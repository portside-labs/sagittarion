// Natural-language to SQL with a user-chosen LLM provider: shared types and presets.

export type AiProviderKind = 'openai' | 'anthropic' | 'google' | 'groq' | 'openrouter' | 'ollama' | 'custom'

/** Which wire protocol a provider speaks. */
export type AiProtocol = 'openai' | 'anthropic'

export interface AiProviderPreset {
  kind: AiProviderKind
  label: string
  protocol: AiProtocol
  baseUrl: string
  defaultModel: string
  /** Embedding model for schema search when the provider offers embeddings. Empty means unsupported. */
  defaultEmbeddingModel: string
  needsKey: boolean
  keyUrl?: string
  notes: string
}

export const AI_PRESETS: Record<AiProviderKind, AiProviderPreset> = {
  openai: {
    kind: 'openai',
    label: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.4-mini',
    defaultEmbeddingModel: 'text-embedding-3-small',
    needsKey: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    notes: 'Any current GPT model works; smaller models are fine for SQL.'
  },
  anthropic: {
    kind: 'anthropic',
    label: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-5',
    defaultEmbeddingModel: '',
    needsKey: true,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    notes: 'Claude models. The schema block is marked cacheable, so repeated questions are cheap.'
  },
  google: {
    kind: 'google',
    label: 'Google Gemini',
    protocol: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
    defaultEmbeddingModel: 'text-embedding-004',
    needsKey: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    notes: 'Uses the OpenAI-compatible Gemini endpoint.'
  },
  groq: {
    kind: 'groq',
    label: 'Groq',
    protocol: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: '',
    defaultEmbeddingModel: '',
    needsKey: true,
    keyUrl: 'https://console.groq.com/keys',
    notes: 'Fast open-weight models. Use "Fetch models" to pick one.'
  },
  openrouter: {
    kind: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: '',
    defaultEmbeddingModel: '',
    needsKey: true,
    keyUrl: 'https://openrouter.ai/keys',
    notes: 'One key for many models. Model ids look like "vendor/model".'
  },
  ollama: {
    kind: 'ollama',
    label: 'Ollama (local)',
    protocol: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: '',
    defaultEmbeddingModel: 'nomic-embed-text',
    needsKey: false,
    notes: 'Runs on your machine; nothing leaves it. Use "Fetch models" to see what is installed.'
  },
  custom: {
    kind: 'custom',
    label: 'Custom (OpenAI-compatible)',
    protocol: 'openai',
    baseUrl: '',
    defaultModel: '',
    defaultEmbeddingModel: '',
    needsKey: false,
    notes: 'Any server that speaks the OpenAI chat-completions API, such as vLLM or LM Studio.'
  }
}

export const SCHEMA_BUDGETS = [4000, 8000, 16000, 32000] as const

export interface AiSettings {
  provider: AiProviderKind
  baseUrl: string
  model: string
  embeddingModel: string
  hasKey: boolean
  /** Last four characters of the stored key for the current provider. */
  keyHint: string | null
  /** Send up to 20 distinct values of short text columns for the tables in context. */
  sendSampleValues: boolean
  /** Run generated queries automatically once they pass the read-only and EXPLAIN checks. */
  autoRun: boolean
  /** Token budget for the schema excerpt in each request. */
  schemaBudgetTokens: number
  encryptionAvailable: boolean
}

export interface AiSettingsUpdate {
  provider?: AiProviderKind
  baseUrl?: string
  model?: string
  embeddingModel?: string
  /** A new key for the (possibly updated) provider, or null to remove the stored key. */
  apiKey?: string | null
  sendSampleValues?: boolean
  autoRun?: boolean
  schemaBudgetTokens?: number
}

/** One earlier exchange in the same chat, sent back so follow-up questions make sense. */
export interface AiTurn {
  question: string
  /** The query that answered it, when there was one. */
  sql?: string
  /** What the model said instead, e.g. a request for clarification. */
  answer?: string
}

export interface AiUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  requests: number
  toolCalls: number
  provider: string
  model: string
}

export interface AiQueryResult {
  kind: 'query'
  sql: string
  explanation: string
  tablesUsed: string[]
  assumptions: string[]
  checks: { readOnly: true; explained: boolean; repairs: number }
  context: { mode: 'all' | 'retrieved'; tables: number; totalTables: number; schemaTokens: number }
  usage: AiUsage
  autoRun: boolean
}

export interface AiClarification {
  kind: 'clarify'
  message: string
  usage: AiUsage
}

export interface AiCancelled {
  kind: 'cancelled'
  usage: AiUsage
}

export type AiResult = AiQueryResult | AiClarification | AiCancelled

export type AiStage = 'index' | 'retrieve' | 'sample' | 'request' | 'tool' | 'check' | 'repair' | 'done' | 'error' | 'cancelled'

/** One step of an ask, streamed to the renderer while the model works. A step is reported twice: running, then done or error. */
export interface AiProgressEvent {
  requestId: string
  seq: number
  stepId: string
  stage: AiStage
  status: 'running' | 'done' | 'error'
  message: string
  detail?: string
  ts: number
}

export type AiProgressStep = Omit<AiProgressEvent, 'requestId' | 'seq' | 'ts'>
