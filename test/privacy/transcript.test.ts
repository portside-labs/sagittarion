// "What was sent": the recorder captures exact bytes and never the API key; the transcript proves each protected
// value stayed behind; values reach the viewer only when asked for, only for what the policy restores anyway.
import { describe, expect, it } from 'vitest'
import type { ColumnInfo, SchemaInfo, TableMeta } from '../../src/shared/types'
import type { AiWireExchange } from '../../src/shared/privacy'
import { blankQuery, WireRecorder } from '../../src/main/ai/wire'
import { createProvider, providerConfigFor } from '../../src/main/ai/providers/factory'
import { SchemaIndex } from '../../src/main/ai/schema-index'
import { askDatabase } from '../../src/main/ai/nl2sql'
import { ModelGateway } from '../../src/main/privacy/gateway'
import { PrivacyEngine } from '../../src/main/privacy/engine'
import { PrivacySession } from '../../src/main/privacy/session'
import { PiiVault } from '../../src/main/privacy/vault'
import { TranscriptStore, transcriptForViewer, type StoredTranscript } from '../../src/main/privacy/transcripts'
import { EXAMPLE_IDS } from '../../src/main/privacy/markers'
import { policy } from './helpers'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('wire recorder', () => {
  it('records exact bodies, never headers, and blanks secrets in the address', async () => {
    const recorder = new WireRecorder(async () => json({ ok: true }))
    const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi <|PII:PERSON:A81F32|>' }] })
    const res = await recorder.fetch('https://user:pw@api.example.com/v1/chat/completions?api-key=sk-live-123&x=1', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-secret-key', 'x-api-key': 'sk-ant-secret' },
      body
    })
    // The adapter still reads the response normally.
    expect(await res.json()).toEqual({ ok: true })
    const [x] = recorder.exchanges
    expect(x).toMatchObject({ n: 1, kind: 'chat', method: 'POST', request: body, status: 200, response: '{"ok":true}' })
    expect(x.url).toBe('https://%E2%80%A2%E2%80%A2%E2%80%A2:%E2%80%A2%E2%80%A2%E2%80%A2@api.example.com/v1/chat/completions?api-key=%E2%80%A2%E2%80%A2%E2%80%A2&x=%E2%80%A2%E2%80%A2%E2%80%A2')
    const everything = JSON.stringify(recorder.exchanges)
    for (const secret of ['sk-secret-key', 'sk-ant-secret', 'sk-live-123', 'user:pw']) expect(everything).not.toContain(secret)
    expect(blankQuery('not a url?key=abc')).toBe('not a url?key=•••')
  })

  it('records failures and keeps the beginning of oversized bodies', async () => {
    const failing = new WireRecorder(async () => {
      throw new Error('connect ECONNREFUSED')
    })
    await expect(failing.fetch('http://localhost:1/v1/embeddings', { method: 'POST', body: '{"input":["x"]}' })).rejects.toThrow('ECONNREFUSED')
    expect(failing.exchanges[0]).toMatchObject({ kind: 'embeddings', status: null, response: null, error: 'connect ECONNREFUSED' })

    const huge = 'x'.repeat(2_500_000)
    const big = new WireRecorder(async () => new Response(huge))
    await big.fetch('https://api.example.com/v1/messages', { method: 'POST', body: '{}' })
    expect(big.exchanges[0].response?.length).toBe(2_000_000)
    expect(big.exchanges[0].truncated).toEqual({ response: 2_500_000 })
  })
})

const col = (name: string, type: string, pk = 0): ColumnInfo => ({ cid: 0, name, type, notnull: false, dflt: null, pk, hidden: 0 })
const table = (name: string, columns: ColumnInfo[]): TableMeta => ({ name, type: 'table', sql: null, columns, withoutRowid: false, rowidAlias: 'rowid', pk: columns.filter((c) => c.pk > 0).map((c) => c.name) })
const schema: SchemaInfo = { kind: 'sqlite', tables: [table('users', [col('id', 'INTEGER', 1), col('email', 'TEXT'), col('card_number', 'TEXT')])], views: [], indexes: [], triggers: [], relations: [] }

/** A protected ask through the real OpenAI adapter, recorded on the wire. */
async function recordedAsk() {
  const provider = new WireRecorder(async (_input, init) => {
    const sent = JSON.parse(String(init?.body))
    const question = sent.messages.filter((m: any) => m.role === 'user').pop().content as string
    const email = question.match(/<\|PII:EMAIL:[0-9A-F]{6}\|>/)![0]
    const args = { sql: `SELECT * FROM users WHERE email = '${email}'`, explanation: `Rows for ${email}.`, tables_used: ['users'] }
    return json({ model: 'm', choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'propose_query', arguments: JSON.stringify(args) } }] } }], usage: {} })
  })
  const vault = new PiiVault()
  const session = new PrivacySession({ engine: new PrivacyEngine({ schemaDetection: true }), policy, vault, host: 'api.openai.com' })
  const gateway = ModelGateway.protected(createProvider(providerConfigFor({ provider: 'openai', baseUrl: '', model: 'm', embeddingModel: '' }, 'sk-test-secret', { fetchImpl: provider.fetch })), session)
  const result = await askDatabase(
    {
      kind: 'sqlite',
      serverVersion: '3.45.1',
      index: SchemaIndex.fromSchema(schema, 'sqlite'),
      provider: gateway,
      settings: { sendSampleValues: true, autoRun: true, schemaBudgetTokens: 8000 },
      runQuery: async (sql) => ({ results: [{ kind: 'rows', sql, columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 1 }], durationMs: 1, tx: false }),
      distinctValues: async (_ref, column) => (column === 'email' ? ['zed@corp.io'] : column === 'card_number' ? ['4111 1111 1111 1111'] : null)
    },
    'rows for jack@example.com; my password is hunter2'
  )
  const stored: StoredTranscript = {
    requestId: 'r1',
    host: 'api.openai.com',
    at: 1,
    protected: true,
    exchanges: provider.exchanges,
    legend: gateway.transcriptLegend(provider.exchanges.map((x) => x.request)),
    report: gateway.report()
  }
  return { stored, vault, result }
}

describe('transcripts', () => {
  it('prove each protected value stayed behind, counted on the exact bytes that were sent', async () => {
    const { stored, result } = await recordedAsk()
    expect(result.kind).toBe('query')
    expect(stored.exchanges).toHaveLength(1)
    const sent = stored.exchanges[0].request
    expect(sent).not.toMatch(/jack@example\.com|zed@corp\.io|hunter2|4111 1111/)
    expect(JSON.stringify(stored)).not.toContain('sk-test-secret')
    // Every protected value is listed by its placeholder, found in what was sent, with the value itself 0 times.
    const byType = Object.fromEntries(stored.legend.map((e) => [e.type, e]))
    expect(Object.keys(byType).sort()).toEqual(['CREDIT_CARD_NUMBER', 'EMAIL_ADDRESS', 'PASSWORD'])
    expect(stored.legend.every((e) => e.occurrences === 0)).toBe(true)
    for (const e of stored.legend) expect(sent).toContain(JSON.stringify(e.marker).slice(1, -1))
    expect(byType.PASSWORD).toMatchObject({ marker: '<|REDACTED:PASSWORD|>', action: 'redact', restorable: false, where: 'the question' })
    // What the user typed is listed first, then what came from the data.
    expect(stored.legend.map((e) => e.where)).toEqual(['the question', 'the question', 'sample values', 'sample values'])
    expect(byType.CREDIT_CARD_NUMBER).toMatchObject({ marker: '<|MASKED:CARD:1111|>', action: 'mask', restorable: false })
    // The transcript itself holds no protected value.
    expect(JSON.stringify(stored.legend)).not.toMatch(/jack@|zed@|hunter2|4111/)
    // What came back is recorded too, in the model's own terms.
    expect(stored.exchanges[0].response).toContain('<|PII:EMAIL:')
  })

  it('hand values to the viewer only on request, only for restorable placeholders, only while the chat holds them', async () => {
    const { stored, vault } = await recordedAsk()
    const plain = transcriptForViewer(stored, vault, false)
    expect(plain.valuesAvailable).toBe(true)
    expect(plain.legend.some((e) => e.value !== undefined)).toBe(false)
    const shown = transcriptForViewer(stored, vault, true)
    const values = shown.legend.filter((e) => e.value !== undefined).map((e) => [e.type, e.value])
    expect(values.sort()).toEqual([
      ['EMAIL_ADDRESS', 'jack@example.com'],
      ['EMAIL_ADDRESS', 'zed@corp.io']
    ])
    // Secrets, masks and anything the chat no longer holds are never handed over.
    expect(JSON.stringify(shown)).not.toMatch(/hunter2|4111 1111/)
    const gone = transcriptForViewer(stored, undefined, true)
    expect(gone.valuesAvailable).toBe(false)
    expect(gone.legend.some((e) => e.value !== undefined)).toBe(false)
  })

  it('are capped, keep the newest, and go when the chat is reset or its connection closes', () => {
    const t = (id: string, size = 10): StoredTranscript => ({
      requestId: id,
      host: 'h',
      at: 0,
      protected: true,
      legend: [],
      exchanges: [{ n: 1, kind: 'chat', method: 'POST', url: 'u', at: 0, durationMs: 0, request: 'x'.repeat(size), status: 200, response: '' } as AiWireExchange]
    })
    const store = new TranscriptStore({ maxTranscripts: 3, maxBytes: 100 })
    store.put('s1', 'c1', t('a'))
    store.put('s1', 'c1', t('b'))
    store.put('s1', 'c2', t('c'))
    store.put('s2', 'c3', t('d'))
    expect([store.get('a'), store.get('b')?.transcript.requestId, store.size]).toEqual([undefined, 'b', 3])
    // The newest is kept however large; anything older goes to make room.
    store.put('s2', 'c3', t('huge', 500))
    expect([store.size, store.get('huge')?.transcript.requestId]).toEqual([1, 'huge'])
    store.put('s1', 'c1', t('e'))
    expect([store.size, store.get('huge')]).toEqual([1, undefined])
    store.put('s1', 'c2', t('f'))
    store.put('s2', 'c4', t('g'))
    store.forgetConversation('c1')
    expect([store.get('e'), store.size]).toEqual([undefined, 2])
    store.forgetSession('s1')
    expect([store.get('f'), store.get('g')?.transcript.requestId]).toEqual([undefined, 'g'])
  })

  it('record nothing sent when protection stops the ask', async () => {
    const recorder = new WireRecorder(async () => json({}))
    const engine = new PrivacyEngine({ schemaDetection: true })
    engine.verify = async () => ({ passed: false, findings: [{ where: 'the question', type: 'EMAIL_ADDRESS', problem: 'unprotected-value', count: 1 }], checked: 1 })
    const gateway = ModelGateway.protected(
      createProvider(providerConfigFor({ provider: 'openai', baseUrl: '', model: 'm', embeddingModel: '' }, 'k', { fetchImpl: recorder.fetch })),
      new PrivacySession({ engine, policy, vault: new PiiVault(), host: 'api.openai.com' })
    )
    await expect(gateway.complete({ system: [], messages: [{ role: 'user', content: 'jack@example.com' }] })).rejects.toThrow(/stopped this request/)
    expect(recorder.exchanges).toEqual([])
    expect(EXAMPLE_IDS.length).toBe(2)
  })
})
