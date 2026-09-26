import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CellValue, PendingChange, RowKey, RowsResponse } from '@shared/types'
import { useStore, type Tab } from '@/store'
import { useSession } from '@/session-store'
import { DataGrid, type GridColumn, type GridMenuContext, type GridSelection } from './DataGrid'
import { CellInspector } from './CellInspector'
import { StructureView } from './StructureView'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { Icon } from './Icons'
import { REFRESH_EVENT } from '@/screens/Workspace'
import { valuesEqual } from '@/lib/format'
import { activeCell, clampSelection, selectedRows, single } from '@/lib/grid-selection'
import { copyText, errorMessage, formatDuration, formatNumber, hasOwn, isMac, modKey } from '@/lib/util'
import { cellToPlainText } from '@shared/export'

const PAGE_SIZES = [100, 200, 500, 1000]

export function TableTab({ tab, active }: { tab: Extract<Tab, { kind: 'table' }>; active: boolean }) {
  const session = useSession((s) => s.session)!
  const setTabDirty = useSession((s) => s.setTabDirty)
  const toast = useStore((s) => s.toast)
  const setStatus = useSession((s) => s.setStatus)
  const setInTransaction = useSession((s) => s.setInTransaction)
  const confirm = useStore((s) => s.confirm)

  const [view, setView] = useState<'data' | 'structure'>('data')
  const [data, setData] = useState<RowsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(200)
  const [sort, setSort] = useState<{ column: string; dir: 'asc' | 'desc' } | null>(null)
  const [where, setWhere] = useState('')
  const [whereDraft, setWhereDraft] = useState('')
  const [updates, setUpdates] = useState<Map<number, Record<string, CellValue>>>(new Map())
  const [deletes, setDeletes] = useState<Set<number>>(new Set())
  const [inserts, setInserts] = useState<Record<string, CellValue>[]>([])
  const [selection, setSelection] = useState<GridSelection>([])
  const [inspector, setInspector] = useState(false)
  /** The cell editing and the inspector act on. */
  const activePos = activeCell(selection)
  const [exportMenu, setExportMenu] = useState<{ x: number; y: number } | null>(null)
  const [applying, setApplying] = useState(false)
  const [structureKey, setStructureKey] = useState(0)
  const [loadCount, setLoadCount] = useState(0)
  const reqSeq = useRef(0)

  const pendingCount = updates.size + deletes.size + inserts.length
  useEffect(() => setTabDirty(tab.id, pendingCount > 0), [pendingCount, setTabDirty, tab.id])

  const clearPending = useCallback(() => {
    setUpdates(new Map())
    setDeletes(new Set())
    setInserts([])
  }, [])

  const load = useCallback(async () => {
    const seq = ++reqSeq.current
    setLoading(true)
    setError(null)
    try {
      const res = await window.api.db.rows(session.sessionId, {
        table: tab.table,
        schema: tab.schema,
        offset: page * pageSize,
        limit: pageSize,
        orderBy: sort?.column,
        orderDir: sort?.dir,
        where: where || undefined,
        withCount: true
      })
      if (seq !== reqSeq.current) return
      setData(res)
      setInTransaction(res.tx)
      setStatus(`${formatNumber(res.rows.length)} rows fetched in ${formatDuration(res.durationMs)}`)
      clearPending()
      setSelection((s) => clampSelection(s, res.rows.length))
    } catch (e) {
      if (seq === reqSeq.current) setError(errorMessage(e))
    } finally {
      if (seq === reqSeq.current) {
        setLoading(false)
        setLoadCount((c) => c + 1)
      }
    }
  }, [session.sessionId, tab.table, tab.schema, page, pageSize, sort, where, clearPending, setInTransaction, setStatus])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const handler = (e: Event) => {
      if ((e as CustomEvent).detail !== tab.id) return
      void guarded(() => {
        setStructureKey((k) => k + 1)
        void load()
      })
    }
    window.addEventListener(REFRESH_EVENT, handler)
    return () => window.removeEventListener(REFRESH_EVENT, handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, pendingCount, tab.id])

  async function guarded(fn: () => void) {
    if (pendingCount > 0) {
      const ok = await confirm('Discard staged changes?', `${pendingCount} staged change${pendingCount === 1 ? '' : 's'} in this tab will be lost.`, 'Discard', true)
      if (!ok) return
    }
    fn()
  }

  const columns: GridColumn[] = useMemo(
    () =>
      (data?.columns ?? []).map((c) => ({
        name: c.name,
        declType: c.declType,
        pk: !!c.pk,
        readOnly: (c.hidden ?? 0) >= 2,
        notnull: c.notnull
      })),
    [data]
  )

  const baseRowCount = data?.rows.length ?? 0
  const allRows = useMemo(() => {
    if (!data) return []
    const insertRows = inserts.map((ins) => data.columns.map((c) => (hasOwn(ins, c.name) ? ins[c.name] : null)))
    return [...data.rows, ...insertRows]
  }, [data, inserts])

  const editable = !!data && !data.isView && (data.rowids !== null || data.pk.length > 0) && !session.db?.readonly

  const keyFor = (row: number): RowKey => {
    if (!data) throw new Error('no data')
    if (data.rowids && data.rowidAlias) return { rowid: data.rowids[row], alias: data.rowidAlias }
    const pk: Record<string, CellValue> = {}
    for (const p of data.pk) {
      const idx = data.columns.findIndex((c) => c.name === p)
      pk[p] = data.rows[row][idx]
    }
    return { pk }
  }

  const onEdit = (row: number, column: string, value: CellValue) => {
    if (!data) return
    if (row >= baseRowCount) {
      setInserts((list) => list.map((ins, i) => (i === row - baseRowCount ? { ...ins, [column]: value } : ins)))
      return
    }
    const ci = data.columns.findIndex((c) => c.name === column)
    const original = data.rows[row][ci]
    setUpdates((m) => {
      const next = new Map(m)
      const cur = { ...(next.get(row) ?? {}) }
      if (valuesEqual(original, value)) delete cur[column]
      else cur[column] = value
      if (Object.keys(cur).length) next.set(row, cur)
      else next.delete(row)
      return next
    })
  }

  const addRow = () => {
    if (!editable || !data) return
    setInserts((list) => [...list, {}])
    setSelection([single({ row: allRows.length, col: 0 })])
  }

  /** The rows the selection touches. */
  const pickedRows = () => selectedRows(clampSelection(selection, allRows.length))

  /** Stages rows for deletion, or takes them back when every one already is; staged inserts among them are dropped. */
  const toggleDelete = (target: number[] = pickedRows()) => {
    if (!target.length || !editable) return
    const inserted = new Set(target.filter((r) => r >= baseRowCount).map((r) => r - baseRowCount))
    const existing = target.filter((r) => r < baseRowCount)
    if (inserted.size) {
      setInserts((list) => list.filter((_, i) => !inserted.has(i)))
      setSelection([])
    }
    if (!existing.length) return
    setDeletes((s) => {
      const next = new Set(s)
      const undo = existing.every((r) => next.has(r))
      for (const r of existing) {
        if (undo) next.delete(r)
        else next.add(r)
      }
      return next
    })
  }

  const apply = async () => {
    if (!data || pendingCount === 0) return
    const changes: PendingChange[] = []
    for (const [row, values] of updates) if (!deletes.has(row)) changes.push({ type: 'update', table: tab.table, schema: tab.schema, key: keyFor(row), values })
    for (const row of deletes) changes.push({ type: 'delete', table: tab.table, schema: tab.schema, key: keyFor(row) })
    for (const values of inserts) changes.push({ type: 'insert', table: tab.table, schema: tab.schema, values })
    const parts = [
      updates.size ? `${updates.size} update${updates.size === 1 ? '' : 's'}` : '',
      inserts.length ? `${inserts.length} insert${inserts.length === 1 ? '' : 's'}` : '',
      deletes.size ? `${deletes.size} delete${deletes.size === 1 ? '' : 's'}` : ''
    ].filter(Boolean)
    const ok = await confirm(`Apply ${parts.join(', ')} to "${tab.title}"?`, 'The changes run inside one transaction on the remote database.', 'Apply', deletes.size > 0)
    if (!ok) return
    setApplying(true)
    try {
      const n = await window.api.db.apply(session.sessionId, changes)
      toast('success', `Applied ${n} change${n === 1 ? '' : 's'} to ${tab.title}`)
      clearPending()
      await load()
    } catch (e) {
      toast('error', 'Changes were not applied', errorMessage(e))
    } finally {
      setApplying(false)
    }
  }

  const exportRows = async (format: 'csv' | 'json' | 'sql') => {
    if (!data) return
    try {
      const res = await window.api.exportData({
        format,
        columns: data.columns.map((c) => c.name),
        rows: data.rows,
        tableName: tab.schema && tab.schema !== 'public' ? `${tab.schema}.${tab.table}` : tab.table,
        suggestedName: tab.table
      })
      if (res.saved) toast('success', `Exported ${formatNumber(data.rows.length)} rows`, res.path)
    } catch (e) {
      toast('error', 'Export failed', errorMessage(e))
    }
  }

  const total = data?.total ?? null
  const from = page * pageSize + 1
  const to = page * pageSize + baseRowCount
  const canPrev = page > 0
  const canNext = total !== null ? to < total : baseRowCount === pageSize

  const selectedValue = activePos && data ? (activePos.row < baseRowCount ? (updates.get(activePos.row) && hasOwn(updates.get(activePos.row)!, columns[activePos.col]?.name) ? updates.get(activePos.row)![columns[activePos.col].name] : data.rows[activePos.row]?.[activePos.col]) : allRows[activePos.row]?.[activePos.col]) : undefined

  /** The grid's context menu, after its Copy items: acts on every row the selection touches. */
  const menuItems = ({ pos, setNull }: GridMenuContext): MenuItem[] => {
    const picked = pickedRows()
    const target = picked.length ? picked : [pos.row]
    const n = target.length
    const rowObject = (r: number) => Object.fromEntries(columns.map((c, i) => [c.name, allRows[r]?.[i] ?? null]))
    const inserted = target.filter((r) => r >= baseRowCount).length
    const undo = inserted < n && target.every((r) => r >= baseRowCount || deletes.has(r))
    return [
      { label: n > 1 ? `Copy ${n} rows as JSON` : 'Copy row as JSON', onClick: () => void copyText(JSON.stringify(n > 1 ? target.map(rowObject) : rowObject(target[0]), null, 2)) },
      { label: n > 1 ? `Copy ${n} rows as CSV` : 'Copy row as CSV', onClick: () => void copyText(target.map((r) => allRows[r].map((c) => cellToPlainText(c)).join(',')).join('\n')) },
      { label: 'Inspect value', onClick: () => setInspector(true) },
      { separator: true },
      { label: 'Set NULL', shortcut: isMac ? '⌘⌫' : 'Ctrl+Del', disabled: !setNull, onClick: setNull },
      { label: 'Add row', disabled: !editable, onClick: addRow },
      {
        label: inserted === n ? (n > 1 ? `Remove ${n} new rows` : 'Remove new row') : undo ? 'Undo delete' : n > 1 ? `Delete ${n} rows` : 'Delete row',
        disabled: !editable,
        danger: inserted < n && !undo,
        onClick: () => toggleDelete(target)
      }
    ]
  }

  return (
    <div className="table-tab" data-loads={loadCount}>
      <div className="toolbar">
        <div className="segmented small">
          <button className={view === 'data' ? 'active' : ''} onClick={() => setView('data')}>
            Data
          </button>
          <button className={view === 'structure' ? 'active' : ''} onClick={() => setView('structure')} data-testid="structure-toggle">
            Structure
          </button>
        </div>
        {view === 'data' ? (
          <>
            <div className="filter-wrap">
              <Icon className="icon" name="filter" size={12} />
              <input
                className={`text ${where ? 'applied' : ''}`}
                placeholder="WHERE clause, e.g. status = 'paid' AND total > 100"
                value={whereDraft}
                onChange={(e) => setWhereDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    void guarded(() => {
                      setWhere(whereDraft.trim())
                      setPage(0)
                    })
                  } else if (e.key === 'Escape') {
                    setWhereDraft(where)
                  }
                }}
                spellCheck={false}
                data-testid="where-input"
              />
              {whereDraft ? (
                <button
                  className="btn ghost icon small clear"
                  title="Clear filter"
                  onClick={() =>
                    void guarded(() => {
                      setWhereDraft('')
                      setWhere('')
                      setPage(0)
                    })
                  }
                >
                  <Icon name="x" size={12} />
                </button>
              ) : null}
            </div>
            <span className="spacer" />
            {pendingCount > 0 ? (
              <>
                <button className="btn small success" onClick={() => void apply()} disabled={applying} data-testid="apply-button">
                  {applying ? <span className="spinner" /> : <Icon name="check" />} Apply {pendingCount}
                </button>
                <button className="btn small" onClick={clearPending} disabled={applying}>
                  Discard
                </button>
                <span className="sep" />
              </>
            ) : null}
            {editable ? (
              <>
                <button className="btn ghost icon small" title="Add row" onClick={addRow} data-testid="add-row">
                  <Icon name="plus" />
                </button>
                <button className="btn ghost icon small" title="Delete selected rows" disabled={!activePos} onClick={() => toggleDelete()} data-testid="delete-row">
                  <Icon name="minus" />
                </button>
                <span className="sep" />
              </>
            ) : null}
            <div className="pager">
              <button className="btn ghost icon small" disabled={!canPrev || loading} onClick={() => void guarded(() => setPage((p) => p - 1))} title="Previous page">
                <Icon name="arrow-left" />
              </button>
              <span data-testid="pager-label">
                {baseRowCount ? `${formatNumber(from)}–${formatNumber(to)}` : '0'}
                {total !== null ? ` of ${formatNumber(total)}` : ''}
              </span>
              <button className="btn ghost icon small" disabled={!canNext || loading} onClick={() => void guarded(() => setPage((p) => p + 1))} title="Next page">
                <Icon name="arrow-right" />
              </button>
              <select
                className="select"
                value={pageSize}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  void guarded(() => {
                    setPageSize(n)
                    setPage(0)
                  })
                }}
                title="Rows per page"
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n} / page
                  </option>
                ))}
              </select>
            </div>
            <span className="sep" />
            <button className="btn ghost icon small" title={`Refresh (${modKey}R)`} onClick={() => void guarded(() => void load())} disabled={loading}>
              {loading ? <span className="spinner" /> : <Icon name="refresh" />}
            </button>
            <button className="btn ghost icon small" title="Export loaded rows" onClick={(e) => setExportMenu({ x: e.clientX, y: e.clientY })} disabled={!data}>
              <Icon name="download" />
            </button>
            <button className={`btn ghost icon small ${inspector ? 'active' : ''}`} title="Toggle cell inspector" onClick={() => setInspector((v) => !v)}>
              <Icon name="panel" />
            </button>
          </>
        ) : (
          <>
            <span className="spacer" />
            <button className="btn ghost icon small" title="Refresh" onClick={() => setStructureKey((k) => k + 1)}>
              <Icon name="refresh" />
            </button>
          </>
        )}
      </div>
      {loading ? <div className="loading-bar" /> : null}
      {error ? (
        <div className="banner error">
          <pre>{error}</pre>
        </div>
      ) : null}
      {view === 'data' && data && !editable && !data.isView && !session.db?.readonly ? (
        <div className="banner info">
          {session.kind === 'postgres'
            ? 'This table has no primary key, so rows cannot be edited safely here.'
            : 'This table has neither a rowid nor a primary key, so rows cannot be edited safely here.'}
        </div>
      ) : null}
      {view === 'structure' ? (
        <StructureView table={{ schema: tab.schema, name: tab.table }} refreshKey={structureKey} />
      ) : (
        <div className="grid-area">
          {data ? (
            <DataGrid
              columns={columns}
              rows={allRows}
              rowNumberOffset={page * pageSize}
              editable={editable}
              pendingUpdates={updates}
              deletedRows={deletes}
              newRowsFrom={baseRowCount}
              sort={sort}
              onSort={(column) =>
                void guarded(() => {
                  setSort((s) => (s?.column !== column ? { column, dir: 'asc' } : s.dir === 'asc' ? { column, dir: 'desc' } : null))
                  setPage(0)
                })
              }
              selection={selection}
              onSelectionChange={setSelection}
              onEdit={editable ? onEdit : undefined}
              menuItems={menuItems}
              onActivate={() => setInspector(true)}
              onCopied={setStatus}
              emptyMessage={where ? 'No rows match the filter' : 'This table is empty'}
              testId="table-grid"
            />
          ) : (
            <div className="grid-wrap" />
          )}
          {inspector ? (
            <CellInspector
              column={activePos ? columns[activePos.col] ?? null : null}
              value={selectedValue}
              editable={editable && !!activePos && !deletes.has(activePos.row)}
              onStage={activePos ? (v) => onEdit(activePos.row, columns[activePos.col].name, v) : undefined}
              onClose={() => setInspector(false)}
              rowLabel={activePos ? (activePos.row >= baseRowCount ? 'new row' : `#${formatNumber(page * pageSize + activePos.row + 1)}`) : undefined}
            />
          ) : null}
        </div>
      )}
      {exportMenu ? (
        <ContextMenu
          x={exportMenu.x}
          y={exportMenu.y}
          onClose={() => setExportMenu(null)}
          items={[
            { label: 'Export loaded rows as CSV…', onClick: () => void exportRows('csv') },
            { label: 'Export loaded rows as JSON…', onClick: () => void exportRows('json') },
            { label: 'Export loaded rows as SQL INSERTs…', onClick: () => void exportRows('sql') }
          ]}
        />
      ) : null}
      {!active ? null : null}
    </div>
  )
}
