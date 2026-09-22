import { promises as fs } from 'node:fs'
import path from 'node:path'
import { AI_PRESETS, type AiProviderKind, type AiSettings, type AiSettingsUpdate } from '@shared/ai'
import type { SecretCodec } from './connections'

interface StoredAi {
  provider?: AiProviderKind
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
  ai?: StoredAi
}

/** App-wide settings. Provider keys are stored encrypted with the OS keychain codec. */
export class SettingsStore {
  private cache: StoredSettings | null = null

  constructor(
    private readonly file: string,
    private readonly codec: SecretCodec
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
    const tmp = this.file + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(s, null, 2), 'utf8')
    await fs.rename(tmp, this.file)
  }

  async apiKeyFor(provider: AiProviderKind): Promise<string | null> {
    const s = await this.load()
    const enc = s.ai?.keys?.[provider]
    if (!enc) return null
    return this.codec.decrypt(enc)
  }

  async get(): Promise<AiSettings> {
    const s = (await this.load()).ai ?? {}
    const provider: AiProviderKind = s.provider && s.provider in AI_PRESETS ? s.provider : 'openai'
    const preset = AI_PRESETS[provider]
    const key = await this.apiKeyFor(provider)
    return {
      provider,
      baseUrl: s.baseUrl ?? preset.baseUrl,
      model: s.model ?? preset.defaultModel,
      embeddingModel: s.embeddingModel ?? '',
      hasKey: Boolean(key),
      keyHint: key ? key.slice(-4) : null,
      sendSampleValues: Boolean(s.sendSampleValues),
      autoRun: s.autoRun ?? true,
      schemaBudgetTokens: s.schemaBudgetTokens ?? 8000,
      encryptionAvailable: this.codec.available
    }
  }

  async update(u: AiSettingsUpdate): Promise<AiSettings> {
    const stored = { ...(await this.load()) }
    const ai: StoredAi = { ...(stored.ai ?? {}), keys: { ...(stored.ai?.keys ?? {}) } }
    if (u.provider && u.provider in AI_PRESETS && u.provider !== ai.provider) {
      const preset = AI_PRESETS[u.provider]
      ai.provider = u.provider
      // Switching provider resets the endpoint and model to that provider's defaults unless given.
      ai.baseUrl = u.baseUrl ?? preset.baseUrl
      ai.model = u.model ?? preset.defaultModel
      ai.embeddingModel = u.embeddingModel ?? ''
    }
    if (typeof u.baseUrl === 'string') ai.baseUrl = u.baseUrl.trim()
    if (typeof u.model === 'string') ai.model = u.model.trim()
    if (typeof u.embeddingModel === 'string') ai.embeddingModel = u.embeddingModel.trim()
    if (typeof u.sendSampleValues === 'boolean') ai.sendSampleValues = u.sendSampleValues
    if (typeof u.autoRun === 'boolean') ai.autoRun = u.autoRun
    if (typeof u.schemaBudgetTokens === 'number' && u.schemaBudgetTokens >= 1000) ai.schemaBudgetTokens = Math.round(u.schemaBudgetTokens)
    const provider = ai.provider ?? 'openai'
    if (u.apiKey === null) {
      delete ai.keys![provider]
    } else if (typeof u.apiKey === 'string' && u.apiKey.trim()) {
      if (!this.codec.available) throw new Error('This system cannot store secrets securely, so the API key was not saved.')
      const enc = this.codec.encrypt(u.apiKey.trim())
      if (!enc) throw new Error('Could not encrypt the API key.')
      ai.keys![provider] = enc
    }
    await this.persist({ ...stored, ai })
    return this.get()
  }
}
