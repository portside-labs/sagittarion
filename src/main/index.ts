import { app, BrowserWindow, dialog, ipcMain, Menu, net, safeStorage, screen, shell, utilityProcess, type MenuItemConstructorOptions } from 'electron'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import agentSource from './agent/sqlite_agent.py?raw'
import modelHostPath from './privacy/semantic/host?modulePath'
import { ConnectionManager } from './connections/manager'
import { humanKeyType, KnownHostsStore } from './ssh/hostkeys'
import { expandLocalHome } from './ssh/local-session'
import { ConnectionStore, noopCodec, type SecretCodec } from './store/connections'
import { SettingsStore } from './store/settings'
import { CredentialStore } from './store/credentials'
import { SshProfileStore } from './store/ssh-profiles'
import { WorkspaceStore } from './store/workspace'
import { qi, qualify } from './db/pg-values'
import { cellToPlainText } from '@shared/export'
import type { AiConnectionInput, AiProgressEvent, AiProgressStep, AiResult, AiSettingsUpdate, AiTurn, AskOptions } from '@shared/ai'
import type { ToolApprovalDecision } from '@shared/connectors'
import type { AiLearned } from '@shared/knowledge'
import { PROVIDERS, readsResults } from '@shared/ai'
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
import { ConnectorStore, connectorInfo } from './connectors/store'
import { InstructionStore } from './store/instructions'
import { ChatHistoryStore } from './store/chat-history'
import { KnowledgeStore } from './knowledge/store'
import { KnowledgeBook, runFacts } from './knowledge/book'
import type { DefinitionReader } from './knowledge/flow'
import { checkReadOnlySql } from './ai/guard'
import { instructionsAcross, instructionsFor, type InstructionInput } from '@shared/instructions'
import { ConnectorManager } from './connectors/manager'
import { connectorsForAsk } from './connectors/ask'
import { ApprovalBroker } from './connectors/approvals'
import { registerConnectorIpc } from './connectors/ipc'
import { connectorPath } from './connectors/shell-env'
import { GLINER_PII_BASE } from './privacy/semantic/manifest'
import { unsupportedReason } from './privacy/semantic/platform'
import { ModelStore } from './privacy/semantic/store'
import type { SemanticSensitiveDataDetector } from './privacy/types'
import { TranscriptStore, transcriptForViewer } from './privacy/transcripts'
import { SchemaIndex, type SchemaSource } from './ai/schema-index'
import { askDatabase, type AgentDatabase } from './ai/nl2sql'
import { EmbeddingCache } from './ai/embeddings'
import type { DatabaseDriver } from './db/driver'
import { toCsv, toJson, toSqlInserts } from '@shared/export'
import type { OpenOptions, SessionLinkEvent } from '@shared/api'
import type { AppInfo, CertificateKind, ConnectionConfig, ExportRequest, QueryResponse, ListObjectsRequest, ObjectRef, PendingChange, RowsRequest, SavedChat, SessionInfo, SshConfig, SshProfile, TableRef, WorkspaceState } from '@shared/types'

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
/** The user's instructions to the model (instructions.json). */
let instructionStore: InstructionStore
let chatHistory: ChatHistoryStore
/** What the app learns about the business behind each connection (knowledge/<id>.json). */
let knowledgeStore: KnowledgeStore
/** Whether it learns at all: the user can turn it off in Settings. Kept here so editor runs need not read settings. */
let learning = true
/** The user's MCP servers (connectors.json) and their running clients. */
let connectorStore: ConnectorStore
let connectorManager: ConnectorManager
/** Connector tool calls waiting in the chat for the user's approval. */
const approvals = new ApprovalBroker((req) => send('ai:approval', req))

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

/** A session's schema index, read once and kept; the steps say so while it is read. `name` marks another database in the chat. */
async function indexWithProgress(sessionId: string, kind: 'sqlite' | 'postgres', onProgress: (step: AiProgressStep) => void, name?: string): Promise<SchemaIndex> {
  const cached = schemaIndexes.get(sessionId)
  if (cached) return cached
  const stepId = name ? `index:${sessionId}` : 'index'
  const message = name ? `Reading the schema of ${name}` : 'Reading the schema'
  onProgress({ stepId, stage: 'index', status: 'running', message })
  try {
    const index = await schemaIndexFor(sessionId, kind)
    onProgress({ stepId, stage: 'index', status: 'done', message, detail: `${index.tables.size.toLocaleString('en-US')} tables indexed` })
    return index
  } catch (err) {
    onProgress({ stepId, stage: 'index', status: 'error', message, detail: err instanceof Error ? err.message : String(err) })
    throw err
  }
}

/**
 * What is known about the business behind a session's connection, when the app learns and the connection is saved;
 * undefined for a session that has closed meanwhile.
 */
function knowledgeFor(sessionId: string): KnowledgeBook | undefined {
  let id: string | undefined
  try {
    id = manager.get(sessionId).config.id || undefined
  } catch {
    return undefined
  }
  return learning && id ? new KnowledgeBook(knowledgeStore, id) : undefined
}

/** How the knowledge reads a session's triggers and definitions, to learn how data moves. */
function definitionReader(sessionId: string): DefinitionReader {
  return {
    triggers: async (ref) => (await manager.read(sessionId, (d) => d.tableDetails(ref))).triggers,
    definition: async (ref) => (await manager.read(sessionId, (d) => d.definition(ref))).sql
  }
}

/** The read statements of a run in the editor, counted for what they teach; errors are left out of what is learned. */
async function noteEditorRun(sessionId: string, response: QueryResponse): Promise<void> {
  const book = knowledgeFor(sessionId)
  if (!book) return
  // The schema index only when an ask has read it already: an editor run never costs a read of the schema.
  const index = await schemaIndexes.get(sessionId)?.catch(() => undefined)
  for (const r of response.results) {
    if (r.kind === 'exec' || !checkReadOnlySql(r.sql).ok) continue
    await book.editorRun(r.sql, r.kind === 'rows', index)
  }
}

/**
 * After an answer, how data moves around the tables it used is read from their triggers and definitions, a few at a
 * time, for later questions: after a moment, so a query the answer runs goes first. The books are made at once, while
 * every session is open; one closed by the time the reading starts is passed by. Learning never stands in the way of
 * an answer, or of anything else.
 */
function scanAfterAnswer(sessions: { sessionId: string; index: SchemaIndex }[], result: Exclude<AiResult, { kind: 'cancelled' }>): void {
  try {
    const scans = sessions.map((s) => ({ ...s, book: knowledgeFor(s.sessionId), keys: new Set<string>() }))
    const of = (connectionId: string | undefined) => scans.find((s) => s.book && s.book.connectionId === (connectionId ?? ''))
    if (result.kind === 'query') {
      const s = (result.database && of(result.database.connectionId)) || scans[0]
      for (const key of runFacts(result.sql, s.index).tables) s.keys.add(key)
    }
    for (const q of result.queries ?? []) {
      const s = of(q.database.connectionId)
      if (s && q.rows !== undefined) for (const key of runFacts(q.sql, s.index).tables) s.keys.add(key)
    }
    setTimeout(() => {
      for (const s of scans) {
        if (s.book && s.keys.size) void s.book.scan(s.index, definitionReader(s.sessionId), [...s.keys]).catch(() => undefined)
      }
    }, 1500)
  } catch {
    /* best effort */
  }
}

/**
 * An open session as the agent sees a database: read-only queries, safe to run again should the link drop under them,
 * whether the user lets the model read their results there, and what is known about its business.
 */
function agentDatabase(sessionId: string, index: SchemaIndex, key: string, readResults: boolean): AgentDatabase {
  const conn = manager.get(sessionId)
  const kind = conn.config.kind
  return {
    readResults,
    key,
    name: conn.config.name || kind,
    connectionId: conn.config.id || undefined,
    kind,
    serverVersion: conn.driver?.info()?.serverVersion ?? kind,
    index,
    runQuery: (sql, maxRows) => manager.read(sessionId, (d) => d.query(sql, [], maxRows, { readOnly: true })),
    distinctValues: (ref, column) => manager.read(sessionId, (d) => distinctValuesFor(d, kind, ref, column)),
    recentTables: recentTables.get(sessionId),
    knowledge: knowledgeFor(sessionId)
  }
}

/**
 * The other databases a chat has in context, each connected and its schema read. One that cannot be reached is left
 * out of this ask, and the steps say why.
 */
async function contextDatabases(home: string, wanted: AskOptions['databases'], onProgress: (step: AiProgressStep) => void): Promise<{ sessionId: string; index: SchemaIndex }[]> {
  const out: { sessionId: string; index: SchemaIndex }[] = []
  const seen = new Set([home])
  for (const d of Array.isArray(wanted) ? wanted : []) {
    if (!d || typeof d.sessionId !== 'string' || seen.has(d.sessionId)) continue
    seen.add(d.sessionId)
    let name = 'a database'
    try {
      const conn = manager.get(d.sessionId)
      name = conn.config.name || conn.config.kind
      await manager.ready(d.sessionId)
      out.push({ sessionId: d.sessionId, index: await indexWithProgress(d.sessionId, conn.config.kind, onProgress, name) })
    } catch (err) {
      onProgress({ stepId: `left-out:${d.sessionId}`, stage: 'index', status: 'error', message: `Left out ${name}`, detail: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}

/**
 * Opens a connector's sign-in page in the user's browser. The tests set SAGITTARION_TEST_BROWSER=fetch to follow it
 * here instead, as a browser already signed in to the server would.
 */
async function openSignInPage(url: URL): Promise<void> {
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error(`The server's sign-in page is not a secure web address (${url.protocol}).`)
  if (process.env['SAGITTARION_TEST_BROWSER'] === 'fetch') {
    await fetch(url)
    return
  }
  await shell.openExternal(url.toString())
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
  // A link followed inside the window would replace the app with the page: it opens in the browser instead.
  win.webContents.on('will-navigate', (e, url) => {
    const origin = (u: string) => {
      try {
        return new URL(u).origin
      } catch {
        return ''
      }
    }
    if (origin(url) === origin(win.webContents.getURL())) return
    e.preventDefault()
    if (/^https?:/i.test(url)) void shell.openExternal(url)
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
  ipcMain.handle('connections:remove', async (_e, id: string) => {
    await connectionStore.remove(id)
    await connectorStore.forgetConnection(id)
    await instructionStore.forgetConnection(id)
    await knowledgeStore.forgetConnection(id)
    await settingsStore.forgetConnection(id)
  })
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
  ipcMain.handle('db:query', async (_e, sessionId: string, sql: string, params: unknown[], maxRows: number) => {
    const response = await (await manager.driver(sessionId)).query(sql, params, maxRows)
    // What the user runs teaches the knowledge how the team queries: after the answer, never holding it up.
    if (learning) void noteEditorRun(sessionId, response).catch(() => undefined)
    return response
  })
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

  ipcMain.handle('dialog:pickCertificate', async (_e, kind: CertificateKind, current?: string) => {
    // Where libpq keeps its certificates, when there is such a folder; else where the file chosen before is.
    const libpqDir = path.join(os.homedir(), '.postgresql')
    const start = current?.trim()
      ? path.dirname(expandLocalHome(current.trim()))
      : await fs.stat(libpqDir).then(
          (s) => (s.isDirectory() ? libpqDir : os.homedir()),
          () => os.homedir()
        )
    const r = await dialog.showOpenDialog(mainWindow as BrowserWindow, {
      title: kind === 'ca' ? 'Choose the CA certificate' : kind === 'cert' ? 'Choose the client certificate' : 'Choose the client key',
      defaultPath: start,
      filters:
        kind === 'key'
          ? [{ name: 'Keys', extensions: ['key', 'pem', 'pk8', 'der'] }, { name: 'All files', extensions: ['*'] }]
          : [{ name: 'Certificates', extensions: ['crt', 'pem', 'cer', 'der'] }, { name: 'All files', extensions: ['*'] }],
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
    const updated = await settingsStore.update(u)
    learning = updated.agent.learn
    return updated
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

  ipcMain.handle('ai:ask', async (_e, sessionId: string, question: string, history: AiTurn[], requestId: string, conversationId?: string, opts?: AskOptions) => {
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
      const index = await indexWithProgress(sessionId, kind, onProgress)
      // With other databases in context, the model looks across them all; each is known to it by a short key.
      const others = await contextDatabases(sessionId, opts?.databases, onProgress)
      const sessions = [{ sessionId, index }, ...others]
      const reads = (id: string) => readsResults(settings.agent.readResults, manager.get(id).config.id || undefined)
      const databases = others.length ? sessions.map((s, i) => agentDatabase(s.sessionId, s.index, `db${i + 1}`, reads(s.sessionId))) : undefined
      // The connectors on for this chat start now; one that cannot start is left out, and the steps say why.
      const connectors = await connectorsForAsk({
        store: connectorStore,
        manager: connectorManager,
        connectionId: databases ? databases.map((d) => d.connectionId) : conn.config.id || undefined,
        overrides: opts?.connectors && typeof opts.connectors === 'object' ? opts.connectors : undefined,
        approve: (c, tool, args, signal) => approvals.request(id, c, tool, args, signal),
        onChange: (c) => send('connectors:status', connectorInfo(c, connectorManager.status(c))),
        onProgress,
        signal: controller.signal
      })
      const allInstructions = await instructionStore.list()
      const instructions = databases
        ? instructionsAcross(allInstructions, databases)
        : instructionsFor(allInstructions, conn.config.id || undefined).map((i) => ({ name: i.name, text: i.text }))
      const result = await askDatabase(
        {
          kind,
          serverVersion: conn.driver?.info()?.serverVersion ?? kind,
          index,
          provider: gateway,
          settings: { ...settings.agent, embeddingModel: connection.embeddingModel },
          readResults: reads(sessionId),
          connectionId: conn.config.id || undefined,
          // Read-only, so safe to run again should the link drop under them.
          runQuery: (sql, maxRows) => manager.read(sessionId, (d) => d.query(sql, [], maxRows, { readOnly: true })),
          distinctValues: (ref, column) => manager.read(sessionId, (d) => distinctValuesFor(d, kind, ref, column)),
          embeddingCache,
          ...(databases ? { databases } : {}),
          knowledge: knowledgeFor(sessionId),
          // A new conversation is named by the model in its first answer, not in a request of its own.
          title: opts?.title === true,
          connectors,
          instructions,
          recentTables: recentTables.get(sessionId),
          onProgress,
          onStream: (text) => send('ai:stream', { requestId: id, text }),
          signal: controller.signal
        },
        question,
        Array.isArray(history) ? history : []
      )
      if (learning && result.kind !== 'cancelled') scanAfterAnswer(sessions, result)
      if (result.kind === 'query') {
        // The tables used are remembered for the database the query is for.
        const at = result.database && databases ? databases.findIndex((d) => d.connectionId === result.database!.connectionId) : -1
        const target = at >= 0 ? sessions[at].sessionId : sessionId
        const recent = [...new Set([...result.tablesUsed, ...(recentTables.get(target) ?? [])])].slice(0, 12)
        recentTables.set(target, recent)
      }
      return result
    } catch (err) {
      if (err instanceof PrivacyBlockedError) blocked = err.message
      throw err
    } finally {
      aiRequests.delete(id)
      if (host) {
        // A response body may still be landing in the record when the ask ends early.
        await wire.settled()
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
  ipcMain.handle('ai:approve', (_e, approvalId: string, decision: ToolApprovalDecision) => approvals.answer(approvalId, decision))

  ipcMain.handle('chats:history', () => chatHistory.list())
  // Opened again, a conversation is a tab once more; closed, it comes back here.
  ipcMain.handle('chats:take', async (_e, id: string) => {
    if (typeof id !== 'string') return null
    const chat = await chatHistory.get(id)
    if (chat) await chatHistory.remove(id)
    return chat
  })
  ipcMain.handle('chats:archive', (_e, chat: SavedChat) => chatHistory.put(chat))
  ipcMain.handle('chats:forget', (_e, id: string) => (typeof id === 'string' ? chatHistory.remove(id) : undefined))
  // Something learned while answering, undone from the answer that shows it; or everything learned, from Settings.
  ipcMain.handle('knowledge:forget', (_e, item: AiLearned) => {
    if (!item || typeof item.connectionId !== 'string' || typeof item.id !== 'string' || !['term', 'rule', 'domain', 'query'].includes(item.kind)) return false
    return new KnowledgeBook(knowledgeStore, item.connectionId).forget({ kind: item.kind, id: item.id, corrected: item.corrected === true })
  })
  ipcMain.handle('knowledge:forgetAll', () => knowledgeStore.forgetAll())
  ipcMain.handle('instructions:list', () => instructionStore.list())
  ipcMain.handle('instructions:save', (_e, input: InstructionInput) => instructionStore.save(input))
  ipcMain.handle('instructions:setEnabled', (_e, id: string, enabled: boolean) => instructionStore.setEnabled(id, enabled === true))
  ipcMain.handle('instructions:remove', (_e, id: string) => instructionStore.remove(id))
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
    // Tests on Linux without a keyring (CI): keep secrets under Chromium's fixed key, as a desktop's keyring would keep
    // them, so saved passwords last across restarts. Nothing changes elsewhere, or without the variable.
    if (process.platform === 'linux' && process.env['SAGITTARION_TEST_PLAINTEXT_SECRETS']) safeStorage.setUsePlainTextEncryption(true)
    const codec = makeCodec()
    connectionStore = new ConnectionStore(path.join(userData, 'connections.json'), codec)
    credentialStore = new CredentialStore(path.join(userData, 'credentials.json'), codec)
    settingsStore = new SettingsStore(path.join(userData, 'settings.json'), credentialStore)
    sshProfileStore = new SshProfileStore(path.join(userData, 'ssh-profiles.json'), codec)
    connectorStore = new ConnectorStore(path.join(userData, 'connectors.json'), codec)
    instructionStore = new InstructionStore(path.join(userData, 'instructions.json'))
    chatHistory = new ChatHistoryStore(path.join(userData, 'chat-history.json'))
    knowledgeStore = new KnowledgeStore(path.join(userData, 'knowledge'))
    void settingsStore.get().then((s) => (learning = s.agent.learn !== false)).catch(() => undefined)
    connectorManager = new ConnectorManager({
      clientInfo: { name: 'Sagittarion', version: app.getVersion() },
      path: () => connectorPath(),
      oauth: (c) => ({ load: () => connectorStore.oauth(c.id), save: (state) => connectorStore.saveOAuth(c.id, state) }),
      openBrowser: openSignInPage
    })
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
    registerConnectorIpc(connectorStore, connectorManager, send)
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
    knowledgeStore?.flushSync()
    void manager?.closeAll()
    semanticModel?.dispose()
    void connectorManager?.dispose()
  })
}
