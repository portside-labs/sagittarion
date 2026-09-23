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
  /** Providers with a stored key, plus those that need none. */
  configuredProviders: AiProviderKind[]
}

export interface CatalogModel {
  provider: AiProviderKind
  id: string
  label: string
}

/** Well-known models offered in the model menu; the configured provider's live list is merged in. */
export const MODEL_CATALOG: CatalogModel[] = [
  { provider: 'anthropic', id: 'claude-opus-5', label: 'Claude Opus 5' },
  { provider: 'anthropic', id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { provider: 'anthropic', id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  { provider: 'openai', id: 'gpt-5.4', label: 'GPT-5.4' },
  { provider: 'openai', id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
  { provider: 'google', id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { provider: 'google', id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { provider: 'groq', id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
  { provider: 'groq', id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' }
]

/** Family names and qualifiers as their makers write them, for ids that are not in the catalogue. */
const MODEL_WORDS: Record<string, string> = {
  claude: 'Claude', gpt: 'GPT', gemini: 'Gemini', gemma: 'Gemma', llama: 'Llama', mistral: 'Mistral', mixtral: 'Mixtral',
  qwen: 'Qwen', qwq: 'QwQ', deepseek: 'DeepSeek', phi: 'Phi', grok: 'Grok', codestral: 'Codestral', devstral: 'Devstral',
  command: 'Command', nemotron: 'Nemotron', kimi: 'Kimi', glm: 'GLM', minimax: 'MiniMax',
  opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', pro: 'Pro', flash: 'Flash', lite: 'Lite', mini: 'mini', nano: 'nano',
  oss: 'OSS', turbo: 'Turbo', instruct: 'Instruct', chat: 'Chat', preview: 'Preview', versatile: 'Versatile', instant: 'Instant',
  thinking: 'Thinking', vision: 'Vision', coder: 'Coder', code: 'Code', moe: 'MoE', large: 'Large', medium: 'Medium', small: 'Small',
  ultra: 'Ultra', embed: 'Embed', embedding: 'Embedding', text: 'Text', exp: 'Exp', it: 'IT', r1: 'R1', v3: 'V3', k2: 'K2',
  maverick: 'Maverick', scout: 'Scout'
}

/**
 * A readable title for a model id: "claude-haiku-4-5-20251001" becomes "Claude Haiku 4.5",
 * "llama3.2:latest" becomes "Llama 3.2". Vendor prefixes, release dates and ":latest" tags are dropped.
 */
export function prettyModelName(id: string): string {
  let s = id.trim()
  const slash = s.lastIndexOf('/')
  if (slash >= 0) s = s.slice(slash + 1)
  s = s.replace(/:latest$/i, '').replace(/:/g, '-')
  s = s.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '')
  // "llama3.2" and "gpt4" read better with the number set apart, but only after a family name.
  s = s.replace(/^([a-z]+)(\d)/i, (m, w: string, d: string) => (MODEL_WORDS[w.toLowerCase()] ? `${w}-${d}` : m))
  const words: string[] = []
  for (const t of s.split(/[-_]+/).filter(Boolean)) {
    const lower = t.toLowerCase()
    if (lower === 'latest') continue
    const prev = words[words.length - 1]
    if (/^\d{1,2}$/.test(t) && prev !== undefined && /^\d+(\.\d+)*$/.test(prev)) {
      words[words.length - 1] = `${prev}.${t}`
    } else if (/^\d+(\.\d+)*$/.test(t) || /^o\d+$/.test(lower) || /^\d+[a-z]$/.test(lower) && !/^\d+[bm]$/.test(lower)) {
      words.push(t)
    } else if (/^\d+[bm]$/.test(lower)) {
      words.push(t.toUpperCase())
    } else if (MODEL_WORDS[lower]) {
      words.push(MODEL_WORDS[lower])
    } else {
      words.push(t.charAt(0).toUpperCase() + t.slice(1))
    }
  }
  let out = ''
  for (const [i, w] of words.entries()) {
    if (i === 0) out = w
    else if (words[i - 1] === 'GPT' && /^\d/.test(w)) out += `-${w}`
    else out += ` ${w}`
  }
  return out || id
}

/** The catalogue title of a model when it has one, otherwise a readable form of its id. */
export function modelTitle(provider: AiProviderKind, id: string): string {
  const known = MODEL_CATALOG.find((m) => m.provider === provider && m.id === id)
  return known ? known.label : prettyModelName(id)
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
