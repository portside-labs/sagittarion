import { isTagged, type CellValue, type TaggedBlob } from '@shared/types'
import { blobToHex, cellToPlainText, floatText, formatBytes } from '@shared/export'

export { formatBytes }

export type StorageClass = 'NULL' | 'INTEGER' | 'REAL' | 'TEXT' | 'BLOB' | 'BOOLEAN'
export type Affinity = 'INTEGER' | 'TEXT' | 'BLOB' | 'REAL' | 'NUMERIC' | 'BOOLEAN'

export function storageClass(v: CellValue): StorageClass {
  if (v === null) return 'NULL'
  if (typeof v === 'boolean') return 'BOOLEAN'
  if (typeof v === 'string') return 'TEXT'
  if (typeof v === 'number') return Number.isInteger(v) ? 'INTEGER' : 'REAL'
  if (isTagged(v)) {
    if (v.$type === 'int') return 'INTEGER'
    if (v.$type === 'float') return 'REAL'
    return 'BLOB'
  }
  return 'TEXT'
}

/** Short, single-line rendering for a grid cell. */
export function displayCell(v: CellValue): { text: string; cls: 'null' | 'num' | 'text' | 'blob' | 'bool' } {
  if (v === null) return { text: 'NULL', cls: 'null' }
  if (typeof v === 'boolean') return { text: v ? 'true' : 'false', cls: 'bool' }
  if (typeof v === 'number') return { text: String(v), cls: 'num' }
  if (typeof v === 'string') return { text: v.length > 512 ? v.slice(0, 512) + '…' : v, cls: 'text' }
  if (isTagged(v)) {
    if (v.$type === 'int') return { text: v.value, cls: 'num' }
    if (v.$type === 'float') return { text: floatText(v.value), cls: 'num' }
    return { text: `BLOB · ${formatBytes(v.size)}`, cls: 'blob' }
  }
  return { text: String(v), cls: 'text' }
}

/** Text used when a cell goes into an editor or the clipboard. Blobs become X'…' literals. */
export function cellText(v: CellValue): string {
  return cellToPlainText(v)
}

/** Full text for the inspector; NULL is spelled out. */
export function inspectorText(v: CellValue): string {
  if (v === null) return 'NULL'
  return cellToPlainText(v)
}

/** SQLite's type affinity rules (https://www.sqlite.org/datatype3.html#determination_of_column_affinity). */
export function affinityOf(declType?: string | null): Affinity {
  const t = (declType ?? '').toUpperCase()
  if (t === 'BOOLEAN' || t === 'BOOL') return 'BOOLEAN'
  if (t.includes('INT')) return 'INTEGER'
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'TEXT'
  if (t.includes('BLOB') || t === '') return 'BLOB'
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'REAL'
  return 'NUMERIC'
}

function hexToBase64(hex: string): string {
  let bin = ''
  for (let i = 0; i < hex.length; i += 2) bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16))
  return btoa(bin)
}

/**
 * Turn what the user typed into a value to bind. Numeric-looking input in
 * numeric or untyped columns becomes a number; TEXT columns always get text.
 * X'..' hex literals become blobs.
 */
export function parseCellInput(text: string, declType?: string | null): CellValue {
  const aff = affinityOf(declType)
  const t = text.trim()
  if (aff === 'BOOLEAN') {
    if (/^(true|t|yes|y|on|1)$/i.test(t)) return true
    if (/^(false|f|no|n|off|0)$/i.test(t)) return false
    return text
  }
  const hexMatch = /^[xX]'((?:[0-9a-fA-F]{2})*)'$/.exec(t)
  if (hexMatch && aff !== 'TEXT') {
    const hex = hexMatch[1]
    return { $type: 'blob', base64: hexToBase64(hex), size: hex.length / 2, truncated: false }
  }
  if (aff === 'TEXT') return text
  if (/^[-+]?\d+$/.test(t)) {
    const n = Number(t)
    if (Number.isSafeInteger(n)) return n
    return { $type: 'int', value: t.replace(/^\+/, '') }
  }
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(t)) {
    const n = Number(t)
    if (!Number.isFinite(n)) return text
    if (Number.isInteger(n)) {
      // Keep the REAL storage class: 2.0 must not silently become integer 2.
      const repr = Math.abs(n) >= 1e16 ? n.toExponential().replace('e+', 'e+') : n.toFixed(1)
      return { $type: 'float', value: repr }
    }
    return n
  }
  return text
}

export function valuesEqual(a: CellValue, b: CellValue): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a !== typeof b) return false
  if (typeof a === 'object' && typeof b === 'object') {
    if (a.$type !== b.$type) return false
    if (a.$type === 'blob' && b.$type === 'blob') return a.base64 === b.base64 && a.size === b.size
    return (a as any).value === (b as any).value
  }
  return false
}

export function hexDump(blob: TaggedBlob, maxBytes = 4096): string {
  const hex = blobToHex(blob.base64)
  const bytes = Math.min(hex.length / 2, maxBytes)
  const lines: string[] = []
  for (let off = 0; off < bytes; off += 16) {
    const chunk = hex.slice(off * 2, (off + 16) * 2)
    const pairs: string[] = []
    let ascii = ''
    for (let i = 0; i < chunk.length; i += 2) {
      const byte = parseInt(chunk.slice(i, i + 2), 16)
      pairs.push(chunk.slice(i, i + 2))
      ascii += byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.'
    }
    lines.push(`${off.toString(16).padStart(8, '0')}  ${pairs.join(' ').padEnd(47)}  ${ascii}`)
  }
  if (blob.size > bytes) lines.push(`… ${formatBytes(blob.size - bytes)} more${blob.truncated ? ' (not loaded)' : ''}`)
  return lines.join('\n')
}

export function valueLength(v: CellValue): string {
  if (v === null) return '—'
  if (typeof v === 'string') return `${v.length} chars`
  if (isTagged(v) && v.$type === 'blob') return `${v.size} bytes`
  return '—'
}
