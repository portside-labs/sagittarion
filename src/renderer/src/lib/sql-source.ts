import type { TableRef } from '@shared/types'

/**
 * The single table a SELECT reads from, when its rows can be edited in place: one table, no joins,
 * grouping, set operations or computed columns. Anything else is null and the result stays read-only.
 */
export function editableSource(sql: string): TableRef | null {
  const text = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/;\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  const m = /^select\s+([\s\S]+?)\s+from\s+((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\.(?:"[^"]+"|[A-Za-z_][\w$]*))?)(?:\s+(?:as\s+)?(?!where\b|order\b|limit\b|offset\b|group\b|having\b|window\b|union\b|except\b|intersect\b|join\b|inner\b|left\b|right\b|full\b|cross\b|natural\b|on\b|using\b)[A-Za-z_][\w$]*)?(\s[\s\S]*)?$/i.exec(text)
  if (!m) return null
  const [, columns, table, rest = ''] = m
  if (/^\s*distinct\b/i.test(columns)) return null
  if (/[()]/.test(columns)) return null
  const lower = rest.toLowerCase()
  if (/\b(join|group by|having|union|intersect|except|window|values)\b/.test(lower)) return null
  if (/\(\s*select\b/.test(lower) || /,/.test(lower.replace(/'[^']*'/g, '').split(/\border by\b/)[0])) return null
  const parts = table.split('.').map((p) => (p.startsWith('"') ? p.slice(1, -1) : p))
  return parts.length === 2 ? { schema: parts[0], name: parts[1] } : { name: parts[0] }
}
