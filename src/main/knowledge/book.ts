// One connection's business knowledge, as the agent and the app use it: recalled for a question, added to as the
// model learns, and fed by every statement run on the database. Reading and writing go through the store.
import type { Knowledge, RunbookEntry } from '@shared/knowledge'
import type { SchemaIndex } from '../ai/schema-index'
import { domainMap, type DomainMap } from './domains'
import { scanFlow, toScan, type DefinitionReader } from './flow'
import { addLink, forgetLearned, keepInRunbook, learnDomain, learnFact, noteRunbookRun, recordQuery, reinforce, type DomainOutcome, type FactInput, type FactOutcome, type QueryRun, type RunbookInput } from './learn'
import { recall, tableNotes, type Recall } from './recall'
import { analyzeSql, sameSqlKey, type ColumnUse, type TableUse } from './sql-facts'
import type { KnowledgeStore } from './store'

/** A statement's tables, joins and values in terms of the schema's table keys. */
export function runFacts(sql: string, index?: SchemaIndex): Pick<QueryRun, 'tables' | 'joins' | 'values'> {
  const facts = analyzeSql(sql)
  const keyOf = (u: TableUse): string | undefined => {
    if (index) return index.find(u.name, u.schema)?.key
    return u.schema && !['public', 'main'].includes(u.schema.toLowerCase()) ? `${u.schema}.${u.name}` : u.name
  }
  const byAlias = new Map<string, string>()
  const tables: string[] = []
  for (const r of facts.reads) {
    const key = keyOf(r)
    if (!key) continue
    if (!tables.includes(key)) tables.push(key)
    byAlias.set((r.alias ?? r.name).toLowerCase(), key)
    byAlias.set(r.name.toLowerCase(), key)
  }
  const tableOf = (c: ColumnUse): string | undefined => (c.qualifier ? byAlias.get(c.qualifier.toLowerCase()) : tables.length === 1 ? tables[0] : undefined)
  const joins: QueryRun['joins'] = []
  for (const j of facts.joins) {
    const from = tableOf(j.left)
    const to = tableOf(j.right)
    if (!from || !to || from === to) continue
    // One way of writing it, whichever order the query used.
    const [a, b] = from < to ? [`${from}.${j.left.column}`, `${to}.${j.right.column}`] : [`${to}.${j.right.column}`, `${from}.${j.left.column}`]
    joins.push({ from: from < to ? from : to, to: from < to ? to : from, via: `${a} = ${b}` })
  }
  const values: QueryRun['values'] = []
  for (const v of facts.values) {
    const t = tableOf(v.column)
    if (t) values.push({ column: `${t}.${v.column.column}`, value: v.value })
  }
  return { tables, joins, values }
}

/**
 * The outline of a schema's domains, worked out again only when the schema index or the domains learned change: on a
 * schema of many thousands of tables it is worth keeping between asks.
 */
const outlines = new WeakMap<SchemaIndex, { signature: string; map: DomainMap }>()

function outlineFor(index: SchemaIndex, k: Knowledge): DomainMap {
  const signature = `${k.domains.length}:${Math.max(0, ...k.domains.map((d) => d.updatedAt))}:${index.tables.size}`
  const kept = outlines.get(index)
  if (kept && kept.signature === signature) return kept.map
  const map = domainMap(index, k)
  outlines.set(index, { signature, map })
  return map
}

export class KnowledgeBook {
  constructor(
    private readonly store: KnowledgeStore,
    readonly connectionId: string
  ) {}

  private async mapFor(index: SchemaIndex): Promise<{ k: Knowledge; map: DomainMap }> {
    const k = await this.store.get(this.connectionId)
    return { k, map: outlineFor(index, k) }
  }

  async recall(question: string, index: SchemaIndex): Promise<Recall> {
    const { k, map } = await this.mapFor(index)
    return recall(k, map, question, index)
  }

  /** What describe_table says about a table beyond its columns. */
  async notes(key: string, index: SchemaIndex): Promise<string[]> {
    const { k, map } = await this.mapFor(index)
    return tableNotes(k, map, key)
  }

  learn(input: FactInput): Promise<FactOutcome> {
    return this.store.change(this.connectionId, (k) => learnFact(k, input))
  }

  learnDomain(input: Parameters<typeof learnDomain>[1]): Promise<DomainOutcome> {
    return this.store.change(this.connectionId, (k) => learnDomain(k, input))
  }

  keep(input: RunbookInput): Promise<{ kind: 'added' | 'updated'; entry: RunbookEntry }> {
    return this.store.change(this.connectionId, (k) => keepInRunbook(k, input))
  }

  async entry(id: string): Promise<RunbookEntry | undefined> {
    const k = await this.store.get(this.connectionId)
    return k.runbook.find((r) => r.id.toLowerCase() === id.trim().toLowerCase())
  }

  ranEntry(id: string, ok: boolean, question?: string): Promise<void> {
    return this.store.change(this.connectionId, (k) => noteRunbookRun(k, id, ok, question))
  }

  /** A statement ran here, in the editor or for the model: counted by its shape, with its joins and values. */
  ran(sql: string, run: Pick<QueryRun, 'by' | 'question' | 'ok'>, index?: SchemaIndex): Promise<void> {
    const facts = runFacts(sql, index)
    return this.store.change(this.connectionId, (k) => recordQuery(k, { sql, ...facts, ...run }))
  }

  /** Facts an answer was built on: used once more, and surer by `amount`. */
  used(factIds: string[], amount: number): Promise<void> {
    if (!factIds.length) return Promise.resolve()
    return this.store.change(this.connectionId, (k) => reinforce(k, factIds, amount))
  }

  /** An answer's query, built on these facts: when the user runs it, they hold up more. */
  answered(sql: string, basis: { facts: string[]; question: string }): void {
    this.store.expect(this.connectionId, sameSqlKey(sql), { ...basis, at: Date.now() })
  }

  /**
   * A statement the user ran in the editor. When it is an answer's query, the facts the answer was built on hold up
   * more, and the query is counted with the question it answered.
   */
  async editorRun(sql: string, ok: boolean, index?: SchemaIndex): Promise<void> {
    const answer = ok ? this.store.take(this.connectionId, sameSqlKey(sql)) : undefined
    if (answer) await this.used(answer.facts, 0.05)
    await this.ran(sql, { by: 'user', ok, ...(answer ? { question: answer.question } : {}) }, index)
  }

  forget(item: Parameters<typeof forgetLearned>[1]): Promise<boolean> {
    return this.store.change(this.connectionId, (k) => forgetLearned(k, item))
  }

  /** Reads how data moves around these tables, a few at a time, and keeps it. */
  async scan(index: SchemaIndex, reader: DefinitionReader, keys: string[], budget = 6): Promise<number> {
    const k = await this.store.get(this.connectionId)
    const next = toScan(keys, k.scanned, budget)
    if (!next.length) return 0
    const { links, scanned } = await scanFlow(index, reader, next)
    const now = Date.now()
    await this.store.change(this.connectionId, (kk) => {
      for (const l of links) addLink(kk, l, now)
      for (const key of scanned) kk.scanned[key] = now
    })
    return links.length
  }
}
