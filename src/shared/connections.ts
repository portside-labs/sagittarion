import type { ConnectionConfig, DatabaseKind, PostgresConfig, SshConfig, SshProfile, TableRef } from './types'

export function defaultSsh(): SshConfig {
  return { host: '', port: 22, username: '', auth: 'key', savePassword: true, savePassphrase: true }
}

export function defaultPostgres(): PostgresConfig {
  return { host: 'localhost', port: 5432, database: '', user: '', savePassword: true, sslMode: 'prefer', tunnel: false }
}

export function newConnection(kind: DatabaseKind): ConnectionConfig {
  return {
    id: '',
    name: '',
    kind,
    readOnly: false,
    ssh: defaultSsh(),
    remote: kind === 'sqlite' ? false : undefined,
    remotePath: kind === 'sqlite' ? '' : undefined,
    pg: kind === 'postgres' ? defaultPostgres() : undefined
  }
}

/** Fill in anything a saved or hand-edited config might be missing. */
export function normalizeConnection(cfg: ConnectionConfig): ConnectionConfig {
  const out: ConnectionConfig = {
    ...cfg,
    kind: cfg.kind === 'postgres' ? 'postgres' : 'sqlite',
    ssh: { ...defaultSsh(), ...(cfg.ssh ?? {}) }
  }
  out.ssh.port = Number(out.ssh.port) || 22
  const group = cfg.group?.trim()
  if (group) out.group = group
  else delete out.group
  // Connections saved before local files were supported were all over SSH.
  if (out.kind === 'sqlite') out.remote = cfg.remote ?? Boolean(cfg.ssh?.host)
  else delete out.remote
  if (out.kind === 'postgres') {
    out.pg = { ...defaultPostgres(), ...(cfg.pg ?? {}) }
    out.pg.port = Number(out.pg.port) || 5432
  }
  return out
}

/** "user@host" or "user@host/database" - how the connection is described in the UI. */
export function describeTarget(cfg: ConnectionConfig): string {
  if (cfg.kind === 'postgres' && cfg.pg) {
    const p = cfg.pg
    return `${p.user}@${p.host}${p.port !== 5432 ? `:${p.port}` : ''}/${p.database}`
  }
  if (cfg.kind === 'sqlite' && !cfg.remote) return 'This computer'
  return describeSsh(cfg.ssh)
}

/** "user@host[:port]" for an SSH endpoint. */
export function describeSsh(s: SshConfig): string {
  return `${s.username}@${s.host}${s.port !== 22 ? `:${s.port}` : ''}`
}

/** True when the connection goes through SSH at all: a remote SQLite file or a Postgres tunnel. */
export function usesSsh(cfg: ConnectionConfig): boolean {
  return cfg.kind === 'sqlite' ? cfg.remote !== false : Boolean(cfg.pg?.tunnel)
}

/** The SSH fields a connection actually uses: its profile's when it references one, else its own. */
export function resolveSshProfile(cfg: ConnectionConfig, profiles: SshProfile[]): ConnectionConfig {
  if (!cfg.sshProfileId) return cfg
  const p = profiles.find((x) => x.id === cfg.sshProfileId)
  if (!p) return cfg
  const { id: _id, name: _name, createdAt: _c, lastUsedAt: _l, ...ssh } = p
  return { ...cfg, ssh }
}

/** Parse a libpq-style URL such as postgres://user:pass@host:5432/db?sslmode=require. */
export function parsePostgresUrl(input: string): Partial<PostgresConfig> | null {
  const text = input.trim()
  if (!/^postgres(ql)?:\/\//i.test(text)) return null
  let url: URL
  try {
    url = new URL(text.replace(/^postgres(ql)?:/i, 'http:'))
  } catch {
    return null
  }
  const out: Partial<PostgresConfig> = {}
  if (url.hostname) out.host = decodeURIComponent(url.hostname)
  if (url.port) out.port = Number(url.port)
  if (url.username) out.user = decodeURIComponent(url.username)
  if (url.password) out.password = decodeURIComponent(url.password)
  const db = url.pathname.replace(/^\//, '')
  if (db) out.database = decodeURIComponent(db)
  const ssl = url.searchParams.get('sslmode')
  if (ssl === 'disable' || ssl === 'require' || ssl === 'verify-full' || ssl === 'prefer') out.sslMode = ssl
  else if (ssl === 'verify-ca') out.sslMode = 'verify-full'
  else if (ssl === 'allow') out.sslMode = 'prefer'
  return out
}

/** Stable identity for a table, safe for names containing dots. */
export function tableKey(ref: TableRef): string {
  return JSON.stringify([ref.schema ?? '', ref.name])
}

/** Display name: hides the default schema so SQLite tables and "public" tables stay short. */
export function tableLabel(ref: TableRef, defaultSchema?: string): string {
  return ref.schema && ref.schema !== defaultSchema ? `${ref.schema}.${ref.name}` : ref.name
}

export function sameTable(a: TableRef, b: TableRef): boolean {
  return a.name === b.name && (a.schema ?? '') === (b.schema ?? '')
}
