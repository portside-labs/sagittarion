// The on-device model as a detector of the privacy engine: its labels become entity types, what it cannot mean is
// dropped, and results are kept by text, so the texts a conversation sends again and again are read once.
import type { SemanticSensitiveDataDetector, SensitiveDetection } from '../types'
import { modelDigest, type SemanticModelManifest } from './manifest'
import type { RawSpan } from './runtime'

/** Words that name a secret rather than being one: "the password field", "password is null". */
const NOT_A_SECRET = /^(?:pass(?:word|wd|code|phrase)?s?|pwd|pin|secret|token|null|none|nil|empty|blank|n\/?a|hidden|redacted|unknown|\*+)$/i
/** Words that name a person's field rather than a person: a CSV header "name", "the customer". */
const NOT_A_NAME = /^(?:(?:first|last|full|given|family|middle|user|customer|client|patient|contact|display)[ _-]?)?names?$|^(?:users?|customers?|clients?|patients?|person|people|contacts?|owners?|someone|somebody|anyone|nobody|null|none|unknown|n\/?a)$/i
/** Text with no letter or digit carries nothing the model could protect, and is not sent to it. */
const MEANINGFUL = /[\p{L}\p{N}]/u

export type Recognize = (texts: string[], signal?: AbortSignal) => Promise<RawSpan[][]>

export class GlinerDetector implements SemanticSensitiveDataDetector {
  readonly id = 'gliner'
  readonly model: { id: string; version: string; sha256: string }
  private readonly cache = new Map<string, SensitiveDetection[]>()

  constructor(
    private readonly recognize: Recognize,
    private readonly manifest: SemanticModelManifest,
    private readonly cacheSize = 2048
  ) {
    this.model = { id: manifest.id, version: manifest.version, sha256: modelDigest(manifest) }
  }

  async detect(texts: string[], signal?: AbortSignal): Promise<SensitiveDetection[][]> {
    const missing = [...new Set(texts.filter((t) => MEANINGFUL.test(t) && !this.cache.has(t)))]
    const fresh = new Map<string, SensitiveDetection[]>()
    if (missing.length) {
      const found = await this.recognize(missing, signal)
      if (found.length !== missing.length) throw new Error('The on-device model answered for a different number of texts.')
      missing.forEach((t, i) => fresh.set(t, this.toDetections(t, found[i])))
      for (const [t, d] of fresh) this.remember(t, d)
    }
    return texts.map((t) => (fresh.get(t) ?? this.cache.get(t) ?? []).map((d) => ({ ...d })))
  }

  /** Drops what the model found in earlier texts; they hold values, so they go when the model does. */
  forget(): void {
    this.cache.clear()
  }

  private toDetections(text: string, spans: RawSpan[]): SensitiveDetection[] {
    const out: SensitiveDetection[] = []
    for (const s of spans) {
      const spec = this.manifest.labels[s.label]
      if (!spec?.type) continue
      const value = text.slice(s.start, s.end)
      if (!MEANINGFUL.test(value)) continue
      if (spec.type === 'PASSWORD' && NOT_A_SECRET.test(value.trim())) continue
      if (spec.type === 'PERSON_NAME' && NOT_A_NAME.test(value.trim())) continue
      out.push({ start: s.start, end: s.end, value, type: spec.type, confidence: s.score, source: 'gliner', detector: `gliner.${spec.label.replaceAll(' ', '-')}` })
    }
    return out
  }

  private remember(text: string, detections: SensitiveDetection[]): void {
    this.cache.delete(text)
    while (this.cache.size >= this.cacheSize) this.cache.delete(this.cache.keys().next().value!)
    this.cache.set(text, detections)
  }
}
