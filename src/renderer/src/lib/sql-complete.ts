// Table and column completion for the SQL editor. Works from the name index
// (so it scales to huge schemas) and loads a table's columns the first time
// they are needed, e.g. when typing `orders.` or after `FROM orders`.
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'

export interface TableEntry {
  schema?: string
  name: string
  kind: 'table' | 'view'
}

export interface CompletionData {
  tables: TableEntry[]
  defaultSchema?: string
  /** Column names when already known. */
  columnsFor(ref: TableEntry): string[] | undefined
  /** Fetch columns on demand; resolves to [] when the table cannot be described. */
  loadColumns(ref: TableEntry): Promise<string[]>
}

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

const MAX_TABLE_OPTIONS = 300

function tableOption(t: TableEntry, defaultSchema?: string): Completion {
  return { label: tableDisplay(t, defaultSchema), type: t.kind === 'view' ? 'interface' : 'type', detail: t.kind === 'view' ? 'view' : t.schema && t.schema !== defaultSchema ? t.schema : undefined }
}

/** A completion source over the given data; `get` is read on every request so the data can change freely. */
export function sqlCompletionSource(get: () => CompletionData | null): CompletionSource {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const data = get()
    if (!data) return null
    const word = ctx.matchBefore(/[\w$]*/)
    const from = word ? word.from : ctx.pos
    const before = ctx.state.sliceDoc(Math.max(0, from - 200), from)
    const qualified = /([\w$]+|"[^"]+")\.$/.exec(before)
    const doc = ctx.state.doc.toString()
    const refs = referencedTables(doc, data)

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

    const typed = (word?.text ?? '').toLowerCase()
    if (!typed && !ctx.explicit) return null
    const options: Completion[] = []
    const seen = new Set<string>()
    // Columns of every table the query mentions, then the aliases themselves.
    for (const { alias, table } of refs.tables) {
      const cols = data.columnsFor(table) ?? (await data.loadColumns(table))
      for (const c of cols) {
        const key = `c:${c.toLowerCase()}`
        if (seen.has(key)) continue
        seen.add(key)
        options.push({ label: c, type: 'property', detail: alias, boost: 3 })
      }
    }
    for (const { alias, table } of refs.tables) {
      if (alias.toLowerCase() === table.name.toLowerCase()) continue
      options.push({ label: alias, type: 'variable', detail: tableDisplay(table, data.defaultSchema), boost: 1 })
    }
    // Table names, narrowed by what has been typed so a huge schema stays cheap.
    let n = 0
    for (const t of data.tables) {
      const label = tableDisplay(t, data.defaultSchema)
      if (typed && !t.name.toLowerCase().includes(typed) && !label.toLowerCase().startsWith(typed)) continue
      options.push(tableOption(t, data.defaultSchema))
      if (++n >= MAX_TABLE_OPTIONS) break
    }
    // Schema names, so `analytics.` can be completed in two steps.
    const schemas = new Set<string>()
    for (const t of data.tables) if (t.schema && t.schema !== data.defaultSchema) schemas.add(t.schema)
    for (const s of schemas) if (!typed || s.toLowerCase().includes(typed)) options.push({ label: s, type: 'namespace', detail: 'schema', boost: -1 })
    if (!options.length) return null
    return { from, options, validFor: n < MAX_TABLE_OPTIONS ? /^[\w$]*$/ : undefined }
  }
}
