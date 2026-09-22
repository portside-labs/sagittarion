import { create } from 'zustand'
import type { AppInfo, ConnectionConfig, SchemaInfo, SessionInfo, TableRef } from '@shared/types'
import { sameTable, tableLabel } from '@shared/connections'
import { errorMessage } from './lib/util'

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

interface State {
  appInfo: AppInfo | null
  connections: ConnectionConfig[]
  session: SessionInfo | null
  schema: SchemaInfo | null
  schemaError: string | null
  schemaLoading: boolean
  tabs: Tab[]
  activeTabId: string | null
  dirtyTabs: Record<string, boolean>
  toasts: Toast[]
  confirmRequest: ConfirmRequest | null
  inTransaction: boolean
  status: string
  queryCounter: number

  init(): Promise<void>
  confirm(message: string, detail?: string, confirmLabel?: string, destructive?: boolean): Promise<boolean>
  resolveConfirm(ok: boolean): void
  loadConnections(): Promise<void>
  setSession(s: SessionInfo | null): void
  refreshSchema(): Promise<void>
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

const emptySession = {
  session: null,
  schema: null,
  schemaError: null,
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
  session: null,
  schema: null,
  schemaError: null,
  schemaLoading: false,
  tabs: [],
  activeTabId: null,
  dirtyTabs: {},
  toasts: [],
  confirmRequest: null,
  inTransaction: false,
  status: '',
  queryCounter: 0,

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
    set({ schemaLoading: true, schemaError: null })
    try {
      const schema = await window.api.db.schema(session.sessionId)
      if (get().session?.sessionId !== session.sessionId) return
      set({ schema, schemaLoading: false })
    } catch (e) {
      set({ schemaError: errorMessage(e), schemaLoading: false })
    }
  },

  openTable(ref) {
    const { tabs, schema } = get()
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
      title: tableLabel(ref, schema?.defaultSchema)
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
