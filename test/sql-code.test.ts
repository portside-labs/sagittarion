// Chat SQL is coloured like the editor: the same parser and highlight style, as spans.
import { describe, expect, it } from 'vitest'
import { highlightSql } from '../src/renderer/src/components/SqlCode'

describe('highlighted SQL', () => {
  it('splits a statement into the pieces the editor colours, losing nothing', () => {
    const sql = "SELECT id, name\nFROM users\nWHERE email = 'a@b.io' AND age > 42 -- adults"
    const pieces = highlightSql(sql, 'postgres')
    expect(pieces.map((p) => p.text).join('')).toBe(sql)
    const cls = (text: string) => pieces.find((p) => p.text === text)?.className
    // Keywords, strings, numbers and comments each get a class; the same kind gets the same one.
    expect(cls('SELECT')).toBeTruthy()
    expect(cls('SELECT')).toBe(cls('FROM'))
    expect(cls("'a@b.io'")).toBeTruthy()
    expect(cls("'a@b.io'")).not.toBe(cls('SELECT'))
    expect(cls('42')).toBeTruthy()
    expect(cls('-- adults')).toBeTruthy()
    // Table and column names have a colour of their own too, as in the editor.
    expect(cls('users')).toBeTruthy()
    expect(cls('users')).toBe(cls('email'))
    expect(cls('users')).not.toBe(cls('SELECT'))
  })

  it('follows the dialect', () => {
    // A dollar-quoted string is one string in PostgreSQL; SQLite has no such thing.
    const sql = 'SELECT $$it is$$'
    const pg = highlightSql(sql, 'postgres')
    expect(pg.some((p) => p.text === '$$it is$$' && p.className)).toBe(true)
    expect(highlightSql(sql, 'sqlite').some((p) => p.text === '$$it is$$')).toBe(false)
  })
})
