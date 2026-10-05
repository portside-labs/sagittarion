// Asking in the business's words: what is known reaches the model and points it at the right tables; what it learns is
// kept without asking and without spending requests on it; the runbook turns earlier answers into queries to call;
// and what the user said holds. The model is scripted, and every request is checked as it would leave.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AiProgressStep } from '../../src/shared/ai'
import type { CellValue, QueryResponse, Relation, SchemaInfo, TableMeta } from '../../src/shared/types'
import { askDatabase, hideTitle, splitTitle, type AskDeps } from '../../src/main/ai/nl2sql'
import { SchemaIndex } from '../../src/main/ai/schema-index'
import { TITLE_REQUEST } from '../../src/main/ai/prompt'
import type { ChatRequest } from '../../src/main/ai/providers/types'
import { ModelGateway } from '../../src/main/privacy/gateway'
import { PrivacyEngine } from '../../src/main/privacy/engine'
import { PrivacySession } from '../../src/main/privacy/session'
import { PiiVault } from '../../src/main/privacy/vault'
import { KnowledgeBook } from '../../src/main/knowledge/book'
import { KnowledgeStore } from '../../src/main/knowledge/store'
import { policy, recordingProvider, reply, wireText, type Script } from '../privacy/helpers'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function knowledge(): { store: KnowledgeStore; book: KnowledgeBook } {
  const dir = mkdtempSync(path.join(tmpdir(), 'knowledge-'))
  dirs.push(dir)
  const store = new KnowledgeStore(dir, 5)
  return { store, book: new KnowledgeBook(store, 'c1') }
}

const col = (cid: number, name: string, type = 'TEXT', pk = 0) => ({ cid, name, type, notnull: false, dflt: null, pk, hidden: 0 })
const table = (name: string, columns: string[]): TableMeta => ({
  name,
  type: 'table',
  sql: null,
  columns: columns.map((c, i) => col(i, c, i === 0 ? 'INTEGER' : 'TEXT', i === 0 ? 1 : 0)),
  withoutRowid: false,
  rowidAlias: 'rowid',
  pk: [columns[0]]
})

/** Programs and their jobs among sixty other tables: more than a small schema budget shows at once. */
function schema(): SchemaInfo {
  const relations: Relation[] = [{ table: 'sys_jobs', column: 'program_id', refTable: 'auto_enroll_programs', refColumn: 'auto_program_id' }]
  return {
    kind: 'sqlite',
    tables: [
      table('auto_enroll_programs', ['auto_program_id', 'program_name', 'owner_email', 'is_active']),
      table('sys_jobs', ['id', 'program_id', 'job_type', 'status', 'created_ts']),
      ...Array.from({ length: 60 }, (_, i) => table(`ledger_entry_${i}`, ['id', 'account', 'amount', 'posted_at', 'memo']))
    ],
    views: [],
    indexes: [],
    triggers: [],
    relations
  }
}

const rows = (sql: string, columns: string[], data: CellValue[][]): QueryResponse => ({
  results: [{ kind: 'rows', sql, columns: columns.map((name) => ({ name })), rows: data, rowCount: data.length, truncated: false, durationMs: 1 }],
  durationMs: 1,
  tx: false
})

function setup(script: Script, opts: { book?: KnowledgeBook; readResults?: boolean; budget?: number; title?: boolean } = {}) {
  const ran: string[] = []
  const steps: AiProgressStep[] = []
  const provider = recordingProvider(script)
  const session = new PrivacySession({ engine: new PrivacyEngine({ schemaDetection: true }), policy, vault: new PiiVault(), host: 'api.example.com' })
  const deps: AskDeps = {
    kind: 'sqlite',
    serverVersion: '3.45.1',
    index: SchemaIndex.fromSchema(schema(), 'sqlite'),
    provider: ModelGateway.protected(provider, session),
    settings: { sendSampleValues: false, autoRun: true, schemaBudgetTokens: opts.budget ?? 8000 },
    readResults: opts.readResults ?? false,
    connectionId: 'c1',
    ...(opts.book ? { knowledge: opts.book } : {}),
    ...(opts.title ? { title: true } : {}),
    now: new Date('2026-10-05T12:00:00Z'),
    runQuery: async (sql) => {
      ran.push(sql)
      return /^EXPLAIN/.test(sql) ? rows(sql, [], []) : rows(sql, ['status', 'n'], [['ok', 41], ['failed', 2]])
    },
    distinctValues: async () => null,
    onProgress: (s) => steps.push(s)
  }
  return { deps, requests: provider.requests, ran, steps }
}

const system = (req: ChatRequest) => req.system.map((b) => b.text).join('\n\n')
const knowledgeBlock = (req: ChatRequest) => req.system.find((b) => (b as { label?: string }).label === 'the business knowledge')?.text ?? ''
const lastTool = (req: ChatRequest) => [...req.messages].reverse().find((m) => m.role === 'tool')

describe('asking in business terms', () => {
  it('puts the tables a term lives in before the model, though the question names none, with what the team means', async () => {
    const { store, book } = knowledge()
    await book.learn({
      kind: 'term',
      name: 'Bullseye',
      meaning: 'The October auto-enrol marketing program.',
      sql: "auto_enroll_programs.program_name = 'Bullseye'",
      tables: ['auto_enroll_programs'],
      source: 'user'
    })
    const f = setup(
      () =>
        reply({
          toolCalls: [
            {
              id: 'p',
              name: 'propose_query',
              args: {
                sql: "SELECT j.status, count(*) FROM sys_jobs j JOIN auto_enroll_programs p ON p.auto_program_id = j.program_id WHERE p.program_name = 'Bullseye' AND j.created_ts >= '2026-06-01' GROUP BY 1",
                explanation: 'Bullseye jobs by status since June.',
                tables_used: ['sys_jobs', 'auto_enroll_programs']
              }
            }
          ],
          stopReason: 'tool_use'
        }),
      { book, budget: 400 }
    )
    const result = await askDatabase(f.deps, 'How have the Bullseye marketing program jobs performed since June?')
    const first = f.requests[0]
    // The schema is cut to fit, and the term's table is in it all the same.
    expect(system(first)).toMatch(/## Schema excerpt \(\d+ of 62 tables/)
    expect(system(first)).toContain('auto_enroll_programs(auto_program_id int pk')
    expect(knowledgeBlock(first)).toContain(`- "Bullseye", told by the user: The October auto-enrol marketing program. SQL: auto_enroll_programs.program_name = 'Bullseye'`)
    // The knowledge comes after the schema, which stays cached from one question to the next.
    expect(first.system.findIndex((b) => b.text.includes('## Schema')) < first.system.findIndex((b) => b.text.includes('## What this team means'))).toBe(true)
    expect(system(first)).toContain('Read the question against "What this team means" first')
    expect(system(first)).toContain('Never ask the user to confirm something you know or can look up')
    expect(f.steps).toContainEqual(expect.objectContaining({ stage: 'knowledge', status: 'done', message: 'Recalling what this team means', detail: '1 term' }))
    expect(result.kind).toBe('query')
    // The answer was built on the term: used once more; and run in the editor, it would count for more.
    const k = await store.get('c1')
    expect(k.facts[0].uses).toBe(1)
    await book.editorRun(result.kind === 'query' ? result.sql : '', true)
    expect((await store.get('c1')).facts[0].uses).toBe(2)
    expect((await store.get('c1')).queries[0]).toMatchObject({ by: 'user', question: 'How have the Bullseye marketing program jobs performed since June?' })
  })

  it('learns from what the user runs: a name they filtered on leads the next question to its table', async () => {
    const { book } = knowledge()
    await book.editorRun("SELECT * FROM auto_enroll_programs WHERE program_name = 'October Push'", true, SchemaIndex.fromSchema(schema(), 'sqlite'))
    const f = setup(() => reply({ text: 'It ran twice.' }), { book, budget: 400 })
    await askDatabase(f.deps, 'How did October Push go?')
    expect(knowledgeBlock(f.requests[0])).toContain("- 'October Push' in auto_enroll_programs.program_name")
    expect(system(f.requests[0])).toContain('auto_enroll_programs(')
  })
})

describe('keeping what is learned', () => {
  it('keeps a term and saves a query with the answer, in the same reply: no request is spent on it', async () => {
    const { store, book } = knowledge()
    const f = setup(
      (req, call) => {
        if (call === 1) return reply({ toolCalls: [{ id: 't1', name: 'run_query', args: { sql: "SELECT status, count(*) FROM sys_jobs WHERE program_id = 7 AND created_ts >= '2026-06-01' GROUP BY 1", purpose: 'jobs by status' } }], stopReason: 'tool_use' })
        return reply({
          text: 'Since June, 41 jobs ran and 2 failed.',
          toolCalls: [
            { id: 'l', name: 'learn', args: { kind: 'domain', name: 'Marketing > Programs', meaning: 'Programs and the jobs that enroll their members.', tables: ['auto_enroll_programs', 'sys_jobs', 'nope'], source: 'inferred' } },
            {
              id: 's',
              name: 'save_query',
              args: {
                name: 'Program jobs by status',
                purpose: 'How a program’s jobs went since a date',
                sql: 'SELECT status, count(*) FROM sys_jobs WHERE program_id = :program AND created_ts >= :since GROUP BY 1',
                params: [
                  { name: 'program', description: 'the program id', example: '7' },
                  { name: 'since', example: '2026-06-01' }
                ]
              }
            }
          ],
          stopReason: 'tool_use'
        })
      },
      { book, readResults: true }
    )
    const result = await askDatabase(f.deps, 'How did program 7 do since June?')
    expect(f.requests).toHaveLength(2)
    expect(result).toMatchObject({
      kind: 'clarify',
      message: 'Since June, 41 jobs ran and 2 failed.',
      learned: [
        { kind: 'domain', id: 'Marketing › Programs', connectionId: 'c1', name: 'Marketing › Programs' },
        { kind: 'query', id: 'q1', connectionId: 'c1', name: 'Program jobs by status' }
      ]
    })
    // Checked as it would run before it was kept, with its values in this question.
    expect(f.ran).toContain("EXPLAIN QUERY PLAN SELECT status, count(*) FROM sys_jobs WHERE program_id = 7 AND created_ts >= '2026-06-01' GROUP BY 1")
    const k = await store.get('c1')
    expect(k.domains).toMatchObject([{ path: 'Marketing › Programs', tables: ['auto_enroll_programs', 'sys_jobs'], source: 'inferred' }])
    // The same query ran in this ask and returned rows: checked in the data.
    expect(k.runbook).toMatchObject([{ id: 'q1', params: [{ name: 'program', description: 'the program id', example: '7' }, { name: 'since', example: '2026-06-01' }], source: 'data', questions: ['How did program 7 do since June?'] }])
    // What the model ran is counted, by its shape.
    expect(k.queries).toMatchObject([{ by: 'model', count: 1, tables: ['sys_jobs'] }])
  })

  it('runs a runbook query with values bound in, real ones in place of placeholders, and counts the run', async () => {
    const { store, book } = knowledge()
    await book.keep({
      name: 'Programs a person owns',
      purpose: 'The programs someone owns, active or not',
      sql: 'SELECT program_name, is_active FROM auto_enroll_programs WHERE owner_email = :owner ORDER BY program_name',
      params: [{ name: 'owner', description: 'their email' }],
      tables: ['auto_enroll_programs'],
      source: 'user'
    })
    const f = setup(
      (req, call) => {
        if (call === 1) {
          expect(knowledgeBlock(req)).toContain('- q1 "Programs a person owns" (owner: their email): The programs someone owns, active or not')
          const owner = /<\|PII:EMAIL:[0-9A-F]{6}\|>/.exec(String(req.messages.at(-1)!.content))![0]
          return reply({ toolCalls: [{ id: 'r', name: 'run_saved_query', args: { id: 'Q1', values: [{ name: 'owner', value: owner }] } }], stopReason: 'tool_use' })
        }
        expect(lastTool(req)!.content).toContain('2 rows from "main"')
        return reply({ text: 'They own two programs; one failed twice.' })
      },
      { book, readResults: true }
    )
    await askDatabase(f.deps, 'Which programs does ann@corp.io own?')
    expect(f.ran).toEqual(["SELECT program_name, is_active FROM auto_enroll_programs WHERE owner_email = 'ann@corp.io' ORDER BY program_name"])
    expect(wireText(f.requests)).not.toContain('ann@corp.io')
    expect(f.steps).toContainEqual(expect.objectContaining({ stage: 'query', status: 'done', message: 'Ran "Programs a person owns" from the runbook' }))
    expect((await store.get('c1')).runbook[0]).toMatchObject({ runs: 1, questions: ['Which programs does ann@corp.io own?'] })
  })

  it('asks for the values a runbook query needs, and never runs one where results are not read', async () => {
    const { book } = knowledge()
    await book.keep({ name: 'Owned', purpose: 'Programs owned', sql: 'SELECT 1 FROM auto_enroll_programs WHERE owner_email = :owner', params: [{ name: 'owner' }], tables: [], source: 'user' })
    const f = setup(
      (req, call) =>
        call === 1
          ? reply({ toolCalls: [{ id: 'r', name: 'run_saved_query', args: { id: 'q1', values: [] } }], stopReason: 'tool_use' })
          : reply({ text: String(lastTool(req)!.content) }),
      { book, readResults: true }
    )
    expect(await askDatabase(f.deps, 'Owned programs?')).toMatchObject({ message: 'Give a value for owner.' })
    expect(f.ran).toEqual([])
    const g = setup(() => reply({ text: 'ok' }), { book })
    await askDatabase(g.deps, 'Owned programs?')
    expect(g.requests[0].tools!.map((t) => t.name)).toEqual(['propose_query', 'search_schema', 'describe_table', 'sample_values', 'learn', 'save_query'])
    expect(knowledgeBlock(g.requests[0])).toContain('Runbook (use the SQL in propose_query, with the values filled in):')
  })

  it('goes by what the user said over what the model reads in the data, and says so to the model', async () => {
    const { store, book } = knowledge()
    await book.learn({ kind: 'term', name: 'Bullseye', meaning: 'The 2023 program.', sql: "auto_enroll_programs.auto_program_id = 'LP23'", tables: ['auto_enroll_programs'], source: 'user' })
    const f = setup(
      (req, call) =>
        call === 1
          ? reply({ toolCalls: [{ id: 'l', name: 'learn', args: { kind: 'term', name: 'bullseye', meaning: 'Any active program.', sql: 'auto_enroll_programs.is_active = 1', tables: ['auto_enroll_programs'], source: 'data' } }], stopReason: 'tool_use' })
          : reply({ text: 'Going by what you said.' }),
      { book }
    )
    const result = await askDatabase(f.deps, 'Is Bullseye on?')
    // Learning alone, with no answer yet: the reply that answers comes next.
    expect(f.requests).toHaveLength(2)
    expect(lastTool(f.requests[1])!.content).toBe('Not kept: the user said "Bullseye" means: The 2023 program. Go by that, and ask them only if the data says otherwise.')
    expect(result).not.toHaveProperty('learned')
    expect((await store.get('c1')).facts[0].meaning).toBe('The 2023 program.')
  })

  it('checks a term’s SQL against its table before keeping it', async () => {
    const { store, book } = knowledge()
    const f = setup(
      (req, call) =>
        call === 1
          ? reply({ text: 'Done.', toolCalls: [{ id: 'l', name: 'learn', args: { kind: 'term', name: 'live', meaning: 'Running programs.', sql: 'p.is_active = 1', tables: ['auto_enroll_programs'], source: 'inferred' } }], stopReason: 'tool_use' })
          : reply({ text: 'x' }),
      { book }
    )
    f.deps.runQuery = async (sql) => {
      f.ran.push(sql)
      return /p\.is_active/.test(sql) ? { results: [{ kind: 'error', sql, message: 'no such column: p.is_active', durationMs: 1 }], durationMs: 1, tx: false } : rows(sql, [], [])
    }
    await askDatabase(f.deps, 'What does live mean?')
    expect((await store.get('c1')).facts).toEqual([])
  })

  it('shows describe_table what is known about a table, read as prose', async () => {
    const { book } = knowledge()
    await book.learn({ kind: 'term', name: 'spawn', meaning: 'Jobs that create members.', sql: "sys_jobs.job_type = 'spawn'", tables: ['sys_jobs'], source: 'data' })
    const f = setup((req, call) => (call === 1 ? reply({ toolCalls: [{ id: 'd', name: 'describe_table', args: { table: 'sys_jobs' } }], stopReason: 'tool_use' }) : reply({ text: 'ok' })), { book })
    await askDatabase(f.deps, 'what is in the jobs table')
    const described = lastTool(f.requests[1])!
    expect(described.content).toContain(`terms: "spawn" (sys_jobs.job_type = 'spawn')`)
    expect(described.structured).toBeUndefined()
  })
})

describe('naming the conversation with its first answer', () => {
  it('asks for the name in the question, and takes it from the first line of a reply in words', async () => {
    const f = setup(() => reply({ text: 'Title: Bullseye Readiness\n\nEverything is ready.' }), { title: true })
    const result = await askDatabase(f.deps, 'Are we ready for Bullseye?')
    expect(String(f.requests[0].messages.at(-1)!.content).endsWith(TITLE_REQUEST)).toBe(true)
    expect(result).toMatchObject({ kind: 'clarify', title: 'Bullseye Readiness', message: 'Everything is ready.' })
    // Only on a conversation's first question.
    const later = setup(() => reply({ text: 'Title: Not one\n\nAnswer.' }))
    expect(await askDatabase(later.deps, 'And now?')).toMatchObject({ message: 'Title: Not one\n\nAnswer.' })
    expect(String(later.requests[0].messages.at(-1)!.content)).not.toContain('Name it for a small tab')
  })

  it('restores the name from placeholders, as it is shown here only', async () => {
    const f = setup(
      (req) => {
        const marker = /<\|PII:EMAIL:[0-9A-F]{6}\|>/.exec(JSON.stringify(req.messages))![0]
        return reply({ text: `Title: Refunds for ${marker}\n\nNo refund yet.` })
      },
      { title: true }
    )
    expect(await askDatabase(f.deps, 'Did zed@corp.io get his refund?')).toMatchObject({ title: 'Refunds for zed@corp.io', message: 'No refund yet.' })
    expect(wireText(f.requests)).not.toContain('zed@corp.io')
  })

  it('takes it from propose_query, and never shows a title line arriving in the stream', async () => {
    const f = setup(
      () =>
        reply({
          toolCalls: [{ id: 'p', name: 'propose_query', args: { sql: 'SELECT count(*) FROM sys_jobs', explanation: 'Counts jobs.', tables_used: ['sys_jobs'], title: '"Job Count."' } }],
          stopReason: 'tool_use'
        }),
      { title: true }
    )
    expect(await askDatabase(f.deps, 'How many jobs?')).toMatchObject({ kind: 'query', title: 'Job Count' })
    expect(hideTitle('Tit')).toBe('')
    expect(hideTitle('**Title:** Job Co')).toBe('')
    expect(hideTitle('Title: Job Count\nThere are')).toBe('There are')
    expect(hideTitle('There are 4')).toBe('There are 4')
    expect(splitTitle('Total: 4 jobs')).toEqual({ text: 'Total: 4 jobs' })
  })
})
