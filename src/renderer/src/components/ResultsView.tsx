import { useEffect, useState } from 'react'
import type { RowsResult, StatementResult } from '@shared/types'
import { DataGrid, type CellPos } from './DataGrid'
import { CellInspector } from './CellInspector'
import { Icon } from './Icons'
import { formatDuration, formatNumber } from '@/lib/util'

function chipLabel(r: StatementResult): string {
  if (r.kind === 'rows') return `${formatNumber(r.rowCount)}${r.truncated ? '+' : ''} row${r.rowCount === 1 && !r.truncated ? '' : 's'}`
  if (r.kind === 'exec') return r.changes > 0 ? `${formatNumber(r.changes)} changed` : 'ok'
  return 'error'
}

export function ResultsView({
  results,
  running,
  error,
  onExport
}: {
  results: StatementResult[] | null
  running: boolean
  error: string | null
  onExport: (r: RowsResult) => void
}) {
  const [idx, setIdx] = useState(0)
  const [selection, setSelection] = useState<CellPos | null>(null)
  const [inspector, setInspector] = useState(false)

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
  }, [results])

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
  if (results.length === 0) {
    return (
      <div className="results">
        <div className="placeholder">Nothing to run</div>
      </div>
    )
  }
  const current = results[Math.min(idx, results.length - 1)]
  const totalMs = results.reduce((s, r) => s + (r.durationMs ?? 0), 0)

  return (
    <div className="results" data-testid="results">
      <div className="result-chips">
        {results.map((r, i) => (
            <button key={i} className={`chip ${i === idx ? 'active' : ''} ${r.kind === 'error' ? 'error' : ''}`} onClick={() => setIdx(i)} title={r.sql}>
              <span className="n">{i + 1}</span>
              {chipLabel(r)}
            </button>
          ))}
        <span className="spacer" style={{ flex: 1 }} />
        <span className="muted" style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          {results.length} statement{results.length === 1 ? '' : 's'} · {formatDuration(totalMs)}
        </span>
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
            columns={current.columns.map((c) => ({ name: c.name, declType: c.declType, inferred: c.inferred }))}
            rows={current.rows}
            selection={selection}
            onSelect={setSelection}
            onActivate={() => setInspector(true)}
            emptyMessage="Query returned no rows"
            testId="result-grid"
          />
          {inspector ? (
            <CellInspector
              column={selection ? { name: current.columns[selection.col].name, declType: current.columns[selection.col].declType } : null}
              value={selection ? current.rows[selection.row]?.[selection.col] : undefined}
              editable={false}
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
