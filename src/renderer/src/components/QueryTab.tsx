import { useEffect, useMemo, useRef, useState } from 'react'
import type { RowsResult, StatementResult } from '@shared/types'
import { useStore, type Tab } from '@/store'
import { SqlEditor, type SqlEditorHandle } from './SqlEditor'
import { ResultsView } from './ResultsView'
import { Splitter } from './Splitter'
import { Icon } from './Icons'
import { REFRESH_EVENT } from '@/screens/Workspace'
import { clamp, errorMessage, formatDuration, formatNumber, modKey } from '@/lib/util'

const LIMITS = [200, 1000, 5000, 20000]

export function QueryTab({ tab, active }: { tab: Extract<Tab, { kind: 'query' }>; active: boolean }) {
  const session = useStore((s) => s.session)!
  const schema = useStore((s) => s.schema)
  const refreshSchema = useStore((s) => s.refreshSchema)
  const setStatus = useStore((s) => s.setStatus)
  const setInTransaction = useStore((s) => s.setInTransaction)
  const toast = useStore((s) => s.toast)

  const editorRef = useRef<SqlEditorHandle>(null)
  const [results, setResults] = useState<StatementResult[] | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [maxRows, setMaxRows] = useState(1000)
  const [editorHeight, setEditorHeight] = useState(() => Number(localStorage.getItem('editorHeight')) || 220)
  const [lastRun, setLastRun] = useState<{ ms: number; statements: number } | null>(null)

  useEffect(() => {
    localStorage.setItem('editorHeight', String(editorHeight))
  }, [editorHeight])

  useEffect(() => {
    if (active) requestAnimationFrame(() => editorRef.current?.focus())
  }, [active])

  const schemaMap = useMemo(() => {
    if (!schema) return undefined
    if (schema.kind === 'postgres') {
      const m: Record<string, Record<string, string[]>> = {}
      for (const t of [...schema.tables, ...schema.views]) {
        const s = t.schema ?? schema.defaultSchema ?? 'public'
        ;(m[s] ??= {})[t.name] = t.columns.map((c) => c.name)
      }
      return m
    }
    const m: Record<string, string[]> = {}
    for (const t of [...schema.tables, ...schema.views]) m[t.name] = t.columns.map((c) => c.name)
    return m
  }, [schema])

  const run = async () => {
    if (running) return
    const ed = editorRef.current
    if (!ed) return
    const selected = ed.getSelection()
    const text = selected.trim() ? selected : ed.getValue()
    if (!text.trim()) return
    setRunning(true)
    setError(null)
    const t0 = performance.now()
    try {
      const res = await window.api.db.query(session.sessionId, text, [], maxRows)
      const ms = performance.now() - t0
      setResults(res.results)
      setInTransaction(res.tx)
      setLastRun({ ms, statements: res.results.length })
      const errors = res.results.filter((r) => r.kind === 'error').length
      const rowsRes = res.results.filter((r): r is RowsResult => r.kind === 'rows')
      setStatus(
        errors
          ? `Query failed after ${formatDuration(ms)}`
          : rowsRes.length
            ? `${formatNumber(rowsRes.reduce((s, r) => s + r.rowCount, 0))} rows in ${formatDuration(ms)}`
            : `Done in ${formatDuration(ms)}`
      )
      if (/\b(create|drop|alter)\b/i.test(text) && !errors) void refreshSchema()
    } catch (e) {
      setError(errorMessage(e))
      setResults(null)
    } finally {
      setRunning(false)
    }
  }

  const stop = () => {
    void window.api.db.cancel(session.sessionId)
  }

  useEffect(() => {
    const handler = (e: Event) => {
      if ((e as CustomEvent).detail === tab.id) void run()
    }
    window.addEventListener(REFRESH_EVENT, handler)
    return () => window.removeEventListener(REFRESH_EVENT, handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, running, maxRows])

  const exportResult = async (r: RowsResult) => {
    try {
      const res = await window.api.exportData({
        format: 'csv',
        columns: r.columns.map((c) => c.name),
        rows: r.rows,
        suggestedName: 'query-result'
      })
      if (res.saved) toast('success', `Exported ${formatNumber(r.rows.length)} rows`, res.path)
    } catch (e) {
      toast('error', 'Export failed', errorMessage(e))
    }
  }

  return (
    <div className="query-tab">
      <div className="toolbar">
        {running ? (
          <button className="btn small danger" onClick={stop} data-testid="stop-button">
            <Icon name="stop" /> Stop
          </button>
        ) : (
          <button className="btn small primary" onClick={() => void run()} title={`Run (${modKey}↩). With a selection, runs only the selected text.`} data-testid="run-button">
            <Icon name="play" /> Run <span className="kbd">{modKey}↩</span>
          </button>
        )}
        <select className="select" style={{ width: 'auto', height: 26 }} value={maxRows} onChange={(e) => setMaxRows(Number(e.target.value))} title="Maximum rows to fetch per statement">
          {LIMITS.map((n) => (
            <option key={n} value={n}>
              Limit {formatNumber(n)}
            </option>
          ))}
        </select>
        <span className="spacer" />
        {lastRun ? (
          <span className="muted">
            {lastRun.statements} statement{lastRun.statements === 1 ? '' : 's'} · {formatDuration(lastRun.ms)} round trip
          </span>
        ) : null}
      </div>
      {running ? <div className="loading-bar" /> : null}
      <div className="editor-wrap" style={{ height: editorHeight }}>
        <SqlEditor
          ref={editorRef}
          initialValue={tab.initialSql}
          onRun={() => void run()}
          schema={schemaMap}
          defaultSchema={schema?.kind === 'postgres' ? schema.defaultSchema ?? 'public' : undefined}
          dialect={session.kind}
          placeholder="SELECT * FROM …"
        />
      </div>
      <Splitter direction="horizontal" onResize={(dy) => setEditorHeight((h) => clamp(h + dy, 80, window.innerHeight - 260))} />
      <ResultsView results={results} running={running} error={error} onExport={(r) => void exportResult(r)} />
    </div>
  )
}
