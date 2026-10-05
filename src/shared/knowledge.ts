// Business knowledge: what the app learns about the business behind a database as it is used, so questions can be
// asked in the business's own words ("How have the Bullseye jobs done since June?") instead of the schema's. Kept per
// saved connection, on this computer. The agent records what it works out as it goes, without asking for a yes; an
// answer shows what was learned, and the user can forget it there.

/**
 * Where something learned came from, which says how far it is trusted: the user said so; the model checked it in the
 * data; the model read it from names alone; or the app grouped tables by their names and keys.
 */
export type KnowledgeSource = 'user' | 'data' | 'inferred' | 'structure'

/** How sure a fact is when it is learned, by where it came from. Answers built on it that the user runs add to it. */
export const SOURCE_CONFIDENCE: Record<KnowledgeSource, number> = { user: 0.95, data: 0.8, inferred: 0.55, structure: 0.4 }

/** How far use alone can take a fact: something unchecked never becomes as sure as something checked or told. */
export const CONFIDENCE_CEILING: Record<KnowledgeSource, number> = { user: 0.99, data: 0.95, inferred: 0.75, structure: 0.6 }

/** Which sources can replace a fact from another: what the user said gives way only to the user. */
export const SOURCE_RANK: Record<KnowledgeSource, number> = { structure: 0, inferred: 1, data: 2, user: 3 }

/** A word or phrase the business uses, or a rule it follows, and what it means in this database. */
export interface KnowledgeFact {
  id: string
  kind: 'term' | 'rule'
  /** The term as the business says it ("active member"); a rule's short title. */
  name: string
  /** Other ways of saying it. */
  aliases: string[]
  /** What it means here, in a sentence or two. */
  meaning: string
  /** For a term that picks out data: the SQL condition or expression for it, written with table names. */
  sql?: string
  /** The tables (keys as the schema index has them) it involves. */
  tables: string[]
  /** The domain it belongs to, by path. */
  domain?: string
  source: KnowledgeSource
  /** 0 to 1. */
  confidence: number
  /** Answers built on it. */
  uses: number
  lastUsedAt?: number
  createdAt: number
  updatedAt: number
  /** What it meant before it was corrected, the latest first. */
  replaced?: { meaning: string; sql?: string; source: KnowledgeSource; at: number }[]
  /** The question it was learned while answering. */
  learnedFrom?: string
}

/** A part of the business and the tables that hold it: "Marketing", or "Marketing › Programs" for a subdomain. */
export interface KnowledgeDomain {
  /** Its name, with the names of the domains above it first, joined by " › ". */
  path: string
  description?: string
  tables: string[]
  source: KnowledgeSource
  confidence: number
  createdAt: number
  updatedAt: number
}

export interface RunbookParam {
  name: string
  description?: string
  /** The value it had in the question the query was saved from. */
  example?: string
}

/** A query that answered a business question, kept with :parameters for the values that change: a runbook entry. */
export interface RunbookEntry {
  /** Short, for the model to call it by: "q1", "q2". */
  id: string
  name: string
  /** The business question it answers, in the business's words. */
  purpose: string
  /** Read-only SQL with :name parameters. */
  sql: string
  params: RunbookParam[]
  /** Questions it answered, as they were asked, the latest first. */
  questions: string[]
  tables: string[]
  domain?: string
  source: KnowledgeSource
  runs: number
  failures: number
  lastRunAt?: number
  createdAt: number
  updatedAt: number
}

/** A statement run on the database, by its shape: what the team asks of it, and the raw material learning works from. */
export interface QueryRecord {
  /** The statement with its literals taken out: the same query with other values has the same shape. */
  shape: string
  /** The latest run of it, values and all. */
  sql: string
  tables: string[]
  /** Who wrote it: the user, in the editor, or the model. */
  by: 'user' | 'model'
  /** The business question it answered, when it came from Ask. */
  question?: string
  count: number
  errors: number
  firstAt: number
  lastAt: number
}

/**
 * How data moves between two tables: they are joined on columns in queries; a trigger or function on one writes the
 * other; or a view or function reads one to make the other.
 */
export interface DataLink {
  from: string
  to: string
  kind: 'join' | 'writes' | 'feeds'
  /** "orders.user_id = users.id", "trigger orders_touch_user", "view order_summary". */
  via: string
  count: number
  lastAt: number
}

/** A value queries compared a column with: how a name in a question finds the table it lives in. */
export interface SeenValue {
  value: string
  /** "table.column", with the table's key. */
  column: string
  count: number
  lastAt: number
}

export interface Knowledge {
  version: 1
  facts: KnowledgeFact[]
  domains: KnowledgeDomain[]
  runbook: RunbookEntry[]
  queries: QueryRecord[]
  links: DataLink[]
  values: SeenValue[]
  /** Tables whose triggers, and views whose definitions, were read for how data moves, with when. */
  scanned: Record<string, number>
  /** The number of the next runbook entry. */
  nextQuery: number
}

export function emptyKnowledge(): Knowledge {
  return { version: 1, facts: [], domains: [], runbook: [], queries: [], links: [], values: [], scanned: {}, nextQuery: 1 }
}

/** Something learned while answering, as the answer shows it. Forgetting it undoes it: a correction goes back. */
export interface AiLearned {
  kind: 'term' | 'rule' | 'domain' | 'query'
  /** The fact's id, the domain's path or the runbook entry's id. */
  id: string
  /** The saved connection it was learned for. */
  connectionId: string
  name: string
  meaning: string
  /** It replaced what was known before rather than adding to it. */
  corrected?: boolean
}

/** A name as it is compared: case, spacing and quotes do not matter. */
export function normalizeName(name: string): string {
  return name
    .replace(/[“”"'`‘’]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** A domain path as it is kept: each part trimmed, joined by " › " whatever separator was written. */
export function domainPath(raw: string): string {
  return raw
    .split(/\s*(?:›|>|\/|::)\s*/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' › ')
}

/** The words to tell the model how far to trust something. */
export function trustLabel(source: KnowledgeSource, uses = 0): string {
  const used = uses > 0 ? `, used ${uses} time${uses === 1 ? '' : 's'}` : ''
  if (source === 'user') return `told by the user${used}`
  if (source === 'data') return `checked in the data${used}`
  if (source === 'inferred') return `unchecked${used}`
  return 'grouped by names and keys'
}
