// The last check before anything crosses to a provider: detect again on exactly what would be sent. Placeholders
// are intentional and masked out; what remains must hold nothing the policy protects, no value already protected in
// the conversation, and (in text the app wrote) no damaged placeholder. Anything else fails closed.
import type { PrivacyFinding } from './errors'
import { findDamaged } from './markers'
import type { PrivacyPolicy } from './policy'
import { resolve } from './resolver'
import type { DetectionContext, SensitiveDetection } from './types'
import type { PiiVault } from './vault'

export interface VerificationItem {
  text: string
  ctx: DetectionContext
  /** Where in the request, in words, for the report. */
  where: string
  /** Text the app assembled, or the model's own earlier words replayed. Damaged placeholders only count in the former. */
  origin: 'local' | 'model'
}

export interface VerificationResult {
  passed: boolean
  findings: PrivacyFinding[]
  checked: number
}

interface Detecting {
  detectAll(items: { text: string; ctx: DetectionContext }[], signal?: AbortSignal): Promise<SensitiveDetection[][]>
  knownValues(text: string, vault: PiiVault): SensitiveDetection[]
}

export class VerificationEngine {
  constructor(private readonly engine: Detecting) {}

  async verify(items: VerificationItem[], vault: PiiVault, policy: PrivacyPolicy, signal?: AbortSignal): Promise<VerificationResult> {
    const tally = new Map<string, PrivacyFinding>()
    const add = (f: Omit<PrivacyFinding, 'count'>) => {
      const key = `${f.where}\u0000${f.type ?? ''}\u0000${f.problem}`
      const existing = tally.get(key)
      if (existing) existing.count++
      else tally.set(key, { ...f, count: 1 })
    }
    const detected = await this.engine.detectAll(items, signal)
    for (const [k, item] of items.entries()) {
      const candidates = [...detected[k], ...this.engine.knownValues(item.text, vault)]
      for (const span of resolve(candidates, policy)) {
        if (span.decision.action === 'preserve') continue
        const known = span.members.some((m) => m.detector === 'known-values')
        add({ where: item.where, type: span.type, problem: known ? 'known-value' : 'unprotected-value' })
      }
      if (item.origin === 'local') for (let i = findDamaged(item.text).length; i > 0; i--) add({ where: item.where, problem: 'damaged-placeholder' })
    }
    const findings = [...tally.values()]
    return { passed: findings.length === 0, findings, checked: items.length }
  }
}
