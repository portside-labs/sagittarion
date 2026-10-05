// Anthropic Messages API, with prompt caching on the schema block.
import {
  classifyHttpError,
  fetchWithTimeout,
  joinUrl,
  parseToolArgs,
  ProviderError,
  readErrorBody,
  readEventStream,
  STREAMING_PROVIDERS,
  type ChatRequest,
  type ChatResponse,
  type CompleteOptions,
  type LlmProvider,
  type ProviderConfig,
  type ToolCall
} from './types'
import type { OutboundRequest } from '../../privacy/boundary'

const VERSION = '2023-06-01'

function mapMessages(req: ChatRequest): unknown[] {
  const out: any[] = []
  for (const m of req.messages) {
    if (m.role === 'user') {
      const last = out[out.length - 1]
      // Words after tool results (such as being told to answer now) go in the same turn as the results.
      if (last && last.role === 'user') {
        if (!Array.isArray(last.content)) last.content = [{ type: 'text', text: last.content }]
        last.content.push({ type: 'text', text: m.content })
      } else out.push({ role: 'user', content: m.content })
    } else if (m.role === 'assistant') {
      const content: unknown[] = []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const tc of m.toolCalls ?? []) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args })
      out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '(no text)' }] })
    } else {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }
      const last = out[out.length - 1]
      // Consecutive tool results must share one user message.
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') last.content.push(block)
      else out.push({ role: 'user', content: [block] })
    }
  }
  // Where the request caches its prompt, the conversation is cached too, up to its last message: the next step of the
  // same question reads all of it back at a tenth of the price instead of paying for it again.
  if (req.system.some((b) => b.cacheable) && out.length) {
    const last = out[out.length - 1]
    if (!Array.isArray(last.content)) last.content = [{ type: 'text', text: last.content }]
    const block = last.content[last.content.length - 1]
    if (block) block.cache_control = { type: 'ephemeral' }
  }
  return out
}

export class AnthropicProvider implements LlmProvider {
  readonly kind: string
  readonly model: string
  readonly supportsEmbeddings = false
  private readonly cfg: ProviderConfig
  private readonly fetchImpl: typeof fetch

  constructor(cfg: ProviderConfig) {
    this.cfg = cfg
    this.kind = cfg.kind
    this.model = cfg.model
    this.fetchImpl = cfg.fetchImpl ?? fetch
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', 'anthropic-version': VERSION, 'x-api-key': this.cfg.apiKey ?? '' }
  }

  async complete(req: OutboundRequest, signal?: AbortSignal, opts?: CompleteOptions): Promise<ChatResponse> {
    if (!this.model) throw new ProviderError('No model is configured. Pick one in Settings.', 'bad_request')
    const onText = opts?.onText && STREAMING_PROVIDERS.has(this.kind) ? opts.onText : undefined
    const body: Record<string, unknown> = {
      model: this.model,
      // Room for a long answer in words, such as one drawn from a connector's documentation.
      max_tokens: req.maxTokens ?? 8192,
      system: req.system.map((b) => ({ type: 'text', text: b.text, ...(b.cacheable ? { cache_control: { type: 'ephemeral' } } : {}) })),
      messages: mapMessages(req)
    }
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
      if (req.toolChoice === 'auto') body.tool_choice = { type: 'auto' }
      else if (req.toolChoice === 'none') body.tool_choice = { type: 'none' }
      else if (req.toolChoice) body.tool_choice = { type: 'tool', name: req.toolChoice.name }
    }
    if (onText) body.stream = true
    const res = await fetchWithTimeout(this.fetchImpl, joinUrl(this.cfg.baseUrl, '/v1/messages'), { method: 'POST', headers: this.headers(), body: JSON.stringify(body) }, this.cfg.timeoutMs ?? 90_000, signal)
    if (!res.ok) throw classifyHttpError(res.status, await readErrorBody(res))
    if (onText) {
      const streamed = await readEventStream(res, signal, onText)
      return {
        text: streamed.text,
        toolCalls: streamed.toolCalls.map((c, i) => ({ id: c.id || `toolu_${i}`, name: c.name, args: parseToolArgs(c.args) })),
        usage: { ...streamed.usage },
        model: streamed.model || this.model,
        stopReason: streamed.stopReason
      }
    }
    const json: any = await res.json()
    const blocks: any[] = Array.isArray(json?.content) ? json.content : []
    const text = blocks
      .filter((b) => b?.type === 'text')
      .map((b) => String(b.text ?? ''))
      .join('')
    const toolCalls: ToolCall[] = blocks
      .filter((b) => b?.type === 'tool_use')
      .map((b, i) => ({ id: String(b.id ?? `toolu_${i}`), name: String(b.name ?? ''), args: b.input && typeof b.input === 'object' ? b.input : {} }))
    return {
      text,
      toolCalls,
      usage: {
        inputTokens: Number(json?.usage?.input_tokens ?? 0),
        outputTokens: Number(json?.usage?.output_tokens ?? 0),
        cachedInputTokens: Number(json?.usage?.cache_read_input_tokens ?? 0)
      },
      model: String(json?.model ?? this.model),
      stopReason: String(json?.stop_reason ?? '')
    }
  }

  async embed(): Promise<number[][]> {
    throw new ProviderError('Anthropic does not offer an embeddings API; schema search uses keyword matching instead.', 'bad_request')
  }

  async listModels(): Promise<string[]> {
    const res = await fetchWithTimeout(this.fetchImpl, joinUrl(this.cfg.baseUrl, '/v1/models?limit=100'), { method: 'GET', headers: this.headers() }, 20_000)
    if (!res.ok) throw classifyHttpError(res.status, await readErrorBody(res))
    const json: any = await res.json()
    const data: any[] = Array.isArray(json?.data) ? json.data : []
    return data
      .map((d) => String(d?.id ?? ''))
      .filter(Boolean)
      .sort()
  }
}
