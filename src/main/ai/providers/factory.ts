import { AI_PRESETS, type AiProviderKind } from '@shared/ai'
import { AnthropicProvider } from './anthropic'
import { OpenAiCompatibleProvider } from './openai'
import type { LlmProvider, ProviderConfig } from './types'

export function createProvider(cfg: ProviderConfig): LlmProvider {
  return cfg.protocol === 'anthropic' ? new AnthropicProvider(cfg) : new OpenAiCompatibleProvider(cfg)
}

export function providerConfigFor(
  s: { provider: AiProviderKind; baseUrl: string; model: string; embeddingModel: string },
  apiKey: string | null,
  extra: Partial<ProviderConfig> = {}
): ProviderConfig {
  const preset = AI_PRESETS[s.provider] ?? AI_PRESETS.custom
  return {
    protocol: preset.protocol,
    kind: s.provider,
    baseUrl: (s.baseUrl || preset.baseUrl).trim(),
    apiKey: apiKey && apiKey.trim() ? apiKey.trim() : null,
    model: (s.model || preset.defaultModel).trim(),
    embeddingModel: (s.embeddingModel ?? '').trim(),
    ...extra
  }
}
