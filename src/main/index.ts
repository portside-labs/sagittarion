import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell, type MenuItemConstructorOptions } from 'electron'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import agentSource from './agent/sqlite_agent.py?raw'
import { Session } from './ssh/session'
import { humanKeyType, KnownHostsStore } from './ssh/hostkeys'
import { ConnectionStore, noopCodec, type SecretCodec } from './store/connections'
import { toCsv, toJson, toSqlInserts } from '@shared/export'
import type { ConnectOptions } from '@shared/api'
import type { AppInfo, ConnectionConfig, ExportRequest, PendingChange, RowsRequest, SessionInfo } from '@shared/types'

const isMac = process.platform === 'darwin'
const sessions = new Map<string, Session>()
let mainWindow: BrowserWindow | null = null
let connectionStore: ConnectionStore
let knownHosts: KnownHostsStore

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

async function verifyHostKey(cfg: ConnectionConfig, key: Buffer): Promise<boolean> {
  const check = await knownHosts.check(cfg.host, cfg.port, key)
  if (check.status === 'trusted') return true
  const win = mainWindow ?? undefined
  const keyLabel = humanKeyType(check.keyType)
  if (check.status === 'unknown') {
    const r = await dialog.showMessageBox(win as BrowserWindow, {
      type: 'question',
      buttons: ['Connect', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Unknown host',
      message: `The authenticity of host "${cfg.host}" can't be established.`,
      detail: `${keyLabel} key fingerprint is\n${check.fingerprint}\n\nIf you trust this host, connect and the key will be remembered for next time.`
    })
    if (r.response !== 0) return false
    await knownHosts.save(knownHosts.entryFor(cfg.host, cfg.port, key))
    return true
  }
  const r = await dialog.showMessageBox(win as BrowserWindow, {
    type: 'warning',
    buttons: ['Cancel', 'Connect anyway and replace the saved key'],
    defaultId: 0,
    cancelId: 0,
    title: 'Host key changed',
    message: `WARNING: the ${keyLabel} host key for ${cfg.host} has changed.`,
    detail:
      `Offered fingerprint:\n${check.fingerprint}\n` +
      (check.previous ? `\nPreviously trusted:\n${check.previous.fingerprint}\n` : `\nIt does not match the entry in your ~/.ssh/known_hosts file.\n`) +
      '\nThis can mean someone is intercepting the connection, or that the server was legitimately reinstalled. Only continue if you know why the key changed.'
  })
  if (r.response !== 1) return false
  await knownHosts.save(knownHosts.entryFor(cfg.host, cfg.port, key))
  return true
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function sessionInfo(s: Session): SessionInfo {
  return {
    sessionId: s.id,
    connectionId: s.config.id,
    name: s.config.name,
    host: s.config.host,
    port: s.config.port,
    username: s.config.username,
    color: s.config.color,
    db: s.db,
    interpreter: s.interpreter ?? '',
    serverBanner: s.serverBanner,
    homeDir: s.homeDir
  }
}

function requireSession(id: string): Session {
  const s = sessions.get(id)
  if (!s || s.closed) throw new Error('This connection is no longer open. Reconnect to continue.')
  return s
}

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

async function connect(cfg: ConnectionConfig, opts: ConnectOptions): Promise<SessionInfo> {
  const session = new Session(cfg, {
    agentSource,
    verifyHostKey: (key) => verifyHostKey(cfg, key),
    onProgress: (p) => send('connect:progress', { ...p, requestId: opts.requestId })
  })
  session.on('close', ({ reason }: { reason: string }) => {
    sessions.delete(session.id)
    send('session:closed', { sessionId: session.id, reason })
  })
  session.on('agent-exit', (info: { code: number | null; stderr: string }) => {
    const detail = info?.stderr?.trim() ? `: ${info.stderr.trim().slice(-300)}` : ''
    send('session:closed', { sessionId: session.id, reason: `The remote helper process exited${detail}` })
    session.close()
  })
  session.on('error', () => {
    /* surfaced through close */
  })
  try {
    await session.connect()
    if (opts.openDatabase !== false) {
      if (!cfg.remotePath?.trim()) throw new Error('No remote database path given.')
      await session.openDatabase(cfg.remotePath.trim(), Boolean(cfg.readOnly))
    }
  } catch (err) {
    session.close()
    throw err
  }
  sessions.set(session.id, session)
  if (cfg.id) void connectionStore.touch(cfg.id)
  return sessionInfo(session)
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

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

  ipcMain.handle('ssh:connect', (_e, cfg: ConnectionConfig, opts: ConnectOptions) => connect(cfg, opts ?? {}))
  ipcMain.handle('ssh:disconnect', async (_e, sessionId: string) => {
    const s = sessions.get(sessionId)
    if (s) {
      sessions.delete(sessionId)
      s.removeAllListeners('close')
      s.close()
    }
  })

  ipcMain.handle('db:open', (_e, sessionId: string, remotePath: string, readOnly: boolean) =>
    requireSession(sessionId).openDatabase(remotePath, readOnly)
  )
  ipcMain.handle('db:schema', (_e, sessionId: string, includeSystem: boolean) => requireSession(sessionId).schema(includeSystem))
  ipcMain.handle('db:tableDetails', (_e, sessionId: string, table: string) => requireSession(sessionId).tableDetails(table))
  ipcMain.handle('db:rows', (_e, sessionId: string, req: RowsRequest) => requireSession(sessionId).rows(req))
  ipcMain.handle('db:count', (_e, sessionId: string, table: string, where?: string) => requireSession(sessionId).count(table, where))
  ipcMain.handle('db:query', (_e, sessionId: string, sql: string, params: unknown[], maxRows: number) =>
    requireSession(sessionId).query(sql, params, maxRows)
  )
  ipcMain.handle('db:cancel', async (_e, sessionId: string) => requireSession(sessionId).cancel())
  ipcMain.handle('db:apply', (_e, sessionId: string, changes: PendingChange[]) => requireSession(sessionId).apply(changes))

  ipcMain.handle('sftp:readdir', (_e, sessionId: string, p: string) => requireSession(sessionId).readdir(p))
  ipcMain.handle('sftp:home', (_e, sessionId: string) => requireSession(sessionId).home())

  ipcMain.handle('dialog:pickPrivateKey', async () => {
    const r = await dialog.showOpenDialog(mainWindow as BrowserWindow, {
      title: 'Choose a private key',
      defaultPath: path.join(os.homedir(), '.ssh'),
      properties: ['openFile', 'showHiddenFiles', 'treatPackageAsDirectory']
    })
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
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
    connectionStore = new ConnectionStore(path.join(userData, 'connections.json'), makeCodec())
    knownHosts = new KnownHostsStore(path.join(userData, 'known_hosts.json'), path.join(os.homedir(), '.ssh', 'known_hosts'))
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
    for (const s of sessions.values()) s.close()
    sessions.clear()
  })
}
