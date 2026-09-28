import { app, BrowserWindow, dialog, ipcMain, Menu, net, safeStorage, screen, shell, utilityProcess, type MenuItemConstructorOptions } from 'electron'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import agentSource from './agent/sqlite_agent.py?raw'
import modelHostPath from './privacy/semantic/host?modulePath'
import { ConnectionManager } from './connections/manager'
import { humanKeyType, KnownHostsStore } from './ssh/hostkeys'
import { ConnectionStore, noopCodec, type SecretCodec } from './store/connections'
import { SettingsStore } from './store/settings'
import { CredentialStore } from './store/credentials'
import { SshProfileStore } from './store/ssh-profiles'
import { WorkspaceStore } from './store/workspace'
import { qi, qualify } from './db/pg-values'
import { cellToPlainText } from '@shared/export'
import type { AiConnectionInput, AiProgressEvent, AiProgressStep, AiSettingsUpdate, AiTurn } from '@shared/ai'
import { PROVIDERS } from '@shared/ai'
import { classifyEndpoint, privacyApplies, type PrivacySettings } from '@shared/privacy'
import { createProvider, providerConfigFor } from './ai/providers/factory'
import { ProviderError, type LlmProvider, type ProviderConfig } from './ai/providers/types'
import { WireRecorder } from './ai/wire'
import { sendUnprotected } from './privacy/boundary'
import { ConversationVaults } from './privacy/conversations'
import { engineForSettings } from './privacy/engine'
import { PrivacyBlockedError } from './privacy/errors'
import { ModelGateway } from './privacy/gateway'
import { PolicyError, policyById } from './privacy/policy'
import { PrivacySession } from './privacy/session'
import type { HostHandle } from './privacy/semantic/client'
import type { HostReply } from './privacy/semantic/host'
import { SemanticModel } from './privacy/semantic/manager'
import { GLINER_PII_BASE } from './privacy/semantic/manifest'
import { unsupportedReason } from './privacy/semantic/platform'
import { ModelStore } from './privacy/semantic/store'
import type { SemanticSensitiveDataDetector } from './privacy/types'
import { TranscriptStore, transcriptForViewer } from './privacy/transcripts'
import { SchemaIndex, type SchemaSource } from './ai/schema-index'
import { askDatabase } from './ai/nl2sql'
import { EmbeddingCache } from './ai/embeddings'
import type { DatabaseDriver } from './db/driver'
import { toCsv, toJson, toSqlInserts } from '@shared/export'
import type { OpenOptions, SessionLinkEvent } from '@shared/api'
import type { AppInfo, ConnectionConfig, ExportRequest, ListObjectsRequest, ObjectRef, PendingChange, RowsRequest, SessionInfo, SshConfig, SshProfile, TableRef, WorkspaceState } from '@shared/types'

const isMac = process.platform === 'darwin'
let mainWindow: BrowserWindow | null = null
let connectionStore: ConnectionStore
let settingsStore: SettingsStore
let credentialStore: CredentialStore
let sshProfileStore: SshProfileStore
let workspaceStore: WorkspaceStore
let knownHosts: KnownHostsStore
let manager: ConnectionManager
let embeddingCache: EmbeddingCache
/** Schema indexes per session, rebuilt when the catalog is refreshed. */
const schemaIndexes = new Map<string, Promise<SchemaIndex>>()
const recentTables = new Map<string, string[]>()
/** Running asks, so the renderer can cancel them. */
const aiRequests = new Map<string, AbortController>()
/** Placeholder vaults of the chats in use: main-process memory only, never written anywhere. */
const conversations = new ConversationVaults()
/** What each recent ask sent and received, for the "What was sent" view. Memory only. */
const transcripts = new TranscriptStore()
/** The on-device model for semantic detection; its files live under userData/models. */
let semanticModel: SemanticModel

/** The model's own process: an Electron utility process running host.ts (Node and onnxruntime-node). */
function spawnModelHost(): HostHandle {
  const child = utilityProcess.fork(modelHostPath, [], { serviceName: 'Sagittarion privacy model', stdio: 'ignore' })
  return {
    post: (request) => child.postMessage(request),
    onMessage: (handler) => child.on('message', (reply: HostReply) => handler(reply)),
    onExit: (handler) => child.on('exit', () => handler()),
    kill: () => {
      child.kill()
    }
  }
}

/** What the AI's schema index reads, through whichever link the session has at the time. */
function schemaSourceFor(sessionId: string): SchemaSource {
  const read = <T>(fn: (driver: DatabaseDriver) => Promise<T>) => manager.read(sessionId, fn)
  return {
    async listTables() {
      const out: Awaited<ReturnType<DatabaseDriver['listObjects']>>['items'] = []
      let cursor: string | null = null
      do {
        const page = await read((d) => d.listObjects({ kinds: ['table', 'view'], cursor, limit: 5000 }))
        out.push(...page.items)
        cursor = page.cursor
      } while (cursor)
      return out
    },
    tablesMeta: (refs) => read((d) => d.tablesMeta(refs)),
    relationsFor: (refs) => read((d) => d.relationsFor(refs)),
    searchColumns: async (query, limit) => (await read((d) => d.searchObjects(query, limit))).columns
  }
}

function schemaIndexFor(sessionId: string, kind: 'sqlite' | 'postgres'): Promise<SchemaIndex> {
  let pending = schemaIndexes.get(sessionId)
  if (!pending) {
    pending = (async () => {
      const catalog = await manager.read(sessionId, (d) => d.catalog())
      return SchemaIndex.create(schemaSourceFor(sessionId), kind, catalog.defaultSchema)
    })()
    pending.catch(() => schemaIndexes.delete(sessionId))
    schemaIndexes.set(sessionId, pending)
  }
  return pending
}

/** The provider behind the active connection, or behind one as typed into Settings, with its key. */
async function providerFor(input?: AiConnectionInput, extra: Partial<ProviderConfig> = {}) {
  const { connection, apiKey } = await settingsStore.resolve(input)
  const preset = PROVIDERS[connection.provider]
  if (!preset.available) throw new Error(`${preset.label} is not available yet.`)
  if (preset.needsKey && !apiKey) throw new Error(`Add an API key for ${preset.label} in Settings to ask questions in plain English.`)
  const settings = await settingsStore.get()
  const config = providerConfigFor({ provider: connection.provider, baseUrl: connection.baseUrl, model: connection.defaultModel, embeddingModel: connection.embeddingModel }, apiKey, extra)
  const provider = createProvider(config)
  return { settings, connection, provider, baseUrl: config.baseUrl }
}

/**
 * The way to the model for one ask. Protected whenever Local AI Privacy is on and the endpoint is not this computer
 * (or protecting local models is on too); otherwise the gateway carries the reason it may send data as it is.
 * Anything that stops protection from working stops the ask.
 */
async function gatewayFor(provider: LlmProvider, baseUrl: string, privacy: PrivacySettings, sessionId: string, conversationId: string, signal: AbortSignal): Promise<ModelGateway> {
  const { trust, host } = classifyEndpoint(baseUrl)
  const applies = privacyApplies(privacy, trust)
  if (!applies.protect) return ModelGateway.unprotected(provider, applies.exemption, host)
  let policy
  try {
    policy = policyById(privacy.policyId)
  } catch (err) {
    throw new PrivacyBlockedError('policy-invalid', [], err instanceof PolicyError ? err.problems[0] : undefined)
  }
  // Switched on but unable to run (not installed, or this computer cannot run it): the engine refuses, and says why.
  let semantic: SemanticSensitiveDataDetector | null = null
  let why: string | undefined
  if (privacy.semanticDetection) {
    semantic = await semanticModel.detector()
    if (!semantic) why = (await semanticModel.status()).message
  }
  const engine = engineForSettings(privacy, semantic, why)
  return ModelGateway.protected(provider, new PrivacySession({ engine, policy, vault: conversations.vault(sessionId, conversationId), host, signal }))
}

async function distinctValuesFor(driver: DatabaseDriver, kind: 'sqlite' | 'postgres', ref: TableRef, column: string): Promise<string[] | null> {
  const table = kind === 'postgres' ? qualify(ref) : qi(ref.name)
  const limit = 21
  const res = await driver.query(`SELECT DISTINCT ${qi(column)} FROM ${table} WHERE ${qi(column)} IS NOT NULL LIMIT ${limit}`, [], limit, { readOnly: true })
  const first = res.results[0]
  if (!first || first.kind !== 'rows') return null
  if (first.rows.length >= limit) return null
  return first.rows.map((r) => cellToPlainText(r[0]))
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow(): BrowserWindow {
  // A roomy default that still fits on the screen it opens on.
  const area = screen.getPrimaryDisplay().workAreaSize
  const win = new BrowserWindow({
    width: Math.min(1584, area.width - 40),
    height: Math.min(1032, area.height - 40),
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'Sagittarion',
    // Charcoal's; the page sends its own theme's once it loads.
    backgroundColor: '#0f0f0f',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 14, y: 13 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  return win
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    ...(isMac ? [] : [{ label: 'File', submenu: [{ role: 'quit' as const }] }]),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : [])] }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

function makeCodec(): SecretCodec {
  if (!safeStorage.isEncryptionAvailable()) return noopCodec
  return {
    available: true,
    encrypt: (plain) => {
      try {
        return safeStorage.encryptString(plain).toString('base64')
      } catch {
        return null
      }
    },
    decrypt: (cipher) => {
      try {
        return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
      } catch {
        return null
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Host key verification (trust on first use, with the user's known_hosts as a second source)
// ---------------------------------------------------------------------------

async function verifyHostKey(ssh: SshConfig, key: Buffer): Promise<boolean> {
  const check = await knownHosts.check(ssh.host, ssh.port, key)
  if (check.status === 'trusted') return true
  const win = mainWindow as BrowserWindow
  const keyLabel = humanKeyType(check.keyType)
  if (check.status === 'unknown') {
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Connect', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Unknown host',
      message: `The authenticity of host "${ssh.host}" can't be established.`,
      detail: `${keyLabel} key fingerprint is\n${check.fingerprint}\n\nIf you trust this host, connect and the key will be remembered for next time.`
    })
    if (r.response !== 0) return false
    await knownHosts.save(knownHosts.entryFor(ssh.host, ssh.port, key))
    return true
  }
  const r = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancel', 'Connect anyway and replace the saved key'],
    defaultId: 0,
    cancelId: 0,
    title: 'Host key changed',
    message: `WARNING: the ${keyLabel} host key for ${ssh.host} has changed.`,
    detail:
      `Offered fingerprint:\n${check.fingerprint}\n` +
      (check.previous ? `\nPreviously trusted:\n${check.previous.fingerprint}\n` : `\nIt does not match the entry in your ~/.ssh/known_hosts file.\n`) +
      '\nThis can mean someone is intercepting the connection, or that the server was legitimately reinstalled. Only continue if you know why the key changed.'
  })
  if (r.response !== 1) return false
  await knownHosts.save(knownHosts.entryFor(ssh.host, ssh.port, key))
  return true
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

async function openSession(cfg: ConnectionConfig, opts: OpenOptions): Promise<SessionInfo> {
  const conn = await manager.open(cfg, {
    openDatabase: opts.openDatabase,
    onProgress: (p) => send('connect:progress', { ...p, requestId: opts.requestId })
  })
  if (cfg.id) void connectionStore.touch(cfg.id)
  if (cfg.sshProfileId) void sshProfileStore.touch(cfg.sshProfileId)
  return manager.info(conn)
}

function registerIpc(): void {
  ipcMain.handle('app:info', async (): Promise<AppInfo> => ({
    version: app.getVersion(),
    platform: process.platform,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    homeDir: os.homedir(),
    sshDir: path.join(os.homedir(), '.ssh')
  }))
  ipcMain.handle('app:openExternal', async (_e, url: string) => {
    if (/^https?:\/\//.test(url)) await shell.openExternal(url)
  })
  ipcMain.handle('app:setBackgroundColor', (e, color: unknown) => {
    if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) BrowserWindow.fromWebContents(e.sender)?.setBackgroundColor(color)
  })

  ipcMain.handle('connections:list', () => connectionStore.list())
  ipcMain.handle('connections:save', (_e, cfg: ConnectionConfig) => connectionStore.save(cfg))
  ipcMain.handle('connections:remove', (_e, id: string) => connectionStore.remove(id))
  ipcMain.handle('connections:setGroup', (_e, ids: string[], group: string | null) => connectionStore.setGroup(ids, group))
  ipcMain.handle('connections:duplicate', (_e, id: string) => connectionStore.duplicate(id))
  ipcMain.handle('connections:groupStyles', () => connectionStore.groupStyles())
  ipcMain.handle('connections:setGroupColor', (_e, name: string, color: string | null) => connectionStore.setGroupColor(name, color))
  ipcMain.handle('sshProfiles:list', () => sshProfileStore.list())
  ipcMain.handle('sshProfiles:save', (_e, p: SshProfile) => sshProfileStore.save(p))
  ipcMain.handle('sshProfiles:remove', (_e, id: string) => sshProfileStore.remove(id))

  ipcMain.handle('session:open', (_e, cfg: ConnectionConfig, opts: OpenOptions) => openSession(cfg, opts ?? {}))
  ipcMain.handle('session:close', (_e, sessionId: string) => {
    schemaIndexes.delete(sessionId)
    recentTables.delete(sessionId)
    conversations.forgetSession(sessionId)
    transcripts.forgetSession(sessionId)
    return manager.close(sessionId)
  })

  // A connection whose link dropped while idle reconnects on the first of these that needs it. Reads run once more if
  // the link turns out to have died under them; statements that may write never run twice.
  ipcMain.handle('db:open', (_e, sessionId: string, remotePath: string, readOnly: boolean) => manager.openFile(sessionId, remotePath, readOnly))
  ipcMain.handle('db:catalog', (_e, sessionId: string) => {
    schemaIndexes.delete(sessionId)
    return manager.read(sessionId, (d) => d.catalog())
  })
  ipcMain.handle('db:listObjects', (_e, sessionId: string, req: ListObjectsRequest) => manager.read(sessionId, (d) => d.listObjects(req)))
  ipcMain.handle('db:searchObjects', (_e, sessionId: string, query: string, limit: number) => manager.read(sessionId, (d) => d.searchObjects(query, limit)))
  ipcMain.handle('db:definition', (_e, sessionId: string, ref: ObjectRef) => manager.read(sessionId, (d) => d.definition(ref)))
  ipcMain.handle('db:tableDetails', (_e, sessionId: string, ref: TableRef) => manager.read(sessionId, (d) => d.tableDetails(ref)))
  ipcMain.handle('db:rows', (_e, sessionId: string, req: RowsRequest) => manager.read(sessionId, (d) => d.rows(req)))
  ipcMain.handle('db:count', (_e, sessionId: string, ref: TableRef, where?: string) => manager.read(sessionId, (d) => d.count(ref, where)))
  ipcMain.handle('db:query', async (_e, sessionId: string, sql: string, params: unknown[], maxRows: number) =>
    (await manager.driver(sessionId)).query(sql, params, maxRows)
  )
  ipcMain.handle('db:cancel', (_e, sessionId: string) => manager.cancel(sessionId))
  ipcMain.handle('db:apply', async (_e, sessionId: string, changes: PendingChange[]) => (await manager.driver(sessionId)).apply(changes))

  ipcMain.handle('sftp:readdir', (_e, sessionId: string, p: string) => manager.readFiles(sessionId, (s) => s.readdir(p)))
  ipcMain.handle('sftp:home', (_e, sessionId: string) => manager.readFiles(sessionId, (s) => s.home()))
  ipcMain.handle('dialog:pickSqliteFile', async (_e, current?: string) => {
    const r = await dialog.showOpenDialog(mainWindow as BrowserWindow, {
      title: 'Choose an SQLite database',
      defaultPath: current?.trim() ? path.dirname(current.trim()) : os.homedir(),
      filters: [
        { name: 'SQLite databases', extensions: ['db', 'sqlite', 'sqlite3', 'db3', 's3db', 'sl3'] },
        { name: 'All files', extensions: ['*'] }
      ],
      properties: ['openFile', 'showHiddenFiles', 'treatPackageAsDirectory']
    })
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })

  ipcMain.handle('dialog:pickPrivateKey', async () => {
    const r = await dialog.showOpenDialog(mainWindow as BrowserWindow, {
      title: 'Choose a private key',
      defaultPath: path.join(os.homedir(), '.ssh'),
      properties: ['openFile', 'showHiddenFiles', 'treatPackageAsDirectory']
    })
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })

  ipcMain.handle('workspace:load', () => workspaceStore.load())
  ipcMain.handle('workspace:save', (_e, state: WorkspaceState) => workspaceStore.save(state))
  ipcMain.on('workspace:flush', (e, state: WorkspaceState) => {
    try {
      workspaceStore.saveSync(state)
    } catch {
      /* best effort while closing */
    }
    e.returnValue = true
  })
  ipcMain.handle('settings:get', () => settingsStore.get())
  ipcMain.handle('settings:update', async (_e, u: AiSettingsUpdate) => {
    // Semantic detection is only offered once the model is installed; a request to switch it on without one is ignored.
    if (u.privacy?.semanticDetection && !(await semanticModel.detector())) u = { ...u, privacy: { ...u.privacy, semanticDetection: false } }
    return settingsStore.update(u)
  })
  ipcMain.handle('privacy:model-status', () => semanticModel.status())
  ipcMain.handle('privacy:model-install', () => semanticModel.install())
  ipcMain.handle('privacy:model-cancel', () => semanticModel.cancel())
  ipcMain.handle('privacy:model-remove', async () => {
    const status = await semanticModel.remove()
    await settingsStore.update({ privacy: { semanticDetection: false } })
    return status
  })
  ipcMain.handle('settings:testProvider', async (_e, overrides: AiConnectionInput | null) => {
    try {
      const { provider, connection } = await providerFor(overrides ?? undefined)
      try {
        const models = await provider.listModels()
        const known = connection.defaultModel && models.includes(connection.defaultModel)
        return {
          ok: true,
          message: `Connected. ${models.length} model${models.length === 1 ? '' : 's'} available${connection.defaultModel ? (known ? `, including ${connection.defaultModel}.` : `; "${connection.defaultModel}" is not in the list, check the name.`) : '.'}`
        }
      } catch (err) {
        // Some servers have no model listing; a tiny completion still proves the connection.
        if (!(err instanceof ProviderError) || err.errorKind === 'auth' || err.errorKind === 'network') throw err
        const res = await provider.complete(sendUnprotected({ system: [{ text: 'Reply with the single word OK.' }], messages: [{ role: 'user', content: 'ping' }] }, 'fixed-text'))
        return { ok: true, message: `Connected to ${res.model || connection.defaultModel}.` }
      }
    } catch (err: any) {
      return { ok: false, message: err?.message ?? String(err) }
    }
  })
  ipcMain.handle('settings:listModels', async (_e, overrides: AiConnectionInput | null) => {
    const { provider } = await providerFor(overrides ?? undefined)
    return provider.listModels()
  })

  ipcMain.handle('ai:ask', async (_e, sessionId: string, question: string, history: AiTurn[], requestId: string, conversationId?: string) => {
    const conn = manager.get(sessionId)
    const kind = conn.config.kind
    const controller = new AbortController()
    const id = requestId || crypto.randomUUID()
    const chatId = conversationId || id
    aiRequests.set(id, controller)
    let seq = 0
    const onProgress = (step: AiProgressStep) => {
      const event: AiProgressEvent = { ...step, requestId: id, seq: ++seq, ts: Date.now() }
      send('ai:progress', event)
    }
    // Every byte the adapters exchange with the provider during this ask, for the user to inspect afterwards.
    const wire = new WireRecorder()
    const started = Date.now()
    let host = ''
    let gateway: ModelGateway | undefined
    let blocked: string | undefined
    try {
      const { provider, settings, connection, baseUrl } = await providerFor(undefined, { fetchImpl: wire.fetch })
      host = classifyEndpoint(baseUrl).host
      gateway = await gatewayFor(provider, baseUrl, settings.privacy, sessionId, chatId, controller.signal)
      // A link that dropped while idle is made again before the ask starts on the database.
      await manager.ready(sessionId)
      let index: SchemaIndex
      const cached = schemaIndexes.get(sessionId)
      if (cached) index = await cached
      else {
        onProgress({ stepId: 'index', stage: 'index', status: 'running', message: 'Reading the schema' })
        try {
          index = await schemaIndexFor(sessionId, kind)
          onProgress({ stepId: 'index', stage: 'index', status: 'done', message: 'Reading the schema', detail: `${index.tables.size.toLocaleString('en-US')} tables indexed` })
        } catch (err) {
          onProgress({ stepId: 'index', stage: 'index', status: 'error', message: 'Reading the schema', detail: err instanceof Error ? err.message : String(err) })
          throw err
        }
      }
      const result = await askDatabase(
        {
          kind,
          serverVersion: conn.driver?.info()?.serverVersion ?? kind,
          index,
          provider: gateway,
          settings: { ...settings.agent, embeddingModel: connection.embeddingModel },
          // Read-only, so safe to run again should the link drop under them.
          runQuery: (sql, maxRows) => manager.read(sessionId, (d) => d.query(sql, [], maxRows, { readOnly: true })),
          distinctValues: (ref, column) => manager.read(sessionId, (d) => distinctValuesFor(d, kind, ref, column)),
          embeddingCache,
          recentTables: recentTables.get(sessionId),
          onProgress,
          signal: controller.signal
        },
        question,
        Array.isArray(history) ? history : []
      )
      if (result.kind === 'query') {
        const recent = [...new Set([...result.tablesUsed, ...(recentTables.get(sessionId) ?? [])])].slice(0, 12)
        recentTables.set(sessionId, recent)
      }
      return result
    } catch (err) {
      if (err instanceof PrivacyBlockedError) blocked = err.message
      throw err
    } finally {
      aiRequests.delete(id)
      if (host) {
        transcripts.put(sessionId, chatId, {
          requestId: id,
          host,
          at: started,
          protected: gateway ? Boolean(gateway.privacy) : Boolean(blocked),
          exemption: gateway?.exemption ?? undefined,
          exchanges: wire.exchanges,
          legend: gateway?.transcriptLegend(wire.exchanges.map((x) => x.request)) ?? [],
          report: gateway?.report(),
          ...(blocked ? { blocked } : {})
        })
      }
    }
  })
  ipcMain.handle('ai:transcript', (_e, requestId: string, opts?: { values?: boolean }) => {
    const held = typeof requestId === 'string' ? transcripts.get(requestId) : undefined
    if (!held) return null
    return transcriptForViewer(held.transcript, conversations.peek(held.sessionId, held.conversationId), opts?.values === true)
  })
  ipcMain.handle('ai:cancel', (_e, requestId: string) => {
    aiRequests.get(requestId)?.abort()
  })
  ipcMain.handle('ai:forget', (_e, conversationId: string, opts?: { transcripts?: boolean }) => {
    if (typeof conversationId !== 'string' || !conversationId) return
    conversations.forget(conversationId)
    if (opts?.transcripts) transcripts.forgetConversation(conversationId)
  })

  ipcMain.handle('export:save', async (_e, req: ExportRequest) => {
    const ext = req.format === 'csv' ? 'csv' : req.format === 'json' ? 'json' : 'sql'
    const r = await dialog.showSaveDialog(mainWindow as BrowserWindow, {
      title: 'Export rows',
      defaultPath: path.join(app.getPath('documents'), `${req.suggestedName || 'export'}.${ext}`),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
    })
    if (r.canceled || !r.filePath) return { saved: false }
    let content: string
    if (req.format === 'csv') content = toCsv(req.columns, req.rows)
    else if (req.format === 'json') content = toJson(req.columns, req.rows)
    else content = toSqlInserts(req.tableName || 'table', req.columns, req.rows)
    await fs.writeFile(r.filePath, content, 'utf8')
    return { saved: true, path: r.filePath }
  })
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Lets tests (and power users) point the app at a separate profile directory.
if (process.env['SAGITTARION_USER_DATA']) {
  app.setPath('userData', process.env['SAGITTARION_USER_DATA'])
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    const userData = app.getPath('userData')
    const codec = makeCodec()
    connectionStore = new ConnectionStore(path.join(userData, 'connections.json'), codec)
    credentialStore = new CredentialStore(path.join(userData, 'credentials.json'), codec)
    settingsStore = new SettingsStore(path.join(userData, 'settings.json'), credentialStore)
    sshProfileStore = new SshProfileStore(path.join(userData, 'ssh-profiles.json'), codec)
    workspaceStore = new WorkspaceStore(path.join(userData, 'workspace.json'))
    embeddingCache = new EmbeddingCache(path.join(userData, 'ai-cache', 'embeddings.json'))
    semanticModel = new SemanticModel({
      // Electron's fetch follows the system's proxy settings, which a company network may require.
      store: new ModelStore({ root: path.join(userData, 'models'), manifest: GLINER_PII_BASE, fetch: (input, init) => net.fetch(input as string, init) }),
      spawn: spawnModelHost,
      unsupported: unsupportedReason(),
      onStatus: (status) => send('privacy:model-status', status)
    })
    knownHosts = new KnownHostsStore(path.join(userData, 'known_hosts.json'), path.join(os.homedir(), '.ssh', 'known_hosts'))
    manager = new ConnectionManager({ agentSource, verifyHostKey, resolveSshProfile: (id) => sshProfileStore.get(id) })
    manager.on('link', (e: SessionLinkEvent) => send('session:link', e))
    registerIpc()
    buildMenu()
    mainWindow = createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (!isMac) app.quit()
  })

  app.on('before-quit', () => {
    void manager?.closeAll()
    semanticModel?.dispose()
  })
}
