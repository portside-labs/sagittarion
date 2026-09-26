import { describe, expect, it } from 'vitest'
import type { CellValue } from '../src/shared/types'
import { sqlLiteral } from '../src/shared/export'
import {
  activeCell,
  cellCount,
  clampSelection,
  clickCell,
  clickColumn,
  clickRow,
  contains,
  extendTo,
  isSingleCell,
  rowSpans,
  parseSpans,
  selectAll,
  selectedColumns,
  selectedRows,
  selectionSqlList,
  selectionText,
  single,
  tsvField,
  wholeColumns,
  wholeRows,
  type GridSelection
} from '../src/renderer/src/lib/grid-selection'

const at = (row: number, col: number) => ({ row, col })
const none = { shift: false, add: false }
const grid = [
  ['1', 'Ada', 'ada@example.com'],
  ['2', 'Grace', ''],
  ['3', 'Linus', 'tab\there'],
  ['4', 'Quote "q"', 'two\nlines']
]
const text = (r: number, c: number) => grid[r][c]

describe('grid selection', () => {
  it('selects a cell, stretches with Shift and keeps the active cell where it started', () => {
    let sel: GridSelection = clickCell([], at(1, 1), none)
    expect(isSingleCell(sel)).toBe(true)
    sel = clickCell(sel, at(3, 2), { shift: true, add: false })
    expect(sel).toEqual([{ anchor: at(1, 1), focus: at(3, 2) }])
    expect(activeCell(sel)).toEqual(at(1, 1))
    expect(contains(sel, 2, 2)).toBe(true)
    expect(contains(sel, 0, 1)).toBe(false)
    // Dragged or Shift+arrowed back past the start, the rectangle flips round its anchor.
    sel = extendTo(sel, at(0, 0))
    expect(selectedRows(sel)).toEqual([0, 1])
    expect(selectedColumns(sel)).toEqual([0, 1])
    // Extending to where it already reaches changes nothing.
    expect(extendTo(sel, at(0, 0))).toBe(sel)
  })

  it('adds cells with the modifier and takes a lone one back out', () => {
    let sel = clickCell([], at(0, 0), none)
    sel = clickCell(sel, at(2, 2), { shift: false, add: true })
    expect(sel).toHaveLength(2)
    expect(activeCell(sel)).toEqual(at(2, 2))
    sel = clickCell(sel, at(2, 2), { shift: false, add: true })
    expect(sel).toEqual([single(at(0, 0))])
    // A plain click starts over.
    expect(clickCell(sel, at(3, 1), none)).toEqual([single(at(3, 1))])
  })

  it('selects whole rows from the row numbers, and rows or columns from the keyboard', () => {
    let sel = clickRow([], 1, 3, none)
    expect(sel).toEqual([{ anchor: at(1, 0), focus: at(1, 2) }])
    sel = clickRow(sel, 3, 3, { shift: true, add: false })
    expect(selectedRows(sel)).toEqual([1, 2, 3])
    expect(cellCount(sel)).toBe(9)
    sel = clickRow(sel, 0, 3, { shift: false, add: true })
    expect(selectedRows(sel)).toEqual([0, 1, 2, 3])
    expect(wholeRows([single(at(2, 1))], 3)).toEqual([{ anchor: at(2, 0), focus: at(2, 2) }])
    expect(wholeColumns([{ anchor: at(1, 1), focus: at(2, 2) }], 4)).toEqual([{ anchor: at(0, 1), focus: at(3, 2) }])
    let cols = clickColumn([], 1, 4, none)
    expect(cols).toEqual([{ anchor: at(0, 1), focus: at(3, 1) }])
    cols = clickColumn(cols, 2, 4, { shift: true, add: false })
    expect(selectedColumns(cols)).toEqual([1, 2])
    expect(selectedColumns(clickColumn(cols, 0, 4, { shift: false, add: true }))).toEqual([0, 1, 2])
    expect(selectAll(4, 3)).toEqual([{ anchor: at(0, 0), focus: at(3, 2) }])
    expect(selectAll(0, 3)).toEqual([])
  })

  it('describes each row by the columns it has selected, merging overlaps', () => {
    const sel: GridSelection = [
      { anchor: at(0, 0), focus: at(2, 1) },
      { anchor: at(1, 1), focus: at(1, 2) },
      single(at(1, 4))
    ]
    expect(rowSpans(sel, 0)).toBe('0-1')
    expect(rowSpans(sel, 1)).toBe('0-2,4-4')
    expect(rowSpans(sel, 3)).toBe('')
    expect(parseSpans('0-2,4-4')).toEqual([
      [0, 2],
      [4, 4]
    ])
    expect(parseSpans('')).toEqual([])
    expect(cellCount(sel)).toBe(2 + 4 + 2)
  })

  it('cuts a selection down to a smaller grid', () => {
    const sel: GridSelection = [{ anchor: at(1, 0), focus: at(5, 2) }, single(at(9, 0))]
    expect(clampSelection(sel, 3)).toEqual([{ anchor: at(1, 0), focus: at(2, 2) }])
    expect(clampSelection(sel, 3, 2)).toEqual([{ anchor: at(1, 0), focus: at(2, 1) }])
    expect(clampSelection(sel, 0)).toEqual([])
    // Unchanged when it fits.
    expect(clampSelection(sel, 20)).toBe(sel)
  })

  it('copies one cell as it is and more as tab-separated lines that spreadsheets paste', () => {
    expect(selectionText([single(at(0, 1))], text)).toBe('Ada')
    expect(selectionText([single(at(2, 2))], text)).toBe('tab\there')
    expect(selectionText([{ anchor: at(0, 0), focus: at(1, 2) }], text)).toBe('1\tAda\tada@example.com\n2\tGrace\t')
    expect(selectionText([{ anchor: at(0, 1), focus: at(1, 1) }], text, ['id', 'name', 'email'])).toBe('name\nAda\nGrace')
    // Tabs, line breaks and quotes are quoted the way spreadsheets expect.
    expect(selectionText([{ anchor: at(2, 1), focus: at(3, 2) }], text)).toBe('Linus\t"tab\there"\n"Quote ""q"""\t"two\nlines"')
    // Rectangles apart share a layout; the cells between them stay empty.
    expect(selectionText([single(at(0, 0)), single(at(2, 2))], text)).toBe('1\t\n\t"tab\there"')
    expect(selectionText([], text)).toBe('')
    expect(tsvField('plain')).toBe('plain')
  })

  it('copies values as a SQL list to paste inside IN ( … )', () => {
    // As SQL: text in quotes with any quote doubled, numbers as they are, NULL for nothing.
    const values: CellValue[][] = [
      [1, 'Ada', "O'Brien"],
      [2, null, 'ada@example.com'],
      [{ $type: 'int', value: '9007199254740993' }, 'two\nlines', '']
    ]
    const literal = (r: number, c: number) => sqlLiteral(values[r][c])
    expect(selectionSqlList([{ anchor: at(0, 2), focus: at(2, 2) }], literal)).toBe("'O''Brien',\n'ada@example.com',\n''")
    expect(selectionSqlList([{ anchor: at(0, 0), focus: at(2, 0) }], literal)).toBe('1,\n2,\n9007199254740993')
    expect(selectionSqlList([single(at(1, 1))], literal)).toBe('NULL')
    // Several columns or rectangles apart: row by row, left to right, as the grid shows them.
    expect(selectionSqlList([{ anchor: at(0, 0), focus: at(1, 1) }], literal)).toBe("1,\n'Ada',\n2,\nNULL")
    expect(selectionSqlList([single(at(2, 1)), single(at(0, 1))], literal)).toBe("'Ada',\n'two\nlines'")
    expect(selectionSqlList([], literal)).toBe('')
  })
})
