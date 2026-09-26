// What actually went over the network during an ask. The recorder wraps the fetch the provider adapters use, so it
// captures the exact bytes of each request body and response body: the proof behind "what was sent". Headers are
// never recorded (they carry the API key), and query-string values in the URL are blanked.
import type { AiWireExchange } from '@shared/privacy'

/** Bodies larger than this keep their beginning only; the original size is recorded. */
const MAX_REQUEST = 8_000_000
const MAX_RESPONSE = 2_000_000

/** The URL with every query value blanked: a key in ?api-key=… must not end up on screen. */
export function blankQuery(url: string): string {
  try {
    const u = new URL(url)
    if (u.username || u.password) {
      u.username = u.username ? '•••' : ''
      u.password = u.password ? '•••' : ''
    }
    for (const key of [...u.searchParams.keys()]) u.searchParams.set(key, '•••')
    return u.toString()
  } catch {
    return url.replace(/([?&][^=&#]+=)[^&#]*/g, '$1•••')
  }
}

function kindOf(url: string): AiWireExchange['kind'] {
  if (/\/embeddings(?:[?#]|$)/.test(url)) return 'embeddings'
  if (/\/chat\/completions(?:[?#]|$)|\/v1\/messages(?:[?#]|$)/.test(url)) return 'chat'
  return 'other'
}

function keep(text: string, max: number): { text: string; size?: number } {
  return text.length > max ? { text: text.slice(0, max), size: text.length } : { text }
}

export class WireRecorder {
  readonly exchanges: AiWireExchange[] = []

  constructor(private readonly base: typeof fetch = fetch) {}

  /** A fetch for the provider adapters that records each exchange and otherwise behaves exactly like fetch. */
  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const body = init?.body
    const request = keep(typeof body === 'string' ? body : body == null ? '' : '[a body that is not text; not recorded]', MAX_REQUEST)
    const exchange: AiWireExchange = {
      n: this.exchanges.length + 1,
      kind: kindOf(url),
      method: (init?.method ?? 'GET').toUpperCase(),
      url: blankQuery(url),
      at: Date.now(),
      durationMs: 0,
      request: request.text,
      status: null,
      response: null,
      ...(request.size ? { truncated: { request: request.size } } : {})
    }
    this.exchanges.push(exchange)
    const started = performance.now()
    try {
      const res = await this.base(input, init)
      exchange.status = res.status
      const text = await res
        .clone()
        .text()
        .catch(() => null)
      if (text !== null) {
        const response = keep(text, MAX_RESPONSE)
        exchange.response = response.text
        if (response.size) exchange.truncated = { ...exchange.truncated, response: response.size }
      }
      return res
    } catch (err) {
      exchange.error = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      exchange.durationMs = Math.round(performance.now() - started)
    }
  }) as typeof fetch
}
