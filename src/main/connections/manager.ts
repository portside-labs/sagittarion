import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import type { ConnectProgress, ConnectionConfig, SessionInfo, SshConfig } from '@shared/types'
import { describeTarget, normalizeConnection } from '@shared/connections'
import { Session, type LocalForward } from '../ssh/session'
import type { DatabaseDriver } from '../db/driver'
import { SqliteSshDriver } from '../db/sqlite-ssh'
import { PostgresDriver } from '../db/postgres'

export interface ActiveConnection {
  id: string
  config: ConnectionConfig
  ssh: Session | null
  forward: LocalForward | null
  driver: DatabaseDriver | null
  closed: boolean
}

export interface ManagerDeps {
  agentSource: string
  verifyHostKey: (ssh: SshConfig, key: Buffer) => Promise<boolean>
}

export interface OpenParams {
  /** SQLite only: open the configured file after connecting (default true). */
  openDatabase?: boolean
  onProgress?: (p: ConnectProgress) => void
}

/** Owns every live connection, whatever kind of database is behind it. */
export class ConnectionManager extends EventEmitter {
  private readonly active = new Map<string, ActiveConnection>()
  private readonly deps: ManagerDeps

  constructor(deps: ManagerDeps) {
    super()
    this.deps = deps
  }

  get(id: string): ActiveConnection {
    const conn = this.active.get(id)
    if (!conn || conn.closed) throw new Error('This connection is no longer open. Reconnect to continue.')
    return conn
  }

  driver(id: string): DatabaseDriver {
    const conn = this.get(id)
    if (!conn.driver) throw new Error('No database is open on this connection.')
    return conn.driver
  }

  /** The SSH session behind a SQLite connection (file browser, opening files). */
  sshSession(id: string): Session {
    const conn = this.get(id)
    if (conn.config.kind !== 'sqlite' || !conn.ssh) throw new Error('This feature is only available for SQLite over SSH connections.')
    return conn.ssh
  }

  async open(rawConfig: ConnectionConfig, params: OpenParams = {}): Promise<ActiveConnection> {
    const config = normalizeConnection(rawConfig)
    const conn: ActiveConnection = { id: randomBytes(8).toString('hex'), config, ssh: null, forward: null, driver: null, closed: false }
    const onProgress = params.onProgress
    try {
      if (config.kind === 'sqlite') {
        const session = this.makeSession(config.ssh, onProgress)
        conn.ssh = session
        this.wireSession(conn, session)
        await session.connect()
        const driver = new SqliteSshDriver(session)
        conn.driver = driver
        if (params.openDatabase !== false) {
          if (!config.remotePath?.trim()) throw new Error('No remote database path given.')
          await driver.open(config.remotePath.trim(), Boolean(config.readOnly))
        }
      } else {
        const pgc = config.pg
        if (!pgc) throw new Error('PostgreSQL connection details are missing.')
        if (!pgc.host.trim()) throw new Error('Database host is required.')
        if (!pgc.database.trim()) throw new Error('Database name is required.')
        if (!pgc.user.trim()) throw new Error('Database user is required.')
        let host = pgc.host.trim()
        let port = pgc.port
        let servername: string | undefined
        let tunnel: string | null = null
        if (pgc.tunnel) {
          const session = this.makeSession(config.ssh, onProgress)
          conn.ssh = session
          this.wireSession(conn, session)
          await session.connect()
          onProgress?.({ stage: 'tunnel', message: `Opening a tunnel to ${host}:${port} through ${config.ssh.host}…` })
          conn.forward = await session.createLocalForward(host, port)
          servername = host
          tunnel = `${config.ssh.username}@${config.ssh.host}`
          host = '127.0.0.1'
          port = conn.forward.port
        }
        const driver = new PostgresDriver({
          host,
          port,
          database: pgc.database.trim(),
          user: pgc.user.trim(),
          password: pgc.password,
          sslMode: pgc.sslMode,
          servername,
          readOnly: Boolean(config.readOnly),
          displayHost: pgc.host.trim(),
          displayPort: pgc.port,
          tunnel,
          onProgress
        })
        conn.driver = driver
        driver.on('closed', (reason: string) => this.markClosed(conn, reason))
        try {
          await driver.connect()
        } catch (err) {
          const fe = conn.ssh?.lastForwardError
          if (fe) throw new Error(`The SSH tunnel could not reach ${pgc.host}:${pgc.port} from ${config.ssh.host}: ${fe.message}`)
          throw err
        }
      }
    } catch (err) {
      await this.teardown(conn)
      throw err
    }
    this.active.set(conn.id, conn)
    return conn
  }

  async close(id: string): Promise<void> {
    const conn = this.active.get(id)
    if (conn) await this.teardown(conn)
  }

  async closeAll(): Promise<void> {
    for (const conn of [...this.active.values()]) await this.teardown(conn)
  }

  info(conn: ActiveConnection): SessionInfo {
    const cfg = conn.config
    const s = conn.ssh
    return {
      sessionId: conn.id,
      connectionId: cfg.id,
      name: cfg.name,
      kind: cfg.kind,
      color: cfg.color,
      target: describeTarget(cfg),
      db: conn.driver?.info() ?? null,
      interpreter: s?.interpreter ?? undefined,
      serverBanner: s?.serverBanner,
      homeDir: s?.homeDir ?? null,
      tunnel: cfg.kind === 'postgres' && cfg.pg?.tunnel ? `${cfg.ssh.username}@${cfg.ssh.host}` : null
    }
  }

  private makeSession(ssh: SshConfig, onProgress?: (p: ConnectProgress) => void): Session {
    return new Session(ssh, {
      agentSource: this.deps.agentSource,
      verifyHostKey: (key) => this.deps.verifyHostKey(ssh, key),
      onProgress
    })
  }

  private wireSession(conn: ActiveConnection, session: Session): void {
    session.on('close', ({ reason }: { reason: string }) => this.markClosed(conn, reason))
    session.on('agent-exit', (info: { stderr?: string }) => {
      const detail = info?.stderr?.trim() ? `: ${info.stderr.trim().slice(-300)}` : ''
      this.markClosed(conn, `The remote helper process exited${detail}`)
      void this.teardown(conn)
    })
    session.on('error', () => {
      /* surfaced through close */
    })
  }

  private markClosed(conn: ActiveConnection, reason: string): void {
    if (conn.closed) return
    conn.closed = true
    this.active.delete(conn.id)
    this.emit('closed', { sessionId: conn.id, reason })
  }

  private async teardown(conn: ActiveConnection): Promise<void> {
    conn.closed = true
    this.active.delete(conn.id)
    try {
      await conn.driver?.close()
    } catch {
      /* ignore */
    }
    conn.forward?.close()
    conn.ssh?.close()
  }
}
