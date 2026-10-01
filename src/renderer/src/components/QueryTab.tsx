import { useEffect, useMemo, useRef, useState } from 'react'
import type { RowsResult, StatementResult } from '@shared/types'
import { tableKey } from '@shared/connections'
import type { TableRef } from '@shared/types'
import type { CompletionData, TableEntry } from '@/lib/sql-complete'
import { codeFontFamily } from '@/lib/theme'
import { PaneHeader, PaneLayout, type DragHandleProps } from './PaneLayout'
import { defaultLayout, moveLeaf, setRatio, type PaneId } from '@/lib/layout'
import { registerQueryTab, useStore, type Tab } from '@/store'
import { takeRunOnOpen, useSession, useSessionStore, wantsRunOnOpen, type SessionState, type SessionStore } from '@/session-store'
import { SqlEditor, type SqlEditorHandle } from './SqlEditor'
import { ResultsView } from './ResultsView'
import { Splitter } from './Splitter'
import { Icon } from './Icons'
import { REFRESH_EVENT } from '@/screens/Workspace'
import { errorMessage, formatDuration, formatNumber, modKey } from '@/lib/util'

const LIMITS = [200, 1000, 5000, 20000]
/** Results bigger than this are not kept between launches; the query text still is. */
const SNAPSHOT_RESULT_BYTES = 1_500_000

/** Column names of a table, fetching them through the store when they are not cached yet. */
async function loadColumnsFor(store: SessionStore, ref: TableRef): Promise<string[]> {
  const key = tableKey(ref)
  const names = (state: SessionState) => {
    const t = state.tables[key]
    return t?.status === 'ready' ? t.details.columns.map((c) => c.name) : t?.status === 'loading' ? null : []
  }
  await store.getState().loadTable(ref)
  const now = names(store.getState())
  if (now !== null) return now
  // Another caller is fetching it; wait for the store to settle.
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsub()
      resolve([])
    }, 10_000)
    const unsub = store.subscribe((state) => {
      const cols = names(state)
      if (cols === null) return
      clearTimeout(timer)
      unsub()
      resolve(cols)
    })
  })
}

export function QueryTab({ tab, active }: { tab: Extract<Tab, { kind: 'query' }>; active: boolean }) {
  const session = useSession((s) => s.session)!
  const store = useSessionStore()
  const catalog = useSession((s) => s.catalog)
  const names = useSession((s) => s.names)
  const refreshSchema = useSession((s) => s.refreshSchema)
  const setStatus = useSession((s) => s.setStatus)
  const setInTransaction = useSession((s) => s.setInTransaction)
  const updateQuerySnapshot = useSession((s) => s.updateQuerySnapshot)
  const setTabDirty = useSession((s) => s.setTabDirty)
  const toast = useStore((s) => s.toast)
  const confirm = useStore((s) => s.confirm)
  const layout = useStore((s) => s.queryLayout)
  const setLayout = useStore((s) => s.setQueryLayout)
  const ui = useStore((s) => s.ui)

  const editorRef = useRef<SqlEditorHandle>(null)
  /** What this tab held when the app last ran, if it is being brought back. Read once, when the tab mounts. */
  const [snapshot] = useState(() => store.getState().querySnapshots[tab.id])
  /** Current editor text, so the editor survives being moved to another pane. */
  const sqlRef = useRef(snapshot?.sql ?? tab.initialSql)
  const [results, setResults] = useState<StatementResult[] | null>(snapshot?.lastRun?.results ?? null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(snapshot?.lastRun?.error ?? null)
  const [maxRows, setMaxRows] = useState(snapshot?.limit ?? 1000)
  const resultsDirty = useRef(false)
  /** Counts runs, so the results view can tell a new run from rows edited in place. */
  const [runKey, setRunKey] = useState(0)
  const [lastRun, setLastRun] = useState<{ ms: number; statements: number; restored?: boolean; dropped?: boolean } | null>(
    snapshot?.lastRun ? { ms: snapshot.lastRun.ms, statements: snapshot.lastRun.statements, restored: true, dropped: Boolean(snapshot.lastRun.resultsDropped) } : null
  )
  const hidden = useMemo(() => new Set<PaneId>(), [])

  // The snapshot follows the tab: text as it is typed and the row limit.
  useEffect(() => {
    if (!snapshot) updateQuerySnapshot(tab.id, { sql: sqlRef.current, limit: maxRows })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    updateQuerySnapshot(tab.id, { limit: maxRows })
  }, [maxRows, tab.id, updateQuerySnapshot])

  useEffect(() => {
    if (active) requestAnimationFrame(() => editorRef.current?.focus())
  }, [active])

  // Autocomplete: every table name from the index, columns fetched the first time a table is referenced.
  const completion = useMemo<CompletionData | undefined>(() => {
    if (!catalog) return undefined
    const tables: TableEntry[] = names.entries.map((e) => ({ schema: e.obj.schema, name: e.obj.name, kind: e.obj.kind === 'view' ? 'view' : 'table' }))
    return {
      tables,
      defaultSchema: catalog.kind === 'postgres' ? (catalog.defaultSchema ?? 'public') : undefined,
      columnsFor: (t) => {
        const cached = store.getState().tables[tableKey({ schema: t.schema, name: t.name })]
        return cached?.status === 'ready' ? cached.details.columns.map((c) => c.name) : undefined
      },
      loadColumns: (t) => loadColumnsFor(store, { schema: t.schema, name: t.name })
    }
  }, [catalog, names, store])

  /**
   * Runs the selection when there is one, otherwise the block of lines the cursor is in; blank lines
   * separate blocks, and a trailing semicolon is optional. `all` runs the whole editor.
   */
  const run = async (sqlOverride?: string, all = false) => {
    if (running) return
    const ed = editorRef.current
    if (!ed) return
    const selected = sqlOverride ? '' : ed.getSelection()
    const text = sqlOverride ?? (all ? ed.getValue() : selected.trim() ? selected : ed.getBlockAtCursor())
    if (!text.trim()) return
    if (resultsDirty.current) {
      const ok = await confirm('Discard staged edits?', 'Edits staged in the results have not been applied to the database.', 'Discard', true)
      if (!ok) return
    }
    setRunning(true)
    setError(null)
    const t0 = performance.now()
    try {
      const res = await window.api.db.query(session.sessionId, text, [], maxRows)
      const ms = performance.now() - t0
      setResults(res.results)
      setRunKey((k) => k + 1)
      setInTransaction(res.tx)
      setLastRun({ ms, statements: res.results.length })
      const keep = JSON.stringify(res.results).length <= SNAPSHOT_RESULT_BYTES
      updateQuerySnapshot(tab.id, {
        sql: sqlRef.current,
        limit: maxRows,
        lastRun: { sql: text, at: Date.now(), ms, statements: res.results.length, results: keep ? res.results : null, error: null, resultsDropped: !keep }
      })
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
      setRunKey((k) => k + 1)
      updateQuerySnapshot(tab.id, { sql: sqlRef.current, limit: maxRows, lastRun: { sql: text, at: Date.now(), ms: performance.now() - t0, statements: 0, results: null, error: errorMessage(e) } })
    } finally {
      setRunning(false)
    }
  }

  const stop = () => {
    void window.api.db.cancel(session.sessionId)
  }

  // The chat beside the connections puts its queries in this editor while the tab is in front.
  const runRef = useRef(run)
  runRef.current = run
  useEffect(
    () =>
      registerQueryTab(tab.id, {
        setSql: (sql) => {
          sqlRef.current = sql
          editorRef.current?.setValue(sql)
        },
        run: (sql) => void runRef.current(sql)
      }),
    [tab.id]
  )

  // A tab opened to run its query, as from the chat's "Run in" another database, runs it once the editor is up.
  useEffect(() => {
    if (!wantsRunOnOpen(tab.id)) return
    const frame = requestAnimationFrame(() => {
      if (takeRunOnOpen(tab.id)) void run(tab.initialSql)
    })
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  const renderPane = (id: PaneId, handle: DragHandleProps) => {
    if (id === 'editor') {
      return (
        <div className="pane" data-testid="pane-editor">
          <PaneHeader title="SQL" handle={handle} testId="editor-header" />
          <div className="pane-body editor-wrap">
            <SqlEditor
              ref={editorRef}
              initialValue={sqlRef.current}
              onChange={(v) => {
                sqlRef.current = v
                // Straight into the store: a quit right after typing must not lose the last words.
                updateQuerySnapshot(tab.id, { sql: v })
              }}
              onRun={() => void run()}
              onRunAll={() => void run(undefined, true)}
              completion={completion}
              prefs={{ keywordCase: ui.keywordCase, autocomplete: ui.autocomplete, autoAlias: ui.autoAlias, acceptKeys: ui.acceptKeys }}
              fontFamily={codeFontFamily(ui.codeFont)}
              dialect={session.kind}
              placeholder="SELECT * FROM …"
            />
          </div>
        </div>
      )
    }
    if (id === 'results') {
      return (
        <div className="pane" data-testid="pane-results">
          <PaneHeader title="Results" handle={handle} testId="results-header" />
          <div className="pane-body">
            <ResultsView
              sessionId={session.sessionId}
              runKey={runKey}
              results={results}
              running={running}
              error={error}
              onExport={(r) => void exportResult(r)}
              onEdited={(index, rows) => {
                setResults((prev) => {
                  if (!prev) return prev
                  const next = prev.map((r, i) => (i === index && r.kind === 'rows' ? { ...r, rows } : r))
                  const keep = JSON.stringify(next).length <= SNAPSHOT_RESULT_BYTES
                  const snap = store.getState().querySnapshots[tab.id]?.lastRun
                  if (snap) updateQuerySnapshot(tab.id, { lastRun: { ...snap, results: keep ? next : null, resultsDropped: !keep } })
                  return next
                })
              }}
              onDirty={(dirty) => {
                resultsDirty.current = dirty
                setTabDirty(tab.id, dirty)
              }}
            />
          </div>
        </div>
      )
    }
    return null
  }

  return (
    <div className="query-tab" data-runs={runKey}>
      <div className="toolbar">
        {running ? (
          <button className="btn small danger" onClick={stop} data-testid="stop-button">
            <Icon name="stop" /> Stop
          </button>
        ) : (
          <button
            className="btn small"
            onClick={() => void run()}
            title={`Run the statement block at the cursor (${modKey}↩). A selection runs on its own; ${modKey}⇧↩ runs everything.`}
            data-testid="run-button"
          >
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
            {lastRun.restored ? (lastRun.dropped ? ' · results from last time were too large to keep; run again' : ' · from last time') : ''}
          </span>
        ) : null}
        <button className="btn ghost icon small" onClick={() => setLayout(defaultLayout())} title="Reset the pane layout" data-testid="layout-reset">
          <Icon name="layout" />
        </button>
      </div>
      {running ? <div className="loading-bar" /> : null}
      <div className="query-body">
        <PaneLayout layout={layout} hidden={hidden} render={renderPane} onRatio={(path, ratio) => setLayout(setRatio(layout, path, ratio))} onMove={(id, target, side) => setLayout(moveLeaf(layout, id, target, side))} />
      </div>
    </div>
  )
}
