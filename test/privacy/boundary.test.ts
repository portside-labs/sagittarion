// Security regression tests for the provider boundary: for every remote provider the app ships, the exact HTTP
// bodies it sends are inspected. Nothing raw, no vault, placeholders present; nothing at all when protection fails.
import { describe, expect, it } from 'vitest'
import { BYOK_PROVIDERS, LOCAL_PROVIDERS, PROVIDERS, type ProviderId } from '../../src/shared/ai'
import { classifyEndpoint, DEFAULT_PRIVACY, privacyApplies } from '../../src/shared/privacy'
import type { ColumnInfo, SchemaInfo, TableMeta } from '../../src/shared/types'
import { createProvider, providerConfigFor } from '../../src/main/ai/providers/factory'
import { SchemaIndex } from '../../src/main/ai/schema-index'
import { askDatabase } from '../../src/main/ai/nl2sql'
import { ModelGateway } from '../../src/main/privacy/gateway'
import { PrivacyEngine } from '../../src/main/privacy/engine'
import { PrivacySession } from '../../src/main/privacy/session'
import { PiiVault } from '../../src/main/privacy/vault'
import { EXAMPLE_IDS } from '../../src/main/privacy/markers'
import type { AiQueryResult } from '../../src/shared/ai'
import { policy } from './helpers'

const col = (name: string, type: string, pk = 0): ColumnInfo => ({ cid: 0, name, type, notnull: false, dflt: null, pk, hidden: 0 })
const table = (name: string, columns: ColumnInfo[], extra: Partial<TableMeta> = {}): TableMeta => ({ name, type: 'table', sql: null, columns, withoutRowid: false, rowidAlias: 'rowid', pk: columns.filter((c) => c.pk > 0).map((c) => c.name), ...extra })

/** Values that must never reach a provider in these tests. */
const SECRETS = ['Jack', '867-5309', 'jack@example.com', 'Zed', 'zed@corp.io', 'Quinlan', '4111 1111 1111 1111', '123-45-6789']

function schema(filler = 0): SchemaInfo {
  const tables = [
    table('users', [col('id', 'INTEGER', 1), col('first_name', 'TEXT'), col('email', 'TEXT'), col('phone', 'TEXT'), col('ssn', 'TEXT')], { comment: 'Maintained by Dr. Quinlan' }),
    table('orders', [col('id', 'INTEGER', 1), col('user_id', 'INTEGER'), col('card_number', 'TEXT'), col('status', 'TEXT')])
  ]
  for (let i = 0; i < filler; i++) tables.push(table(`misc_${i}`, [col('id', 'INTEGER', 1), col(`value_${i}`, 'TEXT'), col(`note_${i}`, 'TEXT')]))
  return { kind: 'postgres', defaultSchema: 'public', tables, views: [], indexes: [], triggers: [], relations: [{ table: 'orders', column: 'user_id', refTable: 'users', refColumn: 'id' }] }
}

const SAMPLES: Record<string, string[]> = {
  first_name: ['Zed', 'Jack'],
  email: ['zed@corp.io'],
  phone: ['867-5309'],
  ssn: ['123-45-6789'],
  card_number: ['4111 1111 1111 1111'],
  status: ['paid', 'pending']
}

/** The first placeholder of a kind in a wire body, skipping the examples in the instructions. */
function placeholderIn(body: string, tag: string): string {
  const all = [...body.matchAll(new RegExp(`<\\\\?\\|PII:${tag}:[0-9A-F]{6}\\\\?\\|>`, 'g'))].map((m) => m[0].replace(/\\/g, ''))
  const found = all.find((t) => !EXAMPLE_IDS.some((id) => t.includes(id)))
  if (!found) throw new Error(`no ${tag} placeholder`)
  return found
}

interface Captured {
  url: string
  body: string
  headers: string
}

/** A fetch that records every request and answers like the provider would, echoing a placeholder it was sent. */
function mockFetch(protocol: 'openai' | 'anthropic', calls: Captured[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = String(init?.body ?? '')
    calls.push({ url, body, headers: JSON.stringify(init?.headers ?? {}) })
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.endsWith('/embeddings')) {
      const input = JSON.parse(body).input as string[]
      return json({ data: input.map((_, index) => ({ index, embedding: [1, 0] })) })
    }
    const question = JSON.parse(body).messages.filter((m: any) => m.role === 'user').pop()
    const email = placeholderIn(JSON.stringify(question), 'EMAIL')
    const args = { sql: `SELECT * FROM users WHERE email = '${email}'`, explanation: `Rows for ${email}.`, tables_used: ['users'] }
    if (protocol === 'anthropic') {
      return json({ model: 'claude-x', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'propose_query', input: args }], usage: { input_tokens: 10, output_tokens: 5 } })
    }
    return json({
      model: 'm',
      choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'propose_query', arguments: JSON.stringify(args) } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 }
    })
  }) as unknown as typeof fetch
}

const REMOTE: ProviderId[] = BYOK_PROVIDERS

async function askThrough(provider: ProviderId, opts: { embeddings?: boolean; filler?: number } = {}) {
  const preset = PROVIDERS[provider]
  const calls: Captured[] = []
  const config = providerConfigFor({ provider, baseUrl: '', model: 'model-x', embeddingModel: opts.embeddings ? 'embed-x' : '' }, 'sk-test-key', { fetchImpl: mockFetch(preset.protocol === 'anthropic' ? 'anthropic' : 'openai', calls) })
  const { trust, host } = classifyEndpoint(config.baseUrl)
  const vault = new PiiVault()
  const session = new PrivacySession({ engine: new PrivacyEngine({ schemaDetection: true }), policy, vault, host })
  const gateway = ModelGateway.protected(createProvider(config), session)
  const result = (await askDatabase(
    {
      kind: 'postgres',
      serverVersion: 'PostgreSQL 16.2',
      index: SchemaIndex.fromSchema(schema(opts.filler ?? 0), 'postgres'),
      provider: gateway,
      settings: { sendSampleValues: true, autoRun: true, schemaBudgetTokens: opts.filler ? 400 : 8000, embeddingModel: opts.embeddings ? 'embed-x' : undefined },
      runQuery: async (sql) => ({ results: [{ kind: 'rows', sql, columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 1 }], durationMs: 1, tx: false }),
      distinctValues: async (_ref, column) => SAMPLES[column] ?? null
    },
    "orders for Jack, jack@example.com, phone 867-5309, SSN 123-45-6789, card 4111 1111 1111 1111; my password is hunter2"
  )) as AiQueryResult
  return { trust, calls, result, vault }
}

describe('provider trust boundary', () => {
  it.each(REMOTE)('%s: the HTTP request carries placeholders only, never values or the vault', async (provider) => {
    const { trust, calls, result, vault } = await askThrough(provider)
    expect(trust).toBe('external')
    expect(calls.length).toBe(1)
    for (const c of calls) {
      for (const secret of [...SECRETS, 'hunter2']) expect(c.body, `${provider} must not send "${secret}"`).not.toContain(secret)
      expect(c.body).toContain('<|PII:')
      expect(c.body).toContain('<|REDACTED:PASSWORD|>')
      expect(c.body).toContain('<|MASKED:CARD:1111|>')
      expect(c.body).not.toContain(vault.id)
      // The flag that routes schema text to identifier-safe detectors never reaches the wire.
      expect(c.body).not.toContain('"structured"')
      expect(c.headers).not.toMatch(/Jack|867-5309|jack@example\.com/)
    }
    // Back on this side the query uses the real value.
    expect(result.sql).toBe("SELECT * FROM users WHERE email = 'jack@example.com'")
    expect(result.explanation).toBe('Rows for jack@example.com.')
  })

  it.each(REMOTE.filter((p) => PROVIDERS[p].protocol === 'openai'))('%s: embedding requests are protected too', async (provider) => {
    const { calls } = await askThrough(provider, { embeddings: true, filler: 60 })
    const embeddings = calls.filter((c) => c.url.endsWith('/embeddings'))
    expect(embeddings.length).toBeGreaterThanOrEqual(2)
    const question = embeddings[embeddings.length - 1].body
    expect(question).toContain('<|PII:EMAIL:')
    for (const c of embeddings) for (const secret of [...SECRETS, 'hunter2']) expect(c.body).not.toContain(secret)
  })

  it('sends nothing at all when protection fails', async () => {
    const calls: Captured[] = []
    const config = providerConfigFor({ provider: 'openai', baseUrl: '', model: 'm', embeddingModel: '' }, 'sk', { fetchImpl: mockFetch('openai', calls) })
    const engine = new PrivacyEngine({ schemaDetection: true })
    engine.verify = async () => ({ passed: false, findings: [{ where: 'the question', type: 'PERSON_NAME', problem: 'unprotected-value', count: 1 }], checked: 1 })
    const gateway = ModelGateway.protected(createProvider(config), new PrivacySession({ engine, policy, vault: new PiiVault(), host: 'api.openai.com' }))
    await expect(gateway.complete({ system: [{ text: 'rules' }], messages: [{ role: 'user', content: 'orders for Jack' }] })).rejects.toThrow(/stopped this request/)
    await expect(gateway.embed(['orders for Jack'])).rejects.toThrow(/stopped this request/)
    expect(calls).toEqual([])
  })

  it('sends data as it is only with an explicit exemption, which the report states', async () => {
    const calls: Captured[] = []
    const config = providerConfigFor({ provider: 'ollama', baseUrl: '', model: 'm', embeddingModel: '' }, null, { fetchImpl: mockFetch('openai', calls) })
    const { trust, host } = classifyEndpoint(config.baseUrl)
    expect([trust, host]).toEqual(['this-device', 'localhost'])
    const applies = privacyApplies(DEFAULT_PRIVACY, trust)
    expect(applies).toEqual({ protect: false, exemption: 'this-device' })
    const gateway = ModelGateway.unprotected(createProvider(config), 'this-device', host)
    await gateway.complete({ system: [{ text: 'rules' }], messages: [{ role: 'user', content: 'orders for jack@example.com' }] }).catch(() => undefined)
    expect(calls[0].body).toContain('jack@example.com')
    expect(gateway.report()).toMatchObject({ protected: false, exemption: 'this-device', host: 'localhost' })
    // Turning on protection for local models puts the same server behind the boundary.
    expect(privacyApplies({ ...DEFAULT_PRIVACY, protectLocalModels: true }, trust)).toEqual({ protect: true })
    expect(privacyApplies({ ...DEFAULT_PRIVACY, enabled: false }, 'external')).toEqual({ protect: false, exemption: 'privacy-off' })
  })
})

describe('endpoint trust', () => {
  it('treats only loopback as this device, whatever the preset says', () => {
    const cases: [string, string][] = [
      ['http://localhost:11434/v1', 'this-device'],
      ['http://127.0.0.1:1234/v1', 'this-device'],
      ['http://127.8.9.10/v1', 'this-device'],
      ['http://[::1]:8000/v1', 'this-device'],
      ['http://ollama.localhost/v1', 'this-device'],
      ['http://0.0.0.0:4000', 'this-device'],
      ['http://192.168.1.20:11434/v1', 'external'],
      ['http://10.0.0.5:8000/v1', 'external'],
      ['https://litellm.company.internal/v1', 'external'],
      ['https://api.openai.com/v1', 'external'],
      ['http://localhost.evil.com/v1', 'external'],
      ['http://127.0.0.1.nip.io/v1', 'external'],
      ['not a url', 'external'],
      ['', 'external']
    ]
    for (const [url, trust] of cases) expect(classifyEndpoint(url).trust, url).toBe(trust)
    // Every "local" preset points at this device by default; every key-based one is external.
    for (const p of LOCAL_PROVIDERS) if (PROVIDERS[p].baseUrl) expect(classifyEndpoint(PROVIDERS[p].baseUrl).trust).toBe('this-device')
    for (const p of BYOK_PROVIDERS) expect(classifyEndpoint(PROVIDERS[p].baseUrl).trust).toBe('external')
  })
})
