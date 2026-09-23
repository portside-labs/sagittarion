// SQLite on this computer: the same Python helper as the SSH path, started
// as a child process instead of over an exec channel.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ConnectProgress, FileEntry, ReaddirResult } from '@shared/types'
import { AgentError, PythonAgent, type AgentStream } from './agent'
import { AgentSession } from './agent-session'

export interface LocalSessionOptions {
  agentSource: string
  onProgress?: (progress: ConnectProgress) => void
  agentStartTimeoutMs?: number
  /** Interpreters to try, in order. */
  interpreters?: string[]
}

const DEFAULT_INTERPRETERS =
  process.platform === 'win32'
    ? ['python', 'py', 'python3']
    : ['python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3', 'python']

export const NO_LOCAL_PYTHON =
  'Python 3 was not found on this computer. Sagittarion drives SQLite files through a small standard-library Python helper. ' +
  (process.platform === 'darwin'
    ? 'Install the Xcode Command Line Tools (run "xcode-select --install" in Terminal) or python3 from Homebrew, then try again.'
    : process.platform === 'win32'
      ? 'Install Python 3 from python.org (tick "Add python.exe to PATH"), then try again.'
      : 'Install python3 with your package manager (e.g. "apt install python3"), then try again.')

/** Adapts a child process to the stream shape the agent expects from an SSH channel. */
class ChildStream implements AgentStream {
  readonly stderr: AgentStream['stderr']
  constructor(private readonly child: ChildProcess) {
    this.stderr = child.stderr!
  }
  on(event: 'data' | 'exit' | 'close' | 'error', cb: (...args: any[]) => void): this {
    if (event === 'data') this.child.stdout!.on('data', cb)
    else if (event === 'exit') this.child.on('exit', (code, signal) => cb(code, signal ?? undefined))
    else this.child.on(event, cb)
    return this
  }
  write(data: string, cb?: (err?: Error | null) => void): void {
    this.child.stdin!.write(data, cb)
  }
  end(): void {
    this.child.stdin!.end()
  }
  close(): void {
    this.child.kill()
  }
}

export function expandLocalHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

export class LocalSession extends AgentSession {
  readonly where = 'this computer'
  private readonly opts: LocalSessionOptions
  private child: ChildProcess | null = null

  constructor(opts: LocalSessionOptions) {
    super()
    this.opts = opts
    this.onProgress = opts.onProgress
    this.homeDir = os.homedir()
  }

  async connect(): Promise<void> {
    await this.probeInterpreter()
  }

  /** The first interpreter that is Python 3 with the sqlite3 module. */
  async probeInterpreter(): Promise<string> {
    if (this.interpreter) return this.interpreter
    this.progress('probing', 'Looking for python3 on this computer…')
    for (const candidate of this.opts.interpreters ?? DEFAULT_INTERPRETERS) {
      const r = spawnSync(candidate, ['-c', 'import sqlite3, sys; print("__OK__", sys.version_info[0])'], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
      if (r.status === 0 && /__OK__ 3\b/.test(r.stdout)) {
        this.interpreter = candidate
        return candidate
      }
    }
    throw new AgentError(NO_LOCAL_PYTHON)
  }

  /** The helper source on disk, keyed by content, so the command line stays short on every platform. */
  private async agentFile(): Promise<string> {
    const hash = createHash('sha1').update(this.opts.agentSource).digest('hex').slice(0, 12)
    const file = path.join(os.tmpdir(), `sagittarion-agent-${hash}.py`)
    try {
      await fs.access(file)
    } catch {
      await fs.writeFile(file, this.opts.agentSource, { encoding: 'utf8', mode: 0o600 })
    }
    return file
  }

  protected async spawnAgent(): Promise<PythonAgent> {
    const interpreter = await this.probeInterpreter()
    this.progress('starting-agent', `Starting helper with ${interpreter}…`)
    const token = randomBytes(12).toString('hex')
    const file = await this.agentFile()
    const child = spawn(interpreter, ['-c', "import sys;exec(compile(open(sys.argv[1], 'rb').read(), sys.argv[1], 'exec'))", file, token], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
    })
    this.child = child
    const agent = new PythonAgent(new ChildStream(child), token)
    await agent.waitReady(this.opts.agentStartTimeoutMs ?? 30_000)
    return agent
  }

  async home(): Promise<string> {
    return os.homedir()
  }

  async realpath(p: string): Promise<string> {
    return fs.realpath(expandLocalHome(p.trim() || os.homedir()))
  }

  async readdir(dir: string): Promise<ReaddirResult> {
    const abs = await this.realpath(dir)
    const list = await fs.readdir(abs, { withFileTypes: true })
    const entries: FileEntry[] = []
    for (const e of list) {
      const full = path.join(abs, e.name)
      let isDir = e.isDirectory()
      const isSymlink = e.isSymbolicLink()
      let size = 0
      let mtime = 0
      try {
        const st = await fs.stat(full)
        isDir = st.isDirectory()
        size = st.size
        mtime = st.mtimeMs
      } catch {
        /* dangling link or unreadable */
      }
      entries.push({ name: e.name, path: full, isDir, isSymlink, size, mtime })
    }
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
    const parent = path.dirname(abs)
    return { path: abs, parent: parent === abs ? null : parent, entries }
  }

  close(): void {
    if (this.closed) return
    try {
      this.agent?.close()
    } catch {
      /* ignore */
    }
    const child = this.child
    if (child && child.exitCode === null) setTimeout(() => child.kill(), 1500).unref()
    this.closed = true
    this.db = null
    this.emit('close', { reason: 'Disconnected' })
  }
}
