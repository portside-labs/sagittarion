// The privacy engine: detect -> resolve -> decide -> transform, repeated until a pass finds nothing new, then
// verified independently. Detectors propose; the versioned policy decides. The engine is stateless: the vault it
// is given holds everything about a conversation.
import type { PrivacyAuditEngine, SensitiveEntityType } from '@shared/privacy'
import { KnownValueDetector } from './detectors/known-values'
import { NameDetector } from './detectors/names'
import { PatternDetector } from './detectors/patterns'
import { classifyColumn, LabeledValueDetector } from './detectors/schema'
import { PrivacyBlockedError } from './errors'
import { FILLER, findMarkers, maskMarkers, type Marker } from './markers'
import type { PrivacyPolicy } from './policy'
import { resolve, type ResolvedSpan } from './resolver'
import { restoreSql, restoreText, type Restored } from './restore'
import type { SqlDialect } from './sql-regions'
import { markerFor, valueOf, type Replacement } from './transformer'
import type { ColumnClassification, ColumnContext, DetectionContext, SemanticSensitiveDataDetector, SensitiveDataDetector, SensitiveDetection, TextRole } from './types'
import type { PiiVault } from './vault'
import { VerificationEngine, type VerificationItem, type VerificationResult } from './verify'

export const PRIVACY_ENGINE_VERSION = '1.0.0'

/** Passes over a set of texts before giving up; each pass only adds placeholders, so this converges fast. */
const MAX_ROUNDS = 4

export interface EngineOptions {
  /** Column classification and labelled values in JSON, logs, SQL and CSV. */
  schemaDetection: boolean
  /** The semantic tier: the on-device model, when it is switched on. */
  semantic?: SemanticSensitiveDataDetector | null
  /** Further detectors; each runs on the roles it declares. */
  extra?: SensitiveDataDetector[]
}

export interface ProtectInput {
  text: string
  ctx: DetectionContext
}

export interface Protected {
  text: string
  /** Offsets in the input text of every value replaced, with its placeholder. */
  replacements: Replacement[]
}

/** A piece of the text being protected: input as it was, or a placeholder standing for input[start, end). */
interface Segment {
  start: number
  end: number
  replacement?: Replacement
}

function render(input: string, segments: Segment[]): { text: string; at: number[] } {
  let text = ''
  const at: number[] = []
  for (const s of segments) {
    at.push(text.length)
    text += s.replacement ? s.replacement.marker : input.slice(s.start, s.end)
  }
  return { text, at }
}

/** Detections that reach into a placeholder are cut back to the part before it, or dropped. */
function clip(detections: SensitiveDetection[], markers: Marker[]): SensitiveDetection[] {
  if (!markers.length) return detections
  const out: SensitiveDetection[] = []
  for (const d of detections) {
    const hit = markers.find((m) => d.start < m.end && m.start < d.end)
    if (!hit) out.push(d)
    else if (hit.start > d.start && !d.value.slice(0, hit.start - d.start).includes(FILLER)) {
      const value = d.value.slice(0, hit.start - d.start).trimEnd()
      if (value) out.push({ ...d, end: d.start + value.length, value })
    }
  }
  return out
}

/**
 * The engine for the user's settings. Semantic detection that is switched on but has no model to run fails closed
 * here: asks stop with a message instead of going out with less protection than the user chose.
 */
export function engineForSettings(s: { schemaDetection: boolean; semanticDetection: boolean }, semantic: SemanticSensitiveDataDetector | null = null, why?: string): PrivacyEngine {
  if (s.semanticDetection && !semantic) throw new PrivacyBlockedError('semantic-unavailable', [], why ?? 'it is not installed')
  return new PrivacyEngine({ schemaDetection: s.schemaDetection, semantic: s.semanticDetection ? semantic : null })
}

export class PrivacyEngine {
  private readonly detectors: SensitiveDataDetector[]
  private readonly known = new KnownValueDetector()
  private identifiers: ReadonlySet<string> = new Set()
  readonly verifier: VerificationEngine

  constructor(private readonly opts: EngineOptions) {
    this.detectors = [new PatternDetector(), new NameDetector(), ...(opts.schemaDetection ? [new LabeledValueDetector()] : []), ...(opts.extra ?? [])]
    this.verifier = new VerificationEngine(this)
  }

  describe(): PrivacyAuditEngine {
    const detectors = [...this.detectors.map((d) => `${d.id}@${d.version}`), `${this.known.id}@${this.known.version}`]
    if (this.opts.schemaDetection) detectors.push('schema.columns@1')
    if (this.opts.semantic) detectors.push(`${this.opts.semantic.id}@${this.opts.semantic.model.version}`)
    return { version: PRIVACY_ENGINE_VERSION, detectors, semanticModel: this.opts.semantic ? { ...this.opts.semantic.model } : null }
  }

  /**
   * The database's table and column names, for the ask at hand. They are never values: a detection that is exactly
   * one of them is dropped, whichever detector made it. Made into a placeholder, a name would vanish from the schema
   * the model reads (a protected value is protected everywhere) and come back as a string where SQL needs a name.
   */
  useIdentifiers(names: Iterable<string>): void {
    this.identifiers = new Set(names)
  }

  private isIdentifier(d: SensitiveDetection): boolean {
    if (!this.identifiers.size) return false
    const v = d.value.trim()
    return this.identifiers.has(v) || this.identifiers.has(v.replace(/^["`[](.*)["`\]]$/, '$1'))
  }

  /** Column classification when schema detection is on; undefined otherwise. */
  classify(column: ColumnContext): ColumnClassification | undefined {
    return this.opts.schemaDetection ? classifyColumn(column) : undefined
  }

  /**
   * A column the schema cannot place, judged from its sampled values: when most of them are mostly one kind of
   * entity (a view's `name` column full of people), every value is treated as that kind for this request. Nothing
   * is remembered; weak evidence never outlives the request that saw it.
   */
  async inferColumn(cls: ColumnClassification | undefined, values: string[], signal?: AbortSignal): Promise<ColumnClassification | undefined> {
    if (!cls || cls.content !== 'unknown') return cls
    const sample = [...new Set(values.map((v) => v.trim()).filter(Boolean))].slice(0, 20)
    if (sample.length < 3) return cls
    const votes = new Map<SensitiveEntityType, number>()
    const found = await this.detectAll(
      sample.map((text) => ({ text, ctx: { role: 'prose' as const } })),
      signal
    )
    for (const [i, value] of sample.entries()) {
      const detections = found[i]
      const chars = value.replace(/\s/g, '').length
      const covered = new Map<SensitiveEntityType, Set<number>>()
      for (const d of detections) {
        const type = d.type === 'RELATIVE_NAME' ? 'PERSON_NAME' : d.type
        const set = covered.get(type) ?? new Set<number>()
        for (let i = d.start; i < d.end; i++) if (!/\s/.test(value[i])) set.add(i)
        covered.set(type, set)
      }
      for (const [type, set] of covered) if (set.size * 2 >= chars) votes.set(type, (votes.get(type) ?? 0) + 1)
    }
    const [best] = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    if (!best || best[1] * 2 < sample.length) return cls
    return { type: best[0], confidence: 0.75, content: 'identifier', rule: `sampled ${best[1]}/${sample.length}` }
  }

  /** A value in a column of statuses and codes is scanned like schema text; any other value like prose. */
  private roleFor(ctx: DetectionContext): TextRole {
    if (ctx.role !== 'value') return ctx.role
    return ctx.classification?.content === 'categorical' ? 'structured' : 'prose'
  }

  /** The semantic model reads prose this app wrote, except a value its column already makes one entity of. */
  private semanticReads(ctx: DetectionContext, role: TextRole): boolean {
    if (!this.opts.semantic || role !== 'prose' || ctx.origin === 'model') return false
    const cls = ctx.role === 'value' ? ctx.classification : undefined
    return !(cls?.type && cls.content === 'identifier')
  }

  /** The model's candidates for every text that it reads, asked for in one call. */
  private async semanticPass(texts: string[], signal?: AbortSignal): Promise<Map<string, SensitiveDetection[]>> {
    const found = new Map<string, SensitiveDetection[]>()
    const semantic = this.opts.semantic
    if (!semantic || !texts.length) return found
    const wanted = [...new Set(texts)]
    let result: SensitiveDetection[][]
    try {
      result = await semantic.detect(wanted, signal)
    } catch (err) {
      if (signal?.aborted) throw err
      // The model's own errors describe the failure (it stopped, a file changed), never the text it was reading.
      throw new PrivacyBlockedError('semantic-unavailable', [], err instanceof Error ? err.message : undefined)
    }
    if (result.length !== wanted.length) throw new PrivacyBlockedError('detector-failed', [], semantic.id)
    wanted.forEach((text, i) => {
      for (const d of result[i]) {
        if (!(Number.isInteger(d.start) && Number.isInteger(d.end) && d.start >= 0 && d.start < d.end && d.end <= text.length)) throw new PrivacyBlockedError('invalid-offsets', [])
      }
      found.set(text, result[i])
    })
    return found
  }

  /** Candidates from every detector that applies, with placeholders already in the text masked out. */
  async detect(text: string, ctx: DetectionContext, signal?: AbortSignal): Promise<SensitiveDetection[]> {
    return (await this.detectAll([{ text, ctx }], signal))[0]
  }

  /** detect for several texts; the semantic model sees all of them at once. */
  async detectAll(items: ProtectInput[], signal?: AbortSignal): Promise<SensitiveDetection[][]> {
    const prepared = items.map(({ text, ctx }) => {
      const markers = findMarkers(text)
      const masked = maskMarkers(text, markers)
      const role = this.roleFor(ctx)
      return { text, ctx, markers, masked, role, semantic: text.trim() !== '' && this.semanticReads(ctx, role) }
    })
    // The model reads each text as it is, placeholders included: with a value's slot still filled, it has no reason
    // to take the words around it ("card_number", a CSV header) for the missing value.
    const semantic = await this.semanticPass(
      prepared.filter((p) => p.semantic).map((p) => p.text),
      signal
    )
    return prepared.map(({ text, ctx, markers, masked, role, semantic: reads }) => {
      if (!text.trim()) return []
      const out: SensitiveDetection[] = []
      for (const d of this.detectors) {
        if (!d.roles.includes(role)) continue
        try {
          out.push(...d.detect(masked, { ...ctx, role }))
        } catch {
          throw new PrivacyBlockedError('detector-failed', [], d.id)
        }
      }
      if (reads) {
        for (const d of semantic.get(text) ?? []) {
          // What the model finds in or against a placeholder is about the value already protected there.
          if (markers.some((m) => d.start < m.end && m.start < d.end)) continue
          // A lone database value that looks random is a code or an id as often as a secret; columns of secrets are
          // recognised by name. The model's password label means something only in a sentence ("my pasword: …").
          if (ctx.role === 'value' && d.type === 'PASSWORD') continue
          out.push({ ...d, value: masked.slice(d.start, d.end) })
        }
      }
      // A column that holds one entity per value: the whole value is that entity.
      const cls = ctx.role === 'value' ? ctx.classification : undefined
      if (cls?.type && cls.content === 'identifier' && !markers.length) {
        const lead = masked.length - masked.trimStart().length
        const value = masked.trim()
        out.push({ start: lead, end: lead + value.length, value, type: cls.type, confidence: cls.confidence, source: 'schema', detector: 'schema.columns', metadata: { rule: cls.rule } })
      }
      return clip(out, markers).filter((d) => !this.isIdentifier(d))
    })
  }

  /** Values already protected in this conversation, wherever they appear. */
  knownValues(text: string, vault: PiiVault): SensitiveDetection[] {
    const markers = findMarkers(text)
    return clip(this.known.detect(maskMarkers(text, markers), vault), markers).filter((d) => !this.isIdentifier(d))
  }

  /**
   * Protects texts that travel together. Each pass detects in every text, including values already protected
   * anywhere in the conversation, and replaces what it finds; the next pass sees those values as known, so a value
   * found in one text is protected in all of them, whatever order they come in.
   */
  async protectAll(inputs: ProtectInput[], vault: PiiVault, policy: PrivacyPolicy, signal?: AbortSignal): Promise<Protected[]> {
    const segments: Segment[][] = inputs.map((i) => [{ start: 0, end: i.text.length }])
    for (let round = 0; ; round++) {
      let changed = false
      const rendered = inputs.map((input, k) => render(input.text, segments[k]))
      // Detection does not depend on the vault, so one call covers the pass; known values are looked up per text, so
      // a value protected in one text this pass is already known in the next.
      const detected = await this.detectAll(
        inputs.map((input, k) => ({ text: rendered[k].text, ctx: input.ctx })),
        signal
      )
      for (let k = 0; k < inputs.length; k++) {
        const input = inputs[k]
        const { text, at } = rendered[k]
        const candidates = [...detected[k], ...this.knownValues(text, vault)]
        const spans = resolve(candidates, policy).filter((s) => s.decision.action !== 'preserve')
        if (!spans.length) continue
        if (round >= MAX_ROUNDS) throw new PrivacyBlockedError('verification-failed', [])
        segments[k] = this.apply(input.text, segments[k], at, text, spans, vault)
        changed = true
      }
      if (!changed) break
    }
    return inputs.map((input, k) => ({
      text: render(input.text, segments[k]).text,
      replacements: segments[k].flatMap((s) => (s.replacement ? [s.replacement] : []))
    }))
  }

  /** Replaces spans found in the rendered text; each lies inside one stretch of input, never across a placeholder. */
  private apply(input: string, segments: Segment[], at: number[], rendered: string, spans: ResolvedSpan[], vault: PiiVault): Segment[] {
    const out: Segment[] = []
    let si = 0
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      if (seg.replacement) {
        out.push(seg)
        continue
      }
      const outStart = at[i]
      const outEnd = outStart + (seg.end - seg.start)
      let cursor = seg.start
      while (si < spans.length && spans[si].start < outEnd) {
        const span = spans[si]
        if (span.start < outStart || span.end > outEnd || span.end <= span.start) throw new PrivacyBlockedError('invalid-offsets', [])
        const start = seg.start + (span.start - outStart)
        const end = seg.start + (span.end - outStart)
        if (start < cursor) throw new PrivacyBlockedError('invalid-offsets', [])
        const made = markerFor(valueOf(rendered, span), span, vault)
        if (made) {
          if (start > cursor) out.push({ start: cursor, end: start })
          out.push({ start, end, replacement: { start, end, marker: made.marker, entry: made.entry } })
          cursor = end
        }
        si++
      }
      if (cursor < seg.end) out.push({ start: cursor, end: seg.end })
    }
    if (si !== spans.length) throw new PrivacyBlockedError('invalid-offsets', [])
    return out
  }

  async protect(text: string, ctx: DetectionContext, vault: PiiVault, policy: PrivacyPolicy, signal?: AbortSignal): Promise<Protected> {
    return (await this.protectAll([{ text, ctx }], vault, policy, signal))[0]
  }

  verify(items: VerificationItem[], vault: PiiVault, policy: PrivacyPolicy, signal?: AbortSignal): Promise<VerificationResult> {
    return this.verifier.verify(items, vault, policy, signal)
  }

  restoreText(text: string, vault: PiiVault, policy: PrivacyPolicy): Restored {
    return restoreText(text, vault, policy)
  }

  restoreSql(sql: string, dialect: SqlDialect, vault: PiiVault, policy: PrivacyPolicy): Restored {
    return restoreSql(sql, dialect, vault, policy)
  }
}
