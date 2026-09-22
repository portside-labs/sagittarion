// Provider-neutral chat and tool-calling types. Adapters translate to each wire protocol.

export interface ToolDef {
  name: string
  description: string
  /** JSON schema for the arguments object. */
  parameters: Record<string, unknown>
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string }

export interface SystemBlock {
  text: string
  /** Hint that this block is stable across requests and worth caching provider-side. */
  cacheable?: boolean
}

export interface ChatRequest {
  system: SystemBlock[]
  messages: ChatMessage[]
  tools?: ToolDef[]
  toolChoice?: 'auto' | 'none' | { name: string }
  maxTokens?: number
}

export interface ChatUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
}

export interface ChatResponse {
  text: string
  toolCalls: ToolCall[]
  usage: ChatUsage
  model: string
  stopReason: string
}

export type ProviderErrorKind = 'auth' | 'rate_limit' | 'not_found' | 'bad_request' | 'tools_unsupported' | 'network' | 'server' | 'cancelled' | 'unknown'

export class ProviderError extends Error {
  readonly status?: number
  readonly errorKind: ProviderErrorKind
  constructor(message: string, errorKind: ProviderErrorKind = 'unknown', status?: number) {
    super(message)
    this.name = 'ProviderError'
    this.errorKind = errorKind
    this.status = status
  }
}

export interface LlmProvider {
  readonly kind: string
  readonly model: string
  readonly supportsEmbeddings: boolean
  complete(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>
  listModels(): Promise<string[]>
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProviderError('Cancelled.', 'cancelled')
}

export interface ProviderConfig {
  protocol: 'openai' | 'anthropic'
  kind: string
  baseUrl: string
  apiKey: string | null
  model: string
  embeddingModel: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`)
}

/** Tolerant JSON: accepts fenced blocks and leading/trailing prose. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  const candidates = [fenced ? fenced[1] : trimmed, trimmed]
  for (const c of candidates) {
    const start = c.indexOf('{')
    if (start < 0) continue
    let depth = 0
    let inString = false
    let escape = false
    for (let i = start; i < c.length; i++) {
      const ch = c[i]
      if (inString) {
        if (escape) escape = false
        else if (ch === '\\') escape = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          try {
            const parsed = JSON.parse(c.slice(start, i + 1))
            if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
          } catch {
            /* try next candidate */
          }
          break
        }
      }
    }
  }
  return null
}

export async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  throwIfAborted(signal)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } catch (err: any) {
    if (signal?.aborted) throw new ProviderError('Cancelled.', 'cancelled')
    if (err?.name === 'AbortError') throw new ProviderError(`The provider did not answer within ${Math.round(timeoutMs / 1000)}s.`, 'network')
    const msg = String(err?.cause?.code ?? err?.message ?? err)
    const host = (() => {
      try {
        return new URL(url).host
      } catch {
        return url
      }
    })()
    const hint = /localhost|127\.0\.0\.1/.test(host) ? ' Is the local server running?' : ''
    throw new ProviderError(`Could not reach ${host} (${msg}).${hint}`, 'network')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

export async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text()
    try {
      const json = JSON.parse(text)
      const msg = json?.error?.message ?? json?.message ?? json?.error
      return typeof msg === 'string' ? msg : text.slice(0, 500)
    } catch {
      return text.slice(0, 500)
    }
  } catch {
    return ''
  }
}

export function classifyHttpError(status: number, message: string): ProviderError {
  const m = message || `HTTP ${status}`
  if (status === 401 || status === 403) return new ProviderError(`The provider rejected the API key (${m}).`, 'auth', status)
  if (status === 404) return new ProviderError(`Not found: check the base URL and model name (${m}).`, 'not_found', status)
  if (status === 429) return new ProviderError(`Rate limited by the provider (${m}). Try again in a moment.`, 'rate_limit', status)
  if (status === 400 && /tool|function/i.test(m)) return new ProviderError(`This model does not support tool calling (${m}).`, 'tools_unsupported', status)
  if (status >= 400 && status < 500) return new ProviderError(`The provider rejected the request (${m}).`, 'bad_request', status)
  return new ProviderError(`The provider returned an error (${status}: ${m}).`, 'server', status)
}
