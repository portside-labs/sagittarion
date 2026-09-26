// Local AI Privacy: the sensitive-data taxonomy, its settings, and the report that crosses IPC.
// Nothing in this module ever holds a sensitive value: only types, counts, placeholders and offsets.

/**
 * Every kind of sensitive value the app knows. Detectors map their own labels onto these; policies decide what
 * happens to each. To add a type, add it here and to ENTITY_TYPES; policy validation then insists every policy
 * says what to do with it.
 */
export const SENSITIVE_ENTITY_TYPES = [
  'PERSON_NAME',
  'RELATIVE_NAME',
  'EMAIL_ADDRESS',
  'PHONE_NUMBER',
  'STREET_ADDRESS',
  'CITY',
  'STATE',
  'POSTAL_CODE',
  'COUNTRY',
  'LOCATION',
  'DATE_OF_BIRTH',
  'AGE',
  'SSN',
  'NATIONAL_ID',
  'PASSPORT_NUMBER',
  'DRIVER_LICENSE',
  'TAX_ID',
  'MEDICAL_RECORD_NUMBER',
  'HEALTH_INSURANCE_ID',
  'MEDICAL_LICENSE',
  'CREDIT_CARD_NUMBER',
  'CVV',
  'CARD_EXPIRATION',
  'BANK_ACCOUNT_NUMBER',
  'ROUTING_NUMBER',
  'IBAN',
  'IP_ADDRESS',
  'MAC_ADDRESS',
  'DEVICE_ID',
  'LICENSE_PLATE',
  'VEHICLE_IDENTIFIER',
  'USERNAME',
  'EMPLOYEE_ID',
  'CUSTOMER_ID',
  'ACCOUNT_ID',
  'URL',
  'BIOMETRIC_IDENTIFIER',
  'EMPLOYER',
  'ORGANIZATION',
  'OCCUPATION',
  'API_KEY',
  'ACCESS_TOKEN',
  'PASSWORD',
  'PRIVATE_KEY',
  'OTHER_UNIQUE_IDENTIFIER',
  'UNKNOWN_SENSITIVE'
] as const

export type SensitiveEntityType = (typeof SENSITIVE_ENTITY_TYPES)[number]

export interface EntityTypeInfo {
  /** The short tag inside placeholders: PERSON in <|PII:PERSON:A81F32|>. Unique per type. */
  tag: string
  label: string
  plural: string
  /** Types sharing an identity are one entity: "wife Susan" and "Susan called" get the same placeholder. */
  identity: string
}

function info(tag: string, label: string, plural?: string, identity?: string): EntityTypeInfo {
  return { tag, label, plural: plural ?? `${label}s`, identity: identity ?? tag }
}

export const ENTITY_TYPES: Record<SensitiveEntityType, EntityTypeInfo> = {
  PERSON_NAME: info('PERSON', 'person name', undefined, 'PERSON'),
  RELATIVE_NAME: info('RELATIVE', "relative's name", "relatives' names", 'PERSON'),
  EMAIL_ADDRESS: info('EMAIL', 'email address', 'email addresses'),
  PHONE_NUMBER: info('PHONE', 'phone number'),
  STREET_ADDRESS: info('ADDRESS', 'street address', 'street addresses'),
  CITY: info('CITY', 'city', 'cities'),
  STATE: info('STATE', 'state or region', 'states or regions'),
  POSTAL_CODE: info('POSTCODE', 'postal code'),
  COUNTRY: info('COUNTRY', 'country', 'countries'),
  LOCATION: info('LOCATION', 'location'),
  DATE_OF_BIRTH: info('DOB', 'date of birth', 'dates of birth'),
  AGE: info('AGE', 'age'),
  SSN: info('SSN', 'social security number'),
  NATIONAL_ID: info('NATIONAL_ID', 'national id number'),
  PASSPORT_NUMBER: info('PASSPORT', 'passport number'),
  DRIVER_LICENSE: info('DRIVER_LICENSE', "driver's license number"),
  TAX_ID: info('TAX_ID', 'tax id'),
  MEDICAL_RECORD_NUMBER: info('MRN', 'medical record number'),
  HEALTH_INSURANCE_ID: info('INSURANCE_ID', 'health insurance id'),
  MEDICAL_LICENSE: info('MEDICAL_LICENSE', 'medical license number'),
  CREDIT_CARD_NUMBER: info('CARD', 'card number'),
  CVV: info('CVV', 'card security code'),
  CARD_EXPIRATION: info('CARD_EXPIRY', 'card expiry date'),
  BANK_ACCOUNT_NUMBER: info('BANK_ACCOUNT', 'bank account number'),
  ROUTING_NUMBER: info('ROUTING', 'routing number'),
  IBAN: info('IBAN', 'IBAN'),
  IP_ADDRESS: info('IP', 'IP address', 'IP addresses'),
  MAC_ADDRESS: info('MAC', 'MAC address', 'MAC addresses'),
  DEVICE_ID: info('DEVICE_ID', 'device id'),
  LICENSE_PLATE: info('PLATE', 'license plate'),
  VEHICLE_IDENTIFIER: info('VIN', 'vehicle identification number'),
  USERNAME: info('USERNAME', 'username'),
  EMPLOYEE_ID: info('EMPLOYEE_ID', 'employee id'),
  CUSTOMER_ID: info('CUSTOMER_ID', 'customer id'),
  ACCOUNT_ID: info('ACCOUNT_ID', 'account id'),
  URL: info('URL', 'URL'),
  BIOMETRIC_IDENTIFIER: info('BIOMETRIC', 'biometric identifier'),
  EMPLOYER: info('EMPLOYER', 'employer'),
  ORGANIZATION: info('ORG', 'organization'),
  OCCUPATION: info('OCCUPATION', 'occupation'),
  API_KEY: info('API_KEY', 'API key'),
  ACCESS_TOKEN: info('TOKEN', 'access token'),
  PASSWORD: info('PASSWORD', 'password'),
  PRIVATE_KEY: info('PRIVATE_KEY', 'private key'),
  OTHER_UNIQUE_IDENTIFIER: info('ID', 'unique identifier'),
  UNKNOWN_SENSITIVE: info('SENSITIVE', 'sensitive value')
}

const BY_TAG = new Map<string, SensitiveEntityType>(SENSITIVE_ENTITY_TYPES.map((t) => [ENTITY_TYPES[t].tag, t]))

/** The type a placeholder tag stands for, e.g. PERSON -> PERSON_NAME. */
export function typeForTag(tag: string): SensitiveEntityType | undefined {
  return BY_TAG.get(tag)
}

export function isSensitiveEntityType(v: unknown): v is SensitiveEntityType {
  return typeof v === 'string' && v in ENTITY_TYPES
}

export type PrivacyAction = 'preserve' | 'pseudonymize' | 'redact' | 'mask' | 'generalize'

/**
 * Every well-formed placeholder, as the main process issues them and the transcript view highlights them:
 * <|PII:PERSON:A81F32|>, <|REDACTED:PASSWORD|>, <|MASKED:CARD:1111|>, <|GENERALIZED:DOB:1984|>.
 */
export const PLACEHOLDER_SOURCE =
  '<\\|(?:PII:([A-Z][A-Z0-9_]{0,31}):([0-9A-F]{6})|REDACTED:([A-Z][A-Z0-9_]{0,31})|MASKED:([A-Z][A-Z0-9_]{0,31})(?::([A-Za-z0-9+.\\-]{1,24}))?|GENERALIZED:([A-Z][A-Z0-9_]{0,31})(?::([A-Za-z0-9+.\\-]{1,24}))?)\\|>'

/** "2 person names, 1 phone number": counts by type, largest first, for the chat and error messages. */
export function describeCounts(counts: Partial<Record<SensitiveEntityType, number>>, limit = 4): string {
  const entries = Object.entries(counts)
    .filter((e): e is [SensitiveEntityType, number] => isSensitiveEntityType(e[0]) && typeof e[1] === 'number' && e[1] > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const parts = entries.slice(0, limit).map(([t, n]) => `${n} ${n === 1 ? ENTITY_TYPES[t].label : ENTITY_TYPES[t].plural}`)
  const rest = entries.slice(limit).reduce((sum, [, n]) => sum + n, 0)
  if (rest > 0) parts.push(`${rest} other${rest === 1 ? '' : 's'}`)
  return parts.join(', ')
}

// ---------------------------------------------------------------------------
// Policies and settings
// ---------------------------------------------------------------------------

export type PrivacyPolicyId = 'general-pii'

export interface PrivacyPolicyInfo {
  id: PrivacyPolicyId
  version: number
  label: string
  description: string
}

/** What the settings screen lists. The rules themselves live in the main process (privacy/policy.ts). */
export const PRIVACY_POLICIES: Record<PrivacyPolicyId, PrivacyPolicyInfo> = {
  'general-pii': {
    id: 'general-pii',
    version: 2,
    label: 'General PII',
    description:
      'Names, contact details, addresses, employers and other organizations, government and account ids become placeholders that are restored on this computer. Card numbers are masked to the last four digits. Passwords, keys, tokens and card security codes are removed. Cities, states, countries, ages and occupations are sent as they are.'
  }
}

export interface PrivacySettings {
  /** Protect sensitive values before a request leaves this device. */
  enabled: boolean
  policyId: PrivacyPolicyId
  /** Classify columns such as email or date_of_birth by name, and key/value pairs in JSON, logs and SQL. */
  schemaDetection: boolean
  /**
   * The on-device model for names, places and organizations that patterns cannot find. On without the model to run
   * it, asks stop rather than go out with less protection than chosen.
   */
  semanticDetection: boolean
  /** Also protect requests to models on this computer, which otherwise see the data as it is. */
  protectLocalModels: boolean
}

export const DEFAULT_PRIVACY: PrivacySettings = {
  enabled: true,
  policyId: 'general-pii',
  schemaDetection: true,
  semanticDetection: false,
  protectLocalModels: false
}

/** Stored settings, whatever their age, as a complete and valid PrivacySettings. */
export function normalizePrivacy(raw: unknown): PrivacySettings {
  const r = raw && typeof raw === 'object' ? (raw as Partial<PrivacySettings>) : {}
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
  return {
    enabled: bool(r.enabled, DEFAULT_PRIVACY.enabled),
    policyId: typeof r.policyId === 'string' && r.policyId in PRIVACY_POLICIES ? r.policyId : DEFAULT_PRIVACY.policyId,
    schemaDetection: bool(r.schemaDetection, DEFAULT_PRIVACY.schemaDetection),
    semanticDetection: bool(r.semanticDetection, DEFAULT_PRIVACY.semanticDetection),
    protectLocalModels: bool(r.protectLocalModels, DEFAULT_PRIVACY.protectLocalModels)
  }
}

// ---------------------------------------------------------------------------
// Where a connection sends data
// ---------------------------------------------------------------------------

/** "this-device" only for loopback addresses; a LAN box or a company gateway is external. */
export type EndpointTrust = 'this-device' | 'external'

export function classifyEndpoint(baseUrl: string): { trust: EndpointTrust; host: string } {
  let host = ''
  try {
    host = new URL(baseUrl.trim()).hostname.toLowerCase()
  } catch {
    return { trust: 'external', host: baseUrl.trim() || 'an unknown address' }
  }
  const bare = host.replace(/^\[|\]$/g, '')
  const loopback =
    bare === 'localhost' ||
    bare.endsWith('.localhost') ||
    /^127(?:\.\d{1,3}){3}$/.test(bare) ||
    bare === '0.0.0.0' ||
    bare === '::1' ||
    /^(?:0{1,4}:){7}0{0,3}1$/.test(bare) ||
    /^::ffff:127(?:\.\d{1,3}){3}$/.test(bare) ||
    /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(bare)
  return { trust: loopback ? 'this-device' : 'external', host }
}

/** Why a request went out unprotected. Every such request names one of these; there is no silent fallback. */
export type PrivacyExemption = 'privacy-off' | 'this-device'

export function privacyApplies(s: PrivacySettings, trust: EndpointTrust): { protect: true } | { protect: false; exemption: PrivacyExemption } {
  if (!s.enabled) return { protect: false, exemption: 'privacy-off' }
  if (trust === 'this-device' && !s.protectLocalModels) return { protect: false, exemption: 'this-device' }
  return { protect: true }
}

// ---------------------------------------------------------------------------
// What an answer carries back: counts, versions and sealed history, never values
// ---------------------------------------------------------------------------

/** How a restored value was written into the text, so it can be read back exactly. */
export type RestoreEscape =
  | 'plain'
  /** Display text for a value that is not restored, e.g. "[redacted password]"; never adopted. */
  | 'display'
  | 'sql-string'
  | 'sql-estring'
  | 'sql-quoted'
  | 'sql-ident'
  | 'sql-bracket'
  | 'sql-backtick'
  | 'sql-dollar'
  | 'sql-number'
  | 'sql-comment'

/** One placeholder of a sealed text and where its value sits in the restored text. */
export interface SealedSpan {
  marker: string
  start: number
  end: number
  escape: RestoreEscape
}

/** Text exactly as the model saw or wrote it, with the offsets that line it up with the restored text. */
export interface SealedText {
  text: string
  spans: SealedSpan[]
}

/** One exchange as the model saw it, kept by the renderer so follow-ups never re-send raw values. */
export interface SealedTurn {
  question: SealedText
  sql?: SealedText
  answer?: SealedText
}

export interface PrivacyAuditEngine {
  version: string
  /** Detector ids with versions, e.g. "patterns@1". */
  detectors: string[]
  /** The on-device model when semantic detection ran, with the digest of the graph that was loaded. */
  semanticModel: { id: string; version: string; sha256: string } | null
}

/** Non-sensitive record of what the privacy layer did during one ask. */
export interface AiPrivacyReport {
  protected: boolean
  exemption?: PrivacyExemption
  /** The host requests went to. */
  host: string
  policy?: { id: string; version: number }
  /** Distinct values withheld from the model, by type. */
  counts: Partial<Record<SensitiveEntityType, number>>
  actions: Partial<Record<PrivacyAction, number>>
  /** Requests that passed verification and were sent. */
  requests: number
  restoration: { restored: number; withheld: number; unknown: number; damaged: number }
  engine?: PrivacyAuditEngine
  at: number
  sealed?: SealedTurn
}

// ---------------------------------------------------------------------------
// What was actually sent: the exchange inspector
// ---------------------------------------------------------------------------

/** One HTTP request to the model provider during an ask, as it went over the network. */
export interface AiWireExchange {
  /** 1-based, in the order sent. */
  n: number
  kind: 'chat' | 'embeddings' | 'other'
  method: string
  /** The endpoint, with any query-string values blanked. Headers are never recorded: they carry the API key. */
  url: string
  at: number
  durationMs: number
  /** The request body exactly as sent. */
  request: string
  status: number | null
  /** The response body exactly as received; null when none arrived. */
  response: string | null
  error?: string
  /** Original sizes of bodies too large to keep whole; what is kept is their beginning. */
  truncated?: { request?: number; response?: number }
}

/** One protected value of an ask, described without the value itself. */
export interface AiTranscriptEntry {
  /** The placeholder the provider saw instead. */
  marker: string
  type: SensitiveEntityType
  action: PrivacyAction
  /** Put back on this computer when the model used it. */
  restorable: boolean
  /** How often the value itself occurs in everything that was sent, counted on the exact bytes. The point is 0. */
  occurrences: number
  /** Where it was first found: "the question", "sample values", "a table comment", "database feedback"… */
  where: string
  /**
   * The value, only when the viewer explicitly asks for it, only for placeholders the policy restores anyway, and
   * only while the conversation still holds it in memory. Never for secrets, masks or generalizations.
   */
  value?: string
}

/** Everything that crossed to the provider during one ask, for the user to inspect. Kept in memory only. */
export interface AiTranscript {
  requestId: string
  host: string
  at: number
  protected: boolean
  exemption?: PrivacyExemption
  exchanges: AiWireExchange[]
  legend: AiTranscriptEntry[]
  report?: AiPrivacyReport
  /** Set when Local AI Privacy stopped the ask: why nothing (more) was sent. */
  blocked?: string
  /** False once the conversation's placeholders were dropped from memory, so values can no longer be shown. */
  valuesAvailable: boolean
}

// ---------------------------------------------------------------------------
// The on-device semantic model
// ---------------------------------------------------------------------------

export interface SemanticModelInfo {
  id: string
  version: string
  name: string
  publisher: string
  license: string
  /** Where it is downloaded from, e.g. "huggingface.co/knowledgator/gliner-pii-base-v1.0". */
  source: string
  /** The whole download, in bytes. */
  size: number
}

/**
 * unsupported: this computer cannot run it (the reason is in `message`). failed: the last download or check did not
 * complete; nothing partial is kept.
 */
export type SemanticModelState = 'unsupported' | 'not-installed' | 'downloading' | 'installed' | 'failed'

export interface SemanticModelStatus {
  model: SemanticModelInfo
  state: SemanticModelState
  /** Bytes received so far, while downloading. */
  received?: number
  message?: string
}
