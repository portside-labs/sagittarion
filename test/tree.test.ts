import { describe, expect, it } from 'vitest'
import type { Catalog, ObjectSummary, SearchResult } from '../src/shared/types'
import { appendNames, buildRows, emptyNames, filterNames, groupKey, objectKey, type NameIndex, type TreeRow } from '../src/renderer/src/lib/tree'

const counts = (table: number, view = 0, fn = 0, index = 0, trigger = 0) => ({ table, view, function: fn, index, trigger })

/** 23 schemas, one of them with 5,000 tables, about 30k names in total. */
function bigDatabase(): { catalog: Catalog; names: NameIndex } {
  const schemas = [{ name: 'public', counts: counts(60, 5, 12, 90, 4) }]
  for (let s = 1; s <= 22; s++) schemas.push({ name: `app_${s}`, counts: counts(s === 7 ? 5000 : 1100, 10, 5, 20, 1) })
  const totalTables = schemas.reduce((n, s) => n + s.counts.table + s.counts.view, 0)
  const totalObjects = schemas.reduce((n, s) => n + s.counts.table + s.counts.view + s.counts.function + s.counts.index + s.counts.trigger, 0)
  const catalog: Catalog = { kind: 'postgres', defaultSchema: 'public', schemas, totalObjects, totalTables }
  const items: ObjectSummary[] = []
  for (const s of schemas) {
    for (let i = 0; i < s.counts.table; i++) items.push({ id: `${s.name}.t${i}`, kind: 'table', schema: s.name, name: i % 97 === 0 ? `invoice_lines_${i}` : `record_${i}`, columnCount: 12, rowEstimate: i * 10 })
    for (let i = 0; i < s.counts.view; i++) items.push({ id: `${s.name}.v${i}`, kind: 'view', schema: s.name, name: `report_${i}` })
  }
  let names = emptyNames(1, totalTables)
  for (let i = 0; i < items.length; i += 4000) names = appendNames(names, items.slice(i, i + 4000), i + 4000 >= items.length)
  return { catalog, names }
}

const base = (catalog: Catalog, names: NameIndex) => ({ catalog, names, groups: {}, tables: {}, expanded: {}, filter: '', search: null, searching: false, activeTable: null, autoExpand: catalog.totalTables <= 2000 })

function summary(rows: TreeRow[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of rows) out[r.type] = (out[r.type] ?? 0) + 1
  return out
}

describe('name index', () => {
  it('streams pages into per-schema buckets without losing order', () => {
    const { names, catalog } = bigDatabase()
    expect(names.complete).toBe(true)
    expect(names.loaded).toBe(catalog.totalTables)
    expect(names.byScope.get('app_7')!.table.length).toBe(5000)
    expect(names.byScope.get('public')!.view.map((e) => e.obj.name)).toEqual(['report_0', 'report_1', 'report_2', 'report_3', 'report_4'])
    expect(names.entries.length).toBe(catalog.totalTables)
  })

  it('filters tens of thousands of names in a few milliseconds', () => {
    const { names } = bigDatabase()
    const t0 = performance.now()
    const hits = filterNames(names, 'invoice')
    const ms = performance.now() - t0
    expect(hits.length).toBeGreaterThan(200)
    expect(hits.every((e) => e.lower.includes('invoice'))).toBe(true)
    expect(ms).toBeLessThan(200)
    expect(filterNames(names, 'app_7.invoice_lines_97').map((e) => e.obj.name)).toEqual(['invoice_lines_97', 'invoice_lines_970'])
    expect(filterNames(names, '')).toEqual([])
  })
})

describe('tree rows', () => {
  it('opens only the default schema on a large database', () => {
    const { catalog, names } = bigDatabase()
    const t0 = performance.now()
    const rows = buildRows(base(catalog, names))
    const ms = performance.now() - t0
    expect(ms).toBeLessThan(200)
    const schemaRows = rows.filter((r) => r.type === 'schema')
    expect(schemaRows.length).toBe(23)
    expect(schemaRows.filter((r) => r.type === 'schema' && r.open).map((r) => (r as { schema: string }).schema)).toEqual(['public'])
    const groups = rows.filter((r) => r.type === 'group') as Extract<TreeRow, { type: 'group' }>[]
    expect(groups.map((g) => g.kind)).toEqual(['table', 'view', 'function', 'index', 'trigger'])
    expect(groups.map((g) => g.open)).toEqual([true, false, false, false, false])
    expect(summary(rows).object).toBe(60)
  })

  it('flattens an expanded schema with thousands of tables and shows lazy groups as loading', () => {
    const { catalog, names } = bigDatabase()
    const gkey = groupKey('app_7', 'index')
    const rows = buildRows({ ...base(catalog, names), expanded: { 'schema:app_7': true, [gkey]: true, [groupKey('app_7', 'view')]: true } })
    expect(summary(rows).object).toBe(60 + 5000 + 10)
    const loading = rows.find((r) => r.type === 'info' && r.key === `${gkey}:loading`)
    expect(loading).toBeTruthy()
    const withGroup = buildRows({
      ...base(catalog, names),
      expanded: { 'schema:app_7': true, [gkey]: true },
      groups: { [gkey]: { items: [{ id: '1', kind: 'index', schema: 'app_7', name: 'ix_a', table: 'record_1' }], cursor: 'more', loading: false, error: null } }
    })
    expect(withGroup.some((r) => r.type === 'object' && r.obj.kind === 'index')).toBe(true)
    expect(withGroup.find((r) => r.type === 'more')).toMatchObject({ kind: 'index', remaining: 19 })
  })

  it('shows columns under an expanded table from the detail cache', () => {
    const { catalog, names } = bigDatabase()
    const first = names.byScope.get('public')!.table[0].obj
    const key = objectKey(first)
    const details = { ...first, type: 'table' as const, sql: null, withoutRowid: true, rowidAlias: null, pk: ['id'], columns: [{ cid: 0, name: 'id', type: 'int', notnull: true, dflt: null, pk: 1, hidden: 0 }, { cid: 1, name: 'label', type: 'text', notnull: false, dflt: null, pk: 0, hidden: 0 }] }
    const loading = buildRows({ ...base(catalog, names), expanded: { [key]: true } })
    expect(loading.find((r) => r.type === 'info' && r.text === 'Loading columns…')).toBeTruthy()
    const rows = buildRows({ ...base(catalog, names), expanded: { [key]: true }, tables: { [JSON.stringify(['public', first.name])]: { status: 'ready', details } } })
    const cols = rows.filter((r) => r.type === 'column') as Extract<TreeRow, { type: 'column' }>[]
    expect(cols.map((c) => c.col.name)).toEqual(['id', 'label'])
    expect(cols[0].depth).toBe(3)
  })

  it('merges local matches, loaded groups and server results when filtering', () => {
    const { catalog, names } = bigDatabase()
    const search: SearchResult = {
      query: 'invoice',
      objects: [
        { id: 'f1', kind: 'function', schema: 'billing', name: 'invoice_total', args: 'id bigint', returns: 'numeric' },
        { id: 'app_7.t97', kind: 'table', schema: 'app_7', name: 'invoice_lines_97' } // already known locally, must not duplicate
      ],
      columns: [{ schema: 'public', table: 'record_5', tableKind: 'table', column: 'invoice_id', type: 'bigint' }],
      truncated: false
    }
    const rows = buildRows({ ...base(catalog, names), filter: 'Invoice', search, groups: { [groupKey('public', 'trigger')]: { items: [{ id: 't', kind: 'trigger', schema: 'public', name: 'trg_invoice', table: 'record_1' }], cursor: null, loading: false, error: null } } })
    const schemas = rows.filter((r) => r.type === 'schema') as Extract<TreeRow, { type: 'schema' }>[]
    expect(schemas[0].schema).toBe('public') // default schema first
    expect(schemas.map((s) => s.schema)).toContain('billing')
    const objects = rows.filter((r) => r.type === 'object') as Extract<TreeRow, { type: 'object' }>[]
    expect(objects.filter((o) => o.obj.name === 'invoice_lines_97' && o.obj.schema === 'app_7').length).toBe(1)
    expect(objects.some((o) => o.obj.kind === 'function' && o.obj.name === 'invoice_total')).toBe(true)
    expect(objects.some((o) => o.obj.kind === 'trigger' && o.obj.name === 'trg_invoice')).toBe(true)
    const hit = rows.find((r) => r.type === 'column' && r.hit) as Extract<TreeRow, { type: 'column' }>
    expect(hit.col.name).toBe('invoice_id')
    const parent = objects.find((o) => o.obj.name === 'record_5')!
    expect(parent.open).toBe(true)
    expect(rows.every((r) => r.type !== 'group' || r.open)).toBe(true)
    expect(buildRows({ ...base(catalog, names), filter: 'zzzz', searching: true })).toEqual([{ type: 'info', key: 'no-matches', depth: 0, text: 'Searching…', spinner: true }])
  })

  it('lays out a small SQLite database flat, with every group visible', () => {
    const catalog: Catalog = { kind: 'sqlite', schemas: [{ name: 'main', counts: counts(3, 1, 0, 2, 1) }], totalObjects: 7, totalTables: 4 }
    let names = emptyNames(1, 4)
    names = appendNames(names, [
      { id: 'users', kind: 'table', name: 'users', columnCount: 4 },
      { id: 'orders', kind: 'table', name: 'orders', columnCount: 5 },
      { id: 'settings', kind: 'table', name: 'settings', columnCount: 2 },
      { id: 'order_summary', kind: 'view', name: 'order_summary' }
    ], true)
    const rows = buildRows(base(catalog, names))
    expect(rows[0]).toMatchObject({ type: 'group', kind: 'table', depth: 0, open: true, count: 3 })
    const groups = rows.filter((r) => r.type === 'group') as Extract<TreeRow, { type: 'group' }>[]
    expect(groups.map((g) => g.kind)).toEqual(['table', 'view', 'index', 'trigger'])
    expect(groups.find((g) => g.kind === 'view')!.open).toBe(true)
    expect(rows.filter((r) => r.type === 'object').length).toBe(4)
  })
})
