// The chat beside the connections: one conversation for the window, kept while the user moves between connections. It
// follows the connection in front until the first question, then keeps the databases it has in context, to which more
// can be added to ask across them.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { AiProgressEvent, AiProgressStep, AiRanQuery, AiTurn, AiUsage, CatalogModel } from '@shared/ai'
import { BYOK_PROVIDERS, LOCAL_PROVIDERS, MODEL_CATALOG, PROVIDERS, activeConnection, connectionReady, modelTitle, prettyModelName, readsResults, vendorOf } from '@shared/ai'
import { describeCounts, type AiPrivacyReport } from '@shared/privacy'
import type { ToolApprovalDecision, ToolApprovalRequest } from '@shared/connectors'
import { getSessionStore, useStore } from '@/store'
import { chatStatus, chatTitle, learnedLabel, memoryName, turnResult, type ChatMessage, type ChatState, type ChatStep } from '@/lib/chat'
import type { AiLearned } from '@shared/knowledge'
import { emptyInstruction } from '@shared/instructions'
import { SqlCode } from './SqlCode'
import { Icon } from './Icons'
import { ExchangeInspector } from './ExchangeInspector'
import { ChatConnectorsButton, ToolApprovalCard } from './ChatConnectors'
import { RevealedMarkdown } from './RevealedMarkdown'
import { revealFrom } from '@/lib/reveal'
import { ChatDatabases } from './ChatDatabases'
import { ChatDot } from './ChatDot'
import { ChatHistoryButton } from './ChatHistory'
import { errorMessage, isModKey, modKey } from '@/lib/util'

type Step = ChatStep

/** A catalogue model as listed in the menu, tied to a saved connection when one offers it. */
type MenuModel = CatalogModel & { connectionId?: string; connectionName?: string }

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

function formatTokens(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.max(0, Math.round(ms))}ms`
}

function emptyUsage(): AiUsage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, requests: 0, toolCalls: 0, provider: '', model: '' }
}

/** A progress event in the message being worked on: a new step, or the next state of one already there. */
function withStep(m: ChatMessage, e: AiProgressEvent): ChatMessage {
  if (m.role !== 'assistant' || m.status !== 'working') return m
  const i = m.steps.findIndex((s) => s.stepId === e.stepId)
  const steps = m.steps.slice()
  // A step that arrives finished (a note such as "Protected more values") took no time of its own.
  if (i < 0) steps.push(e.status === 'running' ? e : { ...e, endedAt: e.ts })
  else steps[i] = { ...steps[i], ...e, ts: steps[i].ts, endedAt: e.status === 'running' ? undefined : e.ts }
  return { ...m, steps }
}

/** The conversations as tabs, like the query tabs beside them, each named by the question it began with. */
function ChatTabs({
  chats,
  activeChatId,
  waiting,
  onSelect,
  onClose
}: {
  chats: ChatState[]
  activeChatId: string
  /** A tool in that conversation's ask waits for the user's yes or no. */
  waiting: (chat: ChatState) => boolean
  onSelect: (id: string) => void
  onClose: (id: string) => void
}) {
  const stripRef = useRef<HTMLDivElement>(null)
  // A tab coming to the front, a new one most of all, scrolls into sight.
  useEffect(() => {
    stripRef.current?.querySelector('.chat-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeChatId, chats.length])
  return (
    <div className="tabbar chat-tabbar" ref={stripRef} role="tablist" aria-label="Conversations">
      {chats.map((c) => {
        const title = chatTitle(c)
        const first = c.messages.find((m) => m.role === 'user')
        const busy = Boolean(c.requestId)
        const status = chatStatus(c, busy && waiting(c))
        return (
          <div
            key={c.id}
            role="tab"
            aria-selected={c.id === activeChatId}
            className={`tab chat-tab ${c.id === activeChatId ? 'active' : ''}`}
            onClick={() => onSelect(c.id)}
            onAuxClick={(e) => {
              if (e.button === 1) onClose(c.id)
            }}
            title={first && first.role === 'user' ? first.text : 'A new conversation'}
            data-testid="chat-tab"
            data-title={title}
            data-status={status}
          >
            <ChatDot status={status} unread={c.unread} />
            <span className="tab-title">{title}</span>
            <button
              className="tab-close"
              title={busy ? 'Stop and close this conversation' : 'Close this conversation'}
              onClick={(e) => {
                e.stopPropagation()
                onClose(c.id)
              }}
              data-testid="chat-tab-close"
            >
              <Icon name="x" size={11} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

const EXAMPLES = ['top 10 customers by revenue last quarter', 'orders from this month with no invoice', 'how many users signed up per week this year']

/** The plain-English chat beside the connections. */
export function AskPanel({ onCollapse }: { onCollapse: () => void }) {
  const settings = useStore((s) => s.settings)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const chats = useStore((s) => s.chats)
  const activeChatId = useStore((s) => s.activeChatId)
  const updateChat = useStore((s) => s.updateChat)
  const updateChats = useStore((s) => s.updateChats)
  const newChat = useStore((s) => s.newChat)
  const selectChat = useStore((s) => s.selectChat)
  const closeChat = useStore((s) => s.closeChat)
  /** The conversation in front. */
  const chat = chats.find((c) => c.id === activeChatId) ?? chats[0]
  const setChat = (update: (c: ChatState) => ChatState) => updateChat(chat.id, update)
  const connections = useStore((s) => s.connections)
  const tabs = useStore((s) => s.tabs)
  const activeConnectionId = useStore((s) => s.activeConnectionId)
  const showConnect = useStore((s) => s.showConnect)
  const ensureSession = useStore((s) => s.ensureSession)
  const openSql = useStore((s) => s.openSql)
  /** The connection in front, when one is. */
  const frontId = !showConnect && activeConnectionId && tabs.some((t) => t.connectionId === activeConnectionId) ? activeConnectionId : null
  /** The databases in context that still exist, in the order added; the first is the chat's own. */
  const pinned = (chat.databases ?? []).filter((id) => connections.some((c) => c.id === id))
  /** Until the first question the chat follows the connection in front. */
  const following = !pinned.length
  const inContext = following ? (frontId ? [frontId] : []) : pinned
  const homeId = inContext[0]
  const nameOf = (id: string | undefined) => connections.find((c) => c.id === id)?.name ?? 'the database'
  const kindOf = (id: string | undefined) => connections.find((c) => c.id === id)?.kind ?? 'sqlite'
  const dialect = kindOf(homeId)
  /** Asks cancelled while the chat was still connecting their databases, before they reached the main process. */
  const cancelledRef = useRef(new Set<string>())
  /** Connector tool calls waiting for the user, shown in the answer being worked on. */
  const approvals = useStore((s) => s.approvals)
  const addApproval = useStore((s) => s.addApproval)
  const dropApprovals = useStore((s) => s.dropApprovals)
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

  // The chat's own asks, in any of its tabs: each answer shows the ones for its request.
  useEffect(
    () =>
      window.api.ai.onApproval((req) => {
        if (useStore.getState().chats.some((c) => c.requestId === req.requestId)) addApproval(req)
      }),
    []
  )

  const answerApproval = (req: ToolApprovalRequest, decision: ToolApprovalDecision) => {
    dropApprovals((a) => a.approvalId === req.approvalId)
    void window.api.ai.approve(req.approvalId, decision)
  }

  // Progress events for the ask in flight update the working message in place.
  useEffect(() => {
    return window.api.ai.onProgress((e) => {
      updateChats((c) => (e.requestId === c.requestId ? { ...c, messages: c.messages.map((m) => withStep(m, e)) } : c))
    })
  }, [updateChats])

  // Keep elapsed times moving while a step runs.
  useEffect(() => {
    if (!asking) return
    const t = setInterval(() => tick((n) => n + 1), 500)
    return () => clearInterval(t)
  }, [asking])

  // The answer being written, as it streams.
  useEffect(
    () =>
      window.api.ai.onStream((e) =>
        updateChats((c) =>
          c.requestId !== e.requestId
            ? c
            : { ...c, messages: c.messages.map((m) => (m.role === 'assistant' && m.status === 'working' && m.requestId === e.requestId ? { ...m, draft: e.text } : m)) }
        )
      ),
    [updateChats]
  )

  // Follow the conversation: to its end when it changes, and as an answer unfolds, unless the user scrolled up to read.
  const atEnd = useRef(true)
  const follow = useCallback(() => {
    const el = listRef.current
    if (el && atEnd.current) el.scrollTop = el.scrollHeight
  }, [])
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
    atEnd.current = true
  }, [messages.length, chat.id])
  useEffect(follow, [messages, follow])

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
      if (m.result.kind === 'query') {
        // What the query returned in the editor goes along only where the user lets Ask read results.
        const on = m.result.database?.connectionId || chat.databases?.[0]
        const result = m.ranResult && readsResults(settings?.agent.readResults, on) ? { result: m.ranResult } : {}
        turns.push({ question: m.question, sql: m.result.sql, ...(m.result.database ? { database: m.result.database.name } : {}), ...result, ...(sealed ? { sealed } : {}) })
      }
      else if (m.result.kind === 'clarify') turns.push({ question: m.question, answer: m.result.message, ...(sealed ? { sealed } : {}) })
    }
    return turns.slice(-6)
  }, [messages, settings, chat.databases])

  const send = async () => {
    const question = input.trim()
    if (!question || asking) return
    if (!providerReady) {
      toast('info', 'Set up a language model first', 'Plain-English questions are answered by a provider of your choice with your own key. Open Settings to pick one.')
      setSettingsOpen(true, { tab: 'models' })
      return
    }
    const ids = inContext
    if (!ids.length) {
      toast('info', 'Add a database first', 'The chat answers questions about the databases it has in context: open a connection, or add one with the + above the box.')
      return
    }
    const requestId = crypto.randomUUID()
    const assistantId = crypto.randomUUID()
    // Every change goes to the conversation that asked, whichever tab is in front by then.
    const chatId = chat.id
    const toChat = (update: (c: ChatState) => ChatState) => updateChat(chatId, update)
    // The answer unfolds as it arrives, rather than landing all at once.
    revealFrom(assistantId)
    revealFrom(`${assistantId}:explanation`)
    /** The conversation's first question: the model names it too, for its tab. */
    const first = !chat.messages.some((m) => m.role === 'user')
    toChat((c) => ({
      ...c,
      requestId,
      input: '',
      // The first question settles the chat on the connection in front; it stays there as the user moves on.
      databases: c.databases?.length ? c.databases : ids,
      messages: [...c.messages, { id: crypto.randomUUID(), role: 'user', text: question, ts: Date.now() }, { id: assistantId, role: 'assistant', question, ts: Date.now(), status: 'working', steps: [], requestId }]
    }))
    const finish = (patch: Partial<Extract<ChatMessage, { role: 'assistant' }>>) => {
      dropApprovals((a) => a.requestId === requestId)
      cancelledRef.current.delete(requestId)
      // An answer that comes while the user looks elsewhere is new to them until they open its tab.
      const now = useStore.getState()
      const seen = now.chatOpen && now.activeChatId === chatId
      toChat((c) => ({
        ...c,
        unread: !seen,
        requestId: c.requestId === requestId ? null : c.requestId,
        messages: c.messages.map((m) => (m.id === assistantId && m.role === 'assistant' ? { ...m, ...patch, status: 'done', endedAt: Date.now() } : m))
      }))
    }
    // A step shown in the answer being worked on, from this side: connecting the databases in context.
    let seq = 0
    const note = (step: AiProgressStep) => {
      const e: AiProgressEvent = { ...step, requestId, seq: --seq, ts: Date.now() }
      toChat((c) => ({ ...c, messages: c.messages.map((m) => (m.id === assistantId ? withStep(m, e) : m)) }))
    }
    try {
      // Each database in context is connected first; one that cannot be is left out of this question, and the steps say why.
      const sessions: { connectionId: string; sessionId: string }[] = []
      for (const id of ids) {
        const name = nameOf(id)
        const tab = useStore.getState().tabs.find((t) => t.connectionId === id)
        if (tab?.status === 'live' && tab.session) {
          sessions.push({ connectionId: id, sessionId: tab.session.sessionId })
          continue
        }
        const stepId = `connect:${id}`
        note({ stepId, stage: 'index', status: 'running', message: `Connecting to ${name}` })
        try {
          sessions.push({ connectionId: id, sessionId: await ensureSession(id) })
          note({ stepId, stage: 'index', status: 'done', message: `Connecting to ${name}` })
        } catch (e) {
          note({ stepId, stage: 'index', status: 'error', message: `Left out ${name}`, detail: errorMessage(e) })
        }
      }
      if (cancelledRef.current.has(requestId)) {
        finish({ result: { kind: 'cancelled', usage: emptyUsage() } })
        return
      }
      if (!sessions.length) throw new Error(ids.length === 1 ? `Could not connect to ${nameOf(ids[0])}.` : 'Could not connect to any database in this chat.')
      const [home, ...others] = sessions
      const res = await window.api.ai.ask(home.sessionId, question, history, requestId, chat.conversationId, {
        connectors: chat.connectors,
        ...(others.length ? { databases: others } : {}),
        ...(first ? { title: true } : {})
      })
      if (res.kind !== 'cancelled' && res.title) toChat((c) => (c.title ? c : { ...c, title: res.title }))
      const statusOf = (connectionId: string) => getSessionStore(sessions.find((x) => x.connectionId === connectionId)?.sessionId ?? home.sessionId)?.getState().setStatus
      if (res.kind === 'query') {
        const target = res.database?.connectionId || home.connectionId
        // Into the editor when the query is for the connection in front; otherwise it waits there for the user.
        const now = useStore.getState()
        const inFront = !now.showConnect && now.activeConnectionId === target
        finish({ result: res, ...(inFront && res.autoRun ? { autoRan: true } : {}) })
        const u = res.usage
        statusOf(target)?.(`${u.model} · ${u.requests} request${u.requests === 1 ? '' : 's'} · ${formatTokens(u.inputTokens)} in / ${formatTokens(u.outputTokens)} out${u.cachedInputTokens ? ` (${formatTokens(u.cachedInputTokens)} cached)` : ''}`)
        if (inFront) void place({ connectionId: target, name: nameOf(target) }, res.sql, res.autoRun).then((results) => keepResult(chatId, assistantId, results))
      } else {
        finish({ result: res })
        if (res.kind === 'cancelled') statusOf(home.connectionId)?.('Cancelled')
      }
    } catch (e) {
      finish({ error: errorMessage(e) })
    }
  }

  const cancel = () => {
    if (!chat.requestId) return
    cancelledRef.current.add(chat.requestId)
    void window.api.ai.cancel(chat.requestId)
  }

  /** Where a query belongs: the database the answer names, or the chat's own. */
  const targetOf = (db: { connectionId: string; name: string } | undefined): { connectionId: string; name: string } | null =>
    db?.connectionId ? db : homeId ? { connectionId: homeId, name: nameOf(homeId) } : null
  const dialectOf = (id: string | undefined) => kindOf(id || homeId)

  /** Puts a query in the editor of its connection, opening and connecting that when needed, and runs it if asked. */
  const place = (target: { connectionId: string; name: string }, sql: string, run: boolean) =>
    openSql(target.connectionId, sql, run).catch((e) => {
      toast('error', `Could not open ${target.name}`, errorMessage(e))
      return null
    })

  /** What an answer's query returned when it ran, kept with the answer for a follow-up about it. */
  const keepResult = (chatId: string, messageId: string, results: Awaited<ReturnType<typeof place>>) => {
    const kept = turnResult(results)
    if (!kept) return
    updateChat(chatId, (c) => ({ ...c, messages: c.messages.map((m) => (m.id === messageId && m.role === 'assistant' ? { ...m, ranResult: kept } : m)) }))
  }

  /** Keeps a fact the model offered as an instruction, for the connections it is about. */
  const putInstruction = useStore((s) => s.putInstruction)
  const rememberFact = async (messageId: string, index: number, fact: string, connectionIds: string[]) => {
    try {
      const saved = await window.api.instructions.save({
        ...emptyInstruction(),
        name: memoryName(fact),
        text: fact,
        scope: connectionIds.length ? 'selected' : 'all',
        connectionIds
      })
      putInstruction(saved)
      setMemory(messageId, index, 'saved')
    } catch (e) {
      toast('error', 'Could not remember that', errorMessage(e))
    }
  }
  /** Undoes something the model learned while answering: forgotten, or a correction taken back. */
  const forgetLearned = async (messageId: string, index: number, item: AiLearned) => {
    try {
      await window.api.knowledge.forget(item)
      setChat((c) => ({
        ...c,
        messages: c.messages.map((m) => (m.id === messageId && m.role === 'assistant' ? { ...m, forgotten: [...new Set([...(m.forgotten ?? []), index])] } : m))
      }))
    } catch (e) {
      toast('error', 'Could not forget that', errorMessage(e))
    }
  }
  const setMemory = (messageId: string, index: number, state: 'saved' | 'dismissed') =>
    setChat((c) => ({
      ...c,
      messages: c.messages.map((m) => (m.id === messageId && m.role === 'assistant' ? { ...m, memoryState: { ...m.memoryState, [index]: state } } : m))
    }))

  /** A query the model ran, into the editor of its own database. */
  const openRan = (q: AiRanQuery) => {
    const target = targetOf(q.database)
    if (target) place(target, q.sql, false)
  }

  /** A new conversation, in front and ready to type in. */
  const startNewChat = () => {
    newChat()
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  // ⌘T in the chat opens a new conversation, as it opens a query tab in a connection. The chat is in use when focus is
  // in it, or nothing has focus and the last click was in it.
  const startNewChatRef = useRef(startNewChat)
  startNewChatRef.current = startNewChat
  useEffect(() => {
    const inChat = (el: EventTarget | null) => el instanceof Element && Boolean(el.closest('.chat-pane'))
    let clickedInChat = false
    const onPointer = (e: PointerEvent) => {
      clickedInChat = inChat(e.target)
    }
    const onKey = (e: KeyboardEvent) => {
      if (!isModKey(e) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 't' || !useStore.getState().chatOpen) return
      const focused = document.activeElement
      if (!(inChat(focused) || ((!focused || focused === document.body) && clickedInChat))) return
      // Before the connection's own shortcut, which would open a query tab.
      e.preventDefault()
      e.stopPropagation()
      startNewChatRef.current()
    }
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [])

  const toggleSteps = (id: string) => setChat((c) => ({ ...c, messages: c.messages.map((m) => (m.id === id && m.role === 'assistant' ? { ...m, stepsOpen: !m.stepsOpen } : m)) }))
  const toggleQueries = (id: string) => setChat((c) => ({ ...c, messages: c.messages.map((m) => (m.id === id && m.role === 'assistant' ? { ...m, queriesOpen: !m.queriesOpen } : m)) }))

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
          {/* The answer as the model writes it. */}
          {m.draft?.trim() ? (
            <RevealedMarkdown revealKey={m.id} text={m.draft.trimStart()} dialect={dialect} className="chat-text" onGrow={follow} />
          ) : null}
          {approvals
            .filter((a) => a.requestId === m.requestId)
            .map((a) => (
              <ToolApprovalCard key={a.approvalId} request={a} onAnswer={(d) => answerApproval(a, d)} />
            ))}
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
      const r = m.result
      const message = r.message
      const privacy = privacyLink(r.privacy, inspect)
      body = (
        <>
          <RevealedMarkdown revealKey={m.id} text={message} dialect={dialect} className="chat-text" onGrow={follow} />
          {r.cutShort ? (
            <div className="ask-note warn" data-testid="ask-cut-short">
              The answer was cut short at the model&apos;s length limit for one reply.
            </div>
          ) : null}
          {/* A question back to the user, rather than an answer in words. */}
          {/\?\s*$/.test(message) ? <div className="chat-hint">Reply below to continue.</div> : null}
          {/* An answer built from query results: what was protected in them, and the cost. */}
          {r.queries?.length ? (
            <div className="ask-meta" data-testid="ask-meta">
              {privacy ? <span>{privacy}</span> : null}
              <span title={`${formatTokens(r.usage.inputTokens)} in, ${formatTokens(r.usage.outputTokens)} out · ${prettyModelName(r.usage.model)}`}>
                {formatTokens(r.usage.inputTokens + r.usage.outputTokens)} tokens
              </span>
            </div>
          ) : null}
        </>
      )
    } else {
      const r = m.result
      const readOnly = r.checks.explained
        ? 'Verified read-only: the database refused writes, and the query plan was checked before running'
        : 'Read-only: the database refused writes, but the query plan could not be checked'
      const context = r.context.mode === 'all' ? `all ${r.context.totalTables} tables` : `${r.context.tables} of ${r.context.totalTables} tables`
      const privacy = privacyLink(r.privacy, inspect)
      const target = targetOf(r.database)
      const autoRan = m.autoRan ?? (r.autoRun && !r.database)
      body = (
        <>
          <RevealedMarkdown revealKey={`${m.id}:explanation`} text={r.explanation} dialect={dialect} className="chat-text" onGrow={follow} />
          {/* In a chat across databases, the one the query is for. */}
          {r.database ? (
            <div className="ask-db-label" data-testid="ask-db-label">
              <Icon name="database" size={11} /> {r.database.name}
            </div>
          ) : null}
          <SqlCode sql={r.sql} dialect={dialectOf(r.database?.connectionId)} className="chat-sql" title={target ? `A query for ${target.name}` : undefined} />
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
              {autoRan ? (
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
    const runTarget = run ? targetOf(run.database) : null
    /** The query's connection is not the one in front: its actions say where it goes. */
    const runAway = runTarget && runTarget.connectionId !== frontId ? runTarget : null
    // The queries the model ran to look into the question, across the databases in the chat.
    const ran = m.result && m.result.kind !== 'cancelled' ? (m.result.queries ?? []) : []
    const queriesToggle = ran.length ? (
      <button className={`ask-steps-toggle ${m.queriesOpen ? 'open' : ''}`} onClick={() => toggleQueries(m.id)} title="The queries the model ran to find the answer" data-testid="ask-queries-toggle">
        {ran.length} {ran.length === 1 ? 'query' : 'queries'} <Icon name="chevron-down" size={11} />
      </button>
    ) : null
    return (
      <div className={`chat-msg assistant ${m.result?.kind ?? (m.error ? 'error' : '')}`} key={m.id} data-testid="ask-result">
        {body}
        {run || stepsToggle || queriesToggle ? (
          <div className="ask-actions">
            {run && runTarget && runAway ? (
              <>
                <button
                  className="ask-action run"
                  onClick={() => void place(runAway, run.sql, true).then((results) => keepResult(chat.id, m.id, results))}
                  title={`Run it in the editor of ${runAway.name}`}
                  data-testid="ask-run-in"
                >
                  <Icon name="play" size={11} /> Run in {runAway.name}
                </button>
                <button className="ask-action" onClick={() => place(runAway, run.sql, false)} title={`Put this query in the editor of ${runAway.name} without running it`} data-testid="ask-open-in">
                  Open in {runAway.name}
                </button>
              </>
            ) : run && runTarget ? (
              <>
                <button className="ask-action run" onClick={() => void place(runTarget, run.sql, true).then((results) => keepResult(chat.id, m.id, results))} data-testid="ask-run">
                  <Icon name="play" size={11} /> {(m.autoRan ?? (run.autoRun && !run.database)) ? 'Run again' : 'Run it'}
                </button>
                <button className="ask-action" onClick={() => place(runTarget, run.sql, false)} title="Put this query in the editor without running it">
                  To editor
                </button>
              </>
            ) : null}
            <span className="ask-toggles">
              {queriesToggle}
              {stepsToggle}
            </span>
          </div>
        ) : null}
        {/* What the model learned while answering, kept already: named here, to forget with a click. */}
        {(() => {
          const learned = m.result && m.result.kind !== 'cancelled' ? (m.result.learned ?? []) : []
          const shown = learned.map((item, i) => ({ item, i })).filter(({ i }) => !m.forgotten?.includes(i))
          if (!shown.length) return null
          return (
            <div className="ask-learned" data-testid="ask-learned">
              <Icon name="sparkles" size={12} />
              <span className="ask-learned-label">Learned</span>
              {shown.map(({ item, i }) => (
                <span key={i} className="ask-learned-item" title={item.meaning} data-testid="ask-learned-item" data-kind={item.kind}>
                  {learnedLabel(item)}
                  <button
                    className="ask-learned-forget"
                    onClick={() => void forgetLearned(m.id, i, item)}
                    title={item.corrected ? 'Forget this correction' : 'Forget this'}
                    aria-label={`Forget ${item.name}`}
                    data-testid="ask-learned-forget"
                  >
                    <Icon name="x" size={10} />
                  </button>
                </span>
              ))}
            </div>
          )
        })()}
        {/* Facts the model offered to remember, in chats from before it learned for itself. */}
        {(m.result && m.result.kind !== 'cancelled' ? (m.result.memories ?? []) : []).map((mem, i) => {
          const state = m.memoryState?.[i]
          if (state === 'dismissed') return null
          const where = mem.connectionIds.length ? mem.connectionIds.map(nameOf).join(', ') : 'every database'
          return (
            <div key={i} className={`ask-memory ${state ?? ''}`} data-testid="ask-memory">
              <Icon name="note" size={12} />
              <span className="ask-memory-text">
                <span className="ask-memory-label">{state === 'saved' ? `Remembered for ${where}` : `Remember for ${where}?`}</span> {mem.fact}
              </span>
              {state === 'saved' ? null : (
                <span className="ask-memory-actions">
                  <button className="ask-action" onClick={() => void rememberFact(m.id, i, mem.fact, mem.connectionIds)} title="Keep it as an instruction" data-testid="ask-memory-save">
                    Remember
                  </button>
                  <button className="ask-action" onClick={() => setMemory(m.id, i, 'dismissed')} data-testid="ask-memory-dismiss">
                    Not now
                  </button>
                </span>
              )}
            </div>
          )
        })}
        {m.queriesOpen && ran.length ? (
          <div className="ask-queries" data-testid="ask-queries">
            {ran.map((q, i) => {
              const target = targetOf(q.database)
              const away = target && target.connectionId !== frontId ? target : null
              return (
                <div key={i} className="ask-query" data-testid="ask-query" data-database={q.database.name}>
                  <div className="ask-query-head">
                    <Icon name="database" size={11} />
                    <span className="ask-query-db">{q.database.name}</span>
                    <span className={`ask-query-rows ${q.error ? 'warn' : ''}`}>{q.error ? 'failed' : `${q.rows ?? 0} row${q.rows === 1 ? '' : 's'}`}</span>
                    <button className="ask-action" onClick={() => openRan(q)} title={away ? `Put this query in the editor of ${away.name}` : 'Put this query in the editor'}>
                      {away ? `Open in ${away.name}` : 'To editor'}
                    </button>
                  </div>
                  <SqlCode sql={q.sql} dialect={dialectOf(q.database.connectionId)} className="chat-sql small" />
                  {q.error ? <div className="ask-note warn">{q.error}</div> : null}
                </div>
              )
            })}
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
      <div className="chat-pane-header" data-testid="ask-header">
        <button className="btn ghost icon small chat-collapse" onClick={onCollapse} title="Hide the chat" data-testid="ask-collapse">
          <Icon name="panel" size={14} />
        </button>
        <ChatTabs
          chats={chats}
          activeChatId={chat.id}
          waiting={(c) => approvals.some((a) => a.requestId === c.requestId)}
          onSelect={(id) => {
            selectChat(id)
            requestAnimationFrame(() => inputRef.current?.focus())
          }}
          onClose={(id) => closeChat(id)}
        />
        {/* Outside the strip of tabs, so they stay in sight however many there are. */}
        <ChatHistoryButton onOpened={() => requestAnimationFrame(() => inputRef.current?.focus())} />
        <button className="tab-new chat-new" onClick={() => startNewChat()} title={`New chat (${modKey}T)`} aria-label="New chat" data-testid="chat-tab-new">
          <Icon name="plus" />
        </button>
      </div>
      <div
        className="chat"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget
          atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        }}
      >
        {!messages.length ? (
          <div className="chat-empty">
            {inContext.length > 1 ? (
              <p>
                Ask across {inContext.length} databases in plain English: the model looks in whichever ones the question needs and can follow a
                customer, an order or a request from one to the next.
              </p>
            ) : inContext.length ? (
              <p>
                Ask about the data in {nameOf(homeId)} in plain English. The answer is a read-only query that goes into the editor. Add databases with +
                to ask across them.
              </p>
            ) : (
              <p>Ask about your data in plain English. Open a connection, or add a database with + below.</p>
            )}
            {providerReady ? (
              <div className="chat-examples">
                {EXAMPLES.map((ex) => (
                  <button key={ex} className="chat-example" onClick={() => setChat((c) => ({ ...c, input: ex }))}>
                    {ex}
                  </button>
                ))}
              </div>
            ) : (
              <button className="btn small" onClick={() => setSettingsOpen(true, { tab: 'models' })} title="Plain-English questions need a language model provider" data-testid="ask-needs-key">
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
        <ChatDatabases
          databases={inContext}
          following={following}
          suggestion={!following && frontId && !pinned.includes(frontId) ? frontId : null}
          onChange={(next) => setChat((c) => ({ ...c, databases: next }))}
        />
        <textarea
          ref={inputRef}
          className="text"
          rows={1}
          placeholder={
            awaitingReply
              ? 'Reply…'
              : messages.length
                ? 'Ask a follow-up, or a new question…'
                : inContext.length > 1
                  ? `Ask across ${inContext.length} databases…`
                  : 'Ask in plain English…'
          }
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
                  setSettingsOpen(true, { tab: 'models' })
                }}
              >
                <Icon name="settings" size={12} /> Manage providers…
              </button>
            </div>,
            document.body
            )
          ) : null}
        </div>
        <ChatConnectorsButton
          connectionId={inContext.length > 1 ? inContext : homeId}
          overrides={chat.connectors}
          onChange={(next) => setChat((c) => ({ ...c, connectors: next }))}
        />
      </div>
    </div>
  )
}
