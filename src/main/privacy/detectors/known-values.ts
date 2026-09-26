// Every value already protected in the conversation is protected wherever else it turns up: a name that came from
// a sample value, echoed back by a database error or written into the SQL of an earlier turn. Exact, case-sensitive
// matches on word boundaries, including the SQL-escaped form ('' for ') that restored queries contain.
import type { PiiVault } from '../vault'
import type { SensitiveDetection } from '../types'

const WORD_CHAR = /[\p{L}\p{N}_]/u

function bounded(text: string, start: number, end: number, needle: string): boolean {
  if (WORD_CHAR.test(needle[0]) && start > 0 && WORD_CHAR.test(text[start - 1])) return false
  if (WORD_CHAR.test(needle[needle.length - 1]) && end < text.length && WORD_CHAR.test(text[end])) return false
  return true
}

/**
 * How often a value occurs in texts, as the known-values detector would find it: exact, on word boundaries, and in
 * its JSON-escaped form too, since request bodies are JSON.
 */
export function countOccurrences(texts: string[], value: string): number {
  if (!value) return 0
  const needles = new Set([value, JSON.stringify(value).slice(1, -1)])
  let n = 0
  for (const text of texts) {
    for (const needle of needles) {
      for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) if (bounded(text, i, i + needle.length, needle)) n++
    }
  }
  return n
}

export class KnownValueDetector {
  readonly id = 'known-values'
  readonly version = 1

  /** Shorter values are only protected where a detector finds them; on their own they would match everywhere. */
  constructor(readonly minLength = 3) {}

  detect(text: string, vault: PiiVault): SensitiveDetection[] {
    const out: SensitiveDetection[] = []
    if (!text) return out
    for (const entry of vault.entries()) {
      if (entry.value.length < this.minLength) continue
      const needles = new Set([entry.value, entry.value.replace(/'/g, "''")])
      for (const needle of needles) {
        for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
          const end = i + needle.length
          if (!bounded(text, i, end, needle)) continue
          out.push({
            start: i,
            end,
            value: needle,
            type: entry.type,
            confidence: 1,
            source: 'deterministic',
            detector: this.id,
            validated: true,
            metadata: { canonical: entry.value }
          })
        }
      }
    }
    return out
  }
}
