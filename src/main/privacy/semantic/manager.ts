// Everything the app does with the on-device model, behind one object: its status for Settings, the download and
// its removal, and the detector the privacy engine uses when semantic detection is switched on.
import type { SemanticModelInfo, SemanticModelState, SemanticModelStatus } from '@shared/privacy'
import type { SemanticSensitiveDataDetector } from '../types'
import { SemanticModelClient, type HostHandle } from './client'
import { GlinerDetector } from './detector'
import { ModelIntegrityError, type ModelStore } from './store'

export interface SemanticModelOptions {
  store: ModelStore
  spawn: () => HostHandle
  /** Why this computer cannot run the model, or null. */
  unsupported: string | null
  onStatus: (status: SemanticModelStatus) => void
  idleMs?: number
  onStats?: ConstructorParameters<typeof SemanticModelClient>[0]['onStats']
}

/** How often download progress reaches the window. */
const PROGRESS_MS = 200

export class SemanticModel {
  private state: Exclude<SemanticModelState, 'unsupported'> | null = null
  private received = 0
  private message: string | undefined
  private download: AbortController | null = null
  private readonly client: SemanticModelClient
  private readonly gliner: GlinerDetector

  constructor(private readonly opts: SemanticModelOptions) {
    const { store } = opts
    this.client = new SemanticModelClient({
      spawn: opts.spawn,
      idleMs: opts.idleMs,
      onStats: opts.onStats,
      prepare: async () => {
        try {
          await store.verify()
        } catch (err) {
          if (err instanceof ModelIntegrityError) await this.fail(`${err.message} Download it again.`)
          throw err
        }
        return { dir: store.dir, manifest: store.manifest }
      },
      onUnload: () => this.gliner.forget()
    })
    this.gliner = new GlinerDetector((texts, signal) => this.client.recognize(texts, signal), store.manifest)
  }

  get info(): SemanticModelInfo {
    const m = this.opts.store.manifest
    return { id: m.id, version: m.version, name: m.name, publisher: m.publisher, license: m.license, source: `${m.source.host}/${m.source.repo}`, size: this.opts.store.size }
  }

  async status(): Promise<SemanticModelStatus> {
    if (this.opts.unsupported) return { model: this.info, state: 'unsupported', message: this.opts.unsupported }
    if (this.state === 'downloading') return { model: this.info, state: 'downloading', received: this.received }
    if (this.state === 'failed') return { model: this.info, state: 'failed', message: this.message }
    return { model: this.info, state: (await this.opts.store.installed()) ? 'installed' : 'not-installed' }
  }

  /** Downloads and checks the model; resolves with the status it ends in, whether installed, cancelled or failed. */
  async install(): Promise<SemanticModelStatus> {
    if (this.opts.unsupported || this.download) return this.status()
    const download = new AbortController()
    this.download = download
    this.state = 'downloading'
    this.received = 0
    this.message = undefined
    await this.emit()
    let last = 0
    try {
      await this.opts.store.install((received) => {
        this.received = received
        const now = Date.now()
        if (now - last >= PROGRESS_MS) {
          last = now
          void this.emit()
        }
      }, download.signal)
      this.state = null
    } catch (err) {
      if (download.signal.aborted) this.state = null
      else {
        this.state = 'failed'
        this.message = err instanceof ModelIntegrityError ? err.message : `The download did not complete: ${err instanceof Error ? err.message : String(err)}`
      }
    } finally {
      this.download = null
    }
    return this.emit()
  }

  cancel(): void {
    this.download?.abort()
  }

  /** Stops the model and deletes its files. The caller switches semantic detection off. */
  async remove(): Promise<SemanticModelStatus> {
    this.download?.abort()
    this.client.unload()
    await this.opts.store.remove()
    this.state = null
    this.message = undefined
    return this.emit()
  }

  /** The engine's semantic detector, or null when the model is not installed or cannot run here. */
  async detector(): Promise<SemanticSensitiveDataDetector | null> {
    if (this.opts.unsupported || this.state === 'downloading') return null
    return (await this.opts.store.installed()) ? this.gliner : null
  }

  /** Ends the model's process (on quit). */
  dispose(): void {
    this.download?.abort()
    this.client.unload()
  }

  private fail(message: string): Promise<SemanticModelStatus> {
    this.state = 'failed'
    this.message = message
    return this.emit()
  }

  private async emit(): Promise<SemanticModelStatus> {
    const s = await this.status()
    this.opts.onStatus(s)
    return s
  }
}
