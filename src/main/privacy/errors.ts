// Failing closed. Messages say what kind of value and where, never the value: they reach the chat, and Electron
// prints errors thrown from IPC handlers to the console.
import { describeCounts, type SensitiveEntityType } from '@shared/privacy'

export type BlockReason = 'verification-failed' | 'policy-invalid' | 'detector-failed' | 'invalid-offsets' | 'semantic-unavailable'

export interface PrivacyFinding {
  /** Where in the request, in words: "the question", "a database error". Never the text itself. */
  where: string
  type?: SensitiveEntityType
  problem: 'unprotected-value' | 'known-value' | 'damaged-placeholder'
  count: number
}

function summarize(findings: PrivacyFinding[]): string {
  const byPlace = new Map<string, { counts: Partial<Record<SensitiveEntityType, number>>; damaged: number }>()
  for (const f of findings) {
    const place = byPlace.get(f.where) ?? { counts: {}, damaged: 0 }
    if (f.problem === 'damaged-placeholder') place.damaged += f.count
    else if (f.type) place.counts[f.type] = (place.counts[f.type] ?? 0) + f.count
    byPlace.set(f.where, place)
  }
  const parts: string[] = []
  for (const [where, p] of byPlace) {
    const values = describeCounts(p.counts)
    if (values) parts.push(`${values} in ${where}`)
    if (p.damaged) parts.push(`${p.damaged === 1 ? 'a damaged placeholder' : `${p.damaged} damaged placeholders`} in ${where}`)
  }
  return parts.slice(0, 4).join('; ') || 'a sensitive value'
}

export class PrivacyBlockedError extends Error {
  readonly reason: BlockReason
  readonly findings: PrivacyFinding[]

  /** `detail` must not contain data: a detector id, a policy problem, a count. */
  constructor(reason: BlockReason, findings: PrivacyFinding[], detail?: string) {
    const lead = 'Local AI Privacy stopped this request before anything was sent'
    const text: Record<BlockReason, string> = {
      'verification-failed': `${lead}: ${summarize(findings)} could not be protected.`,
      'policy-invalid': `${lead}: the privacy policy cannot be evaluated${detail ? ` (${detail})` : ''}.`,
      'detector-failed': `${lead}: a sensitive-data detector failed${detail ? ` (${detail})` : ''}.`,
      'invalid-offsets': `${lead}: protecting the text produced inconsistent offsets.`,
      'semantic-unavailable': `${lead}: the on-device privacy model is switched on but could not run${detail ? ` (${detail.replace(/\.$/, '')})` : ''}. Download it again or switch it off in Settings.`
    }
    super(text[reason])
    this.name = 'PrivacyBlockedError'
    this.reason = reason
    this.findings = findings
  }
}
