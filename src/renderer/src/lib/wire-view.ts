// Reading what was sent to a model provider: request and response bodies, exactly as they went over the network,
// turned into labelled sections for people, with placeholders and search matches marked. Nothing here changes the
// bytes; the raw view shows them as they are.
import { PLACEHOLDER_SOURCE } from '@shared/privacy'
import { isSse, readStream } from '@shared/stream'

export interface WireSection {
  label: string
  text: string
  /** Pretty-printed JSON rather than prose. */
  json?: boolean
  /** Starts folded: long, fixed parts such as tool definitions. */
  collapsed?: boolean
  /** What a folded section shows instead of its first line. */
  summary?: string
}

type Json = Record<string, unknown>

function parse(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

function isObject(v: unknown): v is Json {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

function pretty(v: unknown): string {
  return JSON.stringify(v, null, 2)
}

/** Tool-call arguments arrive as a JSON string in the OpenAI protocol. */
function prettyArgs(args: unknown): string {
  if (typeof args !== 'string') return pretty(args ?? {})
  const parsed = parse(args)
  return parsed === undefined ? args : pretty(parsed)
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b) => (isObject(b) && typeof b.text === 'string' ? b.text : pretty(b))).join('\n')
  return content == null ? '' : pretty(content)
}

function messageSections(m: Json): WireSection[] {
  const role = typeof m.role === 'string' ? m.role : 'message'
  if (role === 'tool') return [{ label: `tool result${m.tool_call_id ? ` · ${m.tool_call_id}` : ''}`, text: contentText(m.content) }]
  const out: WireSection[] = []
  if (typeof m.content === 'string') {
    if (m.content) out.push({ label: role, text: m.content })
  } else if (Array.isArray(m.content)) {
    for (const block of m.content) {
      if (!isObject(block)) continue
      if (block.type === 'text') out.push({ label: role, text: String(block.text ?? '') })
      else if (block.type === 'tool_use') out.push({ label: `${role} → ${block.name}`, text: pretty(block.input ?? {}), json: true })
      else if (block.type === 'tool_result') out.push({ label: `tool result${block.tool_use_id ? ` · ${block.tool_use_id}` : ''}`, text: contentText(block.content) })
      else out.push({ label: role, text: pretty(block), json: true })
    }
  }
  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) {
      const fn = isObject(tc) && isObject(tc.function) ? tc.function : {}
      out.push({ label: `${role} → ${String(fn.name ?? 'tool')}`, text: prettyArgs(fn.arguments), json: true })
    }
  }
  return out.length ? out : [{ label: role, text: '' }]
}

const REQUEST_SETTINGS = ['model', 'max_tokens', 'tool_choice', 'temperature', 'stream', 'encoding_format', 'dimensions']

/** System prompts longer than this start folded, so the question is the first thing in view. */
const FOLD_SYSTEM = 800

/** A request body as sections: settings, system instructions, each message, tool definitions (folded). */
export function readableRequest(body: string): WireSection[] {
  const json = parse(body)
  if (!isObject(json)) return [{ label: 'body', text: body }]
  const out: WireSection[] = []
  const settings = Object.fromEntries(REQUEST_SETTINGS.filter((k) => k in json).map((k) => [k, json[k]]))
  if (Object.keys(settings).length) out.push({ label: 'settings', text: pretty(settings), json: true })
  const system = (label: string, text: string): WireSection => ({ label, text, ...(text.length > FOLD_SYSTEM ? { collapsed: true } : {}) })
  if (typeof json.system === 'string') out.push(system('system', json.system))
  else if (Array.isArray(json.system)) {
    for (const b of json.system) out.push(system(isObject(b) && b.cache_control ? 'system · cached' : 'system', contentText([b])))
  }
  if (Array.isArray(json.messages)) {
    for (const m of json.messages) {
      if (!isObject(m)) continue
      for (const section of messageSections(m)) out.push(section.label === 'system' ? system('system', section.text) : section)
    }
  }
  if (typeof json.input === 'string') out.push({ label: 'input', text: json.input })
  else if (Array.isArray(json.input)) json.input.forEach((t, i) => out.push({ label: `input ${i + 1}`, text: typeof t === 'string' ? t : pretty(t) }))
  if (Array.isArray(json.tools)) {
    const names = json.tools.map((t) => (isObject(t) ? (isObject(t.function) ? t.function.name : t.name) : undefined)).filter((n): n is string => typeof n === 'string')
    out.push({ label: `tool definitions (${json.tools.length})`, text: pretty(json.tools), json: true, collapsed: true, ...(names.length ? { summary: names.join(', ') } : {}) })
  }
  const known = new Set([...REQUEST_SETTINGS, 'system', 'messages', 'input', 'tools'])
  const rest = Object.fromEntries(Object.entries(json).filter(([k]) => !known.has(k)))
  if (Object.keys(rest).length) out.push({ label: 'other fields', text: pretty(rest), json: true })
  return out
}

/** A response body as sections: what the model said, the tools it called, and what it reported about usage. */
export function readableResponse(body: string | null): WireSection[] {
  if (body === null) return [{ label: 'response', text: 'No response arrived.' }]
  // A streamed answer arrives in pieces; read it put together, as one answer.
  if (isSse(body)) {
    const streamed = readStream(body)
    const out: WireSection[] = []
    if (streamed.error) out.push({ label: 'error', text: streamed.error })
    if (streamed.text) out.push({ label: 'assistant', text: streamed.text })
    for (const call of streamed.toolCalls) out.push({ label: `assistant → ${call.name}`, text: prettyArgs(call.args), json: true })
    out.push({ label: 'details', text: pretty({ model: streamed.model, stop_reason: streamed.stopReason, usage: streamed.usage, streamed: true }), json: true })
    return out
  }
  const json = parse(body)
  if (!isObject(json)) return [{ label: 'response', text: body }]
  if (json.error) {
    const e = json.error
    return [{ label: 'error', text: typeof e === 'string' ? e : isObject(e) && typeof e.message === 'string' ? e.message : pretty(e) }]
  }
  const out: WireSection[] = []
  if (Array.isArray(json.choices)) {
    const choice = isObject(json.choices[0]) ? json.choices[0] : {}
    const message = isObject(choice.message) ? choice.message : {}
    out.push(...messageSections({ ...message, role: 'assistant' }).filter((s) => s.text || s.label !== 'assistant'))
  } else if (Array.isArray(json.content)) {
    out.push(...messageSections({ role: 'assistant', content: json.content }).filter((s) => s.text || s.label !== 'assistant'))
  } else if (Array.isArray(json.data) && json.data.some((d) => isObject(d) && Array.isArray(d.embedding))) {
    const first = json.data.find((d): d is Json => isObject(d) && Array.isArray(d.embedding))
    const dims = first && Array.isArray(first.embedding) ? first.embedding.length : 0
    out.push({ label: 'embeddings', text: `${json.data.length} vector${json.data.length === 1 ? '' : 's'} of ${dims} numbers each. The numbers are in the raw view.` })
  }
  const meta = Object.fromEntries(['model', 'usage', 'stop_reason', 'finish_reason'].filter((k) => k in json).map((k) => [k, json[k]]))
  if (Array.isArray(json.choices) && isObject(json.choices[0]) && 'finish_reason' in json.choices[0]) meta.finish_reason = json.choices[0].finish_reason
  if (Object.keys(meta).length) out.push({ label: 'details', text: pretty(meta), json: true })
  return out.length ? out : [{ label: 'response', text: pretty(json), json: true }]
}

export interface MarkedPart {
  text: string
  kind: 'plain' | 'placeholder' | 'match'
}

function needlesFor(query: string): string[] {
  const q = query.trim()
  if (!q) return []
  return [...new Set([q, JSON.stringify(q).slice(1, -1)].map((n) => n.toLowerCase()))]
}

/** Case-insensitive occurrences of a search in each text, including its JSON-escaped form (bodies are JSON). */
export function countMatches(texts: (string | null)[], query: string): number[] {
  const needles = needlesFor(query)
  return texts.map((t) => {
    if (!t || !needles.length) return 0
    const hay = t.toLowerCase()
    let n = 0
    for (const needle of needles) for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++
    return n
  })
}

/** The text in pieces: placeholders, search matches (case-insensitive) and everything else, in order. */
export function markText(text: string, query = ''): MarkedPart[] {
  const parts: MarkedPart[] = []
  const needles = needlesFor(query)
  const plain = (s: string) => {
    if (!s) return
    if (!needles.length) {
      parts.push({ text: s, kind: 'plain' })
      return
    }
    const lower = s.toLowerCase()
    let pos = 0
    while (pos < s.length) {
      let at = -1
      let len = 0
      for (const n of needles) {
        const i = lower.indexOf(n, pos)
        if (i >= 0 && (at < 0 || i < at)) {
          at = i
          len = n.length
        }
      }
      if (at < 0) break
      if (at > pos) parts.push({ text: s.slice(pos, at), kind: 'plain' })
      parts.push({ text: s.slice(at, at + len), kind: 'match' })
      pos = at + len
    }
    if (pos < s.length) parts.push({ text: s.slice(pos), kind: 'plain' })
  }
  let pos = 0
  for (const m of text.matchAll(new RegExp(PLACEHOLDER_SOURCE, 'g'))) {
    const at = m.index ?? 0
    plain(text.slice(pos, at))
    parts.push({ text: m[0], kind: 'placeholder' })
    pos = at + m[0].length
  }
  plain(text.slice(pos))
  return parts
}
