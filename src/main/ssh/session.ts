import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import { AgentError, PythonAgent } from './agent'
import type {
  ConnectProgress,
  ConnectionConfig,
  DatabaseInfo,
  FileEntry,
  PendingChange,
  QueryResponse,
  ReaddirResult,
  RowsRequest,
  RowsResponse,
  SchemaInfo,
  TableDetails
} from '@shared/types'

export interface SessionOptions {
  /** Source of sqlite_agent.py, shipped to the remote host at connect time. */
  agentSource: string
  /** Resolve true to accept the host key, false to abort the connection. */
  verifyHostKey: (key: Buffer) => Promise<boolean>
  onProgress?: (progress: ConnectProgress) => void
  readyTimeoutMs?: number
  agentStartTimeoutMs?: number
  sshAgentSocket?: string
}

export interface ExecResult {
  stdout: string
  stderr: string
  code: number | null
}

/*
 * Probe for a usable interpreter. Wrapped in `sh -c '...'` so it works no
 * matter which login shell the remote user has. The script must not contain
 * single quotes or exclamation marks (csh history expansion).
 */
const PROBE_SCRIPT = [
  'for p in python3 python; do',
  'if command -v "$p" >/dev/null 2>&1 &&',
  '"$p" -c "import sys, sqlite3, json, base64, threading; sys.exit(0 if sys.version_info >= (3, 5) else 1)" >/dev/null 2>&1;',
  'then echo "__PROBE__ python $p"; exit 0; fi;',
  'done;',
  'if command -v sqlite3 >/dev/null 2>&1; then echo "__PROBE__ sqlite3 $(sqlite3 -version)"; exit 0; fi;',
  'echo "__PROBE__ none"; exit 0'
].join(' ')
export const PROBE_COMMAND = `sh -c '${PROBE_SCRIPT}'`

export const DEFAULT_KEY_CANDIDATES = ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_ed25519_sk', 'id_ecdsa_sk']

export function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

export function friendlyConnectError(err: any, cfg: ConnectionConfig): Error {
  const msg: string = String(err?.message ?? err)
  const target = `${cfg.host}:${cfg.port}`
  if (err?.level === 'client-authentication' || /authentication methods failed/i.test(msg)) {
    const how =
      cfg.auth === 'password'
        ? 'Check the username and password.'
        : cfg.auth === 'key'
          ? 'Check that the key is authorized for this user and that the passphrase is correct.'
          : 'Make sure your SSH agent is running and has the right key loaded (ssh-add -l).'
    return new Error(`Authentication failed for ${cfg.username}@${cfg.host}. ${how}`)
  }
  if (/ECONNREFUSED/.test(msg)) return new Error(`Connection refused by ${target}. Is an SSH server listening there?`)
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return new Error(`Host not found: ${cfg.host}`)
  if (/ETIMEDOUT|Timed out/i.test(msg)) return new Error(`Timed out connecting to ${target}.`)
  if (/EHOSTUNREACH|ENETUNREACH/.test(msg)) return new Error(`${cfg.host} is unreachable from this machine.`)
  if (/Host denied|Host key verification failed|hostVerifier|host key/i.test(msg)) return new Error('Host key was not accepted; connection aborted.')
  if (/Encrypted private key detected, but no passphrase given/i.test(msg)) {
    return new Error('The private key is encrypted. Enter its passphrase and try again.')
  }
  if (/Cannot parse privateKey/i.test(msg)) return new Error(`Could not read the private key: ${msg}`)
  return new Error(msg)
}

/**
 * One SSH connection to a host, optionally with the SQLite helper agent
 * running on it and a database open.
 */
export class Session extends EventEmitter {
  readonly id = randomBytes(8).toString('hex')
  readonly config: ConnectionConfig
  private readonly opts: SessionOptions
  private readonly client = new Client()
  private agent: PythonAgent | null = null
  private sftp: SFTPWrapper | null = null
  private sftpPromise: Promise<SFTPWrapper> | null = null
  interpreter: string | null = null
  serverBanner = ''
  homeDir: string | null = null
  db: DatabaseInfo | null = null
  closed = false

  constructor(config: ConnectionConfig, opts: SessionOptions) {
    super()
    this.config = config
    this.opts = opts
  }

  private progress(stage: ConnectProgress['stage'], message: string): void {
    this.opts.onProgress?.({ stage, message })
  }

  // ---------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------

  async connect(): Promise<void> {
    const cfg = await this.buildConnectConfig()
    this.progress('connecting', `Connecting to ${this.config.host}:${this.config.port}…`)
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (err?: Error) => {
        if (settled) return
        settled = true
        this.client.removeListener('error', onError)
        this.client.removeListener('ready', onReady)
        if (err) reject(err)
        else resolve()
      }
      const onError = (err: Error) => finish(friendlyConnectError(err, this.config))
      const onReady = () => finish()
      this.client.on('error', onError)
      this.client.on('ready', onReady)
      this.client.on('banner', (message: string) => {
        this.serverBanner += message
      })
      this.client.on('handshake', () => this.progress('authenticating', `Authenticating as ${this.config.username}…`))
      this.client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finishKI) => {
        finishKI(prompts.map(() => this.config.password ?? ''))
      })
      this.client.on('close', () => {
        finish(new Error(`Connection to ${this.config.host} closed before it was ready.`))
        this.handleClosed('Connection closed by the remote host')
      })
      try {
        this.client.connect(cfg)
      } catch (err) {
        finish(friendlyConnectError(err, this.config))
      }
    })
    // Post-ready error handling: surface but do not crash.
    this.client.on('error', (err: Error) => {
      this.emit('error', err)
    })
  }

  private async buildConnectConfig(): Promise<ConnectConfig> {
    const c = this.config
    const cfg: ConnectConfig = {
      host: c.host,
      port: c.port || 22,
      username: c.username,
      readyTimeout: this.opts.readyTimeoutMs ?? 25_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
      tryKeyboard: true,
      hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
        this.opts
          .verifyHostKey(key)
          .then((ok) => verify(ok))
          .catch(() => verify(false))
      }
    }
    switch (c.auth) {
      case 'password':
        cfg.password = c.password ?? ''
        break
      case 'key': {
        const keyPath = await this.resolveKeyPath()
        try {
          cfg.privateKey = await fs.readFile(keyPath)
        } catch (err: any) {
          throw new Error(`Could not read private key ${keyPath}: ${err?.message ?? err}`)
        }
        if (c.passphrase) cfg.passphrase = c.passphrase
        // Some servers also accept a password as a second factor.
        if (c.password) cfg.password = c.password
        break
      }
      case 'agent': {
        const sock = this.opts.sshAgentSocket ?? process.env.SSH_AUTH_SOCK
        if (!sock) throw new Error('No SSH agent found: SSH_AUTH_SOCK is not set in the environment.')
        cfg.agent = sock
        if (c.password) cfg.password = c.password
        break
      }
    }
    return cfg
  }

  private async resolveKeyPath(): Promise<string> {
    if (this.config.privateKeyPath?.trim()) return expandHome(this.config.privateKeyPath.trim())
    const sshDir = path.join(os.homedir(), '.ssh')
    for (const name of DEFAULT_KEY_CANDIDATES) {
      const p = path.join(sshDir, name)
      try {
        await fs.access(p)
        return p
      } catch {
        /* try next */
      }
    }
    throw new Error(`No private key path given and none of ${DEFAULT_KEY_CANDIDATES.join(', ')} exist in ~/.ssh.`)
  }

  private handleClosed(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.db = null
    this.emit('close', { reason })
  }

  // ---------------------------------------------------------------------
  // Exec helpers
  // ---------------------------------------------------------------------

  execStream(command: string): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      this.client.exec(command, (err, stream) => {
        if (err) reject(err)
        else resolve(stream)
      })
    })
  }

  async exec(command: string, timeoutMs = 30_000): Promise<ExecResult> {
    const stream = await this.execStream(command)
    return new Promise<ExecResult>((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      let code: number | null = null
      const timer = setTimeout(() => {
        try {
          stream.close()
        } catch {
          /* ignore */
        }
        reject(new Error(`Remote command timed out after ${Math.round(timeoutMs / 1000)}s: ${command.slice(0, 80)}`))
      }, timeoutMs)
      stream.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
      stream.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
      stream.on('exit', (c: number | null) => (code = c))
      stream.on('close', () => {
        clearTimeout(timer)
        resolve({ stdout, stderr, code })
      })
      stream.on('error', (e: Error) => {
        clearTimeout(timer)
        reject(e)
      })
    })
  }

  // ---------------------------------------------------------------------
  // Agent lifecycle
  // ---------------------------------------------------------------------

  async probeInterpreter(): Promise<string> {
    if (this.interpreter) return this.interpreter
    this.progress('probing', 'Looking for python3 on the remote host…')
    const res = await this.exec(PROBE_COMMAND)
    const line = res.stdout
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('__PROBE__ '))
    if (!line) {
      throw new AgentError(
        'Could not run a shell command on the remote host.' +
          (res.stderr.trim() ? `\n${res.stderr.trim().slice(0, 500)}` : '') +
          (res.stdout.trim() ? `\nOutput: ${res.stdout.trim().slice(0, 500)}` : '')
      )
    }
    const parts = line.split(/\s+/)
    if (parts[1] === 'python' && parts[2]) {
      this.interpreter = parts[2]
      return parts[2]
    }
    if (parts[1] === 'sqlite3') {
      throw new AgentError(
        `The remote host has the sqlite3 CLI (${parts.slice(2, 3).join(' ')}) but no Python 3, which this app needs to run its helper. ` +
          'Install python3 on the remote host (e.g. "apt install python3", "dnf install python3" or "apk add python3") and reconnect.'
      )
    }
    throw new AgentError(
      'Python 3 was not found on the remote host. This app runs a small standard-library Python helper next to the database file. ' +
        'Install python3 on the remote host (e.g. "apt install python3", "dnf install python3" or "apk add python3") and reconnect.'
    )
  }

  async startAgent(): Promise<PythonAgent> {
    if (this.agent && !this.agent.hasExited) return this.agent
    const interpreter = await this.probeInterpreter()
    this.progress('starting-agent', `Starting helper with ${interpreter}…`)
    const token = randomBytes(12).toString('hex')
    const b64 = Buffer.from(this.opts.agentSource, 'utf8').toString('base64')
    const command = `${interpreter} -c "import sys,base64;exec(base64.b64decode(sys.argv[1]))" ${b64} ${token}`
    const stream = await this.execStream(command)
    const agent = new PythonAgent(stream, token)
    agent.on('exit', (info) => {
      if (this.agent === agent) {
        this.agent = null
        this.db = null
        this.emit('agent-exit', info)
      }
    })
    this.agent = agent
    await agent.waitReady(this.opts.agentStartTimeoutMs ?? 30_000)
    return agent
  }

  private requireAgent(): PythonAgent {
    if (!this.agent || this.agent.hasExited) {
      throw new AgentError('Not connected to a database. Reconnect to continue.')
    }
    return this.agent
  }

  // ---------------------------------------------------------------------
  // Database operations
  // ---------------------------------------------------------------------

  async openDatabase(remotePath: string, readonly = false, create = false): Promise<DatabaseInfo> {
    const agent = await this.startAgent()
    this.progress('opening', `Opening ${remotePath}…`)
    const res = await agent.request<DatabaseInfo & { id: number; ok: true }>('open', {
      path: remotePath,
      readonly,
      create
    })
    const { id: _id, ok: _ok, ...info } = res as any
    this.db = info as DatabaseInfo
    this.homeDir = this.db.home
    return this.db
  }

  async schema(includeSystem = false): Promise<SchemaInfo> {
    const res = await this.requireAgent().request('schema', { include_system: includeSystem })
    return { tables: res.tables, views: res.views, indexes: res.indexes, triggers: res.triggers }
  }

  async tableDetails(table: string): Promise<TableDetails> {
    const { id: _id, ok: _ok, durationMs: _d, tx: _tx, ...rest } = await this.requireAgent().request('table_details', { table })
    return rest as TableDetails
  }

  async count(table: string, where?: string): Promise<number> {
    const res = await this.requireAgent().request('count', { table, where })
    return res.total
  }

  async rows(req: RowsRequest): Promise<RowsResponse> {
    const res = await this.requireAgent().request('rows', {
      table: req.table,
      offset: req.offset,
      limit: req.limit,
      order_by: req.orderBy,
      order_dir: req.orderDir,
      where: req.where,
      with_count: req.withCount ?? false
    })
    return {
      table: res.table,
      columns: res.columns,
      rows: res.rows,
      rowids: res.rowids,
      rowidAlias: res.rowidAlias,
      pk: res.pk,
      isView: res.isView,
      total: res.total,
      sql: res.sql,
      durationMs: res.durationMs,
      tx: res.tx
    }
  }

  async query(sql: string, params: unknown[] = [], maxRows = 1000): Promise<QueryResponse> {
    const res = await this.requireAgent().request('query', { sql, params, max_rows: maxRows })
    return { results: res.results, durationMs: res.durationMs, tx: res.tx }
  }

  cancel(): void {
    this.agent?.cancel()
  }

  async apply(changes: PendingChange[]): Promise<number> {
    const res = await this.requireAgent().request('apply', { changes })
    return res.applied
  }

  async ping(): Promise<boolean> {
    if (!this.agent || this.agent.hasExited) return false
    try {
      await this.agent.request('ping')
      return true
    } catch {
      return false
    }
  }

  // ---------------------------------------------------------------------
  // SFTP (used by the remote file browser)
  // ---------------------------------------------------------------------

  private getSftp(): Promise<SFTPWrapper> {
    if (this.sftp) return Promise.resolve(this.sftp)
    if (!this.sftpPromise) {
      this.sftpPromise = new Promise((resolve, reject) => {
        this.client.sftp((err, sftp) => {
          if (err) {
            this.sftpPromise = null
            reject(new Error(`SFTP is not available on this server (${err.message}). Type the database path manually.`))
            return
          }
          this.sftp = sftp
          sftp.on('close', () => {
            this.sftp = null
            this.sftpPromise = null
          })
          resolve(sftp)
        })
      })
    }
    return this.sftpPromise
  }

  async realpath(p: string): Promise<string> {
    const sftp = await this.getSftp()
    return new Promise((resolve, reject) => {
      sftp.realpath(p, (err, abs) => (err ? reject(err) : resolve(abs)))
    })
  }

  async home(): Promise<string> {
    if (this.homeDir) return this.homeDir
    this.homeDir = await this.realpath('.')
    return this.homeDir
  }

  async readdir(dir: string): Promise<ReaddirResult> {
    const sftp = await this.getSftp()
    let target = dir.trim() || '.'
    if (target === '~') target = '.'
    else if (target.startsWith('~/')) target = path.posix.join(await this.home(), target.slice(2))
    const abs = await this.realpath(target)
    const list = await new Promise<Awaited<ReturnType<typeof readdirAsync>>>((resolve, reject) => {
      sftp.readdir(abs, (err, entries) => (err ? reject(err) : resolve(entries as any)))
    })
    const entries: FileEntry[] = []
    for (const e of list) {
      const attrs: any = e.attrs
      const isSymlink = typeof attrs?.isSymbolicLink === 'function' ? attrs.isSymbolicLink() : false
      let isDir = typeof attrs?.isDirectory === 'function' ? attrs.isDirectory() : false
      const full = path.posix.join(abs, e.filename)
      if (isSymlink) {
        // Follow the link to find out whether it points at a directory.
        try {
          const st = await new Promise<any>((resolve, reject) => sftp.stat(full, (err, s) => (err ? reject(err) : resolve(s))))
          isDir = st.isDirectory()
        } catch {
          /* dangling link */
        }
      }
      entries.push({
        name: e.filename,
        path: full,
        isDir,
        isSymlink,
        size: Number(attrs?.size ?? 0),
        mtime: Number(attrs?.mtime ?? 0) * 1000
      })
    }
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
    return { path: abs, parent: abs === '/' ? null : path.posix.dirname(abs), entries }
  }

  // ---------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------

  close(): void {
    if (this.closed) return
    try {
      this.agent?.close()
    } catch {
      /* ignore */
    }
    try {
      this.sftp?.end()
    } catch {
      /* ignore */
    }
    try {
      this.client.end()
    } catch {
      /* ignore */
    }
    this.handleClosed('Disconnected')
  }
}

// Only used for typing the readdir promise above.
declare function readdirAsync(): Promise<{ filename: string; longname: string; attrs: unknown }[]>
