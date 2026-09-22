// The orchestrator: schema context in, one verified read-only query out.
import type { DatabaseKind, QueryResponse, TableRef } from '@shared/types'
import type { AiProgressStep, AiQueryResult, AiResult, AiTurn, AiUsage } from '@shared/ai'
import { checkReadOnlySql, explainStatement } from './guard'
import { isoDate, systemRules, TOOLS } from './prompt'
import { parseJsonObject, ProviderError, throwIfAborted, type ChatMessage, type ChatResponse, type LlmProvider, type ToolCall } from './providers/types'
import { estimateTokens, tokenize, type SchemaIndex } from './schema-index'
import type { EmbeddingCache } from './embeddings'

export interface AskDeps {
  kind: DatabaseKind
  serverVersion: string
  index: SchemaIndex
  provider: LlmProvider
  settings: { sendSampleValues: boolean; autoRun: boolean; schemaBudgetTokens: number; embeddingModel?: string }
  /** Runs SQL under the database's read-only guard. */
  runQuery: (sql: string, maxRows: number) => Promise<QueryResponse>
  /** Distinct values of a column, or null when there are too many to be useful. */
  distinctValues: (ref: TableRef, column: string) => Promise<string[] | null>
  embeddingCache?: EmbeddingCache
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
    const vectors = new Map<string, number[]>()
    const missing: { key: string; text: string }[] = []
    for (const key of index.tables.keys()) {
      const text = index.embeddingText(key)
      const cached = embeddingCache ? await embeddingCache.get(model, text) : undefined
      if (cached) vectors.set(key, cached)
      else missing.push({ key, text })
    }
    for (let i = 0; i < missing.length; i += 100) {
      const batch = missing.slice(i, i + 100)
      const embedded = await deps.provider.embed(
        batch.map((b) => b.text),
        deps.signal
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
    const [q] = await deps.provider.embed([question], deps.signal)
    return q && q.length ? q : null
  } catch (err) {
    if (err instanceof ProviderError && err.errorKind === 'cancelled') throw err
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

async function run(deps: AskDeps, question: string, history: AiTurn[], usage: AiUsage, progress: Progress): Promise<AiResult> {
  const { index, provider } = deps
  const fmt = new Intl.NumberFormat('en-US')

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
  const schemaText = index.render(selection, question)
  const header =
    selection.mode === 'all'
      ? `## Schema (all ${selection.totalTables} tables)\n`
      : `## Schema excerpt (${selection.keys.length} of ${selection.totalTables} tables; use search_schema for others)\n`
  const today = isoDate(deps.now ?? new Date())

  let toolsEnabled = true
  const messages: ChatMessage[] = []
  for (const turn of history.slice(-4)) {
    messages.push({ role: 'user', content: turn.question })
    messages.push({ role: 'assistant', content: `SQL used:\n${turn.sql}` })
  }
  messages.push({ role: 'user', content: question })

  const maxSteps = deps.maxToolSteps ?? 6
  const maxRepairs = deps.maxRepairs ?? 2
  let repairs = 0
  let explained = false

  const complete = async (): Promise<ChatResponse> => {
    throwIfAborted(deps.signal)
    const req = {
      system: [{ text: systemRules(deps.kind, deps.serverVersion, today, index.defaultSchema, toolsEnabled) }, { text: header + schemaText, cacheable: true }],
      messages,
      tools: toolsEnabled ? TOOLS : undefined,
      toolChoice: toolsEnabled ? ('auto' as const) : undefined
    }
    const asking = progress.start('request', `Asking ${provider.model || provider.kind}${usage.requests ? ` (request ${usage.requests + 1})` : ''}`)
    try {
      const res = await provider.complete(req, deps.signal)
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

  const finish = (p: Proposal, sql: string): AiQueryResult => {
    progress.note('done', 'Query ready', p.tablesUsed.length ? `uses ${p.tablesUsed.join(', ')}` : undefined)
    return {
      kind: 'query',
      sql,
      explanation: p.explanation,
      tablesUsed: p.tablesUsed,
      assumptions: p.assumptions,
      checks: { readOnly: true, explained, repairs },
      context: { mode: selection.mode, tables: selection.keys.length, totalTables: selection.totalTables, schemaTokens: estimateTokens(schemaText) },
      usage,
      autoRun: deps.settings.autoRun && explained
    }
  }

  const runTool = async (call: ToolCall): Promise<string> => {
    usage.toolCalls++
    const args = call.args ?? {}
    if (call.name === 'search_schema') {
      const query = String(args.query ?? '')
      const step = progress.start('tool', `Model searched the schema for "${query}"`)
      const lines = await index.search(query, 10, shown)
      for (const l of lines) shown.add(l.slice(0, l.indexOf('(')))
      step.done(lines.length ? `${lines.length} table${lines.length === 1 ? '' : 's'}` : 'nothing new')
      return lines.length ? lines.join('\n') : 'No further tables match. The excerpt already shows every relevant table.'
    }
    if (call.name === 'describe_table') {
      const name = String(args.table ?? '')
      const step = progress.start('tool', `Model asked to describe ${name}`)
      const t = index.find(name)
      if (!t) {
        step.fail('unknown table')
        return `Unknown table: ${name}. Use search_schema to find the right name.`
      }
      const text = await index.describe(t.key)
      if (deps.settings.sendSampleValues) await loadSamples(deps, [t.key])
      shown.add(t.key)
      step.done(`${t.meta?.columns.length ?? 0} columns`)
      return deps.settings.sendSampleValues ? await index.describe(t.key) : text
    }
    if (call.name === 'sample_values') {
      const table = String(args.table ?? '')
      const column = String(args.column ?? '')
      const step = progress.start('tool', `Model asked for sample values of ${table}.${column}`)
      const t = index.find(table)
      if (t) await index.ensureColumns([t.key])
      if (!t || !t.meta?.columns.some((c) => c.name === column)) {
        step.fail('unknown column')
        return `Unknown table or column: ${table}.${column}`
      }
      if (!deps.settings.sendSampleValues) {
        step.done('disabled in settings')
        return "Sample values are disabled in this app's settings; rely on the column type and the question instead."
      }
      try {
        const values = await deps.distinctValues(t.ref, column)
        const text = values ? (values.length ? values.slice(0, SAMPLE_LIMIT).join(' | ') : 'No values (column is empty or all NULL).') : 'Too many distinct values to list; treat the column as free text.'
        step.done(values ? `${values.length} value${values.length === 1 ? '' : 's'}` : 'too many values')
        return text
      } catch (e: any) {
        step.fail(e?.message ?? String(e))
        return `Could not sample: ${e?.message ?? e}`
      }
    }
    progress.note('tool', `Model called unknown tool ${call.name}`)
    return `Unknown tool ${call.name}.`
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
        progress.note('done', 'Model answered in prose instead of a query')
        return { kind: 'clarify', message: res.text.trim().slice(0, 800), usage }
      } else {
        progress.note('error', 'Model returned an empty answer')
        return { kind: 'clarify', message: 'The model returned an empty answer. Try rephrasing the question.', usage }
      }
    }
    const proposal = calls.find((c) => c.name === 'propose_query')
    if (proposal) {
      const p = readProposal(proposal.args)
      if (p.needsClarification && !p.sql.trim()) {
        progress.note('done', 'Model asked for clarification')
        return { kind: 'clarify', message: p.needsClarification, usage }
      }
      const checking = progress.start('check', 'Checking the query is read-only and valid')
      const gate = checkReadOnlySql(p.sql)
      let problem: string | null = gate.ok ? null : gate.reason
      const cleanSql = gate.ok ? gate.sql : p.sql
      if (!problem) {
        try {
          const res2 = await deps.runQuery(explainStatement(deps.kind, cleanSql), 50)
          const first = res2.results[0]
          if (first && first.kind === 'error') problem = `The database rejected the query: ${first.message}`
          else explained = true
        } catch (e: any) {
          problem = `The database rejected the query: ${e?.message ?? e}`
        }
      }
      if (!problem) {
        checking.done('EXPLAIN passed')
        return finish(p, cleanSql)
      }
      checking.fail(problem)
      if (repairs >= maxRepairs) {
        progress.note('error', 'Gave up after the repair limit')
        return { kind: 'clarify', message: `I could not produce a query the database accepts. Last attempt failed with: ${problem}`, usage }
      }
      repairs++
      explained = false
      progress.note('repair', `Sending the error back for a fix (${repairs} of ${maxRepairs})`)
      if (proposal.id !== 'json') {
        // Every tool call in the turn needs an answer, or the next request is rejected.
        messages.push({ role: 'assistant', content: res.text, toolCalls: calls })
        for (const call of calls) {
          const content = call === proposal ? `${problem}\nFix the query and call propose_query again. Use describe_table if unsure about a column.` : await runTool(call)
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content })
        }
      } else {
        messages.push({ role: 'assistant', content: res.text })
        messages.push({ role: 'user', content: `${problem}\nFix the query and answer again with the JSON object.` })
      }
      continue
    }
    // Information tools: answer each and loop.
    messages.push({ role: 'assistant', content: res.text, toolCalls: calls })
    for (const call of calls) messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: await runTool(call) })
  }
  progress.note('error', 'Model kept exploring without proposing a query')
  return { kind: 'clarify', message: lastText.trim() || 'The model kept exploring the schema without proposing a query. Try naming the tables you mean.', usage }
}

export function questionTerms(question: string): string[] {
  return tokenize(question)
}
