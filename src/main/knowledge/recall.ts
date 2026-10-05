// Recall: what is known about the business that bears on a question, found locally (no model call), for the prompt.
// A term the question uses, a value it names that earlier queries compared with a column, a runbook query that
// answered something like it, the domains and data movement around the tables they point at, and queries the team
// ran there. The tables it points at are put in front of the model even when the question never names them.
import { normalizeName, trustLabel, type DataLink, type Knowledge, type KnowledgeFact, type QueryRecord, type RunbookEntry } from '@shared/knowledge'
import { Bm25, tokenize, type SchemaIndex } from '../ai/schema-index'
import type { DomainEntry, DomainMap } from './domains'

export interface Recall {
  terms: KnowledgeFact[]
  rules: KnowledgeFact[]
  /** Values in the question that earlier queries compared with a column. */
  values: { value: string; column: string }[]
  runbook: RunbookEntry[]
  domains: DomainEntry[]
  flows: DataLink[]
  examples: QueryRecord[]
  /** The other parts of the database, by top-level domain, with how many tables each has. */
  overview: { name: string; tables: number }[]
  /** Table keys the question points at through what is known, the strongest first. */
  tables: string[]
}

const MAX_TERMS = 10
const MAX_RULES = 6
const MAX_VALUES = 8
const MAX_RUNBOOK = 3
const MAX_DOMAINS = 4
const MAX_FLOWS = 8
const MAX_EXAMPLES = 2
const MAX_SEEDS = 10
/** The section's size in characters: about 1,500 tokens. */
const MAX_CHARS = 6000

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether the text holds the phrase as words of its own, not inside other words. */
function hasPhrase(text: string, phrase: string): boolean {
  if (phrase.length < 2) return false
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegex(phrase)}($|[^\\p{L}\\p{N}_])`, 'iu').test(text)
}

/** How well a term's names match the question: its name as a phrase, then its words. */
function termScore(f: KnowledgeFact, text: string, words: Set<string>): number {
  let best = 0
  for (const name of [f.name, ...f.aliases]) {
    const n = normalizeName(name)
    if (!n) continue
    if (hasPhrase(text, n)) {
      best = Math.max(best, 10)
      continue
    }
    const own = [...new Set(tokenize(n))].filter((w) => w.length > 2)
    if (!own.length) continue
    const hit = own.filter((w) => words.has(w)).length
    if (hit === own.length) best = Math.max(best, 6)
    else if (hit) best = Math.max(best, (4 * hit) / own.length)
  }
  return best * (0.5 + f.confidence)
}

function weight(count: number, at: number, now: number): number {
  return Math.log2(1 + count) * Math.pow(0.5, Math.max(0, now - at) / (30 * 86_400_000))
}

const tableOf = (column: string) => column.slice(0, column.lastIndexOf('.'))

export function recall(k: Knowledge, map: DomainMap, question: string, index: SchemaIndex, now = Date.now()): Recall {
  const text = normalizeName(question)
  const words = new Set(tokenize(question))
  const known = (key: string) => index.tables.has(key)
  const seeds = new Map<string, number>()
  const seed = (key: string, score: number) => {
    if (known(key)) seeds.set(key, Math.max(seeds.get(key) ?? 0, score))
  }

  const terms = k.facts
    .filter((f) => f.kind === 'term')
    .map((f) => ({ f, score: termScore(f, text, words) }))
    .filter((x) => x.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_TERMS)
    .map((x) => x.f)
  for (const f of terms) for (const t of f.tables) seed(t, 10)

  // Rules are standing conventions: the ones the question touches, then the most trusted and used of the rest.
  const rules = k.facts
    .filter((f) => f.kind === 'rule')
    .map((f) => {
      const own = new Set(tokenize(`${f.name} ${f.meaning}`))
      let hit = 0
      for (const w of words) if (own.has(w)) hit++
      return { f, score: hit * 10 + f.confidence * 5 + weight(f.uses + 1, f.lastUsedAt ?? f.updatedAt, now) }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RULES)
    .map((x) => x.f)

  const values = k.values
    .filter((v) => v.value.length >= 3 && known(tableOf(v.column)) && hasPhrase(text, v.value.toLowerCase()))
    .sort((a, b) => weight(b.count, b.lastAt, now) - weight(a.count, a.lastAt, now))
    .slice(0, MAX_VALUES)
    .map((v) => ({ value: v.value, column: v.column }))
  for (const v of values) seed(tableOf(v.column), 9)

  // The runbook: an entry whose name, purpose, questions and parameters share enough of the question's words, ranked
  // like documents, so the rarer words count for more.
  const usable = k.runbook.filter((r) => !(r.failures >= 3 && r.failures > r.runs))
  const docs = usable.map((r) => ({
    r,
    tokens: tokenize([r.name, r.purpose, ...r.questions, ...r.params.map((p) => `${p.name} ${p.description ?? ''}`), ...r.tables].join(' '))
  }))
  const ranked = new Bm25(docs.map((d) => ({ id: d.r.id, tokens: d.tokens }))).score([...words])
  const asked = [...words].filter((w) => w.length >= 3)
  const runbook = docs
    .map((d) => {
      const own = new Set(d.tokens)
      const hits = asked.filter((w) => own.has(w)).length
      return { r: d.r, hits, coverage: asked.length ? hits / asked.length : 0 }
    })
    .filter((x) => x.hits >= 2 && x.coverage >= 0.3)
    .sort((a, b) => (ranked.get(b.r.id) ?? 0) - (ranked.get(a.r.id) ?? 0) || b.hits - a.hits || b.r.runs - a.r.runs)
    .slice(0, MAX_RUNBOOK)
    .map((x) => x.r)
  for (const r of runbook) for (const t of r.tables) seed(t, 8)

  // Domains the question names, and those holding the tables it points at.
  const domainScore = new Map<DomainEntry, number>()
  for (const d of map.domains) {
    const own = new Set(tokenize(`${d.path} ${d.description ?? ''}`))
    let hit = 0
    for (const w of words) if (own.has(w)) hit++
    const holds = d.tables.filter((t) => seeds.has(t)).length
    const score = hit * 3 + holds * 2 + (d.source === 'structure' ? 0 : 1)
    if (hit || holds) domainScore.set(d, score)
  }
  const domains = [...domainScore.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_DOMAINS)
    .map(([d]) => d)
  for (const d of domains) {
    // A domain the question names brings its tables, not too many of them.
    if ((domainScore.get(d) ?? 0) >= 3) for (const t of d.tables.slice(0, 6)) seed(t, 5)
  }

  const inPlay = new Set(seeds.keys())
  const flows = k.links
    .filter((l) => inPlay.has(l.from) || inPlay.has(l.to))
    .sort((a, b) => (a.kind === 'join' ? 1 : 0) - (b.kind === 'join' ? 1 : 0) || weight(b.count, b.lastAt, now) - weight(a.count, a.lastAt, now))
    .slice(0, MAX_FLOWS)

  const runbookShapes = new Set(runbook.map((r) => r.sql))
  const examples = k.queries
    .filter((q) => q.errors < q.count && q.tables.some((t) => inPlay.has(t)) && !runbookShapes.has(q.sql))
    .map((q) => ({ q, score: q.tables.filter((t) => inPlay.has(t)).length + weight(q.count, q.lastAt, now) + (q.question ? 1 : 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_EXAMPLES)
    .map((x) => x.q)

  const shownTop = new Set(domains.map((d) => d.path.split(' › ')[0]))
  const sizes = new Map<string, Set<string>>()
  for (const d of map.domains) {
    const name = d.path.split(' › ')[0]
    if (shownTop.has(name)) continue
    const set = sizes.get(name) ?? new Set<string>()
    for (const t of d.tables) set.add(t)
    sizes.set(name, set)
  }
  const overview = [...sizes.entries()]
    .map(([name, set]) => ({ name, tables: set.size }))
    .filter((o) => o.tables > 0)
    .sort((a, b) => b.tables - a.tables || a.name.localeCompare(b.name))
    .slice(0, 12)

  const tables = [...seeds.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SEEDS)
    .map(([key]) => key)
  return { terms, rules, values, runbook, domains, flows, examples, overview, tables }
}

export function recallSize(r: Recall): { terms: number; rules: number; runbook: number; tables: number } {
  return { terms: r.terms.length + r.values.length, rules: r.rules.length, runbook: r.runbook.length, tables: r.tables.length }
}

export function isEmptyRecall(r: Recall): boolean {
  return !r.terms.length && !r.rules.length && !r.values.length && !r.runbook.length && !r.domains.length && !r.flows.length && !r.examples.length && !r.overview.length
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

function flowLine(l: DataLink): string {
  if (l.kind === 'join') return `${l.from} and ${l.to} are joined on ${l.via}${l.count > 1 ? ` (${l.count} queries)` : ''}`
  if (l.kind === 'writes') return `${l.from} → ${l.to}: written by ${l.via}`
  return `${l.from} → ${l.to}: read by ${l.via}`
}

/**
 * The prompt section. `title` names the database in a chat across several. Long parts are cut so the whole stays
 * within about 1,500 tokens.
 */
export function renderRecall(r: Recall, opts: { title?: string; runSaved: boolean }): string {
  if (isEmptyRecall(r)) return ''
  const out: string[] = [
    `## What this team means${opts.title ? ` on ${opts.title}` : ''}`,
    'Learned from earlier questions and queries on this database, on this computer. Read the question in these terms first.'
  ]
  let size = out.join('\n').length
  const add = (lines: string[]) => {
    const text = lines.join('\n')
    if (size + text.length > MAX_CHARS) return false
    out.push(...lines)
    size += text.length + 1
    return true
  }
  if (r.terms.length) {
    const lines = ['', 'Terms:']
    for (const f of r.terms) {
      const also = f.aliases.length ? ` (also "${f.aliases.slice(0, 3).join('", "')}")` : ''
      lines.push(`- "${f.name}"${also}, ${trustLabel(f.source, f.uses)}: ${clip(oneLine(f.meaning), 300)}${f.sql ? ` SQL: ${clip(oneLine(f.sql), 300)}` : ''}`)
    }
    add(lines)
  }
  if (r.values.length) add(['', 'Values in the question that earlier queries compared with a column:', ...r.values.map((v) => `- '${v.value}' in ${v.column}`)])
  if (r.rules.length) add(['', 'Rules:', ...r.rules.map((f) => `- ${f.name}, ${trustLabel(f.source, f.uses)}: ${clip(oneLine(f.meaning), 300)}`)])
  if (r.runbook.length) {
    const lines = ['', opts.runSaved ? 'Runbook (run_saved_query with the id and values, or use the SQL in propose_query):' : 'Runbook (use the SQL in propose_query, with the values filled in):']
    for (const q of r.runbook) {
      const params = q.params.length ? `(${q.params.map((p) => `${p.name}${p.description ? `: ${p.description}` : ''}`).join('; ')})` : '(no parameters)'
      lines.push(`- ${q.id} "${q.name}" ${params}${q.runs ? `, run ${q.runs} time${q.runs === 1 ? '' : 's'}` : ''}: ${clip(oneLine(q.purpose), 200)}`, `  SQL: ${clip(oneLine(q.sql), 700)}`)
    }
    add(lines)
  }
  if (r.domains.length) {
    add([
      '',
      'Domains:',
      ...r.domains.map((d) => {
        const tables = d.tables.length > 15 ? `${d.tables.slice(0, 15).join(', ')} and ${d.tables.length - 15} more` : d.tables.join(', ')
        return `- ${d.path}, ${trustLabel(d.source)}${d.description ? `: ${clip(oneLine(d.description), 200).replace(/[.\s]+$/, '')}` : ''}. Tables: ${tables}`
      })
    ])
  }
  if (r.flows.length) add(['', 'How data moves:', ...r.flows.map((l) => `- ${flowLine(l)}`)])
  if (r.examples.length) {
    add([
      '',
      'Earlier queries on these tables:',
      ...r.examples.map((q) => `- ${q.count > 1 ? `run ${q.count} times` : 'run once'}${q.question ? `, for "${clip(oneLine(q.question), 120)}"` : ''}: ${clip(oneLine(q.sql), 500)}`)
    ])
  }
  if (r.overview.length) add(['', `Other parts of this database: ${r.overview.map((o) => `${o.name} (${o.tables} table${o.tables === 1 ? '' : 's'})`).join(', ')}`])
  return out.join('\n')
}

/** What describe_table adds about a table: its domain, the terms and runbook queries on it, and how data moves there. */
export function tableNotes(k: Knowledge, map: DomainMap, key: string): string[] {
  const lines: string[] = []
  const domains = map.of(key)
  if (domains.length) lines.push(`domain: ${domains.slice(0, 2).map((d) => d.path).join('; ')}`)
  const terms = k.facts.filter((f) => f.kind === 'term' && f.tables.includes(key)).slice(0, 6)
  if (terms.length) lines.push(`terms: ${terms.map((f) => `"${f.name}"${f.sql ? ` (${clip(oneLine(f.sql), 120)})` : ''}`).join('; ')}`)
  const runbook = k.runbook.filter((r) => r.tables.includes(key)).slice(0, 4)
  if (runbook.length) lines.push(`runbook: ${runbook.map((r) => `${r.id} "${r.name}"`).join('; ')}`)
  const flows = k.links
    .filter((l) => l.from === key || l.to === key)
    .sort((a, b) => (a.kind === 'join' ? 1 : 0) - (b.kind === 'join' ? 1 : 0) || b.count - a.count)
    .slice(0, 6)
  if (flows.length) lines.push(`data flow: ${flows.map(flowLine).join('; ')}`)
  return lines
}
