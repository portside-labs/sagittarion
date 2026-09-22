import { useEffect, useMemo, useRef, useState } from 'react'
import type { RowsResult, StatementResult } from '@shared/types'
import type { AiResult, AiTurn } from '@shared/ai'
import { AI_PRESETS } from '@shared/ai'
import { useStore, type Tab } from '@/store'
import { SqlEditor, type SqlEditorHandle } from './SqlEditor'
import { ResultsView } from './ResultsView'
import { Splitter } from './Splitter'
import { Icon } from './Icons'
import { REFRESH_EVENT } from '@/screens/Workspace'
import { clamp, errorMessage, formatDuration, formatNumber, modKey } from '@/lib/util'

const LIMITS = [200, 1000, 5000, 20000]

function formatTokens(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export function QueryTab({ tab, active }: { tab: Extract<Tab, { kind: 'query' }>; active: boolean }) {
  const session = useStore((s) => s.session)!
  const schema = useStore((s) => s.schema)
  const refreshSchema = useStore((s) => s.refreshSchema)
  const setStatus = useStore((s) => s.setStatus)
  const setInTransaction = useStore((s) => s.setInTransaction)
  const toast = useStore((s) => s.toast)
  const settings = useStore((s) => s.settings)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)

  const editorRef = useRef<SqlEditorHandle>(null)
  const [results, setResults] = useState<StatementResult[] | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [maxRows, setMaxRows] = useState(1000)
  const [editorHeight, setEditorHeight] = useState(() => Number(localStorage.getItem('editorHeight')) || 220)
  const [lastRun, setLastRun] = useState<{ ms: number; statements: number } | null>(null)
  const [ask, setAsk] = useState('')
  const [asking, setAsking] = useState(false)
  const [ai, setAi] = useState<AiResult | null>(null)
  const [history, setHistory] = useState<AiTurn[]>([])

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

  const preset = settings ? AI_PRESETS[settings.provider] : null
  const providerReady = Boolean(settings && preset && (settings.hasKey || !preset.needsKey) && settings.model)

  const askQuestion = async () => {
    const question = ask.trim()
    if (!question || asking) return
    if (!providerReady) {
      toast('info', 'Set up a language model first', 'Plain-English questions are answered by a provider of your choice with your own key. Open Settings to pick one.')
      setSettingsOpen(true)
      return
    }
    setAsking(true)
    setAi(null)
    try {
      const res = await window.api.ai.ask(session.sessionId, question, history)
      setAi(res)
      if (res.kind === 'query') {
        editorRef.current?.setValue(res.sql)
        setHistory((h) => [...h, { question, sql: res.sql }].slice(-6))
        setAsk('')
        const u = res.usage
        setStatus(`${u.model} · ${u.requests} request${u.requests === 1 ? '' : 's'} · ${formatTokens(u.inputTokens)} in / ${formatTokens(u.outputTokens)} out${u.cachedInputTokens ? ` (${formatTokens(u.cachedInputTokens)} cached)` : ''}`)
        if (res.autoRun) void run(res.sql)
      }
    } catch (e) {
      toast('error', 'Could not build a query', errorMessage(e))
    } finally {
      setAsking(false)
    }
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
      <div className="ask-bar">
        <Icon className="ask-icon" name="sparkles" />
        <input
          className="text"
          placeholder={history.length ? 'Ask a follow-up, or a new question…' : 'Ask in plain English, e.g. "top 10 customers by revenue last quarter" or "orders with no invoice"'}
          value={ask}
          onChange={(e) => setAsk(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void askQuestion()
          }}
          disabled={asking}
          data-testid="ask-input"
        />
        <button className="btn small primary" onClick={() => void askQuestion()} disabled={asking || !ask.trim()} data-testid="ask-button">
          {asking ? <span className="spinner" /> : <Icon name="sparkles" />} Build query
        </button>
        {!providerReady ? (
          <button className="btn small ghost" onClick={() => setSettingsOpen(true)} title="Plain-English questions need a language model provider" data-testid="ask-needs-key">
            <Icon name="settings" /> Set up provider
          </button>
        ) : history.length ? (
          <button className="btn small ghost" onClick={() => setHistory([])} title="Forget earlier questions in this tab so the next one starts fresh" data-testid="ask-reset">
            <Icon name="x" size={12} /> New topic
          </button>
        ) : null}
      </div>
      {ai ? (
        <div className={`ask-result ${ai.kind}`} data-testid="ask-result">
          {ai.kind === 'clarify' ? (
            <span className="ask-message">{ai.message}</span>
          ) : (
            <>
              <span className={`ask-badge ${ai.checks.explained ? 'ok' : 'warn'}`} title="Read-only was enforced by the database and the query plan was checked before running">
                {ai.checks.explained ? 'verified read-only' : 'read-only'}
                {ai.checks.repairs ? ` · fixed ${ai.checks.repairs}×` : ''}
                {ai.autoRun ? ' · ran automatically' : ' · review before running'}
              </span>
              <span className="ask-message">{ai.explanation}</span>
              {ai.tablesUsed.map((t) => (
                <span key={t} className="ask-chip">
                  <strong>{t}</strong>
                </span>
              ))}
              {ai.assumptions.map((a) => (
                <span key={a} className="ask-chip warn" title={a}>
                  {a}
                </span>
              ))}
              <span className="spacer" />
              <span className="muted small" title={`Schema context: ${ai.context.mode === 'all' ? 'all tables' : `${ai.context.tables} of ${ai.context.totalTables} tables`} (~${formatTokens(ai.context.schemaTokens)} tokens)`}>
                {ai.context.mode === 'all' ? `${ai.context.totalTables} tables` : `${ai.context.tables}/${ai.context.totalTables} tables`} · {formatTokens(ai.usage.inputTokens + ai.usage.outputTokens)} tokens
              </span>
              {!ai.autoRun ? (
                <button className="btn small success" onClick={() => void run()} disabled={running} data-testid="ask-run">
                  <Icon name="play" /> Run it
                </button>
              ) : null}
            </>
          )}
          <button className="btn ghost icon small" onClick={() => setAi(null)} title="Dismiss">
            <Icon name="x" size={12} />
          </button>
        </div>
      ) : null}
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
      <Splitter direction="horizontal" onResize={(dy) => setEditorHeight((h) => clamp(h + dy, 80, window.innerHeight - 300))} />
      <ResultsView results={results} running={running} error={error} onExport={(r) => void exportResult(r)} />
    </div>
  )
}
