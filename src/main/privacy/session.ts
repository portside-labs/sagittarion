// One ask under Local AI Privacy: a policy, the conversation's vault and what was done, for the audit. Everything
// that goes to the provider passes protectRequest (or protectTexts for embeddings), which verifies before it returns.
import type { AiTurn } from '@shared/ai'
import type { AiPrivacyReport, AiTranscriptEntry, PrivacyAction, SealedText, SealedTurn, SensitiveEntityType } from '@shared/privacy'
import type { ChatMessage, ChatRequest, SystemBlock, ToolDef } from '../ai/providers/types'
import type { OutboundTexts, ProtectedRequest } from './boundary'
import type { PrivacyEngine } from './engine'
import { PrivacyBlockedError } from './errors'
import { EXAMPLE_IDS, findMarkers, parseMarker } from './markers'
import { decide, type PrivacyPolicy } from './policy'
import { decodeRestored, restorable, type Restored } from './restore'
import { countOccurrences } from './detectors/known-values'
import type { SqlDialect } from './sql-regions'
import type { Replacement } from './transformer'
import type { ColumnContext, DetectionContext, TextRole } from './types'
import type { PiiVault, VaultEntry } from './vault'
import type { VerificationItem } from './verify'

/** Sent with every protected request. Placeholders are explained; the mapping never is. */
export const PRIVACY_INSTRUCTIONS = [
  '## Protected values',
  "Some values in this conversation were replaced with placeholders on the user's computer before they reached you. Each placeholder stands for one real value you cannot see.",
  `- <|PII:TYPE:ID|> is a protected value, e.g. <|PII:PERSON:${EXAMPLE_IDS[0]}|> or <|PII:EMAIL:${EXAMPLE_IDS[1]}|>. The same placeholder always means the same value; different placeholders mean different values.`,
  `- Copy a placeholder exactly, character for character, wherever you refer to its value, including inside SQL string literals: WHERE email = '<|PII:EMAIL:${EXAMPLE_IDS[1]}|>'. The real value is put back on the user's computer before the query runs.`,
  '- Never modify, expand, translate, summarize or guess the value behind a placeholder, and do not ask for it.',
  '- Placeholders such as <|REDACTED:PASSWORD|>, <|MASKED:CARD:1111|> or <|GENERALIZED:DOB:1984|> mark values that were removed or shortened. They are never restored, so do not use them in queries.'
].join('\n')

/** What the schema block needs to show one table's data safely. */
export interface SchemaTableData {
  key: string
  table: string
  comment: string | null
  columns: { name: string; type: string }[]
  samples?: Record<string, string[]>
}

/** Renders protected sample values and comments; anything it was not given is left out rather than shown raw. */
export interface ProtectedSchemaView {
  samples(key: string, column: string, values: string[]): string[]
  comment(key: string, comment: string): string
}

interface Field {
  text: string
  ctx: DetectionContext
  where: string
  origin: 'local' | 'model'
  set: (text: string) => void
}

/** Model output taken as it is, for connections that are not protected. */
export function unrestored(text: string): Restored {
  return { text, spans: [], restored: 0, withheld: 0, unknown: [], damaged: [] }
}

function toolWhere(name: string): string {
  if (name === 'search_schema' || name === 'describe_table') return 'schema details'
  if (name === 'sample_values') return 'sample values'
  return 'database feedback'
}

/**
 * Lines a sealed text up with the restored text it came from: outside the placeholders they must match exactly.
 * Returns each placeholder with the value it stood for, or null when they do not line up.
 */
export function alignSealed(raw: string, sealed: SealedText): { marker: string; value: string | null }[] | null {
  const out: { marker: string; value: string | null }[] = []
  let rawPos = 0
  let sealedPos = 0
  let spanIndex = 0
  for (const m of findMarkers(sealed.text)) {
    const fragment = sealed.text.slice(sealedPos, m.start)
    const span = sealed.spans[spanIndex]
    if (span && span.marker === m.text) {
      if (!(span.start >= rawPos && span.end >= span.start && span.end <= raw.length)) return null
      if (raw.slice(rawPos, span.start) !== fragment) return null
      out.push({ marker: m.text, value: decodeRestored(raw.slice(span.start, span.end), span.escape) })
      if (span.escape !== 'display' && out[out.length - 1].value === null) return null
      rawPos = span.end
      spanIndex++
    } else {
      // Left as it was: the placeholder itself is in the restored text too.
      if (raw.slice(rawPos, rawPos + fragment.length + m.text.length) !== fragment + m.text) return null
      rawPos += fragment.length + m.text.length
    }
    sealedPos = m.end
  }
  if (spanIndex !== sealed.spans.length) return null
  return raw.slice(rawPos) === sealed.text.slice(sealedPos) ? out : null
}

export class PrivacySession {
  readonly engine: PrivacyEngine
  readonly policy: PrivacyPolicy
  readonly vault: PiiVault
  readonly host: string
  private readonly signal?: AbortSignal
  /** Every value protected during this ask: the placeholder the provider saw instead, and where it was first found. */
  private readonly touched = new Map<VaultEntry, { marker: string; where: string }>()
  private requests = 0
  private readonly restoration = { restored: 0, withheld: 0, unknown: 0, damaged: 0 }

  constructor(opts: { engine: PrivacyEngine; policy: PrivacyPolicy; vault: PiiVault; host: string; signal?: AbortSignal }) {
    this.engine = opts.engine
    this.policy = opts.policy
    this.vault = opts.vault
    this.host = opts.host
    this.signal = opts.signal
  }

  private note(replacements: Replacement[], where: string): void {
    for (const r of replacements) if (!this.touched.has(r.entry)) this.touched.set(r.entry, { marker: r.marker, where })
  }

  /** The database's table and column names: never protected, so the SQL can still use them. */
  useSchema(identifiers: Iterable<string>): void {
    this.engine.useIdentifiers(identifiers)
  }

  /** One text protected on its own, with the offsets of every placeholder in the original: a sealed text. */
  async seal(text: string, role: TextRole = 'prose', where = 'the question'): Promise<SealedText> {
    const [p] = await this.engine.protectAll([{ text, ctx: { role } }], this.vault, this.policy, this.signal)
    this.note(p.replacements, where)
    return { text: p.text, spans: p.replacements.map((r) => ({ marker: r.marker, start: r.start, end: r.end, escape: 'plain' as const })) }
  }

  /** Database values with their column as context: an email column protects whole values, notes are read as prose. */
  async protectValues(column: ColumnContext, values: string[]): Promise<string[]> {
    const classification = await this.engine.inferColumn(this.engine.classify(column), values, this.signal)
    const out = await this.engine.protectAll(
      values.map((text) => ({ text, ctx: { role: 'value' as const, column, classification } })),
      this.vault,
      this.policy,
      this.signal
    )
    out.forEach((p) => this.note(p.replacements, 'sample values'))
    return out.map((p) => p.text)
  }

  /** Protects the sample values and comments of tables about to be shown to the model, in one pass. */
  async schemaView(tables: SchemaTableData[]): Promise<ProtectedSchemaView> {
    const inputs: { text: string; ctx: DetectionContext }[] = []
    const slots: { key: string; column: string | null }[] = []
    for (const t of tables) {
      for (const [column, values] of Object.entries(t.samples ?? {})) {
        const ctxColumn: ColumnContext = { table: t.table, column, declaredType: t.columns.find((c) => c.name === column)?.type }
        const classification = await this.engine.inferColumn(this.engine.classify(ctxColumn), values, this.signal)
        for (const text of values) {
          inputs.push({ text, ctx: { role: 'value', column: ctxColumn, classification } })
          slots.push({ key: t.key, column })
        }
      }
      if (t.comment) {
        inputs.push({ text: t.comment, ctx: { role: 'prose' } })
        slots.push({ key: t.key, column: null })
      }
    }
    const out = await this.engine.protectAll(inputs, this.vault, this.policy, this.signal)
    const samples = new Map<string, Map<string, string[]>>()
    const comments = new Map<string, string>()
    out.forEach((p, i) => {
      const { key, column } = slots[i]
      this.note(p.replacements, column === null ? 'a table comment' : 'sample values')
      if (column === null) comments.set(key, p.text)
      else {
        const cols = samples.get(key) ?? new Map<string, string[]>()
        cols.set(column, [...(cols.get(column) ?? []), p.text])
        samples.set(key, cols)
      }
    })
    return {
      samples: (key, column) => samples.get(key)?.get(column) ?? [],
      comment: (key) => comments.get(key) ?? ''
    }
  }

  /** Every text of a request, protected together and verified. Throws PrivacyBlockedError rather than send a leak. */
  async protectRequest(req: ChatRequest): Promise<ProtectedRequest> {
    const out: ChatRequest = {
      ...req,
      system: req.system.map((b) => ({ ...b })),
      messages: req.messages.map((m): ChatMessage => (m.role === 'assistant' ? { ...m, toolCalls: m.toolCalls?.map((tc) => ({ ...tc, args: structuredClone(tc.args) })) } : { ...m }))
    }
    const fields: Field[] = []
    out.system.forEach((b) => {
      fields.push({ text: b.text, ctx: { role: b.structured ? 'structured' : 'prose' }, where: b.structured && b.cacheable ? 'the schema' : 'the instructions', origin: 'local', set: (t) => (b.text = t) })
    })
    for (const m of out.messages) {
      if (m.role === 'user') fields.push({ text: m.content, ctx: { role: 'prose' }, where: 'a question or reply', origin: 'local', set: (t) => (m.content = t) })
      else if (m.role === 'tool') {
        fields.push({ text: m.content, ctx: { role: m.structured ? 'structured' : 'prose' }, where: toolWhere(m.name), origin: 'local', set: (t) => (m.content = t) })
      } else {
        fields.push({ text: m.content, ctx: { role: 'prose', origin: 'model' }, where: 'an earlier answer', origin: 'model', set: (t) => (m.content = t) })
        for (const tc of m.toolCalls ?? []) collectStrings(tc.args, (text, set) => fields.push({ text, ctx: { role: 'prose', origin: 'model' }, where: 'a tool call', origin: 'model', set }))
      }
    }
    const protectedTexts = await this.engine.protectAll(
      fields.map((f) => ({ text: f.text, ctx: f.ctx })),
      this.vault,
      this.policy,
      this.signal
    )
    protectedTexts.forEach((p, i) => {
      this.note(p.replacements, fields[i].where)
      fields[i].set(p.text)
      fields[i].text = p.text
    })
    const instructions: SystemBlock = { text: PRIVACY_INSTRUCTIONS, structured: true }
    out.system = [instructions, ...out.system]
    const items: VerificationItem[] = [
      { text: PRIVACY_INSTRUCTIONS, ctx: { role: 'structured' }, where: 'the privacy instructions', origin: 'local' },
      ...fields.map((f) => ({ text: f.text, ctx: f.ctx, where: f.where, origin: f.origin })),
      ...toolTexts(out.tools).map((text) => ({ text, ctx: { role: 'structured' as const }, where: 'the tool definitions', origin: 'local' as const }))
    ]
    const verdict = await this.engine.verify(items, this.vault, this.policy, this.signal)
    if (!verdict.passed) throw new PrivacyBlockedError('verification-failed', verdict.findings)
    this.requests++
    return out as ProtectedRequest
  }

  /** Texts for an embeddings endpoint, protected and verified the same way. */
  async protectTexts(texts: string[], role: TextRole): Promise<OutboundTexts> {
    const out = await this.engine.protectAll(texts.map((text) => ({ text, ctx: { role } })), this.vault, this.policy, this.signal)
    out.forEach((p) => this.note(p.replacements, 'an embedding request'))
    const verdict = await this.engine.verify(
      out.map((p) => ({ text: p.text, ctx: { role }, where: 'an embedding request', origin: 'local' as const })),
      this.vault,
      this.policy,
      this.signal
    )
    if (!verdict.passed) throw new PrivacyBlockedError('verification-failed', verdict.findings)
    this.requests++
    return out.map((p) => p.text) as unknown as OutboundTexts
  }

  private count(r: Restored): Restored {
    this.restoration.restored += r.restored
    this.restoration.withheld += r.withheld
    this.restoration.unknown += r.unknown.length
    this.restoration.damaged += r.damaged.length
    return r
  }

  restoreText(text: string): Restored {
    return this.count(this.engine.restoreText(text, this.vault, this.policy))
  }

  restoreSql(sql: string, dialect: SqlDialect): Restored {
    return this.count(this.engine.restoreSql(sql, dialect, this.vault, this.policy))
  }

  /**
   * An earlier turn as the model saw it. Its placeholders are taken back into the vault (they may come from a vault
   * dropped since, e.g. before a relaunch), so the model can keep using them. Null when the sealed form does not line
   * up with the turn as the renderer holds it; the caller then protects the turn afresh.
   */
  adoptTurn(turn: AiTurn): SealedTurn | null {
    const sealed = turn.sealed
    if (!sealed?.question) return null
    const parts: [string | undefined, SealedText | undefined][] = [
      [turn.question, sealed.question],
      [turn.sql, sealed.sql],
      [turn.answer, sealed.answer]
    ]
    const pairs: { marker: string; value: string }[] = []
    for (const [raw, s] of parts) {
      if (!s) continue
      if (typeof raw !== 'string' || typeof s.text !== 'string' || !Array.isArray(s.spans)) return null
      const aligned = alignSealed(raw, s)
      if (!aligned) return null
      for (const a of aligned) if (a.value !== null) pairs.push({ marker: a.marker, value: a.value })
    }
    for (const { marker, value } of pairs) {
      const m = parseMarker(marker)
      if (!m?.type || !value) return null
      if (m.kind === 'pii') {
        if (this.vault.adopt(marker, value, m.type, decide(this.policy, m.type).rehydrate) === 'conflict') return null
      } else this.vault.withhold(value, m.type, m.kind === 'redacted' ? 'redact' : m.kind === 'masked' ? 'mask' : 'generalize')
    }
    return sealed
  }

  /**
   * The protected values of this ask for its transcript: placeholders, kinds and how often each value occurs in
   * what was sent, counted on the exact request bodies. No values.
   */
  transcriptLegend(sent: string[]): AiTranscriptEntry[] {
    const legend = [...this.touched].map(([entry, { marker, where }]) => ({
      marker,
      type: entry.type,
      action: entry.action,
      restorable: restorable(entry, this.policy),
      occurrences: countOccurrences(sent, entry.value),
      where
    }))
    // What the user typed comes first; the rest in the order it was found.
    return [...legend.filter((e) => e.where === 'the question'), ...legend.filter((e) => e.where !== 'the question')]
  }

  report(sealed?: SealedTurn): AiPrivacyReport {
    const counts: Partial<Record<SensitiveEntityType, number>> = {}
    const actions: Partial<Record<PrivacyAction, number>> = {}
    for (const e of this.touched.keys()) {
      counts[e.type] = (counts[e.type] ?? 0) + 1
      actions[e.action] = (actions[e.action] ?? 0) + 1
    }
    return {
      protected: true,
      host: this.host,
      policy: { id: this.policy.id, version: this.policy.version },
      counts,
      actions,
      requests: this.requests,
      restoration: { ...this.restoration },
      engine: this.engine.describe(),
      at: Date.now(),
      ...(sealed ? { sealed } : {})
    }
  }
}

/** Every string inside tool-call arguments, with a way to put a replacement back where it was. */
function collectStrings(value: unknown, visit: (text: string, set: (t: string) => void) => void): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => (typeof v === 'string' ? visit(v, (t) => (value[i] = t)) : collectStrings(v, visit)))
  } else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string') visit(v, (t) => (obj[k] = t))
      else collectStrings(v, visit)
    }
  }
}

function toolTexts(tools: ToolDef[] | undefined): string[] {
  return (tools ?? []).map((t) => `${t.name}\n${t.description}\n${JSON.stringify(t.parameters)}`)
}
