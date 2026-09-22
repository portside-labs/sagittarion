/**
 * Split a PostgreSQL script into statements. Understands single-quoted and
 * E'' strings, double-quoted identifiers, dollar-quoted bodies ($$ … $$ and
 * $tag$ … $tag$), line comments and nested block comments.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  const n = sql.length
  let buf = ''
  let i = 0
  const flush = () => {
    if (!isBlankSql(buf)) out.push(buf.trim())
    buf = ''
  }
  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      const j = end < 0 ? n : end
      buf += sql.slice(i, j)
      i = j
      continue
    }
    if (ch === '/' && next === '*') {
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth++
          j += 2
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--
          j += 2
        } else j++
      }
      buf += sql.slice(i, j)
      i = j
      continue
    }
    if (ch === "'") {
      const escapeString = i > 0 && /[eE]/.test(sql[i - 1]) && (i < 2 || !/[A-Za-z0-9_]/.test(sql[i - 2]))
      let j = i + 1
      while (j < n) {
        if (escapeString && sql[j] === '\\') {
          j += 2
        } else if (sql[j] === "'") {
          if (sql[j + 1] === "'") j += 2
          else {
            j++
            break
          }
        } else j++
      }
      buf += sql.slice(i, j)
      i = j
      continue
    }
    if (ch === '"') {
      let j = i + 1
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') j += 2
          else {
            j++
            break
          }
        } else j++
      }
      buf += sql.slice(i, j)
      i = j
      continue
    }
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64))
      if (m) {
        const tag = m[0]
        const end = sql.indexOf(tag, i + tag.length)
        const j = end < 0 ? n : end + tag.length
        buf += sql.slice(i, j)
        i = j
        continue
      }
    }
    if (ch === ';') {
      buf += ch
      i++
      flush()
      continue
    }
    buf += ch
    i++
  }
  flush()
  return out
}

export function isBlankSql(s: string): boolean {
  return !s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()
}

/** Heuristic: does this statement produce a result set? Used to pick a cursor. */
export function isRowReturning(stmt: string): boolean {
  const s = stmt
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim()
    .toLowerCase()
  return /^(select|with|table|values|show|explain|fetch)\b/.test(s) || /\breturning\b/.test(s)
}
