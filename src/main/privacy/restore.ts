// Local reconstitution of a model's answer. Exact matching only: a placeholder is restored when it is well formed,
// belongs to this conversation's vault and its policy allows it. Unknown and damaged placeholders stay as they are
// and are counted; there is no fuzzy substitution that could replace something it should not.
import { ENTITY_TYPES, type RestoreEscape, type SealedSpan } from '@shared/privacy'
import { findDamaged, findMarkers, type Marker } from './markers'
import type { PrivacyPolicy } from './policy'
import { regionAt, sqlRegions, type SqlDialect, type SqlRegion } from './sql-regions'
import type { PiiVault, VaultEntry } from './vault'

export interface Restored {
  text: string
  /** Where each restored or displayed placeholder landed, for sealing the turn. */
  spans: SealedSpan[]
  restored: number
  /** Placeholders left unrestored on purpose: redacted, masked, generalized, or not restorable under the policy. */
  withheld: number
  /** Well-formed placeholders this conversation never issued. */
  unknown: string[]
  /** Placeholder-like fragments that are not well formed. */
  damaged: string[]
}

/** Whether a protected value may come back on this computer: a pseudonym the policy restores. */
export function restorable(entry: VaultEntry, policy: PrivacyPolicy): boolean {
  const rule = policy.entities[entry.type]
  return entry.token !== null && entry.rehydrate && rule.action === 'pseudonymize' && rule.rehydrate === true
}

/** Plain words for a value that is not coming back: "[redacted password]", "[card ending 1111]". */
export function displayFor(m: Marker): string {
  const label = m.type ? ENTITY_TYPES[m.type].label : 'value'
  switch (m.kind) {
    case 'pii':
      return `[protected ${label}]`
    case 'redacted':
      return `[redacted ${label}]`
    case 'masked':
      return m.shown ? `[${label} ending ${m.shown}]` : `[masked ${label}]`
    case 'generalized':
      return m.shown ? `[${label}: ${m.shown}]` : `[generalized ${label}]`
  }
}

/** Prose: explanations, clarifications, the progress feed. */
export function restoreText(text: string, vault: PiiVault, policy: PrivacyPolicy): Restored {
  const result: Restored = { text: '', spans: [], restored: 0, withheld: 0, unknown: [], damaged: findDamaged(text).map((d) => d.text) }
  let out = ''
  let pos = 0
  for (const m of findMarkers(text)) {
    out += text.slice(pos, m.start)
    pos = m.end
    const entry = m.kind === 'pii' ? vault.resolve(m.text) : undefined
    if (m.kind === 'pii' && !entry) {
      if (m.id) vault.reserve(m.id)
      result.unknown.push(m.text)
      out += m.text
      continue
    }
    const start = out.length
    if (entry && restorable(entry, policy)) {
      out += entry.value
      result.spans.push({ marker: m.text, start, end: out.length, escape: 'plain' })
      result.restored++
    } else {
      out += displayFor(m)
      result.spans.push({ marker: m.text, start, end: out.length, escape: 'display' })
      result.withheld++
    }
  }
  result.text = out + text.slice(pos)
  return result
}

const WORDISH = /[\p{L}\p{N}_$.&'"`]/u

/** A value written into one SQL region so it cannot end that region early. Null when that is impossible. */
function encodeFor(sql: string, marker: Marker, region: SqlRegion, value: string): { text: string; escape: RestoreEscape } | null {
  switch (region.kind) {
    case 'string':
      return { text: value.replace(/'/g, "''"), escape: 'sql-string' }
    case 'estring':
      return { text: value.replace(/\\/g, '\\\\').replace(/'/g, "''"), escape: 'sql-estring' }
    case 'ident':
      return { text: value.replace(/"/g, '""'), escape: 'sql-ident' }
    case 'backtick':
      return { text: value.replace(/`/g, '``'), escape: 'sql-backtick' }
    case 'bracket':
      return value.includes(']') ? null : { text: value, escape: 'sql-bracket' }
    case 'dollar':
      return region.tag && value.includes(region.tag) ? null : { text: value, escape: 'sql-dollar' }
    case 'line-comment':
      return /[\r\n]/.test(value) ? null : { text: value, escape: 'sql-comment' }
    case 'block-comment':
      return value.includes('*/') || value.includes('/*') ? null : { text: value, escape: 'sql-comment' }
    case 'code': {
      // A bare placeholder glued to other tokens (E<|…|>, 1<|…|>) is ambiguous; refuse rather than guess.
      const before = sql[marker.start - 1] ?? ' '
      const after = sql[marker.end] ?? ' '
      if (WORDISH.test(before) || WORDISH.test(after)) return null
      if (/^\d+(?:\.\d+)?$/.test(value)) return { text: value, escape: 'sql-number' }
      return { text: `'${value.replace(/'/g, "''")}'`, escape: 'sql-quoted' }
    }
  }
}

/**
 * SQL from the model, with each placeholder restored for where it sits: inside '…' with quotes doubled, as a
 * number or a quoted literal when bare, and so on. Values that cannot be written safely stay as placeholders.
 */
export function restoreSql(sql: string, dialect: SqlDialect, vault: PiiVault, policy: PrivacyPolicy): Restored {
  const result: Restored = { text: '', spans: [], restored: 0, withheld: 0, unknown: [], damaged: findDamaged(sql).map((d) => d.text) }
  const markers = findMarkers(sql)
  if (!markers.length) return { ...result, text: sql }
  const regions = sqlRegions(sql, dialect)
  let out = ''
  let pos = 0
  for (const m of markers) {
    out += sql.slice(pos, m.start)
    pos = m.end
    const entry = m.kind === 'pii' ? vault.resolve(m.text) : undefined
    if (m.kind === 'pii' && !entry) {
      if (m.id) vault.reserve(m.id)
      result.unknown.push(m.text)
      out += m.text
      continue
    }
    const region = regionAt(regions, m.start)
    const encoded = entry && region && restorable(entry, policy) ? encodeFor(sql, m, region, entry.value) : null
    if (!encoded) {
      result.withheld++
      out += m.text
      continue
    }
    const start = out.length
    out += encoded.text
    result.spans.push({ marker: m.text, start, end: out.length, escape: encoded.escape })
    result.restored++
  }
  result.text = out + sql.slice(pos)
  return result
}

/** Reads a restored value back out of the text it was written into, undoing the escaping. */
export function decodeRestored(encoded: string, escape: RestoreEscape): string | null {
  switch (escape) {
    case 'plain':
    case 'sql-dollar':
    case 'sql-number':
    case 'sql-comment':
    case 'sql-bracket':
      return encoded
    case 'display':
      return null
    case 'sql-string':
      return encoded.replace(/''/g, '').includes("'") ? null : encoded.replace(/''/g, "'")
    case 'sql-quoted':
      return encoded.length >= 2 && encoded.startsWith("'") && encoded.endsWith("'") ? decodeRestored(encoded.slice(1, -1), 'sql-string') : null
    case 'sql-estring': {
      let out = ''
      for (let i = 0; i < encoded.length; i++) {
        const c = encoded[i]
        if (c === '\\' && encoded[i + 1] === '\\') {
          out += '\\'
          i++
        } else if (c === "'" && encoded[i + 1] === "'") {
          out += "'"
          i++
        } else if (c === '\\' || c === "'") return null
        else out += c
      }
      return out
    }
    case 'sql-ident':
      return encoded.replace(/""/g, '"')
    case 'sql-backtick':
      return encoded.replace(/``/g, '`')
  }
}
