// Cell selection in the data grid, as spreadsheets have it: one or more rectangles of cells. The last rectangle is
// the one that grows with Shift, and where it started is the active cell, the one editing and the inspector act on.

export interface CellPos {
  row: number
  col: number
}

/** A rectangle of cells between two corners: `anchor` where it started, `focus` the corner that moves as it grows. */
export interface CellRange {
  anchor: CellPos
  focus: CellPos
}

/** The rectangles selected, in the order they were made; empty when nothing is. */
export type GridSelection = CellRange[]

export interface Bounds {
  top: number
  bottom: number
  left: number
  right: number
}

export function single(pos: CellPos): CellRange {
  return { anchor: pos, focus: pos }
}

export function samePos(a: CellPos | null | undefined, b: CellPos | null | undefined): boolean {
  return !!a && !!b && a.row === b.row && a.col === b.col
}

export function boundsOf(r: CellRange): Bounds {
  return {
    top: Math.min(r.anchor.row, r.focus.row),
    bottom: Math.max(r.anchor.row, r.focus.row),
    left: Math.min(r.anchor.col, r.focus.col),
    right: Math.max(r.anchor.col, r.focus.col)
  }
}

/** The cell editing and the inspector act on: where the last rectangle started. */
export function activeCell(sel: GridSelection): CellPos | null {
  return sel.length ? sel[sel.length - 1].anchor : null
}

export function isSingleCell(sel: GridSelection): boolean {
  return sel.length === 1 && samePos(sel[0].anchor, sel[0].focus)
}

export function contains(sel: GridSelection, row: number, col: number): boolean {
  return sel.some((r) => {
    const b = boundsOf(r)
    return row >= b.top && row <= b.bottom && col >= b.left && col <= b.right
  })
}

export function clampPos(pos: CellPos, rowCount: number, colCount: number): CellPos {
  return { row: Math.max(0, Math.min(rowCount - 1, pos.row)), col: Math.max(0, Math.min(colCount - 1, pos.col)) }
}

/** The selection cut down to a grid of this size; rectangles wholly outside it go. */
export function clampSelection(sel: GridSelection, rowCount: number, colCount = Number.MAX_SAFE_INTEGER): GridSelection {
  if (rowCount <= 0 || colCount <= 0) return []
  const out: GridSelection = []
  for (const r of sel) {
    const b = boundsOf(r)
    if (b.top >= rowCount || b.left >= colCount) continue
    const next = { anchor: clampPos(r.anchor, rowCount, colCount), focus: clampPos(r.focus, rowCount, colCount) }
    out.push(samePos(next.anchor, r.anchor) && samePos(next.focus, r.focus) ? r : next)
  }
  return out.length === sel.length && out.every((r, i) => r === sel[i]) ? sel : out
}

/** Moves the corner of the last rectangle that grows, keeping where it started. */
export function extendTo(sel: GridSelection, focus: CellPos): GridSelection {
  const last = sel[sel.length - 1]
  if (!last) return [single(focus)]
  if (samePos(last.focus, focus)) return sel
  return [...sel.slice(0, -1), { anchor: last.anchor, focus }]
}

/**
 * A click on a cell: selects just that cell; with Shift, stretches the last rectangle to it; with the platform's
 * modifier, adds the cell as a rectangle of its own, or takes a lone cell back out.
 */
export function clickCell(sel: GridSelection, pos: CellPos, mods: { shift: boolean; add: boolean }): GridSelection {
  if (mods.shift && sel.length) return extendTo(sel, pos)
  if (mods.add) {
    const i = sel.findIndex((r) => samePos(r.anchor, pos) && samePos(r.focus, pos))
    return i >= 0 ? sel.filter((_, j) => j !== i) : [...sel, single(pos)]
  }
  return [single(pos)]
}

/** Whole rows from one row to another, across every column. */
export function rowsRange(from: number, to: number, colCount: number): CellRange {
  return { anchor: { row: from, col: 0 }, focus: { row: to, col: Math.max(0, colCount - 1) } }
}

/** A click on a row number: that whole row; with Shift, the rows from the last rectangle's start; with the modifier, one more row. */
export function clickRow(sel: GridSelection, row: number, colCount: number, mods: { shift: boolean; add: boolean }): GridSelection {
  const last = sel[sel.length - 1]
  if (mods.shift && last) return [...sel.slice(0, -1), rowsRange(last.anchor.row, row, colCount)]
  if (mods.add) return [...sel, rowsRange(row, row, colCount)]
  return [rowsRange(row, row, colCount)]
}

/** Whole columns from one column to another, down every row. */
export function columnsRange(from: number, to: number, rowCount: number): CellRange {
  return { anchor: { row: 0, col: from }, focus: { row: Math.max(0, rowCount - 1), col: to } }
}

/** A column picked from its header: that whole column; with Shift, the columns from the last rectangle's start; with the modifier, one more. */
export function clickColumn(sel: GridSelection, col: number, rowCount: number, mods: { shift: boolean; add: boolean }): GridSelection {
  const last = sel[sel.length - 1]
  if (mods.shift && last) return [...sel.slice(0, -1), columnsRange(last.anchor.col, col, rowCount)]
  if (mods.add) return [...sel, columnsRange(col, col, rowCount)]
  return [columnsRange(col, col, rowCount)]
}

export function selectAll(rowCount: number, colCount: number): GridSelection {
  if (rowCount <= 0 || colCount <= 0) return []
  return [{ anchor: { row: 0, col: 0 }, focus: { row: rowCount - 1, col: colCount - 1 } }]
}

/** Every rectangle widened to whole rows (Shift+Space). */
export function wholeRows(sel: GridSelection, colCount: number): GridSelection {
  return sel.map((r) => rowsRange(r.anchor.row, r.focus.row, colCount))
}

/** Every rectangle stretched to whole columns (Ctrl+Space). */
export function wholeColumns(sel: GridSelection, rowCount: number): GridSelection {
  return sel.map((r) => ({ anchor: { row: 0, col: r.anchor.col }, focus: { row: Math.max(0, rowCount - 1), col: r.focus.col } }))
}

/** Sorted indices covered by any of the spans, each span inclusive. */
function covered(spans: [number, number][]): number[] {
  const out = new Set<number>()
  for (const [a, b] of spans) for (let i = a; i <= b; i++) out.add(i)
  return [...out].sort((x, y) => x - y)
}

/** The rows the selection touches, in order. */
export function selectedRows(sel: GridSelection): number[] {
  return covered(sel.map((r) => [boundsOf(r).top, boundsOf(r).bottom]))
}

/** The columns the selection touches, in order. */
export function selectedColumns(sel: GridSelection): number[] {
  return covered(sel.map((r) => [boundsOf(r).left, boundsOf(r).right]))
}

/** Calls `fn` once for every selected cell, row by row. */
export function forEachCell(sel: GridSelection, fn: (row: number, col: number) => void): void {
  const cols = selectedColumns(sel)
  for (const row of selectedRows(sel)) for (const col of cols) if (contains(sel, row, col)) fn(row, col)
}

export function cellCount(sel: GridSelection): number {
  let n = 0
  forEachCell(sel, () => n++)
  return n
}

/**
 * The selected columns of one row as "from-to" spans joined by commas, such as "0-2,5-5"; empty when the row has
 * none. A plain string, so a row that is drawn apart can tell cheaply whether its part of the selection changed.
 */
export function rowSpans(sel: GridSelection, row: number): string {
  const spans: [number, number][] = []
  for (const r of sel) {
    const b = boundsOf(r)
    if (row >= b.top && row <= b.bottom) spans.push([b.left, b.right])
  }
  if (!spans.length) return ''
  spans.sort((x, y) => x[0] - y[0])
  const merged: [number, number][] = []
  for (const s of spans) {
    const prev = merged[merged.length - 1]
    if (prev && s[0] <= prev[1] + 1) prev[1] = Math.max(prev[1], s[1])
    else merged.push([s[0], s[1]])
  }
  return merged.map(([a, b]) => `${a}-${b}`).join(',')
}

export function parseSpans(spans: string): [number, number][] {
  if (!spans) return []
  return spans.split(',').map((s) => {
    const [a, b] = s.split('-')
    return [Number(a), Number(b)]
  })
}

/** A value as one field of tab-separated text: quoted, spreadsheet style, when it holds a tab, line break or quote. */
export function tsvField(text: string): string {
  return /[\t\n\r"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * The selection as text for the clipboard. One cell on its own is its value as it is; anything more is tab-separated
 * lines, a line per row, which spreadsheets paste cell for cell. Rectangles apart from each other are laid out on the
 * rows and columns they share, with the cells in between left empty. `headers` puts the column names first.
 */
/**
 * The selected values as a SQL list, row by row, one per line with a comma after all but the last: ready to paste
 * between the brackets of WHERE … IN ( … ). `literal` writes each value as SQL (text quoted, numbers as they are).
 */
export function selectionSqlList(sel: GridSelection, literal: (row: number, col: number) => string): string {
  const out: string[] = []
  forEachCell(sel, (row, col) => out.push(literal(row, col)))
  return out.join(',\n')
}

export function selectionText(sel: GridSelection, text: (row: number, col: number) => string, headers?: string[]): string {
  const rows = selectedRows(sel)
  const cols = selectedColumns(sel)
  if (!rows.length) return ''
  if (!headers && rows.length === 1 && cols.length === 1) return text(rows[0], cols[0])
  const lines: string[] = []
  if (headers) lines.push(cols.map((c) => tsvField(headers[c] ?? '')).join('\t'))
  for (const row of rows) lines.push(cols.map((col) => (contains(sel, row, col) ? tsvField(text(row, col)) : '')).join('\t'))
  return lines.join('\n')
}
