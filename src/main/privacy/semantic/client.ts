// The main process's side of the on-device model: starts its process on first use (after the files pass their
// checks), sends it texts, and ends it after a quiet spell so its memory is given back. When it cannot load,
// crashes or stops answering, every waiting request is rejected, which stops the ask rather than letting it out with
// less protection than the user chose.
import type { SemanticModelManifest } from './manifest'
import type { HostReply, HostRequest } from './host'
import type { RawSpan } from './runtime'

/** A running model process, however it was started (Electron utility process, or child_process in tests). */
export interface HostHandle {
  post(request: HostRequest): void
  onMessage(handler: (reply: HostReply) => void): void
  onExit(handler: () => void): void
  kill(): void
}

export interface ModelClientOptions {
  spawn: () => HostHandle
  /** Checks the installed files and says where they are; throws when they are missing or altered. */
  prepare: () => Promise<{ dir: string; manifest: SemanticModelManifest }>
  /** The process ends after this long without a request. */
  idleMs?: number
  loadTimeoutMs?: number
  /** Per request, plus a little for each text. */
  requestTimeoutMs?: number
  /** After the process ends, for whatever reason. */
  onUnload?: () => void
  /** Load time and memory, for the numbers in docs/LOCAL_AI_PRIVACY.md; never text. */
  onStats?: (s: { event: 'ready' | 'result'; ms: number; rss: number; texts?: number }) => void
}

interface Waiting {
  resolve: (spans: RawSpan[][]) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  texts: number
}

export class ModelUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelUnavailableError'
  }
}

export class SemanticModelClient {
  private host: HostHandle | null = null
  private starting: Promise<HostHandle> | null = null
  private readonly waiting = new Map<number, Waiting>()
  private nextId = 1
  private idle: ReturnType<typeof setTimeout> | null = null
  private readonly idleMs: number
  private readonly loadTimeoutMs: number
  private readonly requestTimeoutMs: number

  constructor(private readonly opts: ModelClientOptions) {
    this.idleMs = opts.idleMs ?? 10 * 60_000
    this.loadTimeoutMs = opts.loadTimeoutMs ?? 90_000
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000
  }

  get running(): boolean {
    return this.host !== null
  }

  async recognize(texts: string[], signal?: AbortSignal): Promise<RawSpan[][]> {
    signal?.throwIfAborted()
    if (!texts.length) return []
    this.clearIdle()
    let host: HostHandle
    try {
      host = await this.ready()
    } catch (err) {
      this.armIdle()
      throw err
    }
    signal?.throwIfAborted()
    const id = this.nextId++
    return new Promise<RawSpan[][]>((resolve, reject) => {
      const onAbort = () => {
        const w = this.waiting.get(id)
        if (!w) return
        clearTimeout(w.timer)
        this.waiting.delete(id)
        this.armIdle()
        reject(signal!.reason instanceof Error ? signal!.reason : new DOMException('Aborted', 'AbortError'))
      }
      const timer = setTimeout(() => this.stop(new ModelUnavailableError('The on-device model stopped answering.')), this.requestTimeoutMs + texts.length * 100)
      this.waiting.set(id, {
        resolve: (spans) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(spans)
        },
        reject: (err) => {
          signal?.removeEventListener('abort', onAbort)
          reject(err)
        },
        timer,
        texts: texts.length
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      host.post({ type: 'recognize', id, texts })
    })
  }

  /** Ends the model's process now; the next request starts it again. */
  unload(): void {
    this.stop(new ModelUnavailableError('The on-device model was unloaded.'))
  }

  private ready(): Promise<HostHandle> {
    if (this.host) return Promise.resolve(this.host)
    this.starting ??= this.start().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async start(): Promise<HostHandle> {
    const { dir, manifest } = await this.opts.prepare()
    const host = this.opts.spawn()
    return new Promise<HostHandle>((resolve, reject) => {
      let loaded = false
      const timer = setTimeout(() => {
        host.kill()
        reject(new ModelUnavailableError('The on-device model took too long to load.'))
      }, this.loadTimeoutMs)
      host.onMessage((reply) => {
        if (!loaded) {
          clearTimeout(timer)
          if (reply.type === 'ready') {
            loaded = true
            this.host = host
            this.opts.onStats?.({ event: 'ready', ms: reply.ms, rss: reply.rss })
            resolve(host)
          } else {
            host.kill()
            reject(new ModelUnavailableError(`The on-device model could not start: ${reply.type === 'error' ? reply.message : 'unexpected reply'}`))
          }
          return
        }
        this.receive(reply)
      })
      host.onExit(() => {
        clearTimeout(timer)
        if (!loaded) reject(new ModelUnavailableError('The on-device model stopped while loading.'))
        else if (this.host === host) this.stop(new ModelUnavailableError('The on-device model stopped unexpectedly.'))
      })
      host.post({ type: 'load', dir, manifest })
    })
  }

  private receive(reply: HostReply): void {
    if (reply.type === 'ready' || reply.id === undefined) return
    const w = this.waiting.get(reply.id)
    if (!w) return
    clearTimeout(w.timer)
    this.waiting.delete(reply.id)
    if (reply.type === 'result') {
      this.opts.onStats?.({ event: 'result', ms: reply.ms, rss: reply.rss, texts: w.texts })
      w.resolve(reply.spans)
    } else w.reject(new ModelUnavailableError(`The on-device model failed: ${reply.message}`))
    this.armIdle()
  }

  /** Ends the process and fails everything waiting on it. */
  private stop(reason: Error): void {
    this.clearIdle()
    const host = this.host
    this.host = null
    for (const [id, w] of this.waiting) {
      clearTimeout(w.timer)
      this.waiting.delete(id)
      w.reject(reason)
    }
    if (host) {
      host.kill()
      this.opts.onUnload?.()
    }
  }

  private armIdle(): void {
    this.clearIdle()
    if (this.waiting.size || !this.host) return
    this.idle = setTimeout(() => {
      if (!this.waiting.size) this.stop(new ModelUnavailableError('The on-device model was unloaded.'))
    }, this.idleMs)
    this.idle.unref?.()
  }

  private clearIdle(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
  }
}
