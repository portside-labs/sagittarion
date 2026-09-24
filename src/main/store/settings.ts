import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { PROVIDERS, type AgentSettings, type AiConnection, type AiConnectionInput, type AiSettings, type AiSettingsUpdate, type ProviderId } from '@shared/ai'
import type { CredentialStore } from './credentials'

/** A connection as saved: the secret is a reference into the credential store. */
export interface StoredConnection {
  id: string
  name: string
  type: AiConnection['type']
  provider: ProviderId
  baseUrl: string
  credentialRef: string | null
  defaultModel: string
  embeddingModel: string
  capabilityOverrides?: AiConnection['capabilityOverrides']
  createdAt: number
}

interface StoredAi {
  version: 2
  activeConnectionId: string | null
  activeModel: string
  connections: StoredConnection[]
  agent: AgentSettings
}

/** The provider-centric layout written before connections existed. */
interface LegacyAi {
  provider?: string
  baseUrl?: string
  model?: string
  embeddingModel?: string
  sendSampleValues?: boolean
  autoRun?: boolean
  schemaBudgetTokens?: number
  /** provider -> encrypted key */
  keys?: Record<string, string>
}

interface StoredSettings {
  ai?: StoredAi | LegacyAi
}

const DEFAULT_AGENT: AgentSettings = { schemaBudgetTokens: 8000, autoRun: true, sendSampleValues: false }

/** Provider ids as they were saved earlier map onto the current ones. */
export function normalizeProviderId(raw: string | undefined): ProviderId {
  if (raw === 'custom') return 'openai-compatible'
  return raw && raw in PROVIDERS ? (raw as ProviderId) : 'openai-compatible'
}

function isCurrent(ai: StoredAi | LegacyAi | undefined): ai is StoredAi {
  return Boolean(ai) && (ai as StoredAi).version === 2 && Array.isArray((ai as StoredAi).connections)
}

/** App-wide AI settings: connections, the active model and the agent's own options. */
export class SettingsStore {
  private cache: StoredSettings | null = null

  constructor(
    private readonly file: string,
    private readonly credentials: CredentialStore
  ) {}

  private async load(): Promise<StoredSettings> {
    if (this.cache) return this.cache
    try {
      this.cache = JSON.parse(await fs.readFile(this.file, 'utf8')) as StoredSettings
    } catch {
      this.cache = {}
    }
    return this.cache
  }

  private async persist(s: StoredSettings): Promise<void> {
    this.cache = s
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(s, null, 2), 'utf8')
    await fs.rename(tmp, this.file)
  }

  /** The AI block in its current shape, migrating the provider-centric one the first time it is seen. */
  private async ai(): Promise<StoredAi> {
    const stored = await this.load()
    if (isCurrent(stored.ai)) return stored.ai
    const migrated = await this.migrate(stored.ai ?? {})
    await this.persist({ ...stored, ai: migrated })
    return migrated
  }

  /**
   * The old single provider becomes the active connection; every stored key becomes a connection of its own,
   * its ciphertext moved into the credential store as-is, so nobody has to type a key again.
   */
  private async migrate(legacy: LegacyAi): Promise<StoredAi> {
    const now = Date.now()
    const connections: StoredConnection[] = []
    const make = (provider: ProviderId, active: boolean): StoredConnection => {
      const preset = PROVIDERS[provider]
      return {
        id: randomUUID(),
        name: preset.label,
        type: preset.type,
        provider,
        baseUrl: active ? legacy.baseUrl?.trim() || preset.baseUrl : preset.baseUrl,
        credentialRef: null,
        defaultModel: active ? (legacy.model ?? preset.defaultModel).trim() : preset.defaultModel,
        embeddingModel: active ? (legacy.embeddingModel ?? '').trim() : '',
        createdAt: now
      }
    }
    const activeProvider = normalizeProviderId(legacy.provider ?? 'openai')
    const active = make(activeProvider, true)
    connections.push(active)
    for (const [rawProvider, cipher] of Object.entries(legacy.keys ?? {})) {
      if (!cipher) continue
      const provider = normalizeProviderId(rawProvider)
      let conn = connections.find((c) => c.provider === provider)
      if (!conn) {
        conn = make(provider, false)
        connections.push(conn)
      }
      const ref = `cred-${conn.id}`
      await this.credentials.importEncrypted(ref, cipher)
      conn.credentialRef = ref
    }
    return {
      version: 2,
      activeConnectionId: active.id,
      activeModel: active.defaultModel,
      connections,
      agent: {
        schemaBudgetTokens: legacy.schemaBudgetTokens ?? DEFAULT_AGENT.schemaBudgetTokens,
        autoRun: legacy.autoRun ?? DEFAULT_AGENT.autoRun,
        sendSampleValues: Boolean(legacy.sendSampleValues)
      }
    }
  }

  async apiKeyFor(conn: { credentialRef: string | null }): Promise<string | null> {
    return conn.credentialRef ? this.credentials.get(conn.credentialRef) : null
  }

  private async describe(c: StoredConnection): Promise<AiConnection> {
    const { credentialRef, ...rest } = c
    const key = credentialRef ? await this.credentials.get(credentialRef) : null
    return { ...rest, protocol: PROVIDERS[c.provider].protocol, hasCredential: key !== null, credentialHint: key ? key.slice(-4) : null }
  }

  async get(): Promise<AiSettings> {
    const ai = await this.ai()
    const connections: AiConnection[] = []
    for (const c of ai.connections) connections.push(await this.describe(c))
    return {
      activeConnectionId: ai.activeConnectionId,
      activeModel: ai.activeModel,
      connections,
      agent: { ...DEFAULT_AGENT, ...ai.agent },
      encryptionAvailable: this.credentials.available,
      managedAccount: null
    }
  }

  /**
   * Applies a change. A connection given here is created or updated (one per provider unless an id is passed),
   * gets its key stored or removed, and becomes the active connection.
   */
  async update(u: AiSettingsUpdate): Promise<AiSettings> {
    const stored = await this.load()
    const current = await this.ai()
    const ai: StoredAi = { ...current, connections: current.connections.map((c) => ({ ...c })), agent: { ...current.agent } }
    if (u.connection) {
      const input = u.connection
      const provider = normalizeProviderId(input.provider)
      const preset = PROVIDERS[provider]
      if (!preset.available) throw new Error(`${preset.label} is not available yet.`)
      let conn = (input.id ? ai.connections.find((c) => c.id === input.id) : undefined) ?? ai.connections.find((c) => c.provider === provider)
      if (!conn) {
        conn = { id: randomUUID(), name: preset.label, type: preset.type, provider, baseUrl: preset.baseUrl, credentialRef: null, defaultModel: preset.defaultModel, embeddingModel: '', createdAt: Date.now() }
        ai.connections.push(conn)
      }
      if (typeof input.name === 'string' && input.name.trim()) conn.name = input.name.trim()
      if (typeof input.baseUrl === 'string') conn.baseUrl = input.baseUrl.trim() || preset.baseUrl
      if (typeof input.defaultModel === 'string') conn.defaultModel = input.defaultModel.trim()
      if (typeof input.embeddingModel === 'string') conn.embeddingModel = input.embeddingModel.trim()
      if (input.apiKey === null) {
        if (conn.credentialRef) await this.credentials.remove(conn.credentialRef)
        conn.credentialRef = null
      } else if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
        const ref = conn.credentialRef ?? `cred-${conn.id}`
        await this.credentials.set(ref, input.apiKey.trim())
        conn.credentialRef = ref
      }
      ai.activeConnectionId = conn.id
      if (typeof input.defaultModel === 'string') ai.activeModel = conn.defaultModel
    }
    if (u.activeConnectionId && ai.connections.some((c) => c.id === u.activeConnectionId)) ai.activeConnectionId = u.activeConnectionId
    if (typeof u.activeModel === 'string') {
      ai.activeModel = u.activeModel.trim()
      const active = ai.connections.find((c) => c.id === ai.activeConnectionId)
      if (active) active.defaultModel = ai.activeModel
    }
    if (u.agent) {
      if (typeof u.agent.autoRun === 'boolean') ai.agent.autoRun = u.agent.autoRun
      if (typeof u.agent.sendSampleValues === 'boolean') ai.agent.sendSampleValues = u.agent.sendSampleValues
      if (typeof u.agent.schemaBudgetTokens === 'number' && u.agent.schemaBudgetTokens >= 1000) ai.agent.schemaBudgetTokens = Math.round(u.agent.schemaBudgetTokens)
    }
    await this.persist({ ...stored, ai })
    return this.get()
  }

  /**
   * The connection to talk to, with its key: the active one, or one as typed into Settings before saving
   * (its saved key is used when the form did not supply one).
   */
  async resolve(input?: AiConnectionInput): Promise<{ connection: StoredConnection; apiKey: string | null }> {
    const ai = await this.ai()
    if (!input) {
      const active = ai.connections.find((c) => c.id === ai.activeConnectionId)
      if (!active) throw new Error('Set up an AI connection in Settings to ask questions in plain English.')
      return { connection: { ...active, defaultModel: ai.activeModel || active.defaultModel }, apiKey: await this.apiKeyFor(active) }
    }
    const provider = normalizeProviderId(input.provider)
    const preset = PROVIDERS[provider]
    const saved = (input.id ? ai.connections.find((c) => c.id === input.id) : undefined) ?? ai.connections.find((c) => c.provider === provider)
    const connection: StoredConnection = {
      id: saved?.id ?? 'draft',
      name: saved?.name ?? preset.label,
      type: preset.type,
      provider,
      baseUrl: input.baseUrl?.trim() || saved?.baseUrl || preset.baseUrl,
      credentialRef: saved?.credentialRef ?? null,
      defaultModel: input.defaultModel?.trim() || saved?.defaultModel || preset.defaultModel,
      embeddingModel: input.embeddingModel?.trim() ?? saved?.embeddingModel ?? '',
      createdAt: saved?.createdAt ?? Date.now()
    }
    const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : await this.apiKeyFor(connection)
    return { connection, apiKey }
  }
}
