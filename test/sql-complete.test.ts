import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { CompletionContext } from '@codemirror/autocomplete'
import { findTable, referencedTables, sqlCompletionSource, type CompletionData, type TableEntry } from '../src/renderer/src/lib/sql-complete'

const tables: TableEntry[] = [
  { schema: 'public', name: 'users', kind: 'table' },
  { schema: 'public', name: 'orders', kind: 'table' },
  { schema: 'public', name: 'order_summary', kind: 'view' },
  { schema: 'analytics', name: 'daily_totals', kind: 'table' },
  { schema: 'analytics', name: 'users', kind: 'table' }
]
const columns: Record<string, string[]> = {
  'public.users': ['id', 'email', 'name'],
  'public.orders': ['id', 'user_id', 'status', 'total'],
  'analytics.daily_totals': ['day', 'revenue'],
  'analytics.users': ['id', 'segment']
}

function data(known: string[] = []): CompletionData & { loads: string[] } {
  const loaded = new Set(known)
  const loads: string[] = []
  return {
    tables,
    defaultSchema: 'public',
    loads,
    columnsFor: (t) => (loaded.has(`${t.schema}.${t.name}`) ? columns[`${t.schema}.${t.name}`] : undefined),
    loadColumns: async (t) => {
      const key = `${t.schema}.${t.name}`
      loads.push(key)
      loaded.add(key)
      return columns[key] ?? []
    }
  }
}

async function complete(d: CompletionData, doc: string, pos = doc.length, explicit = false) {
  const state = EditorState.create({ doc })
  const res = await sqlCompletionSource(() => d)(new CompletionContext(state, pos, explicit))
  return res ? { from: res.from, labels: res.options.map((o) => o.label), options: res.options } : null
}

describe('SQL completion', () => {
  it('resolves table references and aliases from the query text', () => {
    const d = data()
    const refs = referencedTables('SELECT u.id FROM users u JOIN orders AS o ON o.user_id = u.id, analytics.daily_totals WHERE o.status = 1', d)
    expect(refs.tables.map((r) => `${r.alias}=${r.table.schema}.${r.table.name}`)).toEqual(['u=public.users', 'o=public.orders', 'daily_totals=analytics.daily_totals'])
    expect(refs.byAlias.get('o')!.name).toBe('orders')
    expect(refs.byAlias.get('users')!.schema).toBe('public')
    // keywords after a table are not aliases
    expect(referencedTables('SELECT * FROM orders WHERE total > 5', d).tables[0].alias).toBe('orders')
    expect(findTable(d, 'USERS')!.schema).toBe('public')
    expect(findTable(d, 'analytics.users')!.schema).toBe('analytics')
    expect(findTable(d, '"daily_totals"')!.schema).toBe('analytics')
    expect(findTable(d, 'nope')).toBeUndefined()
  })

  it('offers table names while typing, narrowed by the prefix', async () => {
    const d = data()
    const res = await complete(d, 'SELECT * FROM us')
    expect(res!.from).toBe('SELECT * FROM '.length)
    expect(res!.labels).toEqual(['users', 'analytics.users'])
    expect(res!.options[1].detail).toBe('analytics')
    expect(await complete(d, 'SELECT * FROM ')).toBeNull() // nothing typed, not explicit
    expect((await complete(d, 'SELECT * FROM ', 'SELECT * FROM '.length, true))!.labels).toEqual(expect.arrayContaining(['users', 'orders', 'order_summary', 'analytics.daily_totals', 'analytics']))
  })

  it('loads the columns of a table on demand for qualified names and aliases', async () => {
    const d = data()
    const res = await complete(d, 'SELECT orders. FROM orders', 'SELECT orders.'.length)
    expect(res!.labels).toEqual(['id', 'user_id', 'status', 'total'])
    expect(d.loads).toEqual(['public.orders'])
    const aliased = await complete(d, 'SELECT o.st FROM orders o', 'SELECT o.st'.length)
    expect(aliased!.from).toBe('SELECT o.'.length)
    expect(aliased!.labels).toEqual(['id', 'user_id', 'status', 'total'])
    expect(d.loads).toEqual(['public.orders']) // cached after the first load
    expect((await complete(d, 'SELECT * FROM analytics.'))!.labels).toEqual(['daily_totals', 'users'])
    expect(await complete(d, 'SELECT nothing.')).toBeNull()
  })

  it('offers the columns of every referenced table unqualified, ahead of table names', async () => {
    const d = data(['public.users'])
    const res = await complete(d, 'SELECT e FROM users u JOIN orders o ON o.user_id = u.id', 'SELECT e'.length)
    const labels = res!.labels
    expect(labels.slice(0, 7)).toEqual(['id', 'email', 'name', 'user_id', 'status', 'total', 'u'])
    expect(res!.options.find((o) => o.label === 'email')!.detail).toBe('u')
    expect(d.loads).toEqual(['public.orders'])
    expect(labels).toContain('order_summary') // tables still offered, filtered by the typed text where possible
  })
})
