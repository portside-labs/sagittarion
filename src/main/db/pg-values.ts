import type { CellValue, TableRef, TaggedBlob } from '@shared/types'

const BLOB_INLINE_LIMIT = 1024 * 1024
const BLOB_PREVIEW_BYTES = 64 * 1024

export const OID = {
  bool: 16,
  bytea: 17,
  int8: 20,
  int2: 21,
  int4: 23,
  oid: 26,
  float4: 700,
  float8: 701,
  numeric: 1700
} as const

export function decodeInt8(text: string): CellValue {
  const n = Number(text)
  return Number.isSafeInteger(n) ? n : { $type: 'int', value: text }
}

export function decodeFloat(text: string): CellValue {
  if (text === 'NaN') return { $type: 'float', value: 'nan' }
  if (text === 'Infinity') return { $type: 'float', value: 'inf' }
  if (text === '-Infinity') return { $type: 'float', value: '-inf' }
  // Postgres prints 2.0 as "2"; keep it marked as a float so the UI shows REAL.
  if (/^[-+]?\d+$/.test(text)) return { $type: 'float', value: text }
  const n = Number(text)
  return Number.isFinite(n) ? n : text
}

export function decodeNumeric(text: string): CellValue {
  if (text === 'NaN') return { $type: 'float', value: 'nan' }
  if (/^[-+]?\d+$/.test(text)) {
    const n = Number(text)
    return Number.isSafeInteger(n) ? n : { $type: 'int', value: text }
  }
  // Exact decimals are kept as text so nothing is rounded.
  return { $type: 'float', value: text }
}

export function bufferToBlob(buf: Buffer): TaggedBlob {
  const n = buf.length
  if (n > BLOB_INLINE_LIMIT) {
    return { $type: 'blob', base64: buf.subarray(0, BLOB_PREVIEW_BYTES).toString('base64'), size: n, truncated: true }
  }
  return { $type: 'blob', base64: buf.toString('base64'), size: n, truncated: false }
}

export function decodeBytea(text: string): TaggedBlob {
  if (text.startsWith('\\x')) return bufferToBlob(Buffer.from(text.slice(2), 'hex'))
  // Legacy escape format: best effort.
  return bufferToBlob(Buffer.from(text, 'latin1'))
}

/**
 * Type parsers handed to node-postgres. Everything the UI does not need to
 * understand (dates, arrays, json, uuid, …) stays as the server's text form.
 */
export const pgTypes = {
  getTypeParser(oid: number, format?: string): (value: any) => CellValue {
    if (format === 'binary') return (v: any) => (Buffer.isBuffer(v) ? bufferToBlob(v) : v)
    switch (oid) {
      case OID.bool:
        return (v: any) => v === 't' || v === true
      case OID.int2:
      case OID.int4:
      case OID.oid:
        return (v: string) => parseInt(v, 10)
      case OID.int8:
        return decodeInt8
      case OID.float4:
      case OID.float8:
        return decodeFloat
      case OID.numeric:
        return decodeNumeric
      case OID.bytea:
        return decodeBytea
      default:
        return (v: any) => (v === null || v === undefined ? null : typeof v === 'string' ? v : String(v))
    }
  }
}

/** Turn a UI value into something node-postgres can bind. The server casts text to the column type. */
export function encodeParam(v: CellValue): unknown {
  if (v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return v
  if (v.$type === 'int') return v.value
  if (v.$type === 'float') {
    if (v.value === 'nan') return 'NaN'
    if (v.value === 'inf') return 'Infinity'
    if (v.value === '-inf') return '-Infinity'
    return v.value
  }
  if (v.truncated) throw new Error('Cannot write back a blob that was only partially loaded')
  return Buffer.from(v.base64, 'base64')
}

export function qi(name: string): string {
  return '"' + String(name).replace(/"/g, '""') + '"'
}

export function qualify(ref: TableRef): string {
  return ref.schema ? `${qi(ref.schema)}.${qi(ref.name)}` : qi(ref.name)
}
