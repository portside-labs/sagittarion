import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import type { CellValue } from '@shared/types'
import { cellText, displayCell, parseCellInput, valuesEqual } from '@/lib/format'
import { copyText, hasOwn, isModKey } from '@/lib/util'
import { Icon } from './Icons'

export interface GridColumn {
  name: string
  declType?: string
  pk?: boolean
  readOnly?: boolean
  notnull?: boolean
}

export interface CellPos {
  row: number
  col: number
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
  selection: CellPos | null
  onSelect: (pos: CellPos | null) => void
  onEdit?: (row: number, column: string, value: CellValue) => void
  onContextMenu?: (e: MouseEvent, pos: CellPos) => void
  onActivate?: (pos: CellPos) => void
  emptyMessage?: string
  testId?: string
}

const MIN_WIDTH = 60
const SAMPLE_ROWS = 60
const CHAR_W = 7.4

/** Size a column from its header and a sample of its content, within sane bounds. */
function measureWidth(col: GridColumn, index: number, rows: CellValue[][]): number {
  let chars = col.name.length + (col.declType ? col.declType.length * 0.8 + 3 : 0) + 2
  const n = Math.min(rows.length, SAMPLE_ROWS)
  for (let r = 0; r < n; r++) {
    const v = rows[r]?.[index]
    if (v === undefined || v === null) continue
    const len = displayCell(v).text.length
    if (len > chars) chars = len
  }
  return Math.round(Math.min(380, Math.max(72, chars * CHAR_W + 20)))
}

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
    onSelect,
    onEdit,
    onContextMenu,
    onActivate,
    emptyMessage,
    testId
  } = props

  const [widths, setWidths] = useState<Record<string, number>>({})
  const [resizing, setResizing] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ row: number; col: number; text: string } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const committing = useRef(false)

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
      if (then === 'right' && editing.col < columns.length - 1) onSelect({ row: editing.row, col: editing.col + 1 })
      if (then === 'down' && editing.row < rows.length - 1) onSelect({ row: editing.row + 1, col: editing.col })
    },
    [editing, columns, valueAt, onEdit, onSelect, rows.length]
  )

  const cancelEdit = useCallback(() => {
    setEditing(null)
    requestAnimationFrame(() => scrollRef.current?.focus())
  }, [])

  useEffect(() => {
    if (editing) {
      const el = editorRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }
    }
  }, [editing?.row, editing?.col]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the selected cell visible.
  useEffect(() => {
    if (!selection || !scrollRef.current) return
    const td = scrollRef.current.querySelector<HTMLElement>(`td[data-r="${selection.row}"][data-c="${selection.col}"]`)
    td?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selection])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing) return
    if (!selection) return
    const { row, col } = selection
    const move = (dr: number, dc: number) => {
      e.preventDefault()
      const nr = Math.max(0, Math.min(rows.length - 1, row + dr))
      const nc = Math.max(0, Math.min(columns.length - 1, col + dc))
      onSelect({ row: nr, col: nc })
    }
    switch (e.key) {
      case 'ArrowUp':
        return move(-1, 0)
      case 'ArrowDown':
        return move(1, 0)
      case 'ArrowLeft':
        return move(0, -1)
      case 'ArrowRight':
        return move(0, 1)
      case 'Tab':
        return move(0, e.shiftKey ? -1 : 1)
      case 'PageDown':
        return move(20, 0)
      case 'PageUp':
        return move(-20, 0)
      case 'Home':
        return move(0, -columns.length)
      case 'End':
        return move(0, columns.length)
      case 'Enter':
      case 'F2':
        e.preventDefault()
        if (canEditCell(row, col)) startEdit(row, col)
        else onActivate?.(selection)
        return
      case 'Escape':
        onSelect(null)
        return
      case 'Backspace':
      case 'Delete':
        if (isModKey(e) && canEditCell(row, col)) {
          e.preventDefault()
          onEdit?.(row, columns[col].name, null)
        }
        return
      case 'c':
        if (isModKey(e)) {
          e.preventDefault()
          void copyText(cellText(valueAt(row, col)))
        }
        return
    }
    if (e.key.length === 1 && !isModKey(e) && !e.altKey && canEditCell(row, col)) {
      e.preventDefault()
      startEdit(row, col, e.key)
    }
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
  const totalWidth = 52 + columns.reduce((sum, c) => sum + colWidth(c), 0)

  return (
    <div className="grid-wrap" data-testid={testId}>
      <div className="grid-scroll" ref={scrollRef} tabIndex={0} onKeyDown={onKeyDown}>
        <table className="grid" style={{ width: totalWidth }}>
          <colgroup>
            <col style={{ width: 52 }} />
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
                  className={sort?.column === c.name ? 'sorted' : ''}
                  onClick={() => onSort?.(c.name)}
                  title={`${c.name}${c.declType ? ` — ${c.declType}` : ''}${onSort ? '\nClick to sort' : ''}`}
                >
                  <div className="th-inner">
                    {c.pk ? <Icon className="th-key" name="key" size={11} /> : null}
                    <span className="th-name">{c.name}</span>
                    {sort?.column === c.name ? <span className="th-sort">{sort.dir === 'asc' ? '▲' : '▼'}</span> : null}
                    {c.declType ? <span className="th-type">{c.declType}</span> : null}
                  </div>
                  <span className={`col-resizer ${resizing === c.name ? 'active' : ''}`} onMouseDown={(e) => startResize(e, c.name)} onClick={(e) => e.stopPropagation()} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((_, r) => {
              const isNew = newRowsFrom !== undefined && r >= newRowsFrom
              const isDeleted = deletedRows?.has(r) ?? false
              const upd = pendingUpdates?.get(r)
              const rowCls = [isNew ? 'row-new' : '', isDeleted ? 'row-deleted' : '', selection?.row === r ? 'row-selected' : ''].join(' ')
              return (
                <tr key={r} className={rowCls}>
                  <td className="rownum">{isNew ? '+' : rowNumberOffset + r + 1}</td>
                  {columns.map((c, ci) => {
                    const v = valueAt(r, ci)
                    const d = displayCell(v)
                    const dirty = !!upd && hasOwn(upd, c.name)
                    const isSel = !!selection && selection.row === r && selection.col === ci
                    const isEditing = !!editing && editing.row === r && editing.col === ci
                    return (
                      <td
                        key={ci}
                        data-r={r}
                        data-c={ci}
                        className={`cell cell-${d.cls} ${dirty ? 'cell-dirty' : ''} ${isSel ? 'cell-selected' : ''}`}
                        onMouseDown={(e) => {
                          if (e.button !== 0) return
                          if (editing && !isEditing) commitEdit()
                          onSelect({ row: r, col: ci })
                        }}
                        onDoubleClick={() => (canEditCell(r, ci) ? startEdit(r, ci) : onActivate?.({ row: r, col: ci }))}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          onSelect({ row: r, col: ci })
                          onContextMenu?.(e, { row: r, col: ci })
                        }}
                        title={d.cls === 'text' && d.text.length > 40 ? d.text : undefined}
                      >
                        {isEditing ? (
                          <textarea
                            ref={editorRef}
                            className="cell-editor"
                            value={editing.text}
                            rows={Math.min(8, Math.max(1, editing.text.split('\n').length))}
                            onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault()
                                commitEdit(e.altKey ? 'down' : undefined)
                              } else if (e.key === 'Escape') {
                                e.preventDefault()
                                cancelEdit()
                              } else if (e.key === 'Tab') {
                                e.preventDefault()
                                commitEdit('right')
                              }
                              e.stopPropagation()
                            }}
                            onBlur={() => commitEdit()}
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
            })}
          </tbody>
        </table>
        {rows.length === 0 ? <div className="empty-state">{emptyMessage ?? 'No rows'}</div> : null}
      </div>
    </div>
  )
}
