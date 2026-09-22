import { EventEmitter } from 'node:events'
import { Client, type ClientConfig, type FieldDef } from 'pg'
import Cursor from 'pg-cursor'
import type {
  Catalog,
  CellValue,
  ColumnHit,
  ColumnInfo,
  ConnectProgress,
  DatabaseInfo,
  ForeignKeyDetail,
  IndexDetail,
  ListObjectsRequest,
  ObjectCounts,
  ObjectDefinition,
  ObjectKind,
  ObjectPage,
  ObjectRef,
  ObjectSummary,
  PendingChange,
  QueryOptions,
  QueryResponse,
  Relation,
  RowKey,
  RowsRequest,
  RowsResponse,
  SchemaInfo,
  SearchResult,
  SslMode,
  StatementResult,
  TableDetails,
  TableMeta,
  TableRef
} from '@shared/types'
import { formatBytes } from '@shared/export'
import type { DatabaseDriver } from './driver'
import { encodeParam, pgTypes, qi, qualify } from './pg-values'
import { isRowReturning, splitStatements } from './sql-split'
import { decodeCursor, emptyCounts, encodeCursor, familyOf } from './catalog'

export interface PostgresDriverOptions {
  host: string
  port: number
  database: string
  user: string
  password?: string
  sslMode: SslMode
  /** Host name to verify the certificate against when connecting through a tunnel. */
  servername?: string
  readOnly: boolean
  /** The server as the user knows it (differs from host/port when tunnelled). */
  displayHost: string
  displayPort: number
  /** "user@host" of the SSH tunnel, if any. */
  tunnel?: string | null
  onProgress?: (p: ConnectProgress) => void
}

const SCHEMA_FILTER = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'`
const RELKINDS = `('r', 'p', 'v', 'm', 'f')`
const RELKIND_SUBTYPE: Record<string, string> = { r: 'table', p: 'partitioned', f: 'foreign', v: 'view', m: 'matview' }
const FUNCTION_SELECT = `SELECT p.oid::text, n.nspname, p.proname, p.prokind::text, pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid), l.lanname, d.description
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_language l ON l.oid = p.prolang
       LEFT JOIN pg_description d ON d.objoid = p.oid AND d.classoid = 'pg_proc'::regclass`

function likePattern(q: string, prefix = false): string {
  const escaped = q.replace(/[\\%_]/g, (m) => `\\${m}`)
  return prefix ? `${escaped}%` : `%${escaped}%`
}

function functionSummary(r: unknown[]): ObjectSummary {
  const prokind = String(r[3])
  const returns = (r[5] as string | null) ?? null
  const subtype = prokind === 'p' ? 'procedure' : prokind === 'a' ? 'aggregate' : prokind === 'w' ? 'window' : returns === 'trigger' ? 'trigger-function' : 'function'
  return { id: String(r[0]), kind: 'function', schema: String(r[1]), name: String(r[2]), subtype, args: String(r[4] ?? ''), returns, language: String(r[6] ?? ''), comment: (r[7] as string | null) ?? null }
}

function relationSummary(r: unknown[]): ObjectSummary {
  const relkind = String(r[3])
  const est = toNumber(r[5])
  return {
    id: String(r[0]),
    kind: relkind === 'v' || relkind === 'm' ? 'view' : 'table',
    schema: String(r[1]),
    name: String(r[2]),
    subtype: RELKIND_SUBTYPE[relkind] ?? 'table',
    columnCount: r[4] === null || r[4] === undefined ? null : Number(r[4]),
    rowEstimate: Number.isFinite(est) && est >= 0 ? Math.round(est) : null,
    comment: (r[6] as string | null) ?? null
  }
}
const FK_ACTIONS: Record<string, string> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' }

type Row = any[]

function sslAttempts(mode: SslMode, servername?: string): (false | Record<string, unknown>)[] {
  const verify = { rejectUnauthorized: true, ...(servername ? { servername } : {}) }
  const noVerify = { rejectUnauthorized: false, ...(servername ? { servername } : {}) }
  switch (mode) {
    case 'disable':
      return [false]
    case 'require':
      return [noVerify]
    case 'verify-full':
      return [verify]
    default:
      return [noVerify, false]
  }
}

function isNoSslError(err: any): boolean {
  return /does not support SSL/i.test(String(err?.message ?? ''))
}

export function pgErrorMessage(err: any): string {
  let msg = String(err?.message ?? err)
  if (err?.position) msg += ` (at character ${err.position})`
  if (err?.detail) msg += `\n${err.detail}`
  if (err?.hint) msg += `\nHint: ${err.hint}`
  return msg
}

export function friendlyPgError(err: any, o: PostgresDriverOptions): Error {
  const msg = String(err?.message ?? err)
  const code = err?.code
  const where = `${o.displayHost}:${o.displayPort}`
  if (code === '28P01') return new Error(`Password authentication failed for user "${o.user}".`)
  if (code === '28000') return new Error(`Authentication failed for user "${o.user}": ${msg}`)
  if (code === '3D000') return new Error(`Database "${o.database}" does not exist on ${where}.`)
  if (/ECONNREFUSED/.test(msg)) {
    return new Error(
      o.tunnel
        ? `Nothing is listening on ${where} as seen from the SSH host. Check the database host and port used inside the tunnel.`
        : `Connection refused at ${where}. Is PostgreSQL listening there and accepting TCP connections?`
    )
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return new Error(`Host not found: ${o.displayHost}`)
  if (/ETIMEDOUT|timeout/i.test(msg)) return new Error(`Timed out connecting to ${where}.`)
  if (/EHOSTUNREACH|ENETUNREACH/.test(msg)) return new Error(`${o.displayHost} is unreachable.`)
  if (isNoSslError(err)) return new Error('The server does not support SSL. Set SSL mode to "prefer" or "disable".')
  if (/self[- ]signed|certificate|CERT_|unable to verify|altnames/i.test(msg)) {
    return new Error(`Certificate verification failed: ${msg}. Use SSL mode "require" to connect without verifying the certificate.`)
  }
  if (/no pg_hba.conf entry/i.test(msg)) return new Error(`The server rejected the connection: ${msg}`)
  return new Error(pgErrorMessage(err))
}

/** Direct connection to a PostgreSQL server (optionally through a local tunnel port). */
export class PostgresDriver extends EventEmitter implements DatabaseDriver {
  readonly kind = 'postgres' as const
  private readonly opts: PostgresDriverOptions
  private client: Client | null = null
  private clientConfig: ClientConfig | null = null
  private txStatus: 'I' | 'T' | 'E' = 'I'
  private dbInfo: DatabaseInfo | null = null
  private readonly typeNames = new Map<number, string>()
  private closed = false

  constructor(opts: PostgresDriverOptions) {
    super()
    this.opts = opts
  }

  // ---------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------

  async connect(): Promise<DatabaseInfo> {
    const o = this.opts
    o.onProgress?.({ stage: 'connecting', message: `Connecting to PostgreSQL at ${o.displayHost}:${o.displayPort}…` })
    const base: ClientConfig = {
      host: o.host,
      port: o.port,
      database: o.database,
      user: o.user,
      password: o.password ?? '',
      connectionTimeoutMillis: 20_000,
      application_name: 'Sagittarion',
      keepAlive: true,
      types: pgTypes as any
    }
    let lastErr: any = null
    for (const ssl of sslAttempts(o.sslMode, o.servername)) {
      const client = new Client({ ...base, ssl: ssl as any })
      try {
        await client.connect()
        this.client = client
        this.clientConfig = { ...base, ssl: ssl as any }
        break
      } catch (err) {
        lastErr = err
        await client.end().catch(() => undefined)
        if (!(o.sslMode === 'prefer' && ssl !== false && isNoSslError(err))) throw friendlyPgError(err, o)
      }
    }
    if (!this.client) throw friendlyPgError(lastErr, o)
    const client = this.client
    client.on('error', (err: Error) => this.handleClosed(`Connection error: ${err.message}`))
    client.on('end', () => this.handleClosed('The server closed the connection'))
    const connection: any = (client as any).connection
    connection?.on?.('readyForQuery', (msg: any) => {
      if (msg?.status === 'I' || msg?.status === 'T' || msg?.status === 'E') this.txStatus = msg.status
    })
    if (o.readOnly) await client.query('SET default_transaction_read_only = on')
    o.onProgress?.({ stage: 'opening', message: `Reading database details…` })
    this.dbInfo = await this.loadInfo()
    return this.dbInfo
  }

  private handleClosed(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.emit('closed', reason)
  }

  private requireClient(): Client {
    if (!this.client || this.closed) throw new Error('Not connected to PostgreSQL. Reconnect to continue.')
    return this.client
  }

  private async q(text: string, values: unknown[] = []): Promise<{ rows: Row[]; fields: FieldDef[]; rowCount: number | null }> {
    const res = await this.requireClient().query({ text, values, rowMode: 'array', types: pgTypes as any })
    return { rows: res.rows as Row[], fields: res.fields, rowCount: res.rowCount }
  }

  private async loadInfo(): Promise<DatabaseInfo> {
    const o = this.opts
    const { rows } = await this.q(
      `SELECT current_database(), current_user, current_setting('server_version'), pg_encoding_to_char(d.encoding)
       FROM pg_database d WHERE d.datname = current_database()`
    )
    const [database, user, version, encoding] = rows[0] ?? [o.database, o.user, '?', '?']
    const details: { label: string; value: string }[] = [{ label: 'user', value: String(user) }]
    try {
      const size = await this.q('SELECT pg_database_size(current_database())')
      const v = size.rows[0]?.[0]
      const n = typeof v === 'number' ? v : typeof v === 'object' && v && '$type' in v ? Number((v as any).value) : Number(v)
      if (Number.isFinite(n)) details.push({ label: 'size', value: formatBytes(n) })
    } catch {
      /* no permission */
    }
    details.push({ label: 'encoding', value: String(encoding) })
    let ssl = 'off'
    try {
      const r = await this.q('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()')
      ssl = r.rows[0]?.[0] ? 'on' : 'off'
    } catch {
      /* view unavailable */
    }
    details.push({ label: 'ssl', value: ssl })
    if (o.tunnel) details.push({ label: 'tunnel', value: `via ${o.tunnel}` })
    return {
      kind: 'postgres',
      label: `${database} on ${o.displayHost}${o.displayPort !== 5432 ? `:${o.displayPort}` : ''}`,
      serverVersion: `PostgreSQL ${version}`,
      readonly: o.readOnly,
      details
    }
  }

  info(): DatabaseInfo | null {
    return this.dbInfo
  }

  // ---------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------

  private async loadRelations(extraWhere = '', params: unknown[] = []): Promise<TableMeta[]> {
    const where = `c.relkind IN ${RELKINDS} AND ${SCHEMA_FILTER}${extraWhere ? ` AND ${extraWhere}` : ''}`
    const rels = await this.q(
      `SELECT c.oid::text, n.nspname, c.relname, c.relkind,
              CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) END,
              obj_description(c.oid, 'pg_class'),
              c.reltuples::float8
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE ${where}
       ORDER BY n.nspname, c.relname`,
      params
    )
    const cols = await this.q(
      `SELECT a.attrelid::text, a.attnum, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
              pg_get_expr(d.adbin, d.adrelid), a.attidentity::text, a.attgenerated::text,
              COALESCE((SELECT k.ord::int
                        FROM pg_index i, unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
                        WHERE i.indrelid = a.attrelid AND i.indisprimary AND k.attnum = a.attnum
                        LIMIT 1), 0)
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attnum > 0 AND NOT a.attisdropped AND ${where}
       ORDER BY a.attrelid, a.attnum`,
      params
    )
    const byRel = new Map<string, ColumnInfo[]>()
    for (const r of cols.rows) {
      const [reloid, attnum, name, type, notnull, dflt, identity, generated, pk] = r as [string, number, string, string, boolean, string | null, string, string, number]
      const list = byRel.get(reloid) ?? []
      let extra: string | undefined
      let hidden = 0
      let dfltOut: string | null = dflt
      if (generated === 's') {
        extra = 'generated'
        hidden = 3
        dfltOut = null
      } else if (identity === 'a') {
        extra = 'identity (always)'
        hidden = 3
        dfltOut = null
      } else if (identity === 'd') {
        extra = 'identity (by default)'
        dfltOut = null
      }
      list.push({ cid: attnum - 1, name, type, notnull: Boolean(notnull), dflt: dfltOut, pk: Number(pk) || 0, hidden, extra })
      byRel.set(reloid, list)
    }
    const out: TableMeta[] = []
    for (const r of rels.rows) {
      const [oid, schema, name, relkind, viewdef, comment, reltuples] = r as [string, string, string, string, string | null, string | null, unknown]
      const columns = byRel.get(oid) ?? []
      const isView = relkind === 'v' || relkind === 'm'
      const estimate = toNumber(reltuples)
      const meta: TableMeta & { oid?: string } = {
        oid,
        schema,
        name,
        type: isView ? 'view' : 'table',
        sql: null,
        columns,
        withoutRowid: true,
        rowidAlias: null,
        pk: columns
          .filter((c) => c.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((c) => c.name),
        comment,
        rowEstimate: Number.isFinite(estimate) && estimate >= 0 ? Math.round(estimate) : null
      }
      if (isView) {
        meta.sql = `CREATE ${relkind === 'm' ? 'MATERIALIZED VIEW' : 'VIEW'} ${qualify(meta)} AS\n${viewdef ?? ''}`
      } else {
        meta.sql = synthesizeCreate(meta, relkind)
      }
      out.push(meta)
    }
    return out
  }


  // ---------------------------------------------------------------------
  // Catalog: names first, details on demand
  // ---------------------------------------------------------------------

  private defaultSchemaCache: string | null = null

  private async defaultSchemaName(): Promise<string> {
    if (!this.defaultSchemaCache) {
      const res = await this.q('SELECT current_schema()')
      this.defaultSchemaCache = (res.rows[0]?.[0] as string | null) || 'public'
    }
    return this.defaultSchemaCache
  }

  async catalog(): Promise<Catalog> {
    const [schemasRes, currentRes, rels, idx, trg, fns] = await Promise.all([
      this.q(`SELECT n.nspname FROM pg_namespace n WHERE ${SCHEMA_FILTER} ORDER BY (n.nspname <> 'public'), n.nspname`),
      this.q('SELECT current_schema()'),
      this.q(
        `SELECT n.nspname, count(*) FILTER (WHERE c.relkind IN ('r', 'p', 'f'))::int, count(*) FILTER (WHERE c.relkind IN ('v', 'm'))::int
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ${RELKINDS} AND ${SCHEMA_FILTER} GROUP BY n.nspname`
      ),
      this.q(
        `SELECT n.nspname, count(*)::int FROM pg_index x JOIN pg_class t ON t.oid = x.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE NOT x.indisprimary AND ${SCHEMA_FILTER} GROUP BY n.nspname`
      ),
      this.q(
        `SELECT n.nspname, count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE NOT t.tgisinternal AND ${SCHEMA_FILTER} GROUP BY n.nspname`
      ),
      this.q(`SELECT n.nspname, count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE ${SCHEMA_FILTER} GROUP BY n.nspname`)
    ])
    const counts = new Map<string, ObjectCounts>()
    for (const r of schemasRes.rows) counts.set(String(r[0]), emptyCounts())
    for (const r of rels.rows) {
      const c = counts.get(String(r[0]))
      if (c) {
        c.table += Number(r[1])
        c.view += Number(r[2])
      }
    }
    const add = (rows: Row[], kind: ObjectKind) => {
      for (const r of rows) {
        const c = counts.get(String(r[0]))
        if (c) c[kind] += Number(r[1])
      }
    }
    add(idx.rows, 'index')
    add(trg.rows, 'trigger')
    add(fns.rows, 'function')
    this.defaultSchemaCache = (currentRes.rows[0]?.[0] as string | null) || 'public'
    const schemas = [...counts.entries()].map(([name, c]) => ({ name, counts: c }))
    let totalObjects = 0
    let totalTables = 0
    for (const s of schemas) {
      totalTables += s.counts.table + s.counts.view
      totalObjects += s.counts.table + s.counts.view + s.counts.function + s.counts.index + s.counts.trigger
    }
    return { kind: 'postgres', defaultSchema: this.defaultSchemaCache, schemas, totalObjects, totalTables }
  }

  async listObjects(req: ListObjectsRequest): Promise<ObjectPage> {
    const family = familyOf(req.kinds)
    const limit = Math.min(Math.max(req.limit ?? 2000, 1), 20000)
    const after = decodeCursor<string[]>(req.cursor)
    const params: unknown[] = []
    const p = (v: unknown) => {
      params.push(v)
      return `$${params.length}`
    }
    const conds: string[] = [SCHEMA_FILTER]
    if (req.schema) conds.push(`n.nspname = ${p(req.schema)}`)
    let sql: string
    let map: (r: Row) => ObjectSummary
    let keyOf: (o: ObjectSummary) => string[]
    if (family === 'relation') {
      const kinds = new Set(req.kinds)
      const relkinds = [...(kinds.has('table') ? ['r', 'p', 'f'] : []), ...(kinds.has('view') ? ['v', 'm'] : [])]
      conds.push(`c.relkind IN (${relkinds.map((k) => `'${k}'`).join(', ')})`)
      if (after) conds.push(`(n.nspname, c.relname) > (${p(after[0])}, ${p(after[1])})`)
      sql = `SELECT c.oid::text, n.nspname, c.relname, c.relkind::text, c.relnatts::int, c.reltuples::float8, d.description
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             LEFT JOIN pg_description d ON d.objoid = c.oid AND d.classoid = 'pg_class'::regclass AND d.objsubid = 0
             WHERE ${conds.join(' AND ')} ORDER BY n.nspname, c.relname LIMIT ${p(limit + 1)}`
      map = relationSummary
      keyOf = (o) => [o.schema!, o.name]
    } else if (family === 'index') {
      conds.push('NOT x.indisprimary')
      if (after) conds.push(`(n.nspname, t.relname, i.relname) > (${p(after[0])}, ${p(after[1])}, ${p(after[2])})`)
      sql = `SELECT i.oid::text, n.nspname, i.relname, t.relname
             FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
             WHERE ${conds.join(' AND ')} ORDER BY n.nspname, t.relname, i.relname LIMIT ${p(limit + 1)}`
      map = (r) => ({ id: String(r[0]), kind: 'index', schema: String(r[1]), name: String(r[2]), table: String(r[3]) })
      keyOf = (o) => [o.schema!, o.table!, o.name]
    } else if (family === 'trigger') {
      conds.push('NOT t.tgisinternal')
      if (after) conds.push(`(n.nspname, c.relname, t.tgname) > (${p(after[0])}, ${p(after[1])}, ${p(after[2])})`)
      sql = `SELECT t.oid::text, n.nspname, t.tgname, c.relname
             FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE ${conds.join(' AND ')} ORDER BY n.nspname, c.relname, t.tgname LIMIT ${p(limit + 1)}`
      map = (r) => ({ id: String(r[0]), kind: 'trigger', schema: String(r[1]), name: String(r[2]), table: String(r[3]) })
      keyOf = (o) => [o.schema!, o.table!, o.name]
    } else {
      if (after) conds.push(`(n.nspname, p.proname, p.oid) > (${p(after[0])}, ${p(after[1])}, ${p(after[2])}::oid)`)
      sql = `${FUNCTION_SELECT} WHERE ${conds.join(' AND ')} ORDER BY n.nspname, p.proname, p.oid LIMIT ${p(limit + 1)}`
      map = functionSummary
      keyOf = (o) => [o.schema!, o.name, o.id]
    }
    const res = await this.q(sql, params)
    const items = res.rows.slice(0, limit).map(map)
    const more = res.rows.length > limit
    return { items, cursor: more && items.length ? encodeCursor(keyOf(items[items.length - 1])) : null }
  }

  async searchObjects(query: string, limit = 100): Promise<SearchResult> {
    const q = query.trim()
    if (!q) return { query, objects: [], columns: [], truncated: false }
    const lim = Math.min(Math.max(limit, 1), 500)
    const params = [likePattern(q), likePattern(q, true), lim + 1]
    const [rels, idx, trg, fns, cols] = await Promise.all([
      this.q(
        `SELECT c.oid::text, n.nspname, c.relname, c.relkind::text, c.relnatts::int, c.reltuples::float8, NULL
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ${RELKINDS} AND ${SCHEMA_FILTER} AND c.relname ILIKE $1
         ORDER BY (c.relname ILIKE $2) DESC, n.nspname, c.relname LIMIT $3`,
        params
      ),
      this.q(
        `SELECT i.oid::text, n.nspname, i.relname, t.relname
         FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE NOT x.indisprimary AND ${SCHEMA_FILTER} AND i.relname ILIKE $1
         ORDER BY (i.relname ILIKE $2) DESC, n.nspname, i.relname LIMIT $3`,
        params
      ),
      this.q(
        `SELECT t.oid::text, n.nspname, t.tgname, c.relname
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE NOT t.tgisinternal AND ${SCHEMA_FILTER} AND t.tgname ILIKE $1
         ORDER BY (t.tgname ILIKE $2) DESC, n.nspname, t.tgname LIMIT $3`,
        params
      ),
      this.q(`${FUNCTION_SELECT} WHERE ${SCHEMA_FILTER} AND p.proname ILIKE $1 ORDER BY (p.proname ILIKE $2) DESC, n.nspname, p.proname LIMIT $3`, params),
      this.q(
        `SELECT n.nspname, c.relname, c.relkind::text, c.oid::text, a.attname, format_type(a.atttypid, a.atttypmod)
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ${RELKINDS} AND ${SCHEMA_FILTER} AND a.attname ILIKE $1
         ORDER BY (a.attname ILIKE $2) DESC, n.nspname, c.relname, a.attnum LIMIT $3`,
        params
      )
    ])
    const objects: ObjectSummary[] = [
      ...rels.rows.slice(0, lim).map(relationSummary),
      ...fns.rows.slice(0, lim).map(functionSummary),
      ...idx.rows.slice(0, lim).map<ObjectSummary>((r) => ({ id: String(r[0]), kind: 'index', schema: String(r[1]), name: String(r[2]), table: String(r[3]) })),
      ...trg.rows.slice(0, lim).map<ObjectSummary>((r) => ({ id: String(r[0]), kind: 'trigger', schema: String(r[1]), name: String(r[2]), table: String(r[3]) }))
    ]
    const columns: ColumnHit[] = cols.rows.slice(0, lim).map((r) => {
      const relkind = String(r[2])
      return { schema: String(r[0]), table: String(r[1]), tableKind: relkind === 'v' || relkind === 'm' ? 'view' : 'table', tableId: String(r[3]), column: String(r[4]), type: String(r[5]) }
    })
    const truncated = [rels, idx, trg, fns, cols].some((res) => res.rows.length > lim)
    return { query, objects, columns, truncated }
  }

  async definition(ref: ObjectRef): Promise<ObjectDefinition> {
    const schema = ref.schema ?? (await this.defaultSchemaName())
    if (ref.kind === 'table' || ref.kind === 'view') {
      const meta = await this.loadRelation({ schema, name: ref.name })
      return { ...ref, schema, sql: meta.sql }
    }
    if (ref.kind === 'index') {
      const res = ref.id
        ? await this.q('SELECT pg_get_indexdef($1::oid)', [ref.id])
        : await this.q('SELECT pg_get_indexdef(i.oid) FROM pg_class i JOIN pg_namespace n ON n.oid = i.relnamespace WHERE n.nspname = $1 AND i.relname = $2', [schema, ref.name])
      return { ...ref, schema, sql: (res.rows[0]?.[0] as string | null) ?? null }
    }
    if (ref.kind === 'trigger') {
      const res = ref.id
        ? await this.q('SELECT pg_get_triggerdef($1::oid, true)', [ref.id])
        : await this.q(
            `SELECT pg_get_triggerdef(t.oid, true) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND t.tgname = $2 AND NOT t.tgisinternal ORDER BY c.relname LIMIT 1`,
            [schema, ref.name]
          )
      return { ...ref, schema, sql: (res.rows[0]?.[0] as string | null) ?? null }
    }
    try {
      const res = ref.id
        ? await this.q('SELECT pg_get_functiondef($1::oid)', [ref.id])
        : await this.q('SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = $2 ORDER BY p.oid LIMIT 1', [schema, ref.name])
      return { ...ref, schema, sql: (res.rows[0]?.[0] as string | null) ?? null }
    } catch (err) {
      // Aggregates have no CREATE FUNCTION form.
      return { ...ref, schema, sql: `-- Definition unavailable: ${pgErrorMessage(err)}` }
    }
  }

  async tablesMeta(refs: TableRef[]): Promise<TableMeta[]> {
    if (!refs.length) return []
    const def = await this.defaultSchemaName()
    const out: TableMeta[] = []
    for (let i = 0; i < refs.length; i += 200) {
      const batch = refs.slice(i, i + 200)
      const params: unknown[] = []
      const tuples = batch.map((r) => {
        params.push(r.schema ?? def, r.name)
        return `($${params.length - 1}, $${params.length})`
      })
      out.push(...(await this.loadRelations(`(n.nspname, c.relname) IN (${tuples.join(', ')})`, params)).map(stripOid))
    }
    return out
  }

  async relationsFor(refs: TableRef[]): Promise<Relation[]> {
    if (!refs.length) return []
    const def = await this.defaultSchemaName()
    const params: unknown[] = []
    const tuples = refs.slice(0, 500).map((r) => {
      params.push(r.schema ?? def, r.name)
      return `($${params.length - 1}, $${params.length})`
    })
    const oids = await this.q(`SELECT c.oid::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE (n.nspname, c.relname) IN (${tuples.join(', ')})`, params)
    const ids = oids.rows.map((r) => String(r[0]))
    if (!ids.length) return []
    const res = await this.q(
      `SELECT n.nspname, c.relname, a.attname, fn.nspname, fc.relname, fa.attname
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_class fc ON fc.oid = con.confrelid
       JOIN pg_namespace fn ON fn.oid = fc.relnamespace
       CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, fattnum, ord)
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
       JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = k.fattnum
       WHERE con.contype = 'f' AND (con.conrelid = ANY($1::oid[]) OR con.confrelid = ANY($1::oid[]))
       ORDER BY n.nspname, c.relname, con.oid, k.ord`,
      [ids]
    )
    return res.rows.map((r) => ({ schema: String(r[0]), table: String(r[1]), column: String(r[2]), refSchema: String(r[3]), refTable: String(r[4]), refColumn: r[5] === null ? null : String(r[5]) }))
  }

  async schema(): Promise<SchemaInfo> {
    const [schemasRes, currentRes, relations, indexesRes, triggersRes, fkRes] = await Promise.all([
      this.q(`SELECT n.nspname FROM pg_namespace n WHERE ${SCHEMA_FILTER} ORDER BY (n.nspname <> 'public'), n.nspname`),
      this.q('SELECT current_schema()'),
      this.loadRelations(),
      this.q(
        `SELECT n.nspname, t.relname, i.relname, pg_get_indexdef(x.indexrelid), x.indisprimary
         FROM pg_index x
         JOIN pg_class i ON i.oid = x.indexrelid
         JOIN pg_class t ON t.oid = x.indrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE ${SCHEMA_FILTER}
         ORDER BY n.nspname, t.relname, i.relname`
      ),
      this.q(
        `SELECT n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid, true)
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE NOT t.tgisinternal AND ${SCHEMA_FILTER}
         ORDER BY n.nspname, c.relname, t.tgname`
      ),
      this.q(
        `SELECT n.nspname, c.relname, a.attname, fn.nspname, fc.relname, fa.attname
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_class fc ON fc.oid = con.confrelid
         JOIN pg_namespace fn ON fn.oid = fc.relnamespace
         CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, fattnum, ord)
         JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
         JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = k.fattnum
         WHERE con.contype = 'f' AND ${SCHEMA_FILTER}
         ORDER BY n.nspname, c.relname, k.ord`
      )
    ])
    const schemas = schemasRes.rows.map((r) => String(r[0]))
    const fkRelations: Relation[] = fkRes.rows.map((r) => ({
      schema: String(r[0]),
      table: String(r[1]),
      column: String(r[2]),
      refSchema: String(r[3]),
      refTable: String(r[4]),
      refColumn: r[5] === null ? null : String(r[5])
    }))
    const defaultSchema = (currentRes.rows[0]?.[0] as string | null) || 'public'
    return {
      kind: 'postgres',
      defaultSchema,
      schemas,
      tables: relations.filter((t) => t.type === 'table').map(stripOid),
      views: relations.filter((t) => t.type === 'view').map(stripOid),
      indexes: indexesRes.rows
        .filter((r) => !r[4])
        .map((r) => ({ schema: String(r[0]), table: String(r[1]), name: String(r[2]), sql: r[3] as string | null, auto: false })),
      triggers: triggersRes.rows.map((r) => ({ schema: String(r[0]), table: String(r[1]), name: String(r[2]), sql: r[3] as string | null })),
      relations: fkRelations
    }
  }

  private async loadRelation(ref: TableRef): Promise<TableMeta & { oid?: string }> {
    const list = await this.loadRelations('n.nspname = $1 AND c.relname = $2', [ref.schema ?? 'public', ref.name])
    const meta = list[0]
    if (!meta) throw new Error(`No such table or view: ${ref.schema ? `${ref.schema}.` : ''}${ref.name}`)
    return meta
  }

  async tableDetails(ref: TableRef): Promise<TableDetails> {
    const meta = await this.loadRelation(ref)
    const oid = meta.oid!
    const [idx, fks, trg] = await Promise.all([
      this.q(
        `SELECT i.relname, x.indisunique, x.indisprimary, (x.indpred IS NOT NULL), pg_get_indexdef(x.indexrelid),
                (SELECT json_agg(a.attname ORDER BY k.ord)
                 FROM unnest(x.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
                 LEFT JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum),
                EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = x.indexrelid AND con.contype = 'u')
         FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
         WHERE x.indrelid = $1::oid
         ORDER BY x.indisprimary DESC, i.relname`,
        [oid]
      ),
      this.q(
        `SELECT con.conname, con.confrelid::regclass::text, con.confupdtype::text, con.confdeltype::text,
                (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum),
                (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum)
         FROM pg_constraint con
         WHERE con.conrelid = $1::oid AND con.contype = 'f'
         ORDER BY con.conname`,
        [oid]
      ),
      this.q(
        `SELECT t.tgname, pg_get_triggerdef(t.oid, true) FROM pg_trigger t
         WHERE t.tgrelid = $1::oid AND NOT t.tgisinternal ORDER BY t.tgname`,
        [oid]
      )
    ])
    const indexes: IndexDetail[] = idx.rows.map((r) => ({
      name: String(r[0]),
      unique: Boolean(r[1]),
      origin: r[2] ? 'pk' : r[6] ? 'u' : 'c',
      partial: Boolean(r[3]),
      sql: r[4] as string | null,
      columns: parseJsonArray(r[5])
    }))
    const foreignKeys: ForeignKeyDetail[] = []
    fks.rows.forEach((r, id) => {
      const from = parseJsonArray(r[4])
      const to = parseJsonArray(r[5])
      from.forEach((col, seq) => {
        foreignKeys.push({
          id,
          seq,
          table: String(r[1]),
          from: String(col),
          to: to[seq] ?? null,
          onUpdate: FK_ACTIONS[String(r[2])] ?? String(r[2]),
          onDelete: FK_ACTIONS[String(r[3])] ?? String(r[3])
        })
      })
    })
    return {
      ...stripOid(meta),
      indexes,
      foreignKeys,
      triggers: trg.rows.map((r) => ({ name: String(r[0]), sql: r[1] as string | null }))
    }
  }

  // ---------------------------------------------------------------------
  // Rows
  // ---------------------------------------------------------------------

  async count(ref: TableRef, where?: string): Promise<number> {
    const w = where?.trim()
    const { rows } = await this.q(`SELECT count(*) FROM ${qualify(ref)}${w ? ` WHERE ${w}` : ''}`)
    return toNumber(rows[0]?.[0])
  }

  async rows(req: RowsRequest): Promise<RowsResponse> {
    const ref: TableRef = { schema: req.schema, name: req.table }
    const meta = await this.loadRelation(ref)
    const cols = meta.columns
    const where = req.where?.trim()
    let sql = `SELECT ${cols.map((c) => qi(c.name)).join(', ')} FROM ${qualify(ref)}`
    if (where) sql += ` WHERE ${where}`
    if (req.orderBy) {
      if (!cols.some((c) => c.name === req.orderBy)) throw new Error(`Cannot sort by unknown column ${req.orderBy}`)
      sql += ` ORDER BY ${qi(req.orderBy)} ${req.orderDir === 'desc' ? 'DESC' : 'ASC'}`
    }
    sql += ' LIMIT $1 OFFSET $2'
    const t0 = Date.now()
    const limit = Math.max(1, Math.min(req.limit || 200, 100_000))
    const offset = Math.max(0, req.offset || 0)
    const res = await this.q(sql, [limit, offset])
    let total: number | null = null
    if (req.withCount) total = await this.count(ref, where)
    return {
      table: req.table,
      schema: req.schema,
      columns: cols.map((c) => ({ name: c.name, declType: c.type, pk: c.pk, notnull: c.notnull, dflt: c.dflt, hidden: c.hidden })),
      rows: res.rows as CellValue[][],
      rowids: null,
      rowidAlias: null,
      pk: meta.pk,
      isView: meta.type === 'view',
      total,
      sql,
      durationMs: Date.now() - t0,
      tx: this.txStatus !== 'I'
    }
  }

  // ---------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------

  private runCursor(stmt: string, maxRows: number): Promise<{ rows: Row[]; fields: FieldDef[]; rowCount: number | null }> {
    const client = this.requireClient()
    return new Promise((resolve, reject) => {
      const cursor = client.query(new Cursor(stmt, [], { rowMode: 'array', types: pgTypes as any }))
      cursor.read(maxRows + 1, (err: any, rows: any[], result: any) => {
        if (err) {
          reject(err)
          return
        }
        cursor.close(() => resolve({ rows, fields: result?.fields ?? [], rowCount: result?.rowCount ?? null }))
      })
    })
  }

  private async resolveTypeNames(fields: FieldDef[]): Promise<void> {
    const missing = [...new Set(fields.map((f) => f.dataTypeID).filter((oid) => !this.typeNames.has(oid)))]
    if (!missing.length) return
    try {
      const { rows } = await this.q('SELECT o.oid, format_type(o.oid, NULL) FROM unnest($1::oid[]) AS o(oid)', [missing.map(String)])
      for (const r of rows) this.typeNames.set(Number(r[0]), String(r[1]))
    } catch {
      for (const oid of missing) this.typeNames.set(oid, '')
    }
  }

  async query(sql: string, params: unknown[] = [], maxRows = 1000, options?: QueryOptions): Promise<QueryResponse> {
    const client = this.requireClient()
    const statements = splitStatements(sql)
    const results: StatementResult[] = []
    const start = Date.now()
    const readOnly = Boolean(options?.readOnly)
    if (readOnly) {
      if (this.txStatus !== 'I') throw new Error('An explicit transaction is open on this connection. COMMIT or ROLLBACK it before running generated queries.')
      // Hard guarantee for generated queries: the server refuses writes inside a read-only transaction.
      await client.query('BEGIN READ ONLY')
      await client.query("SET LOCAL statement_timeout = '60s'")
    }
    try {
      await this.runStatements(client, statements, params, maxRows, results)
    } finally {
      if (readOnly) await client.query('ROLLBACK').catch(() => undefined)
    }
    return { results, durationMs: Date.now() - start, tx: this.txStatus !== 'I' }
  }

  private async runStatements(client: Client, statements: string[], params: unknown[], maxRows: number, results: StatementResult[]): Promise<void> {
    for (const stmt of statements) {
      const t0 = Date.now()
      try {
        let rows: Row[]
        let fields: FieldDef[]
        let rowCount: number | null
        if (params.length && statements.length === 1) {
          const res = await client.query({ text: stmt, values: params.map((p) => encodeParam(p as CellValue)), rowMode: 'array', types: pgTypes as any })
          rows = res.rows
          fields = res.fields
          rowCount = res.rowCount
        } else if (isRowReturning(stmt)) {
          ;({ rows, fields, rowCount } = await this.runCursor(stmt, maxRows))
        } else {
          const res = await client.query({ text: stmt, rowMode: 'array', types: pgTypes as any })
          rows = res.rows
          fields = res.fields
          rowCount = res.rowCount
        }
        if (fields && fields.length) {
          await this.resolveTypeNames(fields)
          const truncated = rows.length > maxRows
          const kept = truncated ? rows.slice(0, maxRows) : rows
          results.push({
            kind: 'rows',
            sql: stmt,
            columns: fields.map((f) => ({ name: f.name, declType: this.typeNames.get(f.dataTypeID) || undefined })),
            rows: kept as CellValue[][],
            rowCount: kept.length,
            truncated,
            durationMs: Date.now() - t0
          })
        } else {
          results.push({ kind: 'exec', sql: stmt, changes: rowCount ?? 0, lastRowId: null, durationMs: Date.now() - t0 })
        }
      } catch (err) {
        results.push({ kind: 'error', sql: stmt, message: pgErrorMessage(err), durationMs: Date.now() - t0 })
        break
      }
    }
  }

  async cancel(): Promise<void> {
    const client = this.client
    if (!client || !this.clientConfig || this.closed) return
    const pid = (client as any).processID
    if (!pid) return
    const helper = new Client(this.clientConfig)
    try {
      await helper.connect()
      await helper.query('SELECT pg_cancel_backend($1)', [pid])
    } finally {
      await helper.end().catch(() => undefined)
    }
  }

  // ---------------------------------------------------------------------
  // Edits
  // ---------------------------------------------------------------------

  async apply(changes: PendingChange[]): Promise<number> {
    if (!changes.length) return 0
    const client = this.requireClient()
    if (this.txStatus !== 'I') throw new Error('A transaction is already open on this connection. COMMIT or ROLLBACK it first.')
    await client.query('BEGIN')
    let index = 0
    try {
      for (index = 0; index < changes.length; index++) {
        const ch = changes[index]
        const target = qualify({ schema: ch.schema, name: ch.table })
        if (ch.type === 'update') {
          const cols = Object.keys(ch.values)
          if (!cols.length) continue
          const values = cols.map((c) => encodeParam(ch.values[c]))
          const sets = cols.map((c, i) => `${qi(c)} = $${i + 1}`)
          const key = keyClause(ch.key, values.length)
          const res = await client.query({ text: `UPDATE ${target} SET ${sets.join(', ')} WHERE ${key.where}`, values: [...values, ...key.params] })
          if (res.rowCount !== 1) throw new Error(`UPDATE matched ${res.rowCount} rows instead of exactly 1`)
        } else if (ch.type === 'delete') {
          const key = keyClause(ch.key, 0)
          const res = await client.query({ text: `DELETE FROM ${target} WHERE ${key.where}`, values: key.params })
          if (res.rowCount !== 1) throw new Error(`DELETE matched ${res.rowCount} rows instead of exactly 1`)
        } else {
          const cols = Object.keys(ch.values)
          if (cols.length) {
            await client.query({
              text: `INSERT INTO ${target} (${cols.map(qi).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
              values: cols.map((c) => encodeParam(ch.values[c]))
            })
          } else {
            await client.query(`INSERT INTO ${target} DEFAULT VALUES`)
          }
        }
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw new Error(`${pgErrorMessage(err)} (change ${index + 1} of ${changes.length}). All changes were rolled back.`)
    }
    return changes.length
  }

  async close(): Promise<void> {
    this.closed = true
    const client = this.client
    this.client = null
    if (client) await client.end().catch(() => undefined)
  }
}

function keyClause(key: RowKey, offset: number): { where: string; params: unknown[] } {
  if ('pk' in key) {
    const cols = Object.keys(key.pk)
    if (!cols.length) throw new Error('Row has no primary key; it cannot be addressed safely')
    return {
      where: cols.map((c, i) => `${qi(c)} IS NOT DISTINCT FROM $${offset + i + 1}`).join(' AND '),
      params: cols.map((c) => encodeParam(key.pk[c]))
    }
  }
  throw new Error('PostgreSQL rows must be addressed by primary key')
}

function stripOid(meta: TableMeta & { oid?: string }): TableMeta {
  const { oid: _oid, ...rest } = meta
  return rest
}

function parseJsonArray(v: unknown): (string | null)[] {
  if (v === null || v === undefined) return []
  try {
    const parsed = typeof v === 'string' ? JSON.parse(v) : v
    return Array.isArray(parsed) ? parsed.map((x) => (x === null ? null : String(x))) : []
  } catch {
    return []
  }
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v
  if (v && typeof v === 'object' && '$type' in (v as any)) return Number((v as any).value)
  return Number(v)
}

function synthesizeCreate(meta: TableMeta, relkind: string): string {
  const lines = meta.columns.map((c) => {
    let line = `  ${qi(c.name)} ${c.type}`
    if (c.notnull) line += ' NOT NULL'
    if (c.extra === 'generated') line += ` GENERATED ALWAYS AS (${c.dflt ?? '…'}) STORED`
    else if (c.extra === 'identity (always)') line += ' GENERATED ALWAYS AS IDENTITY'
    else if (c.extra === 'identity (by default)') line += ' GENERATED BY DEFAULT AS IDENTITY'
    else if (c.dflt) line += ` DEFAULT ${c.dflt}`
    return line
  })
  if (meta.pk.length) lines.push(`  PRIMARY KEY (${meta.pk.map(qi).join(', ')})`)
  const kind = relkind === 'f' ? 'FOREIGN TABLE' : 'TABLE'
  return `CREATE ${kind} ${qualify(meta)} (\n${lines.join(',\n')}\n)${relkind === 'p' ? ' PARTITION BY …' : ''};`
}
