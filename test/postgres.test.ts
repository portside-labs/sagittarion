import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { dockerAvailable, loadFixture, providePostgres } from './pg-server.mjs'
import { startMockServer } from './mock-ssh/server.mjs'
import { PostgresDriver } from '../src/main/db/postgres'
import { ConnectionManager } from '../src/main/connections/manager'
import { splitStatements, isRowReturning } from '../src/main/db/sql-split'
import { decodeFloat, decodeNumeric, decodeBytea, encodeParam } from '../src/main/db/pg-values'
import type { RowsResult } from '../src/shared/types'

const root = path.resolve(__dirname, '..')
const agentSource = fs.readFileSync(path.join(root, 'src/main/agent/sqlite_agent.py'), 'utf8')
const enabled = Boolean(process.env.PG_URL) || dockerAvailable()

let server: Awaited<ReturnType<typeof providePostgres>>

function driver(overrides: Partial<ConstructorParameters<typeof PostgresDriver>[0]> = {}): PostgresDriver {
  return new PostgresDriver({
    host: server.host,
    port: server.port,
    database: server.database,
    user: server.user,
    password: server.password,
    sslMode: 'prefer',
    readOnly: false,
    displayHost: server.host,
    displayPort: server.port,
    ...overrides
  })
}

describe('PostgreSQL statement splitting and value codecs', () => {
  it('splits on semicolons outside strings, comments and dollar quotes', () => {
    const script = `
      -- leading; comment
      SELECT 'a;b' AS x; /* block; comment */
      CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;
      SELECT $tag$ x; y $tag$; SELECT E'it\\'s; fine';
      SELECT "col;umn" FROM t
    `
    const parts = splitStatements(script)
    expect(parts.length).toBe(5)
    expect(parts[1]).toMatch(/CREATE FUNCTION/) // the block comment after the previous semicolon belongs to this statement
    expect(parts[1]).toContain('END; $$')
    expect(parts[2]).toBe('SELECT $tag$ x; y $tag$;')
    expect(parts[4]).toBe('SELECT "col;umn" FROM t')
    expect(isRowReturning('  select 1')).toBe(true)
    expect(isRowReturning('/* c */ WITH x AS (SELECT 1) SELECT * FROM x')).toBe(true)
    expect(isRowReturning('UPDATE t SET a = 1 RETURNING id')).toBe(true)
    expect(isRowReturning('UPDATE t SET a = 1')).toBe(false)
  })

  it('decodes and encodes values without losing precision', () => {
    expect(decodeFloat('2')).toEqual({ $type: 'float', value: '2' })
    expect(decodeFloat('2.5')).toBe(2.5)
    expect(decodeFloat('NaN')).toEqual({ $type: 'float', value: 'nan' })
    expect(decodeNumeric('12.50')).toEqual({ $type: 'float', value: '12.50' })
    expect(decodeNumeric('42')).toBe(42)
    expect(decodeNumeric('123456789012345678901234567890')).toEqual({ $type: 'int', value: '123456789012345678901234567890' })
    expect(decodeBytea('\\x00ff')).toEqual({ $type: 'blob', base64: 'AP8=', size: 2, truncated: false })
    expect(encodeParam({ $type: 'int', value: '99999999999999999999' })).toBe('99999999999999999999')
    expect(encodeParam({ $type: 'float', value: 'inf' })).toBe('Infinity')
    expect(encodeParam({ $type: 'blob', base64: 'AP8=', size: 2, truncated: false })).toEqual(Buffer.from([0, 255]))
    expect(encodeParam(true)).toBe(true)
  })
})

describe.skipIf(!enabled)('PostgreSQL driver', () => {
  beforeAll(async () => {
    server = await providePostgres()
    await loadFixture(server.url)
  }, 120_000)

  afterAll(async () => {
    await server?.close()
  })

  it('connects, reports database info and lists the schema', async () => {
    const d = driver()
    const info = await d.connect()
    expect(info.kind).toBe('postgres')
    expect(info.serverVersion).toMatch(/^PostgreSQL \d+/)
    expect(info.label).toContain('app on 127.0.0.1')
    expect(info.details.find((x) => x.label === 'user')?.value).toBe('test')

    const schema = await d.schema()
    expect(schema.kind).toBe('postgres')
    expect(schema.defaultSchema).toBe('public')
    expect(schema.schemas).toEqual(['public', 'analytics'])
    expect(schema.tables.map((t) => `${t.schema}.${t.name}`)).toEqual([
      'analytics.daily_totals',
      'public.no_pk',
      'public.orders',
      'public.settings',
      'public.users',
      'public.weird name'
    ])
    expect(schema.views.map((v) => v.name)).toEqual(['order_summary'])
    const users = schema.tables.find((t) => t.name === 'users')!
    expect(users.pk).toEqual(['id'])
    expect(users.rowids ?? null).toBeNull()
    const id = users.columns.find((c) => c.name === 'id')!
    expect(id.extra).toBe('identity (always)')
    expect(id.hidden).toBe(3)
    expect(users.columns.find((c) => c.name === 'name_upper')?.extra).toBe('generated')
    expect(users.columns.find((c) => c.name === 'balance')?.type).toBe('numeric(12,2)')
    expect(users.sql).toContain('GENERATED ALWAYS AS IDENTITY')
    expect(users.sql).toContain('PRIMARY KEY ("id")')
    expect(schema.indexes.map((i) => i.name)).toEqual(expect.arrayContaining(['idx_orders_user', 'idx_orders_status_placed', 'users_email_key']))
    expect(schema.indexes.some((i) => i.name === 'users_pkey')).toBe(false)
    expect(schema.triggers.map((t) => t.name)).toEqual(['users_touch'])
    expect(schema.relations).toEqual([{ schema: 'public', table: 'orders', column: 'user_id', refSchema: 'public', refTable: 'users', refColumn: 'id' }])
    // Row estimates come from planner statistics: unknown until the table is analyzed.
    expect(schema.tables.find((t) => t.name === 'orders')!.rowEstimate ?? null).toBeNull()
    await d.query('ANALYZE orders')
    const analyzed = await d.schema()
    expect(analyzed.tables.find((t) => t.name === 'orders')!.rowEstimate).toBeGreaterThan(0)
    await d.close()
  })

  it('reads rows with faithful types, paging, sorting and filters', async () => {
    const d = driver()
    await d.connect()
    const rows = await d.rows({ table: 'users', schema: 'public', offset: 0, limit: 5, withCount: true, orderBy: 'id', orderDir: 'asc' })
    expect(rows.total).toBe(60)
    expect(rows.rows.length).toBe(5)
    expect(rows.rowids).toBeNull()
    expect(rows.pk).toEqual(['id'])
    const col = (name: string) => rows.columns.findIndex((c) => c.name === name)
    const first = rows.rows[0]
    expect(first[col('id')]).toBe(1)
    expect(typeof first[col('name')]).toBe('string')
    expect(first[col('is_admin')]).toBe(false)
    expect(first[col('balance')]).toEqual({ $type: 'float', value: '1.37' })
    expect(first[col('tags')]).toBe('{beta}')
    expect(typeof first[col('profile')]).toBe('string')
    expect(JSON.parse(first[col('profile')] as string)).toEqual({ n: 1, nested: { ok: false } })
    expect(first[col('ext_id')]).toMatch(/^[0-9a-f-]{36}$/)
    expect(first[col('created_at')]).toMatch(/^\d{4}-\d{2}-\d{2}/)
    expect(first[col('name_upper')]).toBe((first[col('name')] as string).toUpperCase())
    const sixth = await d.rows({ table: 'users', offset: 5, limit: 1, orderBy: 'id', orderDir: 'asc' })
    expect(sixth.rows[0][col('avatar')]).toMatchObject({ $type: 'blob', size: 16 })
    const fifth = await d.rows({ table: 'users', offset: 4, limit: 1, orderBy: 'id', orderDir: 'asc' })
    expect(fifth.rows[0][col('ratio')]).toEqual({ $type: 'float', value: '5' })

    const filtered = await d.rows({ table: 'orders', offset: 0, limit: 10, where: "status = 'paid' AND total > 500", withCount: true })
    expect(filtered.total).toBeGreaterThan(0)
    expect(filtered.rows.every((r) => r[3] === 'paid')).toBe(true)
    const desc = await d.rows({ table: 'orders', offset: 0, limit: 3, orderBy: 'total', orderDir: 'desc' })
    const totals = desc.rows.map((r) => Number((r[2] as any).value ?? r[2]))
    expect(totals[0]).toBeGreaterThanOrEqual(totals[1])
    const other = await d.rows({ table: 'daily_totals', schema: 'analytics', offset: 0, limit: 10, withCount: true })
    expect(other.total).toBe(2)
    await expect(d.rows({ table: 'users', offset: 0, limit: 1, where: 'nonsense === 1' })).rejects.toThrow(/does not exist|syntax error/)
    await d.close()
  })

  it('runs multi-statement queries with per-statement results and errors', async () => {
    const d = driver()
    await d.connect()
    const q = await d.query(`SELECT id, name FROM users WHERE id <= 2 ORDER BY id;
      -- a comment
      UPDATE settings SET value = 'light' WHERE key = 'theme';
      SELECT count(*) AS n FROM orders;
      SELECT * FROM nope;
      SELECT 1`)
    expect(q.results.map((r) => r.kind)).toEqual(['rows', 'exec', 'rows', 'error'])
    const first = q.results[0] as RowsResult
    expect(first.columns.map((c) => c.declType)).toEqual(['bigint', 'text'])
    expect(first.rows.length).toBe(2)
    expect((q.results[1] as any).changes).toBe(1)
    expect((q.results[2] as RowsResult).rows[0][0]).toBe(400)
    expect((q.results[3] as any).message).toMatch(/relation "nope" does not exist/)
    expect(q.tx).toBe(false)

    const truncated = await d.query('SELECT * FROM orders', [], 10)
    const t = truncated.results[0] as RowsResult
    expect(t.rowCount).toBe(10)
    expect(t.truncated).toBe(true)

    const tx = await d.query("BEGIN; UPDATE settings SET value = 'x' WHERE key = 'theme'")
    expect(tx.tx).toBe(true)
    const rb = await d.query('ROLLBACK')
    expect(rb.tx).toBe(false)
    const check = await d.query("SELECT value FROM settings WHERE key = 'theme'")
    expect((check.results[0] as RowsResult).rows[0][0]).toBe('light')
    await d.close()
  })

  it('applies staged edits in one transaction and rolls back on failure', async () => {
    const d = driver()
    await d.connect()
    const applied = await d.apply([
      { type: 'update', table: 'users', schema: 'public', key: { pk: { id: 1 } }, values: { name: 'Renamed', age: null, is_admin: true } },
      { type: 'insert', table: 'users', schema: 'public', values: { name: 'Inserted', email: 'inserted@example.com', balance: { $type: 'float', value: '10.50' } } },
      { type: 'update', table: 'settings', schema: 'public', key: { pk: { key: 'max_items' } }, values: { value: '300' } },
      { type: 'delete', table: 'orders', schema: 'public', key: { pk: { id: 1 } } },
      { type: 'insert', table: 'weird name', schema: 'public', values: { 'col with space': 'e f', 'quote"d': 3 } }
    ])
    expect(applied).toBe(5)
    const check = await d.query(`SELECT name, age, is_admin, updated_at IS NOT NULL FROM users WHERE id = 1;
      SELECT balance FROM users WHERE name = 'Inserted';
      SELECT value FROM settings WHERE key = 'max_items';
      SELECT count(*) FROM orders WHERE id = 1;
      SELECT count(*) FROM "weird name"`)
    expect((check.results[0] as RowsResult).rows[0]).toEqual(['Renamed', null, true, true])
    expect((check.results[1] as RowsResult).rows[0][0]).toEqual({ $type: 'float', value: '10.50' })
    expect((check.results[2] as RowsResult).rows[0][0]).toBe('300')
    expect((check.results[3] as RowsResult).rows[0][0]).toBe(0)
    expect((check.results[4] as RowsResult).rows[0][0]).toBe(3)

    await expect(
      d.apply([
        { type: 'update', table: 'users', key: { pk: { id: 2 } }, values: { name: 'Should roll back' } },
        { type: 'update', table: 'users', key: { pk: { id: 999999 } }, values: { name: 'x' } }
      ])
    ).rejects.toThrow(/matched 0 rows.*rolled back/)
    const after = await d.query('SELECT name FROM users WHERE id = 2')
    expect((after.results[0] as RowsResult).rows[0][0]).not.toBe('Should roll back')
    await expect(d.apply([{ type: 'update', table: 'users', key: { pk: { id: 3 } }, values: { name_upper: 'X' } }])).rejects.toThrow(/generated|rolled back/i)
    await d.close()
  })

  it('describes indexes, foreign keys and triggers', async () => {
    const d = driver()
    await d.connect()
    const details = await d.tableDetails({ schema: 'public', name: 'orders' })
    expect(details.foreignKeys[0]).toMatchObject({ table: 'users', from: 'user_id', to: 'id', onDelete: 'CASCADE' })
    expect(details.indexes.map((i) => i.name).sort()).toEqual(['idx_orders_status_placed', 'idx_orders_user', 'orders_pkey'])
    expect(details.indexes.find((i) => i.name === 'orders_pkey')).toMatchObject({ unique: true, origin: 'pk', columns: ['id'] })
    expect(details.indexes.find((i) => i.name === 'idx_orders_status_placed')?.columns).toEqual(['status', 'placed_at'])
    const users = await d.tableDetails({ schema: 'public', name: 'users' })
    expect(users.triggers.map((t) => t.name)).toEqual(['users_touch'])
    expect(users.indexes.find((i) => i.name === 'users_email_key')?.origin).toBe('u')
    const view = await d.tableDetails({ schema: 'public', name: 'order_summary' })
    expect(view.type).toBe('view')
    expect(view.sql).toMatch(/^CREATE VIEW "public"\."order_summary" AS/)
    await d.close()
  })

  it('cancels a long-running query and stays usable', async () => {
    const d = driver()
    await d.connect()
    const slow = d.query('SELECT pg_sleep(30)')
    await new Promise((r) => setTimeout(r, 300))
    await d.cancel()
    const res = await slow
    expect(res.results[0].kind).toBe('error')
    expect((res.results[0] as any).message).toMatch(/cancel/i)
    const ok = await d.query('SELECT 1')
    expect(ok.results[0].kind).toBe('rows')
    await d.close()
  })

  it('honours read-only mode', async () => {
    const d = driver({ readOnly: true })
    const info = await d.connect()
    expect(info.readonly).toBe(true)
    const res = await d.query("UPDATE settings SET value = 'nope' WHERE key = 'theme'")
    expect(res.results[0].kind).toBe('error')
    expect((res.results[0] as any).message).toMatch(/read-only/)
    await d.close()
  })

  it('runs individual queries in a read-only transaction', async () => {
    const d = driver()
    await d.connect()
    const blocked = await d.query("UPDATE settings SET value = 'nope' WHERE key = 'theme'", [], 100, { readOnly: true })
    expect(blocked.results[0].kind).toBe('error')
    expect((blocked.results[0] as any).message).toMatch(/read-only transaction/)
    expect(blocked.tx).toBe(false)
    const plan = await d.query('EXPLAIN SELECT count(*) FROM orders WHERE status = $1', ['paid'], 100, { readOnly: true })
    expect(plan.results[0].kind).toBe('rows')
    expect(plan.tx).toBe(false)
    const value = await d.query("SELECT value FROM settings WHERE key = 'theme'")
    expect((value.results[0] as RowsResult).rows[0][0]).not.toBe('nope')
    // Refuses to run inside a user's open transaction rather than disturbing it.
    await d.query('BEGIN')
    await expect(d.query('SELECT 1', [], 100, { readOnly: true })).rejects.toThrow(/transaction is open/)
    await d.query('ROLLBACK')
    await d.close()
  })

  it('reports a catalog with per-schema counts and lists objects in pages', async () => {
    const d = driver()
    await d.connect()
    const catalog = await d.catalog()
    expect(catalog.kind).toBe('postgres')
    expect(catalog.defaultSchema).toBe('public')
    expect(catalog.schemas.map((s) => s.name)).toEqual(['public', 'analytics'])
    const pub = catalog.schemas[0].counts
    expect(pub).toMatchObject({ table: 5, view: 1, trigger: 1, function: 3 })
    expect(pub.index).toBeGreaterThanOrEqual(3)
    expect(catalog.schemas[1].counts).toMatchObject({ table: 1, view: 0 })
    expect(catalog.totalTables).toBe(7)

    // Keyset paging over tables and views, in schema then name order.
    const first = await d.listObjects({ kinds: ['table', 'view'], limit: 3 })
    expect(first.items.length).toBe(3)
    expect(first.cursor).not.toBeNull()
    const all = [...first.items]
    let cursor = first.cursor
    while (cursor) {
      const page = await d.listObjects({ kinds: ['table', 'view'], limit: 3, cursor })
      all.push(...page.items)
      cursor = page.cursor
    }
    expect(all.map((o) => `${o.schema}.${o.name}`)).toEqual(['analytics.daily_totals', 'public.no_pk', 'public.order_summary', 'public.orders', 'public.settings', 'public.users', 'public.weird name'])
    const orders = all.find((o) => o.name === 'orders')!
    expect(orders).toMatchObject({ kind: 'table', subtype: 'table' })
    expect(orders.columnCount).toBeGreaterThan(3)
    expect(all.find((o) => o.name === 'order_summary')).toMatchObject({ kind: 'view', subtype: 'view' })

    const onlyAnalytics = await d.listObjects({ schema: 'analytics', kinds: ['table', 'view'] })
    expect(onlyAnalytics.items.map((o) => o.name)).toEqual(['daily_totals'])
    expect(onlyAnalytics.cursor).toBeNull()

    const fns = await d.listObjects({ schema: 'public', kinds: ['function'] })
    const byName = Object.fromEntries(fns.items.map((f) => [f.name, f]))
    expect(byName.order_total).toMatchObject({ kind: 'function', subtype: 'function', args: 'order_id bigint', returns: 'numeric', language: 'sql' })
    expect(byName.archive_orders).toMatchObject({ subtype: 'procedure', language: 'plpgsql' })
    expect(byName.touch_updated_at).toMatchObject({ subtype: 'trigger-function' })

    const idx = await d.listObjects({ schema: 'public', kinds: ['index'] })
    expect(idx.items.map((i) => i.name)).toEqual(expect.arrayContaining(['idx_orders_user', 'idx_orders_status_placed', 'users_email_key']))
    expect(idx.items.every((i) => i.table)).toBe(true)
    expect(idx.items.some((i) => i.name === 'users_pkey')).toBe(false)
    const trg = await d.listObjects({ schema: 'public', kinds: ['trigger'] })
    expect(trg.items).toEqual([expect.objectContaining({ kind: 'trigger', name: 'users_touch', table: 'users' })])
    await expect(d.listObjects({ kinds: ['table', 'index'] })).rejects.toThrow(/tables and views together/)
    await d.close()
  })

  it('searches names and columns and fetches definitions on demand', async () => {
    const d = driver()
    await d.connect()
    const res = await d.searchObjects('order')
    const found = new Map(res.objects.map((o) => [`${o.kind}:${o.name}`, o]))
    expect(found.has('table:orders')).toBe(true)
    expect(found.has('view:order_summary')).toBe(true)
    expect(found.has('function:order_total')).toBe(true)
    expect(found.has('function:archive_orders')).toBe(true)
    expect(found.has('index:idx_orders_user')).toBe(true)
    expect(res.objects[0].name.startsWith('order')).toBe(true) // prefix matches rank first
    const placed = await d.searchObjects('placed')
    expect(placed.columns).toEqual([expect.objectContaining({ schema: 'public', table: 'orders', column: 'placed_at', tableKind: 'table' })])
    expect(placed.objects.map((o) => o.name)).toContain('idx_orders_status_placed')
    expect((await d.searchObjects('%')).objects.length).toBe(0)

    expect((await d.definition({ kind: 'index', schema: 'public', name: 'idx_orders_user' })).sql).toMatch(/^CREATE INDEX idx_orders_user/)
    expect((await d.definition({ kind: 'trigger', schema: 'public', name: 'users_touch' })).sql).toMatch(/^CREATE TRIGGER users_touch/)
    expect((await d.definition({ kind: 'function', schema: 'public', name: 'order_total' })).sql).toMatch(/^CREATE OR REPLACE FUNCTION public\.order_total/)
    expect((await d.definition({ kind: 'function', schema: 'public', name: 'archive_orders' })).sql).toMatch(/^CREATE OR REPLACE PROCEDURE/)
    expect((await d.definition({ kind: 'view', schema: 'public', name: 'order_summary' })).sql).toMatch(/^CREATE VIEW/)
    const fn = found.get('function:order_total')!
    expect((await d.definition({ kind: 'function', schema: 'public', name: 'order_total', id: fn.id })).sql).toContain('order_total')

    const metas = await d.tablesMeta([{ schema: 'public', name: 'users' }, { schema: 'analytics', name: 'daily_totals' }, { name: 'orders' }])
    expect(metas.map((m) => `${m.schema}.${m.name}`).sort()).toEqual(['analytics.daily_totals', 'public.orders', 'public.users'])
    expect(metas.find((m) => m.name === 'users')!.columns.length).toBeGreaterThan(3)
    expect(await d.relationsFor([{ name: 'users' }])).toEqual([{ schema: 'public', table: 'orders', column: 'user_id', refSchema: 'public', refTable: 'users', refColumn: 'id' }])
    expect(await d.relationsFor([{ schema: 'analytics', name: 'daily_totals' }])).toEqual([])
    await d.close()
  })

  it('stays fast on a database with thousands of tables', async () => {
    const d = driver()
    await d.connect()
    // Batches keep each transaction's lock count small; one giant DO block runs out of shared memory.
    const ddl: string[] = []
    for (let s = 1; s <= 3; s++) {
      ddl.push(`CREATE SCHEMA big_${s}`)
      for (let start = 1; start <= 1000; start += 250) {
        ddl.push(`DO $$ BEGIN FOR i IN ${start}..${start + 249} LOOP EXECUTE format('CREATE TABLE big_${s}.t_%s (id int PRIMARY KEY, value_%s int)', i, i); END LOOP; END $$`)
      }
    }
    const created = await d.query(ddl.join(';\n'))
    expect(created.results.map((r) => (r.kind === 'error' ? `error: ${r.message}` : r.kind))).toEqual(ddl.map(() => 'exec'))
    try {
      let t0 = Date.now()
      const catalog = await d.catalog()
      const catalogMs = Date.now() - t0
      expect(catalog.schemas.map((s) => s.name)).toEqual(expect.arrayContaining(['big_1', 'big_2', 'big_3']))
      expect(catalog.schemas.find((s) => s.name === 'big_2')!.counts.table).toBe(1000)
      t0 = Date.now()
      const items = []
      let cursor: string | null = null
      let pages = 0
      do {
        const page = await d.listObjects({ kinds: ['table', 'view'], cursor, limit: 1000 })
        items.push(...page.items)
        cursor = page.cursor
        pages++
      } while (cursor)
      const listMs = Date.now() - t0
      expect(pages).toBeGreaterThanOrEqual(4)
      expect(items.filter((o) => o.schema?.startsWith('big_')).length).toBe(3000)
      t0 = Date.now()
      const found = await d.searchObjects('t_99', 50)
      const searchMs = Date.now() - t0
      expect(found.objects.filter((o) => o.kind === 'table').length).toBe(33) // t_99 and t_990..t_999 in each schema
      const byColumn = await d.searchObjects('value_99', 50)
      expect(byColumn.columns.some((c) => c.column === 'value_99' && c.table === 't_99')).toBe(true)
      expect(byColumn.objects.length).toBe(0)
      expect(catalogMs).toBeLessThan(5000)
      expect(listMs).toBeLessThan(5000)
      expect(searchMs).toBeLessThan(5000)
    } finally {
      await d.query('DROP SCHEMA big_1 CASCADE; DROP SCHEMA big_2 CASCADE; DROP SCHEMA big_3 CASCADE')
      await d.close()
    }
  }, 180_000)

  it('gives friendly errors for bad credentials and databases', async () => {
    await expect(driver({ password: 'wrong' }).connect()).rejects.toThrow(/Password authentication failed for user "test"/)
    await expect(driver({ database: 'nope' }).connect()).rejects.toThrow(/Database "nope" does not exist/)
    await expect(driver({ port: 1 }).connect()).rejects.toThrow(/Connection refused/)
  })

  it('connects through an SSH tunnel via the ConnectionManager', async () => {
    const ssh = await startMockServer()
    const manager = new ConnectionManager({ agentSource, verifyHostKey: async () => true })
    try {
      const conn = await manager.open({
        id: 'pg-tunnel',
        name: 'Tunnelled',
        kind: 'postgres',
        ssh: { host: ssh.host, port: ssh.port, username: ssh.username, auth: 'password', password: ssh.password },
        pg: { host: server.host, port: server.port, database: server.database, user: server.user, password: server.password, sslMode: 'prefer', tunnel: true }
      })
      const info = manager.info(conn)
      expect(info.kind).toBe('postgres')
      expect(info.tunnel).toBe(`${ssh.username}@${ssh.host}:${ssh.port}`)
      expect(info.target).toBe(`test@${server.host}${server.port !== 5432 ? `:${server.port}` : ''}/app`)
      expect(info.db?.details.find((x) => x.label === 'tunnel')?.value).toContain('via')
      const rows = await manager.driver(conn.id).rows({ table: 'settings', offset: 0, limit: 10, withCount: true })
      expect(rows.total).toBe(3)
      // A second connection through the same tunnel (cancel uses one).
      await manager.driver(conn.id).cancel()
      await manager.close(conn.id)

      await expect(
        manager.open({
          id: 'pg-tunnel-bad',
          name: 'Bad target',
          kind: 'postgres',
          ssh: { host: ssh.host, port: ssh.port, username: ssh.username, auth: 'password', password: ssh.password },
          pg: { host: '127.0.0.1', port: 1, database: 'app', user: 'test', password: 'secret', sslMode: 'disable', tunnel: true }
        })
      ).rejects.toThrow(/tunnel could not reach|Nothing is listening/)
    } finally {
      await ssh.close()
    }
  })
})
