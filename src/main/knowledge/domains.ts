// The parts of the business a database's tables fall into. Domains the model or the user named come first; the
// tables left over are grouped by structure (their schema, the words their names start with, and the foreign keys
// between them) so even an unfamiliar schema has an outline. Everything attached to a table belongs where it does:
// its columns, keys, indexes and triggers, the functions and views that read or write it, and the queries run on it.
import { normalizeName, SOURCE_RANK, type Knowledge, type KnowledgeSource } from '@shared/knowledge'
import type { SchemaIndex } from '../ai/schema-index'

export interface DomainEntry {
  path: string
  description?: string
  tables: string[]
  source: KnowledgeSource
}

export interface DomainMap {
  domains: DomainEntry[]
  /** The domains a table is in: learned ones first, the most specific of them first. */
  of(tableKey: string): DomainEntry[]
}

/** Below this many tables, an outline from names says little that the schema does not. */
const STRUCTURE_FROM = 20
/** A group larger than this splits by the first two words of its names. */
const SPLIT_OVER = 30

/** The words a table name is made of: snake_case, camelCase and digits apart, lowercased, crude singulars. */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+|(?<=[A-Za-z])(?=\d)/)
    .map((w) => w.toLowerCase())
    .filter((w) => w && !/^\d+$/.test(w) && !['tbl', 'tb', 't'].includes(w))
    .map((w) => (w.length > 3 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
}

export function domainMap(index: SchemaIndex, k: Knowledge): DomainMap {
  const learned: DomainEntry[] = k.domains
    .map((d) => ({ path: d.path, ...(d.description ? { description: d.description } : {}), tables: d.tables.filter((t) => index.tables.has(t)), source: d.source }))
    .filter((d) => d.tables.length || d.description)
  const covered = new Set(learned.flatMap((d) => d.tables))
  const structural: DomainEntry[] = []
  if (index.tables.size >= STRUCTURE_FROM) {
    const schemas = new Set([...index.tables.values()].map((t) => t.ref.schema ?? ''))
    const bySchema = schemas.size > 1
    // Group by the first word of the name, within each schema; a big group by its first two.
    const groups = new Map<string, string[]>()
    const firstWords = new Map<string, number>()
    const words = new Map<string, string[]>()
    for (const t of index.tables.values()) {
      if (covered.has(t.key)) continue
      const w = nameWords(t.ref.name)
      words.set(t.key, w)
      const scope = bySchema ? (t.ref.schema ?? '') : ''
      firstWords.set(`${scope}\u0000${w[0] ?? ''}`, (firstWords.get(`${scope}\u0000${w[0] ?? ''}`) ?? 0) + 1)
    }
    const groupOf = new Map<string, string>()
    for (const t of index.tables.values()) {
      const w = words.get(t.key)
      if (!w) continue
      const scope = bySchema ? (t.ref.schema ?? '') : ''
      const first = w[0] ?? ''
      const big = (firstWords.get(`${scope}\u0000${first}`) ?? 0) > SPLIT_OVER && w.length > 2
      const key = `${scope}\u0000${big ? w.slice(0, 2).join(' ') : first}`
      groupOf.set(t.key, key)
      groups.set(key, [...(groups.get(key) ?? []), t.key])
    }
    // A table alone in its group joins the group its foreign keys lead to most.
    for (const [key, members] of [...groups]) {
      if (members.length !== 1) continue
      const t = index.tables.get(members[0])!
      const votes = new Map<string, number>()
      for (const n of t.neighbors) {
        const g = groupOf.get(n)
        if (g && g !== key && (groups.get(g)?.length ?? 0) > 1) votes.set(g, (votes.get(g) ?? 0) + 1)
      }
      const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]
      if (!best) continue
      groups.delete(key)
      groups.get(best[0])!.push(members[0])
      groupOf.set(members[0], best[0])
    }
    for (const [key, members] of groups) {
      if (members.length < 2) continue
      const [scope, label] = key.split('\u0000')
      const path = bySchema && scope ? (label ? `${scope} › ${label}` : scope) : label
      if (!path) continue
      structural.push({ path, tables: members.sort(), source: 'structure' })
    }
  }
  const domains = [...learned, ...structural]
  const byTable = new Map<string, DomainEntry[]>()
  for (const d of domains) for (const t of d.tables) byTable.set(t, [...(byTable.get(t) ?? []), d])
  for (const list of byTable.values()) {
    list.sort((a, b) => SOURCE_RANK[b.source] - SOURCE_RANK[a.source] || b.path.split(' › ').length - a.path.split(' › ').length || a.path.localeCompare(b.path))
  }
  return { domains, of: (key) => byTable.get(key) ?? [] }
}

/** The domain a path names, matched loosely. */
export function findDomain(map: DomainMap, path: string): DomainEntry | undefined {
  const wanted = normalizeName(path)
  return map.domains.find((d) => normalizeName(d.path) === wanted)
}
