import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent, type RefObject } from 'react'
import type { CellValue } from '@shared/types'
import { sqlLiteral } from '@shared/export'
import { cellText, displayCell, parseCellInput, valuesEqual } from '@/lib/format'
import { clamp, copyText, formatNumber, hasOwn, isMac, isModKey, modKey } from '@/lib/util'
import {
  activeCell,
  cellCount,
  clampPos,
  clampSelection,
  clickCell,
  clickColumn,
  clickRow,
  contains,
  extendTo,
  forEachCell,
  isSingleCell,
  parseSpans,
  rowSpans,
  rowsRange,
  selectAll,
  selectedColumns,
  selectionSqlList,
  selectionText,
  single,
  wholeColumns,
  wholeRows,
  type CellPos,
  type GridSelection
} from '@/lib/grid-selection'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { Icon } from './Icons'
import { TypeGlyph } from './TypeGlyph'

export type { CellPos, CellRange, GridSelection } from '@/lib/grid-selection'

export interface GridColumn {
  name: string
  declType?: string
  /** The type was read off the values rather than declared (SQLite query results). */
  inferred?: boolean
  pk?: boolean
  readOnly?: boolean
  notnull?: boolean
}

/** What the grid's context menu tells the items its owner adds. */
export interface GridMenuContext {
  /** The cell right-clicked; the selection covers it. */
  pos: CellPos
  /** Stages NULL in every selected cell that can take one; absent when none can. */
  setNull?: () => void
}

export interface DataGridProps {
  columns: GridColumn[]
  rows: CellValue[][]
  rowNumberOffset?: number
  editable?: boolean
  pendingUpdates?: Map<number, Record<string, CellValue>>
  deletedRows?: Set<number>
  /** Rows at or beyond this index are staged inserts. */
  newRowsFrom?: number
  sort?: { column: string; dir: 'asc' | 'desc' } | null
  onSort?: (column: string) => void
  /** The selected cells: rectangles, the last one's first corner being the active cell. */
  selection: GridSelection
  onSelectionChange: (selection: GridSelection) => void
  onEdit?: (row: number, column: string, value: CellValue) => void
  /** More items for the context menu, after its own Copy items. */
  menuItems?: (ctx: GridMenuContext) => MenuItem[]
  onActivate?: (pos: CellPos) => void
  /** Hears what a copy put on the clipboard, in a few words, for the status bar. */
  onCopied?: (message: string) => void
  emptyMessage?: string
  testId?: string
}

const MIN_WIDTH = 60
const SAMPLE_ROWS = 60
const CHAR_W = 7.4
/** A digit of the row numbers (11px monospace), and their cell's padding and border. */
const ROWNUM_DIGIT_W = 6.7
const ROWNUM_EXTRA = 13

/** The row-number column is as wide as its largest number, so a short result wastes no room on it. */
function rowNumberWidth(largest: number): number {
  return Math.ceil(Math.max(2, String(largest).length) * ROWNUM_DIGIT_W + ROWNUM_EXTRA)
}

/** Size a column from its header and a sample of its content, within sane bounds. */
function measureWidth(col: GridColumn, index: number, rows: CellValue[][]): number {
  // The header holds the name, a key icon for primary keys, a possible sort arrow and a short type glyph.
  let chars = col.name.length + (col.declType ? 4 : 0) + (col.pk ? 3 : 0) + 4
  const n = Math.min(rows.length, SAMPLE_ROWS)
  for (let r = 0; r < n; r++) {
    const v = rows[r]?.[index]
    if (v === undefined || v === null) continue
    const len = displayCell(v).text.length
    if (len > chars) chars = len
  }
  return Math.round(Math.min(380, Math.max(72, chars * CHAR_W + 20)))
}

/** The cell (or row number) an event happened on, if it is one of this grid's. */
function cellFrom(target: EventTarget | null, grid: HTMLElement | null): { row: number; col: number; rownum: boolean } | null {
  const td = (target as HTMLElement | null)?.closest?.<HTMLElement>('td[data-r]')
  if (!td || !grid?.contains(td)) return null
  const rownum = td.classList.contains('rownum')
  return { row: Number(td.dataset.r), col: rownum ? 0 : Number(td.dataset.c), rownum }
}

interface CellEditorProps {
  col: number
  text: string
  editorRef: RefObject<HTMLTextAreaElement | null>
  onChange: (text: string) => void
  onCommit: (then?: 'right' | 'down') => void
  onCancel: () => void
}

interface GridRowProps {
  r: number
  label: string
  values: CellValue[] | undefined
  columns: GridColumn[]
  upd: Record<string, CellValue> | undefined
  isNew: boolean
  isDeleted: boolean
  /** The row's part of a selection of more than one cell, as rowSpans gives it. */
  spans: string
  /** The active cell's column when it is in this row, else -1. */
  activeCol: number
  editor: CellEditorProps | null
}

/** One row, drawn again only when something it shows changes: selecting by dragging redraws just the rows it crosses. */
const GridRow = memo(function GridRow({ r, label, values, columns, upd, isNew, isDeleted, spans, activeCol, editor }: GridRowProps) {
  const selected = spans ? parseSpans(spans) : null
  const rowCls = [isNew ? 'row-new' : '', isDeleted ? 'row-deleted' : '', activeCol >= 0 && !selected ? 'row-selected' : '', selected ? 'row-in-range' : '']
  return (
    <tr className={rowCls.filter(Boolean).join(' ')}>
      <td className="rownum" data-r={r}>
        {label}
      </td>
      {columns.map((c, ci) => {
        const dirty = !!upd && hasOwn(upd, c.name)
        const v = dirty ? upd![c.name] : (values?.[ci] ?? null)
        const d = displayCell(v)
        const inRange = !!selected && selected.some(([a, b]) => ci >= a && ci <= b)
        return (
          <td
            key={ci}
            data-r={r}
            data-c={ci}
            className={`cell cell-${d.cls}${dirty ? ' cell-dirty' : ''}${inRange ? ' cell-in-range' : ''}${ci === activeCol ? ' cell-selected' : ''}`}
            title={d.cls === 'text' && d.text.length > 40 ? d.text : undefined}
          >
            {editor && editor.col === ci ? (
              <textarea
                ref={editor.editorRef}
                className="cell-editor"
                value={editor.text}
                rows={Math.min(8, Math.max(1, editor.text.split('\n').length))}
                onChange={(e) => editor.onChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    editor.onCommit(e.altKey ? 'down' : undefined)
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    editor.onCancel()
                  } else if (e.key === 'Tab') {
                    e.preventDefault()
                    editor.onCommit('right')
                  }
                  e.stopPropagation()
                }}
                onBlur={() => editor.onCommit()}
                spellCheck={false}
              />
            ) : (
              <span className="cell-text">{d.text}</span>
            )}
          </td>
        )
      })}
    </tr>
  )
})

/**
 * Rows and columns of values, selected as in a spreadsheet: click, drag, Shift to stretch, the platform's modifier to
 * add, row numbers for whole rows. Copying puts the selection on the clipboard as tab-separated text.
 */
export function DataGrid(props: DataGridProps) {
  const {
    columns,
    rows,
    rowNumberOffset = 0,
    editable = false,
    pendingUpdates,
    deletedRows,
    newRowsFrom,
    sort,
    onSort,
    selection,
    onSelectionChange,
    onEdit,
    menuItems,
    onActivate,
    onCopied,
    emptyMessage,
    testId
  } = props

  const [widths, setWidths] = useState<Record<string, number>>({})
  const [resizing, setResizing] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ row: number; col: number; text: string } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; pos: CellPos } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const committing = useRef(false)
  const dragging = useRef<{ stop: () => void } | null>(null)
  // A drag runs across many renders; it reads the latest of these.
  const latest = useRef({ selection, onSelectionChange, colCount: columns.length })
  useLayoutEffect(() => {
    latest.current = { selection, onSelectionChange, colCount: columns.length }
  })

  const active = activeCell(selection)
  const multi = selection.length > 0 && !isSingleCell(selection)

  const valueAt = useCallback(
    (r: number, c: number): CellValue => {
      const name = columns[c]?.name
      const upd = pendingUpdates?.get(r)
      if (upd && name !== undefined && hasOwn(upd, name)) return upd[name]
      const v = rows[r]?.[c]
      return v === undefined ? null : v
    },
    [columns, rows, pendingUpdates]
  )

  const canEditCell = useCallback(
    (r: number, c: number) => editable && !!onEdit && !columns[c]?.readOnly && !deletedRows?.has(r),
    [editable, onEdit, columns, deletedRows]
  )

  const startEdit = useCallback(
    (r: number, c: number, initialText?: string) => {
      if (!canEditCell(r, c)) return
      const v = valueAt(r, c)
      setEditing({ row: r, col: c, text: initialText ?? (v === null ? '' : cellText(v)) })
    },
    [canEditCell, valueAt]
  )

  const commitEdit = useCallback(
    (then?: 'right' | 'down') => {
      if (!editing || committing.current) return
      committing.current = true
      const col = columns[editing.col]
      const parsed = parseCellInput(editing.text, col.declType)
      const original = valueAt(editing.row, editing.col)
      if (!valuesEqual(parsed, original)) onEdit?.(editing.row, col.name, parsed)
      setEditing(null)
      committing.current = false
      requestAnimationFrame(() => scrollRef.current?.focus())
      if (then === 'right' && editing.col < columns.length - 1) onSelectionChange([single({ row: editing.row, col: editing.col + 1 })])
      if (then === 'down' && editing.row < rows.length - 1) onSelectionChange([single({ row: editing.row + 1, col: editing.col })])
    },
    [editing, columns, valueAt, onEdit, onSelectionChange, rows.length]
  )

  const cancelEdit = useCallback(() => {
    setEditing(null)
    requestAnimationFrame(() => scrollRef.current?.focus())
  }, [])

  const setEditorText = useCallback((text: string) => setEditing((ed) => (ed ? { ...ed, text } : ed)), [])

  useEffect(() => {
    if (editing) {
      const el = editorRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }
    }
  }, [editing?.row, editing?.col]) // eslint-disable-line react-hooks/exhaustive-deps

  const revealCell = useCallback((pos: CellPos) => {
    scrollRef.current?.querySelector<HTMLElement>(`td[data-r="${pos.row}"][data-c="${pos.col}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [])

  // Keep the active cell visible.
  useEffect(() => {
    if (active) revealCell(active)
  }, [active?.row, active?.col, revealCell]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => dragging.current?.stop(), [])

  /** The selected cells that can take an edit. */
  const editableCells = (): CellPos[] => {
    const cells: CellPos[] = []
    if (!editable || !onEdit) return cells
    forEachCell(clampSelection(selection, rows.length, columns.length), (row, col) => {
      if (canEditCell(row, col)) cells.push({ row, col })
    })
    return cells
  }

  const setNull = (cells: CellPos[]) => {
    for (const { row, col } of cells) onEdit?.(row, columns[col].name, null)
  }

  /** The selection as clipboard text, and how many values it holds. */
  const clipboardText = (withNames: boolean): { text: string; count: number } | null => {
    const sel = clampSelection(selection, rows.length, columns.length)
    if (!sel.length) return null
    const text = selectionText(sel, (r, c) => cellText(valueAt(r, c)), withNames ? columns.map((c) => c.name) : undefined)
    return { text, count: cellCount(sel) }
  }

  const reportCopy = (count: number, how?: string) => {
    onCopied?.(`Copied ${count === 1 ? '1 value' : `${formatNumber(count)} values`}${how ? ` ${how}` : ''}`)
  }

  const copy = (withNames: boolean) => {
    const out = clipboardText(withNames)
    if (!out) return
    void copyText(out.text)
    reportCopy(out.count, withNames ? 'with column names' : undefined)
  }

  /** The selection as a list for WHERE … IN ( … ): 'text' with quotes doubled, numbers as they are, NULL. */
  const copySqlList = () => {
    const sel = clampSelection(selection, rows.length, columns.length)
    if (!sel.length) return
    void copyText(selectionSqlList(sel, (r, c) => sqlLiteral(valueAt(r, c))))
    reportCopy(cellCount(sel), 'as a SQL list')
  }

  // Edit → Copy from the menu bar, with the grid focused.
  const onCopyEvent = (e: ClipboardEvent<HTMLDivElement>) => {
    if (editing) return
    const out = clipboardText(false)
    if (!out) return
    e.preventDefault()
    e.clipboardData.setData('text/plain', out.text)
    reportCopy(out.count)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing || menu) return
    const mod = isModKey(e)
    const key = e.key
    if (mod && !e.shiftKey && !e.altKey && key.toLowerCase() === 'a') {
      e.preventDefault()
      onSelectionChange(selectAll(rows.length, columns.length))
      return
    }
    if (!active) return
    // Shift+Space widens the selection to whole rows, Ctrl+Space to whole columns, as in a spreadsheet.
    if (key === ' ' && (e.shiftKey || e.ctrlKey) && !e.metaKey && !e.altKey) {
      e.preventDefault()
      onSelectionChange(e.ctrlKey ? wholeColumns(selection, rows.length) : wholeRows(selection, columns.length))
      return
    }
    const last = selection[selection.length - 1]
    // Moving starts over from the active cell; with Shift, the far corner of the selection moves instead.
    const move = (dr: number, dc: number) => {
      e.preventDefault()
      onSelectionChange([single(clampPos({ row: active.row + dr, col: active.col + dc }, rows.length, columns.length))])
    }
    const grow = (dr: number, dc: number) => {
      e.preventDefault()
      const to = clampPos({ row: last.focus.row + dr, col: last.focus.col + dc }, rows.length, columns.length)
      onSelectionChange(extendTo(selection, to))
      requestAnimationFrame(() => revealCell(to))
    }
    const go = e.shiftKey ? grow : move
    // With the modifier, arrows go all the way to the edge.
    const far = rows.length + columns.length
    switch (key) {
      case 'ArrowUp':
        return go(mod ? -far : -1, 0)
      case 'ArrowDown':
        return go(mod ? far : 1, 0)
      case 'ArrowLeft':
        return go(0, mod ? -far : -1)
      case 'ArrowRight':
        return go(0, mod ? far : 1)
      case 'PageDown':
        return go(20, 0)
      case 'PageUp':
        return go(-20, 0)
      case 'Home':
        return go(mod ? -far : 0, -far)
      case 'End':
        return go(mod ? far : 0, far)
      case 'Tab':
        return move(0, e.shiftKey ? -1 : 1)
      case 'Enter':
      case 'F2':
        e.preventDefault()
        if (canEditCell(active.row, active.col)) startEdit(active.row, active.col)
        else onActivate?.(active)
        return
      case 'Escape':
        onSelectionChange([])
        return
      case 'Backspace':
      case 'Delete':
        if (mod) {
          e.preventDefault()
          setNull(editableCells())
        }
        return
    }
    if (mod && !e.altKey && key.toLowerCase() === 'c') {
      e.preventDefault()
      copy(e.shiftKey)
      return
    }
    // With Option held, a Mac types another character for C, so the key is told by its position.
    if (mod && e.altKey && !e.shiftKey && e.code === 'KeyC') {
      e.preventDefault()
      copySqlList()
      return
    }
    if (key.length === 1 && !mod && !e.altKey && !e.ctrlKey && canEditCell(active.row, active.col)) {
      e.preventDefault()
      startEdit(active.row, active.col, key)
    }
  }

  /** One frame of a drag: scroll when held past an edge, then stretch the selection to the cell under the pointer. */
  const dragStep = (mode: 'cells' | 'rows', pointer: { x: number; y: number }) => {
    const el = scrollRef.current
    if (!el) return
    const box = el.getBoundingClientRect()
    // The header and the row numbers stay put above and left of the cells.
    const corner = el.querySelector('th.rownum')?.getBoundingClientRect()
    // A table smaller than the view ends before it does: past its last row or column is still that row or column.
    const table = el.querySelector('table')?.getBoundingClientRect()
    const top = corner?.bottom ?? box.top
    const left = corner?.right ?? box.left
    const bottom = Math.min(box.top + el.clientHeight, table?.bottom ?? Infinity)
    const right = Math.min(box.left + el.clientWidth, table?.right ?? Infinity)
    const speed = (past: number) => Math.min(48, Math.ceil(past / 2))
    if (pointer.y < top) el.scrollTop -= speed(top - pointer.y)
    else if (pointer.y > bottom) el.scrollTop += speed(pointer.y - bottom)
    if (mode === 'cells') {
      if (pointer.x < left) el.scrollLeft -= speed(left - pointer.x)
      else if (pointer.x > right) el.scrollLeft += speed(pointer.x - right)
    }
    const hit = cellFrom(document.elementFromPoint(clamp(pointer.x, left + 1, right - 2), clamp(pointer.y, top + 1, bottom - 2)), el)
    if (!hit) return
    const { selection: sel, onSelectionChange: change, colCount } = latest.current
    const next = extendTo(sel, mode === 'rows' ? { row: hit.row, col: colCount - 1 } : { row: hit.row, col: hit.col })
    if (next !== sel) change(next)
  }

  const startDrag = (mode: 'cells' | 'rows', x: number, y: number) => {
    dragging.current?.stop()
    const pointer = { x, y }
    let frame = 0
    const onMove = (ev: globalThis.MouseEvent) => {
      pointer.x = ev.clientX
      pointer.y = ev.clientY
    }
    const stop = () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', stop)
      dragging.current = null
    }
    const tick = () => {
      dragStep(mode, pointer)
      frame = requestAnimationFrame(tick)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', stop)
    frame = requestAnimationFrame(tick)
    dragging.current = { stop }
  }

  const onBodyMouseDown = (e: MouseEvent<HTMLTableSectionElement>) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('.cell-editor')) return
    const hit = cellFrom(e.target, scrollRef.current)
    if (!hit) return
    if (editing) {
      if (!hit.rownum && editing.row === hit.row && editing.col === hit.col) return
      commitEdit()
    }
    // The grid draws its own selection, so no text gets selected on the way.
    e.preventDefault()
    scrollRef.current?.focus({ preventScroll: true })
    const mods = { shift: e.shiftKey, add: isModKey(e) }
    const next = hit.rownum ? clickRow(selection, hit.row, columns.length, mods) : clickCell(selection, { row: hit.row, col: hit.col }, mods)
    onSelectionChange(next)
    // A cell taken back out of the selection starts no drag.
    if (mods.add && next.length < selection.length) return
    startDrag(hit.rownum ? 'rows' : 'cells', e.clientX, e.clientY)
  }

  const onBodyDoubleClick = (e: MouseEvent<HTMLTableSectionElement>) => {
    if ((e.target as HTMLElement).closest('.cell-editor')) return
    const hit = cellFrom(e.target, scrollRef.current)
    if (!hit || hit.rownum) return
    if (canEditCell(hit.row, hit.col)) startEdit(hit.row, hit.col)
    else onActivate?.({ row: hit.row, col: hit.col })
  }

  const onBodyContextMenu = (e: MouseEvent<HTMLTableSectionElement>) => {
    if ((e.target as HTMLElement).closest('.cell-editor')) return
    const hit = cellFrom(e.target, scrollRef.current)
    if (!hit) return
    e.preventDefault()
    // A right-click inside the selection keeps it, as in a spreadsheet; elsewhere it selects what was clicked.
    const kept = hit.rownum ? rowSpans(selection, hit.row) === `0-${columns.length - 1}` : contains(selection, hit.row, hit.col)
    if (!kept) onSelectionChange(hit.rownum ? [rowsRange(hit.row, hit.row, columns.length)] : [single({ row: hit.row, col: hit.col })])
    scrollRef.current?.focus({ preventScroll: true })
    setMenu({ x: e.clientX, y: e.clientY, pos: { row: hit.row, col: hit.col } })
  }

  const menuContent = (pos: CellPos): MenuItem[] => {
    const nullable = editableCells()
    const own: MenuItem[] = [
      { label: 'Copy', shortcut: `${modKey}C`, onClick: () => copy(false) },
      { label: 'Copy with column names', shortcut: isMac ? '⌘⇧C' : 'Ctrl+Shift+C', onClick: () => copy(true) },
      { label: 'Copy as SQL list', shortcut: isMac ? '⌥⌘C' : 'Ctrl+Alt+C', onClick: copySqlList }
    ]
    const extra = menuItems?.({ pos, setNull: nullable.length ? () => setNull(nullable) : undefined }) ?? []
    const items = extra.length ? [...own, { separator: true }, ...extra] : own
    // Once an item is chosen, the keyboard is back with the grid.
    return items.map((item) => (item.onClick ? { ...item, onClick: () => (item.onClick!(), scrollRef.current?.focus({ preventScroll: true })) } : item))
  }

  const autoWidths = useMemo(() => {
    const m: Record<string, number> = {}
    columns.forEach((c, i) => (m[c.name] = measureWidth(c, i, rows)))
    return m
    // Only re-measure when the column set changes, so paging does not jiggle widths.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns.map((c) => c.name).join('\u0000'), rows.length > 0])

  const startResize = (e: MouseEvent, name: string) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = widths[name] ?? autoWidths[name] ?? 150
    setResizing(name)
    const move = (ev: globalThis.MouseEvent) => {
      const w = Math.max(MIN_WIDTH, startW + ev.clientX - startX)
      setWidths((ws) => ({ ...ws, [name]: w }))
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setResizing(null)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const colWidth = (c: GridColumn) => widths[c.name] ?? autoWidths[c.name] ?? 150
  const numWidth = rowNumberWidth(rowNumberOffset + rows.length)
  const totalWidth = numWidth + columns.reduce((sum, c) => sum + colWidth(c), 0)
  const rangeCols = multi ? new Set(selectedColumns(selection)) : null

  return (
    <div className="grid-wrap" data-testid={testId}>
      <div className="grid-scroll" ref={scrollRef} tabIndex={0} onKeyDown={onKeyDown} onCopy={onCopyEvent}>
        <table className="grid" style={{ width: totalWidth }}>
          <colgroup>
            <col style={{ width: numWidth }} />
            {columns.map((c) => (
              <col key={c.name} style={{ width: colWidth(c) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="rownum" />
              {columns.map((c, ci) => (
                <th
                  key={c.name + ci}
                  className={[sort?.column === c.name ? 'sorted' : '', rangeCols?.has(ci) ? 'col-in-range' : ''].filter(Boolean).join(' ')}
                  onClick={(e) => {
                    // A click sorts where the grid sorts; otherwise, or with Alt (⌥), it selects the column, as a
                    // spreadsheet's column header does.
                    if (onSort && !e.altKey) return onSort(c.name)
                    onSelectionChange(clickColumn(selection, ci, rows.length, { shift: e.shiftKey, add: isModKey(e) }))
                    scrollRef.current?.focus({ preventScroll: true })
                  }}
                  title={`${c.name}${c.declType ? ` — ${c.declType}` : ''}\n${onSort ? `Click to sort · ${isMac ? '⌥' : 'Alt+'}click` : 'Click'} to select the column`}
                >
                  <div className="th-inner">
                    {c.pk ? <Icon className="th-key" name="key" size={11} /> : null}
                    <span className="th-name">{c.name}</span>
                    {sort?.column === c.name ? <span className="th-sort">{sort.dir === 'asc' ? '▲' : '▼'}</span> : null}
                    <TypeGlyph declType={c.declType} inferred={c.inferred} />
                  </div>
                  <span className={`col-resizer ${resizing === c.name ? 'active' : ''}`} onMouseDown={(e) => startResize(e, c.name)} onClick={(e) => e.stopPropagation()} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody onMouseDown={onBodyMouseDown} onDoubleClick={onBodyDoubleClick} onContextMenu={onBodyContextMenu}>
            {rows.map((values, r) => {
              const isNew = newRowsFrom !== undefined && r >= newRowsFrom
              return (
                <GridRow
                  key={r}
                  r={r}
                  label={isNew ? '+' : String(rowNumberOffset + r + 1)}
                  values={values}
                  columns={columns}
                  upd={pendingUpdates?.get(r)}
                  isNew={isNew}
                  isDeleted={deletedRows?.has(r) ?? false}
                  spans={multi ? rowSpans(selection, r) : ''}
                  activeCol={active && active.row === r ? active.col : -1}
                  editor={
                    editing && editing.row === r
                      ? { col: editing.col, text: editing.text, editorRef, onChange: setEditorText, onCommit: commitEdit, onCancel: cancelEdit }
                      : null
                  }
                />
              )
            })}
          </tbody>
        </table>
        {rows.length === 0 ? <div className="empty-state">{emptyMessage ?? 'No rows'}</div> : null}
      </div>
      {menu ? <ContextMenu x={menu.x} y={menu.y} items={menuContent(menu.pos)} onClose={() => setMenu(null)} /> : null}
    </div>
  )
}
