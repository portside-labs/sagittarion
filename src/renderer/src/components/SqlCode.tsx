// SQL that is shown rather than edited, such as the queries in the chat: coloured by the editor's own parser and
// highlight style, as plain spans instead of an editor for every message.
import { useLayoutEffect, useMemo } from 'react'
import { PostgreSQL, SQLite } from '@codemirror/lang-sql'
import { highlightCode } from '@lezer/highlight'
import { StyleModule } from 'style-mod'
import { sqlHighlightStyle } from '@/lib/sql-highlight'

export interface SqlPiece {
  text: string
  /** The highlight style's classes for this piece; empty for plain text. */
  className: string
}

/** The SQL in pieces, each with the classes the editor would give it. */
export function highlightSql(sql: string, dialect: 'sqlite' | 'postgres'): SqlPiece[] {
  const parser = (dialect === 'postgres' ? PostgreSQL : SQLite).language.parser
  const pieces: SqlPiece[] = []
  highlightCode(
    sql,
    parser.parse(sql),
    sqlHighlightStyle,
    (text, className) => pieces.push({ text, className }),
    () => pieces.push({ text: '\n', className: '' })
  )
  return pieces
}

/** An editor mounts the highlight style's rules; with no editor on screen yet, they are mounted here. */
let mounted = false
function mountHighlightStyle(): void {
  if (mounted || !sqlHighlightStyle.module) return
  StyleModule.mount(document, sqlHighlightStyle.module)
  mounted = true
}

export function SqlCode({ sql, dialect, className, title }: { sql: string; dialect: 'sqlite' | 'postgres'; className?: string; title?: string }) {
  useLayoutEffect(mountHighlightStyle, [])
  const pieces = useMemo(() => highlightSql(sql, dialect), [sql, dialect])
  return (
    <pre className={className} title={title}>
      {pieces.map((p, i) =>
        p.className ? (
          <span key={i} className={p.className}>
            {p.text}
          </span>
        ) : (
          p.text
        )
      )}
    </pre>
  )
}
