import { createContext, useContext } from 'react'
import { useStore as useZustandStore } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { Catalog, ObjectKind, ObjectRef, QueryTabSnapshot, SearchResult, SessionInfo, TableRef, WorkspaceConnection } from '@shared/types'
import { sameTable, tableKey, tableLabel } from '@shared/connections'
import { errorMessage } from './lib/util'
import { appendNames, emptyNames, groupKey, type GroupState, type NameIndex, type TableState } from './lib/tree'

export type Tab =
  | { id: string; kind: 'table'; schema?: string; table: string; title: string }
  | { id: string; kind: 'query'; title: string; initialSql: string }

export interface SearchState {
  query: string
  result: SearchResult | null
  loading: boolean
}

/** How many table detail records the sidebar keeps around. */
const TABLE_CACHE_LIMIT = 300
const NAMES_PAGE = 4000
const emptySearch: SearchState = { query: '', result: null, loading: false }

/** Everything the app knows about one open connection. Every open connection has a store of its own. */
export interface SessionState {
  session: SessionInfo
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
  inTransaction: boolean
  status: string
  queryCounter: number
  /** What each query tab holds, kept so the tab reopens as it was after a restart. */
  querySnapshots: Record<string, QueryTabSnapshot>

  updateQuerySnapshot(tabId: string, patch: Partial<QueryTabSnapshot>): void
  /** Reload the catalog and restart the name stream; drops every cached list. */
  refreshSchema(): Promise<void>
  loadNames(epoch: number): Promise<void>
  loadGroup(schema: string | undefined, kind: ObjectKind, more?: boolean): Promise<void>
  loadTable(ref: TableRef): Promise<void>
  runSearch(query: string): Promise<void>
  openDefinition(ref: ObjectRef): Promise<void>
  openTable(ref: TableRef): void
  newQueryTab(sql?: string, title?: string): void
  closeTab(id: string): Promise<void>
  setActiveTab(id: string): void
  setTabDirty(id: string, dirty: boolean): void
  setInTransaction(v: boolean): void
  setStatus(text: string): void
  /** Close the connection, after confirming when edits are staged, and drop it from the app. */
  disconnect(): Promise<void>
  /** The server side is gone already: stop any work still in flight. */
  markClosed(): void
}

/** What a session store needs from the rest of the app. */
export interface SessionDeps {
  toast(kind: 'info' | 'success' | 'error', message: string, detail?: string): void
  confirm(message: string, detail?: string, confirmLabel?: string, destructive?: boolean): Promise<boolean>
  /** Takes the session out of the app once it is closed. */
  remove(sessionId: string): Promise<void>
}

export type SessionStore = StoreApi<SessionState>

/** Tabs and query snapshots from a previous launch, ready for a fresh session store. */
function restoreTabs(saved: WorkspaceConnection): { tabs: Tab[]; activeTabId: string | null; snapshots: Record<string, QueryTabSnapshot> } {
  const tabs: Tab[] = []
  const snapshots: Record<string, QueryTabSnapshot> = {}
  for (const t of saved.tabs) {
    if (t.kind === 'table') tabs.push({ id: t.id, kind: 'table', schema: t.schema, table: t.table, title: t.title })
    else {
      tabs.push({ id: t.id, kind: 'query', title: t.title, initialSql: t.snapshot.sql })
      snapshots[t.id] = t.snapshot
    }
  }
  const activeTabId = tabs.some((t) => t.id === saved.activeTabId) ? saved.activeTabId : (tabs[tabs.length - 1]?.id ?? null)
  return { tabs, activeTabId, snapshots }
}

/** The part of a session that is worth keeping between launches. */
export function snapshotSession(state: SessionState): WorkspaceConnection {
  return {
    connectionId: state.session.connectionId,
    activeTabId: state.activeTabId,
    queryCounter: state.queryCounter,
    tabs: state.tabs.map((t) =>
      t.kind === 'table'
        ? { id: t.id, kind: 'table', schema: t.schema, table: t.table, title: t.title }
        : { id: t.id, kind: 'query', title: t.title, snapshot: state.querySnapshots[t.id] ?? { sql: t.initialSql, limit: 1000 } }
    )
  }
}

export function createSessionStore(session: SessionInfo, deps: SessionDeps, restore?: WorkspaceConnection): SessionStore {
  const id = session.sessionId
  let namesEpoch = 0
  let closed = false
  const restored = restore ? restoreTabs(restore) : null
  return createStore<SessionState>()((set, get) => ({
    session,
    catalog: null,
    catalogError: null,
    catalogLoading: false,
    names: emptyNames(),
    groups: {},
    tables: {},
    search: emptySearch,
    tabs: restored?.tabs ?? [],
    activeTabId: restored?.activeTabId ?? null,
    dirtyTabs: {},
    inTransaction: false,
    status: '',
    queryCounter: restore?.queryCounter ?? 0,
    querySnapshots: restored?.snapshots ?? {},

    updateQuerySnapshot(tabId, patch) {
      const current = get().querySnapshots
      set({ querySnapshots: { ...current, [tabId]: { ...(current[tabId] ?? { sql: '', limit: 1000 }), ...patch } } })
    },

    async refreshSchema() {
      if (closed) return
      const epoch = ++namesEpoch
      set({ catalogLoading: true, catalogError: null, groups: {}, tables: {}, search: emptySearch })
      try {
        const catalog = await window.api.db.catalog(id)
        if (closed || epoch !== namesEpoch) return
        set({ catalog, catalogLoading: false, names: emptyNames(epoch, catalog.totalTables) })
        void get().loadNames(epoch)
      } catch (e) {
        if (closed) return
        set({ catalogError: errorMessage(e), catalogLoading: false })
      }
    },

    async loadNames(epoch) {
      let cursor: string | null = null
      try {
        do {
          const page = await window.api.db.listObjects(id, { kinds: ['table', 'view'], cursor, limit: NAMES_PAGE })
          const cur = get()
          if (closed || cur.names.epoch !== epoch) return
          cursor = page.cursor
          set({ names: appendNames(cur.names, page.items, cursor === null) })
        } while (cursor)
      } catch (e) {
        const cur = get()
        if (closed || cur.names.epoch !== epoch) return
        deps.toast('error', 'Could not list tables', errorMessage(e))
        set({ names: { ...cur.names, complete: true } })
      }
    },

    async loadGroup(schema, kind, more = false) {
      if (closed) return
      const key = groupKey(schema ?? '', kind)
      const existing = get().groups[key]
      if (existing?.loading) return
      if (existing && !more) return
      if (more && !existing?.cursor) return
      set({ groups: { ...get().groups, [key]: { items: existing?.items ?? [], cursor: existing?.cursor ?? null, loading: true, error: null } } })
      try {
        const page = await window.api.db.listObjects(id, { schema, kinds: [kind], cursor: more ? existing!.cursor : null, limit: 1000 })
        if (closed) return
        const prev = get().groups[key]
        if (!prev) return
        set({ groups: { ...get().groups, [key]: { items: more ? [...prev.items, ...page.items] : page.items, cursor: page.cursor, loading: false, error: null } } })
      } catch (e) {
        if (closed) return
        set({ groups: { ...get().groups, [key]: { items: existing?.items ?? [], cursor: null, loading: false, error: errorMessage(e) } } })
      }
    },

    async loadTable(ref) {
      if (closed) return
      const key = tableKey(ref)
      if (get().tables[key]) return
      set({ tables: { ...get().tables, [key]: { status: 'loading' } } })
      try {
        const details = await window.api.db.tableDetails(id, ref)
        if (closed) return
        const next: Record<string, TableState> = { ...get().tables, [key]: { status: 'ready', details } }
        const keys = Object.keys(next)
        if (keys.length > TABLE_CACHE_LIMIT) for (const k of keys.slice(0, keys.length - TABLE_CACHE_LIMIT)) if (k !== key) delete next[k]
        set({ tables: next })
      } catch (e) {
        if (closed) return
        set({ tables: { ...get().tables, [key]: { status: 'error', error: errorMessage(e) } } })
      }
    },

    async runSearch(query) {
      const q = query.trim()
      if (closed || q.length < 2) {
        if (get().search.query !== q || get().search.result) set({ search: { query: q, result: null, loading: false } })
        return
      }
      if (get().search.query === q && (get().search.result || get().search.loading)) return
      set({ search: { query: q, result: get().search.result, loading: true } })
      try {
        const result = await window.api.db.searchObjects(id, q, 200)
        if (closed || get().search.query !== q) return
        set({ search: { query: q, result, loading: false } })
      } catch (e) {
        if (get().search.query !== q) return
        set({ search: { query: q, result: null, loading: false } })
        deps.toast('error', 'Search failed', errorMessage(e))
      }
    },

    async openDefinition(ref) {
      if (closed) return
      try {
        const def = await window.api.db.definition(id, ref)
        const sql = def.sql?.trim()
        get().newQueryTab(sql ? (sql.endsWith(';') ? sql : `${sql};`) : `-- No definition available for ${ref.name}`, ref.name)
      } catch (e) {
        deps.toast('error', `Could not load ${ref.name}`, errorMessage(e))
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

    async closeTab(tabId) {
      const { dirtyTabs } = get()
      if (dirtyTabs[tabId]) {
        const ok = await deps.confirm('Discard staged changes?', 'This tab has edits that have not been applied to the database.', 'Discard', true)
        if (!ok) return
      }
      const { tabs, activeTabId } = get()
      const idx = tabs.findIndex((t) => t.id === tabId)
      if (idx < 0) return
      const next = tabs.filter((t) => t.id !== tabId)
      let active = activeTabId
      if (active === tabId) active = next[Math.min(idx, next.length - 1)]?.id ?? null
      const rest = { ...get().dirtyTabs }
      delete rest[tabId]
      const snapshots = { ...get().querySnapshots }
      delete snapshots[tabId]
      set({ tabs: next, activeTabId: active, dirtyTabs: rest, querySnapshots: snapshots })
    },

    setActiveTab(tabId) {
      set({ activeTabId: tabId })
    },

    setTabDirty(tabId, dirty) {
      const current = get().dirtyTabs
      if (Boolean(current[tabId]) === dirty) return
      set({ dirtyTabs: { ...current, [tabId]: dirty } })
    },

    setInTransaction(v) {
      if (get().inTransaction !== v) set({ inTransaction: v })
    },

    setStatus(text) {
      set({ status: text })
    },

    async disconnect() {
      if (closed) return
      if (Object.values(get().dirtyTabs).some(Boolean)) {
        const ok = await deps.confirm('Disconnect and discard staged changes?', 'Some tabs have edits that have not been applied to the database.', 'Disconnect', true)
        if (!ok) return
      }
      closed = true
      try {
        await window.api.session.close(id)
      } catch {
        /* already gone */
      }
      await deps.remove(id)
    },

    markClosed() {
      closed = true
    }
  }))
}

export const SessionContext = createContext<SessionStore | null>(null)

/** The store of the connection this component belongs to. */
export function useSessionStore(): SessionStore {
  const store = useContext(SessionContext)
  if (!store) throw new Error('useSession must be used inside an open connection')
  return store
}

export function useSession<T>(selector: (s: SessionState) => T): T {
  return useZustandStore(useSessionStore(), selector)
}
