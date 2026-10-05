// A short name for a conversation's tab, which the model gives with the answer to its first question (TITLE_REQUEST
// in prompt.ts), rather than in a request of its own.

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
