// OpenAI chat-completions protocol. Also speaks to Groq, Gemini's compatibility
// endpoint, OpenRouter, Ollama, vLLM, LM Studio and similar servers.
import {
  classifyHttpError,
  fetchWithTimeout,
  joinUrl,
  ProviderError,
  readErrorBody,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type LlmProvider,
  type ProviderConfig,
  type ToolCall
} from './types'

function mapMessages(req: ChatRequest): unknown[] {
  const out: unknown[] = []
  const system = req.system.map((b) => b.text).join('\n\n')
  if (system) out.push({ role: 'system', content: system })
  for (const m of req.messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content })
    else if (m.role === 'assistant') {
      const msg: Record<string, unknown> = { role: 'assistant', content: m.content || null }
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } }))
      }
      out.push(msg)
    } else out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content })
  }
  return out
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly kind: string
  readonly model: string
  private readonly cfg: ProviderConfig
  private readonly fetchImpl: typeof fetch

  constructor(cfg: ProviderConfig) {
    this.cfg = cfg
    this.kind = cfg.kind
    this.model = cfg.model
    this.fetchImpl = cfg.fetchImpl ?? fetch
  }

  get supportsEmbeddings(): boolean {
    return Boolean(this.cfg.embeddingModel)
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' }
    if (this.cfg.apiKey) h.authorization = `Bearer ${this.cfg.apiKey}`
    return h
  }

  async complete(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    if (!this.model) throw new ProviderError('No model is configured. Pick one in Settings.', 'bad_request')
    const body: Record<string, unknown> = { model: this.model, messages: mapMessages(req) }
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
      if (req.toolChoice) {
        body.tool_choice = typeof req.toolChoice === 'string' ? req.toolChoice : { type: 'function', function: { name: req.toolChoice.name } }
      }
    }
    const res = await fetchWithTimeout(this.fetchImpl, joinUrl(this.cfg.baseUrl, '/chat/completions'), { method: 'POST', headers: this.headers(), body: JSON.stringify(body) }, this.cfg.timeoutMs ?? 90_000, signal)
    if (!res.ok) throw classifyHttpError(res.status, await readErrorBody(res))
    const json: any = await res.json()
    const choice = json?.choices?.[0]
    const message = choice?.message ?? {}
    const toolCalls: ToolCall[] = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((tc: any, i: number) => ({ id: String(tc.id ?? `call_${i}`), name: String(tc.function?.name ?? ''), args: parseArgs(tc.function?.arguments) }))
      : []
    const content = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.map((p: any) => p?.text ?? '').join('') : ''
    return {
      text: content,
      toolCalls,
      usage: {
        inputTokens: Number(json?.usage?.prompt_tokens ?? 0),
        outputTokens: Number(json?.usage?.completion_tokens ?? 0),
        cachedInputTokens: Number(json?.usage?.prompt_tokens_details?.cached_tokens ?? 0)
      },
      model: String(json?.model ?? this.model),
      stopReason: String(choice?.finish_reason ?? '')
    }
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (!this.cfg.embeddingModel) throw new ProviderError('No embedding model is configured.', 'bad_request')
    const res = await fetchWithTimeout(
      this.fetchImpl,
      joinUrl(this.cfg.baseUrl, '/embeddings'),
      { method: 'POST', headers: this.headers(), body: JSON.stringify({ model: this.cfg.embeddingModel, input: texts }) },
      this.cfg.timeoutMs ?? 90_000,
      signal
    )
    if (!res.ok) throw classifyHttpError(res.status, await readErrorBody(res))
    const json: any = await res.json()
    const data: any[] = Array.isArray(json?.data) ? json.data : []
    data.sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
    return data.map((d) => (Array.isArray(d.embedding) ? d.embedding.map(Number) : []))
  }

  async listModels(): Promise<string[]> {
    const res = await fetchWithTimeout(this.fetchImpl, joinUrl(this.cfg.baseUrl, '/models'), { method: 'GET', headers: this.headers() }, 20_000)
    if (!res.ok) throw classifyHttpError(res.status, await readErrorBody(res))
    const json: any = await res.json()
    const data: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : []
    return data
      .map((d) => String(d?.id ?? d?.name ?? ''))
      .filter(Boolean)
      .sort()
  }
}

export type { ChatMessage }
