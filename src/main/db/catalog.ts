// Catalog views derived from a fully loaded SchemaInfo. SQLite databases are
// small enough to load whole, so their driver answers the lazy calls from here.
import type {
  Catalog,
  ColumnHit,
  ListObjectsRequest,
  ObjectCounts,
  ObjectDefinition,
  ObjectKind,
  ObjectPage,
  ObjectRef,
  ObjectSummary,
  Relation,
  SchemaInfo,
  SearchResult,
  TableMeta,
  TableRef
} from '@shared/types'
import { sameTable } from '@shared/connections'

export function emptyCounts(): ObjectCounts {
  return { table: 0, view: 0, function: 0, index: 0, trigger: 0 }
}

export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

export function decodeCursor<T>(cursor: string | null | undefined): T | null {
  if (!cursor) return null
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T
  } catch {
    throw new Error('Invalid paging cursor.')
  }
}

/** Which catalog a request reads from; mixing families in one page is not supported. */
export function familyOf(kinds: ObjectKind[]): 'relation' | 'index' | 'trigger' | 'function' {
  const set = new Set(kinds)
  const rel = set.has('table') || set.has('view')
  const others = (['index', 'trigger', 'function'] as const).filter((k) => set.has(k))
  if ((rel && others.length) || others.length > 1) throw new Error('listObjects takes tables and views together, or one of index, trigger or function.')
  if (rel) return 'relation'
  if (others.length === 1) return others[0]
  throw new Error('listObjects needs at least one kind.')
}

export function summarizeTable(t: TableMeta): ObjectSummary {
  return {
    id: t.schema ? `${t.schema}.${t.name}` : t.name,
    kind: t.type === 'view' ? 'view' : 'table',
    schema: t.schema,
    name: t.name,
    subtype: t.type,
    columnCount: t.columns.length,
    rowEstimate: t.rowEstimate ?? null,
    comment: t.comment ?? null
  }
}

function allObjects(schema: SchemaInfo): ObjectSummary[] {
  return [
    ...schema.tables.map(summarizeTable),
    ...schema.views.map(summarizeTable),
    ...schema.indexes.map<ObjectSummary>((i) => ({ id: `${i.schema ?? ''}.${i.name}`, kind: 'index', schema: i.schema, name: i.name, table: i.table })),
    ...schema.triggers.map<ObjectSummary>((t) => ({ id: `${t.schema ?? ''}.${t.name}`, kind: 'trigger', schema: t.schema, name: t.name, table: t.table }))
  ]
}

export function catalogFromSchema(schema: SchemaInfo): Catalog {
  const byName = new Map<string, ObjectCounts>()
  const names = schema.schemas ?? []
  for (const n of names) byName.set(n, emptyCounts())
  const bump = (s: string | undefined, kind: ObjectKind) => {
    const key = s ?? ''
    const counts = byName.get(key) ?? emptyCounts()
    counts[kind]++
    byName.set(key, counts)
  }
  for (const t of schema.tables) bump(t.schema, 'table')
  for (const v of schema.views) bump(v.schema, 'view')
  for (const i of schema.indexes) bump(i.schema, 'index')
  for (const t of schema.triggers) bump(t.schema, 'trigger')
  // SQLite has one implicit schema; report it under the default name so counts survive.
  const schemas = names.length
    ? names.map((name) => ({ name, counts: byName.get(name) ?? emptyCounts() }))
    : [...byName.entries()].map(([name, counts]) => ({ name: name || schema.defaultSchema || 'main', counts }))
  const totalObjects = [...byName.values()].reduce((n, c) => n + c.table + c.view + c.function + c.index + c.trigger, 0)
  return { kind: schema.kind, defaultSchema: schema.defaultSchema, schemas, totalObjects, totalTables: schema.tables.length + schema.views.length }
}

export function objectsFromSchema(schema: SchemaInfo, req: ListObjectsRequest): ObjectPage {
  const kinds = new Set(req.kinds)
  familyOf(req.kinds)
  const items = allObjects(schema)
    .filter((o) => kinds.has(o.kind) && (req.schema === undefined || (o.schema ?? '') === req.schema))
    .sort((a, b) => (a.schema ?? '').localeCompare(b.schema ?? '') || a.name.localeCompare(b.name))
  return { items, cursor: null }
}

export function searchSchema(schema: SchemaInfo, query: string, limit = 100): SearchResult {
  const q = query.trim().toLowerCase()
  if (!q) return { query, objects: [], columns: [], truncated: false }
  const objects = allObjects(schema).filter((o) => o.name.toLowerCase().includes(q) || (o.table ?? '').toLowerCase().includes(q))
  const columns: ColumnHit[] = []
  for (const t of [...schema.tables, ...schema.views]) {
    for (const c of t.columns) {
      if (c.name.toLowerCase().includes(q)) columns.push({ schema: t.schema, table: t.name, tableKind: t.type === 'view' ? 'view' : 'table', column: c.name, type: c.type })
    }
  }
  return { query, objects: objects.slice(0, limit), columns: columns.slice(0, limit), truncated: objects.length > limit || columns.length > limit }
}

export function definitionFromSchema(schema: SchemaInfo, ref: ObjectRef): ObjectDefinition {
  const same = (s?: string) => (s ?? '') === (ref.schema ?? '')
  let sql: string | null = null
  if (ref.kind === 'table' || ref.kind === 'view') sql = [...schema.tables, ...schema.views].find((t) => same(t.schema) && t.name === ref.name)?.sql ?? null
  else if (ref.kind === 'index') {
    const i = schema.indexes.find((x) => same(x.schema) && x.name === ref.name)
    sql = i ? (i.sql ?? `-- ${i.name} is an automatic index`) : null
  } else if (ref.kind === 'trigger') sql = schema.triggers.find((t) => same(t.schema) && t.name === ref.name)?.sql ?? null
  else sql = null
  return { ...ref, sql }
}

export function tablesFromSchema(schema: SchemaInfo, refs: TableRef[]): TableMeta[] {
  const all = [...schema.tables, ...schema.views]
  return refs.map((r) => all.find((t) => sameTable(t, r))).filter((t): t is TableMeta => Boolean(t))
}

export function relationsFromSchema(schema: SchemaInfo, refs: TableRef[]): Relation[] {
  const wanted = new Set(refs.map((r) => `${r.schema ?? ''}.${r.name}`))
  return (schema.relations ?? []).filter((r) => wanted.has(`${r.schema ?? ''}.${r.table}`) || wanted.has(`${r.refSchema ?? ''}.${r.refTable}`))
}
