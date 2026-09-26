// Turns candidate detections into non-overlapping spans with one decision each.
//
// Conservative union: overlapping detections become one span covering all of them, so no detector can leave part of
// another's match exposed. The type comes from the best source (validated > schema > deterministic > custom >
// semantic > unknown semantic, then the longest span, then confidence). The action is that type's, combined with
// every same-rank member's and with any lower-rank member that withholds: a model can add protection to a
// deterministic match but never remove it. There is no voting.
import type { SensitiveEntityType } from '@shared/privacy'
import { combine, decide, sourceRank, threshold, withholds, type Decision, type PrivacyPolicy } from './policy'
import type { SensitiveDetection } from './types'

export interface ResolvedSpan {
  start: number
  end: number
  type: SensitiveEntityType
  decision: Decision
  primary: SensitiveDetection
  members: SensitiveDetection[]
}

const SEVERITY: Record<Decision['action'], number> = { preserve: 0, pseudonymize: 1, generalize: 2, mask: 3, redact: 4 }

function better(policy: PrivacyPolicy, a: SensitiveDetection, b: SensitiveDetection): number {
  return (
    sourceRank(policy, a) - sourceRank(policy, b) ||
    b.end - b.start - (a.end - a.start) ||
    b.confidence - a.confidence ||
    SEVERITY[decide(policy, b.type).action] - SEVERITY[decide(policy, a.type).action] ||
    a.start - b.start ||
    a.detector.localeCompare(b.detector) ||
    a.type.localeCompare(b.type)
  )
}

export function resolve(detections: SensitiveDetection[], policy: PrivacyPolicy): ResolvedSpan[] {
  const kept = detections
    .filter((d) => d.end > d.start && d.confidence >= threshold(policy, d.type))
    .sort((a, b) => a.start - b.start || b.end - a.end)
  const clusters: SensitiveDetection[][] = []
  let end = -1
  for (const d of kept) {
    if (clusters.length && d.start < end) {
      clusters[clusters.length - 1].push(d)
      end = Math.max(end, d.end)
    } else {
      clusters.push([d])
      end = d.end
    }
  }
  return clusters.map((members) => {
    const primary = [...members].sort((a, b) => better(policy, a, b))[0]
    const rank = sourceRank(policy, primary)
    let decision = decide(policy, primary.type)
    for (const m of members) {
      if (m === primary) continue
      const d = decide(policy, m.type)
      if (sourceRank(policy, m) === rank || withholds(d.action)) decision = combine(decision, d)
    }
    return {
      start: Math.min(...members.map((m) => m.start)),
      end: Math.max(...members.map((m) => m.end)),
      type: primary.type,
      decision,
      primary,
      members
    }
  })
}
