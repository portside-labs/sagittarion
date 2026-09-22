import { create } from 'zustand'
import type { AppInfo, Catalog, ConnectionConfig, ObjectKind, ObjectRef, SearchResult, SessionInfo, TableRef } from '@shared/types'
import type { AiSettings } from '@shared/ai'
import { sameTable, tableKey, tableLabel } from '@shared/connections'
import { errorMessage } from './lib/util'
import { appendNames, emptyNames, groupKey, type GroupState, type NameIndex, type TableState } from './lib/tree'

export type Tab =
  | { id: string; kind: 'table'; schema?: string; table: string; title: string }
  | { id: string; kind: 'query'; title: string; initialSql: string }

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  message: string
  detail?: string
}

export interface ConfirmRequest {
  message: string
  detail?: string
  confirmLabel: string
  destructive: boolean
  resolve: (ok: boolean) => void
}

export interface SearchState {
  query: string
  result: SearchResult | null
  loading: boolean
}

/** How many table detail records the sidebar keeps around. */
const TABLE_CACHE_LIMIT = 300
const NAMES_PAGE = 4000

interface State {
  appInfo: AppInfo | null
  connections: ConnectionConfig[]
  session: SessionInfo | null
  /** Schema names and counts; the rest of the tree loads on demand. */
  catalog: Catalog | null
  catalogError: string | null
  catalogLoading: boolean
  /** Every table and view name, streamed in pages right after the catalog. */
  names: NameIndex
  /** Lazily loaded index, trigger and function lists, keyed by groupKey. */
  groups: Record<string, GroupState>
  /** Column details for expanded or opened tables, keyed by tableKey. */
  tables: Record<string, TableState>
  search: SearchState
  tabs: Tab[]
  activeTabId: string | null
  dirtyTabs: Record<string, boolean>
  toasts: Toast[]
  confirmRequest: ConfirmRequest | null
  inTransaction: boolean
  status: string
  queryCounter: number
  settings: AiSettings | null
  settingsOpen: boolean

  init(): Promise<void>
  loadSettings(): Promise<void>
  setSettingsOpen(open: boolean): void
  confirm(message: string, detail?: string, confirmLabel?: string, destructive?: boolean): Promise<boolean>
  resolveConfirm(ok: boolean): void
  loadConnections(): Promise<void>
  setSession(s: SessionInfo | null): void
  /** Reload the catalog and restart the name stream; drops every cached list. */
  refreshSchema(): Promise<void>
  loadNames(sessionId: string, epoch: number): Promise<void>
  loadGroup(schema: string | undefined, kind: ObjectKind, more?: boolean): Promise<void>
  loadTable(ref: TableRef): Promise<void>
  runSearch(query: string): Promise<void>
  openDefinition(ref: ObjectRef): Promise<void>
  openTable(ref: TableRef): void
  newQueryTab(sql?: string, title?: string): void
  closeTab(id: string): Promise<void>
  setActiveTab(id: string): void
  setTabDirty(id: string, dirty: boolean): void
  disconnect(): Promise<void>
  toast(kind: Toast['kind'], message: string, detail?: string): void
  dismissToast(id: number): void
  setInTransaction(v: boolean): void
  setStatus(text: string): void
}

let initialized = false
let toastSeq = 0
let namesEpoch = 0

const emptySearch: SearchState = { query: '', result: null, loading: false }

const emptySession = {
  session: null,
  catalog: null,
  catalogError: null,
  catalogLoading: false,
  names: emptyNames(),
  groups: {} as Record<string, GroupState>,
  tables: {} as Record<string, TableState>,
  search: emptySearch,
  tabs: [] as Tab[],
  activeTabId: null,
  dirtyTabs: {} as Record<string, boolean>,
  inTransaction: false,
  status: '',
  queryCounter: 0
}

export const useStore = create<State>()((set, get) => ({
  appInfo: null,
  connections: [],
  ...emptySession,
  toasts: [],
  confirmRequest: null,
  settings: null,
  settingsOpen: false,

  async loadSettings() {
    try {
      set({ settings: await window.api.settings.get() })
    } catch (e) {
      get().toast('error', 'Could not load settings', errorMessage(e))
    }
  },

  setSettingsOpen(open) {
    set({ settingsOpen: open })
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
    await get().loadConnections()
    await get().loadSettings()
    window.api.session.onClosed((e) => {
      const s = get().session
      if (s && s.sessionId === e.sessionId) {
        get().toast('error', 'Connection closed', e.reason)
        set({ ...emptySession })
        void get().loadConnections()
      }
    })
  },

  async loadConnections() {
    try {
      set({ connections: await window.api.connections.list() })
    } catch (e) {
      get().toast('error', 'Could not load saved connections', errorMessage(e))
    }
  },

  setSession(session) {
    set({ ...emptySession, session })
  },

  async refreshSchema() {
    const session = get().session
    if (!session) return
    const epoch = ++namesEpoch
    set({ catalogLoading: true, catalogError: null, groups: {}, tables: {}, search: emptySearch })
    try {
      const catalog = await window.api.db.catalog(session.sessionId)
      if (get().session?.sessionId !== session.sessionId || epoch !== namesEpoch) return
      set({ catalog, catalogLoading: false, names: emptyNames(epoch, catalog.totalTables) })
      void get().loadNames(session.sessionId, epoch)
    } catch (e) {
      set({ catalogError: errorMessage(e), catalogLoading: false })
    }
  },

  async loadNames(sessionId, epoch) {
    let cursor: string | null = null
    try {
      do {
        const page = await window.api.db.listObjects(sessionId, { kinds: ['table', 'view'], cursor, limit: NAMES_PAGE })
        const cur = get()
        if (cur.session?.sessionId !== sessionId || cur.names.epoch !== epoch) return
        cursor = page.cursor
        set({ names: appendNames(cur.names, page.items, cursor === null) })
      } while (cursor)
    } catch (e) {
      const cur = get()
      if (cur.session?.sessionId !== sessionId || cur.names.epoch !== epoch) return
      cur.toast('error', 'Could not list tables', errorMessage(e))
      set({ names: { ...cur.names, complete: true } })
    }
  },

  async loadGroup(schema, kind, more = false) {
    const session = get().session
    if (!session) return
    const key = groupKey(schema ?? '', kind)
    const existing = get().groups[key]
    if (existing?.loading) return
    if (existing && !more) return
    if (more && !existing?.cursor) return
    set({ groups: { ...get().groups, [key]: { items: existing?.items ?? [], cursor: existing?.cursor ?? null, loading: true, error: null } } })
    try {
      const page = await window.api.db.listObjects(session.sessionId, { schema, kinds: [kind], cursor: more ? existing!.cursor : null, limit: 1000 })
      if (get().session?.sessionId !== session.sessionId) return
      const prev = get().groups[key]
      if (!prev) return
      set({ groups: { ...get().groups, [key]: { items: more ? [...prev.items, ...page.items] : page.items, cursor: page.cursor, loading: false, error: null } } })
    } catch (e) {
      if (get().session?.sessionId !== session.sessionId) return
      set({ groups: { ...get().groups, [key]: { items: existing?.items ?? [], cursor: null, loading: false, error: errorMessage(e) } } })
    }
  },

  async loadTable(ref) {
    const session = get().session
    if (!session) return
    const key = tableKey(ref)
    if (get().tables[key]) return
    set({ tables: { ...get().tables, [key]: { status: 'loading' } } })
    try {
      const details = await window.api.db.tableDetails(session.sessionId, ref)
      if (get().session?.sessionId !== session.sessionId) return
      const next: Record<string, TableState> = { ...get().tables, [key]: { status: 'ready', details } }
      const keys = Object.keys(next)
      if (keys.length > TABLE_CACHE_LIMIT) for (const k of keys.slice(0, keys.length - TABLE_CACHE_LIMIT)) if (k !== key) delete next[k]
      set({ tables: next })
    } catch (e) {
      if (get().session?.sessionId !== session.sessionId) return
      set({ tables: { ...get().tables, [key]: { status: 'error', error: errorMessage(e) } } })
    }
  },

  async runSearch(query) {
    const session = get().session
    const q = query.trim()
    if (!session || q.length < 2) {
      if (get().search.query !== q || get().search.result) set({ search: { query: q, result: null, loading: false } })
      return
    }
    if (get().search.query === q && (get().search.result || get().search.loading)) return
    set({ search: { query: q, result: get().search.result, loading: true } })
    try {
      const result = await window.api.db.searchObjects(session.sessionId, q, 200)
      if (get().session?.sessionId !== session.sessionId || get().search.query !== q) return
      set({ search: { query: q, result, loading: false } })
    } catch (e) {
      if (get().search.query !== q) return
      set({ search: { query: q, result: null, loading: false } })
      get().toast('error', 'Search failed', errorMessage(e))
    }
  },

  async openDefinition(ref) {
    const session = get().session
    if (!session) return
    try {
      const def = await window.api.db.definition(session.sessionId, ref)
      const sql = def.sql?.trim()
      get().newQueryTab(sql ? (sql.endsWith(';') ? sql : `${sql};`) : `-- No definition available for ${ref.name}`, ref.name)
    } catch (e) {
      get().toast('error', `Could not load ${ref.name}`, errorMessage(e))
    }
  },

  openTable(ref) {
    const { tabs, catalog } = get()
    const existing = tabs.find((t) => t.kind === 'table' && sameTable({ schema: t.schema, name: t.table }, ref))
    if (existing) {
      set({ activeTabId: existing.id })
      return
    }
    const tab: Tab = {
      id: crypto.randomUUID(),
      kind: 'table',
      schema: ref.schema,
      table: ref.name,
      title: tableLabel(ref, catalog?.defaultSchema)
    }
    set({ tabs: [...tabs, tab], activeTabId: tab.id })
  },

  newQueryTab(sql = '', title) {
    const n = get().queryCounter + 1
    const tab: Tab = { id: crypto.randomUUID(), kind: 'query', title: title ?? `Query ${n}`, initialSql: sql }
    set({ tabs: [...get().tabs, tab], activeTabId: tab.id, queryCounter: n })
  },

  async closeTab(id) {
    const { dirtyTabs } = get()
    if (dirtyTabs[id]) {
      const ok = await get().confirm('Discard staged changes?', 'This tab has edits that have not been applied to the database.', 'Discard', true)
      if (!ok) return
    }
    const { tabs, activeTabId } = get()
    const idx = tabs.findIndex((t) => t.id === id)
    if (idx < 0) return
    const next = tabs.filter((t) => t.id !== id)
    let active = activeTabId
    if (active === id) active = next[Math.min(idx, next.length - 1)]?.id ?? null
    const rest = { ...get().dirtyTabs }
    delete rest[id]
    set({ tabs: next, activeTabId: active, dirtyTabs: rest })
  },

  setActiveTab(id) {
    set({ activeTabId: id })
  },

  setTabDirty(id, dirty) {
    const current = get().dirtyTabs
    if (Boolean(current[id]) === dirty) return
    set({ dirtyTabs: { ...current, [id]: dirty } })
  },

  async disconnect() {
    const { session, dirtyTabs } = get()
    if (!session) return
    if (Object.values(dirtyTabs).some(Boolean)) {
      const ok = await get().confirm('Disconnect and discard staged changes?', 'Some tabs have edits that have not been applied to the database.', 'Disconnect', true)
      if (!ok) return
    }
    try {
      await window.api.session.close(session.sessionId)
    } catch {
      /* already gone */
    }
    set({ ...emptySession })
    await get().loadConnections()
  },

  toast(kind, message, detail) {
    const id = ++toastSeq
    set({ toasts: [...get().toasts, { id, kind, message, detail }] })
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 12_000 : 4_500)
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) })
  },

  setInTransaction(v) {
    if (get().inTransaction !== v) set({ inTransaction: v })
  },

  setStatus(text) {
    set({ status: text })
  }
}))
