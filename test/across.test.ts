// A chat across databases: the model is told about each one, every tool names the database it is for, and in an
// investigation it reads query results, protected so that one value has one placeholder in every database.
import { describe, expect, it } from 'vitest'
import type { AiProgressStep } from '../src/shared/ai'
import type { CellValue, QueryResponse, SchemaInfo } from '../src/shared/types'
import { emptyInstruction, instructionsAcross, type Instruction } from '../src/shared/instructions'
import { askDatabase, type AgentDatabase, type AskDeps } from '../src/main/ai/nl2sql'
import { acrossTools, instructionsPrompt } from '../src/main/ai/prompt'
import { SchemaIndex } from '../src/main/ai/schema-index'
import { ModelGateway } from '../src/main/privacy/gateway'
import { PrivacyEngine } from '../src/main/privacy/engine'
import { PrivacySession } from '../src/main/privacy/session'
import { PiiVault } from '../src/main/privacy/vault'
import type { ChatRequest } from '../src/main/ai/providers/types'
import { placeholders, policy, recordingProvider, reply, wireText, type Script } from './privacy/helpers'

const column = (cid: number, name: string, type: string, pk = 0) => ({ cid, name, type, notnull: false, dflt: null, pk, hidden: 0 })

const ordersSchema: SchemaInfo = {
  kind: 'sqlite',
  tables: [
    {
      name: 'orders',
      type: 'table',
      sql: null,
      columns: [column(0, 'id', 'INTEGER', 1), column(1, 'customer_email', 'TEXT'), column(2, 'total', 'REAL'), column(3, 'created_at', 'TEXT')],
      withoutRowid: false,
      rowidAlias: 'rowid',
      pk: ['id']
    }
  ],
  views: [],
  indexes: [],
  triggers: [],
  relations: []
}

const supportSchema: SchemaInfo = {
  kind: 'postgres',
  defaultSchema: 'public',
  tables: [
    {
      schema: 'public',
      name: 'tickets',
      type: 'table',
      sql: null,
      columns: [column(0, 'id', 'integer', 1), column(1, 'requester_email', 'text'), column(2, 'subject', 'text'), column(3, 'opened_at', 'timestamp')],
      withoutRowid: false,
      rowidAlias: null,
      pk: ['id']
    }
  ],
  views: [],
  indexes: [],
  triggers: [],
  relations: []
}

function rows(sql: string, columns: string[], data: CellValue[][]): QueryResponse {
  return { results: [{ kind: 'rows', sql, columns: columns.map((name) => ({ name })), rows: data, rowCount: data.length, truncated: false, durationMs: 1 }], durationMs: 1, tx: false }
}

interface Fixture {
  deps: AskDeps
  requests: ChatRequest[]
  steps: AiProgressStep[]
  ran: { db: string; sql: string; maxRows: number }[]
}

function fixture(script: Script, opts: { readResults?: boolean; maxToolSteps?: number; results?: Record<string, (sql: string) => QueryResponse> } = {}): Fixture {
  const ran: Fixture['ran'] = []
  const steps: AiProgressStep[] = []
  const provider = recordingProvider(script)
  const session = new PrivacySession({ engine: new PrivacyEngine({ schemaDetection: true }), policy, vault: new PiiVault(), host: 'api.example.com' })
  const database = (key: string, name: string, connectionId: string, kind: 'sqlite' | 'postgres', schema: SchemaInfo): AgentDatabase => ({
    key,
    name,
    connectionId,
    kind,
    serverVersion: kind === 'sqlite' ? '3.45.1' : '16.4',
    index: SchemaIndex.fromSchema(schema, kind),
    runQuery: async (sql, maxRows) => {
      ran.push({ db: key, sql, maxRows })
      return opts.results?.[key]?.(sql) ?? rows(sql, [], [])
    },
    distinctValues: async () => null
  })
  const databases = [database('db1', 'Orders', 'c1', 'sqlite', ordersSchema), database('db2', 'Support', 'c2', 'postgres', supportSchema)]
  const deps: AskDeps = {
    kind: 'sqlite',
    serverVersion: '3.45.1',
    index: databases[0].index,
    runQuery: databases[0].runQuery,
    distinctValues: databases[0].distinctValues,
    databases,
    provider: ModelGateway.protected(provider, session),
    settings: { sendSampleValues: false, autoRun: true, schemaBudgetTokens: 8000, readResults: opts.readResults ?? true },
    now: new Date('2026-10-01T12:00:00Z'),
    maxToolSteps: opts.maxToolSteps,
    onProgress: (s) => steps.push(s)
  }
  return { deps, requests: provider.requests, steps, ran }
}

const lastTool = (req: ChatRequest) => [...req.messages].reverse().find((m) => m.role === 'tool')
const system = (req: ChatRequest) => req.system.map((b) => b.text).join('\n\n')

describe('a chat across databases', () => {
  it('traces a person from one database to another by placeholder, without the model seeing who it is', async () => {
    let placeholder = ''
    const f = fixture(
      (req, call) => {
        if (call === 1) {
          return reply({
            toolCalls: [{ id: 't1', name: 'run_query', args: { database: 'db2', sql: "SELECT id, requester_email, subject, opened_at FROM tickets WHERE subject ILIKE '%refund%' LIMIT 200", purpose: 'refund tickets' } }],
            stopReason: 'tool_calls'
          })
        }
        if (call === 2) {
          // The ticket's requester, as the model sees them: a placeholder.
          placeholder = placeholders(lastTool(req)!.content)[0]
          return reply({
            toolCalls: [{ id: 't2', name: 'run_query', args: { database: 'db1', sql: `SELECT id, customer_email, total, created_at FROM orders WHERE customer_email = '${placeholder}'` } }],
            stopReason: 'tool_calls'
          })
        }
        // The same customer in the orders comes back as the same placeholder.
        expect(placeholders(lastTool(req)!.content)).toEqual([placeholder])
        return reply({ text: `**Timeline**\n\n1. 2026-09-29: order 42 placed by ${placeholder} (Orders).\n2. 2026-09-30: ticket 7, "Refund not received" (Support).` })
      },
      {
        results: {
          db2: (sql) => rows(sql, ['id', 'requester_email', 'subject', 'opened_at'], [[7, 'ann@corp.io', 'Refund not received', '2026-09-30 10:00']]),
          db1: (sql) => rows(sql, ['id', 'customer_email', 'total', 'created_at'], [[42, 'ann@corp.io', 99.5, '2026-09-29 08:00']])
        }
      }
    )
    const result = await askDatabase(f.deps, 'Ann says her refund never came. What happened?')

    // Both databases are described to the model, each by its key, and every tool names the database it is for.
    const rules = system(f.requests[0])
    expect(rules).toContain('- "db1": Orders, SQLite 3.45.1')
    expect(rules).toContain('- "db2": Support, PostgreSQL 16.4 (default schema "public")')
    expect(rules).toContain('## Database "db1": Orders')
    expect(rules).toContain('## Database "db2": Support')
    const runQuery = f.requests[0].tools!.find((t) => t.name === 'run_query')!
    expect((runQuery.parameters as any).properties.database.enum).toEqual(['db1', 'db2'])

    // Each query ran on its own database with real values, read-only, and at most a page of rows.
    expect(f.ran.map((r) => r.db)).toEqual(['db2', 'db1'])
    expect(f.ran[1].sql).toBe("SELECT id, customer_email, total, created_at FROM orders WHERE customer_email = 'ann@corp.io'")
    expect(f.ran.every((r) => r.maxRows === 51)).toBe(true)

    // Nothing that left named Ann's address; the answer shown does.
    expect(wireText(f.requests)).not.toContain('ann@corp.io')
    expect(result.kind).toBe('clarify')
    if (result.kind !== 'clarify') return
    expect(result.message).toContain('order 42 placed by ann@corp.io (Orders)')
    expect(result.queries).toEqual([
      { database: { connectionId: 'c2', name: 'Support' }, sql: "SELECT id, requester_email, subject, opened_at FROM tickets WHERE subject ILIKE '%refund%' LIMIT 200", rows: 1 },
      { database: { connectionId: 'c1', name: 'Orders' }, sql: "SELECT id, customer_email, total, created_at FROM orders WHERE customer_email = 'ann@corp.io'", rows: 1 }
    ])
    expect(result.privacy?.counts.EMAIL_ADDRESS).toBeGreaterThan(0)
    expect(f.steps).toContainEqual(expect.objectContaining({ stage: 'query', status: 'done', message: 'Queried Support: refund tickets', detail: '1 row' }))
  })

  it('proposes a query for the database it names, explained in that database’s dialect', async () => {
    const f = fixture(() =>
      reply({
        toolCalls: [{ id: 'p1', name: 'propose_query', args: { database: 'db2', sql: 'SELECT count(*) FROM tickets', explanation: 'Counts tickets.', tables_used: ['tickets'] } }],
        stopReason: 'tool_calls'
      })
    )
    const result = await askDatabase(f.deps, 'How many tickets are there?', [{ question: 'Orders last week?', sql: 'SELECT * FROM orders', database: 'Orders' }])
    expect(f.ran).toEqual([{ db: 'db2', sql: 'EXPLAIN SELECT count(*) FROM tickets', maxRows: 50 }])
    expect(result).toMatchObject({ kind: 'query', sql: 'SELECT count(*) FROM tickets', database: { connectionId: 'c2', name: 'Support' } })
    // An earlier answer says which database its query was for.
    expect(f.requests[0].messages[1].content).toBe('SQL used on Orders:\nSELECT * FROM orders')
    expect(f.steps).toContainEqual(expect.objectContaining({ stage: 'done', message: 'Query ready for Support' }))
  })

  it('tells the model when it names a database that is not in the chat', async () => {
    const f = fixture((req, call) => {
      if (call === 1) return reply({ toolCalls: [{ id: 't1', name: 'describe_table', args: { database: 'db9', table: 'orders' } }], stopReason: 'tool_calls' })
      expect(lastTool(req)!.content).toBe('Unknown database "db9". Use one of: "db1", "db2".')
      return reply({ toolCalls: [{ id: 't2', name: 'describe_table', args: { database: 'db1', table: 'orders' } }], stopReason: 'tool_calls' })
    }, { maxToolSteps: 2 })
    await askDatabase(f.deps, 'What is in orders?')
    expect(f.steps).toContainEqual(expect.objectContaining({ message: 'Model asked to describe orders in Orders', status: 'done' }))
  })

  it('reads no results unless the setting allows it', async () => {
    const f = fixture(
      (req, call) =>
        call === 1
          ? reply({ toolCalls: [{ id: 't1', name: 'run_query', args: { database: 'db1', sql: 'SELECT * FROM orders' } }], stopReason: 'tool_calls' })
          : reply({ text: 'I cannot read results.' }),
      { readResults: false }
    )
    await askDatabase(f.deps, 'Show me the orders')
    expect(f.requests[0].tools!.map((t) => t.name)).not.toContain('run_query')
    expect(system(f.requests[0])).toContain('You cannot see query results')
    expect(lastTool(f.requests[1])!.content).toBe('Unknown tool run_query.')
    expect(f.ran).toEqual([])
  })

  it('asks for an answer with what was found at the last step', async () => {
    const f = fixture(() => reply({ toolCalls: [{ id: 't', name: 'search_schema', args: { database: 'db1', query: 'refund' } }], stopReason: 'tool_calls' }), { maxToolSteps: 3 })
    const result = await askDatabase(f.deps, 'Where did the refund go?')
    expect(f.requests.map((r) => r.toolChoice)).toEqual(['auto', 'auto', 'none'])
    expect(result).toMatchObject({ kind: 'clarify', message: expect.stringContaining('used every step') })
  })

  it('keeps a wide result to a budget, saying more rows were left out', async () => {
    const wide = Array.from({ length: 50 }, (_, i) => [i, 'x'.repeat(190), 'y'.repeat(190), 'z'.repeat(190)])
    const f = fixture(
      (req, call) =>
        call === 1
          ? reply({ toolCalls: [{ id: 't1', name: 'run_query', args: { database: 'db1', sql: 'SELECT id, a, b, c FROM orders' } }], stopReason: 'tool_calls' })
          : reply({ text: 'Done.' }),
      { results: { db1: (sql) => rows(sql, ['id', 'a', 'b', 'c'], wide) } }
    )
    await askDatabase(f.deps, 'Show wide rows')
    const content = lastTool(f.requests[1])!.content
    expect(content.length).toBeLessThan(13_000)
    expect(content.split('\n')[0]).toMatch(/^\d+ rows from "db1", more not shown: narrow the query or select fewer columns:$/)
  })
})

describe('instructions across databases', () => {
  const make = (partial: Partial<Instruction>): Instruction => ({ ...emptyInstruction(), id: partial.name ?? 'x', name: 'x', text: 'Do this.', createdAt: 0, updatedAt: 0, ...partial })

  it('sends the global ones once, then each database’s own, marked with the databases they are for', () => {
    const list = [
      make({ name: 'Billing dates', scope: 'selected', connectionIds: ['c2', 'c1'], createdAt: 2 }),
      make({ name: 'Style', scope: 'all', createdAt: 1 }),
      make({ name: 'Elsewhere', scope: 'selected', connectionIds: ['c9'], createdAt: 3 }),
      make({ name: 'Support only', scope: 'selected', connectionIds: ['c2'], createdAt: 4 })
    ]
    const across = instructionsAcross(list, [
      { key: 'db1', connectionId: 'c1' },
      { key: 'db2', connectionId: 'c2' }
    ])
    expect(across).toEqual([
      { name: 'Style', text: 'Do this.' },
      { name: 'Billing dates', text: 'Do this.', databases: ['db1', 'db2'] },
      { name: 'Support only', text: 'Do this.', databases: ['db2'] }
    ])
    const prompt = instructionsPrompt(across, true)
    expect(prompt).toContain('### Style\nDo this.')
    expect(prompt).toContain('### Support only (only for "db2")\nDo this.')
  })

  it('offers run_query only with results on, and every tool takes the database', () => {
    expect(acrossTools(['db1', 'db2'], false).map((t) => [t.name, (t.parameters as any).required[0]])).toEqual([
      ['propose_query', 'database'],
      ['search_schema', 'database'],
      ['describe_table', 'database'],
      ['sample_values', 'database']
    ])
    expect(acrossTools(['db1', 'db2'], true).map((t) => t.name)).toContain('run_query')
  })
})
