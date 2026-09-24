import { presetFor, type ProviderId } from '@shared/ai'
import { AnthropicProvider } from './anthropic'
import { OpenAiCompatibleProvider } from './openai'
import type { LlmProvider, ProviderConfig } from './types'

export function createProvider(cfg: ProviderConfig): LlmProvider {
  return cfg.protocol === 'anthropic' ? new AnthropicProvider(cfg) : new OpenAiCompatibleProvider(cfg)
}

/** Wire-level configuration for a provider id, accepting ids saved before connections existed. */
export function providerConfigFor(
  s: { provider: ProviderId | string; baseUrl: string; model: string; embeddingModel: string },
  apiKey: string | null,
  extra: Partial<ProviderConfig> = {}
): ProviderConfig {
  const preset = presetFor(s.provider)
  return {
    protocol: preset.protocol === 'anthropic' ? 'anthropic' : 'openai',
    kind: preset.id,
    baseUrl: (s.baseUrl || preset.baseUrl).trim(),
    apiKey: apiKey && apiKey.trim() ? apiKey.trim() : null,
    model: (s.model || preset.defaultModel).trim(),
    embeddingModel: (s.embeddingModel ?? '').trim(),
    ...extra
  }
}
