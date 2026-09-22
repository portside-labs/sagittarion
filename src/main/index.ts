import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell, type MenuItemConstructorOptions } from 'electron'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import agentSource from './agent/sqlite_agent.py?raw'
import { ConnectionManager } from './connections/manager'
import { humanKeyType, KnownHostsStore } from './ssh/hostkeys'
import { ConnectionStore, noopCodec, type SecretCodec } from './store/connections'
import { SettingsStore } from './store/settings'
import { qi, qualify } from './db/pg-values'
import { cellToPlainText } from '@shared/export'
import { AI_PRESETS, type AiSettings, type AiSettingsUpdate, type AiTurn } from '@shared/ai'
import { createProvider, providerConfigFor } from './ai/providers/factory'
import { ProviderError } from './ai/providers/types'
import { SchemaIndex } from './ai/schema-index'
import { askDatabase } from './ai/nl2sql'
import { EmbeddingCache } from './ai/embeddings'
import type { DatabaseDriver } from './db/driver'
import { toCsv, toJson, toSqlInserts } from '@shared/export'
import type { OpenOptions } from '@shared/api'
import type { AppInfo, ConnectionConfig, ExportRequest, PendingChange, RowsRequest, SessionInfo, SshConfig, TableRef } from '@shared/types'

const isMac = process.platform === 'darwin'
let mainWindow: BrowserWindow | null = null
let connectionStore: ConnectionStore
let settingsStore: SettingsStore
let knownHosts: KnownHostsStore
let manager: ConnectionManager
let embeddingCache: EmbeddingCache
/** Schema indexes per session, rebuilt when the schema is refreshed. */
const schemaIndexes = new Map<string, SchemaIndex>()
const recentTables = new Map<string, string[]>()

async function providerFor(overrides: AiSettingsUpdate = {}) {
  const saved = await settingsStore.get()
  const merged: AiSettings = { ...saved, ...(overrides.provider ? { provider: overrides.provider } : {}) }
  const preset = AI_PRESETS[merged.provider]
  const switching = overrides.provider && overrides.provider !== saved.provider
  merged.baseUrl = overrides.baseUrl ?? (switching ? preset.baseUrl : saved.baseUrl)
  merged.model = overrides.model ?? (switching ? preset.defaultModel : saved.model)
  merged.embeddingModel = overrides.embeddingModel ?? (switching ? '' : saved.embeddingModel)
  const apiKey = typeof overrides.apiKey === 'string' && overrides.apiKey.trim() ? overrides.apiKey : await settingsStore.apiKeyFor(merged.provider)
  if (preset.needsKey && !apiKey) throw new Error(`Add an API key for ${preset.label} in Settings to ask questions in plain English.`)
  return { settings: merged, provider: createProvider(providerConfigFor(merged, apiKey)) }
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
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'SQLite SSH',
    backgroundColor: '#17181b',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 16, y: 18 } : undefined,
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

  ipcMain.handle('connections:list', () => connectionStore.list())
  ipcMain.handle('connections:save', (_e, cfg: ConnectionConfig) => connectionStore.save(cfg))
  ipcMain.handle('connections:remove', (_e, id: string) => connectionStore.remove(id))

  ipcMain.handle('session:open', (_e, cfg: ConnectionConfig, opts: OpenOptions) => openSession(cfg, opts ?? {}))
  ipcMain.handle('session:close', (_e, sessionId: string) => {
    schemaIndexes.delete(sessionId)
    recentTables.delete(sessionId)
    return manager.close(sessionId)
  })

  ipcMain.handle('db:open', async (_e, sessionId: string, remotePath: string, readOnly: boolean) => {
    const conn = manager.get(sessionId)
    if (conn.config.kind !== 'sqlite' || !conn.driver) throw new Error('Only SQLite connections open files.')
    return (conn.driver as any).open(remotePath, readOnly)
  })
  ipcMain.handle('db:schema', (_e, sessionId: string) => {
    schemaIndexes.delete(sessionId)
    return manager.driver(sessionId).schema()
  })
  ipcMain.handle('db:tableDetails', (_e, sessionId: string, ref: TableRef) => manager.driver(sessionId).tableDetails(ref))
  ipcMain.handle('db:rows', (_e, sessionId: string, req: RowsRequest) => manager.driver(sessionId).rows(req))
  ipcMain.handle('db:count', (_e, sessionId: string, ref: TableRef, where?: string) => manager.driver(sessionId).count(ref, where))
  ipcMain.handle('db:query', (_e, sessionId: string, sql: string, params: unknown[], maxRows: number) =>
    manager.driver(sessionId).query(sql, params, maxRows)
  )
  ipcMain.handle('db:cancel', (_e, sessionId: string) => manager.driver(sessionId).cancel())
  ipcMain.handle('db:apply', (_e, sessionId: string, changes: PendingChange[]) => manager.driver(sessionId).apply(changes))

  ipcMain.handle('sftp:readdir', (_e, sessionId: string, p: string) => manager.sshSession(sessionId).readdir(p))
  ipcMain.handle('sftp:home', (_e, sessionId: string) => manager.sshSession(sessionId).home())

  ipcMain.handle('dialog:pickPrivateKey', async () => {
    const r = await dialog.showOpenDialog(mainWindow as BrowserWindow, {
      title: 'Choose a private key',
      defaultPath: path.join(os.homedir(), '.ssh'),
      properties: ['openFile', 'showHiddenFiles', 'treatPackageAsDirectory']
    })
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })

  ipcMain.handle('settings:get', () => settingsStore.get())
  ipcMain.handle('settings:update', (_e, u: AiSettingsUpdate) => settingsStore.update(u))
  ipcMain.handle('settings:testProvider', async (_e, overrides: AiSettingsUpdate) => {
    try {
      const { provider, settings } = await providerFor(overrides)
      try {
        const models = await provider.listModels()
        const known = settings.model && models.includes(settings.model)
        return {
          ok: true,
          message: `Connected. ${models.length} model${models.length === 1 ? '' : 's'} available${settings.model ? (known ? `, including ${settings.model}.` : `; "${settings.model}" is not in the list, check the name.`) : '.'}`
        }
      } catch (err) {
        // Some servers have no model listing; a tiny completion still proves the connection.
        if (!(err instanceof ProviderError) || err.errorKind === 'auth' || err.errorKind === 'network') throw err
        const res = await provider.complete({ system: [{ text: 'Reply with the single word OK.' }], messages: [{ role: 'user', content: 'ping' }] })
        return { ok: true, message: `Connected to ${res.model || settings.model}.` }
      }
    } catch (err: any) {
      return { ok: false, message: err?.message ?? String(err) }
    }
  })
  ipcMain.handle('settings:listModels', async (_e, overrides: AiSettingsUpdate) => {
    const { provider } = await providerFor(overrides)
    return provider.listModels()
  })

  ipcMain.handle('ai:ask', async (_e, sessionId: string, question: string, history: AiTurn[]) => {
    const conn = manager.get(sessionId)
    const driver = manager.driver(sessionId)
    const kind = conn.config.kind
    const { provider, settings } = await providerFor()
    let index = schemaIndexes.get(sessionId)
    if (!index) {
      index = new SchemaIndex(await driver.schema(), kind)
      schemaIndexes.set(sessionId, index)
    }
    const result = await askDatabase(
      {
        kind,
        serverVersion: conn.driver?.info()?.serverVersion ?? kind,
        index,
        provider,
        settings: { sendSampleValues: settings.sendSampleValues, autoRun: settings.autoRun, schemaBudgetTokens: settings.schemaBudgetTokens, embeddingModel: settings.embeddingModel },
        runQuery: (sql, maxRows) => driver.query(sql, [], maxRows, { readOnly: true }),
        distinctValues: (ref, column) => distinctValuesFor(driver, kind, ref, column),
        embeddingCache,
        recentTables: recentTables.get(sessionId)
      },
      question,
      Array.isArray(history) ? history : []
    )
    if (result.kind === 'query') {
      const recent = [...new Set([...result.tablesUsed, ...(recentTables.get(sessionId) ?? [])])].slice(0, 12)
      recentTables.set(sessionId, recent)
    }
    return result
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
if (process.env['SQLITE_SSH_USER_DATA']) {
  app.setPath('userData', process.env['SQLITE_SSH_USER_DATA'])
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
    settingsStore = new SettingsStore(path.join(userData, 'settings.json'), codec)
    embeddingCache = new EmbeddingCache(path.join(userData, 'ai-cache', 'embeddings.json'))
    knownHosts = new KnownHostsStore(path.join(userData, 'known_hosts.json'), path.join(os.homedir(), '.ssh', 'known_hosts'))
    manager = new ConnectionManager({ agentSource, verifyHostKey })
    manager.on('closed', (e: { sessionId: string; reason: string }) => send('session:closed', e))
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
  })
}
