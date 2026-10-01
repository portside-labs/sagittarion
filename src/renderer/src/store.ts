import { create } from 'zustand'
import type { AppInfo, ConnectionConfig, DatabaseKind, GroupStyle, SessionInfo, SshProfile, WorkspaceConnection, WorkspaceState } from '@shared/types'
import type { AiSettings, ProviderId } from '@shared/ai'
import type { ConnectorInfo } from '@shared/connectors'
import type { Instruction } from '@shared/instructions'
import { describeTarget, resolveSshProfile } from '@shared/connections'
import { errorMessage } from './lib/util'
import { defaultLayout, isValidLayout, type LayoutNode } from './lib/layout'
import { clusterTabs, groupByConnection, nearestTab, settleCollapsed } from './lib/tab-groups'
import { createSessionStore, snapshotSession, type SessionStore } from './session-store'
import { ACCEPT_KEY_OPTIONS, type KeywordCase } from './lib/sql-complete'
import { DEFAULT_THEME, isCodeFontId, isSyntaxId, isThemeId, type CodeFontId, type SyntaxId, type ThemeId } from './lib/theme'

export type { Tab, SearchState } from './session-store'

export type SettingsTab = 'appearance' | 'editor' | 'models' | 'connectors' | 'instructions'

/** What the settings dialog should start on when opened for a reason. */
export interface SettingsIntent {
  tab?: SettingsTab
  /** A model whose provider needs setting up: the AI tab opens on that provider with the model filled in. */
  provider?: ProviderId
  model?: string
}

export type ConnectionTabsMode = 'horizontal' | 'vertical'

/** Preferences about the look of the app, kept on this machine. */
export interface UiPrefs {
  /** The colours of the window's surfaces, text and code. */
  theme: ThemeId
  /** Code colours chosen over the theme's; null keeps the theme's. */
  syntax: SyntaxId | null
  /** The SQL editor's font; null keeps the theme's. */
  codeFont: CodeFontId | null
  /** Where open connections are listed: a strip across the top or a rail down the left. */
  connectionTabs: ConnectionTabsMode
  /** Re-case SQL keywords as they are typed. */
  keywordCase: KeywordCase
  /** Suggest tables, columns and keywords while typing. */
  autocomplete: boolean
  /** Give tables an alias as they are typed or picked. */
  autoAlias: boolean
  /** Keys that take the highlighted suggestion. */
  acceptKeys: string[]
}

export type OpenTabStatus = 'pending' | 'connecting' | 'live' | 'error'

/** One connection tab. It may still be waiting to connect, which is how tabs come back after a launch. */
export interface OpenTab {
  /** The saved connection behind the tab; one tab per saved connection. */
  connectionId: string
  name: string
  kind: DatabaseKind
  target: string
  status: OpenTabStatus
  session: SessionInfo | null
  error?: string
  /** The latest progress line while connecting. */
  progress?: string
  progressId?: string
  /** Tabs to bring back once the connection is made. */
  restore?: WorkspaceConnection
  /**
   * A live tab whose link to the database dropped by itself, as idle connections do: it stays as it is, and the next
   * call that needs the database reconnects. Unset while the link is up.
   */
  link?: 'down' | 'reconnecting'
  /** Why the link is down, or the reconnect's latest step. */
  linkMessage?: string
}

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'warn' | 'error'
  message: string
  detail?: string
  /** Set while the exit animation plays. */
  leaving?: boolean
}

export interface ConfirmRequest {
  message: string
  detail?: string
  confirmLabel: string
  destructive: boolean
  resolve: (ok: boolean) => void
}

interface State {
  appInfo: AppInfo | null
  connections: ConnectionConfig[]
  /** How each connection group looks, keyed by name. */
  groupStyles: Record<string, GroupStyle>
  /** Saved SSH hosts, reusable by any connection. */
  sshProfiles: SshProfile[]
  /** True once the profile list has been read, so a connection's profile can be checked against it. */
  sshProfilesLoaded: boolean
  /** Connection tabs in order, each group's tabs side by side. A live one has a session store of its own; see getSessionStore. */
  tabs: OpenTab[]
  activeConnectionId: string | null
  /** Tab groups folded up to their label, by group name; kept with the workspace. */
  collapsedTabGroups: string[]
  /** Show the connect screen although connections are open: the "+" tab. */
  showConnect: boolean
  /** A saved connection the connect screen should open on next, e.g. after "Edit connection" on a failed tab. */
  connectSelect: string | null
  ui: UiPrefs
  toasts: Toast[]
  confirmRequest: ConfirmRequest | null
  settings: AiSettings | null
  /** MCP servers whose tools the chat can use, with how each is doing; kept current by the main process. */
  connectors: ConnectorInfo[]
  /** What the user tells the model about their data, for every connection or chosen ones. */
  instructions: Instruction[]
  settingsOpen: boolean
  settingsIntent: SettingsIntent | null
  /** Arrangement of the editor, chat and results panes in query tabs. */
  queryLayout: LayoutNode
  chatOpen: boolean

  setQueryLayout(layout: LayoutNode): void
  setChatOpen(open: boolean): void
  setUiPref(patch: Partial<UiPrefs>): void
  init(): Promise<void>
  loadSettings(): Promise<void>
  loadConnectors(): Promise<void>
  /** A connector as it is now: added, changed, or in a new state. */
  putConnector(info: ConnectorInfo): void
  dropConnector(id: string): void
  loadInstructions(): Promise<void>
  putInstruction(instruction: Instruction): void
  dropInstruction(id: string): void
  setSettingsOpen(open: boolean, intent?: SettingsIntent): void
  confirm(message: string, detail?: string, confirmLabel?: string, destructive?: boolean): Promise<boolean>
  resolveConfirm(ok: boolean): void
  loadConnections(): Promise<void>
  loadSshProfiles(): Promise<void>
  /** A freshly opened connection becomes a live tab; `restore` brings back tabs from a previous launch. */
  openSession(info: SessionInfo, restore?: WorkspaceConnection, activate?: boolean): void
  /** Brings a tab to the front, connecting it first when it has not been connected yet. */
  activateTab(connectionId: string): void
  connectTab(connectionId: string): Promise<void>
  /** Disconnects a live tab, or just drops one that never connected. */
  closeTab(connectionId: string): Promise<void>
  /** Puts the tabs in the given order, as dragged; the order is kept with the workspace. */
  reorderTabs(connectionIds: string[]): void
  /** Folds a tab group up to its label, or opens it again. The tab in front leaves a group as it folds, as in a browser. */
  toggleTabGroup(name: string): void
  /** Called once a live session is closed; the tab goes away. */
  removeSession(sessionId: string): Promise<void>
  removeTab(connectionId: string): Promise<void>
  /** Bring up the connect screen beside the open connections, on a given saved connection if asked. */
  showConnectScreen(selectConnectionId?: string): void
  setConnectSelect(id: string | null): void
  /** Tabs from the previous launch: the one in front reconnects now, the others when opened. */
  restoreWorkspace(state: WorkspaceState): void
  /** Shows a toast for a while; returns its id. */
  toast(kind: Toast['kind'], message: string, detail?: string): number
  dismissToast(id: number): void
}

let initialized = false
let toastSeq = 0
/** The "disconnected" toast showing for a session, taken down once it reconnects. */
const linkToasts = new Map<string, number>()

/** Text as a sentence of its own, ending in a full stop. */
function sentence(text: string): string {
  const t = text.trim()
  return /[.!?…]$/.test(t) ? t : `${t}.`
}

const LAYOUT_KEY = 'queryLayout.v2'
const UI_KEY = 'uiPrefs.v1'

function loadLayout(): LayoutNode {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null')
    if (isValidLayout(parsed)) return parsed
  } catch {
    /* fall through */
  }
  return defaultLayout()
}

const DEFAULT_UI: UiPrefs = { theme: DEFAULT_THEME, syntax: null, codeFont: null, connectionTabs: 'horizontal', keywordCase: 'upper', autocomplete: true, autoAlias: false, acceptKeys: ['Tab', 'Enter'] }

function loadUiPrefs(): UiPrefs {
  try {
    const parsed = JSON.parse(localStorage.getItem(UI_KEY) ?? 'null') ?? {}
    return {
      theme: isThemeId(parsed.theme) ? parsed.theme : DEFAULT_THEME,
      syntax: isSyntaxId(parsed.syntax) ? parsed.syntax : null,
      codeFont: isCodeFontId(parsed.codeFont) ? parsed.codeFont : null,
      connectionTabs: parsed.connectionTabs === 'vertical' ? 'vertical' : 'horizontal',
      keywordCase: parsed.keywordCase === 'lower' || parsed.keywordCase === 'off' ? parsed.keywordCase : 'upper',
      autocomplete: parsed.autocomplete !== false,
      autoAlias: parsed.autoAlias === true,
      acceptKeys: Array.isArray(parsed.acceptKeys) ? parsed.acceptKeys.filter((k: unknown) => ACCEPT_KEY_OPTIONS.some((o) => o.key === k)) : ['Tab', 'Enter']
    }
  } catch {
    return { ...DEFAULT_UI }
  }
}

/** Session stores live outside React state: they are identified by session id and carry functions. */
const sessionStores = new Map<string, SessionStore>()

export function getSessionStore(sessionId: string): SessionStore | undefined {
  return sessionStores.get(sessionId)
}

function tabFromConfig(cfg: ConnectionConfig, profiles: SshProfile[]): Pick<OpenTab, 'connectionId' | 'name' | 'kind' | 'target'> {
  return { connectionId: cfg.id, name: cfg.name, kind: cfg.kind, target: describeTarget(resolveSshProfile(cfg, profiles)) }
}

export const useStore = create<State>()((set, get) => {
  const patchTab = (connectionId: string, patch: Partial<OpenTab>) => set({ tabs: get().tabs.map((t) => (t.connectionId === connectionId ? { ...t, ...patch } : t)) })

  return {
    appInfo: null,
    connections: [],
    groupStyles: {},
    sshProfiles: [],
    sshProfilesLoaded: false,
    tabs: [],
    activeConnectionId: null,
    collapsedTabGroups: [],
    showConnect: false,
    connectSelect: null,
    ui: loadUiPrefs(),
    toasts: [],
    confirmRequest: null,
    settings: null,
    connectors: [],
    instructions: [],
    settingsOpen: false,
    settingsIntent: null,
    queryLayout: loadLayout(),
    chatOpen: localStorage.getItem('askPanelOpen') !== 'false',

    setQueryLayout(layout) {
      set({ queryLayout: layout })
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
      } catch {
        /* storage is optional */
      }
    },

    setChatOpen(open) {
      set({ chatOpen: open })
      try {
        localStorage.setItem('askPanelOpen', String(open))
      } catch {
        /* storage is optional */
      }
    },

    setUiPref(patch) {
      const ui = { ...get().ui, ...patch }
      set({ ui })
      try {
        localStorage.setItem(UI_KEY, JSON.stringify(ui))
      } catch {
        /* storage is optional */
      }
    },

    async loadSettings() {
      try {
        set({ settings: await window.api.settings.get() })
      } catch (e) {
        get().toast('error', 'Could not load settings', errorMessage(e))
      }
    },

    async loadConnectors() {
      try {
        set({ connectors: await window.api.connectors.list() })
      } catch (e) {
        get().toast('error', 'Could not load connectors', errorMessage(e))
      }
    },

    putConnector(info) {
      const list = get().connectors
      set({ connectors: list.some((c) => c.id === info.id) ? list.map((c) => (c.id === info.id ? info : c)) : [...list, info] })
    },

    dropConnector(id) {
      set({ connectors: get().connectors.filter((c) => c.id !== id) })
    },

    async loadInstructions() {
      try {
        set({ instructions: await window.api.instructions.list() })
      } catch (e) {
        get().toast('error', 'Could not load instructions', errorMessage(e))
      }
    },

    putInstruction(instruction) {
      const list = get().instructions
      set({ instructions: list.some((i) => i.id === instruction.id) ? list.map((i) => (i.id === instruction.id ? instruction : i)) : [...list, instruction] })
    },

    dropInstruction(id) {
      set({ instructions: get().instructions.filter((i) => i.id !== id) })
    },

    setSettingsOpen(open, intent) {
      set({ settingsOpen: open, settingsIntent: open ? (intent ?? null) : null })
    },

    confirm(message, detail, confirmLabel = 'OK', destructive = false) {
      get().confirmRequest?.resolve(false)
      return new Promise<boolean>((resolve) => {
        set({ confirmRequest: { message, detail, confirmLabel, destructive, resolve } })
      })
    },

    resolveConfirm(ok) {
      const req = get().confirmRequest
      set({ confirmRequest: null })
      req?.resolve(ok)
    },

    async init() {
      if (initialized) return
      initialized = true
      try {
        const info = await window.api.app.info()
        set({ appInfo: info })
      } catch (e) {
        get().toast('error', 'Could not initialise', errorMessage(e))
      }
      // Profiles and connections arrive together: a connection's profile is checked against the list on select.
      await Promise.all([get().loadSshProfiles(), get().loadConnections()])
      await get().loadSettings()
      await get().loadConnectors()
      await get().loadInstructions()
      window.api.connectors.onStatus((info) => get().putConnector(info))
      // A connection whose link drops by itself stays open where it is; the next call that needs the database reconnects.
      window.api.session.onLink((e) => {
        const tab = get().tabs.find((t) => t.session?.sessionId === e.sessionId)
        if (!tab) return
        const store = sessionStores.get(e.sessionId)
        const shown = linkToasts.get(e.sessionId)
        if (shown !== undefined) {
          linkToasts.delete(e.sessionId)
          get().dismissToast(shown)
        }
        if (e.state === 'dropped') {
          // A transaction left open went with the link.
          const rolledBack = store?.getState().inTransaction ?? false
          store?.getState().setInTransaction(false)
          patchTab(tab.connectionId, { link: 'down', linkMessage: e.reason })
          const detail = `${sentence(e.reason)}${rolledBack ? ' Its open transaction was rolled back.' : ''} It reconnects the next time it is needed.`
          linkToasts.set(e.sessionId, get().toast('warn', `${tab.name} disconnected`, detail))
        } else if (e.state === 'reconnecting') {
          patchTab(tab.connectionId, { link: 'reconnecting', linkMessage: e.message })
        } else if (e.state === 'reconnect-failed') {
          patchTab(tab.connectionId, { link: 'down', linkMessage: e.reason })
        } else {
          store?.getState().setSession(e.info)
          patchTab(tab.connectionId, { link: undefined, linkMessage: undefined, session: e.info })
        }
      })
      window.api.session.onProgress((e) => {
        if (!e.requestId) return
        const tab = get().tabs.find((t) => t.progressId === e.requestId)
        if (tab) patchTab(tab.connectionId, { progress: e.message })
      })
      try {
        const saved = await window.api.workspace.load()
        if (saved) get().restoreWorkspace(saved)
      } catch {
        /* start with nothing open */
      }
      startPersistence()
    },

    async loadConnections() {
      try {
        const [connections, groupStyles] = await Promise.all([window.api.connections.list(), window.api.connections.groupStyles()])
        // A connection may have changed group, and its tab moves to its new group's tabs.
        const groupOf = groupByConnection(connections)
        const { tabs, collapsedTabGroups, activeConnectionId, showConnect } = get()
        set({ connections, groupStyles, tabs: clusterTabs(tabs, groupOf), collapsedTabGroups: settleCollapsed(collapsedTabGroups, tabs, groupOf, showConnect ? null : activeConnectionId) })
      } catch (e) {
        get().toast('error', 'Could not load saved connections', errorMessage(e))
      }
    },

    async loadSshProfiles() {
      try {
        set({ sshProfiles: await window.api.sshProfiles.list(), sshProfilesLoaded: true })
      } catch (e) {
        get().toast('error', 'Could not load SSH profiles', errorMessage(e))
      }
    },

    openSession(info, restore, activate = true) {
      const store = createSessionStore(
        info,
        {
          toast: (kind, message, detail) => get().toast(kind, message, detail),
          confirm: (message, detail, label, destructive) => get().confirm(message, detail, label, destructive),
          remove: (sessionId) => get().removeSession(sessionId)
        },
        restore
      )
      sessionStores.set(info.sessionId, store)
      watchSessionStore(store)
      const live: OpenTab = { connectionId: info.connectionId, name: info.name, kind: info.kind, target: info.target, status: 'live', session: info }
      const { tabs, collapsedTabGroups } = get()
      const groupOf = groupByConnection(get().connections)
      const idx = tabs.findIndex((t) => t.connectionId === info.connectionId)
      set({
        // A new tab joins the end of its group's tabs, or of the strip.
        tabs: idx >= 0 ? tabs.map((t, i) => (i === idx ? live : t)) : clusterTabs([...tabs, live], groupOf),
        ...(activate ? { activeConnectionId: info.connectionId, showConnect: false, collapsedTabGroups: settleCollapsed(collapsedTabGroups, [...tabs, live], groupOf, info.connectionId) } : {})
      })
      void store.getState().refreshSchema()
    },

    activateTab(connectionId) {
      const { tabs, connections, collapsedTabGroups } = get()
      const tab = tabs.find((t) => t.connectionId === connectionId)
      if (!tab) return
      // Brought to the front from a collapsed group, the tab opens its group.
      set({ activeConnectionId: connectionId, showConnect: false, collapsedTabGroups: settleCollapsed(collapsedTabGroups, tabs, groupByConnection(connections), connectionId) })
      if (tab.status === 'pending' || tab.status === 'error') void get().connectTab(connectionId)
    },

    async connectTab(connectionId) {
      const tab = get().tabs.find((t) => t.connectionId === connectionId)
      if (!tab || tab.status === 'live' || tab.status === 'connecting') return
      let cfg = get().connections.find((c) => c.id === connectionId)
      if (!cfg) {
        await get().loadConnections()
        cfg = get().connections.find((c) => c.id === connectionId)
      }
      if (!cfg) {
        patchTab(connectionId, { status: 'error', error: 'This saved connection no longer exists.' })
        return
      }
      const requestId = crypto.randomUUID()
      patchTab(connectionId, { status: 'connecting', error: undefined, progress: '', progressId: requestId })
      try {
        const info = await window.api.session.open(cfg, { openDatabase: true, requestId })
        if (!get().tabs.some((t) => t.connectionId === connectionId)) {
          // Closed while it was connecting.
          void window.api.session.close(info.sessionId)
          return
        }
        get().openSession(info, tab.restore, false)
      } catch (e) {
        patchTab(connectionId, { status: 'error', error: errorMessage(e), progress: undefined })
      }
    },

    async closeTab(connectionId) {
      const tab = get().tabs.find((t) => t.connectionId === connectionId)
      if (!tab) return
      if (tab.status === 'live' && tab.session) {
        const store = sessionStores.get(tab.session.sessionId)
        if (store) {
          await store.getState().disconnect()
          return
        }
      }
      await get().removeTab(connectionId)
    },

    reorderTabs(connectionIds) {
      const { tabs, connections } = get()
      const byId = new Map(tabs.map((t) => [t.connectionId, t]))
      const next = connectionIds.flatMap((id) => byId.get(id) ?? [])
      if (next.length !== tabs.length || new Set(next).size !== tabs.length) return
      set({ tabs: clusterTabs(next, groupByConnection(connections)) })
    },

    toggleTabGroup(name) {
      const { tabs, connections, collapsedTabGroups, activeConnectionId, showConnect } = get()
      if (collapsedTabGroups.includes(name)) return set({ collapsedTabGroups: collapsedTabGroups.filter((n) => n !== name) })
      const groupOf = groupByConnection(connections)
      const members = tabs.flatMap((t, i) => (groupOf.get(t.connectionId) === name ? [i] : []))
      if (!members.length) return
      const collapsed = [...collapsedTabGroups, name]
      set({ collapsedTabGroups: collapsed })
      if (showConnect || !activeConnectionId || groupOf.get(activeConnectionId) !== name) return
      // The tab in front does not fold away with its group: the nearest tab in sight takes over, or with none left, the
      // connect screen, where a browser would open a new tab.
      const inSight = nearestTab(tabs, members[members.length - 1] + 1, members[0] - 1, (t) => !collapsed.includes(groupOf.get(t.connectionId) ?? ''))
      if (inSight) get().activateTab(inSight.connectionId)
      else get().showConnectScreen()
    },

    async removeSession(sessionId) {
      sessionStores.get(sessionId)?.getState().markClosed()
      sessionStores.delete(sessionId)
      linkToasts.delete(sessionId)
      const tab = get().tabs.find((t) => t.session?.sessionId === sessionId)
      if (tab) await get().removeTab(tab.connectionId)
    },

    async removeTab(connectionId) {
      const { tabs, activeConnectionId, connections, collapsedTabGroups } = get()
      const idx = tabs.findIndex((t) => t.connectionId === connectionId)
      if (idx < 0) return
      const next = tabs.filter((t) => t.connectionId !== connectionId)
      const groupOf = groupByConnection(connections)
      let active = activeConnectionId
      // The nearest tab in sight takes the front; with only collapsed groups left, the connect screen does.
      let onlyCollapsed = false
      if (active === connectionId) {
        active = nearestTab(next, idx, idx - 1, (t) => !collapsedTabGroups.includes(groupOf.get(t.connectionId) ?? ''))?.connectionId ?? null
        onlyCollapsed = !active && next.length > 0
      }
      // With nothing left open, the connect screen appears; refresh the list first so it opens on the most recent connection.
      if (!next.length) await get().loadConnections()
      const showConnect = next.length ? onlyCollapsed || get().showConnect : false
      set({
        tabs: next,
        activeConnectionId: active,
        showConnect,
        collapsedTabGroups: settleCollapsed(get().collapsedTabGroups, next, groupOf, showConnect ? null : active)
      })
      // A neighbour that never connected does so now that it is in front.
      if (active && active !== activeConnectionId && !get().showConnect) {
        const neighbour = next.find((t) => t.connectionId === active)
        if (neighbour && (neighbour.status === 'pending' || neighbour.status === 'error')) void get().connectTab(active)
      }
    },

    showConnectScreen(selectConnectionId) {
      set({ showConnect: true, connectSelect: selectConnectionId ?? null })
    },

    setConnectSelect(id) {
      set({ connectSelect: id })
    },

    restoreWorkspace(state) {
      const { connections, sshProfiles } = get()
      const tabs: OpenTab[] = []
      for (const saved of state.connections) {
        const cfg = connections.find((c) => c.id === saved.connectionId)
        if (!cfg || tabs.some((t) => t.connectionId === saved.connectionId)) continue
        tabs.push({ ...tabFromConfig(cfg, sshProfiles), status: 'pending', session: null, restore: saved })
      }
      if (!tabs.length) return
      const groupOf = groupByConnection(connections)
      const ordered = clusterTabs(tabs, groupOf)
      const active = ordered.some((t) => t.connectionId === state.activeConnectionId) ? state.activeConnectionId : ordered[0].connectionId
      const saved = Array.isArray(state.collapsedGroups) ? state.collapsedGroups.filter((n): n is string => typeof n === 'string') : []
      set({
        tabs: ordered,
        activeConnectionId: active,
        showConnect: Boolean(state.showConnect),
        collapsedTabGroups: settleCollapsed(saved, ordered, groupOf, state.showConnect ? null : active)
      })
      if (!state.showConnect && active) void get().connectTab(active)
    },

    toast(kind, message, detail) {
      const id = ++toastSeq
      set({ toasts: [...get().toasts, { id, kind, message, detail }] })
      setTimeout(() => get().dismissToast(id), kind === 'error' || kind === 'warn' ? 12_000 : 4_500)
      return id
    },

    dismissToast(id) {
      const current = get().toasts.find((t) => t.id === id)
      if (!current || current.leaving) return
      set({ toasts: get().toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) })
      setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), 160)
    }
  }
})

// ---------------------------------------------------------------------------
// Keeping the workspace between launches
// ---------------------------------------------------------------------------

let persistenceOn = false
let persistTimer: ReturnType<typeof setTimeout> | null = null
let lastSaved = ''

/** Everything worth bringing back next time: the tabs, and for live ones their query tabs as they stand. */
export function snapshotWorkspace(): WorkspaceState {
  const { tabs, activeConnectionId, showConnect, collapsedTabGroups } = useStore.getState()
  return {
    version: 1,
    activeConnectionId,
    showConnect,
    collapsedGroups: collapsedTabGroups,
    connections: tabs.map((t) => {
      const store = t.session ? sessionStores.get(t.session.sessionId) : undefined
      return store ? snapshotSession(store.getState()) : (t.restore ?? { connectionId: t.connectionId, activeTabId: null, queryCounter: 0, tabs: [] })
    })
  }
}

function schedulePersist(): void {
  if (!persistenceOn) return
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    void persistNow()
  }, 400)
}

async function persistNow(): Promise<void> {
  const state = snapshotWorkspace()
  const json = JSON.stringify(state)
  if (json === lastSaved) return
  lastSaved = json
  try {
    await window.api.workspace.save(state)
  } catch {
    /* the next change tries again */
  }
}

function watchSessionStore(store: SessionStore): void {
  store.subscribe((next, prev) => {
    if (next.tabs !== prev.tabs || next.activeTabId !== prev.activeTabId || next.querySnapshots !== prev.querySnapshots || next.queryCounter !== prev.queryCounter) schedulePersist()
  })
}

function startPersistence(): void {
  if (persistenceOn) return
  persistenceOn = true
  useStore.subscribe((next, prev) => {
    if (next.tabs !== prev.tabs || next.activeConnectionId !== prev.activeConnectionId || next.showConnect !== prev.showConnect || next.collapsedTabGroups !== prev.collapsedTabGroups) schedulePersist()
  })
  // The window is closing: write whatever the debounce has not written yet, synchronously on the other side.
  window.addEventListener('beforeunload', () => {
    if (persistTimer) clearTimeout(persistTimer)
    const state = snapshotWorkspace()
    const json = JSON.stringify(state)
    if (json !== lastSaved) {
      lastSaved = json
      window.api.workspace.flush(state)
    }
  })
}
