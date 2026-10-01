// Answers streamed as the model writes them: put together from server-sent events in either protocol, passed on as
// they come, restored for display without ever showing half a placeholder, and read back whole in "What was sent".
import { describe, expect, it } from 'vitest'
import { isSse, readStream, splitSse, StreamedAnswer } from '../src/shared/stream'
import { AnthropicProvider } from '../src/main/ai/providers/anthropic'
import { OpenAiCompatibleProvider } from '../src/main/ai/providers/openai'
import { ProviderError, type ChatRequest, type ChatResponse, type CompleteOptions, type LlmProvider, type ProviderConfig } from '../src/main/ai/providers/types'
import { holdBackPartialMarker, ModelGateway } from '../src/main/privacy/gateway'
import { sendUnprotected } from '../src/main/privacy/boundary'
import { PrivacyEngine } from '../src/main/privacy/engine'
import { PrivacySession } from '../src/main/privacy/session'
import { PiiVault } from '../src/main/privacy/vault'
import { askDatabase } from '../src/main/ai/nl2sql'
import { SchemaIndex } from '../src/main/ai/schema-index'
import { readableResponse } from '../src/renderer/src/lib/wire-view'
import type { SchemaInfo } from '../src/shared/types'
import { policy, reply } from './privacy/helpers'

const sse = (events: unknown[], named = false) =>
  events.map((e) => (named ? `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n` : `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`)).join('')

/** A response whose body arrives in the given pieces, cut wherever they fall. */
function streamed(body: string, cuts: number[], status = 200): Response {
  const bytes = new TextEncoder().encode(body)
  const points = [0, ...cuts.filter((c) => c > 0 && c < bytes.length), bytes.length]
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 1; i < points.length; i++) controller.enqueue(bytes.slice(points[i - 1], points[i]))
        controller.close()
      }
    }),
    { status, headers: { 'content-type': 'text/event-stream' } }
  )
}

const openAiChunks = [
  { object: 'chat.completion.chunk', model: 'gpt-x', choices: [{ index: 0, delta: { role: 'assistant', content: 'Ann ' } }] },
  { object: 'chat.completion.chunk', model: 'gpt-x', choices: [{ index: 0, delta: { content: 'asked twice. ' } }] },
  { object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'run_query', arguments: '{"database":' } }] } }] },
  { object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"db1","sql":"SELECT 1"}' } }] } }] },
  { object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  { object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } } },
  '[DONE]'
]

const anthropicEvents = [
  { type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 90, cache_read_input_tokens: 80, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Looking at ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'refunds.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'describe_table', input: {} } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"table": "ref' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'unds"}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } },
  { type: 'message_stop' }
]

describe('server-sent events', () => {
  it('split into whole events, keeping an incomplete tail for the next read', () => {
    const { events, rest } = splitSse('event: ping\r\ndata: {"a":1}\r\n\r\ndata: line one\ndata: line two\n\ndata: {"half')
    expect(events).toEqual([{ event: 'ping', data: '{"a":1}' }, { data: 'line one\nline two' }])
    expect(rest).toBe('data: {"half')
    expect(isSse('data: {"x":1}\n\n')).toBe(true)
    expect(isSse('{"choices":[]}')).toBe(false)
  })

  it('put an OpenAI-style answer together: text, a tool call in pieces, usage', () => {
    const a = readStream(sse(openAiChunks))
    expect(a.text).toBe('Ann asked twice. ')
    expect(a.toolCalls).toEqual([{ id: 'call_1', name: 'run_query', args: '{"database":"db1","sql":"SELECT 1"}' }])
    expect(a.usage).toEqual({ inputTokens: 120, outputTokens: 30, cachedInputTokens: 100 })
    expect([a.model, a.stopReason, a.done]).toEqual(['gpt-x', 'tool_calls', true])
  })

  it('put an Anthropic answer together, from named events', () => {
    const a = readStream(sse(anthropicEvents, true))
    expect(a.text).toBe('Looking at refunds.')
    expect(a.toolCalls).toEqual([{ id: 'toolu_1', name: 'describe_table', args: '{"table": "refunds"}' }])
    expect(a.usage).toEqual({ inputTokens: 90, outputTokens: 42, cachedInputTokens: 80 })
    expect([a.model, a.stopReason]).toEqual(['claude-x', 'tool_use'])
    const failed = new StreamedAnswer()
    failed.push({ event: 'error', data: JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }) })
    expect(failed.error).toBe('Overloaded')
  })

  it('read back whole in "What was sent"', () => {
    const sections = readableResponse(sse(anthropicEvents, true))
    expect(sections.map((s) => s.label)).toEqual(['assistant', 'assistant → describe_table', 'details'])
    expect(sections[0].text).toBe('Looking at refunds.')
    expect(JSON.parse(sections[1].text)).toEqual({ table: 'refunds' })
    expect(sections[2].text).toContain('"streamed": true')
  })
})

const request: ChatRequest = { system: [{ text: 'Rules.' }], messages: [{ role: 'user', content: 'Who asked for a refund?' }] }
const config = (kind: string, protocol: 'openai' | 'anthropic', fetchImpl: typeof fetch): ProviderConfig => ({ protocol, kind, baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm', embeddingModel: '', fetchImpl })

describe('streaming adapters', () => {
  it('pass OpenAI text on as it arrives, however the bytes are cut, and still return the whole answer', async () => {
    const bodies: any[] = []
    const body = sse(openAiChunks)
    const provider = new OpenAiCompatibleProvider(
      config('openai', 'openai', async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return streamed(body, [7, 30, 31, 95, 200, 333])
      })
    )
    const pieces: string[] = []
    const res = await provider.complete(sendUnprotected(request, 'fixed-text'), undefined, { onText: (d) => pieces.push(d) })
    expect(bodies[0]).toMatchObject({ stream: true, stream_options: { include_usage: true } })
    expect(pieces.join('')).toBe('Ann asked twice. ')
    expect(pieces.length).toBeGreaterThan(1)
    expect(res).toEqual({
      text: 'Ann asked twice. ',
      toolCalls: [{ id: 'call_1', name: 'run_query', args: { database: 'db1', sql: 'SELECT 1' } }],
      usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 100 },
      model: 'gpt-x',
      stopReason: 'tool_calls'
    })
  })

  it('stream Anthropic answers the same way', async () => {
    const provider = new AnthropicProvider(config('anthropic', 'anthropic', async () => streamed(sse(anthropicEvents, true), [11, 64, 65, 400])))
    const pieces: string[] = []
    const res = await provider.complete(sendUnprotected(request, 'fixed-text'), undefined, { onText: (d) => pieces.push(d) })
    expect(pieces.join('')).toBe('Looking at refunds.')
    expect(res.toolCalls).toEqual([{ id: 'toolu_1', name: 'describe_table', args: { table: 'refunds' } }])
    expect(res.usage).toEqual({ inputTokens: 90, outputTokens: 42, cachedInputTokens: 80 })
  })

  it('leave local servers answering whole, where streamed tool calls are not dependable', async () => {
    const bodies: any[] = []
    const provider = new OpenAiCompatibleProvider(
      config('ollama', 'openai', async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify({ model: 'llama', choices: [{ message: { content: 'Whole.' }, finish_reason: 'stop' }], usage: {} }))
      })
    )
    const pieces: string[] = []
    const res = await provider.complete(sendUnprotected(request, 'fixed-text'), undefined, { onText: (d) => pieces.push(d) })
    expect(bodies[0].stream).toBeUndefined()
    expect([res.text, pieces]).toEqual(['Whole.', []])
  })

  it('ask again without the usage option for a server that refuses it', async () => {
    const bodies: any[] = []
    const provider = new OpenAiCompatibleProvider(
      config('google', 'openai', async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        bodies.push(body)
        if (body.stream_options) return new Response(JSON.stringify({ error: { message: 'Unknown name "stream_options": Cannot find field.' } }), { status: 400 })
        return streamed(sse(openAiChunks.slice(0, 2)), [])
      })
    )
    const res = await provider.complete(sendUnprotected(request, 'fixed-text'), undefined, { onText: () => undefined })
    expect(res.text).toBe('Ann asked twice. ')
    expect(bodies.map((b) => Boolean(b.stream_options))).toEqual([true, false])
    // Remembered for the next request.
    await provider.complete(sendUnprotected(request, 'fixed-text'), undefined, { onText: () => undefined })
    expect(bodies.map((b) => Boolean(b.stream_options))).toEqual([true, false, false])
  })

  it('stop at once when cancelled mid-answer', async () => {
    const controller = new AbortController()
    let push: ((s: string) => void) | null = null
    const provider = new OpenAiCompatibleProvider(
      config('openai', 'openai', async (_url, init) => {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            push = (s) => c.enqueue(new TextEncoder().encode(s))
            init?.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')))
          }
        })
        return new Response(stream)
      })
    )
    const pieces: string[] = []
    const answer = provider.complete(sendUnprotected(request, 'fixed-text'), controller.signal, {
      onText: (d) => {
        pieces.push(d)
        controller.abort()
      }
    })
    await new Promise((r) => setTimeout(r, 0))
    push!(sse([openAiChunks[0]]))
    await expect(answer).rejects.toMatchObject({ errorKind: 'cancelled' })
    expect(pieces).toEqual(['Ann '])
    expect(new ProviderError('x', 'cancelled')).toBeInstanceOf(ProviderError)
  })
})

describe('a draft shown while it streams', () => {
  it('never shows half a placeholder', () => {
    expect(holdBackPartialMarker('Rows for <|PII:EMAIL:3F')).toBe('Rows for ')
    expect(holdBackPartialMarker('Rows for <|PII:EMAIL:3F2A9C|> and <')).toBe('Rows for <|PII:EMAIL:3F2A9C|> and ')
    expect(holdBackPartialMarker('a <| b that runs on far too long to be a placeholder at all, so it shows')).toContain('<| b')
  })

  const schema: SchemaInfo = {
    kind: 'sqlite',
    tables: [{ name: 'refunds', type: 'table', sql: null, columns: [{ cid: 0, name: 'id', type: 'INTEGER', notnull: false, dflt: null, pk: 1, hidden: 0 }, { cid: 1, name: 'email', type: 'TEXT', notnull: false, dflt: null, pk: 0, hidden: 0 }], withoutRowid: false, rowidAlias: 'rowid', pk: ['id'] }],
    views: [],
    indexes: [],
    triggers: [],
    relations: []
  }

  /** A provider that streams each reply in small pieces, as a hosted model would. */
  function streamingProvider(replies: ((req: ChatRequest) => ChatResponse)[]): LlmProvider {
    let n = 0
    return {
      kind: 'openai',
      model: 'm',
      supportsEmbeddings: false,
      async complete(req: any, _signal?: AbortSignal, opts?: CompleteOptions) {
        const res = replies[Math.min(n++, replies.length - 1)](req)
        for (let i = 0; i < res.text.length; i += 4) {
          opts?.onText?.(res.text.slice(i, i + 4))
          await new Promise((r) => setTimeout(r, 15))
        }
        return res
      },
      async embed() {
        return []
      },
      async listModels() {
        return []
      }
    }
  }

  it('is restored as it comes, dropped when it leads into tool calls, and ends as the answer', async () => {
    const vault = new PiiVault()
    const session = new PrivacySession({ engine: new PrivacyEngine({ schemaDetection: true }), policy, vault, host: 'api.example.com' })
    let marker = ''
    const provider = streamingProvider([
      // Long enough to be shown before the tool call it leads into.
      () => reply({ text: 'Let me look at the refunds table first.', toolCalls: [{ id: 't1', name: 'describe_table', args: { table: 'refunds' } }], stopReason: 'tool_calls' }),
      (req) => {
        marker = /<\|PII:EMAIL:[0-9A-F]{6}\|>/.exec(JSON.stringify(req.messages))![0]
        return reply({ text: `**${marker}** asked for two refunds this week.` })
      }
    ])
    const drafts: string[] = []
    const result = await askDatabase(
      {
        kind: 'sqlite',
        serverVersion: '3.45.1',
        index: SchemaIndex.fromSchema(schema, 'sqlite'),
        provider: ModelGateway.protected(provider, session),
        settings: { sendSampleValues: false, autoRun: true, schemaBudgetTokens: 8000 },
        runQuery: async (sql) => ({ results: [{ kind: 'rows', sql, columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 1 }], durationMs: 1, tx: false }),
        distinctValues: async () => null,
        onStream: (text) => drafts.push(text)
      },
      'Did ann@corp.io ask for a refund?'
    )
    expect(result).toMatchObject({ kind: 'clarify', message: '**ann@corp.io** asked for two refunds this week.' })
    // The first reply led into a tool call: what was shown of it went again.
    const preamble = drafts.slice(0, drafts.indexOf(''))
    expect(preamble.length).toBeGreaterThan(0)
    for (const d of preamble) expect('Let me look at the refunds table first.'.startsWith(d)).toBe(true)
    const answerDrafts = drafts.slice(drafts.lastIndexOf('') + 1)
    expect(answerDrafts[answerDrafts.length - 1]).toBe('**ann@corp.io** asked for two refunds this week.')
    // Each draft is the answer so far: restored, and never with a placeholder cut in half.
    for (const d of answerDrafts) {
      expect('**ann@corp.io** asked for two refunds this week.'.startsWith(d)).toBe(true)
      expect(d).not.toContain('<|')
    }
    // Restoring drafts does not count against the answer: one restored placeholder, the answer's own.
    expect(result.kind === 'clarify' && result.privacy?.restoration.restored).toBe(1)
    expect(marker).toMatch(/PII:EMAIL/)
  })
})
