import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { AiProgressEvent, AiResult, AiTurn, CatalogModel } from '@shared/ai'
import { BYOK_PROVIDERS, LOCAL_PROVIDERS, MODEL_CATALOG, PROVIDERS, activeConnection, connectionReady, modelTitle, prettyModelName, vendorOf } from '@shared/ai'
import { describeCounts, type AiPrivacyReport } from '@shared/privacy'
import { useStore } from '@/store'
import { useSession } from '@/session-store'
import { SqlCode } from './SqlCode'
import { Icon } from './Icons'
import { PaneHeader, type DragHandleProps } from './PaneLayout'
import { ExchangeInspector } from './ExchangeInspector'
import { errorMessage } from '@/lib/util'

type Step = AiProgressEvent & { endedAt?: number }

/** A catalogue model as listed in the menu, tied to a saved connection when one offers it. */
type MenuModel = CatalogModel & { connectionId?: string; connectionName?: string }

export type ChatMessage =
  | { id: string; role: 'user'; text: string; ts: number }
  | {
      id: string
      role: 'assistant'
      question: string
      ts: number
      status: 'working' | 'done'
      steps: Step[]
      result?: AiResult
      error?: string
      stepsOpen?: boolean
      endedAt?: number
      /** The ask behind this answer, for "What was sent". Not kept across relaunches: that record lives in memory. */
      requestId?: string
    }

/** Conversation state lives in the query tab so the pane can be moved or hidden without losing it. */
export interface ChatState {
  messages: ChatMessage[]
  input: string
  requestId: string | null
  /** Scopes Local AI Privacy's placeholders to this chat. New for every chat and after a relaunch; never saved. */
  conversationId: string
}

export function emptyChat(): ChatState {
  return { messages: [], input: '', requestId: null, conversationId: crypto.randomUUID() }
}

/** "🔒 6 protected", with the kinds in the tooltip; opens what was sent and the values behind it. Nothing when the answer
 * was not protected. */
function privacyLink(p: AiPrivacyReport | undefined, onOpen?: () => void): ReactNode {
  if (!p?.protected) return null
  const n = Object.values(p.counts).reduce((sum, c) => sum + (c ?? 0), 0)
  const title = [
    n ? `Replaced with placeholders before sending: ${describeCounts(p.counts, 8)}.` : 'Nothing sensitive was found in what was sent.',
    `Checked again before each of ${p.requests} request${p.requests === 1 ? '' : 's'} to ${p.host}.`,
    p.restoration.restored ? `${p.restoration.restored} placeholder${p.restoration.restored === 1 ? '' : 's'} in the answer restored on this computer.` : '',
    p.policy ? `Policy: ${p.policy.id} v${p.policy.version}.` : '',
    onOpen ? 'Click to see exactly what was sent.' : ''
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <button type="button" className="ask-protected" title={title} onClick={onOpen} disabled={!onOpen} data-testid="ask-privacy">
      <Icon name="lock" size={12} />
      {n ? `${n} protected` : 'nothing to protect'}
    </button>
  )
}

export interface AskPanelProps {
  sessionId: string
  chat: ChatState
  setChat: (update: (c: ChatState) => ChatState) => void
  handle: DragHandleProps
  /** Puts generated SQL in the editor and optionally runs it. */
  onSql: (sql: string, run: boolean) => void
  running: boolean
  onCollapse: () => void
}

function formatTokens(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.max(0, Math.round(ms))}ms`
}

const EXAMPLES = ['top 10 customers by revenue last quarter', 'orders from this month with no invoice', 'how many users signed up per week this year']

/** The plain-English chat pane of a query tab. */
export function AskPanel({ sessionId, chat, setChat, handle, onSql, running, onCollapse }: AskPanelProps) {
  const settings = useStore((s) => s.settings)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const setStatus = useSession((s) => s.setStatus)
  const dialect = useSession((s) => s.session?.kind) ?? 'sqlite'
  const toast = useStore((s) => s.toast)

  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const loadSettings = useStore((s) => s.loadSettings)
  const [, tick] = useState(0)
  const [menuOpen, setMenuOpen] = useState(false)
  const [liveModels, setLiveModels] = useState<string[] | null>(null)
  const modelButtonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuScrolledRef = useRef(false)
  /** Where the open menu sits; it renders at the document root so no pane can clip it. */
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null)
  /** A model that needs a provider set up first, with the message shown above the input. */
  const [notice, setNotice] = useState<{ model: MenuModel; text: string } | null>(null)
  /** The ask whose exchange with the provider is open for inspection. */
  const [inspecting, setInspecting] = useState<string | null>(null)
  const { messages, input } = chat

  const asking = messages.some((m) => m.role === 'assistant' && m.status === 'working')
  const active = activeConnection(settings)
  const providerReady = Boolean(settings && active && connectionReady(active) && settings.activeModel)
  const lastAssistant = [...messages].reverse().find((m): m is Extract<ChatMessage, { role: 'assistant' }> => m.role === 'assistant')
  const awaitingReply = lastAssistant?.status === 'done' && lastAssistant.result?.kind === 'clarify'

  // Progress events for the ask in flight update the working message in place.
  useEffect(() => {
    return window.api.ai.onProgress((e) => {
      setChat((c) => {
        if (e.requestId !== c.requestId) return c
        return {
          ...c,
          messages: c.messages.map((m) => {
            if (m.role !== 'assistant' || m.status !== 'working') return m
            const i = m.steps.findIndex((s) => s.stepId === e.stepId)
            const steps = m.steps.slice()
            // A step that arrives finished (a note such as "Protected more values") took no time of its own.
            if (i < 0) steps.push(e.status === 'running' ? e : { ...e, endedAt: e.ts })
            else steps[i] = { ...steps[i], ...e, ts: steps[i].ts, endedAt: e.status === 'running' ? undefined : e.ts }
            return { ...m, steps }
          })
        }
      })
    })
  }, [setChat])

  // Keep elapsed times moving while a step runs.
  useEffect(() => {
    if (!asking) return
    const t = setInterval(() => tick((n) => n + 1), 500)
    return () => clearInterval(t)
  }, [asking])

  // A chat's placeholders stay in memory only while the chat is in use: forget them on reset or when the pane goes.
  const conversationId = chat.conversationId
  useEffect(() => () => void window.api.ai.forget(conversationId), [conversationId])

  // Follow the conversation.
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  // The box starts as one line and grows with the text up to a limit, then scrolls.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = '0px'
    const max = 160
    const next = Math.min(el.scrollHeight, max)
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
  }, [input])

  // Put the menu above the button, or below when there is more room there, never taller than that room.
  const placeMenu = useCallback(() => {
    const el = modelButtonRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const gap = 6
    const margin = 8
    const width = 280
    const above = r.top - gap - margin
    const below = window.innerHeight - r.bottom - gap - margin
    const flip = above < 240 && below > above
    const left = Math.max(margin, Math.min(r.left, window.innerWidth - width - margin))
    const maxHeight = Math.max(120, Math.min(360, flip ? below : above))
    setMenuStyle(flip ? { left, top: r.bottom + gap, width, maxHeight } : { left, bottom: window.innerHeight - r.top + gap, width, maxHeight })
  }, [])

  useLayoutEffect(() => {
    if (!menuOpen) {
      setMenuStyle(null)
      menuScrolledRef.current = false
      return
    }
    placeMenu()
    window.addEventListener('resize', placeMenu)
    return () => window.removeEventListener('resize', placeMenu)
  }, [menuOpen, placeMenu])

  // Bring the current model into view once the menu is on screen.
  useEffect(() => {
    if (!menuOpen || !menuStyle || menuScrolledRef.current) return
    menuScrolledRef.current = true
    menuRef.current?.querySelector('.model-item.current')?.scrollIntoView({ block: 'nearest' })
  }, [menuOpen, menuStyle])

  // Close the model menu on any outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.('.model-menu, .model-button')) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  // The configured provider's own list (e.g. models installed in Ollama) joins the catalogue.
  useEffect(() => {
    if (!menuOpen || liveModels !== null || !providerReady) return
    let cancelled = false
    window.api.settings
      .listModels()
      .then((list) => {
        if (!cancelled) setLiveModels(list)
      })
      .catch(() => {
        if (!cancelled) setLiveModels([])
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen])

  const menuModels = useMemo<MenuModel[]>(() => {
    if (!settings) return MODEL_CATALOG.map((m) => ({ ...m }))
    const out: MenuModel[] = []
    const seen = new Set<string>()
    const add = (m: MenuModel) => {
      const key = `${m.connectionId ?? m.provider}:${m.id}`
      if (seen.has(key)) return
      seen.add(key)
      out.push(m)
    }
    // Saved connections: their catalogue models, plus the active one's current model and whatever it lists.
    for (const c of settings.connections) {
      for (const m of MODEL_CATALOG) if (m.provider === c.provider) add({ ...m, connectionId: c.id, connectionName: c.name })
      if (c.id !== settings.activeConnectionId) continue
      if (settings.activeModel) add({ provider: c.provider, vendor: vendorOf(settings.activeModel), id: settings.activeModel, label: modelTitle(c.provider, settings.activeModel), connectionId: c.id, connectionName: c.name })
      for (const id of liveModels ?? []) add({ provider: c.provider, vendor: vendorOf(id), id, label: modelTitle(c.provider, id), connectionId: c.id, connectionName: c.name })
    }
    // Providers with no connection yet still show their models, with a way to set them up.
    for (const m of MODEL_CATALOG) if (!settings.connections.some((c) => c.provider === m.provider)) add({ ...m })
    return out
  }, [settings, liveModels])

  /** Menu sections: one per saved connection, then providers that are not set up. */
  const menuGroups = useMemo(() => {
    const groups: { key: string; title: string; note?: string; items: MenuModel[] }[] = []
    for (const c of settings?.connections ?? []) {
      const items = menuModels.filter((m) => m.connectionId === c.id)
      if (items.length) groups.push({ key: c.id, title: c.name, note: connectionReady(c) ? undefined : 'not set up', items })
    }
    for (const p of [...BYOK_PROVIDERS, ...LOCAL_PROVIDERS]) {
      if (settings?.connections.some((c) => c.provider === p)) continue
      const items = menuModels.filter((m) => !m.connectionId && m.provider === p)
      if (items.length) groups.push({ key: p, title: PROVIDERS[p].label, note: 'not set up', items })
    }
    return groups
  }, [menuModels, settings])

  const chooseModel = async (m: MenuModel) => {
    setMenuOpen(false)
    if (!settings) return
    const conn = m.connectionId ? settings.connections.find((c) => c.id === m.connectionId) : undefined
    if (!conn || !connectionReady(conn)) {
      const preset = PROVIDERS[m.provider]
      const needs = preset.needsKey ? `${preset.label} API key` : `${preset.label} server details`
      setNotice({ model: m, text: `${m.label} needs ${/^[aeiou]/i.test(needs) ? 'an' : 'a'} ${needs} before it can answer.` })
      return
    }
    setNotice(null)
    try {
      await window.api.settings.update({ activeConnectionId: conn.id, activeModel: m.id })
      await loadSettings()
      setLiveModels(null)
    } catch (e) {
      toast('error', 'Could not switch model', errorMessage(e))
    }
  }

  const history = useMemo<AiTurn[]>(() => {
    const turns: AiTurn[] = []
    for (const m of messages) {
      if (m.role !== 'assistant' || m.status !== 'done' || !m.result) continue
      // The sealed turn is the exchange as the model saw it; the main process replays it instead of raw values.
      const sealed = m.result.kind === 'cancelled' ? undefined : m.result.privacy?.sealed
      if (m.result.kind === 'query') turns.push({ question: m.question, sql: m.result.sql, ...(sealed ? { sealed } : {}) })
      else if (m.result.kind === 'clarify') turns.push({ question: m.question, answer: m.result.message, ...(sealed ? { sealed } : {}) })
    }
    return turns.slice(-6)
  }, [messages])

  const send = async () => {
    const question = input.trim()
    if (!question || asking) return
    if (!providerReady) {
      toast('info', 'Set up a language model first', 'Plain-English questions are answered by a provider of your choice with your own key. Open Settings to pick one.')
      setSettingsOpen(true, { tab: 'ai' })
      return
    }
    const requestId = crypto.randomUUID()
    const assistantId = crypto.randomUUID()
    setChat((c) => ({
      ...c,
      requestId,
      input: '',
      messages: [...c.messages, { id: crypto.randomUUID(), role: 'user', text: question, ts: Date.now() }, { id: assistantId, role: 'assistant', question, ts: Date.now(), status: 'working', steps: [], requestId }]
    }))
    const finish = (patch: Partial<Extract<ChatMessage, { role: 'assistant' }>>) =>
      setChat((c) => ({
        ...c,
        requestId: c.requestId === requestId ? null : c.requestId,
        messages: c.messages.map((m) => (m.id === assistantId && m.role === 'assistant' ? { ...m, ...patch, status: 'done', endedAt: Date.now() } : m))
      }))
    try {
      const res = await window.api.ai.ask(sessionId, question, history, requestId, chat.conversationId)
      finish({ result: res })
      if (res.kind === 'query') {
        const u = res.usage
        setStatus(`${u.model} · ${u.requests} request${u.requests === 1 ? '' : 's'} · ${formatTokens(u.inputTokens)} in / ${formatTokens(u.outputTokens)} out${u.cachedInputTokens ? ` (${formatTokens(u.cachedInputTokens)} cached)` : ''}`)
        onSql(res.sql, res.autoRun)
      } else if (res.kind === 'cancelled') setStatus('Cancelled')
    } catch (e) {
      finish({ error: errorMessage(e) })
    }
  }

  const cancel = () => {
    if (chat.requestId) void window.api.ai.cancel(chat.requestId)
  }

  const clear = () => {
    if (asking) cancel()
    // A reset chat forgets its placeholders and what its answers sent.
    void window.api.ai.forget(chat.conversationId, { transcripts: true })
    setChat(() => emptyChat())
  }

  const toggleSteps = (id: string) => setChat((c) => ({ ...c, messages: c.messages.map((m) => (m.id === id && m.role === 'assistant' ? { ...m, stepsOpen: !m.stepsOpen } : m)) }))

  const stepIcon = (s: Step): ReactNode => {
    if (s.status === 'running') return <span className="spinner tiny" />
    if (s.status === 'error') return <Icon name="x" size={12} className="step-fail" />
    return <Icon name="check" size={12} className="step-ok" />
  }

  const renderSteps = (m: Extract<ChatMessage, { role: 'assistant' }>, live: boolean) => (
    <div className={`ask-steps ${live ? 'live' : ''}`}>
      {m.steps.map((s) => (
        <div key={s.stepId} className={`ask-step ${s.status} ${s.stage}`}>
          {stepIcon(s)}
          <span className="ask-step-text">
            <span className="ask-step-message">{s.message}</span>
            {s.detail ? <span className="ask-step-detail">{s.detail}</span> : null}
          </span>
          {s.endedAt === undefined || s.endedAt > s.ts ? <span className="ask-step-time">{formatMs((s.endedAt ?? Date.now()) - s.ts)}</span> : null}
        </div>
      ))}
    </div>
  )

  const renderAssistant = (m: Extract<ChatMessage, { role: 'assistant' }>) => {
    if (m.status === 'working') {
      const current = m.steps[m.steps.length - 1]
      return (
        <div className="chat-msg assistant working" key={m.id} data-testid="ask-working">
          <div className="ask-step live">
            {current ? stepIcon(current) : <span className="spinner tiny" />}
            <span className="ask-step-text">
              <span className="ask-step-message">{current ? current.message : 'Starting…'}</span>
              {current?.detail ? <span className="ask-step-detail">{current.detail}</span> : null}
            </span>
            {current ? (
              <span className="ask-step-time">
                {m.steps.length > 1 ? `step ${m.steps.length} · ` : ''}
                {formatMs((current.endedAt ?? Date.now()) - current.ts)}
              </span>
            ) : null}
          </div>
          <div className="chat-actions">
            <button className="btn small ghost" onClick={cancel} data-testid="ask-cancel">
              <Icon name="stop" size={11} /> Cancel
            </button>
          </div>
        </div>
      )
    }
    const summary = m.steps.length ? `${m.steps.length} step${m.steps.length === 1 ? '' : 's'} · ${formatMs((m.endedAt ?? m.ts) - m.ts)}` : ''
    const inspect = m.requestId ? () => setInspecting(m.requestId!) : undefined
    const stepsToggle = summary ? (
      <button className={`ask-steps-toggle ${m.stepsOpen ? 'open' : ''}`} onClick={() => toggleSteps(m.id)} title="What happened while the answer was built">
        {summary} <Icon name="chevron-down" size={11} />
      </button>
    ) : null
    // Beside the steps: every request and response, as they went over the network.
    const whatWasSent = inspect ? (
      <button className="ask-action" onClick={inspect} title="Exactly what was sent to the model and what came back" data-testid="ask-what-was-sent">
        <Icon name="shield" size={11} /> What was sent to the model
      </button>
    ) : null
    let body: ReactNode
    if (m.error) body = <div className="chat-text error">{m.error}</div>
    else if (!m.result || m.result.kind === 'cancelled') body = <div className="chat-text muted">Cancelled.</div>
    else if (m.result.kind === 'clarify') {
      body = (
        <>
          <div className="chat-text">{m.result.message}</div>
          <div className="chat-hint">Reply below to continue.</div>
        </>
      )
    } else {
      const r = m.result
      const readOnly = r.checks.explained
        ? 'Verified read-only: the database refused writes, and the query plan was checked before running'
        : 'Read-only: the database refused writes, but the query plan could not be checked'
      const context = r.context.mode === 'all' ? `all ${r.context.totalTables} tables` : `${r.context.tables} of ${r.context.totalTables} tables`
      const privacy = privacyLink(r.privacy, inspect)
      body = (
        <>
          <div className="chat-text">{r.explanation}</div>
          <SqlCode sql={r.sql} dialect={dialect} className="chat-sql" title="The query placed in the editor" />
          {r.warnings?.map((w) => (
            <div key={w} className="ask-note warn" data-testid="ask-warning">
              {w}
            </div>
          ))}
          {r.assumptions.map((a) => (
            <div key={a} className="ask-note">
              {a}
            </div>
          ))}
          {/* What happened to the query, as glyphs with their details in tooltips, then the cost. */}
          <div className="ask-meta" data-testid="ask-meta">
            <span className="ask-glyphs">
              <span className={`ask-glyph ${r.checks.explained ? 'ok' : 'warn'}`} role="img" title={readOnly} aria-label={readOnly} data-testid="ask-read-only">
                <Icon name={r.checks.explained ? 'shield' : 'shield-alert'} size={12} />
              </span>
              {r.checks.repairs ? (
                <span className="ask-glyph" role="img" title={`Fixed ${r.checks.repairs}× after the database rejected it`} aria-label={`Fixed ${r.checks.repairs} times`}>
                  <Icon name="wrench" size={12} />
                  <span>{r.checks.repairs}</span>
                </span>
              ) : null}
              {r.autoRun ? (
                <span className="ask-glyph" role="img" title="Ran automatically" aria-label="Ran automatically" data-testid="ask-auto-ran">
                  <Icon name="bolt" size={12} />
                </span>
              ) : null}
            </span>
            {/* Spelled out rather than a glyph: it is the way in to what was protected. */}
            {privacy ? <span>{privacy}</span> : null}
            <span title={`${formatTokens(r.usage.inputTokens)} in, ${formatTokens(r.usage.outputTokens)} out · ${prettyModelName(r.usage.model)} · schema from ${context} (~${formatTokens(r.context.schemaTokens)} tokens)`}>
              {formatTokens(r.usage.inputTokens + r.usage.outputTokens)} tokens
            </span>
          </div>
        </>
      )
    }
    const run = m.result?.kind === 'query' ? m.result : null
    return (
      <div className={`chat-msg assistant ${m.result?.kind ?? (m.error ? 'error' : '')}`} key={m.id} data-testid="ask-result">
        {body}
        {run || stepsToggle ? (
          <div className="ask-actions">
            {run ? (
              <>
                <button className="ask-action run" onClick={() => onSql(run.sql, true)} disabled={running} data-testid="ask-run">
                  <Icon name="play" size={11} /> {run.autoRun ? 'Run again' : 'Run it'}
                </button>
                <button className="ask-action" onClick={() => onSql(run.sql, false)} title="Put this query in the editor without running it">
                  To editor
                </button>
              </>
            ) : null}
            {stepsToggle}
          </div>
        ) : null}
        {m.stepsOpen ? (
          <>
            {renderSteps(m, false)}
            {whatWasSent}
          </>
        ) : null}
      </div>
    )
  }

  return (
    <div className="pane ask-panel" data-testid="ask-panel">
      <PaneHeader title="Ask" handle={handle} testId="ask-header">
        <span className="spacer" />
        {messages.length ? (
          <button className="btn ghost icon small" onClick={clear} title="Start a new conversation" data-testid="ask-reset">
            <Icon name="refresh" size={13} />
          </button>
        ) : null}
        <button className="btn ghost icon small" onClick={onCollapse} title="Hide the chat" data-testid="ask-collapse">
          <Icon name="chevron-right" size={14} />
        </button>
      </PaneHeader>
      <div className="chat" ref={listRef}>
        {!messages.length ? (
          <div className="chat-empty">
            <p>Ask about the data in plain English. The answer is a read-only query that goes into the editor.</p>
            {providerReady ? (
              <div className="chat-examples">
                {EXAMPLES.map((ex) => (
                  <button key={ex} className="chat-example" onClick={() => setChat((c) => ({ ...c, input: ex }))}>
                    {ex}
                  </button>
                ))}
              </div>
            ) : (
              <button className="btn small" onClick={() => setSettingsOpen(true, { tab: 'ai' })} title="Plain-English questions need a language model provider" data-testid="ask-needs-key">
                <Icon name="settings" /> Set up provider
              </button>
            )}
          </div>
        ) : null}
        {messages.map((m) =>
          m.role === 'user' ? (
            <div className="chat-msg user" key={m.id}>
              <div className="chat-text">{m.text}</div>
            </div>
          ) : (
            renderAssistant(m)
          )
        )}
      </div>
      {inspecting ? <ExchangeInspector requestId={inspecting} onClose={() => setInspecting(null)} /> : null}
      {notice ? (
        <div className="chat-notice" data-testid="model-notice">
          <span>{notice.text}</span>
          <button
            className="btn small"
            onClick={() => {
              setSettingsOpen(true, { provider: notice.model.provider, model: notice.model.id })
              setNotice(null)
            }}
            data-testid="model-notice-settings"
          >
            <Icon name="settings" /> Set up {PROVIDERS[notice.model.provider].label}
          </button>
          <button className="btn ghost icon small notice-close" onClick={() => setNotice(null)} title="Dismiss">
            <Icon name="x" size={12} />
          </button>
        </div>
      ) : null}
      <div className="chat-input">
        <textarea
          ref={inputRef}
          className="text"
          rows={1}
          placeholder={awaitingReply ? 'Reply…' : messages.length ? 'Ask a follow-up, or a new question…' : 'Ask in plain English…'}
          value={input}
          onChange={(e) => {
            const v = e.target.value
            setChat((c) => ({ ...c, input: v }))
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          disabled={asking}
          data-testid="ask-input"
        />
        <button className="chat-send" onClick={() => void send()} disabled={asking || !input.trim()} title="Send (Enter)" data-testid="ask-button">
          {asking ? <span className="spinner" /> : <Icon name="send" size={15} />}
        </button>
      </div>
      <div className="chat-footer">
        <div className="model-picker">
          <button
            ref={modelButtonRef}
            className={`model-button ${menuOpen ? 'open' : ''}`}
            onClick={() => setMenuOpen((v) => !v)}
            title={settings?.activeModel ? `${settings.activeModel} via ${active?.name ?? 'the active connection'} · choose the model that answers questions` : 'Choose the model that answers questions'}
            data-testid="model-button"
          >
            <span className="model-name">{settings?.activeModel && active ? modelTitle(active.provider, settings.activeModel) : 'Choose a model'}</span>
            <Icon name={menuOpen ? 'chevron-down' : 'chevron-right'} size={11} />
          </button>
          {menuOpen && menuStyle ? (
            createPortal(
            <div className="model-menu" role="menu" style={menuStyle} ref={menuRef} data-testid="model-menu">
              {menuGroups.map((g) => (
                <div className="model-group" key={g.key}>
                  <div className="model-group-title">
                    {g.title}
                    {g.note ? <span className="model-group-note">{g.note}</span> : null}
                  </div>
                  {g.items.map((m) => {
                    const current = Boolean(m.connectionId) && m.connectionId === settings?.activeConnectionId && settings?.activeModel === m.id
                    return (
                      <button key={`${g.key}:${m.id}`} className={`model-item ${current ? 'current' : ''} ${g.note ? 'unavailable' : ''}`} role="menuitem" onClick={() => void chooseModel(m)} data-testid={`model-${m.id}`}>
                        <span className="model-item-label">{m.label}</span>
                        {m.label !== m.id ? <span className="model-item-id">{m.id}</span> : null}
                        {current ? <Icon name="check" size={12} /> : null}
                      </button>
                    )
                  })}
                </div>
              ))}
              <button
                className="model-item manage"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  setSettingsOpen(true, { tab: 'ai' })
                }}
              >
                <Icon name="settings" size={12} /> Manage providers…
              </button>
            </div>,
            document.body
            )
          ) : null}
        </div>
      </div>
    </div>
  )
}
