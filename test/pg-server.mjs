// Provides a PostgreSQL server for tests: PG_URL if set, otherwise a throwaway
// Docker container. Used by the vitest suite and the end-to-end script.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
export const FIXTURE_SQL = path.join(here, 'fixtures', 'pg-fixture.sql')

function docker(args) {
  const r = spawnSync('docker', args, { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`docker ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

export function dockerAvailable() {
  return spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 15000 }).status === 0
}

async function waitForPort(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port })
      sock.once('connect', () => {
        sock.destroy()
        resolve(true)
      })
      sock.once('error', () => resolve(false))
    })
    if (ok) return
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`PostgreSQL on port ${port} did not come up`)
}

/**
 * @returns {Promise<{ url: string, host: string, port: number, database: string, user: string, password: string, close: () => Promise<void> }>}
 */
export async function providePostgres() {
  if (process.env.PG_URL) {
    const u = new URL(process.env.PG_URL)
    return {
      url: process.env.PG_URL,
      host: u.hostname,
      port: Number(u.port || 5432),
      database: u.pathname.replace(/^\//, ''),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      close: async () => {}
    }
  }
  if (!dockerAvailable()) throw new Error('No PG_URL and Docker is not available')
  const image = process.env.PG_IMAGE || 'postgres:16-alpine'
  const id = docker(['run', '-d', '--rm', '-e', 'POSTGRES_USER=test', '-e', 'POSTGRES_PASSWORD=secret', '-e', 'POSTGRES_DB=app', '-p', '127.0.0.1::5432', image])
  const port = Number(docker(['port', id, '5432/tcp']).split('\n')[0].split(':').pop())
  const close = async () => {
    spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore' })
  }
  try {
    await waitForPort(port)
    // The official image restarts once during initialisation; wait for the final server to accept logins.
    const deadline = Date.now() + 60000
    for (;;) {
      const r = spawnSync('docker', ['exec', id, 'pg_isready', '-h', '127.0.0.1', '-U', 'test', '-d', 'app'], { stdio: 'ignore' })
      if (r.status === 0) break
      if (Date.now() > deadline) throw new Error('pg_isready never succeeded')
      await new Promise((r) => setTimeout(r, 400))
    }
    // pg_isready can pass a moment before authentication is fully set up.
    await new Promise((r) => setTimeout(r, 500))
  } catch (err) {
    await close()
    throw err
  }
  return { url: `postgres://test:secret@127.0.0.1:${port}/app`, host: '127.0.0.1', port, database: 'app', user: 'test', password: 'secret', close }
}

/** (Re)creates the fixture schema and data. */
export async function loadFixture(url) {
  const sql = fs.readFileSync(FIXTURE_SQL, 'utf8')
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end()
  }
}
