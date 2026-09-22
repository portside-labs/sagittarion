// On-disk cache of table-description embeddings so a big schema is embedded once.
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export class EmbeddingCache {
  private data: Record<string, number[]> | null = null
  private dirty = false

  constructor(private readonly file: string) {}

  static key(model: string, text: string): string {
    return `${model}|${createHash('sha1').update(text).digest('hex')}`
  }

  private async load(): Promise<Record<string, number[]>> {
    if (this.data) return this.data
    try {
      this.data = JSON.parse(await fs.readFile(this.file, 'utf8')) as Record<string, number[]>
    } catch {
      this.data = {}
    }
    return this.data
  }

  async get(model: string, text: string): Promise<number[] | undefined> {
    return (await this.load())[EmbeddingCache.key(model, text)]
  }

  async set(model: string, text: string, vector: number[]): Promise<void> {
    const data = await this.load()
    data[EmbeddingCache.key(model, text)] = vector
    this.dirty = true
  }

  async save(): Promise<void> {
    if (!this.dirty || !this.data) return
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(this.data), 'utf8')
    await fs.rename(tmp, this.file)
    this.dirty = false
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}
