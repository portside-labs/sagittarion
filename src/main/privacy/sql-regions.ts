// Where each part of a SQL statement sits: code, a string, an identifier, a comment. Restoring a value into SQL
// depends on it, so a value can never change the statement around it.
export type SqlDialect = 'sqlite' | 'postgres'

export type SqlRegionKind = 'code' | 'string' | 'estring' | 'ident' | 'bracket' | 'backtick' | 'dollar' | 'line-comment' | 'block-comment'

export interface SqlRegion {
  kind: SqlRegionKind
  start: number
  end: number
  /** The delimiter of a dollar-quoted body, e.g. $fn$. */
  tag?: string
}

/** Postgres strings with backslash escapes: E'…' and U&'…'. */
function escapePrefix(sql: string, quote: number): boolean {
  const before = (i: number) => (i >= 0 ? sql[i] : '')
  if (/[eE]/.test(before(quote - 1)) && !/[\w$]/.test(before(quote - 2))) return true
  return before(quote - 1) === '&' && /[uU]/.test(before(quote - 2)) && !/[\w$]/.test(before(quote - 3))
}

/** Splits SQL into contiguous regions covering the whole text. Unterminated regions run to the end. */
export function sqlRegions(sql: string, dialect: SqlDialect): SqlRegion[] {
  const out: SqlRegion[] = []
  const n = sql.length
  let i = 0
  let codeStart = 0
  const region = (kind: SqlRegionKind, end: number, tag?: string) => {
    if (i > codeStart) out.push({ kind: 'code', start: codeStart, end: i })
    out.push({ kind, start: i, end, ...(tag ? { tag } : {}) })
    i = end
    codeStart = end
  }
  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i)
      region('line-comment', nl < 0 ? n : nl)
    } else if (ch === '/' && next === '*') {
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (dialect === 'postgres' && sql[j] === '/' && sql[j + 1] === '*') {
          depth++
          j += 2
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--
          j += 2
        } else j++
      }
      region('block-comment', j)
    } else if (ch === "'") {
      const escapes = dialect === 'postgres' && escapePrefix(sql, i)
      let j = i + 1
      while (j < n) {
        if (escapes && sql[j] === '\\') j += 2
        else if (sql[j] === "'") {
          if (sql[j + 1] === "'") j += 2
          else {
            j++
            break
          }
        } else j++
      }
      region(escapes ? 'estring' : 'string', Math.min(j, n))
    } else if (ch === '"' || (dialect === 'sqlite' && ch === '`')) {
      let j = i + 1
      while (j < n) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) j += 2
          else {
            j++
            break
          }
        } else j++
      }
      region(ch === '"' ? 'ident' : 'backtick', Math.min(j, n))
    } else if (dialect === 'sqlite' && ch === '[') {
      const close = sql.indexOf(']', i + 1)
      region('bracket', close < 0 ? n : close + 1)
    } else if (dialect === 'postgres' && ch === '$' && !(i > 0 && /[\w$]/.test(sql[i - 1]))) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64))
      if (m) {
        const close = sql.indexOf(m[0], i + m[0].length)
        region('dollar', close < 0 ? n : close + m[0].length, m[0])
      } else i++
    } else i++
  }
  if (n > codeStart) out.push({ kind: 'code', start: codeStart, end: n })
  return out
}

export function regionAt(regions: SqlRegion[], pos: number): SqlRegion | undefined {
  let lo = 0
  let hi = regions.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const r = regions[mid]
    if (pos < r.start) hi = mid - 1
    else if (pos >= r.end) lo = mid + 1
    else return r
  }
  return undefined
}
