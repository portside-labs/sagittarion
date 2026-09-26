// Transcripts of what crossed to the provider, kept so the user can inspect any answer's exchange on demand.
// Memory only, capped, dropped when the chat is reset or its connection closes. A transcript of a protected ask
// holds no protected value: request and response bodies carry placeholders, and its legend holds placeholders and
// counts. Values come from the live vault, and only when the viewer explicitly asks for them.
import type { AiTranscript, AiTranscriptEntry } from '@shared/privacy'
import type { PiiVault } from './vault'

export type StoredTranscript = Omit<AiTranscript, 'valuesAvailable'>

interface Held {
  sessionId: string
  conversationId: string
  transcript: StoredTranscript
  bytes: number
}

function sizeOf(t: StoredTranscript): number {
  return t.exchanges.reduce((n, x) => n + x.request.length + (x.response?.length ?? 0), 0)
}

export class TranscriptStore {
  private readonly held = new Map<string, Held>()
  private bytes = 0

  constructor(private readonly opts: { maxTranscripts: number; maxBytes: number } = { maxTranscripts: 40, maxBytes: 32_000_000 }) {}

  put(sessionId: string, conversationId: string, transcript: StoredTranscript): void {
    this.drop(transcript.requestId)
    const held: Held = { sessionId, conversationId, transcript, bytes: sizeOf(transcript) }
    this.held.set(transcript.requestId, held)
    this.bytes += held.bytes
    // Oldest first; the newest is always kept, however large.
    for (const [id] of this.held) {
      if (this.held.size <= 1 || (this.held.size <= this.opts.maxTranscripts && this.bytes <= this.opts.maxBytes)) break
      this.drop(id)
    }
  }

  get(requestId: string): Held | undefined {
    return this.held.get(requestId)
  }

  forgetConversation(conversationId: string): void {
    for (const [id, h] of [...this.held]) if (h.conversationId === conversationId) this.drop(id)
  }

  forgetSession(sessionId: string): void {
    for (const [id, h] of [...this.held]) if (h.sessionId === sessionId) this.drop(id)
  }

  get size(): number {
    return this.held.size
  }

  private drop(requestId: string): void {
    const h = this.held.get(requestId)
    if (!h) return
    this.bytes -= h.bytes
    this.held.delete(requestId)
  }
}

/**
 * The transcript as the viewer gets it. With `values`, placeholders the policy restores anyway are paired with their
 * values from the conversation's vault, if it is still in memory. Secrets, masks and generalizations never are.
 */
export function transcriptForViewer(stored: StoredTranscript, vault: PiiVault | undefined, values: boolean): AiTranscript {
  const legend: AiTranscriptEntry[] = stored.legend.map((e) => {
    if (!values || !vault || !e.restorable || e.action !== 'pseudonymize') return { ...e }
    const entry = vault.resolve(e.marker)
    return entry ? { ...e, value: entry.value } : { ...e }
  })
  return { ...stored, legend, valuesAvailable: Boolean(vault) && stored.legend.some((e) => e.restorable) }
}
