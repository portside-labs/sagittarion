# -*- coding: utf-8 -*-
"""
Sagittarion remote agent.

This file is shipped to the remote host over SSH (base64-encoded in the exec
command line) and run with the remote's python3. It opens the SQLite file
in place and answers newline-delimited JSON requests on stdin with
newline-delimited JSON responses on stdout.

Constraints:
  * Standard library only.
  * Must run on Python 3.5+ (no f-strings, no walrus, no builtin generics).
  * All output on stdout must be protocol lines; diagnostics go to stderr.

Protocol
--------
Startup: prints "__SAGITTARION_READY__ <token>" once it is listening. Anything
printed before that line (shell rc noise, MOTD-like output) is ignored by the
client.

Request:  {"id": 1, "op": "query", ...}
Response: {"id": 1, "ok": true, ...} or {"id": 1, "ok": false, "error": "..."}

The "cancel" op is handled out-of-band by the stdin reader thread and calls
sqlite3.Connection.interrupt() on whatever statement is currently running.
"""
import sys
import os
import re
import json
import time
import base64
import socket
import sqlite3
import platform
import threading
import traceback

try:
    import queue
except ImportError:  # pragma: no cover - Python 2 is not supported, but fail gracefully
    import Queue as queue  # type: ignore

try:
    from urllib.parse import quote as url_quote
except ImportError:  # pragma: no cover
    from urllib import quote as url_quote  # type: ignore

READY_PREFIX = '__SAGITTARION_READY__'
MAX_SAFE_INT = 2 ** 53 - 1
BLOB_INLINE_LIMIT = 1024 * 1024  # send blobs up to 1 MiB in full
BLOB_PREVIEW_BYTES = 64 * 1024   # otherwise send this much as a preview
ROWID_CANDIDATES = ('rowid', '_rowid_', 'oid')

conn = None      # type: ignore
db_path = None   # type: ignore
out_lock = threading.Lock()


class AgentError(Exception):
    """An error that should be reported to the client as a plain message."""


# ----------------------------------------------------------------------------
# I/O helpers
# ----------------------------------------------------------------------------

def send(obj):
    data = json.dumps(obj, ensure_ascii=False, separators=(',', ':'))
    payload = data.encode('utf-8', 'replace') + b'\n'
    with out_lock:
        try:
            sys.stdout.buffer.write(payload)
            sys.stdout.buffer.flush()
        except (BrokenPipeError, OSError):
            # Client went away; nothing sensible left to do.
            os._exit(0)


def log(msg):
    try:
        sys.stderr.write(msg + '\n')
        sys.stderr.flush()
    except Exception:
        pass


# ----------------------------------------------------------------------------
# Value encoding
# ----------------------------------------------------------------------------

def encode_cell(v):
    """Convert a Python value from sqlite3 into a JSON-safe representation."""
    if v is None:
        return None
    t = type(v)
    if t is int:
        if -MAX_SAFE_INT <= v <= MAX_SAFE_INT:
            return v
        return {'$type': 'int', 'value': str(v)}
    if t is float:
        if v != v:
            return {'$type': 'float', 'value': 'nan'}
        if v == float('inf'):
            return {'$type': 'float', 'value': 'inf'}
        if v == float('-inf'):
            return {'$type': 'float', 'value': '-inf'}
        if v.is_integer():
            # JSON would turn 2.0 into 2; keep the REAL storage class visible.
            return {'$type': 'float', 'value': repr(v)}
        return v
    if t is str:
        return v
    if t is bytes or t is bytearray or t is memoryview:
        b = bytes(v)
        n = len(b)
        if n > BLOB_INLINE_LIMIT:
            return {
                '$type': 'blob',
                'base64': base64.b64encode(b[:BLOB_PREVIEW_BYTES]).decode('ascii'),
                'size': n,
                'truncated': True,
            }
        return {'$type': 'blob', 'base64': base64.b64encode(b).decode('ascii'), 'size': n, 'truncated': False}
    return str(v)


def decode_value(v):
    """Convert a JSON value from the client into something sqlite3 can bind."""
    if isinstance(v, dict) and '$type' in v:
        t = v['$type']
        if t == 'int':
            return int(v['value'])
        if t == 'float':
            s = v['value']
            if s == 'nan':
                return float('nan')
            if s == 'inf':
                return float('inf')
            if s == '-inf':
                return float('-inf')
            return float(s)
        if t == 'blob':
            if v.get('truncated'):
                raise AgentError('Cannot write back a blob that was only partially loaded')
            return base64.b64decode(v['base64'])
        if t == 'text':
            return v['value']
        raise AgentError('Unknown value type: %r' % (t,))
    if isinstance(v, bool):
        return 1 if v else 0
    return v


def qi(name):
    """Quote an SQL identifier."""
    return '"' + str(name).replace('"', '""') + '"'


# ----------------------------------------------------------------------------
# SQL statement splitting
# ----------------------------------------------------------------------------

_COMMENT_RE = re.compile(r'--[^\n]*|/\*.*?\*/', re.S)


def is_blank_sql(sql):
    return not _COMMENT_RE.sub('', sql).strip()


def split_statements(sql):
    """
    Split a script into individual statements using sqlite3.complete_statement,
    which understands string literals, comments and CREATE TRIGGER bodies.
    """
    statements = []
    buf = ''
    parts = sql.split(';')
    last = len(parts) - 1
    for i, part in enumerate(parts):
        buf += part
        if i < last:
            buf += ';'
        if sqlite3.complete_statement(buf):
            if not is_blank_sql(buf):
                statements.append(buf.strip())
            buf = ''
    if not is_blank_sql(buf):
        statements.append(buf.strip())
    return statements


# ----------------------------------------------------------------------------
# Schema introspection
# ----------------------------------------------------------------------------

def table_columns(name):
    try:
        rows = conn.execute('PRAGMA table_xinfo(%s)' % qi(name)).fetchall()
        rows = [tuple(r) for r in rows]
    except sqlite3.Error:
        rows = [tuple(r) + (0,) for r in conn.execute('PRAGMA table_info(%s)' % qi(name)).fetchall()]
    cols = []
    for r in rows:
        cols.append({
            'cid': r[0],
            'name': r[1],
            'type': r[2] or '',
            'notnull': bool(r[3]),
            'dflt': r[4],
            'pk': r[5],
            'hidden': r[6] if len(r) > 6 else 0,
        })
    return cols


def table_meta(name):
    row = conn.execute('SELECT type, sql FROM sqlite_master WHERE name = ?', (name,)).fetchone()
    if row is None:
        raise AgentError('No such table or view: %s' % name)
    typ, sql = row[0], row[1]
    columns = table_columns(name)
    without_rowid = False
    rowid_alias = None
    if typ == 'table':
        without_rowid = bool(re.search(r'\bWITHOUT\s+ROWID\b', sql or '', re.I))
        if not without_rowid:
            lower = set(c['name'].lower() for c in columns)
            for cand in ROWID_CANDIDATES:
                if cand not in lower:
                    rowid_alias = cand
                    break
            if rowid_alias is not None:
                try:
                    conn.execute('SELECT %s FROM %s LIMIT 0' % (rowid_alias, qi(name))).close()
                except sqlite3.Error:
                    rowid_alias = None
                    without_rowid = True
    pk_cols = [c['name'] for c in sorted([c for c in columns if c['pk']], key=lambda c: c['pk'])]
    return {
        'name': name,
        'type': typ,
        'sql': sql,
        'columns': columns,
        'withoutRowid': without_rowid,
        'rowidAlias': rowid_alias,
        'pk': pk_cols,
    }


def visible_columns(meta):
    # hidden == 1 marks hidden virtual-table columns, which SELECT * omits too.
    return [c for c in meta['columns'] if c.get('hidden', 0) != 1]


# ----------------------------------------------------------------------------
# Operations
# ----------------------------------------------------------------------------

def op_open(req):
    global conn, db_path
    raw_path = req.get('path') or ''
    if not raw_path:
        raise AgentError('No database path given')
    path = os.path.expanduser(raw_path)
    if not os.path.isabs(path):
        path = os.path.abspath(path)
    readonly = bool(req.get('readonly'))
    exists = os.path.exists(path)
    if exists and os.path.isdir(path):
        raise AgentError('%s is a directory' % path)
    if not exists:
        if readonly or not req.get('create'):
            raise AgentError('No such file on remote host: %s' % path)
    timeout = float(req.get('busy_timeout', 5.0))
    if readonly:
        uri = 'file:%s?mode=ro' % url_quote(path)
        c = sqlite3.connect(uri, uri=True, isolation_level=None, timeout=timeout)
    else:
        c = sqlite3.connect(path, isolation_level=None, timeout=timeout)
    c.text_factory = lambda b: b.decode('utf-8', 'replace')
    try:
        journal = c.execute('PRAGMA journal_mode').fetchone()[0]
        page_size = c.execute('PRAGMA page_size').fetchone()[0]
        page_count = c.execute('PRAGMA page_count').fetchone()[0]
    except sqlite3.DatabaseError as e:
        c.close()
        raise AgentError('Not a valid SQLite database: %s' % e)
    if req.get('foreign_keys'):
        try:
            c.execute('PRAGMA foreign_keys = ON')
        except sqlite3.Error:
            pass
    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass
    conn = c
    db_path = path
    try:
        size = os.path.getsize(path)
    except OSError:
        size = 0
    return {
        'path': path,
        'readonly': readonly,
        'sqliteVersion': sqlite3.sqlite_version,
        'pythonVersion': platform.python_version(),
        'fileSize': size,
        'pageSize': page_size,
        'pageCount': page_count,
        'journalMode': journal,
        'home': os.path.expanduser('~'),
        'hostname': socket.gethostname(),
        'writable': (not readonly) and os.access(path, os.W_OK) if exists else (not readonly),
    }


def op_schema(req):
    include_system = bool(req.get('include_system'))
    items = conn.execute('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY lower(name)').fetchall()
    tables, views, indexes, triggers, relations = [], [], [], [], []
    for typ, name, tbl, sql in items:
        if typ in ('table', 'view'):
            if name.startswith('sqlite_') and not include_system:
                continue
            try:
                meta = table_meta(name)
            except sqlite3.Error as e:
                meta = {'name': name, 'type': typ, 'sql': sql, 'columns': [], 'withoutRowid': True,
                        'rowidAlias': None, 'pk': [], 'error': str(e)}
            (tables if typ == 'table' else views).append(meta)
            if typ == 'table':
                try:
                    for fk in conn.execute('PRAGMA foreign_key_list(%s)' % qi(name)).fetchall():
                        fk = tuple(fk)
                        relations.append({'table': name, 'column': fk[3], 'refTable': fk[2], 'refColumn': fk[4]})
                except sqlite3.Error:
                    pass
        elif typ == 'index':
            if name.startswith('sqlite_') and not include_system:
                continue
            indexes.append({'name': name, 'table': tbl, 'sql': sql, 'auto': sql is None})
        elif typ == 'trigger':
            triggers.append({'name': name, 'table': tbl, 'sql': sql})
    return {'tables': tables, 'views': views, 'indexes': indexes, 'triggers': triggers, 'relations': relations}


def op_table_details(req):
    name = req.get('table')
    meta = table_meta(name)
    indexes = []
    for r in conn.execute('PRAGMA index_list(%s)' % qi(name)).fetchall():
        r = tuple(r)
        iname = r[1]
        cols = [c[2] for c in conn.execute('PRAGMA index_info(%s)' % qi(iname)).fetchall()]
        sql_row = conn.execute("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", (iname,)).fetchone()
        indexes.append({
            'name': iname,
            'unique': bool(r[2]),
            'origin': r[3] if len(r) > 3 else 'c',
            'partial': bool(r[4]) if len(r) > 4 else False,
            'columns': cols,
            'sql': sql_row[0] if sql_row else None,
        })
    fks = []
    for r in conn.execute('PRAGMA foreign_key_list(%s)' % qi(name)).fetchall():
        r = tuple(r)
        fks.append({'id': r[0], 'seq': r[1], 'table': r[2], 'from': r[3], 'to': r[4],
                    'onUpdate': r[5], 'onDelete': r[6]})
    triggers = []
    for n, s in conn.execute("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name", (name,)).fetchall():
        triggers.append({'name': n, 'sql': s})
    result = dict(meta)
    result.update({'indexes': indexes, 'foreignKeys': fks, 'triggers': triggers})
    return result


def op_count(req):
    name = req.get('table')
    where = (req.get('where') or '').strip()
    sql = 'SELECT count(*) FROM %s' % qi(name)
    if where:
        sql += ' WHERE ' + where
    return {'total': conn.execute(sql).fetchone()[0]}


def op_rows(req):
    name = req.get('table')
    meta = table_meta(name)
    cols = visible_columns(meta)
    offset = max(0, int(req.get('offset') or 0))
    limit = max(1, min(int(req.get('limit') or 200), 100000))
    where = (req.get('where') or '').strip()
    order_by = req.get('order_by')
    order_dir = 'DESC' if str(req.get('order_dir') or 'asc').lower() == 'desc' else 'ASC'

    select = []
    if meta['rowidAlias']:
        select.append('%s AS "__rowid__"' % meta['rowidAlias'])
    select.extend(qi(c['name']) for c in cols)
    sql = 'SELECT %s FROM %s' % (', '.join(select), qi(name))
    if where:
        sql += ' WHERE ' + where
    if order_by:
        if order_by not in [c['name'] for c in cols]:
            raise AgentError('Cannot sort by unknown column %s' % order_by)
        sql += ' ORDER BY %s %s' % (qi(order_by), order_dir)
    sql += ' LIMIT ? OFFSET ?'

    cur = conn.execute(sql, (limit, offset))
    try:
        raw = cur.fetchall()
    finally:
        cur.close()

    rowids = None
    rows = []
    if meta['rowidAlias']:
        rowids = []
        for r in raw:
            rowids.append(encode_cell(r[0]))
            rows.append([encode_cell(v) for v in r[1:]])
    else:
        for r in raw:
            rows.append([encode_cell(v) for v in r])

    total = None
    if req.get('with_count'):
        csql = 'SELECT count(*) FROM %s' % qi(name)
        if where:
            csql += ' WHERE ' + where
        total = conn.execute(csql).fetchone()[0]

    return {
        'table': name,
        'columns': [{'name': c['name'], 'declType': c['type'], 'pk': c['pk'], 'notnull': c['notnull'],
                     'dflt': c['dflt'], 'hidden': c.get('hidden', 0)} for c in cols],
        'rows': rows,
        'rowids': rowids,
        'rowidAlias': meta['rowidAlias'],
        'pk': meta['pk'],
        'isView': meta['type'] == 'view',
        'total': total,
        'sql': sql,
    }


def op_query(req):
    sql = req.get('sql') or ''
    params = req.get('params') or []
    max_rows = int(req.get('max_rows') or 1000)
    read_only = bool(req.get('read_only'))
    statements = split_statements(sql)
    results = []
    if read_only:
        # Hard guarantee for generated queries: SQLite refuses any write while query_only is on.
        conn.execute('PRAGMA query_only = 1')
    try:
        return {'results': run_statements(statements, params, max_rows)}
    finally:
        if read_only:
            try:
                conn.execute('PRAGMA query_only = 0')
            except sqlite3.Error:
                pass


def run_statements(statements, params, max_rows):
    results = []
    for stmt in statements:
        t0 = time.time()
        before = conn.total_changes
        cur = conn.cursor()
        try:
            bind = [decode_value(p) for p in params] if (params and len(statements) == 1) else []
            cur.execute(stmt, bind)
            if cur.description is not None:
                columns = [d[0] for d in cur.description]
                fetched = cur.fetchmany(max_rows + 1)
                truncated = len(fetched) > max_rows
                fetched = fetched[:max_rows]
                results.append({
                    'kind': 'rows',
                    'sql': stmt,
                    'columns': [{'name': c} for c in columns],
                    'rows': [[encode_cell(v) for v in r] for r in fetched],
                    'rowCount': len(fetched),
                    'truncated': truncated,
                    'durationMs': round((time.time() - t0) * 1000, 1),
                })
            else:
                results.append({
                    'kind': 'exec',
                    'sql': stmt,
                    'changes': conn.total_changes - before,
                    'lastRowId': cur.lastrowid,
                    'durationMs': round((time.time() - t0) * 1000, 1),
                })
        except sqlite3.Error as e:
            results.append({
                'kind': 'error',
                'sql': stmt,
                'message': str(e),
                'durationMs': round((time.time() - t0) * 1000, 1),
            })
            break
        finally:
            cur.close()
    return results


def key_clause(key):
    """Return (where_sql, params) addressing exactly one row."""
    if not isinstance(key, dict):
        raise AgentError('Malformed row key')
    if 'rowid' in key:
        alias = key.get('alias') or 'rowid'
        if alias not in ROWID_CANDIDATES:
            raise AgentError('Invalid rowid alias %r' % (alias,))
        return '%s = ?' % alias, [decode_value(key['rowid'])]
    pk = key.get('pk') or {}
    if not pk:
        raise AgentError('Row has no primary key and no rowid; it cannot be addressed safely')
    cols = list(pk.keys())
    return ' AND '.join('%s IS ?' % qi(c) for c in cols), [decode_value(pk[c]) for c in cols]


def op_apply(req):
    changes = req.get('changes') or []
    if not changes:
        return {'applied': 0}
    if conn.in_transaction:
        raise AgentError('A transaction is already open on this connection. COMMIT or ROLLBACK it first.')
    conn.execute('BEGIN IMMEDIATE')
    index = 0
    try:
        for index, ch in enumerate(changes):
            typ = ch.get('type')
            table = ch.get('table')
            if not table:
                raise AgentError('Change has no table')
            if typ == 'update':
                values = ch.get('values') or {}
                if not values:
                    continue
                cols = list(values.keys())
                where_sql, where_params = key_clause(ch.get('key'))
                sql = 'UPDATE %s SET %s WHERE %s' % (
                    qi(table), ', '.join('%s = ?' % qi(c) for c in cols), where_sql)
                cur = conn.execute(sql, [decode_value(values[c]) for c in cols] + where_params)
                if cur.rowcount != 1:
                    raise AgentError('UPDATE matched %d rows instead of exactly 1' % cur.rowcount)
            elif typ == 'delete':
                where_sql, where_params = key_clause(ch.get('key'))
                cur = conn.execute('DELETE FROM %s WHERE %s' % (qi(table), where_sql), where_params)
                if cur.rowcount != 1:
                    raise AgentError('DELETE matched %d rows instead of exactly 1' % cur.rowcount)
            elif typ == 'insert':
                values = ch.get('values') or {}
                cols = list(values.keys())
                if cols:
                    sql = 'INSERT INTO %s (%s) VALUES (%s)' % (
                        qi(table), ', '.join(qi(c) for c in cols), ', '.join(['?'] * len(cols)))
                    conn.execute(sql, [decode_value(values[c]) for c in cols])
                else:
                    conn.execute('INSERT INTO %s DEFAULT VALUES' % qi(table))
            else:
                raise AgentError('Unknown change type %r' % (typ,))
        conn.execute('COMMIT')
    except Exception as e:
        try:
            conn.execute('ROLLBACK')
        except Exception:
            pass
        raise AgentError('%s (change %d of %d). All changes were rolled back.' % (e, index + 1, len(changes)))
    return {'applied': len(changes)}


def op_ping(req):
    return {'time': time.time()}


def op_close(req):
    return {}


OPS = {
    'open': op_open,
    'schema': op_schema,
    'table_details': op_table_details,
    'count': op_count,
    'rows': op_rows,
    'query': op_query,
    'apply': op_apply,
    'ping': op_ping,
    'close': op_close,
}

NEEDS_DB = set(['schema', 'table_details', 'count', 'rows', 'query', 'apply'])


# ----------------------------------------------------------------------------
# Main loop
# ----------------------------------------------------------------------------

def reader_thread(q):
    stdin = sys.stdin.buffer
    try:
        while True:
            line = stdin.readline()
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line.decode('utf-8'))
            except Exception as e:
                send({'id': None, 'ok': False, 'error': 'Malformed request: %s' % e})
                continue
            if not isinstance(req, dict):
                send({'id': None, 'ok': False, 'error': 'Malformed request'})
                continue
            if req.get('op') == 'cancel':
                if conn is not None:
                    try:
                        conn.interrupt()
                    except Exception:
                        pass
                send({'id': req.get('id'), 'ok': True})
                continue
            q.put(req)
    except Exception as e:
        log('reader thread failed: %s' % e)
    finally:
        q.put(None)


def main():
    token = sys.argv[2] if len(sys.argv) > 2 else ''
    q = queue.Queue()
    t = threading.Thread(target=reader_thread, args=(q,))
    t.daemon = True
    t.start()

    with out_lock:
        sys.stdout.buffer.write((READY_PREFIX + ' ' + token + '\n').encode('utf-8'))
        sys.stdout.buffer.flush()

    while True:
        req = q.get()
        if req is None:
            break
        rid = req.get('id')
        op = req.get('op')
        t0 = time.time()
        try:
            handler = OPS.get(op)
            if handler is None:
                raise AgentError('Unknown operation: %r' % (op,))
            if op in NEEDS_DB and conn is None:
                raise AgentError('No database is open')
            result = handler(req) or {}
            result['id'] = rid
            result['ok'] = True
            result['durationMs'] = round((time.time() - t0) * 1000, 1)
            result['tx'] = bool(conn is not None and conn.in_transaction)
            send(result)
        except AgentError as e:
            send({'id': rid, 'ok': False, 'error': str(e),
                  'tx': bool(conn is not None and conn.in_transaction)})
        except sqlite3.Error as e:
            send({'id': rid, 'ok': False, 'error': str(e), 'sqlite': True,
                  'tx': bool(conn is not None and conn.in_transaction)})
        except Exception as e:
            send({'id': rid, 'ok': False, 'error': 'Agent failure: %s' % e,
                  'trace': traceback.format_exc()})
        if op == 'close':
            break

    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass
    try:
        sys.stdout.buffer.flush()
    except Exception:
        pass
    # The stdin reader thread is blocked in readline(); a normal interpreter
    # shutdown would complain about it, so leave immediately.
    os._exit(0)


main()
