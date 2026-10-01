// A short name for a conversation's tab, written by the model from its first question. It goes through the same
// gateway as the ask, so it is protected the same way and shows in "What was sent".
import type { ModelGateway } from '../privacy/gateway'

const RULES =
  'Name the conversation that begins with the question below, for a small tab: two to four words, at most 24 characters, ' +
  'in Title Case. Name the subject, not the request. Reply with the name only: no quotes, no punctuation at the end.'

/** The model's name for a conversation, tidied; null when it has none to give. */
export async function conversationTitle(gateway: ModelGateway, question: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await gateway.complete({ system: [{ text: RULES, structured: true }], messages: [{ role: 'user', content: question }], maxTokens: 24 }, signal)
    // Shown here only, so restored; not counted against the answer's own restoring.
    return cleanTitle(gateway.previewText(res.text))
  } catch {
    return null
  }
}

/** A name fit for a tab: one line, no wrapping quotes or trailing punctuation, cut at a word within 28 characters. */
export function cleanTitle(raw: string): string | null {
  let t = (raw.split('\n').find((line) => line.trim()) ?? '').trim()
  t = t.replace(/^(?:title|name)\s*:\s*/i, '')
  t = t.replace(/^[\s"'“”‘’`*#_]+|[\s"'“”‘’`*#_.!?:;,]+$/g, '').replace(/\s+/g, ' ')
  if (!t || t.length < 2) return null
  if (t.length <= 28) return t
  const cut = t.slice(0, 28)
  const space = cut.lastIndexOf(' ')
  return `${(space > 12 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`
}
