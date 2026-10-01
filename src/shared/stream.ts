// Streamed chat answers (server-sent events), put together as they arrive. The provider adapters use it to pass text
// on while it is written; the "What was sent" view uses it to read a streamed response like any other.

export interface SseEvent {
  /** The `event:` line, when the server names its events (Anthropic does; OpenAI does not). */
  event?: string
  data: string
}

/** The complete events in a buffer of SSE text, and the incomplete tail to carry into the next read. */
export function splitSse(buffer: string): { events: SseEvent[]; rest: string } {
  const text = buffer.replace(/\r\n?/g, '\n')
  const events: SseEvent[] = []
  let start = 0
  for (;;) {
    const end = text.indexOf('\n\n', start)
    if (end < 0) break
    const block = text.slice(start, end)
    start = end + 2
    let event: string | undefined
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (data.length) events.push({ ...(event ? { event } : {}), data: data.join('\n') })
  }
  return { events, rest: text.slice(start) }
}

/** Whether a response body is a stream of server-sent events rather than one JSON document. */
export function isSse(body: string): boolean {
  return /^(?:event|data): /m.test(body.slice(0, 2000)) && !body.trimStart().startsWith('{')
}

export interface StreamedToolCall {
  id: string
  name: string
  /** The arguments' JSON, as streamed. */
  args: string
}

/** A chat answer streamed in either protocol: OpenAI chat-completions chunks, or Anthropic message events. */
export class StreamedAnswer {
  text = ''
  model = ''
  stopReason = ''
  error: string | null = null
  done = false
  readonly usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }
  private readonly calls: StreamedToolCall[] = []
  /** Anthropic content blocks by index: which are tool calls. */
  private readonly blocks = new Map<number, number>()

  get toolCalls(): StreamedToolCall[] {
    return this.calls.filter((c) => c.name || c.args)
  }

  /** Takes one event in; returns the text it adds to the answer, if any. */
  push(e: SseEvent): string {
    if (e.data === '[DONE]') {
      this.done = true
      return ''
    }
    let json: any
    try {
      json = JSON.parse(e.data)
    } catch {
      return ''
    }
    if (!json || typeof json !== 'object') return ''
    const type = typeof json.type === 'string' ? json.type : e.event
    if (json.error) {
      const err = json.error
      this.error = typeof err === 'string' ? err : typeof err?.message === 'string' ? err.message : JSON.stringify(err)
      return ''
    }
    // OpenAI and the servers that speak its protocol.
    if (Array.isArray(json.choices) || json.object === 'chat.completion.chunk') {
      if (json.model) this.model = String(json.model)
      const usage = json.usage ?? json.x_groq?.usage
      if (usage) {
        this.usage.inputTokens = Number(usage.prompt_tokens ?? this.usage.inputTokens)
        this.usage.outputTokens = Number(usage.completion_tokens ?? this.usage.outputTokens)
        this.usage.cachedInputTokens = Number(usage.prompt_tokens_details?.cached_tokens ?? this.usage.cachedInputTokens)
      }
      const choice = Array.isArray(json.choices) ? json.choices[0] : undefined
      if (!choice) return ''
      if (choice.finish_reason) this.stopReason = String(choice.finish_reason)
      const delta = choice.delta ?? {}
      for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const at = typeof tc.index === 'number' ? tc.index : this.calls.length
        const call = (this.calls[at] ??= { id: '', name: '', args: '' })
        if (tc.id) call.id = String(tc.id)
        if (tc.function?.name) call.name += String(tc.function.name)
        if (typeof tc.function?.arguments === 'string') call.args += tc.function.arguments
        else if (tc.function?.arguments && typeof tc.function.arguments === 'object') call.args = JSON.stringify(tc.function.arguments)
      }
      const added = typeof delta.content === 'string' ? delta.content : ''
      this.text += added
      return added
    }
    // Anthropic.
    switch (type) {
      case 'message_start': {
        const m = json.message ?? {}
        if (m.model) this.model = String(m.model)
        this.usage.inputTokens = Number(m.usage?.input_tokens ?? 0)
        this.usage.cachedInputTokens = Number(m.usage?.cache_read_input_tokens ?? 0)
        this.usage.outputTokens = Number(m.usage?.output_tokens ?? 0)
        return ''
      }
      case 'content_block_start': {
        const block = json.content_block ?? {}
        if (block.type === 'tool_use') {
          this.blocks.set(Number(json.index), this.calls.length)
          this.calls.push({ id: String(block.id ?? ''), name: String(block.name ?? ''), args: '' })
        } else if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          this.text += block.text
          return block.text
        }
        return ''
      }
      case 'content_block_delta': {
        const d = json.delta ?? {}
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          this.text += d.text
          return d.text
        }
        if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          const at = this.blocks.get(Number(json.index))
          if (at !== undefined) this.calls[at].args += d.partial_json
        }
        return ''
      }
      case 'message_delta':
        if (json.delta?.stop_reason) this.stopReason = String(json.delta.stop_reason)
        if (json.usage?.output_tokens !== undefined) this.usage.outputTokens = Number(json.usage.output_tokens)
        return ''
      case 'message_stop':
        this.done = true
        return ''
      default:
        return ''
    }
  }
}

/** A whole streamed response body, put together. */
export function readStream(body: string): StreamedAnswer {
  const answer = new StreamedAnswer()
  for (const e of splitSse(`${body}\n\n`).events) answer.push(e)
  return answer
}
