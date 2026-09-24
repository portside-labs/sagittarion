import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { CompletionContext } from '@codemirror/autocomplete'
import {
  aliasFor,
  boundaryEdit,
  DEFAULT_EDITOR_PREFS,
  findTable,
  referencedTables,
  situationBefore,
  sqlCompletionSource,
  statementAt,
  type CompletionData,
  type EditorPrefs,
  type TableEntry
} from '../src/renderer/src/lib/sql-complete'

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

function data(known: string[] = [], prefs: Partial<EditorPrefs> = {}): CompletionData & { loads: string[] } {
  const loaded = new Set(known)
  const loads: string[] = []
  return {
    tables,
    defaultSchema: 'public',
    dialect: 'postgres',
    prefs: { ...DEFAULT_EDITOR_PREFS, ...prefs },
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

describe('reading the statement', () => {
  it('resolves table references and aliases from the query text', () => {
    const refs = referencedTables('select * from users u join public.orders as o on o.user_id = u.id, analytics.users au', data())
    expect(refs.tables.map((r) => [r.alias, `${r.table.schema}.${r.table.name}`])).toEqual([
      ['u', 'public.users'],
      ['o', 'public.orders'],
      ['au', 'analytics.users']
    ])
    expect(findTable(data(), 'users')?.schema).toBe('public')
    expect(findTable(data(), 'analytics.users')?.schema).toBe('analytics')
  })

  it('finds the statement around a position: the block, cut at semicolons', () => {
    const doc = 'select 1;\nselect 2\n\nselect 3 from t'
    expect(statementAt(doc, 3).text).toBe('select 1')
    expect(statementAt(doc, 14).text).toBe('\nselect 2')
    expect(statementAt(doc, doc.length).text).toBe('select 3 from t')
  })

  it('tells tables, columns and keywords apart from what comes before the cursor', () => {
    const mode = (s: string) => situationBefore(s).mode
    expect(mode('')).toBe('statement')
    expect(mode('select 1; ')).toBe('statement')
    expect(mode('select * from ')).toBe('tables')
    expect(mode('select * from users u left join ')).toBe('tables')
    expect(mode('insert into ')).toBe('tables')
    expect(mode('select ')).toBe('columns')
    expect(mode('select id, ')).toBe('columns')
    expect(mode('select * from users where ')).toBe('columns')
    expect(mode('select * from users where id = 1 and ')).toBe('columns')
    expect(mode('select * from users order by ')).toBe('columns')
    expect(mode('update users set ')).toBe('columns')
    expect(mode('insert into users (')).toBe('columns')
    expect(mode('select * from users u join orders o on ')).toBe('columns')
    expect(mode('select * from users ')).toBe('keywords')
    expect(mode('select id ')).toBe('keywords')
    expect(mode('select * ')).toBe('keywords')
    expect(mode('select * from users, ')).toBe('tables')
    expect(mode('select * from users where name = ')).toBe('columns')
    expect(mode('select * from users as ')).toBe('none')
    expect(mode('select * from users limit ')).toBe('none')
    expect(mode('insert into users (id) values (')).toBe('none')
    expect(situationBefore('select count(')).toMatchObject({ mode: 'columns', alsoStatements: true })
    expect(situationBefore('select * from users where token is ')).toMatchObject({ mode: 'keywords', only: ['NULL', 'NOT NULL', 'TRUE', 'FALSE', 'DISTINCT FROM'] })
    expect(situationBefore('select * from users where token is not ').only).toEqual(['NULL', 'TRUE', 'FALSE', 'DISTINCT FROM'])
    expect(mode('select * from users where not ')).toBe('columns')
  })
})

describe('SQL completion', () => {
  it('offers only table names after FROM and JOIN, narrowed by the prefix', async () => {
    const r = await complete(data(), 'select * from us')
    expect(r?.labels).toEqual(['users', 'analytics.users'])
    const j = await complete(data(), 'select * from users u join ')
    expect(j?.labels).toContain('orders')
    expect(j?.labels.some((l) => l === l.toUpperCase() && /^[A-Z ]+$/.test(l))).toBe(false)
  })

  it('offers only column names after SELECT, WHERE and ON, loading them on demand', async () => {
    const d = data()
    const doc = 'select  from users where id = 1'
    const r = await complete(d, doc, 'select '.length)
    expect(r?.labels).toEqual(['id', 'email', 'name'])
    expect(d.loads).toEqual(['public.users'])
    const w = await complete(d, 'select * from users u join orders o on ')
    expect(w?.labels).toEqual(['id', 'email', 'name', 'user_id', 'status', 'total', 'u', 'o'])
    expect(await complete(d, 'select ')).toBeNull()
  })

  it('offers keywords only where one can follow, and statement keywords at the start', async () => {
    const d = data()
    const start = await complete(d, 'se')
    expect(start?.labels).toContain('SELECT')
    expect(start?.labels).not.toContain('WHERE')
    const after = await complete(d, 'select * from users w')
    expect(after?.labels).toContain('WHERE')
    expect(after?.labels).not.toContain('users')
    expect(after?.labels).not.toContain('CASCADE')
    expect(await complete(d, 'select * from users ')).toBeNull()
    // After IS NOT the answer is NULL, never a function that happens to start the same way.
    const afterIsNot = (await complete(d, 'select * from users u where access_token is not nu'))?.labels ?? []
    expect(afterIsNot).toContain('NULL')
    expect(afterIsNot).not.toContain('NULLIF')
    const afterIs = await complete(d, 'select * from users where id is ')
    expect(afterIs?.labels).toEqual(['NULL', 'NOT NULL', 'TRUE', 'FALSE', 'DISTINCT FROM'])
    // Ranked in that order too, since the editor sorts by boost before the alphabet.
    expect(afterIs?.options.map((o) => o.boost)).toEqual([10, 9, 8, 7, 6])
    expect((await complete(d, 'select * from users where id is not '))?.options.map((o) => [o.label, o.boost])).toEqual([['NULL', 10], ['TRUE', 9], ['FALSE', 8], ['DISTINCT FROM', 7]])
  })

  it('completes qualified names: columns of a table or alias, tables of a schema', async () => {
    const d = data(['public.orders'])
    expect((await complete(d, 'select o. from orders o', 'select o.'.length))?.labels).toEqual(['id', 'user_id', 'status', 'total'])
    expect((await complete(d, 'select * from analytics.'))?.labels).toEqual(['daily_totals', 'users'])
  })

  it('follows the preferences: lowercase keywords, no suggestions when off, aliases when picking a table', async () => {
    expect((await complete(data([], { keywordCase: 'lower' }), 'se'))?.labels).toContain('select')
    expect(await complete(data([], { autocomplete: false }), 'select * from us')).toBeNull()
    const r = await complete(data([], { autoAlias: true }), 'select * from ord')
    expect(r?.options.find((o) => o.label === 'orders')?.apply).toBeTypeOf('function')
  })
})

describe('finishing a word', () => {
  const prefs = DEFAULT_EDITOR_PREFS
  it('re-cases keywords when they are finished, in the chosen case', () => {
    expect(boundaryEdit('select', ' ', data(), prefs)).toEqual({ from: 0, to: 6, insert: 'SELECT ' })
    expect(boundaryEdit('select * from users where', '\n', data(), prefs)?.insert).toBe('WHERE\n')
    expect(boundaryEdit('SELECT', ' ', data(), { ...prefs, keywordCase: 'lower' })?.insert).toBe('select ')
    expect(boundaryEdit('select', ' ', data(), { ...prefs, keywordCase: 'off' })).toBeNull()
    expect(boundaryEdit('select', 'x', data(), prefs)).toBeNull()
  })

  it('leaves names, strings, comments and quoted identifiers alone', () => {
    expect(boundaryEdit('select * from users', ' ', data(), prefs)).toBeNull()
    expect(boundaryEdit("select 'from", ' ', data(), prefs)).toBeNull()
    expect(boundaryEdit('-- select', ' ', data(), prefs)).toBeNull()
    expect(boundaryEdit('select "from', ' ', data(), prefs)).toBeNull()
    expect(boundaryEdit('select u.from', ' ', data(), prefs)).toBeNull()
  })

  it('aliases tables after FROM and JOIN when asked, keeping aliases unique', () => {
    const on = { ...prefs, autoAlias: true }
    expect(boundaryEdit('select * from users', ' ', data(), on)?.insert).toBe('users u ')
    expect(boundaryEdit('select * from users u join users', ' ', data(), on)?.insert).toBe('users u2 ')
    expect(boundaryEdit('select * from users u join orders', '\n', data(), on)?.insert).toBe('orders o\n')
    expect(boundaryEdit('insert into users', ' ', data(), on)).toBeNull()
    expect(boundaryEdit('select * from users', ' ', data(), prefs)).toBeNull()
    expect(aliasFor('phone_numbers')).toBe('pn')
    expect(aliasFor('PhoneNumbers')).toBe('pn')
    expect(aliasFor('order_rows')).toBe('or2')
    expect(aliasFor('users', ['u'])).toBe('u2')
  })
})
