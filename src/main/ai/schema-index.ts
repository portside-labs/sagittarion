// Compact schema descriptions plus local retrieval (BM25, optional embeddings,
// foreign-key expansion) so a huge schema fits a small token budget.
import type { DatabaseKind, Relation, SchemaInfo, TableMeta, TableRef } from '@shared/types'
import { tableLabel } from '@shared/connections'
import { cosine } from './embeddings'

const STOP = new Set(
  'a an the and or of for in on at to from by with as is are was were be do does did show me list get find give all any which what who where when how many much count total sum average avg min max number top first last latest newest oldest recent most least highest lowest per group grouped by than more less over under between before after since until during within this that these those it its their them they i we you my our your please can could would should have has had not no yes only just each every rows row records record table tables column columns data select query return'.split(
    /\s+/
  )
)

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Split identifiers and prose into lowercase word tokens, crude singulars included. */
export function tokenize(text: string): string[] {
  const out: string[] = []
  const parts = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-./:,()[\]{}"'`]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
  for (const p of parts) {
    if (p.length < 2 || STOP.has(p)) continue
    out.push(p)
    if (p.length > 3 && p.endsWith('ies')) out.push(p.slice(0, -3) + 'y')
    else if (p.length > 3 && p.endsWith('es') && /(s|x|z|ch|sh)es$/.test(p)) out.push(p.slice(0, -2))
    else if (p.length > 3 && p.endsWith('s') && !p.endsWith('ss')) out.push(p.slice(0, -1))
  }
  return out
}

export class Bm25 {
  private readonly df = new Map<string, number>()
  private readonly docs = new Map<string, Map<string, number>>()
  private readonly lengths = new Map<string, number>()
  private avgLen = 1

  constructor(docs: { id: string; tokens: string[] }[]) {
    let total = 0
    for (const d of docs) {
      const tf = new Map<string, number>()
      for (const t of d.tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1)
      this.docs.set(d.id, tf)
      this.lengths.set(d.id, d.tokens.length)
      total += d.tokens.length
    }
    this.avgLen = docs.length ? total / docs.length : 1
  }

  score(queryTokens: string[], k1 = 1.2, b = 0.75): Map<string, number> {
    const n = this.docs.size
    const scores = new Map<string, number>()
    const unique = [...new Set(queryTokens)]
    for (const [id, tf] of this.docs) {
      const len = this.lengths.get(id) ?? 0
      let s = 0
      for (const q of unique) {
        const f = tf.get(q)
        if (!f) continue
        const df = this.df.get(q) ?? 0
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
        s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / this.avgLen)))
      }
      if (s > 0) scores.set(id, s)
    }
    return scores
  }
}

const TYPE_MAP: [RegExp, string][] = [
  [/^(big|small)?int(eger)?(\(\d+\))?$|^serial|^bigserial|^int[248]$/, 'int'],
  [/^(character varying|varchar|char|character|text|clob|citext|nvarchar|nchar)/, 'text'],
  [/^timestamp with time zone|^timestamptz/, 'timestamptz'],
  [/^timestamp/, 'timestamp'],
  [/^double precision|^float\d*|^real$/, 'float'],
  [/^numeric|^decimal|^money/, 'numeric'],
  [/^bool/, 'bool']
]

export function compactType(type: string): string {
  const t = (type ?? '').trim().toLowerCase()
  if (!t) return ''
  for (const [re, name] of TYPE_MAP) if (re.test(t)) return name
  return t.replace(/\s+/g, ' ')
}

export interface IndexedTable {
  key: string
  ref: TableRef
  meta: TableMeta
  /** Token estimate of the compact line without sample values. */
  tokens: number
  docTokens: string[]
  /** Keys of tables joined to this one by foreign keys, either direction. */
  neighbors: Set<string>
  /** column -> referenced "table.column" */
  fkByColumn: Map<string, string>
}

export interface Selection {
  mode: 'all' | 'retrieved'
  keys: string[]
  tokens: number
  totalTables: number
  totalTokens: number
}

export interface SchemaIndexOptions {
  /** Tables with more columns than this get a shortened line unless described in full. */
  wideTableColumns?: number
}

export class SchemaIndex {
  readonly kind: DatabaseKind
  readonly defaultSchema?: string
  readonly tables = new Map<string, IndexedTable>()
  readonly totalTokens: number
  readonly relations: Relation[]
  /** Sample values by table key then column, filled in by the caller when allowed. */
  readonly samples = new Map<string, Record<string, string[]>>()
  private readonly bm25: Bm25
  private embeddings: Map<string, number[]> | null = null
  private readonly wide: number

  constructor(schema: SchemaInfo, kind: DatabaseKind, opts: SchemaIndexOptions = {}) {
    this.kind = kind
    this.defaultSchema = schema.defaultSchema
    this.wide = opts.wideTableColumns ?? 60
    this.relations = schema.relations ?? []
    const all = [...schema.tables, ...schema.views]
    for (const meta of all) {
      const key = tableLabel(meta, schema.defaultSchema)
      if (this.tables.has(key)) continue
      const ref: TableRef = { schema: meta.schema, name: meta.name }
      const t: IndexedTable = { key, ref, meta, tokens: 0, docTokens: [], neighbors: new Set(), fkByColumn: new Map() }
      this.tables.set(key, t)
    }
    for (const r of this.relations) {
      const from = this.find(r.table, r.schema)
      const to = this.find(r.refTable, r.refSchema)
      if (!from || !to) continue
      from.neighbors.add(to.key)
      to.neighbors.add(from.key)
      from.fkByColumn.set(r.column, `${to.key}.${r.refColumn ?? to.meta.pk[0] ?? 'id'}`)
    }
    let total = 0
    const docs: { id: string; tokens: string[] }[] = []
    for (const t of this.tables.values()) {
      t.tokens = estimateTokens(this.lineFor(t.key, { full: true, samples: false }))
      total += t.tokens
      const words = [
        ...tokenize(t.meta.name),
        ...tokenize(t.meta.name), // name counts double
        ...(t.meta.schema ? tokenize(t.meta.schema) : []),
        ...t.meta.columns.flatMap((c) => tokenize(c.name)),
        ...tokenize(t.meta.comment ?? ''),
        ...[...t.neighbors].flatMap((n) => tokenize(n))
      ]
      t.docTokens = words
      docs.push({ id: t.key, tokens: words })
    }
    this.totalTokens = total
    this.bm25 = new Bm25(docs)
  }

  /** Resolve "schema.table", "table", or a TableRef to an indexed table. */
  find(name: string, schema?: string): IndexedTable | undefined {
    if (schema) {
      const direct = this.tables.get(tableLabel({ schema, name }, this.defaultSchema))
      if (direct) return direct
    }
    const exact = this.tables.get(name)
    if (exact) return exact
    const lower = name.toLowerCase()
    for (const t of this.tables.values()) {
      if (t.key.toLowerCase() === lower || t.meta.name.toLowerCase() === lower) return t
      if (t.meta.schema && `${t.meta.schema}.${t.meta.name}`.toLowerCase() === lower) return t
    }
    return undefined
  }

  keyFor(ref: TableRef): string {
    return tableLabel(ref, this.defaultSchema)
  }

  setEmbeddings(vectors: Map<string, number[]>): void {
    this.embeddings = vectors
  }

  /** Text used to embed a table: what it is called and what it holds. */
  embeddingText(key: string): string {
    const t = this.tables.get(key)
    if (!t) return key
    const cols = t.meta.columns
      .slice(0, 40)
      .map((c) => c.name)
      .join(', ')
    return `${t.key}: ${cols}${t.meta.comment ? `. ${t.meta.comment}` : ''}`
  }

  /** Rank tables for a question. Fuses BM25 with embeddings when both exist. */
  rank(question: string, queryVector?: number[] | null): { key: string; score: number }[] {
    const lexical = this.bm25.score(tokenize(question))
    if (!queryVector || !this.embeddings) {
      return [...lexical.entries()].map(([key, score]) => ({ key, score })).sort((a, b) => b.score - a.score)
    }
    const semantic = new Map<string, number>()
    for (const [key, vec] of this.embeddings) semantic.set(key, cosine(queryVector, vec))
    const lexRank = [...lexical.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
    const semRank = [...semantic.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
    const fused = new Map<string, number>()
    const add = (list: string[], weight: number) => list.forEach((k, i) => fused.set(k, (fused.get(k) ?? 0) + weight / (60 + i)))
    add(lexRank, 1)
    add(semRank.slice(0, 50), 1)
    return [...fused.entries()].map(([key, score]) => ({ key, score })).sort((a, b) => b.score - a.score)
  }

  /**
   * Pick the tables to show the model. Sends everything when the whole compact
   * schema fits the budget (stable, cacheable); otherwise ranks, expands along
   * foreign keys and fills the budget in score order.
   */
  select(question: string, budgetTokens: number, opts: { recentKeys?: string[]; queryVector?: number[] | null; seeds?: number } = {}): Selection {
    const totalTables = this.tables.size
    if (this.totalTokens <= budgetTokens) {
      return { mode: 'all', keys: [...this.tables.keys()], tokens: this.totalTokens, totalTables, totalTokens: this.totalTokens }
    }
    const ranked = this.rank(question, opts.queryVector)
    const scores = new Map<string, number>(ranked.map((r) => [r.key, r.score]))
    const top = ranked.length ? ranked[0].score : 1
    for (const k of opts.recentKeys ?? []) if (this.tables.has(k)) scores.set(k, (scores.get(k) ?? 0) + top * 0.5)
    const ordered = [...scores.entries()].sort((a, b) => b[1] - a[1])
    const seedCount = opts.seeds ?? 8
    const seeds = ordered.slice(0, seedCount).map(([k]) => k)
    if (!seeds.length) {
      // Nothing matched by name: start from the most connected (and largest) tables.
      const hubs = [...this.tables.values()].sort((a, b) => b.neighbors.size - a.neighbors.size || (b.meta.rowEstimate ?? 0) - (a.meta.rowEstimate ?? 0))
      seeds.push(...hubs.slice(0, seedCount).map((t) => t.key))
    }
    // One hop along foreign keys, bridge tables that connect two chosen tables,
    // then a second hop at low priority to use up whatever budget remains.
    const candidates = new Map<string, number>()
    for (const k of seeds) candidates.set(k, scores.get(k) ?? 0)
    for (const k of seeds) {
      const base = scores.get(k) ?? 0
      for (const n of this.tables.get(k)!.neighbors) if (!candidates.has(n)) candidates.set(n, Math.max(scores.get(n) ?? 0, base * 0.6))
    }
    for (const t of this.tables.values()) {
      if (candidates.has(t.key)) continue
      let links = 0
      for (const n of t.neighbors) if (candidates.has(n)) links++
      if (links >= 2) candidates.set(t.key, (scores.get(t.key) ?? 0) + top * 0.3)
    }
    for (const k of [...candidates.keys()]) {
      const base = candidates.get(k) ?? 0
      for (const n of this.tables.get(k)!.neighbors) if (!candidates.has(n)) candidates.set(n, Math.max(scores.get(n) ?? 0, base * 0.2))
    }
    // Remaining keyword matches beyond the seeds, in score order, fill any budget left.
    for (const [k, sc] of ordered) if (!candidates.has(k)) candidates.set(k, sc)
    const keys: string[] = []
    let tokens = 0
    for (const [k] of [...candidates.entries()].sort((a, b) => b[1] - a[1])) {
      const t = this.tables.get(k)!
      const cost = this.lineTokens(k)
      if (tokens + cost > budgetTokens && keys.length) continue
      keys.push(k)
      tokens += cost
      if (tokens >= budgetTokens) break
      void t
    }
    return { mode: 'retrieved', keys, tokens, totalTables, totalTokens: this.totalTokens }
  }

  private lineTokens(key: string): number {
    const t = this.tables.get(key)
    if (!t) return 0
    return t.meta.columns.length > this.wide ? estimateTokens(this.lineFor(key, { full: false, samples: false })) : t.tokens
  }

  /** One compact line for a table, e.g. orders(id int pk, user_id int fk->users.id, status text {paid|pending}) ~400 rows */
  lineFor(key: string, opts: { full?: boolean; samples?: boolean; matchTerms?: string[] } = {}): string {
    const t = this.tables.get(key)
    if (!t) return ''
    const full = opts.full ?? true
    const samples = (opts.samples ?? true) ? this.samples.get(key) : undefined
    const terms = new Set(opts.matchTerms ?? [])
    let cols = t.meta.columns
    let omitted = 0
    if (!full && cols.length > this.wide) {
      const keep = cols.filter((c, i) => i < 25 || c.pk > 0 || t.fkByColumn.has(c.name) || tokenize(c.name).some((w) => terms.has(w)))
      omitted = cols.length - keep.length
      cols = keep
    }
    const parts = cols.map((c) => {
      let s = c.name
      const ty = compactType(c.type)
      if (ty) s += ` ${ty}`
      if (c.pk > 0) s += ' pk'
      const fk = t.fkByColumn.get(c.name)
      if (fk) s += ` fk->${fk}`
      const vals = samples?.[c.name]
      if (vals && vals.length) s += ` {${vals.slice(0, 20).join('|')}}`
      return s
    })
    if (omitted > 0) parts.push(`+${omitted} more columns (describe_table for all)`)
    let line = `${t.key}(${parts.join(', ')})`
    if (t.meta.type === 'view') line += ' [view]'
    if (typeof t.meta.rowEstimate === 'number' && t.meta.rowEstimate >= 0) line += ` ~${formatCount(t.meta.rowEstimate)} rows`
    if (t.meta.comment) line += ` -- ${t.meta.comment.replace(/\s+/g, ' ').slice(0, 120)}`
    return line
  }

  /** Everything about one table, for the describe_table tool. */
  describe(key: string): string {
    const t = this.tables.get(key)
    if (!t) return `Unknown table: ${key}`
    const lines = [this.lineFor(key, { full: true, samples: true })]
    const refs = this.relations.filter((r) => this.find(r.refTable, r.refSchema)?.key === key)
    if (refs.length) lines.push(`referenced by: ${refs.map((r) => `${this.find(r.table, r.schema)?.key ?? r.table}.${r.column}`).join(', ')}`)
    if (t.meta.pk.length) lines.push(`primary key: ${t.meta.pk.join(', ')}`)
    return lines.join('\n')
  }

  /** Compact lines of the best-matching tables for the search_schema tool. */
  search(query: string, limit: number, exclude: Set<string> = new Set()): string[] {
    const terms = tokenize(query)
    return this.rank(query)
      .filter((r) => !exclude.has(r.key))
      .slice(0, limit)
      .map((r) => this.lineFor(r.key, { full: false, samples: true, matchTerms: terms }))
  }

  /** The schema block for the prompt, in stable order for cacheability. */
  render(selection: Selection, question: string): string {
    const terms = tokenize(question)
    const keys = selection.mode === 'all' ? selection.keys : [...selection.keys].sort()
    return keys.map((k) => this.lineFor(k, { full: false, samples: true, matchTerms: terms })).join('\n')
  }
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(Math.round(n))
}
