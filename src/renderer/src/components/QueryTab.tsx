import { useEffect, useMemo, useRef, useState } from 'react'
import type { QueryTabSnapshot, RowsResult, StatementResult } from '@shared/types'
import { tableKey } from '@shared/connections'
import type { TableRef } from '@shared/types'
import type { CompletionData, TableEntry } from '@/lib/sql-complete'
import { AskPanel, emptyChat, type ChatMessage, type ChatState } from './AskPanel'
import { PaneHeader, PaneLayout, type DragHandleProps } from './PaneLayout'
import { defaultLayout, moveLeaf, setRatio, type PaneId } from '@/lib/layout'
import { useStore, type Tab } from '@/store'
import { useSession, useSessionStore, type SessionState, type SessionStore } from '@/session-store'
import { SqlEditor, type SqlEditorHandle } from './SqlEditor'
import { ResultsView } from './ResultsView'
import { Splitter } from './Splitter'
import { Icon } from './Icons'
import { REFRESH_EVENT } from '@/screens/Workspace'
import { errorMessage, formatDuration, formatNumber, modKey } from '@/lib/util'

const LIMITS = [200, 1000, 5000, 20000]
/** Results bigger than this are not kept between launches; the query text still is. */
const SNAPSHOT_RESULT_BYTES = 1_500_000

/** A saved chat, with anything that was still running marked as cut short. */
function restoreChat(saved: QueryTabSnapshot['chat'] | undefined): ChatState {
  if (!saved) return emptyChat()
  const messages = (saved.messages as ChatMessage[]).map((m) =>
    m.role === 'assistant' && m.status === 'working' ? { ...m, status: 'done' as const, error: m.error ?? 'The app was closed before this finished.' } : m
  )
  return { messages, input: saved.input ?? '', requestId: null }
}

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
  const toast = useStore((s) => s.toast)
  const layout = useStore((s) => s.queryLayout)
  const setLayout = useStore((s) => s.setQueryLayout)
  const chatOpen = useStore((s) => s.chatOpen)
  const setChatOpen = useStore((s) => s.setChatOpen)

  const editorRef = useRef<SqlEditorHandle>(null)
  /** What this tab held when the app last ran, if it is being brought back. Read once, when the tab mounts. */
  const [snapshot] = useState(() => store.getState().querySnapshots[tab.id])
  /** Current editor text, so the editor survives being moved to another pane. */
  const sqlRef = useRef(snapshot?.sql ?? tab.initialSql)
  const [chat, setChatState] = useState<ChatState>(() => restoreChat(snapshot?.chat))
  const setChat = (update: (c: ChatState) => ChatState) => setChatState(update)
  const [results, setResults] = useState<StatementResult[] | null>(snapshot?.lastRun?.results ?? null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(snapshot?.lastRun?.error ?? null)
  const [maxRows, setMaxRows] = useState(snapshot?.limit ?? 1000)
  const [lastRun, setLastRun] = useState<{ ms: number; statements: number; restored?: boolean; dropped?: boolean } | null>(
    snapshot?.lastRun ? { ms: snapshot.lastRun.ms, statements: snapshot.lastRun.statements, restored: true, dropped: Boolean(snapshot.lastRun.resultsDropped) } : null
  )
  const hidden = useMemo(() => new Set<PaneId>(chatOpen ? [] : ['chat']), [chatOpen])

  // The snapshot follows the tab: text as it is typed, the row limit, and the chat.
  useEffect(() => {
    if (!snapshot) updateQuerySnapshot(tab.id, { sql: sqlRef.current, limit: maxRows })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    updateQuerySnapshot(tab.id, { limit: maxRows })
  }, [maxRows, tab.id, updateQuerySnapshot])
  useEffect(() => {
    updateQuerySnapshot(tab.id, { chat: { messages: chat.messages, input: chat.input } })
  }, [chat, tab.id, updateQuerySnapshot])

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

  const run = async (sqlOverride?: string) => {
    if (running) return
    const ed = editorRef.current
    if (!ed) return
    const selected = sqlOverride ? '' : ed.getSelection()
    const text = sqlOverride ?? (selected.trim() ? selected : ed.getValue())
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
      updateQuerySnapshot(tab.id, { sql: sqlRef.current, limit: maxRows, lastRun: { sql: text, at: Date.now(), ms: performance.now() - t0, statements: 0, results: null, error: errorMessage(e) } })
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
              completion={completion}
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
            <ResultsView results={results} running={running} error={error} onExport={(r) => void exportResult(r)} />
          </div>
        </div>
      )
    }
    return (
      <AskPanel
        sessionId={session.sessionId}
        chat={chat}
        setChat={setChat}
        handle={handle}
        running={running}
        onCollapse={() => setChatOpen(false)}
        onSql={(sql, runIt) => {
          sqlRef.current = sql
          editorRef.current?.setValue(sql)
          if (runIt) void run(sql)
        }}
      />
    )
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
            {lastRun.restored ? (lastRun.dropped ? ' · results from last time were too large to keep; run again' : ' · from last time') : ''}
          </span>
        ) : null}
        <button className="btn ghost icon small" onClick={() => setLayout(defaultLayout())} title="Reset the pane layout" data-testid="layout-reset">
          <Icon name="layout" />
        </button>
        <button className={`btn small ${chatOpen ? 'active' : 'ghost'}`} onClick={() => setChatOpen(!chatOpen)} title={chatOpen ? 'Hide the plain-English chat' : 'Ask in plain English'} data-testid="ask-toggle">
          <Icon name="chat" /> Ask
        </button>
      </div>
      {running ? <div className="loading-bar" /> : null}
      <div className="query-body">
        <PaneLayout layout={layout} hidden={hidden} render={renderPane} onRatio={(path, ratio) => setLayout(setRatio(layout, path, ratio))} onMove={(id, target, side) => setLayout(moveLeaf(layout, id, target, side))} />
        {!chatOpen ? (
          <button className="ask-strip" onClick={() => setChatOpen(true)} title="Ask in plain English" data-testid="ask-strip">
            <Icon name="chat" size={14} />
            <span className="ask-strip-label">Ask</span>
          </button>
        ) : null}
      </div>
    </div>
  )
}
