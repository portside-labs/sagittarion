// Compact schema descriptions plus local retrieval (BM25, optional embeddings,
// foreign-key expansion) so a huge schema fits a small token budget.
//
// The index starts from object names only, which are cheap even for a hundred
// thousand tables, and pulls columns and foreign keys in on demand for the
// tables a question needs. Small schemas are loaded whole up front.
import type { ColumnHit, DatabaseKind, ObjectSummary, Relation, SchemaInfo, TableMeta, TableRef } from '@shared/types'
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

/** Where the index gets names, columns and foreign keys from. */
export interface SchemaSource {
  /** Every table and view, names only. */
  listTables(): Promise<ObjectSummary[]>
  /** Column metadata for a batch of tables. */
  tablesMeta(refs: TableRef[]): Promise<TableMeta[]>
  /** Foreign keys touching any of the given tables. */
  relationsFor(refs: TableRef[]): Promise<Relation[]>
  /** Tables whose column names match words, for questions about columns the excerpt does not show. */
  searchColumns?(query: string, limit: number): Promise<ColumnHit[]>
}

export interface IndexedTable {
  key: string
  ref: TableRef
  type: 'table' | 'view'
  columnCount: number | null
  rowEstimate: number | null
  comment: string | null
  /** Columns and keys, once loaded. */
  meta: TableMeta | null
  /** Keys of tables joined to this one by foreign keys, either direction, as far as known. */
  neighbors: Set<string>
  /** column -> referenced "table.column" */
  fkByColumn: Map<string, string>
  relationsLoaded: boolean
  /** Tokens of loaded column names, used to boost ranking. */
  colTokens: Set<string> | null
  /** Token estimate of the compact line. */
  tokens: number
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
  /** Schemas with at most this many tables are loaded whole when the index is created. */
  preloadUpTo?: number
}

const DEFAULT_PRELOAD = 400
const SAMPLE_COLUMNS_PER_LINE = 20

export class SchemaIndex {
  readonly kind: DatabaseKind
  readonly defaultSchema?: string
  readonly tables = new Map<string, IndexedTable>()
  /** Sample values by table key then column, filled in by the caller when allowed. */
  readonly samples = new Map<string, Record<string, string[]>>()
  totalTokens = 0
  private bm25: Bm25
  private embeddings: Map<string, number[]> | null = null
  private readonly wide: number
  private readonly source: SchemaSource | null

  private constructor(kind: DatabaseKind, defaultSchema: string | undefined, source: SchemaSource | null, opts: SchemaIndexOptions) {
    this.kind = kind
    this.defaultSchema = defaultSchema
    this.source = source
    this.wide = opts.wideTableColumns ?? 60
    this.bm25 = new Bm25([])
  }

  /** An index over a fully loaded schema: everything is known up front. */
  static fromSchema(schema: SchemaInfo, kind: DatabaseKind, opts: SchemaIndexOptions = {}): SchemaIndex {
    const index = new SchemaIndex(kind, schema.defaultSchema, null, opts)
    for (const meta of [...schema.tables, ...schema.views]) {
      index.addTable({ id: meta.name, kind: meta.type === 'view' ? 'view' : 'table', schema: meta.schema, name: meta.name, columnCount: meta.columns.length, rowEstimate: meta.rowEstimate, comment: meta.comment })
    }
    for (const t of index.tables.values()) t.relationsLoaded = true
    index.applyRelations(schema.relations ?? [])
    for (const meta of [...schema.tables, ...schema.views]) index.applyMeta(meta)
    index.rebuild()
    return index
  }

  /** An index over a live database: names now, columns and keys when a question needs them. */
  static async create(source: SchemaSource, kind: DatabaseKind, defaultSchema: string | undefined, opts: SchemaIndexOptions = {}): Promise<SchemaIndex> {
    const index = new SchemaIndex(kind, defaultSchema, source, opts)
    for (const o of await source.listTables()) index.addTable(o)
    index.rebuild()
    if (index.tables.size <= (opts.preloadUpTo ?? DEFAULT_PRELOAD)) {
      const keys = [...index.tables.keys()]
      await index.ensureColumns(keys)
      await index.ensureRelations(keys)
    }
    return index
  }

  private addTable(o: ObjectSummary): void {
    if (o.kind !== 'table' && o.kind !== 'view') return
    const ref: TableRef = { schema: o.schema, name: o.name }
    const key = tableLabel(ref, this.defaultSchema)
    if (this.tables.has(key)) return
    const t: IndexedTable = {
      key,
      ref,
      type: o.kind,
      columnCount: o.columnCount ?? null,
      rowEstimate: o.rowEstimate ?? null,
      comment: o.comment ?? null,
      meta: null,
      neighbors: new Set(),
      fkByColumn: new Map(),
      relationsLoaded: false,
      colTokens: null,
      tokens: 0
    }
    t.tokens = this.estimateLineTokens(t)
    this.tables.set(key, t)
    this.totalTokens += t.tokens
  }

  private estimateLineTokens(t: IndexedTable): number {
    if (t.meta) return estimateTokens(this.lineFor(t.key, { full: true, samples: false }))
    return estimateTokens(t.key) + 2 + (t.columnCount ?? 10) * 5
  }

  private applyMeta(meta: TableMeta): void {
    const t = this.tables.get(this.keyFor(meta))
    if (!t) return
    t.meta = meta
    t.columnCount = meta.columns.length
    if (typeof meta.rowEstimate === 'number') t.rowEstimate = meta.rowEstimate
    if (meta.comment) t.comment = meta.comment
    t.colTokens = new Set(meta.columns.flatMap((c) => tokenize(c.name)))
    this.totalTokens -= t.tokens
    t.tokens = this.estimateLineTokens(t)
    this.totalTokens += t.tokens
  }

  private applyRelations(relations: Relation[]): void {
    for (const r of relations) {
      const from = this.find(r.table, r.schema)
      const to = this.find(r.refTable, r.refSchema)
      if (!from || !to) continue
      from.neighbors.add(to.key)
      to.neighbors.add(from.key)
      from.fkByColumn.set(r.column, `${to.key}.${r.refColumn ?? to.meta?.pk[0] ?? 'id'}`)
    }
  }

  /** Rebuild the keyword index over names, schemas and comments. */
  private rebuild(): void {
    const docs: { id: string; tokens: string[] }[] = []
    for (const t of this.tables.values()) {
      docs.push({
        id: t.key,
        tokens: [...tokenize(t.ref.name), ...tokenize(t.ref.name), ...(t.ref.schema ? tokenize(t.ref.schema) : []), ...tokenize(t.comment ?? '')]
      })
    }
    this.bm25 = new Bm25(docs)
  }

  /** Load columns for tables that do not have them yet. */
  async ensureColumns(keys: string[]): Promise<void> {
    const missing = keys.map((k) => this.tables.get(k)).filter((t): t is IndexedTable => Boolean(t && !t.meta))
    if (!missing.length || !this.source) return
    for (let i = 0; i < missing.length; i += 200) {
      const batch = missing.slice(i, i + 200)
      const metas = await this.source.tablesMeta(batch.map((t) => t.ref))
      for (const m of metas) this.applyMeta(m)
      // Tables the source could not describe stay estimate-only but are not asked for again.
      for (const t of batch) if (!t.meta) t.meta = { ...t.ref, type: t.type, sql: null, columns: [], withoutRowid: true, rowidAlias: null, pk: [] }
    }
  }

  /** Load foreign keys for tables whose relations are not known yet. */
  async ensureRelations(keys: string[]): Promise<void> {
    const missing = keys.map((k) => this.tables.get(k)).filter((t): t is IndexedTable => Boolean(t && !t.relationsLoaded))
    if (!missing.length) return
    for (const t of missing) t.relationsLoaded = true
    if (!this.source) return
    for (let i = 0; i < missing.length; i += 200) {
      const batch = missing.slice(i, i + 200)
      this.applyRelations(await this.source.relationsFor(batch.map((t) => t.ref)))
    }
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
      if (t.key.toLowerCase() === lower || t.ref.name.toLowerCase() === lower) return t
      if (t.ref.schema && `${t.ref.schema}.${t.ref.name}`.toLowerCase() === lower) return t
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
    const cols = (t.meta?.columns ?? [])
      .slice(0, 40)
      .map((c) => c.name)
      .join(', ')
    return `${t.key}${cols ? `: ${cols}` : ''}${t.comment ? `. ${t.comment}` : ''}`
  }

  /** Rank tables for a question. Names and comments always count; loaded columns add to the score. */
  rank(question: string, queryVector?: number[] | null): { key: string; score: number }[] {
    const terms = [...new Set(tokenize(question))]
    const lexical = this.bm25.score(terms)
    for (const t of this.tables.values()) {
      if (!t.colTokens) continue
      let hits = 0
      for (const term of terms) if (t.colTokens.has(term)) hits++
      if (hits) lexical.set(t.key, (lexical.get(t.key) ?? 0) + hits)
    }
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
   * foreign keys and fills the budget in score order. Columns are loaded for
   * whatever is selected.
   */
  async select(question: string, budgetTokens: number, opts: { recentKeys?: string[]; queryVector?: number[] | null; seeds?: number } = {}): Promise<Selection> {
    const totalTables = this.tables.size
    if (this.totalTokens <= budgetTokens) {
      const keys = [...this.tables.keys()]
      await this.ensureColumns(keys)
      await this.ensureRelations(keys)
      if (this.totalTokens <= budgetTokens) return { mode: 'all', keys, tokens: this.totalTokens, totalTables, totalTokens: this.totalTokens }
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
      const hubs = [...this.tables.values()].sort((a, b) => b.neighbors.size - a.neighbors.size || (b.rowEstimate ?? 0) - (a.rowEstimate ?? 0) || a.key.localeCompare(b.key))
      seeds.push(...hubs.slice(0, seedCount).map((t) => t.key))
    }
    await this.ensureRelations(seeds)
    // One hop along foreign keys, bridge tables that connect two chosen tables,
    // then a second hop at low priority to use up whatever budget remains.
    const candidates = new Map<string, number>()
    for (const k of seeds) candidates.set(k, scores.get(k) ?? 0)
    for (const k of seeds) {
      const base = scores.get(k) ?? 0
      for (const n of this.tables.get(k)!.neighbors) if (!candidates.has(n)) candidates.set(n, Math.max(scores.get(n) ?? 0, base * 0.6))
    }
    await this.ensureRelations([...candidates.keys()])
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
      const cost = this.lineTokens(k)
      if (tokens + cost > budgetTokens && keys.length) continue
      keys.push(k)
      tokens += cost
      if (tokens >= budgetTokens) break
    }
    await this.ensureColumns(keys)
    tokens = keys.reduce((n, k) => n + this.lineTokens(k), 0)
    return { mode: 'retrieved', keys, tokens, totalTables, totalTokens: this.totalTokens }
  }

  private lineTokens(key: string): number {
    const t = this.tables.get(key)
    if (!t) return 0
    if (!t.meta) return t.tokens
    return t.meta.columns.length > this.wide ? estimateTokens(this.lineFor(key, { full: false, samples: false })) : t.tokens
  }

  /** One compact line for a table, e.g. orders(id int pk, user_id int fk->users.id, status text {paid|pending}) ~400 rows */
  lineFor(key: string, opts: { full?: boolean; samples?: boolean; matchTerms?: string[] } = {}): string {
    const t = this.tables.get(key)
    if (!t) return ''
    let line: string
    if (!t.meta) {
      line = `${t.key}(${t.columnCount ?? '?'} columns; describe_table for details)`
    } else {
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
        if (vals && vals.length) s += ` {${vals.slice(0, SAMPLE_COLUMNS_PER_LINE).join('|')}}`
        return s
      })
      if (omitted > 0) parts.push(`+${omitted} more columns (describe_table for all)`)
      line = `${t.key}(${parts.join(', ')})`
    }
    if (t.type === 'view') line += ' [view]'
    if (typeof t.rowEstimate === 'number' && t.rowEstimate >= 0) line += ` ~${formatCount(t.rowEstimate)} rows`
    if (t.comment) line += ` -- ${t.comment.replace(/\s+/g, ' ').slice(0, 120)}`
    return line
  }

  /** Everything about one table, for the describe_table tool. Loads what is missing. */
  async describe(key: string): Promise<string> {
    const t = this.tables.get(key)
    if (!t) return `Unknown table: ${key}`
    await this.ensureColumns([key])
    await this.ensureRelations([key])
    const lines = [this.lineFor(key, { full: true, samples: true })]
    const referencedBy: string[] = []
    for (const other of this.tables.values()) {
      for (const [col, target] of other.fkByColumn) if (target.startsWith(`${key}.`)) referencedBy.push(`${other.key}.${col}`)
    }
    if (referencedBy.length) lines.push(`referenced by: ${referencedBy.join(', ')}`)
    if (t.meta?.pk.length) lines.push(`primary key: ${t.meta.pk.join(', ')}`)
    return lines.join('\n')
  }

  /**
   * Compact lines of the best-matching tables for the search_schema tool.
   * Falls back to a column-name search in the database when names alone find little.
   */
  async search(query: string, limit: number, exclude: Set<string> = new Set()): Promise<string[]> {
    const terms = tokenize(query)
    const keys = this.rank(query)
      .filter((r) => !exclude.has(r.key))
      .slice(0, limit)
      .map((r) => r.key)
    if (keys.length < Math.min(3, limit) && this.source?.searchColumns) {
      for (const word of terms.slice(0, 4)) {
        if (keys.length >= limit) break
        let hits: ColumnHit[] = []
        try {
          hits = await this.source.searchColumns(word, 20)
        } catch {
          /* best effort */
        }
        for (const h of hits) {
          const t = this.find(h.table, h.schema)
          if (t && !exclude.has(t.key) && !keys.includes(t.key)) keys.push(t.key)
          if (keys.length >= limit) break
        }
      }
    }
    await this.ensureColumns(keys)
    return keys.map((k) => this.lineFor(k, { full: false, samples: true, matchTerms: terms }))
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
