// Natural-language to SQL with an AI connection of the user's choosing: shared types, presets and catalogue.
//
// Three words that are kept apart on purpose:
//   connection  how the app reaches models: your own key with a vendor, a local server, or (later) Managed AI
//   provider    the API family behind a connection, e.g. Anthropic, OpenRouter, Ollama
//   model       what answers, e.g. Claude Sonnet, which several connections may offer

export type ConnectionType = 'managed' | 'byok' | 'local'

export type ProviderId = 'openai' | 'anthropic' | 'google' | 'groq' | 'openrouter' | 'ollama' | 'lmstudio' | 'vllm' | 'litellm' | 'openai-compatible' | 'managed'

/** Kept for stored settings written before connections existed. */
export type AiProviderKind = ProviderId

/** Which wire protocol a provider speaks. */
export type AiProtocol = 'openai' | 'anthropic' | 'managed'

export interface AiProviderPreset {
  id: ProviderId
  type: ConnectionType
  label: string
  protocol: AiProtocol
  baseUrl: string
  defaultModel: string
  /** Embedding model for schema search when the provider offers embeddings. Empty means unsupported. */
  defaultEmbeddingModel: string
  needsKey: boolean
  keyUrl?: string
  notes: string
  /** False while a connection type is announced but not usable yet. */
  available: boolean
}

export const PROVIDERS: Record<ProviderId, AiProviderPreset> = {
  managed: {
    id: 'managed',
    type: 'managed',
    label: 'Managed AI',
    protocol: 'managed',
    baseUrl: '',
    defaultModel: '',
    defaultEmbeddingModel: '',
    needsKey: false,
    notes: 'Claude, GPT, Gemini and more through one account, with no API keys to manage.',
    available: false
  },
  openai: {
    id: 'openai',
    type: 'byok',
    label: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.4-mini',
    defaultEmbeddingModel: 'text-embedding-3-small',
    needsKey: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    notes: 'Any current GPT model works; smaller models are fine for SQL.',
    available: true
  },
  anthropic: {
    id: 'anthropic',
    type: 'byok',
    label: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-5',
    defaultEmbeddingModel: '',
    needsKey: true,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    notes: 'Claude models. The schema block is marked cacheable, so repeated questions are cheap.',
    available: true
  },
  google: {
    id: 'google',
    type: 'byok',
    label: 'Google Gemini',
    protocol: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
    defaultEmbeddingModel: 'text-embedding-004',
    needsKey: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    notes: 'Uses the OpenAI-compatible Gemini endpoint.',
    available: true
  },
  openrouter: {
    id: 'openrouter',
    type: 'byok',
    label: 'OpenRouter',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: '',
    defaultEmbeddingModel: '',
    needsKey: true,
    keyUrl: 'https://openrouter.ai/keys',
    notes: 'One key for many vendors. Model ids look like "vendor/model".',
    available: true
  },
  groq: {
    id: 'groq',
    type: 'byok',
    label: 'Groq',
    protocol: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: '',
    defaultEmbeddingModel: '',
    needsKey: true,
    keyUrl: 'https://console.groq.com/keys',
    notes: 'Fast open-weight models. Use "Fetch models" to pick one.',
    available: true
  },
  ollama: {
    id: 'ollama',
    type: 'local',
    label: 'Ollama',
    protocol: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: '',
    defaultEmbeddingModel: 'nomic-embed-text',
    needsKey: false,
    notes: 'Runs on your machine; nothing leaves it. Use "Fetch models" to see what is installed.',
    available: true
  },
  lmstudio: {
    id: 'lmstudio',
    type: 'local',
    label: 'LM Studio',
    protocol: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    defaultModel: '',
    defaultEmbeddingModel: '',
    needsKey: false,
    notes: 'Start the local server in LM Studio, then fetch the loaded models.',
    available: true
  },
  vllm: {
    id: 'vllm',
    type: 'local',
    label: 'vLLM',
    protocol: 'openai',
    baseUrl: 'http://localhost:8000/v1',
    defaultModel: '',
    defaultEmbeddingModel: '',
    needsKey: false,
    notes: 'The OpenAI-compatible server vLLM starts with "vllm serve".',
    available: true
  },
  litellm: {
    id: 'litellm',
    type: 'local',
    label: 'LiteLLM',
    protocol: 'openai',
    baseUrl: 'http://localhost:4000/v1',
    defaultModel: '',
    defaultEmbeddingModel: '',
    needsKey: false,
    notes: 'A LiteLLM proxy, yours or your company\'s. Add its virtual key if it has one.',
    available: true
  },
  'openai-compatible': {
    id: 'openai-compatible',
    type: 'local',
    label: 'OpenAI-compatible server',
    protocol: 'openai',
    baseUrl: '',
    defaultModel: '',
    defaultEmbeddingModel: '',
    needsKey: false,
    notes: 'Any server that speaks the OpenAI chat-completions API.',
    available: true
  }
}

/** The preset for a provider id, accepting the pre-connection name "custom". */
export function presetFor(id: string): AiProviderPreset {
  return PROVIDERS[id as ProviderId] ?? PROVIDERS['openai-compatible']
}

/** Kept under its old name for callers written against the provider-centric settings. */
export const AI_PRESETS = PROVIDERS

export const BYOK_PROVIDERS: ProviderId[] = ['openai', 'anthropic', 'google', 'openrouter', 'groq']
export const LOCAL_PROVIDERS: ProviderId[] = ['ollama', 'lmstudio', 'vllm', 'litellm', 'openai-compatible']

export const CONNECTION_TYPES: { type: ConnectionType; label: string; blurb: string; account: string }[] = [
  { type: 'managed', label: 'Managed AI', blurb: 'Claude, GPT, Gemini and more. No API keys.', account: 'Account required' },
  { type: 'byok', label: 'Bring your own key', blurb: 'OpenAI, Anthropic, Gemini, OpenRouter, Groq.', account: 'No account needed' },
  { type: 'local', label: 'Local or custom', blurb: 'Ollama, LM Studio, vLLM, LiteLLM, OpenAI-compatible.', account: 'No account needed' }
]

export const SCHEMA_BUDGETS = [4000, 8000, 16000, 32000] as const

// ---------------------------------------------------------------------------
// Models and what they can do
// ---------------------------------------------------------------------------

export interface ModelCapabilities {
  streaming: boolean
  tools: boolean
  structuredOutput: boolean
  reasoning: boolean
  vision: boolean
  contextWindow?: number
  promptCaching?: boolean
}

/** One model as offered by one connection; the same model through another connection is another AiModel. */
export interface AiModel {
  id: string
  displayName: string
  /** Who makes the model: anthropic, openai, google, meta, qwen, deepseek… */
  vendor: string
  connectionId: string
  capabilities: ModelCapabilities
  /** The model's own id when the connection uses a routed one such as "anthropic/claude-sonnet-5". */
  canonicalId?: string
}

/** The vendor a model id points at, from the id's own naming. */
export function vendorOf(modelId: string): string {
  const id = modelId.toLowerCase()
  const slash = id.indexOf('/')
  if (slash > 0) return id.slice(0, slash).replace(/^meta-llama$/, 'meta')
  if (/^claude/.test(id)) return 'anthropic'
  if (/^(gpt|o[1-9]|chatgpt|text-embedding)/.test(id)) return 'openai'
  if (/^gemini|^gemma/.test(id)) return 'google'
  if (/^llama/.test(id)) return 'meta'
  if (/^qwen|^qwq/.test(id)) return 'qwen'
  if (/^deepseek/.test(id)) return 'deepseek'
  if (/^mistral|^mixtral|^codestral|^devstral/.test(id)) return 'mistral'
  if (/^phi/.test(id)) return 'microsoft'
  if (/^grok/.test(id)) return 'xai'
  return 'other'
}

/**
 * Sane defaults for what a model can do, from its family. Connections and, later, provider catalogues
 * refine these; unknown models are assumed capable of tools because the agent has a fallback when they are not.
 */
export function capabilitiesFor(modelId: string, overrides?: Partial<ModelCapabilities>): ModelCapabilities {
  const id = (modelId.includes('/') ? modelId.slice(modelId.indexOf('/') + 1) : modelId).toLowerCase()
  let caps: ModelCapabilities = { streaming: true, tools: true, structuredOutput: false, reasoning: false, vision: false }
  if (/^claude/.test(id)) caps = { ...caps, structuredOutput: true, reasoning: /opus|sonnet-[4-9]|sonnet-5|haiku-[4-9]/.test(id), vision: true, contextWindow: 200_000, promptCaching: true }
  else if (/^o[1-9]/.test(id)) caps = { ...caps, structuredOutput: true, reasoning: true, vision: !/mini/.test(id), contextWindow: 200_000, promptCaching: true }
  else if (/^gpt/.test(id)) caps = { ...caps, structuredOutput: true, reasoning: /^gpt-5/.test(id), vision: !/oss|instruct/.test(id), contextWindow: /^gpt-5/.test(id) ? 400_000 : 128_000, promptCaching: true }
  else if (/^gemini/.test(id)) caps = { ...caps, structuredOutput: true, reasoning: /2\.5|3/.test(id), vision: true, contextWindow: 1_000_000, promptCaching: true }
  else if (/^deepseek-r1|^qwq|thinking|reason/.test(id)) caps = { ...caps, reasoning: true, contextWindow: 128_000 }
  else if (/^llama|^qwen|^deepseek|^mistral|^mixtral|^gemma|^phi/.test(id)) caps = { ...caps, vision: /vision|vl/.test(id), contextWindow: 128_000 }
  else if (/embed/.test(id)) caps = { streaming: false, tools: false, structuredOutput: false, reasoning: false, vision: false }
  return { ...caps, ...overrides }
}

// ---------------------------------------------------------------------------
// Connections and settings
// ---------------------------------------------------------------------------

/** How the app reaches models. Secrets live in the credential store; only their presence is exposed here. */
export interface AiConnection {
  id: string
  name: string
  type: ConnectionType
  provider: ProviderId
  protocol: AiProtocol
  baseUrl: string
  hasCredential: boolean
  /** Last four characters of the stored key, for the placeholder. */
  credentialHint: string | null
  defaultModel: string
  embeddingModel: string
  capabilityOverrides?: Partial<ModelCapabilities>
  createdAt: number
}

/** True when the connection can answer: local servers need no key, keyed providers need theirs, Managed AI is not here yet. */
export function connectionReady(c: AiConnection | null | undefined): boolean {
  if (!c) return false
  if (c.type === 'managed') return false
  return c.type === 'local' || c.hasCredential || !PROVIDERS[c.provider].needsKey
}

/** Settings of the database agent itself: the same whichever model answers. */
export interface AgentSettings {
  /** Token budget for the schema excerpt in each request. */
  schemaBudgetTokens: number
  /** Run generated queries automatically once they pass the read-only and EXPLAIN checks. */
  autoRun: boolean
  /** Send up to 20 distinct values of short text columns for the tables in context. */
  sendSampleValues: boolean
}

export interface ManagedAccount {
  email: string
  plan?: string
}

export interface AiSettings {
  activeConnectionId: string | null
  activeModel: string
  connections: AiConnection[]
  agent: AgentSettings
  encryptionAvailable: boolean
  /** Null until Managed AI exists and the user signs in; nothing else in the app depends on it. */
  managedAccount: ManagedAccount | null
}

export function activeConnection(s: AiSettings | null | undefined): AiConnection | null {
  if (!s) return null
  return s.connections.find((c) => c.id === s.activeConnectionId) ?? null
}

/** A connection as typed into Settings: saved or not yet, with a key to store or remove. */
export interface AiConnectionInput {
  id?: string
  type: ConnectionType
  provider: ProviderId
  name?: string
  baseUrl?: string
  defaultModel?: string
  embeddingModel?: string
  /** A key to store for this connection, or null to remove the stored one. */
  apiKey?: string | null
}

export interface AiSettingsUpdate {
  /** Creates or updates a connection and makes it the active one. */
  connection?: AiConnectionInput
  activeConnectionId?: string
  activeModel?: string
  agent?: Partial<AgentSettings>
}

export interface CatalogModel {
  /** The provider that offers it natively. */
  provider: ProviderId
  vendor: string
  id: string
  label: string
}

/** Well-known models offered in the model menu; the configured provider's live list is merged in. */
export const MODEL_CATALOG: CatalogModel[] = [
  { provider: 'anthropic', vendor: 'anthropic', id: 'claude-opus-5', label: 'Claude Opus 5' },
  { provider: 'anthropic', vendor: 'anthropic', id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { provider: 'anthropic', vendor: 'anthropic', id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  { provider: 'openai', vendor: 'openai', id: 'gpt-5.4', label: 'GPT-5.4' },
  { provider: 'openai', vendor: 'openai', id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
  { provider: 'google', vendor: 'google', id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { provider: 'google', vendor: 'google', id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { provider: 'groq', vendor: 'meta', id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
  { provider: 'groq', vendor: 'openai', id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' }
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
export function modelTitle(provider: ProviderId | string, id: string): string {
  const known = MODEL_CATALOG.find((m) => m.id === id && (m.provider === provider || m.vendor === provider))
  return known ? known.label : prettyModelName(id)
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
