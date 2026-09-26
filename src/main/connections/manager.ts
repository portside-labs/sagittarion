import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import type { ConnectProgress, ConnectionConfig, DatabaseInfo, SessionInfo, SshConfig, SshProfile } from '@shared/types'
import type { SessionLinkEvent } from '@shared/api'
import { describeSsh, describeTarget, normalizeConnection, resolveSshProfile, usesSsh } from '@shared/connections'
import { Session, type LocalForward } from '../ssh/session'
import { LocalSession } from '../ssh/local-session'
import type { AgentSession } from '../ssh/agent-session'
import type { DatabaseDriver } from '../db/driver'
import { SqliteSshDriver } from '../db/sqlite-ssh'
import { PostgresDriver } from '../db/postgres'

/**
 * One open connection. Its link to the database (SSH connection, tunnel, helper, driver) can drop by itself, as an
 * idle connection closed by the server or the network does; the connection stays open, and the next call that needs
 * the database makes a new link.
 */
export interface ActiveConnection {
  id: string
  /** The configuration as opened, with any SSH profile already resolved into `ssh`. */
  config: ConnectionConfig
  /** The SSH connection in use: a remote SQLite host or a Postgres tunnel. */
  ssh: Session | null
  /** The helper session behind a SQLite connection, local or remote. */
  session: AgentSession | null
  forward: LocalForward | null
  driver: DatabaseDriver | null
  /** Closed for good: by the user, or as the app quits. */
  closed: boolean
  /** The link dropped by itself and is not back yet. */
  dropped: boolean
  /** SQLite: the file to open whenever the link is made, if any. */
  file: { path: string; readOnly: boolean } | null
  /** Counts the links made, so that events from an earlier one are ignored. */
  link: number
  /** The last link that ended by itself. */
  ended: number
  /** A reconnect under way, shared by every call that arrives meanwhile. */
  reconnecting: Promise<void> | null
}

export interface ManagerDeps {
  agentSource: string
  verifyHostKey: (ssh: SshConfig, key: Buffer) => Promise<boolean>
  /** Looks up a saved SSH profile by id. */
  resolveSshProfile?: (id: string) => Promise<SshProfile | undefined>
}

export interface OpenParams {
  /** SQLite only: open the configured file after connecting (default true). */
  openDatabase?: boolean
  onProgress?: (p: ConnectProgress) => void
}

/**
 * Owns every open connection, whatever kind of database is behind it. Emits `link` (a SessionLinkEvent) as a
 * connection's link drops by itself and is made again.
 */
export class ConnectionManager extends EventEmitter {
  private readonly active = new Map<string, ActiveConnection>()
  private readonly deps: ManagerDeps

  constructor(deps: ManagerDeps) {
    super()
    this.deps = deps
  }

  /** An open connection, whether or not its link is up at the moment. */
  get(id: string): ActiveConnection {
    const conn = this.active.get(id)
    if (!conn || conn.closed) throw new Error('This connection is no longer open. Reconnect to continue.')
    return conn
  }

  /** An open connection with its link up, reconnecting first when the link has dropped. */
  async ready(id: string): Promise<ActiveConnection> {
    const conn = this.get(id)
    if (conn.dropped) await this.reconnect(conn)
    return conn
  }

  async driver(id: string): Promise<DatabaseDriver> {
    const conn = await this.ready(id)
    if (!conn.driver) throw new Error('No database is open on this connection.')
    return conn.driver
  }

  /** The helper session behind a SQLite connection (file browser, opening files), local or over SSH. */
  async fileSession(id: string): Promise<AgentSession> {
    const conn = await this.ready(id)
    if (conn.config.kind !== 'sqlite' || !conn.session) throw new Error('This feature is only available for SQLite connections.')
    return conn.session
  }

  /**
   * A call through the driver that changes nothing, such as reading the catalog or a page of rows. A link that died
   * without a word is only found out when used: should the link turn out to have dropped under the call, it is made
   * again and the call runs once more. Statements that may write never run twice; they go through `driver`.
   */
  read<T>(id: string, fn: (driver: DatabaseDriver) => Promise<T>): Promise<T> {
    return this.retrying(id, async () => fn(await this.driver(id)))
  }

  /** As `read`, through the helper session: browsing files. */
  readFiles<T>(id: string, fn: (session: AgentSession) => Promise<T>): Promise<T> {
    return this.retrying(id, async () => fn(await this.fileSession(id)))
  }

  private async retrying<T>(id: string, call: () => Promise<T>): Promise<T> {
    const conn = await this.ready(id)
    const link = conn.link
    try {
      return await call()
    } catch (err) {
      const lost = conn.ended === link || conn.link !== link
      if (conn.closed || !lost) throw err
      return call()
    }
  }

  /** Interrupts the statement running on a connection. With the link down, nothing is running. */
  async cancel(id: string): Promise<void> {
    const conn = this.active.get(id)
    if (!conn || conn.closed || conn.dropped || !conn.driver) return
    await conn.driver.cancel()
  }

  /** SQLite: opens another file on the connection, which the connection then opens whenever its link is made. */
  async openFile(id: string, path: string, readOnly: boolean): Promise<DatabaseInfo> {
    const conn = await this.ready(id)
    if (!(conn.driver instanceof SqliteSshDriver)) throw new Error('Only SQLite connections open files.')
    const info = await conn.driver.open(path, readOnly)
    conn.file = { path, readOnly }
    return info
  }

  /** The SSH fields a connection uses, with a referenced profile resolved. */
  private async sshFor(config: ConnectionConfig): Promise<ConnectionConfig> {
    if (!config.sshProfileId || !usesSsh(config)) return config
    const profile = await this.deps.resolveSshProfile?.(config.sshProfileId)
    if (!profile) throw new Error('The SSH profile this connection uses no longer exists. Edit the connection and pick another one.')
    return resolveSshProfile(config, [profile])
  }

  async open(rawConfig: ConnectionConfig, params: OpenParams = {}): Promise<ActiveConnection> {
    const config = await this.sshFor(normalizeConnection(rawConfig))
    let file: ActiveConnection['file'] = null
    if (config.kind === 'sqlite') {
      if (params.openDatabase !== false) {
        if (!config.remotePath?.trim()) throw new Error(config.remote ? 'No remote database path given.' : 'No database file chosen.')
        file = { path: config.remotePath.trim(), readOnly: Boolean(config.readOnly) }
      }
    } else {
      const pgc = config.pg
      if (!pgc) throw new Error('PostgreSQL connection details are missing.')
      if (!pgc.host.trim()) throw new Error('Database host is required.')
      if (!pgc.database.trim()) throw new Error('Database name is required.')
      if (!pgc.user.trim()) throw new Error('Database user is required.')
    }
    const conn: ActiveConnection = {
      id: randomBytes(8).toString('hex'),
      config,
      ssh: null,
      session: null,
      forward: null,
      driver: null,
      closed: false,
      dropped: false,
      file,
      link: 0,
      ended: 0,
      reconnecting: null
    }
    try {
      await this.establish(conn, params.onProgress)
    } catch (err) {
      await this.teardown(conn)
      throw err
    }
    this.active.set(conn.id, conn)
    return conn
  }

  /** Makes the connection's link: the SSH connection, tunnel, helper and driver it needs, with its database open. */
  private async establish(conn: ActiveConnection, onProgress?: (p: ConnectProgress) => void): Promise<void> {
    const config = conn.config
    const link = ++conn.link
    if (config.kind === 'sqlite') {
      let session: AgentSession
      if (config.remote) {
        const ssh = this.makeSession(config.ssh, onProgress)
        conn.ssh = ssh
        session = ssh
      } else {
        session = new LocalSession({ agentSource: this.deps.agentSource, onProgress })
      }
      conn.session = session
      this.wireSession(conn, session, link)
      await session.connect()
      const driver = new SqliteSshDriver(session)
      conn.driver = driver
      if (conn.file) await driver.open(conn.file.path, conn.file.readOnly)
    } else {
      const pgc = config.pg!
      let host = pgc.host.trim()
      let port = pgc.port
      let servername: string | undefined
      let tunnel: string | null = null
      if (pgc.tunnel) {
        const session = this.makeSession(config.ssh, onProgress)
        conn.ssh = session
        this.wireSession(conn, session, link)
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
      driver.on('closed', (reason: string) => this.linkEnded(conn, link, reason))
      try {
        await driver.connect()
      } catch (err) {
        const fe = conn.ssh?.lastForwardError
        if (fe) throw new Error(`The SSH tunnel could not reach ${pgc.host}:${pgc.port} from ${config.ssh.host}: ${fe.message}`)
        throw err
      }
    }
    if (conn.ended === link) throw new Error('The connection closed as soon as it was made.')
  }

  /**
   * Makes a dropped link again. Calls that arrive meanwhile wait on the same attempt; one that fails leaves the link
   * down, for the next call to try again.
   */
  private reconnect(conn: ActiveConnection): Promise<void> {
    if (conn.reconnecting) return conn.reconnecting
    const report = (e: SessionLinkEvent) => this.emit('link', e)
    const attempt = async () => {
      report({ sessionId: conn.id, state: 'reconnecting', message: 'Reconnecting…' })
      try {
        await this.establish(conn, (p) => report({ sessionId: conn.id, state: 'reconnecting', message: p.message }))
      } catch (err) {
        await this.release(conn)
        if (conn.closed) throw new Error('This connection is no longer open. Reconnect to continue.')
        const reason = `Could not reconnect to ${conn.config.name}: ${err instanceof Error ? err.message : String(err)}`
        report({ sessionId: conn.id, state: 'reconnect-failed', reason })
        throw new Error(reason)
      }
      // Closed by the user while it was reconnecting.
      if (conn.closed) {
        await this.release(conn)
        throw new Error('This connection is no longer open. Reconnect to continue.')
      }
      conn.dropped = false
      report({ sessionId: conn.id, state: 'reconnected', info: this.info(conn) })
    }
    conn.reconnecting = attempt().finally(() => {
      conn.reconnecting = null
    })
    return conn.reconnecting
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
      target: describeTarget(cfg),
      db: conn.driver?.info() ?? null,
      interpreter: conn.session?.interpreter ?? undefined,
      serverBanner: s?.serverBanner,
      homeDir: conn.session?.homeDir ?? null,
      tunnel: cfg.kind === 'postgres' && cfg.pg?.tunnel ? describeSsh(cfg.ssh) : null
    }
  }

  private makeSession(ssh: SshConfig, onProgress?: (p: ConnectProgress) => void): Session {
    return new Session(ssh, {
      agentSource: this.deps.agentSource,
      verifyHostKey: (key) => this.deps.verifyHostKey(ssh, key),
      onProgress
    })
  }

  private wireSession(conn: ActiveConnection, session: AgentSession, link: number): void {
    session.on('close', ({ reason }: { reason: string }) => this.linkEnded(conn, link, reason))
    session.on('agent-exit', (info: { stderr?: string }) => {
      const detail = info?.stderr?.trim() ? `: ${info.stderr.trim().slice(-300)}` : ''
      this.linkEnded(conn, link, `The remote helper process exited${detail}`)
    })
    session.on('error', () => {
      /* surfaced through close */
    })
  }

  /**
   * Link number `link` ended by itself. What is left of it goes, and the connection stays for the next call to
   * reconnect. A link still being made just fails: its open or reconnect says so.
   */
  private linkEnded(conn: ActiveConnection, link: number, reason: string): void {
    if (conn.closed || conn.link !== link || conn.ended === link) return
    conn.ended = link
    void this.release(conn)
    if (conn.dropped || !this.active.has(conn.id)) return
    conn.dropped = true
    this.emit('link', { sessionId: conn.id, state: 'dropped', reason } satisfies SessionLinkEvent)
  }

  private async teardown(conn: ActiveConnection): Promise<void> {
    conn.closed = true
    this.active.delete(conn.id)
    await this.release(conn)
  }

  /** Closes the link: driver, tunnel, helper and SSH connection. */
  private async release(conn: ActiveConnection): Promise<void> {
    const { driver, forward, session, ssh } = conn
    conn.driver = null
    conn.forward = null
    conn.session = null
    conn.ssh = null
    try {
      await driver?.close()
    } catch {
      /* ignore */
    }
    forward?.close()
    session?.close()
    ssh?.close()
  }
}
