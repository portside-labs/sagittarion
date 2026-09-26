// Internal types of the privacy engine. Detections hold values and never leave the main process;
// what crosses IPC is in @shared/privacy.
import type { SensitiveEntityType } from '@shared/privacy'

export type DetectionSource = 'schema' | 'deterministic' | 'gliner' | 'custom'

export interface SensitiveDetection {
  /** Offsets into the text that was scanned. */
  start: number
  end: number
  value: string
  type: SensitiveEntityType
  /** 0..1, compared with the policy's threshold for the type. */
  confidence: number
  source: DetectionSource
  /** Which recognizer, e.g. "patterns.email". Never the value. */
  detector: string
  /** Confirmed by a checksum or parser (Luhn, mod 97, an IP parser…), or an exact match of a value already protected. */
  validated?: boolean
  metadata?: Record<string, unknown>
}

/**
 * How a text is scanned.
 * - prose: questions, chat, errors, comments, free-text values. Every detector runs.
 * - structured: schema lines and fixed instructions. Only detectors that cannot mistake an identifier for a name
 *   run, so a table called Jordan stays usable in SQL; the data inside (samples, comments) was protected before.
 * - value: one database value, with its column as context.
 */
export type TextRole = 'prose' | 'structured' | 'value'

export interface ColumnContext {
  table?: string
  column: string
  declaredType?: string
  comment?: string | null
}

/** What the schema detector concluded about a column, for one request only. */
export interface ColumnClassification {
  /** The entity the whole value is, when the column holds one (email, date_of_birth…). */
  type: SensitiveEntityType | null
  confidence: number
  /**
   * identifier: every value is one entity of `type`.
   * free-text: notes, descriptions, JSON; scanned as prose.
   * categorical: statuses, plans, codes; scanned with the identifier-safe detectors only.
   * unknown: scanned as prose.
   */
  content: 'identifier' | 'free-text' | 'categorical' | 'unknown'
  rule: string
}

export interface DetectionContext {
  role: TextRole
  column?: ColumnContext
  classification?: ColumnClassification
  /**
   * Who wrote the text: this app and its user (local, the default) or the model provider, whose replies and tool
   * calls are replayed as history. The on-device model reads only local text: the provider's words were written
   * from what was already sent, so they hold nothing new, and they are mostly SQL and table names.
   */
  origin?: 'local' | 'model'
}

export interface SensitiveDataDetector {
  readonly id: string
  readonly version: number
  readonly roles: readonly TextRole[]
  detect(text: string, ctx: DetectionContext): SensitiveDetection[]
}

/**
 * The semantic tier: a model on this computer (GLiNER, in its own process; see semantic/). The engine only depends on
 * this shape, so another model can be benchmarked or swapped in without touching the rest.
 */
export interface SemanticSensitiveDataDetector {
  readonly id: string
  readonly model: { id: string; version: string; sha256: string }
  /**
   * Candidates in each text, in order, with offsets into the texts as given. The engine passes every text of a pass
   * in one call, placeholders included, and drops whatever touches one.
   */
  detect(texts: string[], signal?: AbortSignal): Promise<SensitiveDetection[][]>
}
