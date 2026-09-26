// Versioned privacy policies: what happens to each kind of sensitive value. Detectors only propose; the policy
// decides, deterministically. A policy named after a standard is a set of technical rules, not a compliance claim.
import { PRIVACY_POLICIES, SENSITIVE_ENTITY_TYPES, type PrivacyAction, type PrivacyPolicyId, type SensitiveEntityType } from '@shared/privacy'
import type { SensitiveDetection } from './types'

export interface EntityPolicy {
  action: PrivacyAction
  /** Detections of the type below this confidence are ignored. Defaults to the policy's defaultMinConfidence. */
  minConfidence?: number
  /** Pseudonyms only: restore the value on this computer when the model's answer uses the placeholder. */
  rehydrate?: boolean
}

/** Classes of detection source, best first by default. */
export type SourceClass = 'validated' | 'schema' | 'deterministic' | 'custom' | 'semantic' | 'semantic-unknown'

export const DEFAULT_PRECEDENCE: readonly SourceClass[] = ['validated', 'schema', 'deterministic', 'custom', 'semantic', 'semantic-unknown']

export interface PrivacyPolicy {
  id: string
  version: number
  label: string
  description: string
  defaultMinConfidence: number
  entities: Record<SensitiveEntityType, EntityPolicy>
  /** Which source decides the type of overlapping detections. A policy may reorder these as an explicit exception. */
  precedence?: readonly SourceClass[]
}

export interface Decision {
  action: PrivacyAction
  rehydrate: boolean
}

export function sourceClass(d: SensitiveDetection): SourceClass {
  if (d.source === 'deterministic') return d.validated ? 'validated' : 'deterministic'
  if (d.source === 'schema') return 'schema'
  if (d.source === 'custom') return d.validated ? 'validated' : 'custom'
  return d.type === 'UNKNOWN_SENSITIVE' ? 'semantic-unknown' : 'semantic'
}

export function sourceRank(policy: PrivacyPolicy, d: SensitiveDetection): number {
  const order = policy.precedence ?? DEFAULT_PRECEDENCE
  const i = order.indexOf(sourceClass(d))
  return i < 0 ? order.length : i
}

export function decide(policy: PrivacyPolicy, type: SensitiveEntityType): Decision {
  const rule = policy.entities[type]
  return { action: rule.action, rehydrate: rule.action === 'pseudonymize' && rule.rehydrate === true }
}

export function threshold(policy: PrivacyPolicy, type: SensitiveEntityType): number {
  return policy.entities[type].minConfidence ?? policy.defaultMinConfidence
}

/** Actions that let the model see less than the value, or nothing, and are never restored. */
export function withholds(action: PrivacyAction): action is 'redact' | 'mask' | 'generalize' {
  return action === 'redact' || action === 'mask' || action === 'generalize'
}

/**
 * Two decisions over the same text, combined so neither protection is lost. Redaction wins outright. A pseudonym
 * wins over a mask or generalization (the model sees less) but stops being restorable, because the other rule says
 * the value must not come back. Two different partial reveals cannot both hold, so they become a redaction.
 */
export function combine(a: Decision, b: Decision): Decision {
  if (a.action === 'redact' || b.action === 'redact') return { action: 'redact', rehydrate: false }
  if (a.action === 'preserve') return b
  if (b.action === 'preserve') return a
  if (a.action === b.action) return { action: a.action, rehydrate: a.rehydrate && b.rehydrate }
  if (a.action === 'pseudonymize' || b.action === 'pseudonymize') return { action: 'pseudonymize', rehydrate: false }
  return { action: 'redact', rehydrate: false }
}

// ---------------------------------------------------------------------------
// Partial reveals
// ---------------------------------------------------------------------------

/** The visible part of a mask: the last four letters or digits of a long enough value, else nothing. */
export function maskShown(value: string): string | undefined {
  const alnum = value.replace(/[^A-Za-z0-9]/g, '')
  return alnum.length >= 8 ? alnum.slice(-4) : undefined
}

/** Types that can be generalized, and how. A generalizer returns null when the value has nothing safe to keep. */
export const GENERALIZERS: Partial<Record<SensitiveEntityType, (value: string) => string | null>> = {
  DATE_OF_BIRTH: (v) => /(?<!\d)(19\d{2}|20\d{2})(?!\d)/.exec(v)?.[1] ?? null,
  AGE: (v) => {
    const n = Number(/\d{1,3}/.exec(v)?.[0])
    if (!Number.isFinite(n)) return null
    if (n >= 90) return '90+'
    const lo = Math.floor(n / 10) * 10
    return `${lo}-${lo + 9}`
  },
  POSTAL_CODE: (v) => {
    const t = v.trim().toUpperCase()
    const zip = /^(\d{3})\d{2}(?:-\d{4})?$/.exec(t)
    if (zip) return `${zip[1]}XX`
    const uk = /^([A-Z]{1,2}\d[A-Z\d]?)\s*\d[A-Z]{2}$/.exec(t)
    return uk ? uk[1] : null
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ACTIONS: readonly PrivacyAction[] = ['preserve', 'pseudonymize', 'redact', 'mask', 'generalize']

/** Every problem that would make the policy unsafe to evaluate. Empty when it is usable. */
export function validatePolicy(p: PrivacyPolicy): string[] {
  const problems: string[] = []
  if (!p || typeof p !== 'object') return ['The policy is missing.']
  if (typeof p.id !== 'string' || !p.id) problems.push('The policy has no id.')
  if (!Number.isInteger(p.version) || p.version < 1) problems.push('The policy version must be a positive integer.')
  if (!(p.defaultMinConfidence >= 0 && p.defaultMinConfidence <= 1)) problems.push('The default confidence threshold must be between 0 and 1.')
  const entities = p.entities ?? ({} as PrivacyPolicy['entities'])
  for (const type of SENSITIVE_ENTITY_TYPES) {
    const rule = entities[type]
    if (!rule) {
      problems.push(`No rule for ${type}.`)
      continue
    }
    if (!ACTIONS.includes(rule.action)) problems.push(`Unknown action for ${type}.`)
    if (rule.rehydrate && rule.action !== 'pseudonymize') problems.push(`${type}: only pseudonyms can be restored.`)
    if (rule.minConfidence !== undefined && !(rule.minConfidence >= 0 && rule.minConfidence <= 1)) problems.push(`${type}: the confidence threshold must be between 0 and 1.`)
    if (rule.action === 'generalize' && !GENERALIZERS[type]) problems.push(`${type} cannot be generalized.`)
  }
  for (const key of Object.keys(entities)) if (!(SENSITIVE_ENTITY_TYPES as readonly string[]).includes(key)) problems.push(`Rule for an unknown type: ${key}.`)
  if (p.precedence) {
    const sorted = [...p.precedence].sort().join()
    if (sorted !== [...DEFAULT_PRECEDENCE].sort().join()) problems.push('The source precedence must list every source class once.')
  }
  return problems
}

// ---------------------------------------------------------------------------
// Built-in policies
// ---------------------------------------------------------------------------

const pseudonymize = (rehydrate = true): EntityPolicy => ({ action: 'pseudonymize', rehydrate })
const redact: EntityPolicy = { action: 'redact' }
const keep: EntityPolicy = { action: 'preserve' }

/** Starting defaults for general use. Not a HIPAA, PCI or GDPR rule set. */
export const GENERAL_PII: PrivacyPolicy = {
  ...PRIVACY_POLICIES['general-pii'],
  defaultMinConfidence: 0.5,
  entities: {
    PERSON_NAME: pseudonymize(),
    RELATIVE_NAME: pseudonymize(),
    EMAIL_ADDRESS: pseudonymize(),
    PHONE_NUMBER: pseudonymize(),
    STREET_ADDRESS: pseudonymize(),
    CITY: keep,
    STATE: keep,
    POSTAL_CODE: pseudonymize(),
    COUNTRY: keep,
    LOCATION: pseudonymize(),
    DATE_OF_BIRTH: pseudonymize(),
    AGE: keep,
    SSN: pseudonymize(),
    NATIONAL_ID: pseudonymize(),
    PASSPORT_NUMBER: pseudonymize(),
    DRIVER_LICENSE: pseudonymize(),
    TAX_ID: pseudonymize(),
    MEDICAL_RECORD_NUMBER: pseudonymize(),
    HEALTH_INSURANCE_ID: pseudonymize(),
    MEDICAL_LICENSE: pseudonymize(),
    CREDIT_CARD_NUMBER: { action: 'mask' },
    CVV: redact,
    CARD_EXPIRATION: redact,
    BANK_ACCOUNT_NUMBER: pseudonymize(),
    ROUTING_NUMBER: pseudonymize(),
    IBAN: pseudonymize(),
    IP_ADDRESS: pseudonymize(),
    MAC_ADDRESS: pseudonymize(),
    DEVICE_ID: pseudonymize(),
    LICENSE_PLATE: pseudonymize(),
    VEHICLE_IDENTIFIER: pseudonymize(),
    USERNAME: pseudonymize(),
    EMPLOYEE_ID: pseudonymize(),
    CUSTOMER_ID: pseudonymize(),
    ACCOUNT_ID: pseudonymize(),
    URL: pseudonymize(),
    BIOMETRIC_IDENTIFIER: redact,
    EMPLOYER: pseudonymize(),
    ORGANIZATION: pseudonymize(),
    OCCUPATION: keep,
    API_KEY: redact,
    ACCESS_TOKEN: redact,
    PASSWORD: redact,
    PRIVATE_KEY: redact,
    OTHER_UNIQUE_IDENTIFIER: pseudonymize(),
    UNKNOWN_SENSITIVE: pseudonymize()
  }
}

const POLICIES: Record<PrivacyPolicyId, PrivacyPolicy> = {
  'general-pii': GENERAL_PII
}

export class PolicyError extends Error {
  constructor(readonly problems: string[]) {
    super(`The privacy policy cannot be evaluated: ${problems.slice(0, 3).join(' ')}`)
    this.name = 'PolicyError'
  }
}

/** A built-in policy, validated. Throws rather than hand back something that cannot be evaluated. */
export function policyById(id: string): PrivacyPolicy {
  const policy = POLICIES[id as PrivacyPolicyId]
  if (!policy) throw new PolicyError([`Unknown policy "${id}".`])
  const problems = validatePolicy(policy)
  if (problems.length) throw new PolicyError(problems)
  return policy
}
