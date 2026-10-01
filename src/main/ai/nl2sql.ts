// The orchestrator: schema context in, one verified read-only query out.
//
// The model is reached only through a ModelGateway. Under Local AI Privacy every request it builds is protected and
// verified before it leaves; the model's answers keep their placeholders in the transcript (that is what it wrote),
// and are restored only where they are used here: the SQL that runs, and the words shown in the chat.
import type { DatabaseKind, QueryResponse, TableRef } from '@shared/types'
import type { AiClarification, AiDatabaseRef, AiMemory, AiProgressStep, AiQueryResult, AiRanQuery, AiResult, AiTurn, AiUsage } from '@shared/ai'
import { cellToPlainText } from '@shared/export'
import { describeCounts, type SealedText, type SealedTurn, type SensitiveEntityType } from '@shared/privacy'
import { checkReadOnlySql, explainStatement } from './guard'
import { acrossRules, acrossTools, instructionsPrompt, isoDate, RESULT_CHARS, RESULT_ROWS, singleTools, systemRules } from './prompt'
import { parseJsonObject, ProviderError, throwIfAborted, type ChatMessage, type ChatRequest, type ChatResponse, type ToolCall, type ToolDef } from './providers/types'
import { estimateTokens, shortComment, tokenize, type RenderView, type SchemaIndex, type Selection } from './schema-index'
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

/** One database an ask can see: the chat's own, or another it has in context. */
export interface AgentDatabase {
  /** What the model calls it in tools: a short key, unique in the ask. */
  key: string
  /** The connection's name, for the steps and the answer. */
  name: string
  /** The saved connection, so an answer can say where its queries belong. */
  connectionId?: string
  kind: DatabaseKind
  serverVersion: string
  index: SchemaIndex
  /** Runs SQL under the database's read-only guard. */
  runQuery: (sql: string, maxRows: number) => Promise<QueryResponse>
  distinctValues: (ref: TableRef, column: string) => Promise<string[] | null>
  recentTables?: string[]
  /** The user lets the model run read-only queries here and read their results, to work questions out itself. */
  readResults?: boolean
}

export interface AskDeps {
  kind: DatabaseKind
  serverVersion: string
  index: SchemaIndex
  /** The way to the model: protects and verifies every request when Local AI Privacy applies to the connection. */
  provider: ModelGateway
  settings: { sendSampleValues: boolean; autoRun: boolean; schemaBudgetTokens: number; embeddingModel?: string }
  /** For the one database the fields above describe: whether the model may read query results on it. */
  readResults?: boolean
  /** Its saved connection, which a fact the model offers to remember is about. */
  connectionId?: string
  /** Runs SQL under the database's read-only guard. */
  runQuery: (sql: string, maxRows: number) => Promise<QueryResponse>
  /** Distinct values of a column, or null when there are too many to be useful. */
  distinctValues: (ref: TableRef, column: string) => Promise<string[] | null>
  embeddingCache?: EmbeddingCache
  /**
   * Every database the chat has in context, its own first. With more than one, the model looks across all of them;
   * otherwise the fields above describe the only one.
   */
  databases?: AgentDatabase[]
  /** Tools from the connectors on for this chat, if any. */
  connectors?: AgentConnectors
  /**
   * The user's instructions for this database: the global ones, then its own. Sent to the model, never shown. Across
   * databases, one written for some of them lists their keys.
   */
  instructions?: { name: string; text: string; databases?: string[] }[]
  now?: Date
  recentTables?: string[]
  maxToolSteps?: number
  maxRepairs?: number
  /** Streams what is happening to the UI. */
  onProgress?: (step: AiProgressStep) => void
  /**
   * The answer as the model writes it, restored for display, for providers that stream: the whole text so far each
   * time, and '' when what was written turns out to lead into tool calls rather than be the answer.
   */
  onStream?: (text: string) => void
  /** Stops at the next step and aborts the request in flight. */
  signal?: AbortSignal
}

const MAX_SAMPLE_COLUMNS = 24
/** The longest answer in words kept: a connector's documentation can make a long one, but not a runaway. */
const MAX_PROSE_CHARS = 40_000
const SAMPLE_LIMIT = 20

interface Proposal {
  /** The database key, in a chat across several. */
  database: string
  sql: string
  explanation: string
  tablesUsed: string[]
  assumptions: string[]
  needsClarification: string | null
}

function readProposal(args: Record<string, unknown>): Proposal {
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [])
  return {
    database: typeof args.database === 'string' ? args.database : '',
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

/** The answer being written, passed on restored at most every 50ms, so a fast stream does not flood the window. */
class Draft {
  private raw = ''
  private shown = ''
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly emit: (text: string) => void,
    private readonly preview: (raw: string) => string
  ) {}

  add(delta: string): void {
    this.raw += delta
    this.timer ??= setTimeout(() => {
      this.timer = null
      this.send()
    }, 50)
  }

  /** The reply is the answer: everything written so far goes out now. */
  flush(): void {
    this.stop()
    this.send()
  }

  /** The reply leads into tool calls, or failed: what was shown of it goes. */
  clear(): void {
    this.stop()
    this.raw = ''
    if (this.shown) {
      this.shown = ''
      this.emit('')
    }
  }

  private stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private send(): void {
    const text = this.preview(this.raw)
    if (text === this.shown) return
    this.shown = text
    this.emit(text)
  }
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

/** The databases of an ask: those given, or the one the single-database fields describe. */
function databasesOf(deps: AskDeps): AgentDatabase[] {
  if (deps.databases?.length) return deps.databases
  return [
    {
      key: 'main',
      name: 'this database',
      kind: deps.kind,
      serverVersion: deps.serverVersion,
      index: deps.index,
      runQuery: deps.runQuery,
      distinctValues: deps.distinctValues,
      recentTables: deps.recentTables,
      readResults: deps.readResults,
      connectionId: deps.connectionId
    }
  ]
}

/** A render view for these tables, or none when nothing is protected. */
async function viewFor(deps: AskDeps, db: AgentDatabase, keys: string[]): Promise<RenderView | undefined> {
  const privacy = deps.provider.privacy
  if (!privacy) return undefined
  privacy.useSchema(databasesOf(deps).flatMap((d) => d.index.identifiers()))
  return privacy.schemaView(tableData(db.index, keys))
}

async function loadSamples(deps: AskDeps, db: AgentDatabase, keys: string[]): Promise<number> {
  const { index } = db
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
      const values = await db.distinctValues(job.ref, job.column)
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

async function queryVector(deps: AskDeps, db: AgentDatabase, question: string): Promise<number[] | null> {
  const model = deps.settings.embeddingModel?.trim()
  if (!model || !deps.provider.supportsEmbeddings) return null
  const { embeddingCache } = deps
  const { index } = db
  try {
    const keys = [...index.tables.keys()]
    const commented = keys.filter((k) => index.tables.get(k)?.comment)
    const view = commented.length ? await viewFor(deps, db, commented) : undefined
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
  const { provider } = deps
  const usage: AiUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, requests: 0, toolCalls: 0, provider: provider.kind, model: provider.model }
  const progress = new Progress(deps.onProgress)
  if (!question) return { kind: 'clarify', message: 'Type a question about the data first.', usage }
  if (databasesOf(deps).every((d) => !d.index.tables.size)) return { kind: 'clarify', message: 'This database has no tables to ask about.', usage }
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
  const { provider } = deps
  const privacy = provider.privacy
  const fmt = new Intl.NumberFormat('en-US')
  const dbs = databasesOf(deps)
  /** More than one database in the chat: the model looks across them all. */
  const across = dbs.length > 1
  /** The databases whose query results the model may read: the user said so for these. */
  const readableKeys = dbs.filter((d) => d.readResults).map((d) => d.key)
  /** With any, the model works the question out by looking at data, rather than writing one query for the user. */
  const investigating = readableKeys.length > 0
  const identifiers = () => dbs.flatMap((d) => d.index.identifiers())
  const refOf = (db: AgentDatabase): AiDatabaseRef => ({ connectionId: db.connectionId ?? '', name: db.name })
  /** The queries the model ran to look into the question, as they ran here. */
  const ranQueries: AiRanQuery[] = []
  /** Facts the model offered to remember, for the user to keep or not. */
  const memories: AiMemory[] = []
  // Table and column names are never protected, so the model can still write SQL with them. The list grows as
  // tables are described, so it is refreshed before each protection.
  privacy?.useSchema(identifiers())

  // The user's instructions go to the model with every request; the steps say which are followed, not what they say.
  const instructions = (deps.instructions ?? []).filter((i) => i.text.trim())
  if (instructions.length) {
    progress.note('instructions', instructions.length === 1 ? 'Following 1 instruction' : `Following ${instructions.length} instructions`, instructions.map((i) => i.name).join(', '))
  }

  // Schema context for each database: everything when it fits, otherwise retrieve. Several share the budget.
  const budget = across ? Math.max(1500, Math.floor(deps.settings.schemaBudgetTokens / dbs.length)) : deps.settings.schemaBudgetTokens
  const retrieving = progress.start('retrieve', across ? `Choosing tables in ${dbs.length} databases` : 'Choosing tables for the question')
  const contexts: { db: AgentDatabase; selection: Selection; shown: Set<string> }[] = []
  let embedded = false
  for (const db of dbs) {
    const vector = db.index.totalTokens > budget ? await queryVector(deps, db, question) : null
    if (vector) embedded = true
    throwIfAborted(deps.signal)
    const selection = await db.index.select(question, budget, { recentKeys: db.recentTables, queryVector: vector })
    contexts.push({ db, selection, shown: new Set(selection.keys) })
  }
  const describeSelection = (sel: Selection) =>
    sel.mode === 'all'
      ? `all ${fmt.format(sel.totalTables)} tables, ~${formatTokens(sel.tokens)} tokens`
      : `${sel.keys.length} of ${fmt.format(sel.totalTables)} tables, ~${formatTokens(sel.tokens)} tokens${!across && embedded ? ', with embeddings' : ''}`
  retrieving.done(across ? contexts.map((c) => `${c.db.name}: ${describeSelection(c.selection)}`).join('; ') : describeSelection(contexts[0].selection))
  throwIfAborted(deps.signal)
  if (deps.settings.sendSampleValues) {
    const targets = contexts.map((c) => ({ db: c.db, keys: c.selection.keys.slice(0, across ? 6 : 12) }))
    const count = targets.reduce((n, t) => n + t.keys.length, 0)
    const sampling = progress.start('sample', `Sampling values in ${count} table${count === 1 ? '' : 's'}`)
    let n = 0
    for (const t of targets) n += await loadSamples(deps, t.db, t.keys)
    sampling.done(`${n} column${n === 1 ? '' : 's'} with short value lists`)
  }
  // Sample values and comments are protected with their columns as context before the question is, so a value
  // seen in the data is recognised wherever else it appears.
  const sections: string[] = []
  let schemaTokens = 0
  for (const c of contexts) {
    const text = c.db.index.render(c.selection, question, await viewFor(deps, c.db, c.selection.keys))
    schemaTokens += estimateTokens(text)
    const sel = c.selection
    if (across) {
      const what = sel.mode === 'all' ? `all ${sel.totalTables} tables` : `${sel.keys.length} of ${sel.totalTables} tables; use search_schema for others`
      sections.push(`## Database "${c.db.key}": ${c.db.name} (${what})\n${text}`)
    } else {
      const header = sel.mode === 'all' ? `## Schema (all ${sel.totalTables} tables)\n` : `## Schema excerpt (${sel.keys.length} of ${sel.totalTables} tables; use search_schema for others)\n`
      sections.push(header + text)
    }
  }
  const schemaBlock = sections.join('\n\n')
  const today = isoDate(deps.now ?? new Date())

  /**
   * What an earlier answer's query returned when it ran in the editor, on a database whose results the model may read:
   * the first rows, each value protected with its column as context, as run_query's are.
   */
  const editorResult = async (turn: AiTurn): Promise<string> => {
    const r = turn.result
    if (!r || !Array.isArray(r.columns) || !Array.isArray(r.rows)) return ''
    const db = across ? dbs.find((d) => d.name === turn.database) : dbs[0]
    if (!db?.readResults) return ''
    const rows = r.rows.slice(0, 20).map((row) => r.columns.map((_, c) => (row[c] == null ? 'NULL' : safeSlice(String(row[c]).replace(/\s*\n\s*/g, ' '), 200))))
    if (privacy && rows.length) {
      privacy.useSchema(identifiers())
      for (let c = 0; c < r.columns.length; c++) {
        const at = rows.map((row, i) => (row[c] === 'NULL' ? -1 : i)).filter((i) => i >= 0)
        if (!at.length) continue
        const safe = await privacy.protectValues({ column: r.columns[c] }, at.map((i) => rows[i][c]), 'query results')
        at.forEach((i, k) => (rows[i][c] = safe[k]))
      }
    }
    const count = Number(r.rowCount) || rows.length
    const head = `When it ran in the editor, it returned ${count} row${count === 1 ? '' : 's'}${count > rows.length ? `; the first ${rows.length}` : ''}:`
    return [head, r.columns.join(' | '), ...rows.map((row) => row.join(' | '))].join('\n')
  }

  let toolsEnabled = true
  const messages: ChatMessage[] = []
  for (const turn of history.slice(-6)) {
    // An earlier turn as the model saw it, when the chat kept that; otherwise as shown, and protected on the way out.
    const sealed = provider.adoptTurn(turn)
    messages.push({ role: 'user', content: sealed?.question.text ?? turn.question })
    const sql = turn.sql ? (sealed?.sql?.text ?? turn.sql) : undefined
    const result = sql ? await editorResult(turn) : ''
    const said = sql ? `SQL used${turn.database ? ` on ${turn.database}` : ''}:\n${sql}` : (sealed?.answer?.text ?? turn.answer ?? '(no answer)')
    messages.push({ role: 'assistant', content: result ? `${said}\n\n${result}` : said })
  }
  messages.push({ role: 'user', content: (await provider.seal(question))?.text ?? question })

  // Connectors take steps of their own, following a trail across databases takes more, and working a question out
  // from the data takes the most.
  const maxSteps = deps.maxToolSteps ?? (investigating ? 25 : across ? 16 : deps.connectors?.tools.length ? 10 : 6)
  const maxRepairs = deps.maxRepairs ?? 2
  let repairs = 0
  let explained = false
  let protectedSoFar = -1

  /** The request as it may leave: protected and verified, or marked exempt. Reports what was protected. */
  const prepare = async (req: ChatRequest): Promise<OutboundRequest> => {
    if (!privacy) return provider.prepare(req)
    const step = protectedSoFar < 0 ? progress.start('privacy', 'Protecting sensitive values') : null
    try {
      privacy.useSchema(identifiers())
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

  /** `last`: the final step of a chat across databases, where the model answers with what it found instead of looking further. */
  const complete = async (last = false): Promise<ChatResponse> => {
    throwIfAborted(deps.signal)
    const connectorTools = deps.connectors?.tools ?? []
    const rules = across
      ? acrossRules(
          dbs.map((d) => ({ key: d.key, name: d.name, kind: d.kind, serverVersion: d.serverVersion, defaultSchema: d.index.defaultSchema })),
          today,
          { tools: toolsEnabled, readable: toolsEnabled ? readableKeys : [], connectors: Boolean(toolsEnabled && connectorTools.length) }
        )
      : systemRules(dbs[0].kind, dbs[0].serverVersion, today, dbs[0].index.defaultSchema, toolsEnabled, Boolean(toolsEnabled && connectorTools.length), investigating)
    const req: ChatRequest = {
      system: [
        { text: rules, structured: true },
        // Prose the user wrote, so protected as prose; before the schema, so its cache breakpoint covers both.
        ...(instructions.length ? [{ text: instructionsPrompt(instructions, across) }] : []),
        { text: schemaBlock, cacheable: true, structured: true }
      ],
      messages,
      tools: toolsEnabled ? [...(across ? acrossTools(dbs.map((d) => d.key), readableKeys) : singleTools(investigating)), ...connectorTools] : undefined,
      toolChoice: toolsEnabled ? (last ? ('none' as const) : ('auto' as const)) : undefined
    }
    const outbound = await prepare(req)
    throwIfAborted(deps.signal)
    const asking = progress.start('request', `Asking ${provider.model || provider.kind}${usage.requests ? ` (request ${usage.requests + 1})` : ''}`)
    // Prose the model writes is shown as it streams; a JSON answer, asked for when tools are not, is not prose.
    const draft = deps.onStream && toolsEnabled ? new Draft(deps.onStream, (raw) => provider.previewText(raw)) : null
    try {
      const res = await provider.send(outbound, deps.signal, draft ? (delta) => draft.add(delta) : undefined)
      if (res.toolCalls.length) draft?.clear()
      else draft?.flush()
      usage.requests++
      usage.inputTokens += res.usage.inputTokens
      usage.outputTokens += res.usage.outputTokens
      usage.cachedInputTokens += res.usage.cachedInputTokens
      usage.model = res.model || usage.model
      asking.done(`${formatTokens(res.usage.inputTokens)} in / ${formatTokens(res.usage.outputTokens)} out${res.usage.cachedInputTokens ? `, ${formatTokens(res.usage.cachedInputTokens)} cached` : ''}`)
      return res
    } catch (err) {
      draft?.clear()
      if (err instanceof ProviderError && err.errorKind === 'tools_unsupported' && toolsEnabled) {
        asking.done('no tool support; switching to JSON answers')
        toolsEnabled = false
        return complete(last)
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
    return {
      kind: 'clarify',
      message,
      usage,
      privacy: provider.report(sealed),
      ...(cutShort ? { cutShort } : {}),
      ...(ranQueries.length ? { queries: ranQueries } : {}),
      ...(memories.length ? { memories } : {})
    }
  }

  const finish = async (p: Proposal, tokenizedSql: string, restored: Restored, db: AgentDatabase): Promise<AiQueryResult> => {
    const tablesUsed = p.tablesUsed.map(shownText)
    progress.note('done', across ? `Query ready for ${db.name}` : 'Query ready', tablesUsed.length ? `uses ${tablesUsed.join(', ')}` : undefined)
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
      context: {
        mode: contexts.every((c) => c.selection.mode === 'all') ? 'all' : 'retrieved',
        tables: contexts.reduce((n, c) => n + c.selection.keys.length, 0),
        totalTables: contexts.reduce((n, c) => n + c.selection.totalTables, 0),
        schemaTokens
      },
      usage,
      autoRun: deps.settings.autoRun && explained && !warnings.length,
      ...(across ? { database: refOf(db) } : {}),
      ...(ranQueries.length ? { queries: ranQueries } : {}),
      ...(memories.length ? { memories } : {}),
      ...(warnings.length ? { warnings } : {}),
      privacy: provider.report(sealed)
    }
  }

  /** The database a tool call names; with one database, that one. A string is the error to send back. */
  const dbFor = (args: Record<string, unknown>): AgentDatabase | string => {
    if (!across) return dbs[0]
    const key = String(args.database ?? '').trim()
    return dbs.find((d) => d.key === key) ?? `Unknown database "${key}". Use one of: ${dbs.map((d) => `"${d.key}"`).join(', ')}.`
  }
  const contextOf = (db: AgentDatabase) => contexts.find((c) => c.db === db)!

  /**
   * Runs one read-only query for the model to read: checked, restored for this database, and its result sent back as
   * a short table with every value protected with its column as context, like sample values.
   */
  const readQuery = async (db: AgentDatabase, raw: string, step: ReturnType<Progress['start']>): Promise<{ content: string; structured?: boolean }> => {
    const gate = checkReadOnlySql(raw)
    if (!gate.ok) {
      step.fail(shownText(gate.reason))
      return { content: `${gate.reason} Send one read-only SELECT.` }
    }
    const restored = provider.restoreSql(gate.sql, db.kind)
    if (restored.unknown.length || restored.damaged.length) {
      const bad = [...new Set([...restored.unknown, ...restored.damaged])].slice(0, 5)
      step.fail('a placeholder that matches nothing')
      return { content: `The query uses placeholders that do not match any protected value: ${bad.join(', ')}. Copy each one exactly as it appears, including the <| and |>.` }
    }
    if (restored.withheld) {
      step.fail('refers to a value withheld from the model')
      return { content: 'The query refers to a value you were never shown in full, so it cannot run. Use another column to find the records.' }
    }
    const gate2 = checkReadOnlySql(restored.text)
    if (!gate2.ok) {
      step.fail(gate2.reason)
      return { content: `${gate2.reason} Send one read-only SELECT.` }
    }
    let message: string | null = null
    let first: QueryResponse['results'][number] | undefined
    try {
      first = (await db.runQuery(restored.text, RESULT_ROWS + 1)).results.find((r) => r.kind === 'rows' || r.kind === 'error')
      if (!first) message = 'The statement returned no rows.'
      else if (first.kind === 'error') message = first.message
    } catch (e: any) {
      message = e?.message ?? String(e)
    }
    if (message !== null || !first || first.kind !== 'rows') {
      ranQueries.push({ database: refOf(db), sql: restored.text, error: message ?? 'No rows.' })
      step.fail(shownText(message ?? 'no rows'))
      return { content: `The database rejected the query: ${message}` }
    }
    const rows = first.rows.slice(0, RESULT_ROWS)
    const cells = rows.map((r) => r.map((v) => (v === null ? 'NULL' : safeSlice(cellToPlainText(v).replace(/\s*\n\s*/g, ' '), 200))))
    if (privacy) {
      privacy.useSchema(identifiers())
      for (let c = 0; c < first.columns.length; c++) {
        const at = cells.map((r, i) => (r[c] === 'NULL' ? -1 : i)).filter((i) => i >= 0)
        if (!at.length) continue
        const column = first.columns[c]
        const safe = await privacy.protectValues({ column: column.name, declaredType: column.declType }, at.map((i) => cells[i][c]), 'query results')
        at.forEach((i, k) => (cells[i][c] = safe[k]))
      }
    }
    // As many rows as fit: wide ones show fewer.
    const lines: string[] = []
    let size = 0
    for (const r of cells) {
      const line = r.join(' | ')
      if (lines.length && size + line.length > RESULT_CHARS) break
      lines.push(line)
      size += line.length + 1
    }
    const more = first.rows.length > lines.length || first.truncated
    ranQueries.push({ database: refOf(db), sql: restored.text, rows: rows.length })
    step.done(`${rows.length}${first.rows.length > RESULT_ROWS || first.truncated ? '+' : ''} row${rows.length === 1 ? '' : 's'}`)
    const head = `${lines.length} row${lines.length === 1 ? '' : 's'} from "${db.key}"${more ? ', more not shown: narrow the query or select fewer columns' : ''}:`
    return { content: [head, first.columns.map((c) => c.name).join(' | '), ...lines].join('\n'), structured: true }
  }

  const runTool = async (call: ToolCall): Promise<{ content: string; structured?: boolean }> => {
    usage.toolCalls++
    const args = call.args ?? {}
    if (call.name === 'remember') {
      const fact = shownText(String(args.fact ?? '')).replace(/\s+/g, ' ').trim()
      if (!fact) return { content: 'Give the fact to remember.' }
      const key = String(args.database ?? '')
      const about = across ? (key === 'all' ? [] : dbs.filter((d) => d.key === key)) : dbs.slice(0, 1)
      const connectionIds = about.flatMap((d) => (d.connectionId ? [d.connectionId] : []))
      if (!memories.some((m) => m.fact === fact)) memories.push({ fact: safeSlice(fact, 500), connectionIds })
      progress.note('tool', 'Model offered to remember something', safeSlice(fact, 120))
      return { content: 'Offered to the user, who decides whether to keep it. Carry on.' }
    }
    const named = call.name === 'search_schema' || call.name === 'describe_table' || call.name === 'sample_values' || call.name === 'run_query'
    const target = named ? dbFor(args) : dbs[0]
    if (typeof target === 'string') {
      progress.note('tool', 'Model named a database that is not in the chat', String(args.database ?? ''))
      return { content: target }
    }
    const db = target
    const ctx = contextOf(db)
    /** " in Orders" in a chat across databases. */
    const inDb = across ? ` in ${db.name}` : ''
    if (call.name === 'run_query') {
      if (!db.readResults) {
        progress.note('tool', `Model asked to read results on ${db.name}, which the settings do not allow`)
        return { content: `Results cannot be read on ${across ? `"${db.key}"` : 'this database'}: write the query for the user to run instead.` }
      }
      const purpose = shownText(String(args.purpose ?? '')).trim()
      const step = progress.start('query', `Queried ${db.name}${purpose ? `: ${safeSlice(purpose, 80)}` : ''}`)
      return readQuery(db, String(args.sql ?? ''), step)
    }
    if (call.name === 'search_schema') {
      const query = shownText(String(args.query ?? ''))
      const step = progress.start('tool', across ? `Model searched ${db.name} for "${query}"` : `Model searched the schema for "${query}"`)
      const lines = await db.index.search(query, 10, ctx.shown, privacy ? (keys) => viewFor(deps, db, keys) as Promise<RenderView> : undefined)
      for (const l of lines) ctx.shown.add(l.slice(0, l.indexOf('(')))
      step.done(lines.length ? `${lines.length} table${lines.length === 1 ? '' : 's'}` : 'nothing new')
      return { content: lines.length ? lines.join('\n') : 'No further tables match. The excerpt already shows every relevant table.', structured: true }
    }
    if (call.name === 'describe_table') {
      const name = shownText(String(args.table ?? ''))
      const step = progress.start('tool', `Model asked to describe ${name}${inDb}`)
      const t = db.index.find(name)
      if (!t) {
        step.fail('unknown table')
        return { content: `Unknown table: ${name}. Use search_schema to find the right name.`, structured: true }
      }
      await db.index.ensureColumns([t.key])
      if (deps.settings.sendSampleValues) await loadSamples(deps, db, [t.key])
      const text = await db.index.describe(t.key, await viewFor(deps, db, [t.key]))
      ctx.shown.add(t.key)
      step.done(`${t.meta?.columns.length ?? 0} columns`)
      return { content: text, structured: true }
    }
    if (call.name === 'sample_values') {
      const table = shownText(String(args.table ?? ''))
      const column = shownText(String(args.column ?? ''))
      const step = progress.start('tool', `Model asked for sample values of ${table}.${column}${inDb}`)
      const t = db.index.find(table)
      if (t) await db.index.ensureColumns([t.key])
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
        const values = await db.distinctValues(t.ref, column)
        privacy?.useSchema(identifiers())
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
    const res = await complete((across || investigating) && step === maxSteps - 1)
    lastText = res.text
    let calls = res.toolCalls
    if (!calls.length) {
      const parsed = parseJsonObject(res.text)
      if (parsed && (typeof parsed.sql === 'string' || typeof parsed.needs_clarification === 'string')) {
        calls = [{ id: 'json', name: 'propose_query', args: parsed }]
      } else if (res.text.trim()) {
        progress.note('done', investigating ? 'Answered' : 'Model answered in words, without a query')
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
      const target = dbFor(proposal.args)
      const db = typeof target === 'string' ? dbs[0] : target
      const checking = progress.start('check', across ? `Checking the query for ${db.name} is read-only and valid` : 'Checking the query is read-only and valid')
      // The model's SQL is checked in its own terms, then restored for its database and checked again.
      const gate = checkReadOnlySql(p.sql)
      let problem: string | null = typeof target === 'string' ? target : gate.ok ? null : gate.reason
      const tokenizedSql = gate.ok ? gate.sql : p.sql
      const restored = provider.restoreSql(tokenizedSql, db.kind)
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
          const res2 = await db.runQuery(explainStatement(db.kind, restored.text), 50)
          const first = res2.results[0]
          if (first && first.kind === 'error') problem = `The database rejected the query: ${first.message}`
          else explained = true
        } catch (e: any) {
          problem = `The database rejected the query: ${e?.message ?? e}`
        }
      }
      if (!problem) {
        checking.done('EXPLAIN passed')
        return finish(p, tokenizedSql, restored, db)
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
  return clarify(
    safeSlice(lastText.trim(), MAX_PROSE_CHARS),
    across
      ? 'The model used every step it has without finishing. Ask about one part at a time, or name the databases and tables you mean.'
      : 'The model kept exploring the schema without proposing a query. Try naming the tables you mean.'
  )
}

export function questionTerms(question: string): string[] {
  return tokenize(question)
}
