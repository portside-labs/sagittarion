import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Api, ConnectProgressEvent, SessionLinkEvent } from '@shared/api'
import type { AiProgressEvent } from '@shared/ai'
import type { SemanticModelStatus } from '@shared/privacy'
import type { ConnectorInfo, ToolApprovalRequest } from '@shared/connectors'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.off(channel, handler)
}

const api: Api = {
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
    setBackgroundColor: (color) => ipcRenderer.invoke('app:setBackgroundColor', color)
  },
  connections: {
    list: () => ipcRenderer.invoke('connections:list'),
    save: (cfg) => ipcRenderer.invoke('connections:save', cfg),
    remove: (id) => ipcRenderer.invoke('connections:remove', id),
    setGroup: (ids, group) => ipcRenderer.invoke('connections:setGroup', ids, group),
    duplicate: (id) => ipcRenderer.invoke('connections:duplicate', id),
    groupStyles: () => ipcRenderer.invoke('connections:groupStyles'),
    setGroupColor: (name, color) => ipcRenderer.invoke('connections:setGroupColor', name, color)
  },
  sshProfiles: {
    list: () => ipcRenderer.invoke('sshProfiles:list'),
    save: (profile) => ipcRenderer.invoke('sshProfiles:save', profile),
    remove: (id) => ipcRenderer.invoke('sshProfiles:remove', id)
  },
  session: {
    open: (cfg, opts) => ipcRenderer.invoke('session:open', cfg, opts ?? {}),
    close: (sessionId) => ipcRenderer.invoke('session:close', sessionId),
    onLink: (cb) => subscribe<SessionLinkEvent>('session:link', cb),
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
    pickPrivateKey: () => ipcRenderer.invoke('dialog:pickPrivateKey'),
    pickSqliteFile: (current) => ipcRenderer.invoke('dialog:pickSqliteFile', current)
  },
  exportData: (req) => ipcRenderer.invoke('export:save', req),
  workspace: {
    load: () => ipcRenderer.invoke('workspace:load'),
    save: (state) => ipcRenderer.invoke('workspace:save', state),
    flush: (state) => ipcRenderer.sendSync('workspace:flush', state)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (u) => ipcRenderer.invoke('settings:update', u),
    testProvider: (input) => ipcRenderer.invoke('settings:testProvider', input ?? null),
    listModels: (input) => ipcRenderer.invoke('settings:listModels', input ?? null)
  },
  ai: {
    ask: (sessionId, question, history, requestId, conversationId, opts) => ipcRenderer.invoke('ai:ask', sessionId, question, history ?? [], requestId ?? '', conversationId ?? '', opts ?? {}),
    cancel: (requestId) => ipcRenderer.invoke('ai:cancel', requestId),
    forget: (conversationId, opts) => ipcRenderer.invoke('ai:forget', conversationId, opts ?? {}),
    transcript: (requestId, opts) => ipcRenderer.invoke('ai:transcript', requestId, opts ?? {}),
    onProgress: (cb) => subscribe<AiProgressEvent>('ai:progress', cb),
    approve: (approvalId, decision) => ipcRenderer.invoke('ai:approve', approvalId, decision),
    onApproval: (cb) => subscribe<ToolApprovalRequest>('ai:approval', cb)
  },
  instructions: {
    list: () => ipcRenderer.invoke('instructions:list'),
    save: (input) => ipcRenderer.invoke('instructions:save', input),
    setEnabled: (id, enabled) => ipcRenderer.invoke('instructions:setEnabled', id, enabled),
    remove: (id) => ipcRenderer.invoke('instructions:remove', id)
  },
  connectors: {
    list: () => ipcRenderer.invoke('connectors:list'),
    save: (input) => ipcRenderer.invoke('connectors:save', input),
    start: (id) => ipcRenderer.invoke('connectors:start', id),
    refresh: (id) => ipcRenderer.invoke('connectors:refresh', id),
    setEnabled: (id, enabled) => ipcRenderer.invoke('connectors:setEnabled', id, enabled),
    setToolPermission: (id, tool, permission) => ipcRenderer.invoke('connectors:setToolPermission', id, tool, permission),
    remove: (id) => ipcRenderer.invoke('connectors:remove', id),
    onStatus: (cb) => subscribe<ConnectorInfo>('connectors:status', cb)
  },
  privacyModel: {
    status: () => ipcRenderer.invoke('privacy:model-status'),
    install: () => ipcRenderer.invoke('privacy:model-install'),
    cancel: () => ipcRenderer.invoke('privacy:model-cancel'),
    remove: () => ipcRenderer.invoke('privacy:model-remove'),
    onStatus: (cb) => subscribe<SemanticModelStatus>('privacy:model-status', cb)
  }
}

contextBridge.exposeInMainWorld('api', api)
