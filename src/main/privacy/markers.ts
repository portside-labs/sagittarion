// Placeholder syntax. Unusual on purpose, so a model is unlikely to produce it by accident and a scanner cannot
// mistake it for data:
//   <|PII:PERSON:A81F32|>        a pseudonym, restorable when the policy allows
//   <|REDACTED:PASSWORD|>        removed, never restored
//   <|MASKED:CARD:1111|>         partly shown, never restored
//   <|GENERALIZED:DOB:1984|>     coarsened, never restored
import { ENTITY_TYPES, PLACEHOLDER_SOURCE, typeForTag, type SensitiveEntityType } from '@shared/privacy'

export type MarkerKind = 'pii' | 'redacted' | 'masked' | 'generalized'

export interface Marker {
  kind: MarkerKind
  text: string
  start: number
  end: number
  tag: string
  /** Undefined when the tag is not one the app issues. */
  type?: SensitiveEntityType
  /** Pseudonym id, six hex digits. */
  id?: string
  /** The visible part of a mask or generalization. */
  shown?: string
}

const MARKER_SOURCE = PLACEHOLDER_SOURCE

/** Something shaped like a placeholder, well formed or not. */
const LOOSE_SOURCE = `<?\\|?[ \\t]*(PII|REDACTED|MASKED|GENERALIZED)[ \\t]*:[ \\t]*[A-Za-z][A-Za-z0-9_]{0,31}(?:[ \\t]*:[ \\t]*[A-Za-z0-9+.\\-]{1,24})?[ \\t]*\\|?>?`

/** Pseudonym ids used in the instructions to the model; never issued, so a copied example cannot resolve. */
export const EXAMPLE_IDS = ['0000AB', '0000CD'] as const

/** Filler for masked-out placeholders: a private-use character no detector matches. */
export const FILLER = '\uE000'

export function pseudonym(type: SensitiveEntityType, id: string): string {
  return `<|PII:${ENTITY_TYPES[type].tag}:${id}|>`
}

export function redaction(type: SensitiveEntityType): string {
  return `<|REDACTED:${ENTITY_TYPES[type].tag}|>`
}

export function masked(type: SensitiveEntityType, shown?: string): string {
  return `<|MASKED:${ENTITY_TYPES[type].tag}${shown ? `:${shown}` : ''}|>`
}

export function generalized(type: SensitiveEntityType, shown?: string): string {
  return `<|GENERALIZED:${ENTITY_TYPES[type].tag}${shown ? `:${shown}` : ''}|>`
}

/** Every well-formed placeholder in the text, in order. */
export function findMarkers(text: string): Marker[] {
  const out: Marker[] = []
  if (!text.includes('<|')) return out
  const re = new RegExp(MARKER_SOURCE, 'g')
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0
    const base = { text: m[0], start, end: start + m[0].length }
    if (m[1] !== undefined) out.push({ ...base, kind: 'pii', tag: m[1], type: typeForTag(m[1]), id: m[2] })
    else if (m[3] !== undefined) out.push({ ...base, kind: 'redacted', tag: m[3], type: typeForTag(m[3]) })
    else if (m[4] !== undefined) out.push({ ...base, kind: 'masked', tag: m[4], type: typeForTag(m[4]), shown: m[5] })
    else out.push({ ...base, kind: 'generalized', tag: m[6], type: typeForTag(m[6]), shown: m[7] })
  }
  return out
}

/** A single well-formed placeholder and nothing else. */
export function parseMarker(text: string): Marker | null {
  const found = findMarkers(text)
  return found.length === 1 && found[0].start === 0 && found[0].end === text.length ? found[0] : null
}

/**
 * Placeholder-like fragments that are not well formed, such as <|PII:PERSON:A81F32> or PII:PERSON:A81F32. A pseudonym
 * fragment counts when it keeps its six-digit id; the others only when they keep a delimiter, so prose such as
 * "masked: yes" is not flagged.
 */
export function findDamaged(text: string): { start: number; end: number; text: string }[] {
  if (!/PII|REDACTED|MASKED|GENERALIZED/i.test(text)) return []
  const good = findMarkers(text)
  const out: { start: number; end: number; text: string }[] = []
  const re = new RegExp(LOOSE_SOURCE, 'gi')
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0
    const end = start + m[0].length
    if (good.some((g) => start < g.end && g.start < end)) continue
    const lead = m[0].length - m[0].trimStart().length
    const fragment = m[0].trim()
    const isPii = m[1].toUpperCase() === 'PII'
    if (isPii ? !/:[ \t]*[0-9A-Fa-f]{6}[ \t]*\|?>?$/.test(fragment) : !/<\||\|>|^<|>$/.test(fragment)) continue
    out.push({ start: start + lead, end: start + lead + fragment.length, text: fragment })
  }
  return out
}

/** The text with every well-formed placeholder replaced by filler of the same length, so offsets still line up. */
export function maskMarkers(text: string, markers: Marker[] = findMarkers(text)): string {
  if (!markers.length) return text
  let out = ''
  let pos = 0
  for (const m of markers) {
    out += text.slice(pos, m.start) + FILLER.repeat(m.end - m.start)
    pos = m.end
  }
  return out + text.slice(pos)
}

/** Cuts text to at most `max` characters without splitting a placeholder. */
export function safeSlice(text: string, max: number): string {
  if (text.length <= max) return text
  let cut = max
  for (const m of findMarkers(text)) if (m.start < cut && m.end > cut) cut = m.start
  return text.slice(0, cut)
}
