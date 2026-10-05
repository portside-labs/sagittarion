// Business knowledge on disk: one file per saved connection under <userData>/knowledge, read once and kept in memory,
// and written a moment after it changes, so a run of changes during an ask is one write. Only this computer has it.
import { promises as fs, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { emptyKnowledge, type Knowledge, type KnowledgeSource } from '@shared/knowledge'

/** How much is kept per connection. The least used and oldest go first; what the user said goes last. */
export const LIMITS = { facts: 400, domains: 150, runbook: 150, queries: 400, links: 1500, values: 1500 } as const
const SCANNED_DAYS = 30

const SOURCES: KnowledgeSource[] = ['user', 'data', 'inferred', 'structure']
const isSource = (v: unknown): v is KnowledgeSource => SOURCES.includes(v as KnowledgeSource)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** A file as read: anything malformed in it is dropped rather than trusted. */
export function sanitizeKnowledge(raw: any): Knowledge {
  const k = emptyKnowledge()
  if (!raw || typeof raw !== 'object') return k
  const now = Date.now()
  for (const f of Array.isArray(raw.facts) ? raw.facts : []) {
    if (!f || typeof f.id !== 'string' || typeof f.name !== 'string' || typeof f.meaning !== 'string' || !isSource(f.source)) continue
    k.facts.push({
      id: f.id,
      kind: f.kind === 'rule' ? 'rule' : 'term',
      name: f.name,
      aliases: strings(f.aliases),
      meaning: f.meaning,
      ...(typeof f.sql === 'string' && f.sql ? { sql: f.sql } : {}),
      tables: strings(f.tables),
      ...(typeof f.domain === 'string' && f.domain ? { domain: f.domain } : {}),
      source: f.source,
      confidence: Math.min(1, Math.max(0, num(f.confidence, 0.5))),
      uses: num(f.uses),
      ...(typeof f.lastUsedAt === 'number' ? { lastUsedAt: f.lastUsedAt } : {}),
      createdAt: num(f.createdAt, now),
      updatedAt: num(f.updatedAt, now),
      ...(Array.isArray(f.replaced) ? { replaced: f.replaced.filter((r: any) => r && typeof r.meaning === 'string').slice(0, 5) } : {}),
      ...(typeof f.learnedFrom === 'string' ? { learnedFrom: f.learnedFrom } : {})
    })
  }
  for (const d of Array.isArray(raw.domains) ? raw.domains : []) {
    if (!d || typeof d.path !== 'string' || !d.path || !isSource(d.source)) continue
    k.domains.push({
      path: d.path,
      ...(typeof d.description === 'string' && d.description ? { description: d.description } : {}),
      tables: strings(d.tables),
      source: d.source,
      confidence: Math.min(1, Math.max(0, num(d.confidence, 0.5))),
      createdAt: num(d.createdAt, now),
      updatedAt: num(d.updatedAt, now)
    })
  }
  for (const r of Array.isArray(raw.runbook) ? raw.runbook : []) {
    if (!r || typeof r.id !== 'string' || typeof r.name !== 'string' || typeof r.sql !== 'string' || !isSource(r.source)) continue
    k.runbook.push({
      id: r.id,
      name: r.name,
      purpose: typeof r.purpose === 'string' ? r.purpose : '',
      sql: r.sql,
      params: (Array.isArray(r.params) ? r.params : [])
        .filter((p: any) => p && typeof p.name === 'string')
        .map((p: any) => ({ name: p.name, ...(typeof p.description === 'string' ? { description: p.description } : {}), ...(typeof p.example === 'string' ? { example: p.example } : {}) })),
      questions: strings(r.questions).slice(0, 8),
      tables: strings(r.tables),
      ...(typeof r.domain === 'string' && r.domain ? { domain: r.domain } : {}),
      source: r.source,
      runs: num(r.runs),
      failures: num(r.failures),
      ...(typeof r.lastRunAt === 'number' ? { lastRunAt: r.lastRunAt } : {}),
      createdAt: num(r.createdAt, now),
      updatedAt: num(r.updatedAt, now)
    })
  }
  for (const q of Array.isArray(raw.queries) ? raw.queries : []) {
    if (!q || typeof q.shape !== 'string' || typeof q.sql !== 'string') continue
    k.queries.push({
      shape: q.shape,
      sql: q.sql,
      tables: strings(q.tables),
      by: q.by === 'model' ? 'model' : 'user',
      ...(typeof q.question === 'string' && q.question ? { question: q.question } : {}),
      count: Math.max(1, num(q.count, 1)),
      errors: num(q.errors),
      firstAt: num(q.firstAt, now),
      lastAt: num(q.lastAt, now)
    })
  }
  for (const l of Array.isArray(raw.links) ? raw.links : []) {
    if (!l || typeof l.from !== 'string' || typeof l.to !== 'string' || typeof l.via !== 'string' || !['join', 'writes', 'feeds'].includes(l.kind)) continue
    k.links.push({ from: l.from, to: l.to, kind: l.kind, via: l.via, count: Math.max(1, num(l.count, 1)), lastAt: num(l.lastAt, now) })
  }
  for (const v of Array.isArray(raw.values) ? raw.values : []) {
    if (!v || typeof v.value !== 'string' || typeof v.column !== 'string') continue
    k.values.push({ value: v.value, column: v.column, count: Math.max(1, num(v.count, 1)), lastAt: num(v.lastAt, now) })
  }
  if (raw.scanned && typeof raw.scanned === 'object') {
    for (const [key, at] of Object.entries(raw.scanned)) if (typeof at === 'number') k.scanned[key] = at
  }
  k.nextQuery = Math.max(1, num(raw.nextQuery, 1), ...k.runbook.map((r) => (Number(/^q(\d+)$/.exec(r.id)?.[1]) || 0) + 1))
  return k
}

/** What is kept of a list over its limit: the highest scoring. */
function keepBest<T>(list: T[], limit: number, score: (item: T) => number): T[] {
  if (list.length <= limit) return list
  return [...list].sort((a, b) => score(b) - score(a)).slice(0, limit)
}

/** Recent and much used beats old and seldom: a month without use halves an item's weight. */
function weight(count: number, at: number, now: number): number {
  return Math.log2(1 + count) * Math.pow(0.5, Math.max(0, now - at) / (30 * 86_400_000))
}

/** Keeps a connection's knowledge within its limits. */
export function trimKnowledge(k: Knowledge, now = Date.now()): void {
  k.facts = keepBest(k.facts, LIMITS.facts, (f) => (f.source === 'user' ? 1000 : 0) + f.confidence * 10 + weight(f.uses + 1, f.lastUsedAt ?? f.updatedAt, now))
  k.domains = keepBest(k.domains, LIMITS.domains, (d) => (d.source === 'user' ? 1000 : 0) + d.confidence * 10 + weight(1, d.updatedAt, now))
  k.runbook = keepBest(k.runbook, LIMITS.runbook, (r) => (r.source === 'user' ? 1000 : 0) + weight(r.runs + 1, r.lastRunAt ?? r.updatedAt, now) - r.failures)
  k.queries = keepBest(k.queries, LIMITS.queries, (q) => weight(q.count, q.lastAt, now) + (q.question ? 1 : 0))
  k.links = keepBest(k.links, LIMITS.links, (l) => (l.kind === 'join' ? 0 : 5) + weight(l.count, l.lastAt, now))
  k.values = keepBest(k.values, LIMITS.values, (v) => weight(v.count, v.lastAt, now))
  const cutoff = now - SCANNED_DAYS * 86_400_000
  for (const [key, at] of Object.entries(k.scanned)) if (at < cutoff) delete k.scanned[key]
}

/** An answer's query, waiting for the user to run it: what it was built on, and the question it answered. */
export interface PendingAnswer {
  facts: string[]
  question: string
  at: number
}

/** How long an answer waits to be run before it no longer counts as the user taking it. */
const PENDING_MS = 2 * 3_600_000

export class KnowledgeStore {
  private readonly cache = new Map<string, Knowledge>()
  /** By connection, then by the query's words: memory only. */
  private readonly pending = new Map<string, Map<string, PendingAnswer>>()
  private readonly loading = new Map<string, Promise<Knowledge>>()
  private readonly dirty = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly dir: string,
    private readonly delayMs = 1000
  ) {}

  private file(connectionId: string): string {
    return path.join(this.dir, `${connectionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
  }

  /** A connection's knowledge, read from disk the first time. Change it only through change(). */
  get(connectionId: string): Promise<Knowledge> {
    const cached = this.cache.get(connectionId)
    if (cached) return Promise.resolve(cached)
    let pending = this.loading.get(connectionId)
    if (!pending) {
      pending = fs
        .readFile(this.file(connectionId), 'utf8')
        .then((text) => sanitizeKnowledge(JSON.parse(text)))
        .catch(() => emptyKnowledge())
        .then((k) => {
          // A change made while it was read wins over what was on disk.
          const now = this.cache.get(connectionId) ?? k
          this.cache.set(connectionId, now)
          this.loading.delete(connectionId)
          return now
        })
      this.loading.set(connectionId, pending)
    }
    return pending
  }

  /** Changes a connection's knowledge in memory; it is written soon after. */
  async change<T>(connectionId: string, fn: (k: Knowledge) => T): Promise<T> {
    const k = await this.get(connectionId)
    const out = fn(k)
    trimKnowledge(k)
    this.dirty.add(connectionId)
    this.schedule()
    return out
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.delayMs)
  }

  /** Writes whatever changed; at once, as when the app quits. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const ids = [...this.dirty]
    this.dirty.clear()
    this.writing = this.writing.then(async () => {
      if (!ids.length) return
      try {
        await fs.mkdir(this.dir, { recursive: true })
      } catch {
        for (const id of ids) this.dirty.add(id)
        return
      }
      for (const id of ids) {
        const k = this.cache.get(id)
        if (!k) continue
        const file = this.file(id)
        const tmp = `${file}.tmp`
        try {
          await fs.writeFile(tmp, JSON.stringify(k), { encoding: 'utf8', mode: 0o600 })
          await fs.rename(tmp, file)
        } catch {
          // Kept in memory; tried again with the next change.
          this.dirty.add(id)
        }
      }
    })
    return this.writing
  }

  /** An answer's query, to recognise when the user runs it. */
  expect(connectionId: string, key: string, answer: PendingAnswer): void {
    const now = answer.at
    const list = this.pending.get(connectionId) ?? new Map<string, PendingAnswer>()
    for (const [k, a] of list) if (now - a.at > PENDING_MS) list.delete(k)
    list.set(key, answer)
    if (list.size > 50) list.delete(list.keys().next().value!)
    this.pending.set(connectionId, list)
  }

  /** The answer a query run in the editor came from, once; undefined when it came from none. */
  take(connectionId: string, key: string, now = Date.now()): PendingAnswer | undefined {
    const list = this.pending.get(connectionId)
    const found = list?.get(key)
    if (!found) return undefined
    list!.delete(key)
    return now - found.at > PENDING_MS ? undefined : found
  }

  /** Writes whatever changed before the app exits, which does not wait for promises. */
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty.size) return
    try {
      mkdirSync(this.dir, { recursive: true })
      for (const id of this.dirty) {
        const k = this.cache.get(id)
        if (!k) continue
        const file = this.file(id)
        writeFileSync(`${file}.tmp`, JSON.stringify(k), { encoding: 'utf8', mode: 0o600 })
        renameSync(`${file}.tmp`, file)
      }
      this.dirty.clear()
    } catch {
      /* best effort while closing */
    }
  }

  /** A connection was deleted: so is what was learned about it. */
  async forgetConnection(connectionId: string): Promise<void> {
    this.cache.delete(connectionId)
    this.dirty.delete(connectionId)
    this.pending.delete(connectionId)
    await this.writing
    await fs.rm(this.file(connectionId), { force: true })
  }

  /** Everything learned, for every connection, goes. */
  async forgetAll(): Promise<void> {
    this.cache.clear()
    this.dirty.clear()
    this.pending.clear()
    await this.writing
    await fs.rm(this.dir, { recursive: true, force: true })
  }
}
