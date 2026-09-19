import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Api, ConnectProgressEvent, SessionClosedEvent } from '@shared/api'

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
  ssh: {
    connect: (cfg, opts) => ipcRenderer.invoke('ssh:connect', cfg, opts ?? {}),
    disconnect: (sessionId) => ipcRenderer.invoke('ssh:disconnect', sessionId),
    onClosed: (cb) => subscribe<SessionClosedEvent>('session:closed', cb),
    onProgress: (cb) => subscribe<ConnectProgressEvent>('connect:progress', cb)
  },
  db: {
    open: (sessionId, remotePath, readOnly) => ipcRenderer.invoke('db:open', sessionId, remotePath, readOnly),
    schema: (sessionId, includeSystem) => ipcRenderer.invoke('db:schema', sessionId, includeSystem ?? false),
    tableDetails: (sessionId, table) => ipcRenderer.invoke('db:tableDetails', sessionId, table),
    rows: (sessionId, req) => ipcRenderer.invoke('db:rows', sessionId, req),
    count: (sessionId, table, where) => ipcRenderer.invoke('db:count', sessionId, table, where),
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
  exportData: (req) => ipcRenderer.invoke('export:save', req)
}

contextBridge.exposeInMainWorld('api', api)
