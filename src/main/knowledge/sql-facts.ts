// What a statement says about the database it runs on, read without a full SQL parser: the tables it reads and writes,
// how it joins them, the text values it compares columns with, its named parameters, and its shape (the statement
// with its values taken out, so the same query with other values has the same shape). Good enough to learn from; it
// never decides what runs.

export interface TableUse {
  schema?: string
  name: string
  alias?: string
}

/** A column as written: with the table or alias in front of it, or bare. */
export interface ColumnUse {
  qualifier?: string
  column: string
}

export interface SqlFacts {
  reads: TableUse[]
  writes: TableUse[]
  /** Columns of two tables compared with = : a join, in ON or WHERE. */
  joins: { left: ColumnUse; right: ColumnUse }[]
  /** Text values columns were compared with: = 'x', IN ('x', 'y'), LIKE '%x%'. */
  values: { column: ColumnUse; value: string }[]
  /** :name parameters, in order of first use. */
  params: string[]
  shape: string
}

type Kind = 'word' | 'qident' | 'string' | 'number' | 'param' | 'op'
interface Tok {
  k: Kind
  v: string
  /** A word, lowercased. */
  w?: string
}

const KEYWORDS = new Set(
  'select from where group order by having limit offset join inner left right full outer cross natural on using as and or not in is null like ilike between exists case when then else end union all intersect except distinct with recursive values set update insert delete into returning lateral only window partition over fetch first next rows row for share nowait skip locked asc desc nulls last collate filter within tablesample materialized do nothing conflict merge matched true false interval current_date current_timestamp now any some escape similar glob regexp match'.split(
    ' '
  )
)
/** Words a FROM follows inside a call rather than a query: EXTRACT(YEAR FROM x), IS DISTINCT FROM. */
const NOT_A_SOURCE = new Set(['extract', 'substring', 'trim', 'overlay', 'position', 'distinct'])
const COMPARE = new Set(['=', '<>', '!=', 'like', 'ilike'])

function lex(sql: string): Tok[] {
  const out: Tok[] = []
  const n = sql.length
  let i = 0
  const word = /[A-Za-z_\u0080-￿]/
  const wordChar = /[A-Za-z0-9_$\u0080-￿]/
  while (i < n) {
    const c = sql[i]
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f') {
      i++
      continue
    }
    if (c === '-' && sql[i + 1] === '-') {
      const e = sql.indexOf('\n', i)
      i = e < 0 ? n : e + 1
      continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      const e = sql.indexOf('*/', i + 2)
      i = e < 0 ? n : e + 2
      continue
    }
    if (c === "'") {
      let v = ''
      let j = i + 1
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            v += "'"
            j += 2
            continue
          }
          break
        }
        v += sql[j++]
      }
      out.push({ k: 'string', v })
      i = j + 1
      continue
    }
    if (c === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64))
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length)
        out.push({ k: 'string', v: sql.slice(i + tag[0].length, end < 0 ? n : end) })
        i = end < 0 ? n : end + tag[0].length
        continue
      }
      const num = /^\$\d+/.exec(sql.slice(i, i + 12))
      if (num) {
        out.push({ k: 'param', v: num[0] })
        i += num[0].length
        continue
      }
    }
    if (c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c
      let v = ''
      let j = i + 1
      while (j < n) {
        if (sql[j] === close) {
          if (close !== ']' && sql[j + 1] === close) {
            v += close
            j += 2
            continue
          }
          break
        }
        v += sql[j++]
      }
      out.push({ k: 'qident', v, w: v.toLowerCase() })
      i = j + 1
      continue
    }
    if (c === ':' && sql[i + 1] === ':') {
      out.push({ k: 'op', v: '::' })
      i += 2
      continue
    }
    if ((c === ':' || c === '@') && word.test(sql[i + 1] ?? '') && !(c === ':' && sql[i - 1] === ':')) {
      let j = i + 1
      while (j < n && wordChar.test(sql[j])) j++
      out.push({ k: 'param', v: sql.slice(i, j) })
      i = j
      continue
    }
    if (c === '?') {
      out.push({ k: 'param', v: '?' })
      i++
      continue
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(sql.slice(i))
      const len = m ? m[0].length : 1
      out.push({ k: 'number', v: sql.slice(i, i + len) })
      i += len
      continue
    }
    if (word.test(c)) {
      let j = i + 1
      while (j < n && wordChar.test(sql[j])) j++
      const v = sql.slice(i, j)
      // E'...', N'...' and the like: a prefixed string.
      if (sql[j] === "'" && /^(e|n|x|b|u&)$/i.test(v)) {
        i = j
        continue
      }
      out.push({ k: 'word', v, w: v.toLowerCase() })
      i = j
      continue
    }
    const two = sql.slice(i, i + 2)
    if (['<>', '!=', '<=', '>=', '||', '->', '=>'].includes(two)) {
      if (two === '->' && sql[i + 2] === '>') {
        out.push({ k: 'op', v: '->>' })
        i += 3
        continue
      }
      out.push({ k: 'op', v: two })
      i += 2
      continue
    }
    out.push({ k: 'op', v: c })
    i++
  }
  return out
}

const isName = (t: Tok | undefined): t is Tok => Boolean(t && (t.k === 'qident' || (t.k === 'word' && !KEYWORDS.has(t.w!))))

/** A name of up to three dotted parts at `at`: [catalog.]schema.table, schema.table or table. */
function dotted(toks: Tok[], at: number): { parts: string[]; end: number } | null {
  if (!isName(toks[at])) return null
  const parts = [toks[at].v]
  let j = at + 1
  while (parts.length < 3 && toks[j]?.v === '.' && toks[j + 1] && (toks[j + 1].k === 'word' || toks[j + 1].k === 'qident')) {
    parts.push(toks[j + 1].v)
    j += 2
  }
  return { parts, end: j }
}

/**
 * A table named at `at`, with its alias; null for a subquery, a function call or a keyword. `target`: the table of an
 * INSERT, which a column list in parentheses can follow.
 */
function tableRef(toks: Tok[], at: number, target = false): { ref: TableUse; end: number } | null {
  let k = at
  while (toks[k]?.k === 'word' && (toks[k].w === 'lateral' || toks[k].w === 'only')) k++
  const name = dotted(toks, k)
  if (!name) return null
  // A function in FROM, such as generate_series(...) or json_each(...).
  if (toks[name.end]?.v === '(' && !target) return null
  const ref: TableUse = { name: name.parts[name.parts.length - 1] }
  if (name.parts.length > 1) ref.schema = name.parts[name.parts.length - 2]
  let j = name.end
  if (toks[j]?.w === 'as' && isName(toks[j + 1])) {
    ref.alias = toks[j + 1].v
    j += 2
  } else if (isName(toks[j])) {
    ref.alias = toks[j].v
    j++
  }
  return { ref, end: j }
}

/** The column in front of a comparison that ends at `at` (exclusive): [qualifier.]column, through LOWER(...) or ::casts. */
function columnBefore(toks: Tok[], at: number): ColumnUse | null {
  let j = at - 1
  // x::text = 'a'
  while (toks[j - 1]?.v === '::' && toks[j]?.k === 'word') j -= 2
  // lower(x) = 'a', lower(t.x) = 'a'
  if (toks[j]?.v === ')') {
    const open = toks[j - 2]?.v === '(' ? j - 2 : toks[j - 4]?.v === '(' && toks[j - 2]?.v === '.' ? j - 4 : -1
    if (open < 0 || !/^(lower|upper|trim|btrim)$/.test(toks[open - 1]?.w ?? '')) return null
    j -= 1
  }
  const col = toks[j]
  if (!isName(col)) return null
  if (toks[j + 1]?.v === '(') return null
  if (toks[j - 1]?.v === '.' && toks[j - 2] && (toks[j - 2].k === 'word' || toks[j - 2].k === 'qident')) return { qualifier: toks[j - 2].v, column: col.v }
  return { column: col.v }
}

function likeValue(raw: string): string {
  return raw.replace(/^[%_]+|[%_]+$/g, '')
}

function addValue(out: SqlFacts['values'], column: ColumnUse | null, raw: string, like: boolean): void {
  if (!column) return
  const value = (like ? likeValue(raw) : raw).trim()
  if (value.length < 2 || value.length > 120) return
  // A pattern with wildcards inside is not a value anyone names.
  if (like && /[%_]/.test(value)) return
  out.push({ column, value })
}

export function analyzeSql(sql: string): SqlFacts {
  const toks = lex(sql)
  const facts: SqlFacts = { reads: [], writes: [], joins: [], values: [], params: [], shape: '' }
  const ctes = new Set<string>()
  // WITH a AS (...), b (x, y) AS (...): their names are not tables.
  for (let j = 0; j < toks.length; j++) {
    const t = toks[j]
    if (!isName(t)) continue
    const before = toks[j - 1]
    if (!(before && (before.w === 'with' || before.w === 'recursive' || before.v === ','))) continue
    let k = j + 1
    if (toks[k]?.v === '(') {
      let depth = 0
      for (; k < toks.length; k++) {
        if (toks[k].v === '(') depth++
        else if (toks[k].v === ')' && --depth === 0) break
      }
      k++
    }
    if (toks[k]?.w !== 'as') continue
    k++
    while (toks[k]?.w === 'not' || toks[k]?.w === 'materialized') k++
    if (toks[k]?.v === '(') ctes.add(t.w!)
  }
  const isCte = (r: TableUse) => !r.schema && ctes.has(r.name.toLowerCase())
  // The word in front of each open parenthesis, to tell EXTRACT(YEAR FROM x) from a subquery's FROM.
  const opener: (string | undefined)[] = []
  const consumed = new Set<number>()
  for (let j = 0; j < toks.length; j++) {
    const t = toks[j]
    if (t.v === '(') opener.push(toks[j - 1]?.w)
    else if (t.v === ')') opener.pop()
    if (t.k !== 'word') continue
    const w = t.w!
    if (w === 'from' && !consumed.has(j)) {
      if (NOT_A_SOURCE.has(toks[j - 1]?.w ?? '') || NOT_A_SOURCE.has(opener[opener.length - 1] ?? '')) continue
      let k = j + 1
      for (;;) {
        const r = tableRef(toks, k)
        if (!r) break
        if (!isCte(r.ref)) facts.reads.push(r.ref)
        k = r.end
        if (toks[k]?.v !== ',') break
        k++
      }
    } else if (w === 'join') {
      const r = tableRef(toks, j + 1)
      if (r && !isCte(r.ref)) facts.reads.push(r.ref)
    } else if (w === 'into') {
      const prev = toks[j - 1]?.w
      if (prev === 'insert' || prev === 'replace' || prev === 'ignore' || prev === 'abort' || prev === 'fail' || prev === 'rollback' || prev === 'merge') {
        const r = tableRef(toks, j + 1, true)
        if (r) facts.writes.push({ schema: r.ref.schema, name: r.ref.name })
      }
    } else if (w === 'update') {
      const prev = toks[j - 1]?.w
      if (prev === 'on' || prev === 'for' || prev === 'do' || prev === 'key' || prev === 'or' || prev === 'after' || prev === 'before') continue
      const r = tableRef(toks, j + 1)
      if (r && toks[r.end]?.w === 'set') facts.writes.push({ schema: r.ref.schema, name: r.ref.name })
    } else if (w === 'delete' && toks[j + 1]?.w === 'from') {
      consumed.add(j + 1)
      const r = tableRef(toks, j + 2)
      if (r) facts.writes.push({ schema: r.ref.schema, name: r.ref.name })
    }
  }
  for (let j = 0; j < toks.length; j++) {
    const t = toks[j]
    // a.x = b.y
    if (t.v === '=' && toks[j - 2]?.v === '.' && toks[j + 2]?.v === '.') {
      const left = columnBefore(toks, j)
      // b.y, or s.b.y with its schema in front.
      const at = toks[j + 4]?.v === '.' && toks[j + 5] ? j + 3 : j + 1
      const col = toks[at + 2]
      const right = col && (col.k === 'word' || col.k === 'qident') && toks[at + 3]?.v !== '(' ? { qualifier: toks[at].v, column: col.v } : null
      if (left?.qualifier && right && left.qualifier.toLowerCase() !== right.qualifier.toLowerCase()) facts.joins.push({ left, right })
    }
    if (t.k === 'string') {
      const before = toks[j - 1]
      const op = before?.k === 'word' ? before.w! : before?.v
      if (op && COMPARE.has(op)) {
        addValue(facts.values, columnBefore(toks, j - 1), t.v, op === 'like' || op === 'ilike')
      } else if (toks[j + 1]?.v === '=' && isName(toks[j + 2])) {
        // 'a' = x
        const col = toks[j + 3]?.v === '.' && toks[j + 4] ? { qualifier: toks[j + 2].v, column: toks[j + 4].v } : { column: toks[j + 2].v }
        if (toks[j + 3]?.v !== '(') addValue(facts.values, col, t.v, false)
      } else if (before && (before.v === '(' || before.v === ',')) {
        // x IN ('a', 'b')
        let k = j - 1
        while (k > 0 && (toks[k].v === ',' || toks[k].k === 'string')) k--
        if (toks[k]?.v === '(' && toks[k - 1]?.w === 'in') {
          const at = toks[k - 2]?.w === 'not' ? k - 2 : k - 1
          addValue(facts.values, columnBefore(toks, at), t.v, false)
        }
      }
    }
    if (t.k === 'param' && t.v.startsWith(':') && !facts.params.includes(t.v.slice(1))) facts.params.push(t.v.slice(1))
  }
  facts.shape = toks
    .map((t) => (t.k === 'string' || t.k === 'number' || t.k === 'param' ? '?' : t.k === 'word' ? t.w! : t.k === 'qident' ? `"${t.w}"` : t.v))
    .join(' ')
    .replace(/\( \?(?: , \?)+ \)/g, '( ? )')
    .replace(/ ;$/, '')
  return facts
}

/** The tables a definition reads and writes: a view's query, a trigger's or a function's body, dollar-quoted or not. */
export function definitionFacts(sql: string): { reads: TableUse[]; writes: TableUse[]; calls: string[] } {
  const bodies = [...sql.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)?\$([\s\S]*?)\$\1\$/g)].map((m) => m[2])
  const outer = analyzeSql(sql)
  const reads = [...outer.reads]
  const writes = [...outer.writes]
  for (const body of bodies) {
    const inner = analyzeSql(body)
    reads.push(...inner.reads)
    writes.push(...inner.writes)
  }
  // EXECUTE FUNCTION schema.fn(): the function a PostgreSQL trigger runs.
  const calls = [...sql.matchAll(/\bexecute\s+(?:function|procedure)\s+((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)\s*\(/gi)].map((m) => m[1].replace(/"/g, ''))
  return { reads, writes, calls }
}

/** A value as an SQL literal: a number as it is, text quoted, nothing as NULL. */
export function sqlLiteral(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return 'NULL'
  const text = String(value)
  if (/^-?\d{1,15}(\.\d{1,15})?$/.test(text)) return text
  return `'${text.replace(/'/g, "''")}'`
}

/**
 * A runbook query with values in place of its :parameters, as literals. Strings, comments, quoted names and casts
 * (::date) are left as they are. A parameter with no value is left in, for the database to refuse.
 */
export function bindParams(sql: string, values: Record<string, string | number | null>): string {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    const rest = sql.slice(i)
    const skip =
      (c === "'" && /^'(?:[^']|'')*'?/.exec(rest)) ||
      (c === '"' && /^"(?:[^"]|"")*"?/.exec(rest)) ||
      (c === '-' && sql[i + 1] === '-' && /^--[^\n]*/.exec(rest)) ||
      (c === '/' && sql[i + 1] === '*' && /^\/\*[\s\S]*?(?:\*\/|$)/.exec(rest)) ||
      (c === '$' && /^\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/.exec(rest)) ||
      (c === ':' && sql[i + 1] === ':' && /^::/.exec(rest))
    if (skip) {
      out += skip[0]
      i += skip[0].length
      continue
    }
    const param = c === ':' && sql[i - 1] !== ':' ? /^:([A-Za-z_][A-Za-z0-9_]*)/.exec(rest) : null
    if (param && Object.prototype.hasOwnProperty.call(values, param[1])) {
      out += sqlLiteral(values[param[1]])
      i += param[0].length
      continue
    }
    out += c
    i++
  }
  return out
}

/** One line, spaces collapsed and no trailing semicolon: how two runs of the same SQL are compared. */
export function sameSqlKey(sql: string): string {
  return sql.replace(/\s+/g, ' ').replace(/\s*;\s*$/, '').trim().toLowerCase()
}
