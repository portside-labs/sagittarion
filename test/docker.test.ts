// Runs the SSH layer against real OpenSSH servers in Docker containers.
// Opt in with: DOCKER_TESTS=1 npx vitest run test/docker.test.ts
// Set DOCKER_BASE to an Alpine-flavoured image you already have if the registry is unreachable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { buildImages, IMAGES, keyPath } from './docker/build.mjs'
import { Session } from '../src/main/ssh/session'
import { parseKeyType } from '../src/main/ssh/hostkeys'
import type { ConnectionConfig, RowsResult } from '../src/shared/types'

const enabled = process.env.DOCKER_TESTS === '1'
const root = path.resolve(__dirname, '..')
const agentSource = fs.readFileSync(path.join(root, 'src/main/agent/sqlite_agent.py'), 'utf8')

interface Container {
  id: string
  port: number
}
const containers: Record<string, Container> = {}

function docker(args: string[]): string {
  const r = spawnSync('docker', args, { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`docker ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

async function waitForSsh(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port })
      const done = (v: boolean) => {
        sock.destroy()
        resolve(v)
      }
      sock.once('data', (d) => done(d.toString().startsWith('SSH-')))
      sock.once('error', () => done(false))
      setTimeout(() => done(false), 2000)
    })
    if (ok) return
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`sshd on port ${port} did not come up`)
}

function start(name: string, image: string): void {
  const id = docker(['run', '-d', '--rm', '-p', '127.0.0.1::22', image])
  const mapping = docker(['port', id, '22/tcp']).split('\n')[0]
  containers[name] = { id, port: Number(mapping.split(':').pop()) }
}

function cfg(name: string, username: string, overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: name,
    name,
    host: '127.0.0.1',
    port: containers[name].port,
    username,
    auth: 'password',
    password: 'secret',
    remotePath: '~/sample.db',
    ...overrides
  }
}

function session(c: ConnectionConfig, verify: (key: Buffer) => Promise<boolean> = async () => true): Session {
  return new Session(c, { agentSource, verifyHostKey: verify })
}

describe.skipIf(!enabled)('real OpenSSH servers in Docker', () => {
  beforeAll(async () => {
    buildImages()
    start('alpine', IMAGES.alpine)
    start('bare', IMAGES.bare)
    await Promise.all(Object.values(containers).map((c) => waitForSsh(c.port)))
  }, 600_000)

  afterAll(() => {
    for (const c of Object.values(containers)) spawnSync('docker', ['rm', '-f', c.id], { stdio: 'ignore' })
  })

  it('works with a bash login shell (password auth)', async () => {
    const s = session(cfg('alpine', 'bashuser'))
    await s.connect()
    const info = await s.openDatabase('~/sample.db')
    expect(info.path).toBe('/home/bashuser/sample.db')
    expect(s.interpreter).toBe('python3')
    const schema = await s.schema()
    expect(schema.tables.map((t) => t.name)).toContain('users')
    const rows = await s.rows({ table: 'users', offset: 0, limit: 3, withCount: true })
    expect(rows.total).toBe(60)
    await s.apply([{ type: 'update', table: 'users', key: { rowid: 1, alias: 'rowid' }, values: { name: 'Changed over real SSH' } }])
    const check = docker(['exec', containers.alpine.id, 'sqlite3', '/home/bashuser/sample.db', 'SELECT name FROM users WHERE id = 1'])
    expect(check).toBe('Changed over real SSH')
    const listing = await s.readdir('~')
    expect(listing.entries.some((e) => e.name === 'sample.db')).toBe(true)
    s.close()
  })

  it('works when the login shell is fish with a chatty config.fish (public key auth)', async () => {
    const s = session(cfg('alpine', 'fishuser', { auth: 'key', privateKeyPath: keyPath, password: undefined, remotePath: '~/data/sample.db' }))
    await s.connect()
    const info = await s.openDatabase('~/data/sample.db')
    expect(info.path).toBe('/home/fishuser/data/sample.db')
    const q = await s.query("SELECT count(*) FROM orders WHERE status = 'paid'")
    expect(q.results[0].kind).toBe('rows')
    expect(typeof (q.results[0] as RowsResult).rows[0][0]).toBe('number')
    const home = await s.home()
    expect(home).toBe('/home/fishuser')
    s.close()
  })

  it('presents the real host key to the verifier', async () => {
    let seen: Buffer | null = null
    const s = session(cfg('alpine', 'ashuser'), async (key) => {
      seen = key
      return true
    })
    await s.connect()
    s.close()
    expect(seen).not.toBeNull()
    const type = parseKeyType(seen!)
    const file = type === 'ssh-ed25519' ? 'ssh_host_ed25519_key.pub' : type.startsWith('ecdsa') ? 'ssh_host_ecdsa_key.pub' : 'ssh_host_rsa_key.pub'
    const pub = docker(['exec', containers.alpine.id, 'cat', `/etc/ssh/${file}`]).split(/\s+/)[1]
    expect(seen!.toString('base64')).toBe(pub)
  })

  it('works with busybox ash as the login shell', async () => {
    const s = session(cfg('alpine', 'ashuser'))
    await s.connect()
    const info = await s.openDatabase('~/sample.db')
    expect(info.path).toBe('/home/ashuser/sample.db')
    const rows = await s.rows({ table: 'settings', offset: 0, limit: 10 })
    expect(rows.rowids).toBeNull()
    expect(rows.pk).toEqual(['key'])
    s.close()
  })

  it('explains clearly when the remote has no Python', async () => {
    const s = session(cfg('bare', 'bareuser', { remotePath: '/tmp/x.db' }))
    await s.connect()
    await expect(s.openDatabase('/tmp/x.db')).rejects.toThrow(/sqlite3 CLI .* but no Python 3/)
    s.close()
  })
})
