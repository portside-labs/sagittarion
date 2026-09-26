// Applies resolved spans to a text: pseudonyms from the vault, masks, generalizations and redactions. Offsets are
// checked first; a span that does not fit the text stops the request instead of producing something half-replaced.
import { GENERALIZERS, maskShown, type PrivacyPolicy } from './policy'
import { generalized, masked, redaction } from './markers'
import type { ResolvedSpan } from './resolver'
import type { PiiVault, VaultEntry } from './vault'
import { PrivacyBlockedError } from './errors'

export interface Replacement {
  /** Offsets in the input text. */
  start: number
  end: number
  marker: string
  entry: VaultEntry
}

export interface Transformed {
  text: string
  replacements: Replacement[]
}

/** The value a span stands for: an exact known value keeps its canonical form ("O''Brien" in SQL is "O'Brien"). */
export function valueOf(text: string, span: ResolvedSpan): string {
  const canonical = span.primary.metadata?.canonical
  if (typeof canonical === 'string' && span.primary.start === span.start && span.primary.end === span.end) return canonical
  return text.slice(span.start, span.end)
}

export function checkSpans(text: string, spans: { start: number; end: number }[]): void {
  let last = 0
  for (const s of spans) {
    if (!Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start < last || s.end <= s.start || s.end > text.length) {
      throw new PrivacyBlockedError('invalid-offsets', [])
    }
    last = s.end
  }
}

/** Records the decision for a span in the vault and returns the placeholder that replaces it. */
export function markerFor(value: string, span: ResolvedSpan, vault: PiiVault): { marker: string; entry: VaultEntry } | null {
  const { action, rehydrate } = span.decision
  switch (action) {
    case 'preserve':
      return null
    case 'pseudonymize': {
      const entry = vault.pseudonymFor(value, span.type, rehydrate)
      return { marker: entry.token!, entry }
    }
    case 'redact':
      return { marker: redaction(span.type), entry: vault.withhold(value, span.type, 'redact') }
    case 'mask':
      return { marker: masked(span.type, maskShown(value)), entry: vault.withhold(value, span.type, 'mask') }
    case 'generalize': {
      const shown = GENERALIZERS[span.type]?.(value) ?? undefined
      return { marker: generalized(span.type, shown ?? undefined), entry: vault.withhold(value, span.type, 'generalize') }
    }
  }
}

export function transform(text: string, spans: ResolvedSpan[], vault: PiiVault, _policy: PrivacyPolicy): Transformed {
  const active = spans.filter((s) => s.decision.action !== 'preserve')
  checkSpans(text, active)
  let out = ''
  let pos = 0
  const replacements: Replacement[] = []
  for (const span of active) {
    const made = markerFor(valueOf(text, span), span, vault)
    if (!made) continue
    out += text.slice(pos, span.start) + made.marker
    replacements.push({ start: span.start, end: span.end, marker: made.marker, entry: made.entry })
    pos = span.end
  }
  return { text: out + text.slice(pos), replacements }
}
