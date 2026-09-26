// Shared fixtures for the privacy tests.
import { PrivacyEngine } from '../../src/main/privacy/engine'
import { GENERAL_PII } from '../../src/main/privacy/policy'
import { PrivacySession } from '../../src/main/privacy/session'
import { PiiVault } from '../../src/main/privacy/vault'
import type { ChatRequest, ChatResponse, LlmProvider } from '../../src/main/ai/providers/types'
import { ProviderError } from '../../src/main/ai/providers/types'

export const policy = GENERAL_PII

export function engine(schemaDetection = true): PrivacyEngine {
  return new PrivacyEngine({ schemaDetection })
}

/** Ids from a counter, so a test can predict placeholders. */
export function sequentialVault(): PiiVault {
  let n = 0
  return new PiiVault(() => (0xa00000 + ++n).toString(16).toUpperCase())
}

export function session(vault = new PiiVault(), e = engine()): PrivacySession {
  return new PrivacySession({ engine: e, policy, vault, host: 'api.example.com' })
}

export async function protectText(text: string, vault = new PiiVault(), e = engine()): Promise<{ text: string; vault: PiiVault }> {
  const [p] = await e.protectAll([{ text, ctx: { role: 'prose' } }], vault, policy)
  return { text: p.text, vault }
}

/** Every string a request would put on the wire, flattened, for "never contains" assertions. */
export function wireText(value: unknown): string {
  return JSON.stringify(value)
}

export type Script = (req: ChatRequest, call: number) => ChatResponse

/** A provider that records exactly what it was given and answers from a script. */
export function recordingProvider(script: Script, opts: { supportsEmbeddings?: boolean } = {}): LlmProvider & { requests: ChatRequest[]; embedded: string[][] } {
  const requests: ChatRequest[] = []
  const embedded: string[][] = []
  return {
    kind: 'mock',
    model: 'mock-1',
    supportsEmbeddings: opts.supportsEmbeddings ?? false,
    requests,
    embedded,
    async complete(req, signal) {
      if (signal?.aborted) throw new ProviderError('Cancelled.', 'cancelled')
      requests.push(structuredClone(req))
      return script(req, requests.length)
    },
    async embed(texts) {
      embedded.push([...texts])
      return texts.map(() => [1, 0])
    },
    async listModels() {
      return ['mock-1']
    }
  }
}

export function reply(partial: Partial<ChatResponse>): ChatResponse {
  return { text: '', toolCalls: [], usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 }, model: 'mock-1', stopReason: 'stop', ...partial }
}

/** The pseudonym placeholders in a text, in order. */
export function placeholders(text: string): string[] {
  return [...text.matchAll(/<\|PII:[A-Z_]+:[0-9A-F]{6}\|>/g)].map((m) => m[0])
}
