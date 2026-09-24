import { create } from 'zustand'
import type { AppInfo, ConnectionConfig, DatabaseKind, GroupStyle, SessionInfo, SshProfile, WorkspaceConnection, WorkspaceState } from '@shared/types'
import type { AiSettings, ProviderId } from '@shared/ai'
import { describeTarget, resolveSshProfile } from '@shared/connections'
import { errorMessage } from './lib/util'
import { defaultLayout, isValidLayout, type LayoutNode } from './lib/layout'
import { createSessionStore, snapshotSession, type SessionStore } from './session-store'
import { ACCEPT_KEY_OPTIONS, type KeywordCase } from './lib/sql-complete'

export type { Tab, SearchState } from './session-store'

export type SettingsTab = 'appearance' | 'editor' | 'ai'

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
  color?: string
  target: string
  status: OpenTabStatus
  session: SessionInfo | null
  error?: string
  /** The latest progress line while connecting. */
  progress?: string
  progressId?: string
  /** Tabs to bring back once the connection is made. */
  restore?: WorkspaceConnection
}

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
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
  /** Connection tabs in order. A live one has a session store of its own; see getSessionStore. */
  tabs: OpenTab[]
  activeConnectionId: string | null
  /** Show the connect screen although connections are open: the "+" tab. */
  showConnect: boolean
  /** A saved connection the connect screen should open on next, e.g. after "Edit connection" on a failed tab. */
  connectSelect: string | null
  ui: UiPrefs
  toasts: Toast[]
  confirmRequest: ConfirmRequest | null
  settings: AiSettings | null
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
  /** Called once a live session is closed; the tab goes away. */
  removeSession(sessionId: string): Promise<void>
  removeTab(connectionId: string): Promise<void>
  /** Bring up the connect screen beside the open connections, on a given saved connection if asked. */
  showConnectScreen(selectConnectionId?: string): void
  setConnectSelect(id: string | null): void
  /** Tabs from the previous launch: the one in front reconnects now, the others when opened. */
  restoreWorkspace(state: WorkspaceState): void
  toast(kind: Toast['kind'], message: string, detail?: string): void
  dismissToast(id: number): void
}

let initialized = false
let toastSeq = 0

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

const DEFAULT_UI: UiPrefs = { connectionTabs: 'horizontal', keywordCase: 'upper', autocomplete: true, autoAlias: false, acceptKeys: ['Tab', 'Enter'] }

function loadUiPrefs(): UiPrefs {
  try {
    const parsed = JSON.parse(localStorage.getItem(UI_KEY) ?? 'null') ?? {}
    return {
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

function tabFromConfig(cfg: ConnectionConfig, profiles: SshProfile[]): Pick<OpenTab, 'connectionId' | 'name' | 'kind' | 'color' | 'target'> {
  return { connectionId: cfg.id, name: cfg.name, kind: cfg.kind, color: cfg.color, target: describeTarget(resolveSshProfile(cfg, profiles)) }
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
    showConnect: false,
    connectSelect: null,
    ui: loadUiPrefs(),
    toasts: [],
    confirmRequest: null,
    settings: null,
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
      window.api.session.onClosed((e) => {
        const gone = get().tabs.find((t) => t.session?.sessionId === e.sessionId)
        if (!gone) return
        get().toast('error', `${gone.name} was disconnected`, e.reason)
        void get().removeSession(e.sessionId)
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
        set({ connections, groupStyles })
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
      const live: OpenTab = { connectionId: info.connectionId, name: info.name, kind: info.kind, color: info.color, target: info.target, status: 'live', session: info }
      const tabs = get().tabs
      const idx = tabs.findIndex((t) => t.connectionId === info.connectionId)
      set({
        tabs: idx >= 0 ? tabs.map((t, i) => (i === idx ? live : t)) : [...tabs, live],
        ...(activate ? { activeConnectionId: info.connectionId, showConnect: false } : {})
      })
      void store.getState().refreshSchema()
    },

    activateTab(connectionId) {
      const tab = get().tabs.find((t) => t.connectionId === connectionId)
      if (!tab) return
      set({ activeConnectionId: connectionId, showConnect: false })
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

    async removeSession(sessionId) {
      sessionStores.get(sessionId)?.getState().markClosed()
      sessionStores.delete(sessionId)
      const tab = get().tabs.find((t) => t.session?.sessionId === sessionId)
      if (tab) await get().removeTab(tab.connectionId)
    },

    async removeTab(connectionId) {
      const { tabs, activeConnectionId } = get()
      const idx = tabs.findIndex((t) => t.connectionId === connectionId)
      if (idx < 0) return
      const next = tabs.filter((t) => t.connectionId !== connectionId)
      let active = activeConnectionId
      if (active === connectionId) active = next[Math.min(idx, next.length - 1)]?.connectionId ?? null
      // With nothing left open, the connect screen appears; refresh the list first so it opens on the most recent connection.
      if (!next.length) await get().loadConnections()
      set({ tabs: next, activeConnectionId: active, showConnect: next.length ? get().showConnect : false })
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
      const active = tabs.some((t) => t.connectionId === state.activeConnectionId) ? state.activeConnectionId : tabs[0].connectionId
      set({ tabs, activeConnectionId: active, showConnect: Boolean(state.showConnect) })
      if (!state.showConnect && active) void get().connectTab(active)
    },

    toast(kind, message, detail) {
      const id = ++toastSeq
      set({ toasts: [...get().toasts, { id, kind, message, detail }] })
      setTimeout(() => get().dismissToast(id), kind === 'error' ? 12_000 : 4_500)
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
  const { tabs, activeConnectionId, showConnect } = useStore.getState()
  return {
    version: 1,
    activeConnectionId,
    showConnect,
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
    if (next.tabs !== prev.tabs || next.activeConnectionId !== prev.activeConnectionId || next.showConnect !== prev.showConnect) schedulePersist()
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
