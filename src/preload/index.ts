import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Api, ConnectProgressEvent, SessionClosedEvent } from '@shared/api'
import type { AiProgressEvent } from '@shared/ai'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.off(channel, handler)
}

const api: Api = {
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url)
  },
  connections: {
    list: () => ipcRenderer.invoke('connections:list'),
    save: (cfg) => ipcRenderer.invoke('connections:save', cfg),
    remove: (id) => ipcRenderer.invoke('connections:remove', id)
  },
  session: {
    open: (cfg, opts) => ipcRenderer.invoke('session:open', cfg, opts ?? {}),
    close: (sessionId) => ipcRenderer.invoke('session:close', sessionId),
    onClosed: (cb) => subscribe<SessionClosedEvent>('session:closed', cb),
    onProgress: (cb) => subscribe<ConnectProgressEvent>('connect:progress', cb)
  },
  db: {
    open: (sessionId, remotePath, readOnly) => ipcRenderer.invoke('db:open', sessionId, remotePath, readOnly),
    catalog: (sessionId) => ipcRenderer.invoke('db:catalog', sessionId),
    listObjects: (sessionId, req) => ipcRenderer.invoke('db:listObjects', sessionId, req),
    searchObjects: (sessionId, query, limit) => ipcRenderer.invoke('db:searchObjects', sessionId, query, limit ?? 100),
    definition: (sessionId, ref) => ipcRenderer.invoke('db:definition', sessionId, ref),
    tableDetails: (sessionId, ref) => ipcRenderer.invoke('db:tableDetails', sessionId, ref),
    rows: (sessionId, req) => ipcRenderer.invoke('db:rows', sessionId, req),
    count: (sessionId, ref, where) => ipcRenderer.invoke('db:count', sessionId, ref, where),
    query: (sessionId, sql, params, maxRows) => ipcRenderer.invoke('db:query', sessionId, sql, params ?? [], maxRows ?? 1000),
    cancel: (sessionId) => ipcRenderer.invoke('db:cancel', sessionId),
    apply: (sessionId, changes) => ipcRenderer.invoke('db:apply', sessionId, changes)
  },
  sftp: {
    readdir: (sessionId, path) => ipcRenderer.invoke('sftp:readdir', sessionId, path),
    home: (sessionId) => ipcRenderer.invoke('sftp:home', sessionId)
  },
  dialog: {
    pickPrivateKey: () => ipcRenderer.invoke('dialog:pickPrivateKey')
  },
  exportData: (req) => ipcRenderer.invoke('export:save', req),
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (u) => ipcRenderer.invoke('settings:update', u),
    testProvider: (overrides) => ipcRenderer.invoke('settings:testProvider', overrides ?? {}),
    listModels: (overrides) => ipcRenderer.invoke('settings:listModels', overrides ?? {})
  },
  ai: {
    ask: (sessionId, question, history, requestId) => ipcRenderer.invoke('ai:ask', sessionId, question, history ?? [], requestId ?? ''),
    cancel: (requestId) => ipcRenderer.invoke('ai:cancel', requestId),
    onProgress: (cb) => subscribe<AiProgressEvent>('ai:progress', cb)
  }
}

contextBridge.exposeInMainWorld('api', api)
