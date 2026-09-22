// Pure logic behind the schema sidebar: a name index that grows as pages
// arrive, instant local filtering, and the flattened row list that a
// virtualized tree draws. No React here, so it is unit-tested directly.
import type { Catalog, ColumnHit, ColumnInfo, ObjectCounts, ObjectKind, ObjectSummary, SearchResult, TableDetails } from '@shared/types'
import { tableKey } from '@shared/connections'

export const ROW_HEIGHT = 24
/** Matches shown per group before asking for a narrower filter. */
export const FILTER_CAP = 2000

export const KIND_LABELS: Record<ObjectKind, string> = { table: 'Tables', view: 'Views', function: 'Functions', index: 'Indexes', trigger: 'Triggers' }
export const KIND_ORDER: ObjectKind[] = ['table', 'view', 'function', 'index', 'trigger']

export interface NameEntry {
  obj: ObjectSummary
  lower: string
  /** Schema name, or '' for SQLite. */
  scope: string
}

export interface NameIndex {
  entries: NameEntry[]
  byScope: Map<string, { table: NameEntry[]; view: NameEntry[] }>
  loaded: number
  total: number
  complete: boolean
  /** Bumped on every refresh so late pages of an old load are dropped. */
  epoch: number
}

export interface GroupState {
  items: ObjectSummary[]
  cursor: string | null
  loading: boolean
  error: string | null
}

export type TableState = { status: 'loading' } | { status: 'ready'; details: TableDetails } | { status: 'error'; error: string }

export function emptyNames(epoch = 0, total = 0): NameIndex {
  return { entries: [], byScope: new Map(), loaded: 0, total, complete: total === 0, epoch }
}

/** A new index with the page appended; arrays are copied so React sees the change. */
export function appendNames(prev: NameIndex, items: ObjectSummary[], complete: boolean): NameIndex {
  const entries = prev.entries.slice()
  const byScope = new Map(prev.byScope)
  const touched = new Set<string>()
  for (const o of items) {
    if (o.kind !== 'table' && o.kind !== 'view') continue
    const scope = o.schema ?? ''
    const e: NameEntry = { obj: o, lower: o.name.toLowerCase(), scope }
    entries.push(e)
    let bucket = byScope.get(scope)
    if (!bucket || !touched.has(scope)) {
      bucket = { table: [...(bucket?.table ?? [])], view: [...(bucket?.view ?? [])] }
      byScope.set(scope, bucket)
      touched.add(scope)
    }
    bucket[o.kind].push(e)
  }
  return { entries, byScope, loaded: prev.loaded + items.length, total: prev.total, complete, epoch: prev.epoch }
}

export function groupKey(scope: string, kind: ObjectKind): string {
  return `${scope}|${kind}`
}

export function objectKey(o: ObjectSummary): string {
  return `${o.kind}|${o.schema ?? ''}|${o.name}|${o.kind === 'function' ? o.id : ''}`
}

/** Case-insensitive substring match over the local name index. */
export function filterNames(index: NameIndex, q: string, cap = FILTER_CAP): NameEntry[] {
  const out: NameEntry[] = []
  if (!q) return out
  const dotted = q.includes('.')
  for (const e of index.entries) {
    if (e.lower.includes(q) || (dotted && `${e.scope.toLowerCase()}.${e.lower}`.includes(q))) {
      out.push(e)
      if (out.length >= cap) break
    }
  }
  return out
}

export type TreeRow =
  | { type: 'schema'; key: string; depth: number; schema: string; count: number; open: boolean }
  | { type: 'group'; key: string; depth: number; scope: string; schema?: string; kind: ObjectKind; count: number; open: boolean; loading: boolean }
  | { type: 'object'; key: string; depth: number; obj: ObjectSummary; open: boolean; active: boolean; hasChildren: boolean }
  | { type: 'column'; key: string; depth: number; col: ColumnInfo; hit: boolean }
  | { type: 'more'; key: string; depth: number; scope: string; schema?: string; kind: ObjectKind; remaining: number }
  | { type: 'info'; key: string; depth: number; text: string; spinner?: boolean }

export interface TreeInputs {
  catalog: Catalog
  names: NameIndex
  groups: Record<string, GroupState>
  tables: Record<string, TableState>
  /** Explicit toggles; anything absent uses the default for its row type. */
  expanded: Record<string, boolean>
  filter: string
  search: SearchResult | null
  searching: boolean
  /** tableKey of the table open in the active tab. */
  activeTable: string | null
  /** Small databases open every schema and view group up front. */
  autoExpand: boolean
}

const zeroCounts: ObjectCounts = { table: 0, view: 0, function: 0, index: 0, trigger: 0 }

function totalOf(c: ObjectCounts): number {
  return c.table + c.view + c.function + c.index + c.trigger
}

function columnFromHit(h: ColumnHit, i: number): ColumnInfo {
  return { cid: i, name: h.column, type: h.type, notnull: false, dflt: null, pk: 0, hidden: 0 }
}

export function buildRows(i: TreeInputs): TreeRow[] {
  const q = i.filter.trim().toLowerCase()
  if (q) return buildFilteredRows(i, q)
  const rows: TreeRow[] = []
  const multi = i.catalog.schemas.length > 1
  const scopes: { scope: string; schema?: string; counts: ObjectCounts }[] = multi
    ? i.catalog.schemas.map((s) => ({ scope: s.name, schema: s.name, counts: s.counts }))
    : [{ scope: i.catalog.kind === 'sqlite' ? '' : (i.catalog.schemas[0]?.name ?? ''), schema: i.catalog.kind === 'sqlite' ? undefined : i.catalog.schemas[0]?.name, counts: i.catalog.schemas[0]?.counts ?? zeroCounts }]

  for (const { scope, schema, counts } of scopes) {
    let depth = 0
    if (multi) {
      const key = `schema:${scope}`
      const open = i.expanded[key] ?? (i.autoExpand || scope === i.catalog.defaultSchema)
      rows.push({ type: 'schema', key, depth: 0, schema: scope, count: totalOf(counts), open })
      if (!open) continue
      depth = 1
    }
    for (const kind of KIND_ORDER) {
      const count = counts[kind]
      if (kind === 'function' && i.catalog.kind === 'sqlite') continue
      if (count === 0 && kind !== 'table') continue
      const gkey = groupKey(scope, kind)
      const open = i.expanded[gkey] ?? (kind === 'table' || (kind === 'view' && i.autoExpand))
      const group = i.groups[gkey]
      rows.push({ type: 'group', key: gkey, depth, scope, schema, kind, count, open, loading: Boolean(group?.loading) })
      if (!open) continue
      if (kind === 'table' || kind === 'view') {
        const list = i.names.byScope.get(scope)?.[kind] ?? []
        for (const e of list) pushObject(rows, i, e.obj, depth + 1, null)
        if (list.length < count && !i.names.complete) rows.push({ type: 'info', key: `${gkey}:loading`, depth: depth + 1, text: 'Loading names…', spinner: true })
        else if (!list.length) rows.push({ type: 'info', key: `${gkey}:empty`, depth: depth + 1, text: `No ${KIND_LABELS[kind].toLowerCase()}` })
      } else if (!group || (group.loading && !group.items.length)) {
        rows.push({ type: 'info', key: `${gkey}:loading`, depth: depth + 1, text: 'Loading…', spinner: true })
      } else {
        for (const o of group.items) pushObject(rows, i, o, depth + 1, null)
        if (group.error) rows.push({ type: 'info', key: `${gkey}:error`, depth: depth + 1, text: group.error })
        else if (!group.items.length) rows.push({ type: 'info', key: `${gkey}:empty`, depth: depth + 1, text: `No ${KIND_LABELS[kind].toLowerCase()}` })
        if (group.loading) rows.push({ type: 'info', key: `${gkey}:more-loading`, depth: depth + 1, text: 'Loading more…', spinner: true })
        else if (group.cursor) rows.push({ type: 'more', key: `${gkey}:more`, depth: depth + 1, scope, schema, kind, remaining: Math.max(0, count - group.items.length) })
      }
    }
  }
  return rows
}

function pushObject(rows: TreeRow[], i: TreeInputs, o: ObjectSummary, depth: number, hits: ColumnHit[] | null): void {
  const key = objectKey(o)
  const isTable = o.kind === 'table' || o.kind === 'view'
  const tkey = isTable ? tableKey({ schema: o.schema, name: o.name }) : ''
  if (hits) {
    rows.push({ type: 'object', key, depth, obj: o, open: hits.length > 0, active: isTable && tkey === i.activeTable, hasChildren: isTable })
    hits.forEach((h, n) => rows.push({ type: 'column', key: `${key}:hit:${h.column}`, depth: depth + 1, col: columnFromHit(h, n), hit: true }))
    return
  }
  const open = isTable ? (i.expanded[key] ?? false) : false
  rows.push({ type: 'object', key, depth, obj: o, open, active: isTable && tkey === i.activeTable, hasChildren: isTable })
  if (!open) return
  const state = i.tables[tkey]
  if (!state || state.status === 'loading') rows.push({ type: 'info', key: `${key}:loading`, depth: depth + 1, text: 'Loading columns…', spinner: true })
  else if (state.status === 'error') rows.push({ type: 'info', key: `${key}:error`, depth: depth + 1, text: state.error })
  else if (!state.details.columns.length) rows.push({ type: 'info', key: `${key}:empty`, depth: depth + 1, text: 'No columns' })
  else for (const c of state.details.columns) rows.push({ type: 'column', key: `${key}:${c.cid}:${c.name}`, depth: depth + 1, col: c, hit: false })
}

function buildFilteredRows(i: TreeInputs, q: string): TreeRow[] {
  const rows: TreeRow[] = []
  const multi = i.catalog.schemas.length > 1
  // scope -> kind -> objects, plus column hits per table
  const byScope = new Map<string, Map<ObjectKind, Map<string, ObjectSummary>>>()
  const hitsByTable = new Map<string, ColumnHit[]>()
  const add = (o: ObjectSummary) => {
    const scope = o.schema ?? ''
    let kinds = byScope.get(scope)
    if (!kinds) byScope.set(scope, (kinds = new Map()))
    let objs = kinds.get(o.kind)
    if (!objs) kinds.set(o.kind, (objs = new Map()))
    const k = objectKey(o)
    if (!objs.has(k)) objs.set(k, o)
  }
  let capped = false
  const local = filterNames(i.names, q)
  if (local.length >= FILTER_CAP) capped = true
  for (const e of local) add(e.obj)
  for (const g of Object.values(i.groups)) for (const o of g.items) if (o.name.toLowerCase().includes(q) || (o.table ?? '').toLowerCase().includes(q)) add(o)
  if (i.search && i.search.query.toLowerCase() === q) {
    for (const o of i.search.objects) add(o)
    for (const h of i.search.columns) {
      const summary: ObjectSummary = { id: h.tableId ?? `${h.schema ?? ''}.${h.table}`, kind: h.tableKind, schema: h.schema, name: h.table }
      add(summary)
      const tk = tableKey({ schema: h.schema, name: h.table })
      const list = hitsByTable.get(tk) ?? []
      list.push(h)
      hitsByTable.set(tk, list)
    }
    if (i.search.truncated) capped = true
  }
  const scopes = [...byScope.keys()].sort((a, b) => (a === i.catalog.defaultSchema ? -1 : b === i.catalog.defaultSchema ? 1 : a.localeCompare(b)))
  for (const scope of scopes) {
    const kinds = byScope.get(scope)!
    let depth = 0
    let count = 0
    for (const objs of kinds.values()) count += objs.size
    if (multi) {
      rows.push({ type: 'schema', key: `schema:${scope}`, depth: 0, schema: scope, count, open: true })
      depth = 1
    }
    for (const kind of KIND_ORDER) {
      const objs = kinds.get(kind)
      if (!objs) continue
      const gkey = groupKey(scope, kind)
      rows.push({ type: 'group', key: gkey, depth, scope, schema: scope || undefined, kind, count: objs.size, open: true, loading: false })
      const sorted = [...objs.values()].sort((a, b) => a.name.localeCompare(b.name))
      for (const o of sorted) {
        const tk = o.kind === 'table' || o.kind === 'view' ? tableKey({ schema: o.schema, name: o.name }) : ''
        pushObject(rows, i, o, depth + 1, hitsByTable.get(tk) ?? [])
      }
    }
  }
  if (!rows.length) rows.push({ type: 'info', key: 'no-matches', depth: 0, text: i.searching ? 'Searching…' : 'No matches', spinner: i.searching })
  else if (i.searching) rows.push({ type: 'info', key: 'searching', depth: 0, text: 'Searching the server…', spinner: true })
  if (capped) rows.push({ type: 'info', key: 'capped', depth: 0, text: 'Showing the first matches; narrow the filter to see more.' })
  return rows
}
