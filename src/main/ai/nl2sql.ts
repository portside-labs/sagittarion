// The orchestrator: schema context in, one verified read-only query out.
//
// The model is reached only through a ModelGateway. Under Local AI Privacy every request it builds is protected and
// verified before it leaves; the model's answers keep their placeholders in the transcript (that is what it wrote),
// and are restored only where they are used here: the SQL that runs, and the words shown in the chat.
import type { DatabaseKind, QueryResponse, TableRef } from '@shared/types'
import type { AiClarification, AiProgressStep, AiQueryResult, AiResult, AiTurn, AiUsage } from '@shared/ai'
import { describeCounts, type SealedText, type SealedTurn, type SensitiveEntityType } from '@shared/privacy'
import { checkReadOnlySql, explainStatement } from './guard'
import { instructionsPrompt, isoDate, systemRules, TOOLS } from './prompt'
import { parseJsonObject, ProviderError, throwIfAborted, type ChatMessage, type ChatRequest, type ChatResponse, type ToolCall, type ToolDef } from './providers/types'
import { estimateTokens, shortComment, tokenize, type RenderView, type SchemaIndex } from './schema-index'
import type { EmbeddingCache } from './embeddings'
import type { ModelGateway } from '../privacy/gateway'
import type { OutboundRequest } from '../privacy/boundary'
import type { SchemaTableData } from '../privacy/session'
import type { Restored } from '../privacy/restore'
import { PrivacyBlockedError } from '../privacy/errors'
import { safeSlice } from '../privacy/markers'

/**
 * Tools from the user's connectors (MCP servers), named as the model sees them. A connector sits on this side of Local
 * AI Privacy, like the database: it gets real values, and what it returns is protected before the model sees it.
 */
export interface AgentConnectors {
  tools: ToolDef[]
  /** "GitHub: Create issue", for the steps shown; undefined for a name that is not a connector's tool. */
  label(name: string): string | undefined
  /** Runs a tool, asking the user first where its permission says so. The arguments hold real values. */
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ content: string; isError?: boolean; declined?: boolean }>
}

export interface AskDeps {
  kind: DatabaseKind
  serverVersion: string
  index: SchemaIndex
  /** The way to the model: protects and verifies every request when Local AI Privacy applies to the connection. */
  provider: ModelGateway
  settings: { sendSampleValues: boolean; autoRun: boolean; schemaBudgetTokens: number; embeddingModel?: string }
  /** Runs SQL under the database's read-only guard. */
  runQuery: (sql: string, maxRows: number) => Promise<QueryResponse>
  /** Distinct values of a column, or null when there are too many to be useful. */
  distinctValues: (ref: TableRef, column: string) => Promise<string[] | null>
  embeddingCache?: EmbeddingCache
  /** Tools from the connectors on for this chat, if any. */
  connectors?: AgentConnectors
  /** The user's instructions for this database: the global ones, then its own. Sent to the model, never shown. */
  instructions?: { name: string; text: string }[]
  now?: Date
  recentTables?: string[]
  maxToolSteps?: number
  maxRepairs?: number
  /** Streams what is happening to the UI. */
  onProgress?: (step: AiProgressStep) => void
  /** Stops at the next step and aborts the request in flight. */
  signal?: AbortSignal
}

const MAX_SAMPLE_COLUMNS = 24
/** The longest answer in words kept: a connector's documentation can make a long one, but not a runaway. */
const MAX_PROSE_CHARS = 40_000
const SAMPLE_LIMIT = 20

interface Proposal {
  sql: string
  explanation: string
  tablesUsed: string[]
  assumptions: string[]
  needsClarification: string | null
}

function readProposal(args: Record<string, unknown>): Proposal {
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [])
  return {
    sql: typeof args.sql === 'string' ? args.sql : '',
    explanation: typeof args.explanation === 'string' ? args.explanation : '',
    tablesUsed: list(args.tables_used ?? args.tablesUsed),
    assumptions: list(args.assumptions),
    needsClarification: typeof args.needs_clarification === 'string' && args.needs_clarification.trim() ? args.needs_clarification.trim() : null
  }
}

function formatTokens(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** Reports steps as running, then done or failed. */
export class Progress {
  private seq = 0
  constructor(private readonly emit?: (step: AiProgressStep) => void) {}

  start(stage: AiProgressStep['stage'], message: string): { done(detail?: string): void; fail(detail: string): void } {
    const stepId = `s${++this.seq}`
    this.emit?.({ stepId, stage, status: 'running', message })
    return {
      done: (detail) => this.emit?.({ stepId, stage, status: 'done', message, detail }),
      fail: (detail) => this.emit?.({ stepId, stage, status: 'error', message, detail })
    }
  }

  note(stage: AiProgressStep['stage'], message: string, detail?: string): void {
    const stepId = `s${++this.seq}`
    this.emit?.({ stepId, stage, status: 'done', message, detail })
  }
}

/** What the privacy layer needs to render a table's data safely: samples and comment with their columns. */
function tableData(index: SchemaIndex, keys: string[]): SchemaTableData[] {
  const out: SchemaTableData[] = []
  for (const key of keys) {
    const t = index.tables.get(key)
    if (!t) continue
    out.push({
      key,
      table: t.ref.name,
      comment: t.comment ? shortComment(t.comment) : null,
      columns: (t.meta?.columns ?? []).map((c) => ({ name: c.name, type: c.type })),
      samples: index.samples.get(key)
    })
  }
  return out
}

/** A render view for these tables, or none when nothing is protected. */
async function viewFor(deps: AskDeps, keys: string[]): Promise<RenderView | undefined> {
  const privacy = deps.provider.privacy
  if (!privacy) return undefined
  privacy.useSchema(deps.index.identifiers())
  return privacy.schemaView(tableData(deps.index, keys))
}

async function loadSamples(deps: AskDeps, keys: string[]): Promise<number> {
  const { index } = deps
  const jobs: { key: string; column: string; ref: TableRef }[] = []
  for (const key of keys) {
    const t = index.tables.get(key)
    if (!t || !t.meta || index.samples.has(key)) continue
    if (typeof t.rowEstimate === 'number' && t.rowEstimate > 2_000_000) continue
    for (const c of t.meta.columns) {
      if (/int|serial|real|float|doub|dec|num|money|bool|date|time|json|uuid|bytea|blob/i.test(c.type)) continue
      if (c.pk > 0 || t.fkByColumn.has(c.name)) continue
      jobs.push({ key, column: c.name, ref: t.ref })
      if (jobs.length >= MAX_SAMPLE_COLUMNS) break
    }
    if (jobs.length >= MAX_SAMPLE_COLUMNS) break
  }
  let sampled = 0
  for (const job of jobs) {
    throwIfAborted(deps.signal)
    try {
      const values = await deps.distinctValues(job.ref, job.column)
      const existing = index.samples.get(job.key) ?? {}
      if (values && values.length && values.length <= SAMPLE_LIMIT && values.every((v) => v.length <= 40)) {
        existing[job.column] = values
        sampled++
      }
      index.samples.set(job.key, existing)
    } catch {
      /* sampling is best effort */
    }
  }
  for (const key of keys) if (!index.samples.has(key)) index.samples.set(key, {})
  return sampled
}

async function queryVector(deps: AskDeps, question: string): Promise<number[] | null> {
  const model = deps.settings.embeddingModel?.trim()
  if (!model || !deps.provider.supportsEmbeddings) return null
  const { index, embeddingCache } = deps
  try {
    const keys = [...index.tables.keys()]
    const commented = keys.filter((k) => index.tables.get(k)?.comment)
    const view = commented.length ? await viewFor(deps, commented) : undefined
    const vectors = new Map<string, number[]>()
    const missing: { key: string; text: string }[] = []
    for (const key of keys) {
      const text = index.embeddingText(key, view)
      const cached = embeddingCache ? await embeddingCache.get(model, text) : undefined
      if (cached) vectors.set(key, cached)
      else missing.push({ key, text })
    }
    for (let i = 0; i < missing.length; i += 100) {
      const batch = missing.slice(i, i + 100)
      const embedded = await deps.provider.embed(
        batch.map((b) => b.text),
        deps.signal,
        { role: 'structured' }
      )
      batch.forEach((b, j) => {
        const v = embedded[j]
        if (v && v.length) {
          vectors.set(b.key, v)
          if (embeddingCache) void embeddingCache.set(model, b.text, v)
        }
      })
    }
    if (embeddingCache) await embeddingCache.save()
    index.setEmbeddings(vectors)
    const [q] = await deps.provider.embed([question], deps.signal, { role: 'prose' })
    return q && q.length ? q : null
  } catch (err) {
    if (err instanceof ProviderError && err.errorKind === 'cancelled') throw err
    if (err instanceof PrivacyBlockedError) throw err
    return null
  }
}

export async function askDatabase(deps: AskDeps, rawQuestion: string, history: AiTurn[] = []): Promise<AiResult> {
  const question = rawQuestion.trim()
  const { index, provider } = deps
  const usage: AiUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, requests: 0, toolCalls: 0, provider: provider.kind, model: provider.model }
  const progress = new Progress(deps.onProgress)
  if (!question) return { kind: 'clarify', message: 'Type a question about the data first.', usage }
  if (!index.tables.size) return { kind: 'clarify', message: 'This database has no tables to ask about.', usage }
  try {
    return await run(deps, question, history, usage, progress)
  } catch (err) {
    if (err instanceof ProviderError && err.errorKind === 'cancelled') {
      progress.note('cancelled', 'Cancelled')
      return { kind: 'cancelled', usage }
    }
    progress.note('error', 'Failed', err instanceof Error ? err.message : String(err))
    throw err
  }
}

function total(counts: Partial<Record<SensitiveEntityType, number>>): number {
  return Object.values(counts).reduce((n, c) => n + (c ?? 0), 0)
}

async function run(deps: AskDeps, question: string, history: AiTurn[], usage: AiUsage, progress: Progress): Promise<AiResult> {
  const { index, provider } = deps
  const privacy = provider.privacy
  const fmt = new Intl.NumberFormat('en-US')
  // Table and column names are never protected, so the model can still write SQL with them. The list grows as
  // tables are described, so it is refreshed before each protection.
  privacy?.useSchema(index.identifiers())

  // The user's instructions go to the model with every request; the steps say which are followed, not what they say.
  const instructions = (deps.instructions ?? []).filter((i) => i.text.trim())
  if (instructions.length) {
    progress.note('instructions', instructions.length === 1 ? 'Following 1 instruction' : `Following ${instructions.length} instructions`, instructions.map((i) => i.name).join(', '))
  }

  // Schema context: everything when it fits, otherwise retrieve.
  const retrieving = progress.start('retrieve', 'Choosing tables for the question')
  const vector = index.totalTokens > deps.settings.schemaBudgetTokens ? await queryVector(deps, question) : null
  throwIfAborted(deps.signal)
  const selection = await index.select(question, deps.settings.schemaBudgetTokens, { recentKeys: deps.recentTables, queryVector: vector })
  retrieving.done(
    selection.mode === 'all'
      ? `all ${fmt.format(selection.totalTables)} tables, ~${formatTokens(selection.tokens)} tokens`
      : `${selection.keys.length} of ${fmt.format(selection.totalTables)} tables, ~${formatTokens(selection.tokens)} tokens${vector ? ', with embeddings' : ''}`
  )
  throwIfAborted(deps.signal)
  if (deps.settings.sendSampleValues) {
    const targets = selection.keys.slice(0, 12)
    const sampling = progress.start('sample', `Sampling values in ${targets.length} table${targets.length === 1 ? '' : 's'}`)
    const n = await loadSamples(deps, targets)
    sampling.done(`${n} column${n === 1 ? '' : 's'} with short value lists`)
  }
  const shown = new Set(selection.keys)
  // Sample values and comments are protected with their columns as context before the question is, so a value
  // seen in the data is recognised wherever else it appears.
  const schemaText = index.render(selection, question, await viewFor(deps, selection.keys))
  const header =
    selection.mode === 'all'
      ? `## Schema (all ${selection.totalTables} tables)\n`
      : `## Schema excerpt (${selection.keys.length} of ${selection.totalTables} tables; use search_schema for others)\n`
  const today = isoDate(deps.now ?? new Date())

  let toolsEnabled = true
  const messages: ChatMessage[] = []
  for (const turn of history.slice(-6)) {
    // An earlier turn as the model saw it, when the chat kept that; otherwise as shown, and protected on the way out.
    const sealed = provider.adoptTurn(turn)
    messages.push({ role: 'user', content: sealed?.question.text ?? turn.question })
    const sql = turn.sql ? (sealed?.sql?.text ?? turn.sql) : undefined
    messages.push({ role: 'assistant', content: sql ? `SQL used:\n${sql}` : (sealed?.answer?.text ?? turn.answer ?? '(no answer)') })
  }
  messages.push({ role: 'user', content: (await provider.seal(question))?.text ?? question })

  // Connectors take steps of their own: looking something up elsewhere comes before the schema work.
  const maxSteps = deps.maxToolSteps ?? (deps.connectors?.tools.length ? 10 : 6)
  const maxRepairs = deps.maxRepairs ?? 2
  let repairs = 0
  let explained = false
  let protectedSoFar = -1

  /** The request as it may leave: protected and verified, or marked exempt. Reports what was protected. */
  const prepare = async (req: ChatRequest): Promise<OutboundRequest> => {
    if (!privacy) return provider.prepare(req)
    const step = protectedSoFar < 0 ? progress.start('privacy', 'Protecting sensitive values') : null
    try {
      privacy.useSchema(index.identifiers())
      const outbound = await provider.prepare(req)
      const counts = privacy.report().counts
      const n = total(counts)
      if (step) step.done(n ? `${describeCounts(counts)} replaced with placeholders; checked again before sending` : 'nothing sensitive found; checked before sending')
      else if (n > protectedSoFar) progress.note('privacy', 'Protected more values', describeCounts(counts))
      protectedSoFar = n
      return outbound
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      if (step) step.fail(detail)
      else progress.note('error', 'Stopped by Local AI Privacy', detail)
      throw err
    }
  }

  const complete = async (): Promise<ChatResponse> => {
    throwIfAborted(deps.signal)
    const req: ChatRequest = {
      system: [
        { text: systemRules(deps.kind, deps.serverVersion, today, index.defaultSchema, toolsEnabled, Boolean(toolsEnabled && deps.connectors?.tools.length)), structured: true },
        // Prose the user wrote, so protected as prose; before the schema, so its cache breakpoint covers both.
        ...(instructions.length ? [{ text: instructionsPrompt(instructions) }] : []),
        { text: header + schemaText, cacheable: true, structured: true }
      ],
      messages,
      tools: toolsEnabled ? [...TOOLS, ...(deps.connectors?.tools ?? [])] : undefined,
      toolChoice: toolsEnabled ? ('auto' as const) : undefined
    }
    const outbound = await prepare(req)
    throwIfAborted(deps.signal)
    const asking = progress.start('request', `Asking ${provider.model || provider.kind}${usage.requests ? ` (request ${usage.requests + 1})` : ''}`)
    try {
      const res = await provider.send(outbound, deps.signal)
      usage.requests++
      usage.inputTokens += res.usage.inputTokens
      usage.outputTokens += res.usage.outputTokens
      usage.cachedInputTokens += res.usage.cachedInputTokens
      usage.model = res.model || usage.model
      asking.done(`${formatTokens(res.usage.inputTokens)} in / ${formatTokens(res.usage.outputTokens)} out${res.usage.cachedInputTokens ? `, ${formatTokens(res.usage.cachedInputTokens)} cached` : ''}`)
      return res
    } catch (err) {
      if (err instanceof ProviderError && err.errorKind === 'tools_unsupported' && toolsEnabled) {
        asking.done('no tool support; switching to JSON answers')
        toolsEnabled = false
        return complete()
      }
      asking.fail(err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  /** Words from the model, restored for display here. */
  const shownText = (text: string) => provider.restoreText(text).text

  /** The turn as the model saw it, for the chat to replay; only when something is protected. */
  const sealTurn = async (extra: { sql?: SealedText; answer?: SealedText }): Promise<SealedTurn | undefined> => {
    if (!privacy) return undefined
    const q = await provider.seal(question)
    return q ? { question: q, ...extra } : undefined
  }

  /**
   * A reply that is not a query. `fromModel` is the model's own words, sealed for the history as it wrote them;
   * `local` is the app's message, which the history replays as shown and protects again.
   */
  const clarify = async (fromModel: string, local?: string, cutShort = false): Promise<AiClarification> => {
    const restored = provider.restoreText(fromModel)
    const message = restored.text || (local ? shownText(local) : '')
    const sealed = await sealTurn(restored.text ? { answer: { text: fromModel, spans: restored.spans } } : {})
    return { kind: 'clarify', message, usage, privacy: provider.report(sealed), ...(cutShort ? { cutShort } : {}) }
  }

  const finish = async (p: Proposal, tokenizedSql: string, restored: Restored): Promise<AiQueryResult> => {
    const tablesUsed = p.tablesUsed.map(shownText)
    progress.note('done', 'Query ready', tablesUsed.length ? `uses ${tablesUsed.join(', ')}` : undefined)
    const warnings = restored.withheld
      ? [`The query refers to ${restored.withheld === 1 ? 'a value' : `${restored.withheld} values`} the model never saw in full (masked or withheld by the privacy policy). Replace ${restored.withheld === 1 ? 'it' : 'them'} before running.`]
      : []
    const sealed = await sealTurn({ sql: { text: tokenizedSql, spans: restored.spans } })
    return {
      kind: 'query',
      sql: restored.text,
      explanation: shownText(p.explanation),
      tablesUsed,
      assumptions: p.assumptions.map(shownText),
      checks: { readOnly: true, explained, repairs },
      context: { mode: selection.mode, tables: selection.keys.length, totalTables: selection.totalTables, schemaTokens: estimateTokens(schemaText) },
      usage,
      autoRun: deps.settings.autoRun && explained && !warnings.length,
      ...(warnings.length ? { warnings } : {}),
      privacy: provider.report(sealed)
    }
  }

  const runTool = async (call: ToolCall): Promise<{ content: string; structured?: boolean }> => {
    usage.toolCalls++
    const args = call.args ?? {}
    if (call.name === 'search_schema') {
      const query = shownText(String(args.query ?? ''))
      const step = progress.start('tool', `Model searched the schema for "${query}"`)
      const lines = await index.search(query, 10, shown, privacy ? (keys) => viewFor(deps, keys) as Promise<RenderView> : undefined)
      for (const l of lines) shown.add(l.slice(0, l.indexOf('(')))
      step.done(lines.length ? `${lines.length} table${lines.length === 1 ? '' : 's'}` : 'nothing new')
      return { content: lines.length ? lines.join('\n') : 'No further tables match. The excerpt already shows every relevant table.', structured: true }
    }
    if (call.name === 'describe_table') {
      const name = shownText(String(args.table ?? ''))
      const step = progress.start('tool', `Model asked to describe ${name}`)
      const t = index.find(name)
      if (!t) {
        step.fail('unknown table')
        return { content: `Unknown table: ${name}. Use search_schema to find the right name.`, structured: true }
      }
      await index.ensureColumns([t.key])
      if (deps.settings.sendSampleValues) await loadSamples(deps, [t.key])
      const text = await index.describe(t.key, await viewFor(deps, [t.key]))
      shown.add(t.key)
      step.done(`${t.meta?.columns.length ?? 0} columns`)
      return { content: text, structured: true }
    }
    if (call.name === 'sample_values') {
      const table = shownText(String(args.table ?? ''))
      const column = shownText(String(args.column ?? ''))
      const step = progress.start('tool', `Model asked for sample values of ${table}.${column}`)
      const t = index.find(table)
      if (t) await index.ensureColumns([t.key])
      const meta = t?.meta?.columns.find((c) => c.name === column)
      if (!t || !meta) {
        step.fail('unknown column')
        return { content: `Unknown table or column: ${table}.${column}`, structured: true }
      }
      if (!deps.settings.sendSampleValues) {
        step.done('disabled in settings')
        return { content: "Sample values are disabled in this app's settings; rely on the column type and the question instead.", structured: true }
      }
      try {
        const values = await deps.distinctValues(t.ref, column)
        privacy?.useSchema(index.identifiers())
        const shownValues = values && privacy ? await privacy.protectValues({ table: t.ref.name, column, declaredType: meta.type }, values.slice(0, SAMPLE_LIMIT)) : values
        const text = shownValues ? (shownValues.length ? shownValues.slice(0, SAMPLE_LIMIT).join(' | ') : 'No values (column is empty or all NULL).') : 'Too many distinct values to list; treat the column as free text.'
        step.done(values ? `${values.length} value${values.length === 1 ? '' : 's'}` : 'too many values')
        return { content: text, structured: true }
      } catch (e: any) {
        if (e instanceof PrivacyBlockedError) throw e
        step.fail(e?.message ?? String(e))
        return { content: `Could not sample: ${e?.message ?? e}` }
      }
    }
    const label = deps.connectors?.label(call.name)
    if (deps.connectors && label) {
      const step = progress.start('tool', `Model used ${label}`)
      try {
        // Placeholders become the values they stand for: the connector needs the real email, not a stand-in for it.
        const res = await deps.connectors.call(call.name, restoreArgs(args), deps.signal)
        if (res.declined) step.fail('you declined')
        else if (res.isError) step.fail(safeSlice(res.content.trim().split('\n')[0] ?? 'failed', 160))
        else step.done(`${formatTokens(estimateTokens(res.content))} tokens back`)
        // Unstructured: what the connector returned is protected like any reply, before the next request leaves.
        return { content: res.content || '(no content)' }
      } catch (e: any) {
        if (e instanceof PrivacyBlockedError || deps.signal?.aborted) throw e
        step.fail(e?.message ?? String(e))
        return { content: `The tool failed: ${e?.message ?? e}` }
      }
    }
    progress.note('tool', `Model called unknown tool ${call.name}`)
    return { content: `Unknown tool ${call.name}.` }
  }

  /** A tool call's arguments with placeholders turned back into their values, strings at any depth. */
  const restoreArgs = (value: Record<string, unknown>): Record<string, unknown> => {
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') return shownText(v)
      if (Array.isArray(v)) return v.map(walk)
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
      return v
    }
    return walk(value) as Record<string, unknown>
  }

  let lastText = ''
  for (let step = 0; step < maxSteps; step++) {
    const res = await complete()
    lastText = res.text
    let calls = res.toolCalls
    if (!calls.length) {
      const parsed = parseJsonObject(res.text)
      if (parsed && (typeof parsed.sql === 'string' || typeof parsed.needs_clarification === 'string')) {
        calls = [{ id: 'json', name: 'propose_query', args: parsed }]
      } else if (res.text.trim()) {
        progress.note('done', 'Model answered in words, without a query')
        // "max_tokens" (Anthropic) and "length" (OpenAI and the like): the reply stopped at the model's limit.
        return clarify(safeSlice(res.text.trim(), MAX_PROSE_CHARS), undefined, /^(max_tokens|length)$/.test(res.stopReason))
      } else {
        progress.note('error', 'Model returned an empty answer')
        return clarify('', 'The model returned an empty answer. Try rephrasing the question.')
      }
    }
    const proposal = calls.find((c) => c.name === 'propose_query')
    if (proposal) {
      const p = readProposal(proposal.args)
      if (p.needsClarification && !p.sql.trim()) {
        progress.note('done', 'Model asked for clarification')
        return clarify(p.needsClarification)
      }
      const checking = progress.start('check', 'Checking the query is read-only and valid')
      // The model's SQL is checked in its own terms, then restored for this database and checked again.
      const gate = checkReadOnlySql(p.sql)
      let problem: string | null = gate.ok ? null : gate.reason
      const tokenizedSql = gate.ok ? gate.sql : p.sql
      const restored = provider.restoreSql(tokenizedSql, deps.kind)
      if (!problem && (restored.unknown.length || restored.damaged.length)) {
        const bad = [...new Set([...restored.unknown, ...restored.damaged])].slice(0, 5)
        problem = `The query uses placeholders that do not match any protected value: ${bad.join(', ')}. Copy each placeholder exactly as it appears in the conversation, including the <| and |> around it.`
      }
      if (!problem) {
        const gate2 = checkReadOnlySql(restored.text)
        if (!gate2.ok) problem = gate2.reason
      }
      if (!problem) {
        try {
          const res2 = await deps.runQuery(explainStatement(deps.kind, restored.text), 50)
          const first = res2.results[0]
          if (first && first.kind === 'error') problem = `The database rejected the query: ${first.message}`
          else explained = true
        } catch (e: any) {
          problem = `The database rejected the query: ${e?.message ?? e}`
        }
      }
      if (!problem) {
        checking.done('EXPLAIN passed')
        return finish(p, tokenizedSql, restored)
      }
      checking.fail(shownText(problem))
      if (repairs >= maxRepairs) {
        progress.note('error', 'Gave up after the repair limit')
        return clarify('', `I could not produce a query the database accepts. Last attempt failed with: ${problem}`)
      }
      repairs++
      explained = false
      progress.note('repair', `Sending the error back for a fix (${repairs} of ${maxRepairs})`)
      if (proposal.id !== 'json') {
        // Every tool call in the turn needs an answer, or the next request is rejected.
        messages.push({ role: 'assistant', content: res.text, toolCalls: calls })
        for (const call of calls) {
          const answer = call === proposal ? { content: `${problem}\nFix the query and call propose_query again. Use describe_table if unsure about a column.` } : await runTool(call)
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, ...answer })
        }
      } else {
        messages.push({ role: 'assistant', content: res.text })
        messages.push({ role: 'user', content: `${problem}\nFix the query and answer again with the JSON object.` })
      }
      continue
    }
    // Information tools: answer each and loop.
    messages.push({ role: 'assistant', content: res.text, toolCalls: calls })
    for (const call of calls) messages.push({ role: 'tool', toolCallId: call.id, name: call.name, ...(await runTool(call)) })
  }
  progress.note('error', 'Model kept exploring without proposing a query')
  return clarify(safeSlice(lastText.trim(), MAX_PROSE_CHARS), 'The model kept exploring the schema without proposing a query. Try naming the tables you mean.')
}

export function questionTerms(question: string): string[] {
  return tokenize(question)
}
