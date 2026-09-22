import { isTagged, type CellValue } from './types'

export function blobToHex(base64: string): string {
  const bin = typeof atob === 'function' ? atob(base64) : Buffer.from(base64, 'base64').toString('binary')
  let out = ''
  for (let i = 0; i < bin.length; i++) out += bin.charCodeAt(i).toString(16).padStart(2, '0')
  return out
}

export function floatText(value: string): string {
  if (value === 'nan') return 'NaN'
  if (value === 'inf') return 'Infinity'
  if (value === '-inf') return '-Infinity'
  return value
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '?'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** Plain-text rendering used for CSV export and clipboard copy. NULL becomes an empty string. */
export function cellToPlainText(v: CellValue): string {
  if (v === null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return String(v)
  if (isTagged(v)) {
    if (v.$type === 'int') return v.value
    if (v.$type === 'float') return floatText(v.value)
    if (v.$type === 'blob') return 'X\'' + blobToHex(v.base64) + '\'' + (v.truncated ? '…' : '')
  }
  return String(v)
}

export function sqlLiteral(v: CellValue): string {
  if (v === null) return 'NULL'
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'string') return '\'' + v.replace(/'/g, '\'\'') + '\''
  if (isTagged(v)) {
    if (v.$type === 'int') return v.value
    if (v.$type === 'float') return v.value === 'nan' ? 'NULL' : v.value === 'inf' ? '9e999' : v.value === '-inf' ? '-9e999' : v.value
    if (v.$type === 'blob') return 'X\'' + blobToHex(v.base64) + '\''
  }
  return 'NULL'
}

export function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"'
}

function csvField(s: string): string {
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

export function toCsv(columns: string[], rows: CellValue[][]): string {
  const lines = [columns.map(csvField).join(',')]
  for (const r of rows) lines.push(r.map((c) => csvField(cellToPlainText(c))).join(','))
  return lines.join('\r\n') + '\r\n'
}

export function toJson(columns: string[], rows: CellValue[][]): string {
  const objs = rows.map((r) => {
    const o: Record<string, unknown> = {}
    columns.forEach((c, i) => {
      const v = r[i]
      if (isTagged(v)) {
        if (v.$type === 'int') o[c] = v.value
        else if (v.$type === 'float') o[c] = /^(nan|-?inf)$/.test(v.value) ? null : Number(v.value)
        else o[c] = { blob_base64: v.base64, size: v.size, truncated: v.truncated }
      } else o[c] = v
    })
    return o
  })
  return JSON.stringify(objs, null, 2) + '\n'
}

export function toSqlInserts(table: string, columns: string[], rows: CellValue[][]): string {
  const cols = columns.map(quoteIdent).join(', ')
  const t = quoteIdent(table)
  return rows.map((r) => `INSERT INTO ${t} (${cols}) VALUES (${r.map(sqlLiteral).join(', ')});`).join('\n') + '\n'
}
