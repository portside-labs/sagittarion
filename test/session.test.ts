import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { startMockServer } from './mock-ssh/server.mjs'
import { Session } from '../src/main/ssh/session'
import { fingerprintSha256, matchOpenSshKnownHosts, parseKeyType, KnownHostsStore } from '../src/main/ssh/hostkeys'
import { toCsv, toSqlInserts } from '../src/shared/export'
import { ConnectionManager } from '../src/main/connections/manager'
import { migrateStored } from '../src/main/store/connections'
import type { RowsResult, SshConfig } from '../src/shared/types'

const root = path.resolve(__dirname, '..')
const agentSource = fs.readFileSync(path.join(root, 'src/main/agent/sqlite_agent.py'), 'utf8')
const fixture = path.join(root, 'test/fixtures/sample.db')

let tmp: string
let server: Awaited<ReturnType<typeof startMockServer>>
let noisyServer: Awaited<ReturnType<typeof startMockServer>>
let keyPath: string

function freshDb(name: string): string {
  const target = path.join(tmp, name)
  fs.copyFileSync(fixture, target)
  return target
}

function baseConfig(overrides: Partial<SshConfig> = {}): SshConfig {
  return {
    host: server.host,
    port: server.port,
    username: server.username,
    auth: 'password',
    password: server.password,
    ...overrides
  }
}

function makeSession(ssh: SshConfig, verify: (key: Buffer) => Promise<boolean> = async () => true): Session {
  return new Session(ssh, { agentSource, verifyHostKey: verify })
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-ssh-test-'))
  if (!fs.existsSync(fixture)) {
    const r = spawnSync('python3', [path.join(root, 'test/fixtures/make-sample-db.py'), fixture], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error('fixture generation failed')
  }
  keyPath = path.join(tmp, 'id_ed25519')
  const gen = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath], { stdio: 'inherit' })
  if (gen.status !== 0) throw new Error('ssh-keygen failed')
  const pub = fs.readFileSync(keyPath + '.pub', 'utf8')
  server = await startMockServer({ authorizedKeys: [pub] })
  noisyServer = await startMockServer({ noise: true })
})

afterAll(async () => {
  await server?.close()
  await noisyServer?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('Session over SSH', () => {
  it('connects with a password, opens the database and reads schema and rows', async () => {
    const db = freshDb('a.db')
    const s = makeSession(baseConfig())
    const stages: string[] = []
    ;(s as any).opts.onProgress = (p: any) => stages.push(p.stage)
    await s.connect()
    const info = await s.openDatabase(db)
    expect(info.sqliteVersion).toMatch(/^3\./)
    expect(info.path).toBe(db)
    expect(info.readonly).toBe(false)
    expect(s.interpreter).toMatch(/python/)
    expect(stages).toContain('probing')
    expect(stages).toContain('starting-agent')

    const schema = await s.schema()
    expect(schema.tables.map((t) => t.name)).toEqual(['big_numbers', 'orders', 'settings', 'users', 'weird name'])
    expect(schema.views.map((v) => v.name)).toEqual(['order_summary'])
    const users = schema.tables.find((t) => t.name === 'users')!
    expect(users.rowidAlias).toBe('rowid')
    expect(users.pk).toEqual(['id'])
    const settings = schema.tables.find((t) => t.name === 'settings')!
    expect(settings.withoutRowid).toBe(true)
    expect(settings.rowidAlias).toBeNull()
    const weird = schema.tables.find((t) => t.name === 'weird name')!
    expect(weird.rowidAlias).toBe('_rowid_')

    const rows = await s.rows({ table: 'users', offset: 0, limit: 5, withCount: true, orderBy: 'id', orderDir: 'desc' })
    expect(rows.total).toBe(60)
    expect(rows.rows.length).toBe(5)
    expect(rows.rowids).toEqual([60, 59, 58, 57, 56])
    expect(rows.columns.map((c) => c.name)).toContain('email')

    const filtered = await s.rows({ table: 'orders', offset: 0, limit: 10, where: "status = 'paid' AND total > 500", withCount: true })
    expect(filtered.total).toBeGreaterThan(0)
    expect(filtered.rows.every((r) => r[3] === 'paid')).toBe(true)

    expect(schema.relations).toEqual([{ table: 'orders', column: 'user_id', refTable: 'users', refColumn: 'id' }])

    const details = await s.tableDetails('orders')
    expect(details.foreignKeys[0]).toMatchObject({ table: 'users', from: 'user_id', to: 'id' })
    expect(details.indexes.map((i) => i.name).sort()).toEqual(['idx_orders_status_placed', 'idx_orders_user'])
    expect(details.triggers.map((t) => t.name)).toEqual(['orders_touch_user'])

    const q = await s.query('SELECT id, name FROM users WHERE id <= 2 ORDER BY id; SELECT count(*) FROM orders')
    expect(q.results.length).toBe(2)
    const first = q.results[0] as RowsResult
    expect(first.kind).toBe('rows')
    expect(first.rows[0][1]).toBe('Radia Hamilton')
    expect(q.tx).toBe(false)

    const big = await s.rows({ table: 'big_numbers', offset: 0, limit: 10 })
    expect(big.rows[0][1]).toEqual({ $type: 'int', value: '9007199254740993' })
    expect(big.rows[2][2]).toBeNull() // SQLite stores NaN as NULL
    expect(big.rows[3][2]).toEqual({ $type: 'float', value: 'inf' })
    expect(big.rows[4][2]).toEqual({ $type: 'float', value: '2.0' })
    expect(big.rows[0][2]).toBe(1.5)

    const listing = await s.readdir(path.dirname(db))
    expect(listing.entries.some((e) => e.name === 'a.db' && !e.isDir)).toBe(true)
    expect(listing.parent).toBe(fs.realpathSync(path.dirname(path.dirname(db))))
    const home = await s.home()
    expect(home).toBe(fs.realpathSync(os.homedir()))

    s.close()
    expect(s.closed).toBe(true)
  })

  it('applies staged changes atomically and rolls back on failure', async () => {
    const db = freshDb('b.db')
    const s = makeSession(baseConfig())
    await s.connect()
    await s.openDatabase(db)
    const applied = await s.apply([
      { type: 'update', table: 'users', key: { rowid: 1, alias: 'rowid' }, values: { name: 'Renamed', age: null } },
      { type: 'insert', table: 'users', values: { name: 'Inserted', email: 'inserted@example.com' } },
      { type: 'update', table: 'settings', key: { pk: { key: 'theme' } }, values: { value: 'light' } },
      { type: 'delete', table: 'orders', key: { rowid: 1, alias: 'rowid' } }
    ])
    expect(applied).toBe(4)
    const check = await s.query(
      "SELECT name, age FROM users WHERE id = 1; SELECT count(*) FROM users WHERE name = 'Inserted'; SELECT value FROM settings WHERE key = 'theme'; SELECT count(*) FROM orders WHERE id = 1"
    )
    expect((check.results[0] as RowsResult).rows[0]).toEqual(['Renamed', null])
    expect((check.results[1] as RowsResult).rows[0][0]).toBe(1)
    expect((check.results[2] as RowsResult).rows[0][0]).toBe('light')
    expect((check.results[3] as RowsResult).rows[0][0]).toBe(0)

    await expect(
      s.apply([
        { type: 'update', table: 'users', key: { rowid: 2, alias: 'rowid' }, values: { name: 'Should roll back' } },
        { type: 'update', table: 'users', key: { rowid: 999999, alias: 'rowid' }, values: { name: 'x' } }
      ])
    ).rejects.toThrow(/matched 0 rows.*rolled back/)
    const after = await s.query('SELECT name FROM users WHERE id = 2')
    expect((after.results[0] as RowsResult).rows[0][0]).not.toBe('Should roll back')
    s.close()
  })

  it('cancels a long-running query', async () => {
    const s = makeSession(baseConfig())
    await s.connect()
    await s.openDatabase(fixture, true)
    const slow = s.query('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c')
    await new Promise((r) => setTimeout(r, 300))
    s.cancel()
    const res = await slow
    expect(res.results[0].kind).toBe('error')
    expect((res.results[0] as any).message).toMatch(/interrupted/)
    // The connection is still usable afterwards.
    const ok = await s.query('SELECT 1')
    expect(ok.results[0].kind).toBe('rows')
    s.close()
  })

  it('enforces read-only mode', async () => {
    const db = freshDb('c.db')
    const s = makeSession(baseConfig())
    await s.connect()
    const info = await s.openDatabase(db, true)
    expect(info.readonly).toBe(true)
    const res = await s.query("UPDATE users SET name = 'nope' WHERE id = 1")
    expect(res.results[0].kind).toBe('error')
    expect((res.results[0] as any).message).toMatch(/readonly/)
    s.close()
  })

  it('runs individual queries read-only on a writable database', async () => {
    const db = freshDb('c2.db')
    const s = makeSession(baseConfig())
    await s.connect()
    const info = await s.openDatabase(db)
    expect(info.readonly).toBe(false)
    const blocked = await s.query("UPDATE users SET name = 'nope' WHERE id = 1", [], 100, { readOnly: true })
    expect(blocked.results[0].kind).toBe('error')
    expect((blocked.results[0] as any).message).toMatch(/readonly/)
    const plan = await s.query('EXPLAIN QUERY PLAN SELECT count(*) FROM orders WHERE status = ?', ['paid'], 100, { readOnly: true })
    expect(plan.results[0].kind).toBe('rows')
    // The guard is per call: the connection is writable again afterwards.
    const ok = await s.query("UPDATE users SET name = name WHERE id = 1")
    expect(ok.results[0].kind).toBe('exec')
    const unchanged = await s.query('SELECT name FROM users WHERE id = 1')
    expect((unchanged.results[0] as RowsResult).rows[0][0]).toBe('Radia Hamilton')
    s.close()
  })

  it('reports a clear error for a missing database file', async () => {
    const s = makeSession(baseConfig())
    await s.connect()
    await expect(s.openDatabase('/nonexistent/dir/missing.db')).rejects.toThrow(/No such file on remote host/)
    s.close()
  })

  it('authenticates with a private key', async () => {
    const s = makeSession(baseConfig({ auth: 'key', privateKeyPath: keyPath, password: undefined }))
    await s.connect()
    const res = await s.exec('echo key-auth-ok')
    expect(res.stdout.trim()).toBe('key-auth-ok')
    s.close()
  })

  it('gives a friendly error on a bad password', async () => {
    const s = makeSession(baseConfig({ password: 'wrong' }))
    await expect(s.connect()).rejects.toThrow(/authentication failed for test@127\.0\.0\.1/i)
  })

  it('aborts when the host key is rejected', async () => {
    const s = makeSession(baseConfig(), async () => false)
    await expect(s.connect()).rejects.toThrow(/Host key was not accepted/)
  })

  it('gives a friendly error when nothing is listening', async () => {
    const s = makeSession(baseConfig({ port: 1 }))
    await expect(s.connect()).rejects.toThrow(/Connection refused|unreachable|Timed out/)
  })

  it('starts the helper even when the login shell prints noise', async () => {
    const s = makeSession(baseConfig({ host: noisyServer.host, port: noisyServer.port }))
    await s.connect()
    const info = await s.openDatabase(fixture, true)
    expect(info.sqliteVersion).toMatch(/^3\./)
    const q = await s.query('SELECT 42 AS answer')
    expect((q.results[0] as RowsResult).rows[0][0]).toBe(42)
    s.close()
  })

  it('exposes the host key to the verifier with a stable fingerprint', async () => {
    let seen: Buffer | null = null
    const s = makeSession(baseConfig(), async (key) => {
      seen = key
      return true
    })
    await s.connect()
    s.close()
    expect(seen).not.toBeNull()
    expect(parseKeyType(seen!)).toBe('ssh-rsa')
    expect(fingerprintSha256(seen!)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
  })
})

describe('ConnectionManager', () => {
  it('opens a SQLite connection end to end and reports it', async () => {
    const db = freshDb('m.db')
    const manager = new ConnectionManager({ agentSource, verifyHostKey: async () => true })
    const closed: string[] = []
    manager.on('closed', (e: { reason: string }) => closed.push(e.reason))
    const conn = await manager.open({ id: 'c1', name: 'Mock', kind: 'sqlite', ssh: baseConfig(), remotePath: db })
    const info = manager.info(conn)
    expect(info.kind).toBe('sqlite')
    expect(info.target).toBe(`test@127.0.0.1:${server.port}`)
    expect(info.db?.label).toBe(db)
    expect(info.db?.serverVersion).toMatch(/^SQLite 3\./)
    const schema = await manager.driver(conn.id).schema()
    expect(schema.kind).toBe('sqlite')
    expect(schema.tables.map((t) => t.name)).toContain('users')
    const details = await manager.driver(conn.id).tableDetails({ name: 'orders' })
    expect(details.foreignKeys.length).toBe(1)
    await manager.close(conn.id)
    expect(() => manager.get(conn.id)).toThrow(/no longer open/)
    // A user-initiated close does not fire the closed event.
    expect(closed).toEqual([])
  })

  it('forwards a local port through the SSH connection', async () => {
    const echo = net.createServer((sock) => sock.pipe(sock))
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()))
    const echoPort = (echo.address() as net.AddressInfo).port
    const s = makeSession(baseConfig())
    await s.connect()
    const fwd = await s.createLocalForward('127.0.0.1', echoPort)
    const reply = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(fwd.port, '127.0.0.1', () => sock.write('ping through tunnel'))
      sock.on('data', (d) => {
        resolve(d.toString())
        sock.destroy()
      })
      sock.on('error', reject)
    })
    expect(reply).toBe('ping through tunnel')
    fwd.close()
    s.close()
    echo.close()
  })
})

describe('saved connection migration', () => {
  it('lifts the old flat SSH layout into the nested one', () => {
    const migrated = migrateStored({
      id: 'x',
      name: 'Old',
      host: 'h',
      port: '2222',
      username: 'u',
      auth: 'password',
      savePassword: true,
      encryptedPassword: 'abc',
      remotePath: '/tmp/a.db',
      color: '#fff'
    })
    expect(migrated).toMatchObject({ id: 'x', kind: 'sqlite', remotePath: '/tmp/a.db', color: '#fff', ssh: { host: 'h', port: 2222, username: 'u', auth: 'password', encryptedPassword: 'abc' } })
    expect(migrateStored({ id: 'y', kind: 'postgres', ssh: { host: 'h' } })?.kind).toBe('postgres')
    expect(migrateStored({ nonsense: true })).toBeNull()
  })
})

describe('known_hosts handling', () => {
  it('matches plain, port-qualified and hashed OpenSSH entries', () => {
    const key = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 3]), Buffer.from([1, 2, 3])])
    const b64 = key.toString('base64')
    const other = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 3]), Buffer.from([9, 9, 9])]).toString('base64')
    const content = [
      '# comment',
      `example.com,10.0.0.5 ssh-ed25519 ${b64}`,
      `[alt.example.com]:2222 ssh-ed25519 ${b64}`,
      `changed.example.com ssh-ed25519 ${other}`,
      `@revoked revoked.example.com ssh-ed25519 ${b64}`
    ].join('\n')
    expect(matchOpenSshKnownHosts(content, 'EXAMPLE.com', 22, key)).toBe('match')
    expect(matchOpenSshKnownHosts(content, '10.0.0.5', 22, key)).toBe('match')
    expect(matchOpenSshKnownHosts(content, 'alt.example.com', 2222, key)).toBe('match')
    expect(matchOpenSshKnownHosts(content, 'alt.example.com', 22, key)).toBe('none')
    expect(matchOpenSshKnownHosts(content, 'changed.example.com', 22, key)).toBe('mismatch')
    expect(matchOpenSshKnownHosts(content, 'revoked.example.com', 22, key)).toBe('mismatch')
    expect(matchOpenSshKnownHosts(content, 'unknown.example.com', 22, key)).toBe('none')

    // Hashed entry produced by: ssh-keygen -H style, HMAC-SHA1(salt, hostname)
    const salt = Buffer.from('0123456789abcdefghij')
    const { createHmac } = require('node:crypto')
    const hash = createHmac('sha1', salt).update('hashed.example.com').digest('base64')
    const hashed = `|1|${salt.toString('base64')}|${hash} ssh-ed25519 ${b64}`
    expect(matchOpenSshKnownHosts(hashed, 'hashed.example.com', 22, key)).toBe('match')
  })

  it('remembers keys accepted through the app store', async () => {
    const store = new KnownHostsStore(path.join(tmp, 'kh', 'known_hosts.json'))
    const key = Buffer.concat([Buffer.from([0, 0, 0, 7]), Buffer.from('ssh-rsa'), Buffer.from([0, 0, 0, 1, 7])])
    expect((await store.check('h', 22, key)).status).toBe('unknown')
    await store.save(store.entryFor('h', 22, key))
    expect((await store.check('H', 22, key)).status).toBe('trusted')
    const changed = Buffer.concat([Buffer.from([0, 0, 0, 7]), Buffer.from('ssh-rsa'), Buffer.from([0, 0, 0, 1, 8])])
    const res = await store.check('h', 22, changed)
    expect(res.status).toBe('mismatch')
    expect(res.previous?.fingerprint).toBe(fingerprintSha256(key))
  })
})

describe('export helpers', () => {
  it('produces CSV and SQL', () => {
    const csv = toCsv(['a', 'b'], [[1, 'x,y'], [null, 'q"uote'], [{ $type: 'int', value: '99999999999999999' }, { $type: 'blob', base64: 'AAH/', size: 3, truncated: false }]])
    expect(csv).toBe('a,b\r\n1,"x,y"\r\n,"q""uote"\r\n99999999999999999,X\'0001ff\'\r\n')
    const sql = toSqlInserts('t x', ['a', 'b'], [[1, "it's"], [null, { $type: 'blob', base64: 'AAH/', size: 3, truncated: false }]])
    expect(sql).toBe('INSERT INTO "t x" ("a", "b") VALUES (1, \'it\'\'s\');\nINSERT INTO "t x" ("a", "b") VALUES (NULL, X\'0001ff\');\n')
  })
})
