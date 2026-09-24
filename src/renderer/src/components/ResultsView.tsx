import { useEffect, useMemo, useState } from 'react'
import type { CellValue, PendingChange, RowKey, RowsResult, StatementResult, TableRef } from '@shared/types'
import { tableKey } from '@shared/connections'
import { DataGrid, type CellPos, type GridColumn } from './DataGrid'
import { CellInspector } from './CellInspector'
import { Icon } from './Icons'
import { editableSource } from '@/lib/sql-source'
import { valuesEqual } from '@/lib/format'
import { errorMessage, formatDuration, formatNumber } from '@/lib/util'
import { useSession } from '@/session-store'
import { useStore } from '@/store'

function chipLabel(r: StatementResult): string {
  if (r.kind === 'rows') return `${formatNumber(r.rowCount)}${r.truncated ? '+' : ''} row${r.rowCount === 1 && !r.truncated ? '' : 's'}`
  if (r.kind === 'exec') return r.changes > 0 ? `${formatNumber(r.changes)} changed` : 'ok'
  return 'error'
}

/** How rows of a result map back to their table, when they can be edited in place. */
interface EditPlan {
  table: TableRef
  columns: GridColumn[]
  keyFor: (row: CellValue[]) => RowKey
}

type Edits = Map<number, Record<string, CellValue>>

export function ResultsView({
  sessionId,
  runKey,
  results,
  running,
  error,
  onExport,
  onEdited,
  onDirty
}: {
  sessionId: string
  /** Changes with every run; edits applied in place keep it, so the view stays where it is. */
  runKey: number
  results: StatementResult[] | null
  running: boolean
  error: string | null
  onExport: (r: RowsResult) => void
  /** Rows of a result changed on the server; the caller keeps the new rows. */
  onEdited?: (index: number, rows: CellValue[][]) => void
  /** Whether edits are staged and not yet applied. */
  onDirty?: (dirty: boolean) => void
}) {
  const [idx, setIdx] = useState(0)
  const [selection, setSelection] = useState<CellPos | null>(null)
  const [inspector, setInspector] = useState(false)
  /** Staged cell edits per result index. */
  const [edits, setEdits] = useState<Map<number, Edits>>(new Map())
  const [applying, setApplying] = useState(false)
  const tables = useSession((s) => s.tables)
  const loadTable = useSession((s) => s.loadTable)
  const confirm = useStore((s) => s.confirm)
  const toast = useStore((s) => s.toast)

  useEffect(() => {
    if (!results) return
    const errIdx = results.findIndex((r) => r.kind === 'error')
    if (errIdx >= 0) setIdx(errIdx)
    else {
      let last = results.length - 1
      for (let i = results.length - 1; i >= 0; i--) {
        if (results[i].kind === 'rows') {
          last = i
          break
        }
      }
      setIdx(Math.max(0, last))
    }
    setSelection(null)
    setEdits(new Map())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey, results === null])

  const current = results && results.length ? results[Math.min(idx, results.length - 1)] : null
  const source = useMemo(() => (current?.kind === 'rows' ? editableSource(current.sql) : null), [current])

  // The table behind a single-table select is looked up once, so its keys and columns are known.
  useEffect(() => {
    if (source) void loadTable(source)
  }, [source, loadTable])

  const plan = useMemo<EditPlan | null>(() => {
    if (!current || current.kind !== 'rows' || !source) return null
    const t = tables[tableKey(source)]
    if (!t || t.status !== 'ready' || t.details.type === 'view') return null
    const details = t.details
    const names = current.columns.map((c) => c.name)
    const known = new Map(details.columns.map((c) => [c.name, c]))
    let keyFor: EditPlan['keyFor'] | null = null
    if (details.pk.length && details.pk.every((p) => names.includes(p))) {
      const idxs = details.pk.map((p) => names.indexOf(p))
      keyFor = (row) => ({ pk: Object.fromEntries(details.pk.map((p, i) => [p, row[idxs[i]]])) })
    } else if (details.rowidAlias && names.includes(details.rowidAlias)) {
      const alias = details.rowidAlias
      const ri = names.indexOf(alias)
      keyFor = (row) => ({ rowid: row[ri], alias })
    }
    if (!keyFor) return null
    const columns: GridColumn[] = current.columns.map((c) => {
      const col = known.get(c.name)
      return { name: c.name, declType: c.declType, inferred: c.inferred, pk: Boolean(col && col.pk > 0), readOnly: !col || col.hidden >= 2 }
    })
    return { table: { schema: details.schema, name: details.name }, columns, keyFor }
  }, [current, source, tables])

  const pending = edits.get(idx)
  const pendingCount = pending?.size ?? 0
  const totalPending = useMemo(() => [...edits.values()].reduce((n, m) => n + m.size, 0), [edits])
  useEffect(() => {
    onDirty?.(totalPending > 0)
  }, [totalPending, onDirty])

  const onEdit = (row: number, column: string, value: CellValue) => {
    if (!current || current.kind !== 'rows') return
    const ci = current.columns.findIndex((c) => c.name === column)
    const original = current.rows[row][ci]
    setEdits((all) => {
      const next = new Map(all)
      const mine = new Map(next.get(idx) ?? [])
      const cur = { ...(mine.get(row) ?? {}) }
      if (valuesEqual(original, value)) delete cur[column]
      else cur[column] = value
      if (Object.keys(cur).length) mine.set(row, cur)
      else mine.delete(row)
      if (mine.size) next.set(idx, mine)
      else next.delete(idx)
      return next
    })
  }

  const discard = () => {
    setEdits((all) => {
      const next = new Map(all)
      next.delete(idx)
      return next
    })
  }

  const apply = async () => {
    if (!current || current.kind !== 'rows' || !plan || !pending?.size) return
    const changes: PendingChange[] = [...pending].map(([row, values]) => ({ type: 'update', table: plan.table.name, schema: plan.table.schema, key: plan.keyFor(current.rows[row]), values }))
    const label = plan.table.schema ? `${plan.table.schema}.${plan.table.name}` : plan.table.name
    const ok = await confirm(`Apply ${changes.length} update${changes.length === 1 ? '' : 's'} to "${label}"?`, 'The changes run inside one transaction on the database.', 'Apply')
    if (!ok) return
    setApplying(true)
    try {
      const n = await window.api.db.apply(sessionId, changes)
      toast('success', `Applied ${n} change${n === 1 ? '' : 's'} to ${label}`)
      const names = current.columns.map((c) => c.name)
      const rows = current.rows.map((r, i) => {
        const upd = pending.get(i)
        return upd ? r.map((v, ci) => (names[ci] in upd ? upd[names[ci]] : v)) : r
      })
      discard()
      onEdited?.(idx, rows)
    } catch (e) {
      toast('error', 'Changes were not applied', errorMessage(e))
    } finally {
      setApplying(false)
    }
  }

  if (error) {
    return (
      <div className="results">
        <div className="result-message result-error">
          <strong>Error</strong>
          <pre>{error}</pre>
        </div>
      </div>
    )
  }
  if (!results) {
    return (
      <div className="results">
        <div className="placeholder">{running ? <span className="spinner" /> : <Icon name="play" />} {running ? 'Running…' : 'Results will appear here'}</div>
      </div>
    )
  }
  if (results.length === 0 || !current) {
    return (
      <div className="results">
        <div className="placeholder">Nothing to run</div>
      </div>
    )
  }
  const totalMs = results.reduce((s, r) => s + (r.durationMs ?? 0), 0)
  const gridColumns: GridColumn[] = plan?.columns ?? (current.kind === 'rows' ? current.columns.map((c) => ({ name: c.name, declType: c.declType, inferred: c.inferred })) : [])
  const selectedColumn = current.kind === 'rows' && selection ? gridColumns[selection.col] : null

  return (
    <div className="results" data-testid="results">
      <div className="result-chips">
        {results.map((r, i) => (
          <button key={i} className={`chip ${i === idx ? 'active' : ''} ${r.kind === 'error' ? 'error' : ''}`} onClick={() => setIdx(i)} title={r.sql}>
            <span className="n">{i + 1}</span>
            {chipLabel(r)}
            {edits.get(i)?.size ? <span className="chip-dot" title="Has staged edits" /> : null}
          </button>
        ))}
        <span className="spacer" style={{ flex: 1 }} />
        {pendingCount > 0 ? (
          <>
            <button className="btn small success" onClick={() => void apply()} disabled={applying} data-testid="results-apply">
              {applying ? <span className="spinner" /> : <Icon name="check" />} Apply {pendingCount}
            </button>
            <button className="btn small" onClick={discard} disabled={applying} data-testid="results-discard">
              Discard
            </button>
          </>
        ) : (
          <span className="muted" style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            {results.length} statement{results.length === 1 ? '' : 's'} · {formatDuration(totalMs)}
          </span>
        )}
        {current.kind === 'rows' ? (
          <>
            <button className="btn ghost icon small" title="Export this result" onClick={() => onExport(current)}>
              <Icon name="download" />
            </button>
            <button className={`btn ghost icon small ${inspector ? 'active' : ''}`} title="Toggle cell inspector" onClick={() => setInspector((v) => !v)}>
              <Icon name="panel" />
            </button>
          </>
        ) : null}
      </div>
      {current.kind === 'rows' ? (
        <div className="grid-area">
          <DataGrid
            columns={gridColumns}
            rows={current.rows}
            editable={Boolean(plan)}
            pendingUpdates={pending}
            selection={selection}
            onSelect={setSelection}
            onEdit={plan ? onEdit : undefined}
            onActivate={() => setInspector(true)}
            emptyMessage="Query returned no rows"
            testId="result-grid"
          />
          {inspector ? (
            <CellInspector
              column={selectedColumn}
              value={selection ? (pending?.get(selection.row)?.[selectedColumn?.name ?? ''] ?? current.rows[selection.row]?.[selection.col]) : undefined}
              editable={Boolean(plan) && Boolean(selectedColumn) && !selectedColumn?.readOnly}
              onStage={plan && selection && selectedColumn ? (v) => onEdit(selection.row, selectedColumn.name, v) : undefined}
              onClose={() => setInspector(false)}
              rowLabel={selection ? `#${selection.row + 1}` : undefined}
            />
          ) : null}
        </div>
      ) : current.kind === 'exec' ? (
        <div className="result-message" data-testid="exec-message">
          <div>
            <strong>{current.changes > 0 ? `${formatNumber(current.changes)} row${current.changes === 1 ? '' : 's'} affected` : 'Statement executed'}</strong>{' '}
            <span className="muted">in {formatDuration(current.durationMs)}</span>
          </div>
          {current.lastRowId && /^\s*insert/i.test(current.sql) ? <div className="muted">Last inserted rowid: {current.lastRowId}</div> : null}
          <pre>{current.sql}</pre>
        </div>
      ) : (
        <div className="result-message result-error" data-testid="error-message">
          <div>
            <strong>Error:</strong> {current.message}
          </div>
          <pre>{current.sql}</pre>
        </div>
      )}
      {current.kind === 'rows' && current.truncated ? (
        <div className="banner info">Showing the first {formatNumber(current.rowCount)} rows. Raise the row limit in the toolbar to fetch more.</div>
      ) : null}
    </div>
  )
}
