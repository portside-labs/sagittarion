// The mapping from placeholders to the values they stand for. One per conversation, held in the main process
// only: never serialized, never logged, never part of anything that crosses IPC or reaches a provider.
// The maps are #private so structuredClone, spreading or Object.keys cannot copy them out either.
import { randomBytes, randomUUID } from 'node:crypto'
import { inspect } from 'node:util'
import { ENTITY_TYPES, type PrivacyAction, type SensitiveEntityType } from '@shared/privacy'
import { EXAMPLE_IDS, pseudonym } from './markers'

export interface VaultEntry {
  /** The placeholder for pseudonyms; null for values that are withheld (redacted, masked, generalized). */
  readonly token: string | null
  readonly value: string
  readonly type: SensitiveEntityType
  readonly action: PrivacyAction
  /** Pseudonyms only: whether the value may come back on this computer. Once refused, never restored. */
  readonly rehydrate: boolean
}

type MutableEntry = { -readonly [K in keyof VaultEntry]: VaultEntry[K] }

function identityKey(type: SensitiveEntityType, value: string): string {
  return `${ENTITY_TYPES[type].identity}\u0000${value}`
}

export class PiiVault {
  readonly id = randomUUID()
  #byToken = new Map<string, VaultEntry>()
  #byIdentity = new Map<string, VaultEntry>()
  #withheld = new Map<string, VaultEntry>()
  /** Ids seen in text that this vault did not issue (examples, a model's inventions): never handed out. */
  #reserved = new Set<string>(EXAMPLE_IDS)
  #randomId: () => string
  /** Grows whenever a value is added, so callers can tell a cached result is stale. */
  version = 0

  constructor(randomId: () => string = () => randomBytes(3).toString('hex').toUpperCase()) {
    this.#randomId = randomId
  }

  get size(): number {
    return this.#byIdentity.size + this.#withheld.size
  }

  /**
   * The placeholder for a value, issued the first time it is seen. Exact values: "Jack" and "JACK" are different
   * values, because the restored text must be exactly what was there. Names and relatives share an identity.
   */
  pseudonymFor(value: string, type: SensitiveEntityType, rehydrate = true): VaultEntry {
    const key = identityKey(type, value)
    const existing = this.#byIdentity.get(key) as MutableEntry | undefined
    if (existing) {
      if (!rehydrate) existing.rehydrate = false
      return existing
    }
    let id = this.#randomId()
    for (let i = 0; this.#byToken.has(pseudonym(type, id)) || this.#reserved.has(id); i++) {
      if (i > 1000) throw new Error('Could not issue a unique placeholder id.')
      id = this.#randomId()
    }
    const entry: VaultEntry = { token: pseudonym(type, id), value, type, action: 'pseudonymize', rehydrate }
    this.#byToken.set(entry.token!, entry)
    this.#byIdentity.set(key, entry)
    this.version++
    return entry
  }

  /** Remembers a value that was withheld, so it is caught wherever else it turns up in the conversation. */
  withhold(value: string, type: SensitiveEntityType, action: Exclude<PrivacyAction, 'preserve' | 'pseudonymize'>): VaultEntry {
    const existing = this.#withheld.get(value)
    if (existing) return existing
    const entry: VaultEntry = { token: null, value, type, action, rehydrate: false }
    this.#withheld.set(value, entry)
    this.version++
    return entry
  }

  resolve(token: string): VaultEntry | undefined {
    return this.#byToken.get(token)
  }

  /**
   * Takes a placeholder issued earlier in this conversation (by a vault since dropped) back in, from the chat's own
   * sealed history. Refuses when the placeholder already means something else.
   */
  adopt(token: string, value: string, type: SensitiveEntityType, rehydrate = true): 'added' | 'same' | 'conflict' {
    const current = this.#byToken.get(token)
    if (current) return current.value === value && ENTITY_TYPES[current.type].identity === ENTITY_TYPES[type].identity ? 'same' : 'conflict'
    const key = identityKey(type, value)
    const entry: VaultEntry = this.#byIdentity.get(key) ?? { token, value, type, action: 'pseudonymize', rehydrate }
    // A value that already has a placeholder keeps it; the adopted one becomes an alias, so both resolve.
    this.#byToken.set(token, entry)
    if (!this.#byIdentity.has(key)) this.#byIdentity.set(key, entry)
    this.version++
    return 'added'
  }

  /** Every protected value, for exact-match detection elsewhere in the conversation. */
  *entries(): IterableIterator<VaultEntry> {
    yield* this.#byIdentity.values()
    yield* this.#withheld.values()
  }

  reserve(id: string): void {
    this.#reserved.add(id)
  }

  /** Never serialize values, whatever tries: JSON, util.inspect, string coercion. */
  toJSON(): { id: string; size: number } {
    return { id: this.id, size: this.size }
  }

  toString(): string {
    return `PiiVault(${this.id}, ${this.size} entries)`
  }

  [inspect.custom](): string {
    return this.toString()
  }
}
