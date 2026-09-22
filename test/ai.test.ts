import { describe, expect, it } from 'vitest'
import type { ColumnInfo, QueryResponse, Relation, SchemaInfo, TableMeta, TableRef } from '../src/shared/types'
import { SchemaIndex, compactType, estimateTokens, tokenize, type SchemaSource } from '../src/main/ai/schema-index'
import { relationsFromSchema, searchSchema, summarizeTable, tablesFromSchema } from '../src/main/db/catalog'
import type { AiProgressStep } from '../src/shared/ai'
import { checkReadOnlySql, explainStatement } from '../src/main/ai/guard'
import { askDatabase, type AskDeps } from '../src/main/ai/nl2sql'
import { OpenAiCompatibleProvider } from '../src/main/ai/providers/openai'
import { AnthropicProvider } from '../src/main/ai/providers/anthropic'
import { ProviderError, parseJsonObject, type ChatRequest, type ChatResponse, type LlmProvider } from '../src/main/ai/providers/types'
import { providerConfigFor } from '../src/main/ai/providers/factory'
import { systemRules } from '../src/main/ai/prompt'

// ---------------------------------------------------------------- fixtures

function col(name: string, type: string, pk = 0): ColumnInfo {
  return { cid: 0, name, type, notnull: false, dflt: null, pk, hidden: 0 }
}

function table(name: string, columns: ColumnInfo[], extra: Partial<TableMeta> = {}): TableMeta {
  return { name, type: 'table', sql: null, columns, withoutRowid: false, rowidAlias: 'rowid', pk: columns.filter((c) => c.pk > 0).map((c) => c.name), ...extra }
}

function fk(tbl: string, column: string, refTable: string, refColumn = 'id'): Relation {
  return { table: tbl, column, refTable, refColumn }
}

/** A shop schema plus `filler` unrelated tables, to exercise retrieval. */
function shopSchema(filler = 0, kind: 'sqlite' | 'postgres' = 'sqlite'): SchemaInfo {
  const tables: TableMeta[] = [
    table('users', [col('id', 'INTEGER', 1), col('email', 'TEXT'), col('full_name', 'TEXT'), col('plan', 'TEXT'), col('created_at', 'TIMESTAMP')], { rowEstimate: 12_400 }),
    table('orders', [col('id', 'INTEGER', 1), col('user_id', 'INTEGER'), col('status', 'TEXT'), col('total', 'NUMERIC(12,2)'), col('placed_at', 'TIMESTAMP')], { rowEstimate: 250_000 }),
    table('order_items', [col('id', 'INTEGER', 1), col('order_id', 'INTEGER'), col('product_id', 'INTEGER'), col('quantity', 'INTEGER'), col('unit_price', 'NUMERIC')]),
    table('products', [col('id', 'INTEGER', 1), col('sku', 'VARCHAR(40)'), col('title', 'TEXT'), col('category_id', 'INTEGER')]),
    table('categories', [col('id', 'INTEGER', 1), col('name', 'TEXT')]),
    table('invoices', [col('id', 'INTEGER', 1), col('order_id', 'INTEGER'), col('amount', 'NUMERIC'), col('paid_at', 'TIMESTAMP')]),
    table('audit_log', [col('id', 'INTEGER', 1), col('actor', 'TEXT'), col('action', 'TEXT'), col('at', 'TIMESTAMP')])
  ]
  for (let i = 0; i < filler; i++) {
    tables.push(table(`misc_${i}`, [col('id', 'INTEGER', 1), col(`value_${i}`, 'TEXT'), col(`note_${i}`, 'TEXT'), col('updated_at', 'TIMESTAMP')]))
  }
  const relations = [
    fk('orders', 'user_id', 'users'),
    fk('order_items', 'order_id', 'orders'),
    fk('order_items', 'product_id', 'products'),
    fk('products', 'category_id', 'categories'),
    fk('invoices', 'order_id', 'orders')
  ]
  return { kind, tables, views: [], indexes: [], triggers: [], relations }
}

// ---------------------------------------------------------------- schema index

describe('schema index', () => {
  it('tokenizes identifiers the way people ask about them', () => {
    expect(tokenize('customer_addresses')).toEqual(['customer', 'addresses', 'addresse', 'address'].filter((t) => t !== 'addresse'))
    expect(tokenize('orderItems')).toEqual(['order', 'items', 'item'])
    expect(tokenize('Show me the categories')).toEqual(['categories', 'category'])
    expect(compactType('character varying(255)')).toBe('text')
    expect(compactType('timestamp with time zone')).toBe('timestamptz')
    expect(compactType('bigint')).toBe('int')
    expect(compactType('numeric(12,2)')).toBe('numeric')
  })

  it('renders one compact line per table with keys, foreign keys, samples and row estimates', async () => {
    const index = SchemaIndex.fromSchema(shopSchema(), 'sqlite')
    index.samples.set('orders', { status: ['paid', 'pending', 'refunded'] })
    const line = index.lineFor('orders')
    expect(line).toBe('orders(id int pk, user_id int fk->users.id, status text {paid|pending|refunded}, total numeric, placed_at timestamp) ~250k rows')
    expect(index.lineFor('users')).toContain('~12k rows')
    expect(await index.describe('orders')).toContain('referenced by: order_items.order_id, invoices.order_id')
    expect(index.tables.get('orders')!.neighbors).toEqual(new Set(['users', 'order_items', 'invoices']))
  })

  it('sends the whole schema when it fits the budget', async () => {
    const index = SchemaIndex.fromSchema(shopSchema(), 'sqlite')
    const sel = await index.select('how many users are on the pro plan', 8000)
    expect(sel.mode).toBe('all')
    expect(sel.keys.length).toBe(7)
    expect(sel.tokens).toBe(index.totalTokens)
    expect(estimateTokens(index.render(sel, 'x'))).toBeLessThanOrEqual(8000)
  })

  it('retrieves the relevant tables from a huge schema and expands along foreign keys', async () => {
    const index = SchemaIndex.fromSchema(shopSchema(300), 'sqlite')
    expect(index.tables.size).toBe(307)
    expect(index.totalTokens).toBeGreaterThan(4000)
    const sel = await index.select('total invoice amount per customer email for paid invoices', 4000)
    expect(sel.mode).toBe('retrieved')
    expect(sel.tokens).toBeLessThanOrEqual(4000)
    expect(sel.keys).toEqual(expect.arrayContaining(['invoices', 'users', 'orders']))
    // orders was not mentioned but bridges invoices and users
    expect(sel.keys.filter((k) => k.startsWith('misc_')).length).toBeLessThan(sel.keys.length / 2)
    const rendered = index.render(sel, 'invoice customer email')
    expect(rendered.split('\n')).toEqual([...rendered.split('\n')].sort()) // stable order for caching
  })

  it('adapts the number of tables to the budget and boosts recently used tables', async () => {
    const index = SchemaIndex.fromSchema(shopSchema(300), 'sqlite')
    // A question matching hundreds of tables fills whatever budget it is given.
    const small = await index.select('misc values and notes updated', 600)
    const large = await index.select('misc values and notes updated', 3000)
    expect(small.tokens).toBeLessThanOrEqual(600)
    expect(large.tokens).toBeLessThanOrEqual(3000)
    expect(small.keys.length).toBeLessThan(large.keys.length)
    expect(large.keys.length).toBeGreaterThan(20)
    // A specific question stays focused: the matches, their neighbours, and no padding with unrelated tables.
    const focused = await index.select('products in each category', 3000)
    expect(focused.keys).toEqual(expect.arrayContaining(['products', 'categories', 'order_items']))
    expect(focused.keys.some((k) => k.startsWith('misc_'))).toBe(false)
    // Recently used tables are kept in view for follow-up questions.
    const boosted = await index.select('anything at all really', 600, { recentKeys: ['audit_log'] })
    expect(boosted.keys).toContain('audit_log')
    // With no match at all, the most connected tables are the best guess.
    const hubs = await index.select('zzz qqq', 400)
    expect(hubs.keys).toContain('orders')
  })

  it('shortens very wide tables to keys, foreign keys and matching columns', () => {
    const cols = [col('id', 'INTEGER', 1), col('account_id', 'INTEGER'), ...Array.from({ length: 90 }, (_, i) => col(`metric_${i}`, 'REAL')), col('churn_risk', 'REAL')]
    const schema: SchemaInfo = {
      kind: 'postgres',
      defaultSchema: 'public',
      tables: [table('wide', cols, { schema: 'public' }), table('accounts', [col('id', 'INTEGER', 1), col('name', 'TEXT')], { schema: 'public' }), table('events', [col('id', 'INTEGER', 1)], { schema: 'analytics' })],
      views: [],
      indexes: [],
      triggers: [],
      relations: [{ schema: 'public', table: 'wide', column: 'account_id', refSchema: 'public', refTable: 'accounts', refColumn: 'id' }]
    }
    const index = SchemaIndex.fromSchema(schema, 'postgres')
    expect([...index.tables.keys()]).toEqual(['wide', 'accounts', 'analytics.events'])
    const short = index.lineFor('wide', { full: false, matchTerms: tokenize('churn risk') })
    expect(short).toContain('account_id int fk->accounts.id')
    expect(short).toContain('churn_risk float')
    expect(short).toMatch(/\+\d+ more columns/)
    expect(short.length).toBeLessThan(index.lineFor('wide', { full: true }).length / 2)
    expect(index.find('analytics.events')?.key).toBe('analytics.events')
    expect(index.find('events')?.key).toBe('analytics.events')
    expect(index.find('public.accounts')?.key).toBe('accounts')
  })

  it('loads columns and keys only for the tables a question needs', async () => {
    const schema = shopSchema(3000)
    const calls = { meta: [] as string[], rel: [] as string[], search: [] as string[] }
    const source: SchemaSource = {
      listTables: async () => [...schema.tables, ...schema.views].map(summarizeTable),
      tablesMeta: async (refs) => {
        calls.meta.push(...refs.map((r) => r.name))
        return tablesFromSchema(schema, refs)
      },
      relationsFor: async (refs) => {
        calls.rel.push(...refs.map((r) => r.name))
        return relationsFromSchema(schema, refs)
      },
      searchColumns: async (q, limit) => {
        calls.search.push(q)
        return searchSchema(schema, q, limit).columns
      }
    }
    const index = await SchemaIndex.create(source, 'sqlite', undefined)
    expect(index.tables.size).toBe(3007)
    expect(calls.meta).toEqual([]) // nothing is described up front on a big schema
    expect(index.totalTokens).toBeGreaterThan(50_000)
    const sel = await index.select('paid invoices per customer email', 3000)
    expect(sel.mode).toBe('retrieved')
    expect(sel.keys).toEqual(expect.arrayContaining(['invoices', 'orders', 'users']))
    expect(calls.meta.length).toBeLessThan(200)
    expect(calls.meta).toEqual(expect.arrayContaining(['invoices', 'orders', 'users']))
    expect(calls.rel).toContain('invoices')
    expect(index.lineFor('invoices')).toContain('order_id int fk->orders.id')
    // Once columns are known they count towards ranking.
    expect(index.rank('email')[0]?.key).toBe('users')
    // search_schema falls through to the database's column search for words that are not table names.
    const lines = await index.search('sku', 5)
    expect(calls.search).toContain('sku')
    expect(lines.some((l) => l.startsWith('products('))).toBe(true)
    expect(await index.describe('categories')).toContain('referenced by: products.category_id')
  })

  it('preloads small schemas whole through a source', async () => {
    const schema = shopSchema()
    const source: SchemaSource = {
      listTables: async () => [...schema.tables, ...schema.views].map(summarizeTable),
      tablesMeta: async (refs) => tablesFromSchema(schema, refs),
      relationsFor: async (refs) => relationsFromSchema(schema, refs)
    }
    const index = await SchemaIndex.create(source, 'sqlite', undefined)
    expect([...index.tables.values()].every((t) => t.meta && t.relationsLoaded)).toBe(true)
    const sel = await index.select('anything', 8000)
    expect(sel.mode).toBe('all')
    expect(index.lineFor('orders')).toContain('user_id int fk->users.id')
  })

  it('fuses embeddings with keyword search when vectors are available', () => {
    const index = SchemaIndex.fromSchema(shopSchema(50), 'sqlite')
    const vectors = new Map<string, number[]>()
    for (const key of index.tables.keys()) vectors.set(key, key === 'audit_log' ? [1, 0] : [0, 1])
    index.setEmbeddings(vectors)
    const ranked = index.rank('who changed things yesterday', [1, 0])
    expect(ranked[0].key).toBe('audit_log')
  })
})

// ---------------------------------------------------------------- guard

describe('read-only guard', () => {
  it('accepts a single SELECT or CTE and strips the trailing semicolon', () => {
    expect(checkReadOnlySql('SELECT 1;')).toEqual({ ok: true, sql: 'SELECT 1' })
    expect(checkReadOnlySql("with x as (select 1) select * from x where note = 'delete me'")).toMatchObject({ ok: true })
    expect(checkReadOnlySql('SELECT * FROM t -- drop table t')).toMatchObject({ ok: true })
  })

  it('rejects writes, multiple statements and data-modifying CTEs', () => {
    expect(checkReadOnlySql('DELETE FROM users')).toMatchObject({ ok: false, reason: expect.stringContaining('DELETE') })
    expect(checkReadOnlySql('SELECT 1; DROP TABLE users')).toMatchObject({ ok: false, reason: expect.stringContaining('single statement') })
    expect(checkReadOnlySql('WITH d AS (DELETE FROM users RETURNING id) SELECT * FROM d')).toMatchObject({ ok: false, reason: expect.stringContaining('DELETE') })
    expect(checkReadOnlySql('SELECT * INTO backup FROM users')).toMatchObject({ ok: false })
    expect(checkReadOnlySql('PRAGMA query_only = 0')).toMatchObject({ ok: false })
    expect(checkReadOnlySql('')).toMatchObject({ ok: false })
    expect(explainStatement('sqlite', 'SELECT 1')).toBe('EXPLAIN QUERY PLAN SELECT 1')
    expect(explainStatement('postgres', 'SELECT 1')).toBe('EXPLAIN SELECT 1')
  })

  it('parses JSON out of prose and fences', () => {
    expect(parseJsonObject('Sure! ```json\n{"sql": "SELECT 1", "x": {"y": "}"}}\n``` done')).toEqual({ sql: 'SELECT 1', x: { y: '}' } })
    expect(parseJsonObject('no json here')).toBeNull()
  })
})

// ---------------------------------------------------------------- orchestrator

type Script = (req: ChatRequest, call: number) => ChatResponse

function fakeProvider(script: Script, opts: { supportsEmbeddings?: boolean } = {}): LlmProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = []
  return {
    kind: 'fake',
    model: 'fake-1',
    supportsEmbeddings: opts.supportsEmbeddings ?? false,
    requests,
    async complete(req, signal) {
      if (signal?.aborted) throw new ProviderError('Cancelled.', 'cancelled')
      requests.push(structuredClone(req))
      return script(req, requests.length)
    },
    async embed(texts) {
      return texts.map(() => [1, 0])
    },
    async listModels() {
      return ['fake-1']
    }
  }
}

function reply(partial: Partial<ChatResponse>): ChatResponse {
  return { text: '', toolCalls: [], usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 }, model: 'fake-1', stopReason: 'stop', ...partial }
}

function propose(args: Record<string, unknown>, id = 'call_1'): ChatResponse {
  return reply({ toolCalls: [{ id, name: 'propose_query', args }], stopReason: 'tool_calls' })
}

function deps(provider: LlmProvider, overrides: Partial<AskDeps> = {}): AskDeps & { ran: string[] } {
  const ran: string[] = []
  const index = SchemaIndex.fromSchema(shopSchema(), 'sqlite')
  return {
    kind: 'sqlite',
    serverVersion: '3.45.1',
    index,
    provider,
    settings: { sendSampleValues: false, autoRun: true, schemaBudgetTokens: 8000 },
    runQuery: async (sql): Promise<QueryResponse> => {
      ran.push(sql)
      return { results: [{ kind: 'rows', sql, columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 1 }], durationMs: 1, tx: false }
    },
    distinctValues: async (_ref: TableRef, column: string) => (column === 'status' ? ['paid', 'pending'] : null),
    now: new Date(2026, 8, 22),
    ran,
    ...overrides
  }
}

describe('ask orchestrator', () => {
  it('returns a verified query with explanation, usage and context info', async () => {
    const provider = fakeProvider(() => propose({ sql: 'SELECT count(*) FROM users WHERE plan = \'pro\';', explanation: 'Counts pro users.', tables_used: ['users'], assumptions: ['plan is stored lowercase'] }))
    const d = deps(provider)
    const res = await askDatabase(d, 'how many pro users?')
    expect(res.kind).toBe('query')
    if (res.kind !== 'query') return
    expect(res.sql).toBe("SELECT count(*) FROM users WHERE plan = 'pro'")
    expect(res.explanation).toBe('Counts pro users.')
    expect(res.tablesUsed).toEqual(['users'])
    expect(res.assumptions).toEqual(['plan is stored lowercase'])
    expect(res.checks).toEqual({ readOnly: true, explained: true, repairs: 0 })
    expect(res.autoRun).toBe(true)
    expect(res.context).toMatchObject({ mode: 'all', tables: 7, totalTables: 7 })
    expect(res.usage).toMatchObject({ requests: 1, inputTokens: 100, outputTokens: 20, toolCalls: 0, model: 'fake-1' })
    expect(d.ran).toEqual(["EXPLAIN QUERY PLAN SELECT count(*) FROM users WHERE plan = 'pro'"])
    const req = provider.requests[0]
    expect(req.system[0].text).toContain('SQLite (3.45.1)')
    expect(req.system[0].text).toContain('Today is 2026-09-22')
    expect(req.system[1].cacheable).toBe(true)
    expect(req.system[1].text).toContain('## Schema (all 7 tables)')
    expect(req.system[1].text).toContain('orders(id int pk, user_id int fk->users.id')
    expect(req.tools?.map((t) => t.name)).toEqual(['propose_query', 'search_schema', 'describe_table', 'sample_values'])
  })

  it('feeds EXPLAIN failures back to the model and repairs the query', async () => {
    const provider = fakeProvider((_req, call) =>
      call === 1
        ? propose({ sql: 'SELECT count(*) FROM users WHERE tier = \'pro\'', explanation: 'x', tables_used: ['users'] })
        : propose({ sql: 'SELECT count(*) FROM users WHERE plan = \'pro\'', explanation: 'fixed', tables_used: ['users'] }, 'call_2')
    )
    const d = deps(provider, {
      runQuery: async (sql) => {
        if (sql.includes('tier')) return { results: [{ kind: 'error', sql, message: 'no such column: tier', durationMs: 1 }], durationMs: 1, tx: false }
        return { results: [{ kind: 'rows', sql, columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 1 }], durationMs: 1, tx: false }
      }
    })
    const res = await askDatabase(d, 'how many pro users?')
    expect(res.kind).toBe('query')
    if (res.kind !== 'query') return
    expect(res.sql).toContain('plan')
    expect(res.checks).toEqual({ readOnly: true, explained: true, repairs: 1 })
    expect(res.usage.requests).toBe(2)
    const second = provider.requests[1]
    const toolMsg = second.messages.find((m) => m.role === 'tool')
    expect(toolMsg && toolMsg.role === 'tool' ? toolMsg.content : '').toContain('no such column: tier')
  })

  it('answers every tool call of a turn when the proposal in it needs repair', async () => {
    const provider = fakeProvider((_req, call) =>
      call === 1
        ? reply({
            toolCalls: [
              { id: 'p1', name: 'propose_query', args: { sql: 'SELECT nope FROM users', explanation: 'x', tables_used: ['users'] } },
              { id: 's1', name: 'search_schema', args: { query: 'invoice' } }
            ]
          })
        : propose({ sql: 'SELECT email FROM users', explanation: 'ok', tables_used: ['users'] }, 'p2')
    )
    const d = deps(provider, {
      runQuery: async (sql) =>
        sql.includes('nope')
          ? { results: [{ kind: 'error', sql, message: 'no such column: nope', durationMs: 1 }], durationMs: 1, tx: false }
          : { results: [{ kind: 'rows', sql, columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 1 }], durationMs: 1, tx: false }
    })
    const res = await askDatabase(d, 'user emails')
    expect(res).toMatchObject({ kind: 'query', sql: 'SELECT email FROM users' })
    const second = provider.requests[1].messages
    const toolReplies = second.filter((m) => m.role === 'tool') as { toolCallId: string; content: string }[]
    expect(toolReplies.map((m) => m.toolCallId)).toEqual(['p1', 's1'])
    expect(toolReplies[0].content).toContain('no such column: nope')
    expect(toolReplies[1].content).toContain('No further tables match') // the small schema was shown in full already
  })

  it('gives up after the repair limit and refuses writes without ever running them', async () => {
    const provider = fakeProvider((_req, call) => propose({ sql: 'DELETE FROM users', explanation: 'x', tables_used: ['users'] }, `call_${call}`))
    const d = deps(provider)
    const res = await askDatabase(d, 'remove everyone')
    expect(res.kind).toBe('clarify')
    if (res.kind !== 'clarify') return
    expect(res.message).toContain('DELETE')
    expect(res.usage.requests).toBe(3) // initial + 2 repairs
    expect(d.ran).toEqual([])
  })

  it('answers schema tools locally and lets the model explore before proposing', async () => {
    const provider = fakeProvider((_req, call) => {
      if (call === 1) return reply({ toolCalls: [{ id: 'c1', name: 'search_schema', args: { query: 'invoice payment' } }, { id: 'c2', name: 'describe_table', args: { table: 'orders' } }] })
      if (call === 2) return reply({ toolCalls: [{ id: 'c3', name: 'sample_values', args: { table: 'orders', column: 'status' } }] })
      return propose({ sql: 'SELECT o.id FROM orders o LEFT JOIN invoices i ON i.order_id = o.id WHERE i.id IS NULL', explanation: 'orders without invoices', tables_used: ['orders', 'invoices'] })
    })
    const d = deps(provider, { settings: { sendSampleValues: true, autoRun: false, schemaBudgetTokens: 8000 } })
    const res = await askDatabase(d, 'orders without an invoice')
    expect(res.kind).toBe('query')
    if (res.kind !== 'query') return
    expect(res.autoRun).toBe(false)
    expect(res.usage.toolCalls).toBe(3)
    const toolReplies = provider.requests[2].messages.filter((m) => m.role === 'tool') as { content: string; name: string }[]
    expect(toolReplies.map((m) => m.name)).toEqual(['search_schema', 'describe_table', 'sample_values'])
    expect(toolReplies[1].content).toContain('orders(id int pk, user_id int fk->users.id, status text {paid|pending}')
    expect(toolReplies[2].content).toBe('paid | pending')
    // Sample values were also folded into the schema block once loaded.
    expect(provider.requests[0].system[1].text).toContain('{paid|pending}')
  })

  it('passes clarification requests through and includes conversation history', async () => {
    const provider = fakeProvider(() => propose({ sql: '', explanation: '', tables_used: [], needs_clarification: 'Which year do you mean?' }))
    const d = deps(provider)
    const res = await askDatabase(d, 'sales for that year', [{ question: 'sales for 2025', sql: 'SELECT sum(total) FROM orders' }])
    expect(res).toMatchObject({ kind: 'clarify', message: 'Which year do you mean?' })
    const msgs = provider.requests[0].messages
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(msgs[1].role === 'assistant' ? msgs[1].content : '').toContain('SELECT sum(total) FROM orders')
    // A clarification exchange is replayed as the model's own words.
    const again = fakeProvider(() => propose({ sql: 'SELECT count(*) FROM orders', explanation: 'x', tables_used: ['orders'] }))
    await askDatabase(deps(again), '2025', [{ question: 'sales for that year', answer: 'Which year do you mean?' }])
    const replay = again.requests[0].messages
    expect(replay.map((m) => (m.role === 'assistant' ? m.content : m.role))).toEqual(['user', 'Which year do you mean?', 'user'])
  })

  it('falls back to JSON answers when the model cannot call tools', async () => {
    const provider = fakeProvider((req, call) => {
      if (call === 1) throw new ProviderError('tools are not supported by this model', 'tools_unsupported', 400)
      expect(req.tools).toBeUndefined()
      return reply({ text: 'Here you go:\n```json\n{"sql": "SELECT count(*) FROM orders", "explanation": "Counts orders.", "tables_used": ["orders"]}\n```' })
    })
    const d = deps(provider)
    const res = await askDatabase(d, 'how many orders')
    expect(res).toMatchObject({ kind: 'query', sql: 'SELECT count(*) FROM orders', explanation: 'Counts orders.' })
    expect(provider.requests[1].system[0].text).toContain('single JSON object')
  })

  it('retrieves a subset and uses embeddings when the schema is larger than the budget', async () => {
    const provider = fakeProvider(() => propose({ sql: 'SELECT count(*) FROM invoices', explanation: 'x', tables_used: ['invoices'] }), { supportsEmbeddings: true })
    const index = SchemaIndex.fromSchema(shopSchema(300), 'sqlite')
    const d = deps(provider, { index, settings: { sendSampleValues: false, autoRun: true, schemaBudgetTokens: 4000, embeddingModel: 'fake-embed' } })
    const res = await askDatabase(d, 'how many invoices were paid')
    expect(res.kind).toBe('query')
    if (res.kind !== 'query') return
    expect(res.context.mode).toBe('retrieved')
    expect(res.context.tables).toBeLessThan(res.context.totalTables)
    expect(res.context.schemaTokens).toBeLessThanOrEqual(4000)
    expect(provider.requests[0].system[1].text).toMatch(/## Schema excerpt \(\d+ of 307 tables/)
    expect(provider.requests[0].system[1].text).toContain('invoices(')
  })

  it('reports each step while it works', async () => {
    const provider = fakeProvider((_req, call) =>
      call === 1 ? reply({ toolCalls: [{ id: 'c1', name: 'describe_table', args: { table: 'orders' } }] }) : propose({ sql: 'SELECT count(*) FROM orders', explanation: 'x', tables_used: ['orders'] })
    )
    const steps: AiProgressStep[] = []
    const d = deps(provider, { onProgress: (s) => steps.push(s) })
    const res = await askDatabase(d, 'how many orders')
    expect(res.kind).toBe('query')
    const finished = steps.filter((s) => s.status !== 'running')
    expect(finished.map((s) => s.stage)).toEqual(['retrieve', 'request', 'tool', 'request', 'check', 'done'])
    expect(finished[0].detail).toMatch(/all 7 tables/)
    expect(finished[2].message).toContain('describe orders')
    expect(finished[2].detail).toBe('5 columns')
    expect(finished[4].detail).toBe('EXPLAIN passed')
    for (const s of steps.filter((x) => x.status === 'running')) expect(finished.some((f) => f.stepId === s.stepId)).toBe(true)
  })

  it('stops when cancelled and says so', async () => {
    const controller = new AbortController()
    const provider = fakeProvider(() => {
      controller.abort()
      return reply({ toolCalls: [{ id: 'c1', name: 'search_schema', args: { query: 'invoice' } }] })
    })
    const steps: AiProgressStep[] = []
    const d = deps(provider, { onProgress: (s) => steps.push(s), signal: controller.signal })
    const res = await askDatabase(d, 'how many invoices')
    expect(res.kind).toBe('cancelled')
    expect(provider.requests.length).toBe(1)
    expect(steps[steps.length - 1]).toMatchObject({ stage: 'cancelled', status: 'done' })
  })

  it('handles empty input without calling the provider', async () => {
    const provider = fakeProvider(() => {
      throw new Error('should not be called')
    })
    const res = await askDatabase(deps(provider), '   ')
    expect(res.kind).toBe('clarify')
    expect(systemRules('postgres', 'PostgreSQL 16.2', '2026-01-01', 'public')).toContain('ILIKE')
  })
})

// ---------------------------------------------------------------- HTTP adapters

function mockFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit; json: any }[] = []
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const json = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url, init: init ?? {}, json })
    const { status = 200, body } = handler(url, init ?? {})
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { fn, calls }
}

describe('OpenAI-compatible adapter', () => {
  const req: ChatRequest = {
    system: [{ text: 'rules' }, { text: 'schema', cacheable: true }],
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'search_schema', args: { query: 'x' } }] },
      { role: 'tool', toolCallId: 'c1', name: 'search_schema', content: 'lines' }
    ],
    tools: [{ name: 'propose_query', description: 'd', parameters: { type: 'object' } }],
    toolChoice: 'auto'
  }

  it('maps messages and tools to chat-completions and reads tool calls back', async () => {
    const { fn, calls } = mockFetch(() => ({
      body: {
        model: 'gpt-x',
        choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'propose_query', arguments: '{"sql":"SELECT 1"}' } }] } }],
        usage: { prompt_tokens: 500, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 400 } }
      }
    }))
    const p = new OpenAiCompatibleProvider(providerConfigFor({ provider: 'openai', baseUrl: 'https://api.openai.com/v1/', model: 'gpt-x', embeddingModel: '' }, 'sk-test', { fetchImpl: fn }))
    const res = await p.complete(req)
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions')
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer sk-test')
    const body = calls[0].json
    expect(body.model).toBe('gpt-x')
    expect(body.messages[0]).toEqual({ role: 'system', content: 'rules\n\nschema' })
    expect(body.messages[2].tool_calls[0]).toMatchObject({ id: 'c1', type: 'function', function: { name: 'search_schema', arguments: '{"query":"x"}' } })
    expect(body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'lines' })
    expect(body.tools[0]).toMatchObject({ type: 'function', function: { name: 'propose_query' } })
    expect(body.temperature).toBeUndefined()
    expect(res.toolCalls).toEqual([{ id: 'call_9', name: 'propose_query', args: { sql: 'SELECT 1' } }])
    expect(res.usage).toEqual({ inputTokens: 500, outputTokens: 30, cachedInputTokens: 400 })
    expect(res.model).toBe('gpt-x')
  })

  it('lists models, embeds in order and turns HTTP errors into readable messages', async () => {
    const { fn } = mockFetch((url) => {
      if (url.endsWith('/models')) return { body: { data: [{ id: 'b' }, { id: 'a' }] } }
      if (url.endsWith('/embeddings')) return { body: { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] } }
      return { status: 401, body: { error: { message: 'Incorrect API key provided' } } }
    })
    const p = new OpenAiCompatibleProvider(providerConfigFor({ provider: 'ollama', baseUrl: '', model: 'llama3', embeddingModel: 'nomic-embed-text' }, null, { fetchImpl: fn }))
    expect(await p.listModels()).toEqual(['a', 'b'])
    expect(await p.embed(['x', 'y'])).toEqual([[1, 0], [0, 1]])
    await expect(p.complete({ system: [], messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ errorKind: 'auth', message: expect.stringContaining('Incorrect API key') })
  })

  it('flags servers that reject tool definitions so the caller can fall back', async () => {
    const { fn } = mockFetch(() => ({ status: 400, body: { error: { message: 'this model does not support function calling' } } }))
    const p = new OpenAiCompatibleProvider(providerConfigFor({ provider: 'custom', baseUrl: 'http://localhost:8000/v1', model: 'm', embeddingModel: '' }, null, { fetchImpl: fn }))
    await expect(p.complete(req)).rejects.toMatchObject({ errorKind: 'tools_unsupported' })
  })

  it('reports unreachable servers plainly', async () => {
    const failing = (async () => {
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    }) as unknown as typeof fetch
    const p = new OpenAiCompatibleProvider(providerConfigFor({ provider: 'ollama', baseUrl: '', model: 'm', embeddingModel: '' }, null, { fetchImpl: failing }))
    await expect(p.listModels()).rejects.toMatchObject({ errorKind: 'network', message: expect.stringContaining('Is the local server running?') })
  })
})

describe('Anthropic adapter', () => {
  it('maps to the Messages API with cache control, groups tool results and reads tool_use blocks', async () => {
    const { fn, calls } = mockFetch(() => ({
      body: {
        model: 'claude-x',
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Looking.' },
          { type: 'tool_use', id: 'toolu_1', name: 'propose_query', input: { sql: 'SELECT 2' } }
        ],
        usage: { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 800 }
      }
    }))
    const p = new AnthropicProvider(providerConfigFor({ provider: 'anthropic', baseUrl: '', model: 'claude-x', embeddingModel: '' }, 'sk-ant', { fetchImpl: fn }))
    const res = await p.complete({
      system: [{ text: 'rules' }, { text: 'schema', cacheable: true }],
      messages: [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'a', name: 'search_schema', args: { query: 'x' } },
            { id: 'b', name: 'describe_table', args: { table: 't' } }
          ]
        },
        { role: 'tool', toolCallId: 'a', name: 'search_schema', content: 'r1' },
        { role: 'tool', toolCallId: 'b', name: 'describe_table', content: 'r2' }
      ],
      tools: [{ name: 'propose_query', description: 'd', parameters: { type: 'object' } }],
      toolChoice: 'auto'
    })
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages')
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-ant')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    const body = calls[0].json
    expect(body.max_tokens).toBe(2048)
    expect(body.system).toEqual([
      { type: 'text', text: 'rules' },
      { type: 'text', text: 'schema', cache_control: { type: 'ephemeral' } }
    ])
    expect(body.messages[1].content.map((c: any) => c.type)).toEqual(['tool_use', 'tool_use'])
    expect(body.messages[2].role).toBe('user')
    expect(body.messages[2].content.map((c: any) => c.tool_use_id)).toEqual(['a', 'b'])
    expect(body.tools[0]).toMatchObject({ name: 'propose_query', input_schema: { type: 'object' } })
    expect(body.tool_choice).toEqual({ type: 'auto' })
    expect(res.text).toBe('Looking.')
    expect(res.toolCalls).toEqual([{ id: 'toolu_1', name: 'propose_query', args: { sql: 'SELECT 2' } }])
    expect(res.usage).toEqual({ inputTokens: 900, outputTokens: 40, cachedInputTokens: 800 })
    expect(p.supportsEmbeddings).toBe(false)
  })

  it('lists models and surfaces rate limits', async () => {
    const { fn } = mockFetch((url) => (url.includes('/v1/models') ? { body: { data: [{ id: 'claude-b' }, { id: 'claude-a' }] } } : { status: 429, body: { error: { message: 'slow down' } } }))
    const p = new AnthropicProvider(providerConfigFor({ provider: 'anthropic', baseUrl: '', model: 'claude-x', embeddingModel: '' }, 'k', { fetchImpl: fn }))
    expect(await p.listModels()).toEqual(['claude-a', 'claude-b'])
    await expect(p.complete({ system: [], messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ errorKind: 'rate_limit' })
  })
})
