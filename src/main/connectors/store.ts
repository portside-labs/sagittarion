import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ConnectorInfo, ConnectorInput, ConnectorScope, ConnectorStatus, ConnectorTransport, ToolPermission } from '@shared/connectors'
import type { SecretCodec } from '../store/connections'

/** A connector as saved. Environment variable and header values are secrets: encrypted, or null where they could not be. */
interface StoredConnector {
  id: string
  name: string
  enabled: boolean
  transport: ConnectorTransport
  command: string
  args: string[]
  env: Record<string, string | null>
  url: string
  headers: Record<string, string | null>
  scope: ConnectorScope
  connectionIds: string[]
  toolPermissions: Record<string, ToolPermission>
  createdAt: number
}

/** A connector with its secrets in the clear, for the main process alone. */
export interface Connector extends Omit<StoredConnector, 'env' | 'headers'> {
  env: Record<string, string>
  headers: Record<string, string>
  /** Keys whose values are not to hand: saved on a computer that could not keep them, before a relaunch. */
  missingSecrets: string[]
}

const PERMISSIONS: ToolPermission[] = ['allow', 'ask', 'never']

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function record(v: unknown): Record<string, string | null> {
  if (!v || typeof v !== 'object') return {}
  const out: Record<string, string | null> = {}
  for (const [k, x] of Object.entries(v)) if (k && (typeof x === 'string' || x === null)) out[k] = x
  return out
}

function migrate(raw: any): StoredConnector | null {
  if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string') return null
  const permissions: Record<string, ToolPermission> = {}
  for (const [k, v] of Object.entries(raw.toolPermissions ?? {})) if (PERMISSIONS.includes(v as ToolPermission)) permissions[k] = v as ToolPermission
  return {
    id: raw.id,
    name: raw.name,
    enabled: raw.enabled !== false,
    transport: raw.transport === 'http' ? 'http' : 'stdio',
    command: typeof raw.command === 'string' ? raw.command : '',
    args: strings(raw.args),
    env: record(raw.env),
    url: typeof raw.url === 'string' ? raw.url : '',
    headers: record(raw.headers),
    scope: raw.scope === 'selected' ? 'selected' : 'all',
    connectionIds: strings(raw.connectionIds),
    toolPermissions: permissions,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now()
  }
}

/** The MCP servers the user connected, in connectors.json. */
export class ConnectorStore {
  private cache: StoredConnector[] | null = null
  /**
   * Secrets typed this session that the codec could not save (no keyring): kept here until the app quits, so the
   * connector works now and asks for them again after a relaunch.
   */
  private readonly unsaved = new Map<string, Record<string, string>>()

  constructor(
    private readonly file: string,
    private readonly codec: SecretCodec
  ) {}

  private async load(): Promise<StoredConnector[]> {
    if (this.cache) return this.cache
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'))
      this.cache = (Array.isArray(parsed?.connectors) ? parsed.connectors : []).map(migrate).filter((c: StoredConnector | null): c is StoredConnector => c !== null)
    } catch {
      this.cache = []
    }
    return this.cache!
  }

  private async persist(list: StoredConnector[]): Promise<void> {
    this.cache = list
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    await fs.writeFile(tmp, JSON.stringify({ version: 1, connectors: list }, null, 2), { encoding: 'utf8', mode: 0o600 })
    await fs.rename(tmp, this.file)
  }

  /** Values for one connector's secrets, from the keychain or from this session. `prefix` keeps env and headers apart. */
  private reveal(id: string, prefix: string, stored: Record<string, string | null>, missing: string[]): Record<string, string> {
    const out: Record<string, string> = {}
    const session = this.unsaved.get(id) ?? {}
    for (const [key, cipher] of Object.entries(stored)) {
      const plain = cipher ? this.codec.decrypt(cipher) : null
      const value = plain ?? session[prefix + key]
      if (value === undefined) missing.push(key)
      else out[key] = value
    }
    return out
  }

  private toConnector(s: StoredConnector): Connector {
    const missing: string[] = []
    const env = this.reveal(s.id, 'env:', s.env, missing)
    const headers = this.reveal(s.id, 'header:', s.headers, missing)
    return { ...s, args: [...s.args], connectionIds: [...s.connectionIds], toolPermissions: { ...s.toolPermissions }, env, headers, missingSecrets: missing }
  }

  async list(): Promise<Connector[]> {
    return (await this.load()).map((s) => this.toConnector(s)).sort((a, b) => a.createdAt - b.createdAt)
  }

  async get(id: string): Promise<Connector | undefined> {
    const s = (await this.load()).find((c) => c.id === id)
    return s ? this.toConnector(s) : undefined
  }

  /** Secrets for one side (env or headers): a null value keeps the saved one; a key left out is dropped. */
  private seal(id: string, prefix: string, input: Record<string, string | null>, previous: Record<string, string | null>): Record<string, string | null> {
    const out: Record<string, string | null> = {}
    const session = { ...(this.unsaved.get(id) ?? {}) }
    for (const key of Object.keys(session)) if (key.startsWith(prefix) && !(key.slice(prefix.length) in input)) delete session[key]
    for (const [rawKey, value] of Object.entries(input)) {
      const key = rawKey.trim()
      if (!key) continue
      if (value === null) {
        out[key] = previous[key] ?? null
        continue
      }
      const cipher = this.codec.available ? this.codec.encrypt(value) : null
      out[key] = cipher
      if (cipher) delete session[prefix + key]
      else session[prefix + key] = value
    }
    if (Object.keys(session).length) this.unsaved.set(id, session)
    else this.unsaved.delete(id)
    return out
  }

  async save(input: ConnectorInput): Promise<Connector> {
    const list = await this.load()
    const id = input.id || randomUUID()
    const existing = list.find((c) => c.id === id)
    const stored: StoredConnector = {
      id,
      name: input.name.trim() || (input.transport === 'http' ? input.url.trim() : input.command.trim()) || 'Connector',
      enabled: input.enabled,
      transport: input.transport === 'http' ? 'http' : 'stdio',
      command: input.transport === 'stdio' ? input.command.trim() : '',
      args: input.transport === 'stdio' ? input.args : [],
      env: input.transport === 'stdio' ? this.seal(id, 'env:', input.env, existing?.env ?? {}) : {},
      url: input.transport === 'http' ? input.url.trim() : '',
      headers: input.transport === 'http' ? this.seal(id, 'header:', input.headers, existing?.headers ?? {}) : {},
      scope: input.scope === 'selected' ? 'selected' : 'all',
      connectionIds: [...new Set(input.connectionIds)],
      toolPermissions: existing?.toolPermissions ?? {},
      createdAt: existing?.createdAt ?? Date.now()
    }
    const next = existing ? list.map((c) => (c.id === id ? stored : c)) : [...list, stored]
    await this.persist(next)
    return this.toConnector(stored)
  }

  private async patch(id: string, change: (c: StoredConnector) => StoredConnector): Promise<Connector> {
    const list = await this.load()
    const found = list.find((c) => c.id === id)
    if (!found) throw new Error('That connector no longer exists.')
    const next = change(found)
    await this.persist(list.map((c) => (c.id === id ? next : c)))
    return this.toConnector(next)
  }

  setEnabled(id: string, enabled: boolean): Promise<Connector> {
    return this.patch(id, (c) => ({ ...c, enabled }))
  }

  setToolPermission(id: string, tool: string, permission: ToolPermission): Promise<Connector> {
    return this.patch(id, (c) => ({ ...c, toolPermissions: { ...c.toolPermissions, [tool]: permission } }))
  }

  /** A database connection was deleted: connectors scoped to it forget it. */
  async forgetConnection(connectionId: string): Promise<void> {
    const list = await this.load()
    if (!list.some((c) => c.connectionIds.includes(connectionId))) return
    await this.persist(list.map((c) => ({ ...c, connectionIds: c.connectionIds.filter((x) => x !== connectionId) })))
  }

  async remove(id: string): Promise<void> {
    this.unsaved.delete(id)
    await this.persist((await this.load()).filter((c) => c.id !== id))
  }
}

/** What the renderer may see of a connector: everything but the secret values. */
export function connectorInfo(c: Connector, status: ConnectorStatus): ConnectorInfo {
  const keys = (have: Record<string, string>) => [...Object.keys(have), ...c.missingSecrets.filter((k) => !(k in have))]
  return {
    id: c.id,
    name: c.name,
    enabled: c.enabled,
    transport: c.transport,
    command: c.command,
    args: c.args,
    url: c.url,
    scope: c.scope,
    connectionIds: c.connectionIds,
    envKeys: c.transport === 'stdio' ? keys(c.env) : [],
    headerKeys: c.transport === 'http' ? keys(c.headers) : [],
    missingSecrets: c.missingSecrets,
    toolPermissions: c.toolPermissions,
    status
  }
}
