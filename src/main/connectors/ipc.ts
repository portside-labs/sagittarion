// Settings' side of connectors: list, add, change, switch on and off, and see how each is doing as it changes.
import { ipcMain } from 'electron'
import { emptyConnector, type ConnectorInfo, type ConnectorInput, type ToolPermission } from '@shared/connectors'
import { connectorInfo, type Connector, type ConnectorStore } from './store'
import type { ConnectorManager } from './manager'

const PERMISSIONS: ToolPermission[] = ['allow', 'ask', 'never']

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function secrets(v: unknown): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k.trim() && (typeof x === 'string' || x === null)) out[k.trim()] = x
  return out
}

/** What the renderer sent, checked field by field. */
export function readConnectorInput(raw: unknown): ConnectorInput {
  const r = (raw ?? {}) as Partial<Record<keyof ConnectorInput, unknown>>
  const base = emptyConnector()
  const input: ConnectorInput = {
    id: typeof r.id === 'string' ? r.id : '',
    name: typeof r.name === 'string' ? r.name : '',
    enabled: r.enabled !== false,
    transport: r.transport === 'http' ? 'http' : 'stdio',
    command: typeof r.command === 'string' ? r.command : '',
    args: strings(r.args),
    env: secrets(r.env),
    url: typeof r.url === 'string' ? r.url.trim() : '',
    headers: secrets(r.headers),
    scope: r.scope === 'selected' ? 'selected' : base.scope,
    connectionIds: strings(r.connectionIds)
  }
  if (input.transport === 'stdio' && !input.command.trim()) throw new Error('Give the command that starts the server, such as npx or uvx.')
  if (input.transport === 'http') {
    let url: URL
    try {
      url = new URL(input.url)
    } catch {
      throw new Error('Give the server’s full address, starting with https://.')
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The address must start with https:// (or http:// for a server on this computer).')
  }
  return input
}

export function registerConnectorIpc(store: ConnectorStore, manager: ConnectorManager, send: (channel: string, payload: unknown) => void): void {
  const info = (c: Connector): ConnectorInfo => connectorInfo(c, manager.status(c))
  const required = async (id: string): Promise<Connector> => {
    const c = await store.get(id)
    if (!c) throw new Error('That connector no longer exists.')
    return c
  }
  /** Starts it in the background, so Settings shows its tools, or why it could not start, as soon as it knows. */
  const warm = (c: Connector) => {
    if (c.enabled) void manager.ensure(c).catch(() => {})
  }

  manager.on('status', async (id: string) => {
    const c = await store.get(id)
    if (c) send('connectors:status', info(c))
  })

  ipcMain.handle('connectors:list', async () => (await store.list()).map(info))
  ipcMain.handle('connectors:save', async (_e, raw: unknown) => {
    const c = await store.save(readConnectorInput(raw))
    warm(c)
    return info(c)
  })
  ipcMain.handle('connectors:start', async (_e, id: string) => {
    warm(await required(id))
  })
  ipcMain.handle('connectors:refresh', async (_e, id: string) => {
    const c = await required(id)
    // Its status carries any error to Settings.
    await manager.refresh(c).catch(() => {})
    return info(c)
  })
  ipcMain.handle('connectors:setEnabled', async (_e, id: string, enabled: boolean) => {
    const c = await store.setEnabled(id, enabled === true)
    if (c.enabled) warm(c)
    else await manager.stop(id, true)
    return info(c)
  })
  ipcMain.handle('connectors:setToolPermission', async (_e, id: string, tool: string, permission: ToolPermission) => {
    if (typeof tool !== 'string' || !PERMISSIONS.includes(permission)) throw new Error('Unknown permission.')
    return info(await store.setToolPermission(id, tool, permission))
  })
  ipcMain.handle('connectors:remove', async (_e, id: string) => {
    await manager.stop(id)
    await store.remove(id)
  })
}
