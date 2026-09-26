// The on-device model's files on this computer: downloading them, checking them against the manifest, removing them.
// A download goes to a fresh folder beside the final one and is hashed as it streams in; it is moved into place only
// when every file has the pinned size and SHA-256, so a failed, cancelled or tampered download leaves nothing behind.
// Before each load the installed files are hashed again: a model is never replaced or altered silently.
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { modelUrl, modelSize, type ModelFile, type SemanticModelManifest } from './manifest'

export class ModelIntegrityError extends Error {
  constructor(
    readonly file: string,
    readonly problem: 'missing' | 'size' | 'digest' | 'download'
  ) {
    const why = { missing: 'is missing', size: 'has the wrong size', digest: 'does not match its pinned SHA-256', download: 'could not be downloaded' }[problem]
    super(`The on-device model file ${file} ${why}.`)
    this.name = 'ModelIntegrityError'
  }
}

export interface ModelStoreOptions {
  /** Where models live, e.g. <userData>/models. */
  root: string
  manifest: SemanticModelManifest
  fetch: typeof fetch
  /** Where each file is downloaded from; the manifest's pinned address unless a test says otherwise. */
  urlFor?: (file: ModelFile) => string
}

export class ModelStore {
  constructor(private readonly opts: ModelStoreOptions) {}

  get manifest(): SemanticModelManifest {
    return this.opts.manifest
  }

  /** <root>/<id>/<version> */
  get dir(): string {
    return path.join(this.opts.root, this.opts.manifest.id, this.opts.manifest.version)
  }

  get size(): number {
    return modelSize(this.opts.manifest)
  }

  /** Every file present at its pinned size. The digests are checked by verify(), before the model is loaded. */
  async installed(): Promise<boolean> {
    for (const f of this.opts.manifest.files) {
      const s = await stat(path.join(this.dir, f.path)).catch(() => null)
      if (!s?.isFile() || s.size !== f.size) return false
    }
    return true
  }

  /** Hashes every installed file; throws ModelIntegrityError for the first that is missing or altered. */
  async verify(signal?: AbortSignal): Promise<void> {
    for (const f of this.opts.manifest.files) {
      const file = path.join(this.dir, f.path)
      const s = await stat(file).catch(() => null)
      if (!s?.isFile()) throw new ModelIntegrityError(f.path, 'missing')
      if (s.size !== f.size) throw new ModelIntegrityError(f.path, 'size')
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(file, { signal })) hash.update(chunk as Buffer)
      if (hash.digest('hex') !== f.sha256) throw new ModelIntegrityError(f.path, 'digest')
    }
  }

  /** Downloads and checks every file, then puts them in place together. Rejects, leaving nothing, on any mismatch. */
  async install(onProgress: (received: number, total: number) => void, signal?: AbortSignal): Promise<void> {
    const parent = path.dirname(this.dir)
    await mkdir(parent, { recursive: true })
    await this.clean()
    const staging = path.join(parent, `.${this.opts.manifest.version}.download-${randomBytes(6).toString('hex')}`)
    const total = this.size
    let received = 0
    try {
      for (const f of this.opts.manifest.files) {
        const target = path.join(staging, f.path)
        await mkdir(path.dirname(target), { recursive: true })
        const res = await this.opts.fetch(this.opts.urlFor?.(f) ?? modelUrl(this.opts.manifest, f), { signal, redirect: 'follow' })
        if (!res.ok || !res.body) throw new ModelIntegrityError(f.path, 'download')
        const announced = Number(res.headers.get('content-length'))
        if (announced && announced !== f.size) throw new ModelIntegrityError(f.path, 'size')
        const hash = createHash('sha256')
        let bytes = 0
        const check = new Transform({
          transform(chunk: Buffer, _enc, done) {
            bytes += chunk.length
            if (bytes > f.size) return done(new ModelIntegrityError(f.path, 'size'))
            hash.update(chunk)
            received += chunk.length
            onProgress(received, total)
            done(null, chunk)
          }
        })
        await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), check, createWriteStream(target), { signal })
        if (bytes !== f.size) throw new ModelIntegrityError(f.path, 'size')
        if (hash.digest('hex') !== f.sha256) throw new ModelIntegrityError(f.path, 'digest')
      }
      await rm(this.dir, { recursive: true, force: true })
      await rename(staging, this.dir)
    } catch (err) {
      await rm(staging, { recursive: true, force: true })
      throw err
    }
  }

  async remove(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true })
    await this.clean()
  }

  /** Leftovers of downloads that never finished (the app quit mid-way). */
  private async clean(): Promise<void> {
    const parent = path.dirname(this.dir)
    const prefix = `.${this.opts.manifest.version}.download-`
    for (const name of await readdir(parent).catch(() => [] as string[])) {
      if (name.startsWith(prefix)) await rm(path.join(parent, name), { recursive: true, force: true })
    }
  }
}
