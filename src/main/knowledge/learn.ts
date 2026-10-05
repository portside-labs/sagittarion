// How knowledge changes: a term, rule or domain learned or corrected, a query kept in the runbook, a statement run,
// an answer that held up. Pure functions over one connection's Knowledge; the store writes the result.
import { randomBytes } from 'node:crypto'
import {
  CONFIDENCE_CEILING,
  domainPath,
  normalizeName,
  SOURCE_CONFIDENCE,
  SOURCE_RANK,
  type DataLink,
  type Knowledge,
  type KnowledgeDomain,
  type KnowledgeFact,
  type KnowledgeSource,
  type RunbookEntry,
  type RunbookParam
} from '@shared/knowledge'
import { tokenize } from '../ai/schema-index'
import { analyzeSql, sameSqlKey } from './sql-facts'

const newId = () => `f${randomBytes(4).toString('hex')}`

/** How alike two meanings are, by their words: 1 the same words, 0 none shared. */
function overlap(a: string, b: string): number {
  const x = new Set(tokenize(a))
  const y = new Set(tokenize(b))
  if (!x.size || !y.size) return normalizeName(a) === normalizeName(b) ? 1 : 0
  let shared = 0
  for (const t of x) if (y.has(t)) shared++
  return shared / Math.min(x.size, y.size)
}

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])]

export interface FactInput {
  kind: 'term' | 'rule'
  name: string
  meaning: string
  sql?: string
  /** Table keys, already checked against the schema. */
  tables: string[]
  aliases?: string[]
  domain?: string
  source: KnowledgeSource
  question?: string
}

export type FactOutcome =
  | { kind: 'added' | 'confirmed' | 'corrected'; fact: KnowledgeFact }
  /** Something more trusted says otherwise: what the user said gives way only to the user. */
  | { kind: 'refused'; fact: KnowledgeFact }

/** The fact of this kind that goes by a name, or by one of its aliases. */
export function findFact(k: Knowledge, kind: 'term' | 'rule', names: string[]): KnowledgeFact | undefined {
  const wanted = new Set(names.map(normalizeName).filter(Boolean))
  return k.facts.find((f) => f.kind === kind && (wanted.has(normalizeName(f.name)) || f.aliases.some((a) => wanted.has(normalizeName(a)))))
}

/**
 * Learns a term or rule. The same thing said again confirms it; something different corrects it, keeping what it
 * meant before, unless what is known came from a more trusted source.
 */
export function learnFact(k: Knowledge, input: FactInput, now = Date.now()): FactOutcome {
  const name = input.name.replace(/\s+/g, ' ').trim()
  const meaning = input.meaning.replace(/\s+/g, ' ').trim()
  const sql = input.sql?.trim() || undefined
  const aliases = (input.aliases ?? []).map((a) => a.replace(/\s+/g, ' ').trim()).filter((a) => a && normalizeName(a) !== normalizeName(name))
  const domain = input.domain ? domainPath(input.domain) || undefined : undefined
  const existing = findFact(k, input.kind, [name, ...aliases])
  if (!existing) {
    const fact: KnowledgeFact = {
      id: newId(),
      kind: input.kind,
      name,
      aliases,
      meaning,
      ...(sql ? { sql } : {}),
      tables: input.tables,
      ...(domain ? { domain } : {}),
      source: input.source,
      confidence: SOURCE_CONFIDENCE[input.source],
      uses: 0,
      createdAt: now,
      updatedAt: now,
      ...(input.question ? { learnedFrom: input.question } : {})
    }
    k.facts.push(fact)
    return { kind: 'added', fact }
  }
  // With SQL on both sides, the SQL says whether it is the same thing; otherwise the words do.
  const same = sql && existing.sql ? sameSqlKey(sql) === sameSqlKey(existing.sql) : overlap(meaning, existing.meaning) >= 0.6
  if (same) {
    if (SOURCE_RANK[input.source] >= SOURCE_RANK[existing.source]) {
      existing.meaning = meaning
      existing.source = input.source
    }
    if (sql && !existing.sql) existing.sql = sql
    existing.confidence = Math.max(existing.confidence, SOURCE_CONFIDENCE[input.source])
    existing.aliases = union(existing.aliases, aliases)
    existing.tables = union(existing.tables, input.tables)
    if (domain) existing.domain = domain
    existing.updatedAt = now
    return { kind: 'confirmed', fact: existing }
  }
  if (SOURCE_RANK[input.source] < SOURCE_RANK[existing.source]) return { kind: 'refused', fact: existing }
  existing.replaced = [{ meaning: existing.meaning, ...(existing.sql ? { sql: existing.sql } : {}), source: existing.source, at: now }, ...(existing.replaced ?? [])].slice(0, 5)
  existing.meaning = meaning
  if (sql) existing.sql = sql
  else delete existing.sql
  existing.tables = input.tables.length ? input.tables : existing.tables
  existing.aliases = union(existing.aliases, aliases)
  if (domain) existing.domain = domain
  existing.source = input.source
  existing.confidence = SOURCE_CONFIDENCE[input.source]
  existing.uses = 0
  existing.updatedAt = now
  if (input.question) existing.learnedFrom = input.question
  return { kind: 'corrected', fact: existing }
}

export type DomainOutcome = { kind: 'added' | 'updated'; domain: KnowledgeDomain } | { kind: 'refused'; domain: KnowledgeDomain }

/** Learns a domain or subdomain and the tables in it. Tables add up; a description from a weaker source is not taken. */
export function learnDomain(k: Knowledge, input: { path: string; description?: string; tables: string[]; source: KnowledgeSource }, now = Date.now()): DomainOutcome {
  const path = domainPath(input.path)
  const description = input.description?.replace(/\s+/g, ' ').trim() || undefined
  const existing = k.domains.find((d) => normalizeName(d.path) === normalizeName(path))
  if (!existing) {
    const domain: KnowledgeDomain = { path, ...(description ? { description } : {}), tables: input.tables, source: input.source, confidence: SOURCE_CONFIDENCE[input.source], createdAt: now, updatedAt: now }
    k.domains.push(domain)
    return { kind: 'added', domain }
  }
  const stronger = SOURCE_RANK[input.source] >= SOURCE_RANK[existing.source]
  if (!stronger && description && existing.description && overlap(description, existing.description) < 0.6 && !input.tables.some((t) => !existing.tables.includes(t))) {
    return { kind: 'refused', domain: existing }
  }
  if (description && (stronger || !existing.description)) existing.description = description
  existing.tables = union(existing.tables, input.tables)
  if (stronger) {
    existing.source = input.source
    existing.confidence = Math.max(existing.confidence, SOURCE_CONFIDENCE[input.source])
  }
  existing.updatedAt = now
  return { kind: 'updated', domain: existing }
}

export interface RunbookInput {
  name: string
  purpose: string
  sql: string
  params: RunbookParam[]
  tables: string[]
  domain?: string
  question?: string
  source: KnowledgeSource
}

/** Keeps a query in the runbook; the same query again (by its shape, or its name) updates the entry it has. */
export function keepInRunbook(k: Knowledge, input: RunbookInput, now = Date.now()): { kind: 'added' | 'updated'; entry: RunbookEntry } {
  const shape = analyzeSql(input.sql).shape
  const existing = k.runbook.find((r) => analyzeSql(r.sql).shape === shape || normalizeName(r.name) === normalizeName(input.name))
  const domain = input.domain ? domainPath(input.domain) || undefined : undefined
  if (existing) {
    existing.name = input.name
    existing.purpose = input.purpose || existing.purpose
    existing.sql = input.sql
    existing.params = input.params
    existing.tables = input.tables.length ? input.tables : existing.tables
    if (domain) existing.domain = domain
    if (input.question) existing.questions = [input.question, ...existing.questions.filter((q) => q !== input.question)].slice(0, 8)
    if (SOURCE_RANK[input.source] > SOURCE_RANK[existing.source]) existing.source = input.source
    existing.updatedAt = now
    return { kind: 'updated', entry: existing }
  }
  const entry: RunbookEntry = {
    id: `q${k.nextQuery++}`,
    name: input.name,
    purpose: input.purpose,
    sql: input.sql,
    params: input.params,
    questions: input.question ? [input.question] : [],
    tables: input.tables,
    ...(domain ? { domain } : {}),
    source: input.source,
    runs: 0,
    failures: 0,
    createdAt: now,
    updatedAt: now
  }
  k.runbook.push(entry)
  return { kind: 'added', entry }
}

/** A runbook query ran: it worked, or it did not. One that keeps failing drops out of what the model is shown. */
export function noteRunbookRun(k: Knowledge, id: string, ok: boolean, question?: string, now = Date.now()): void {
  const r = k.runbook.find((x) => x.id === id)
  if (!r) return
  if (ok) r.runs++
  else r.failures++
  r.lastRunAt = now
  if (ok && question) r.questions = [question, ...r.questions.filter((q) => q !== question)].slice(0, 8)
}

export interface QueryRun {
  sql: string
  /** Table keys it read. */
  tables: string[]
  /** Joins between table keys, as "a.x = b.y". */
  joins: { from: string; to: string; via: string }[]
  /** Values compared with columns, as "table.column". */
  values: { column: string; value: string }[]
  by: 'user' | 'model'
  question?: string
  ok: boolean
}

/** A statement ran: counted by its shape, with what it shows of how tables join and which values live where. */
export function recordQuery(k: Knowledge, run: QueryRun, now = Date.now()): void {
  const shape = analyzeSql(run.sql).shape
  const existing = k.queries.find((q) => q.shape === shape)
  if (existing) {
    existing.count++
    existing.lastAt = now
    if (run.ok) existing.sql = run.sql
    else existing.errors++
    existing.tables = run.tables.length ? run.tables : existing.tables
    if (run.question) existing.question = run.question
    if (run.by === 'user') existing.by = 'user'
  } else {
    k.queries.push({ shape, sql: run.sql, tables: run.tables, by: run.by, ...(run.question ? { question: run.question } : {}), count: 1, errors: run.ok ? 0 : 1, firstAt: now, lastAt: now })
  }
  if (!run.ok) return
  for (const j of run.joins) addLink(k, { from: j.from, to: j.to, kind: 'join', via: j.via }, now)
  for (const v of run.values) {
    const seen = k.values.find((x) => x.column === v.column && x.value.toLowerCase() === v.value.toLowerCase())
    if (seen) {
      seen.count++
      seen.lastAt = now
      seen.value = v.value
    } else k.values.push({ value: v.value, column: v.column, count: 1, lastAt: now })
  }
}

/** A link between two tables, counted again when it is seen again. A join is the same either way round. */
export function addLink(k: Knowledge, link: Pick<DataLink, 'from' | 'to' | 'kind' | 'via'>, now = Date.now()): void {
  const existing = k.links.find(
    (l) => l.kind === link.kind && l.via === link.via && ((l.from === link.from && l.to === link.to) || (link.kind === 'join' && l.from === link.to && l.to === link.from))
  )
  if (existing) {
    existing.count++
    existing.lastAt = now
  } else k.links.push({ ...link, count: 1, lastAt: now })
}

/** Facts an answer built on, that held up: used once more, and a little surer, up to what their source allows. */
export function reinforce(k: Knowledge, factIds: string[], amount: number, now = Date.now()): void {
  for (const f of k.facts) {
    if (!factIds.includes(f.id)) continue
    f.uses++
    f.lastUsedAt = now
    f.confidence = Math.min(CONFIDENCE_CEILING[f.source], f.confidence + amount)
  }
}

/** Undoes something learned: a correction goes back to what was known before; anything else is forgotten. */
export function forgetLearned(k: Knowledge, item: { kind: 'term' | 'rule' | 'domain' | 'query'; id: string; corrected?: boolean }): boolean {
  if (item.kind === 'domain') {
    const before = k.domains.length
    k.domains = k.domains.filter((d) => normalizeName(d.path) !== normalizeName(item.id))
    return k.domains.length < before
  }
  if (item.kind === 'query') {
    const before = k.runbook.length
    k.runbook = k.runbook.filter((r) => r.id !== item.id)
    return k.runbook.length < before
  }
  const fact = k.facts.find((f) => f.id === item.id)
  if (!fact) return false
  const previous = fact.replaced?.[0]
  if (item.corrected && previous) {
    fact.meaning = previous.meaning
    if (previous.sql) fact.sql = previous.sql
    else delete fact.sql
    fact.source = previous.source
    fact.confidence = SOURCE_CONFIDENCE[previous.source]
    fact.replaced = fact.replaced!.slice(1)
    return true
  }
  k.facts = k.facts.filter((f) => f.id !== item.id)
  return true
}
