// Completion for the SQL editor that follows the shape of the statement: table names after FROM and
// JOIN, column names after SELECT, WHERE and the like, and keywords only where one can follow. Works
// from the name index (so it scales to huge schemas) and loads a table's columns the first time they
// are needed. Also home to the keyword re-casing and table aliasing applied as words are finished.
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'

export interface TableEntry {
  schema?: string
  name: string
  kind: 'table' | 'view'
}

export type KeywordCase = 'upper' | 'lower' | 'off'

/** How the editor behaves while typing; kept in the app's preferences. */
export interface EditorPrefs {
  keywordCase: KeywordCase
  autocomplete: boolean
  autoAlias: boolean
  /** Keys that take the highlighted suggestion; any of ACCEPT_KEY_OPTIONS, possibly none. */
  acceptKeys: string[]
}

/** Keys a user may pick for accepting a suggestion, as CodeMirror names them. */
export const ACCEPT_KEY_OPTIONS: { key: string; label: string }[] = [
  { key: 'Tab', label: 'Tab' },
  { key: 'Enter', label: 'Enter' },
  { key: 'ArrowRight', label: 'Right arrow' }
]

export const DEFAULT_EDITOR_PREFS: EditorPrefs = { keywordCase: 'upper', autocomplete: true, autoAlias: false, acceptKeys: ['Tab', 'Enter'] }

export interface CompletionData {
  tables: TableEntry[]
  defaultSchema?: string
  dialect?: 'sqlite' | 'postgres'
  prefs?: EditorPrefs
  /** Column names when already known. */
  columnsFor(ref: TableEntry): string[] | undefined
  /** Fetch columns on demand; resolves to [] when the table cannot be described. */
  loadColumns(ref: TableEntry): Promise<string[]>
}

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

/** What can start a statement. */
const STATEMENT_KEYWORDS = [
  'SELECT', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'WITH', 'CREATE TABLE', 'CREATE INDEX', 'CREATE VIEW', 'ALTER TABLE', 'DROP TABLE', 'DROP INDEX', 'DROP VIEW', 'EXPLAIN', 'BEGIN', 'COMMIT', 'ROLLBACK', 'VALUES'
]
/** What can follow a finished name, value or clause. */
const CLAUSE_KEYWORDS = [
  'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS NULL', 'IS NOT NULL', 'LIKE', 'BETWEEN', 'EXISTS', 'NOT EXISTS', 'AS', 'ON', 'USING', 'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'OUTER JOIN',
  'ORDER BY', 'GROUP BY', 'PARTITION BY', 'BY', 'HAVING', 'LIMIT', 'OFFSET', 'ASC', 'DESC', 'UNION', 'UNION ALL', 'EXCEPT', 'INTERSECT', 'DISTINCT', 'SET', 'VALUES', 'RETURNING',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'OVER', 'NULL', 'TRUE', 'FALSE', 'DEFAULT', 'INTO', 'TABLE', 'INDEX', 'VIEW', 'KEY', 'IF EXISTS', 'IF NOT EXISTS', 'PRIMARY KEY', 'NOT NULL', 'UNIQUE', 'REFERENCES'
]
const DIALECT_KEYWORDS: Record<'sqlite' | 'postgres', string[]> = {
  postgres: ['ILIKE', 'NULLS FIRST', 'NULLS LAST', 'FOR UPDATE', 'TRUNCATE TABLE'],
  sqlite: ['GLOB', 'PRAGMA', 'REPLACE INTO', 'WITHOUT ROWID']
}
/** Offered among columns once a couple of letters are typed. */
const FUNCTIONS = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'CAST', 'ROUND', 'ABS', 'LOWER', 'UPPER', 'LENGTH', 'SUBSTR', 'TRIM', 'NULLIF', 'CURRENT_DATE', 'CURRENT_TIMESTAMP']

/** Every word that is re-cased as a keyword. Words that are commonly column names (date, key, first…) are left out on purpose. */
export const KEYWORD_WORDS: Set<string> = new Set(
  [...STATEMENT_KEYWORDS, ...CLAUSE_KEYWORDS, ...DIALECT_KEYWORDS.postgres, ...DIALECT_KEYWORDS.sqlite]
    .flatMap((k) => k.toLowerCase().split(' '))
    .concat('insert delete create drop alter truncate outer left right inner cross natural group order partition primary foreign references constraint collate cascade restrict transaction recursive all any some exists window fetch next only for share nowait lateral'.split(' '))
)

// ---------------------------------------------------------------------------
// Reading the statement
// ---------------------------------------------------------------------------

/** Words that can follow a table reference and are therefore never aliases. */
const NOT_ALIAS = new Set(
  'where on join left right inner outer cross full natural using group order limit offset set values select having union except intersect window with as returning into from and or not in is null asc desc fetch for update share nowait lateral tablesample'.split(' ')
)
const IDENT = String.raw`(?:"[^"]+"|[\w$]+)`
const REF_RE = new RegExp(String.raw`\b(from|join|update|into|table|,)\s*(${IDENT}(?:\.${IDENT})?)(?:\s+(?:as\s+)?([\w$]+))?`, 'gi')

function unquote(s: string): string {
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s
}

export function tableDisplay(t: TableEntry, defaultSchema?: string): string {
  return t.schema && t.schema !== defaultSchema ? `${t.schema}.${t.name}` : t.name
}

/** Find a table by `name` or `schema.name`, case-insensitively, preferring the default schema. */
export function findTable(data: CompletionData, ident: string): TableEntry | undefined {
  const parts = ident.split('.').map(unquote)
  const name = parts[parts.length - 1].toLowerCase()
  const schema = parts.length > 1 ? parts[parts.length - 2].toLowerCase() : null
  let fallback: TableEntry | undefined
  for (const t of data.tables) {
    if (t.name.toLowerCase() !== name) continue
    const s = (t.schema ?? '').toLowerCase()
    if (schema !== null) {
      if (s === schema) return t
      continue
    }
    if (!t.schema || t.schema === data.defaultSchema) return t
    fallback ??= t
  }
  return fallback
}

export interface References {
  /** Lowercased alias or table name -> table. */
  byAlias: Map<string, TableEntry>
  /** Tables in the order they appear. */
  tables: { alias: string; table: TableEntry }[]
}

/** Tables named in FROM, JOIN, UPDATE and INTO clauses, with their aliases. */
export function referencedTables(doc: string, data: CompletionData): References {
  const byAlias = new Map<string, TableEntry>()
  const tables: { alias: string; table: TableEntry }[] = []
  for (const m of doc.matchAll(REF_RE)) {
    const table = findTable(data, m[2])
    if (!table) continue
    const alias = m[3] && !NOT_ALIAS.has(m[3].toLowerCase()) ? m[3] : table.name
    if (!tables.some((r) => r.table === table && r.alias === alias)) tables.push({ alias, table })
    byAlias.set(alias.toLowerCase(), table)
    byAlias.set(table.name.toLowerCase(), table)
  }
  return { byAlias, tables }
}

/** The statement around a position: the blank-line-separated block, cut at semicolons. */
export function statementAt(doc: string, pos: number): { text: string; start: number } {
  const lines = doc.split('\n')
  const blank = (i: number) => lines[i].trim() === ''
  let offset = 0
  let cur = 0
  for (let i = 0; i < lines.length; i++) {
    const end = offset + lines[i].length
    if (pos <= end || i === lines.length - 1) {
      cur = i
      break
    }
    offset = end + 1
  }
  let first = cur
  let last = cur
  if (!blank(cur)) {
    while (first > 0 && !blank(first - 1)) first--
    while (last < lines.length - 1 && !blank(last + 1)) last++
  }
  let blockStart = 0
  for (let i = 0; i < first; i++) blockStart += lines[i].length + 1
  const block = lines.slice(first, last + 1).join('\n')
  const rel = Math.max(0, Math.min(block.length, pos - blockStart))
  const lastSemi = rel > 0 ? block.lastIndexOf(';', rel - 1) : -1
  const nextSemi = block.indexOf(';', rel)
  const start = blockStart + lastSemi + 1
  const end = nextSemi < 0 ? blockStart + block.length : blockStart + nextSemi
  return { text: doc.slice(start, end), start }
}

/** Strings and comments replaced so their contents never look like SQL. */
function cleanSql(s: string): string {
  return s
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''")
}

/** True when the position is inside an unfinished string, a line comment or an unclosed block comment. */
export function inStringOrComment(before: string): boolean {
  const noBlocks = before.replace(/\/\*[\s\S]*?\*\//g, ' ')
  if (noBlocks.includes('/*')) return true
  const noStrings = noBlocks.replace(/'(?:[^']|'')*'/g, "''").replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''")
  const lastLine = noStrings.slice(noStrings.lastIndexOf('\n') + 1)
  if (lastLine.includes('--')) return true
  return (noStrings.match(/'/g) ?? []).length % 2 === 1
}

const TOKEN_RE = /"[^"]*"|`[^`]*`|\[[^\]]*\]|''|[\w$]+|<>|!=|<=|>=|\|\||::|[.,()*;=<>+\-/]/g

export function tokensOf(sql: string): string[] {
  return cleanSql(sql).match(TOKEN_RE) ?? []
}

export type CompletionMode = 'statement' | 'tables' | 'columns' | 'keywords' | 'none'

export interface Situation {
  mode: CompletionMode
  /** A subquery could start here too, so statement keywords are offered as well. */
  alsoStatements: boolean
  /** The clause the cursor is in, e.g. "from" or "where". */
  clause: string | null
  /** Inside parentheses opened within the clause. */
  inParens: boolean
  lastToken: string | null
  /** The only words that fit here, e.g. NULL after IS NOT. */
  only?: string[]
}

const CLAUSE_WORDS = new Set('select from where join on set by having into update values using returning limit offset when then else case'.split(' '))
const TABLE_INTRO = new Set(['from', 'join', 'into', 'update', 'table'])
const COLUMN_INTRO = new Set(['select', 'distinct', 'where', 'and', 'or', 'not', 'on', 'by', 'having', 'set', 'when', 'then', 'else', 'case', 'returning', 'like', 'ilike', 'glob', 'between', '=', '<>', '!=', '<', '>', '<=', '>=', '+', '-', '/', '||', 'any', 'some', 'filter'])
const NOTHING_AFTER = new Set(['as', 'limit', 'offset', 'fetch', 'with', 'recursive', 'in', 'exists', 'using', 'values', 'over', 'window', '::', 'transaction'])
const KEYWORD_AFTER = new Set(['insert', 'delete', 'create', 'drop', 'alter', 'truncate', 'left', 'right', 'inner', 'full', 'cross', 'natural', 'outer', 'primary', 'foreign', 'if', 'group', 'order', 'partition', 'null', 'true', 'false', 'asc', 'desc', 'end', ')', "''", 'default', 'unique'])

/** What the word at the cursor could be, judged from the tokens before it within the statement. */
export function situationBefore(before: string): Situation {
  const toks = tokensOf(before)
  const last = toks.length ? toks[toks.length - 1].toLowerCase() : null
  const prev = toks.length > 1 ? toks[toks.length - 2].toLowerCase() : null
  let depth = 0
  let clause: string | null = null
  let inParens = false
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i].toLowerCase()
    if (t === ')') {
      depth++
      continue
    }
    if (t === '(') {
      if (depth === 0) inParens = true
      else depth--
      continue
    }
    if (depth > 0) continue
    if (t === ';') break
    if (CLAUSE_WORDS.has(t)) {
      clause = t
      break
    }
  }
  const sit = (mode: CompletionMode, alsoStatements = false, only?: string[]): Situation => ({ mode, alsoStatements, clause, inParens, lastToken: last, ...(only ? { only } : {}) })
  if (last === null || last === ';') return sit('statement')
  // After IS and IS NOT only a null or boolean test can follow.
  if (last === 'is') return sit('keywords', false, ['NULL', 'NOT NULL', 'TRUE', 'FALSE', 'DISTINCT FROM'])
  if (last === 'not' && prev === 'is') return sit('keywords', false, ['NULL', 'TRUE', 'FALSE', 'DISTINCT FROM'])
  if (last === 'all') return ['union', 'except', 'intersect'].includes(prev ?? '') ? sit('statement') : sit('columns')
  if (['union', 'except', 'intersect', 'explain'].includes(last)) return sit('statement')
  if (TABLE_INTRO.has(last)) return sit('tables')
  if (last === ',') {
    if (!inParens && (clause === 'from' || clause === 'update')) return sit('tables')
    if (clause === 'values') return sit('none')
    return sit('columns')
  }
  if (last === '(') {
    if (clause === 'values') return sit('none')
    if (clause === 'into') return sit('columns')
    return sit('columns', true)
  }
  if (last === '*') return prev && /^[\w$")]/.test(prev) && !['select', 'distinct', ','].includes(prev) ? sit('columns') : sit('keywords')
  if (COLUMN_INTRO.has(last)) return sit('columns')
  if (NOTHING_AFTER.has(last)) return sit('none')
  if (KEYWORD_AFTER.has(last)) return sit('keywords')
  return sit('keywords')
}

// ---------------------------------------------------------------------------
// Aliases and casing
// ---------------------------------------------------------------------------

/** A short alias for a table: initials of its words, kept unique among the aliases already used. */
export function aliasFor(name: string, taken: Iterable<string> = []): string {
  const used = new Set([...taken].map((a) => a.toLowerCase()))
  const words = unquote(name).split(/[_\s-]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean)
  let base = (words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? 't').slice(0, 1)).toLowerCase()
  if (!/^[a-z]/.test(base)) base = 't'
  let alias = base
  for (let n = 2; used.has(alias) || KEYWORD_WORDS.has(alias) || alias === name.toLowerCase(); n++) alias = `${base}${n}`
  return alias
}

export function caseKeyword(word: string, mode: KeywordCase): string {
  return mode === 'upper' ? word.toUpperCase() : mode === 'lower' ? word.toLowerCase() : word
}

/** Names the schema knows, which are never re-cased even when they spell a keyword. */
function isSchemaName(data: CompletionData | null, refs: References | null, word: string): boolean {
  if (!data) return false
  const lower = word.toLowerCase()
  if (data.tables.some((t) => t.name.toLowerCase() === lower)) return true
  if (refs) for (const { table } of refs.tables) if ((data.columnsFor(table) ?? []).some((c) => c.toLowerCase() === lower)) return true
  return false
}

export interface BoundaryEdit {
  from: number
  to: number
  insert: string
}

/**
 * What to change when a word is finished with a space, newline or punctuation: the word re-cased when it
 * is a keyword, and an alias added after a table name in a FROM or JOIN, as the preferences ask.
 */
export function boundaryEdit(before: string, inserted: string, data: CompletionData | null, prefs: EditorPrefs): BoundaryEdit | null {
  if (!/^[ \n\t,();]$/.test(inserted)) return null
  const m = /([\w$]+)$/.exec(before)
  if (!m) return null
  const word = m[1]
  const wordFrom = before.length - word.length
  const head = before.slice(0, wordFrom)
  if (inStringOrComment(head) || /["`\[.]$/.test(head)) return null
  const stmt = statementAt(before, wordFrom)
  const refs = data ? referencedTables(stmt.text, data) : null
  let replacement = word
  if (prefs.keywordCase !== 'off' && KEYWORD_WORDS.has(word.toLowerCase()) && !isSchemaName(data, refs, word)) replacement = caseKeyword(word, prefs.keywordCase)
  let alias = ''
  if (prefs.autoAlias && data && (inserted === ' ' || inserted === '\n')) {
    const sit = situationBefore(head.slice(stmt.start))
    const introducedByFrom = sit.lastToken === 'from' || sit.lastToken === 'join' || (sit.lastToken === ',' && sit.clause === 'from' && !sit.inParens)
    const table = introducedByFrom ? findTable(data, word) : undefined
    if (table && refs) alias = aliasFor(table.name, [...refs.byAlias.keys()].filter((k) => k !== table.name.toLowerCase()))
  }
  if (replacement === word && !alias) return null
  return { from: wordFrom, to: before.length, insert: replacement + (alias ? ` ${alias}` : '') + inserted }
}

// ---------------------------------------------------------------------------
// The completion source
// ---------------------------------------------------------------------------

const MAX_TABLE_OPTIONS = 300

function keywordOptions(words: string[], mode: KeywordCase, boost = 0): Completion[] {
  return words.map((k) => ({ label: caseKeyword(k, mode), type: 'keyword', boost }))
}

/** A completion source over the given data; `get` is read on every request so the data can change freely. */
export function sqlCompletionSource(get: () => CompletionData | null): CompletionSource {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const data = get()
    if (!data) return null
    const prefs = data.prefs ?? DEFAULT_EDITOR_PREFS
    if (!prefs.autocomplete) return null
    const word = ctx.matchBefore(/[\w$]*/)
    const from = word ? word.from : ctx.pos
    const typed = (word?.text ?? '').toLowerCase()
    const doc = ctx.state.doc.toString()
    const head = doc.slice(0, from)
    if (inStringOrComment(head)) return null
    const stmt = statementAt(doc, from)
    const refs = referencedTables(stmt.text, data)
    const casing = prefs.keywordCase
    const tableOption = (t: TableEntry): Completion => {
      const label = tableDisplay(t, data.defaultSchema)
      const option: Completion = { label, type: t.kind === 'view' ? 'interface' : 'type', detail: t.kind === 'view' ? 'view' : t.schema && t.schema !== data.defaultSchema ? t.schema : undefined }
      if (prefs.autoAlias) {
        option.apply = (view, _c, f, to) => {
          const alias = aliasFor(t.name, [...refs.byAlias.keys()].filter((k) => k !== t.name.toLowerCase()))
          const insert = `${label} ${alias}`
          view.dispatch({ changes: { from: f, to, insert }, selection: { anchor: f + insert.length }, userEvent: 'input.complete' })
        }
      }
      return option
    }

    // "orders." or "u.": columns of that table or alias; "analytics.": tables of that schema.
    const qualified = /([\w$]+|"[^"]+")\.$/.exec(head.slice(Math.max(0, head.length - 200)))
    if (qualified) {
      const q = unquote(qualified[1])
      const table = refs.byAlias.get(q.toLowerCase()) ?? findTable(data, q)
      if (table) {
        const cols = data.columnsFor(table) ?? (await data.loadColumns(table))
        if (!cols.length) return null
        return { from, options: cols.map((c) => ({ label: c, type: 'property', boost: 2 })), validFor: /^[\w$]*$/ }
      }
      const lower = q.toLowerCase()
      const inSchema = data.tables.filter((t) => (t.schema ?? '').toLowerCase() === lower)
      if (!inSchema.length) return null
      return { from, options: inSchema.slice(0, MAX_TABLE_OPTIONS).map((t) => ({ label: t.name, type: t.kind === 'view' ? 'interface' : 'type' })), validFor: inSchema.length <= MAX_TABLE_OPTIONS ? /^[\w$]*$/ : undefined }
    }

    const sit = situationBefore(head.slice(stmt.start))
    if (sit.mode === 'none') return null
    const options: Completion[] = []

    if (sit.mode === 'tables') {
      let n = 0
      for (const t of data.tables) {
        const label = tableDisplay(t, data.defaultSchema)
        if (typed && !t.name.toLowerCase().includes(typed) && !label.toLowerCase().startsWith(typed)) continue
        options.push(tableOption(t))
        if (++n >= MAX_TABLE_OPTIONS) break
      }
      const schemas = new Set<string>()
      for (const t of data.tables) if (t.schema && t.schema !== data.defaultSchema) schemas.add(t.schema)
      for (const s of schemas) if (!typed || s.toLowerCase().includes(typed)) options.push({ label: s, type: 'namespace', detail: 'schema', boost: -1 })
      if (!options.length) return null
      return { from, options, validFor: n < MAX_TABLE_OPTIONS ? /^[\w$]*$/ : undefined }
    }

    if (sit.mode === 'columns') {
      const seen = new Set<string>()
      // Inside an INSERT's column list only that table's columns apply; elsewhere every referenced table's.
      const scope = sit.clause === 'into' && sit.inParens ? refs.tables.slice(-1) : refs.tables
      for (const { alias, table } of scope) {
        const cols = data.columnsFor(table) ?? (await data.loadColumns(table))
        for (const c of cols) {
          const key = c.toLowerCase()
          if (seen.has(key)) continue
          seen.add(key)
          options.push({ label: c, type: 'property', detail: scope.length > 1 ? alias : undefined, boost: 3 })
        }
      }
      // Aliases, so `u.` can be typed from a suggestion.
      for (const { alias, table } of refs.tables) if (refs.tables.length > 1 || alias.toLowerCase() !== table.name.toLowerCase()) options.push({ label: alias, type: 'variable', detail: tableDisplay(table, data.defaultSchema), boost: 1 })
      if (typed.length >= 2) options.push(...keywordOptions(FUNCTIONS.filter((f) => f.toLowerCase().startsWith(typed)), casing, -1))
      if (sit.alsoStatements && typed) options.push(...keywordOptions(STATEMENT_KEYWORDS, casing, -2))
      if (!options.length) return null
      return { from, options, validFor: /^[\w$]*$/ }
    }

    // Keywords: only while a word is being typed or asked for, except where just a few words can follow.
    if (!typed && !ctx.explicit && !sit.only) return null
    const words = sit.only ?? (sit.mode === 'statement' ? STATEMENT_KEYWORDS : [...CLAUSE_KEYWORDS, ...(data.dialect ? DIALECT_KEYWORDS[data.dialect] : [])])
    // A short list is shown in the order it is written; the editor would otherwise sort it alphabetically.
    options.push(...keywordOptions(words, casing).map((o, i) => (sit.only ? { ...o, boost: 10 - i } : o)))
    return { from, options, validFor: /^[\w$]*$/ }
  }
}
