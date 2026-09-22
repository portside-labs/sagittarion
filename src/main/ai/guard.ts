// Soft gate for generated SQL. The hard gate is the database itself: generated
// queries run under SQLite's query_only pragma or a Postgres read-only transaction.
import type { DatabaseKind } from '@shared/types'
import { splitStatements } from '../db/sql-split'

const READ_STARTERS = new Set(['select', 'with', 'explain', 'values', 'table', 'show'])
const FORBIDDEN = /\b(insert|update|delete|merge|create|drop|alter|truncate|grant|revoke|vacuum|copy|reindex|attach|detach|replace|pragma|analyze|cluster|refresh|lock|call|do|listen|notify|into)\b/i

function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''")
}

export type GuardResult = { ok: true; sql: string } | { ok: false; reason: string }

/** Accepts exactly one read-only statement, returned without a trailing semicolon. */
export function checkReadOnlySql(sql: string): GuardResult {
  const statements = splitStatements(sql)
  if (statements.length === 0) return { ok: false, reason: 'The model returned no SQL.' }
  if (statements.length > 1) return { ok: false, reason: 'Only a single statement is allowed.' }
  const stmt = statements[0].replace(/;\s*$/, '').trim()
  const scan = stripLiteralsAndComments(stmt).trim()
  const first = scan.split(/\s+/)[0]?.toLowerCase() ?? ''
  if (!READ_STARTERS.has(first)) return { ok: false, reason: `Only SELECT queries may run; this starts with ${first.toUpperCase() || 'nothing'}.` }
  const bad = FORBIDDEN.exec(scan)
  if (bad) return { ok: false, reason: `The statement contains ${bad[1].toUpperCase()}, which is not allowed in a read-only query.` }
  return { ok: true, sql: stmt }
}

export function explainStatement(kind: DatabaseKind, sql: string): string {
  return kind === 'sqlite' ? `EXPLAIN QUERY PLAN ${sql}` : `EXPLAIN ${sql}`
}
