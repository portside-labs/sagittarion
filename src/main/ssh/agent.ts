import { EventEmitter } from 'node:events'
import type { ClientChannel } from 'ssh2'

export const READY_PREFIX = '__SAGITTARION_READY__'

export class AgentError extends Error {
  readonly sqlite: boolean
  constructor(message: string, sqlite = false) {
    super(message)
    this.name = 'AgentError'
    this.sqlite = sqlite
  }
}

interface Pending {
  op: string
  resolve: (value: any) => void
  reject: (err: Error) => void
}

/**
 * Client side of the newline-delimited JSON protocol spoken by
 * sqlite_agent.py over an SSH exec channel.
 */
export class PythonAgent extends EventEmitter {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private buffer = ''
  private ready = false
  private readyPromise: Promise<void>
  private readyResolve!: () => void
  private readyReject!: (err: Error) => void
  private stderrTail = ''
  private preReadyTail = ''
  private exited = false
  private exitCode: number | null = null
  private exitSignal: string | null = null

  constructor(
    private readonly stream: ClientChannel,
    private readonly token: string
  ) {
    super()
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    // Avoid unhandled rejection noise if nobody awaits readiness.
    this.readyPromise.catch(() => undefined)

    stream.on('data', (chunk: Buffer) => this.onStdout(chunk))
    stream.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-8192)
    })
    stream.on('exit', (code: number | null, signal?: string) => {
      this.exitCode = code
      this.exitSignal = signal ?? null
    })
    stream.on('close', () => this.onClose())
    stream.on('error', (err: Error) => this.failAll(err))
  }

  get isReady(): boolean {
    return this.ready && !this.exited
  }

  get hasExited(): boolean {
    return this.exited
  }

  get diagnostics(): string {
    return this.stderrTail.trim()
  }

  waitReady(timeoutMs = 30_000): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<void>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new AgentError(
            `The remote helper did not start within ${Math.round(timeoutMs / 1000)}s.` +
              this.describeOutput()
          )
        )
      }, timeoutMs)
    })
    return Promise.race([this.readyPromise, timeout]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }

  request<T = any>(op: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (this.exited) {
      return Promise.reject(new AgentError('The remote helper is no longer running.' + this.describeOutput()))
    }
    const id = this.nextId++
    const line = JSON.stringify({ id, op, ...payload }) + '\n'
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { op, resolve, reject })
      this.stream.write(line, (err?: Error | null) => {
        if (err) {
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  /** Interrupt whatever statement is currently running on the remote side. */
  cancel(): void {
    if (this.exited) return
    this.stream.write(JSON.stringify({ id: 0, op: 'cancel' }) + '\n')
  }

  /** Ask the agent to exit and close the channel. */
  close(): void {
    if (this.exited) return
    try {
      this.stream.write(JSON.stringify({ id: 0, op: 'close' }) + '\n')
      this.stream.end()
    } catch {
      /* ignore */
    }
    const timer = setTimeout(() => {
      if (!this.exited) {
        try {
          this.stream.close()
        } catch {
          /* ignore */
        }
      }
    }, 2000)
    timer.unref?.()
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '')
      this.buffer = this.buffer.slice(idx + 1)
      if (!this.ready) {
        if (line === `${READY_PREFIX} ${this.token}`) {
          this.ready = true
          this.readyResolve()
        } else {
          // Shell rc noise, MOTD, etc. Keep a tail for diagnostics.
          this.preReadyTail = (this.preReadyTail + line + '\n').slice(-4096)
        }
        continue
      }
      this.handleLine(line)
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      // Something other than the agent wrote to stdout; ignore.
      return
    }
    const id = typeof msg.id === 'number' ? msg.id : null
    if (id === null) return
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (msg.ok) {
      pending.resolve(msg)
    } else {
      pending.reject(new AgentError(String(msg.error ?? 'Unknown agent error'), Boolean(msg.sqlite)))
    }
  }

  private describeOutput(): string {
    const parts: string[] = []
    if (this.exitCode !== null || this.exitSignal) {
      parts.push(`Exit ${this.exitSignal ? 'signal ' + this.exitSignal : 'code ' + this.exitCode}.`)
    }
    if (this.stderrTail.trim()) parts.push('stderr: ' + this.stderrTail.trim().slice(-1500))
    if (!this.ready && this.preReadyTail.trim()) parts.push('stdout: ' + this.preReadyTail.trim().slice(-800))
    return parts.length ? '\n' + parts.join('\n') : ''
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err)
    this.pending.clear()
  }

  private onClose(): void {
    if (this.exited) return
    this.exited = true
    const err = new AgentError('The remote helper exited unexpectedly.' + this.describeOutput())
    if (!this.ready) this.readyReject(err)
    this.failAll(err)
    this.emit('exit', { code: this.exitCode, signal: this.exitSignal, stderr: this.stderrTail })
  }
}
