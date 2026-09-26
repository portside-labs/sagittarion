// The orchestrator with Local AI Privacy on: what the model is sent, what runs, what the chat shows.
import { describe, expect, it } from 'vitest'
import type { ColumnInfo, QueryResponse, SchemaInfo, TableMeta } from '../../src/shared/types'
import type { AiProgressStep, AiQueryResult, AiTurn } from '../../src/shared/ai'
import { SchemaIndex } from '../../src/main/ai/schema-index'
import { askDatabase, type AskDeps } from '../../src/main/ai/nl2sql'
import { ModelGateway } from '../../src/main/privacy/gateway'
import { PrivacyEngine } from '../../src/main/privacy/engine'
import { PrivacyBlockedError } from '../../src/main/privacy/errors'
import { PrivacySession } from '../../src/main/privacy/session'
import { PiiVault } from '../../src/main/privacy/vault'
import type { ChatRequest, ChatResponse } from '../../src/main/ai/providers/types'
import type { SensitiveDataDetector } from '../../src/main/privacy/types'
import { EXAMPLE_IDS } from '../../src/main/privacy/markers'
import { placeholders, policy, recordingProvider, reply, wireText } from './helpers'

function col(name: string, type: string, pk = 0): ColumnInfo {
  return { cid: 0, name, type, notnull: false, dflt: null, pk, hidden: 0 }
}
function table(name: string, columns: ColumnInfo[], extra: Partial<TableMeta> = {}): TableMeta {
  return { name, type: 'table', sql: null, columns, withoutRowid: false, rowidAlias: 'rowid', pk: columns.filter((c) => c.pk > 0).map((c) => c.name), ...extra }
}

function crmSchema(): SchemaInfo {
  return {
    kind: 'sqlite',
    tables: [
      table('users', [col('id', 'INTEGER', 1), col('first_name', 'TEXT'), col('email', 'TEXT'), col('plan', 'TEXT'), col('notes', 'TEXT')], { comment: 'Owned by Dr. Quinlan Vasquez' }),
      table('orders', [col('id', 'INTEGER', 1), col('user_id', 'INTEGER'), col('status', 'TEXT'), col('card_number', 'TEXT')])
    ],
    views: [],
    indexes: [],
    triggers: [],
    relations: [{ table: 'orders', column: 'user_id', refTable: 'users', refColumn: 'id' }]
  }
}

/** Sample values of a small CRM, some of them personal. */
const SAMPLES: Record<string, string[]> = {
  first_name: ['Zed', 'Ann', 'Quorra'],
  email: ['zed@corp.io', 'ann@corp.io'],
  plan: ['free', 'pro'],
  notes: ['VIP, call 555-867-5309'],
  status: ['paid', 'pending'],
  card_number: ['4111 1111 1111 1111']
}

function rows(sql: string): QueryResponse {
  return { results: [{ kind: 'rows', sql, columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 1 }], durationMs: 1, tx: false }
}

interface Harness {
  deps: AskDeps
  provider: ReturnType<typeof recordingProvider>
  vault: PiiVault
  ran: string[]
  steps: AiProgressStep[]
}

function harness(script: (req: ChatRequest, call: number) => ChatResponse, opts: { vault?: PiiVault; samples?: boolean; runQuery?: AskDeps['runQuery']; engine?: PrivacyEngine } = {}): Harness {
  const provider = recordingProvider(script)
  const vault = opts.vault ?? new PiiVault()
  const session = new PrivacySession({ engine: opts.engine ?? new PrivacyEngine({ schemaDetection: true }), policy, vault, host: 'api.example.com' })
  const ran: string[] = []
  const steps: AiProgressStep[] = []
  const deps: AskDeps = {
    kind: 'sqlite',
    serverVersion: '3.45.1',
    index: SchemaIndex.fromSchema(crmSchema(), 'sqlite'),
    provider: ModelGateway.protected(provider, session),
    settings: { sendSampleValues: opts.samples ?? true, autoRun: true, schemaBudgetTokens: 8000 },
    runQuery:
      opts.runQuery ??
      (async (sql) => {
        ran.push(sql)
        return rows(sql)
      }),
    distinctValues: async (_ref, column) => SAMPLES[column] ?? null,
    now: new Date(2026, 8, 24),
    onProgress: (s) => steps.push(s)
  }
  return { deps, provider, vault, ran, steps }
}

function propose(args: Record<string, unknown>, id = 'call_1'): ChatResponse {
  return reply({ toolCalls: [{ id, name: 'propose_query', args }], stopReason: 'tool_calls' })
}

/** The placeholder the model was given for a value, found in the request it received (not the instructions' examples). */
function tokenIn(req: ChatRequest, tag: string, nth = 0): string {
  const found = [...new Set([...wireText(req).matchAll(new RegExp(`<\\|PII:${tag}:[0-9A-F]{6}\\|>`, 'g'))].map((m) => m[0]))].filter((t) => !EXAMPLE_IDS.some((id) => t.includes(id)))
  if (!found[nth]) throw new Error(`no ${tag} placeholder #${nth} in the request`)
  return found[nth]
}

/** The placeholder in the question itself: the last message the user sent. */
function tokenInQuestion(req: ChatRequest, tag: string): string {
  const question = [...req.messages].reverse().find((m) => m.role === 'user')!
  return tokenIn({ system: [], messages: [question] }, tag)
}

const RAW = ['jack@example.com', 'Jack', 'Zed', 'Ann', 'Quorra', 'zed@corp.io', 'ann@corp.io', '555-867-5309', '4111 1111 1111 1111', 'Quinlan', 'Vasquez', 'hunter2']

function expectNothingRaw(requests: ChatRequest[]): void {
  const sent = wireText(requests)
  for (const value of RAW) expect(sent, `the provider must not receive "${value}"`).not.toContain(value)
}

describe('asking with Local AI Privacy', () => {
  it('sends placeholders, runs the restored SQL and shows real values', async () => {
    const h = harness((req) => {
      const email = tokenInQuestion(req, 'EMAIL')
      return propose({
        sql: `SELECT o.* FROM orders o JOIN users u ON u.id = o.user_id WHERE u.email = '${email}';`,
        explanation: `Orders placed by ${email}.`,
        tables_used: ['orders', 'users'],
        assumptions: [`${email} is stored lower case`]
      })
    })
    const res = (await askDatabase(h.deps, 'orders for jack@example.com, the customer Jack')) as AiQueryResult
    expect(res.kind).toBe('query')
    expect(res.sql).toBe("SELECT o.* FROM orders o JOIN users u ON u.id = o.user_id WHERE u.email = 'jack@example.com'")
    expect(res.explanation).toBe('Orders placed by jack@example.com.')
    expect(res.assumptions).toEqual(['jack@example.com is stored lower case'])
    expect(res.autoRun).toBe(true)
    expect(h.ran).toEqual(["EXPLAIN QUERY PLAN SELECT o.* FROM orders o JOIN users u ON u.id = o.user_id WHERE u.email = 'jack@example.com'"])
    expectNothingRaw(h.provider.requests)

    const req = h.provider.requests[0]
    // The instructions explain placeholders; the schema keeps identifiers and hides data.
    expect(req.system[0].text).toContain('## Protected values')
    const schema = req.system.find((b) => b.cacheable)!.text
    expect(schema).toContain('users(id int pk, first_name text {<|PII:PERSON:')
    expect(schema).toContain('plan text {free|pro}')
    expect(schema).toContain('status text {paid|pending}')
    expect(schema).toContain('card_number text {<|MASKED:CARD:1111|>}')
    expect(schema).toMatch(/notes text \{VIP, call <\|PII:PHONE:[0-9A-F]{6}\|>\}/)
    expect(schema).toMatch(/-- Owned by Dr\. <\|PII:PERSON:[0-9A-F]{6}\|>/)
    expect(req.messages[req.messages.length - 1]).toMatchObject({ role: 'user' })

    const report = res.privacy!
    expect(report).toMatchObject({ protected: true, host: 'api.example.com', policy: { id: 'general-pii', version: 2 }, requests: 1 })
    expect(report.counts.EMAIL_ADDRESS).toBeGreaterThanOrEqual(3)
    expect(report.counts.CREDIT_CARD_NUMBER).toBe(1)
    expect(report.restoration.restored).toBe(3)
    expect(report.engine?.detectors).toContain('patterns@1')
    expect(JSON.stringify(report)).not.toMatch(/jack@example\.com|Zed|4111/)
    // The step list says what happened in counts only.
    const privacyStep = h.steps.find((s) => s.stage === 'privacy' && s.status === 'done')
    expect(privacyStep?.detail).toMatch(/email addresses?.*replaced with placeholders/)
    expect(JSON.stringify(h.steps)).not.toContain('jack@example.com')
  })

  it('restores a name that only a column knew was personal', async () => {
    const h = harness((req) => {
      const schema = req.system.find((b) => b.cacheable)!.text
      const zed = /first_name text \{(<\|PII:PERSON:[0-9A-F]{6}\|>)/.exec(schema)![1]
      return propose({ sql: `SELECT count(*) FROM users WHERE first_name = '${zed}'`, explanation: `Users named ${zed}.`, tables_used: ['users'] })
    })
    const res = (await askDatabase(h.deps, 'how many users are named Zed?')) as AiQueryResult
    expect(res.sql).toBe("SELECT count(*) FROM users WHERE first_name = 'Zed'")
    expect(res.explanation).toBe('Users named Zed.')
    expectNothingRaw(h.provider.requests)
  })

  it('protects database errors that echo a restored value before sending them back for repair', async () => {
    const h = harness(
      (req, call) => {
        const email = tokenInQuestion(req, 'EMAIL')
        return call === 1
          ? propose({ sql: `SELECT * FROM users WHERE id = '${email}'`, explanation: 'x', tables_used: ['users'] })
          : propose({ sql: `SELECT * FROM users WHERE email = '${email}'`, explanation: 'fixed', tables_used: ['users'] }, 'call_2')
      },
      {
        runQuery: async (sql) =>
          sql.includes('WHERE id =')
            ? { results: [{ kind: 'error', sql, message: `datatype mismatch: "jack@example.com" is not an integer`, durationMs: 1 }], durationMs: 1, tx: false }
            : rows(sql)
      }
    )
    const res = (await askDatabase(h.deps, 'the user jack@example.com')) as AiQueryResult
    expect(res.sql).toBe("SELECT * FROM users WHERE email = 'jack@example.com'")
    expect(res.checks.repairs).toBe(1)
    const feedback = h.provider.requests[1].messages.find((m) => m.role === 'tool')!
    expect(feedback.content).toMatch(/datatype mismatch: "<\|PII:EMAIL:[0-9A-F]{6}\|>" is not an integer/)
    expectNothingRaw(h.provider.requests)
  })

  it('sends damaged or invented placeholders back for repair instead of running them', async () => {
    const h = harness((req, call) => {
      const email = tokenInQuestion(req, 'EMAIL')
      if (call === 1) return propose({ sql: `SELECT * FROM users WHERE email = '${email.slice(0, -2)}>' OR email = '<|PII:EMAIL:FFFFFF|>'`, explanation: 'x', tables_used: ['users'] })
      return propose({ sql: `SELECT * FROM users WHERE email = '${email}'`, explanation: 'ok', tables_used: ['users'] }, 'call_2')
    })
    const res = (await askDatabase(h.deps, 'the user jack@example.com')) as AiQueryResult
    expect(res.sql).toBe("SELECT * FROM users WHERE email = 'jack@example.com'")
    expect(h.ran).toHaveLength(1)
    const feedback = h.provider.requests[1].messages.find((m) => m.role === 'tool')!.content
    expect(feedback).toContain('do not match any protected value')
    expect(feedback).toContain('<|PII:EMAIL:FFFFFF|>')
  })

  it('warns instead of running a query that relies on a value the model never saw', async () => {
    const h = harness(() => propose({ sql: "SELECT * FROM orders WHERE card_number = '<|MASKED:CARD:1111|>'", explanation: 'Orders paid with that card.', tables_used: ['orders'] }))
    const res = (await askDatabase(h.deps, 'orders paid with card 4111 1111 1111 1111')) as AiQueryResult
    expect(res.kind).toBe('query')
    expect(res.autoRun).toBe(false)
    expect(res.warnings?.[0]).toMatch(/never saw in full/)
    expect(res.sql).toContain('<|MASKED:CARD:1111|>')
    expectNothingRaw(h.provider.requests)
  })

  it('protects tool results: schema lookups, table descriptions and sample values', async () => {
    const h = harness((req, call) => {
      if (call === 1)
        return reply({
          toolCalls: [
            { id: 't1', name: 'describe_table', args: { table: 'users' } },
            { id: 't2', name: 'sample_values', args: { table: 'users', column: 'first_name' } }
          ]
        })
      const zed = tokenIn(req, 'PERSON')
      return propose({ sql: `SELECT * FROM users WHERE first_name = '${zed}'`, explanation: 'x', tables_used: ['users'] })
    })
    h.deps.settings.schemaBudgetTokens = 8000
    await askDatabase(h.deps, 'people called Zed')
    const tools = h.provider.requests[1].messages.filter((m) => m.role === 'tool').map((m) => m.content)
    expect(tools[0]).toMatch(/users\(id int pk, first_name text \{<\|PII:PERSON:/)
    expect(tools[1]).toMatch(/^<\|PII:PERSON:[0-9A-F]{6}\|> \| <\|PII:PERSON:[0-9A-F]{6}\|> \| <\|PII:PERSON:[0-9A-F]{6}\|>$/)
    expectNothingRaw(h.provider.requests)
  })

  it('keeps placeholders across follow-ups, even after the vault was dropped by a relaunch', async () => {
    const first = harness((req) => propose({ sql: `SELECT * FROM users WHERE email = '${tokenIn(req, 'EMAIL')}'`, explanation: 'x', tables_used: ['users'] }), { samples: false })
    const r1 = (await askDatabase(first.deps, 'find jack@example.com')) as AiQueryResult
    const sealed = r1.privacy!.sealed!
    expect(sealed.question.text).toMatch(/^find <\|PII:EMAIL:[0-9A-F]{6}\|>$/)
    const original = placeholders(sealed.question.text)[0]
    const turn: AiTurn = { question: 'find jack@example.com', sql: r1.sql, sealed }

    // A new vault, as after a relaunch; the chat still holds its sealed history.
    const second = harness(
      (req) => {
        // The model sees its earlier turn exactly as before and reuses the old placeholder.
        const history = req.messages.slice(0, 2).map((m) => m.content)
        expect(history).toEqual([`find ${original}`, `SQL used:\nSELECT * FROM users WHERE email = '${original}'`])
        return propose({ sql: `SELECT * FROM users WHERE email = '${original}' AND plan = 'pro'`, explanation: 'x', tables_used: ['users'] })
      },
      { samples: false }
    )
    const r2 = (await askDatabase(second.deps, 'only the pro ones', [turn])) as AiQueryResult
    expect(r2.sql).toBe("SELECT * FROM users WHERE email = 'jack@example.com' AND plan = 'pro'")
    expectNothingRaw([...first.provider.requests, ...second.provider.requests])
  })

  it('protects history that has no sealed form, or whose sealed form does not match', async () => {
    const h = harness(() => propose({ sql: 'SELECT 1', explanation: 'x', tables_used: [] }), { samples: false })
    const tampered: AiTurn = {
      question: 'orders for Quorra Smith, SSN 123-45-6789',
      sql: "SELECT * FROM users WHERE first_name = 'Quorra'",
      sealed: { question: { text: 'orders for <|PII:PERSON:ABCDEF|>', spans: [{ marker: '<|PII:PERSON:ABCDEF|>', start: 11, end: 17, escape: 'plain' }] } }
    }
    const plain: AiTurn = { question: 'and for jack@example.com?', answer: 'Which Jack do you mean, jack@example.com?' }
    await askDatabase(h.deps, 'now the same for June', [tampered, plain])
    const sent = wireText(h.provider.requests)
    for (const v of ['Quorra', '123-45-6789', 'jack@example.com']) expect(sent).not.toContain(v)
    expect(h.vault.resolve('<|PII:PERSON:ABCDEF|>')).toBeUndefined()
  })

  it('restores clarifications and seals the model’s words for the next turn', async () => {
    const h = harness((req) => propose({ sql: '', explanation: '', tables_used: [], needs_clarification: `Do you mean ${tokenIn(req, 'EMAIL')} or another address?` }), { samples: false })
    const res = await askDatabase(h.deps, 'orders of jack@example.com')
    expect(res).toMatchObject({ kind: 'clarify', message: 'Do you mean jack@example.com or another address?' })
    if (res.kind !== 'clarify') return
    expect(res.privacy?.sealed?.answer?.text).toMatch(/^Do you mean <\|PII:EMAIL:[0-9A-F]{6}\|> or another address\?$/)
  })

  it('fails closed: nothing is sent when protection cannot run or verification fails', async () => {
    const broken: SensitiveDataDetector = {
      id: 'broken',
      version: 1,
      roles: ['prose'],
      detect() {
        throw new Error('boom Jack')
      }
    }
    const h = harness(() => propose({ sql: 'SELECT 1', explanation: 'x', tables_used: [] }), { engine: new PrivacyEngine({ schemaDetection: true, extra: [broken] }) })
    await expect(askDatabase(h.deps, 'orders for Jack')).rejects.toThrow(PrivacyBlockedError)
    expect(h.provider.requests).toHaveLength(0)
    expect(JSON.stringify(h.steps)).toContain('a sensitive-data detector failed (broken)')
    expect(JSON.stringify(h.steps)).not.toContain('boom')

    const engine = new PrivacyEngine({ schemaDetection: true })
    engine.verify = async () => ({ passed: false, findings: [{ where: 'the question', type: 'PHONE_NUMBER', problem: 'unprotected-value', count: 1 }], checked: 1 })
    const v = harness(() => propose({ sql: 'SELECT 1', explanation: 'x', tables_used: [] }), { engine })
    await expect(askDatabase(v.deps, 'anything')).rejects.toThrow('Local AI Privacy stopped this request before anything was sent: 1 phone number in the question could not be protected.')
    expect(v.provider.requests).toHaveLength(0)
  })
})
