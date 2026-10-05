// Working a question out on one database: where the user lets Ask read results, the model runs read-only queries,
// reads them, and answers with what it found, instead of asking for what it can look up. It keeps what it learns, in
// the reply it sends anyway. Elsewhere it writes queries without seeing their results.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeResultsAccess, readsResults, withResultsFor, type AiProgressStep, type AiTurn } from '../src/shared/ai'
import type { CellValue, QueryResponse, SchemaInfo } from '../src/shared/types'
import { askDatabase, type AskDeps } from '../src/main/ai/nl2sql'
import { SchemaIndex } from '../src/main/ai/schema-index'
import { ModelGateway } from '../src/main/privacy/gateway'
import { PrivacyEngine } from '../src/main/privacy/engine'
import { PrivacySession } from '../src/main/privacy/session'
import { PiiVault } from '../src/main/privacy/vault'
import type { ChatRequest } from '../src/main/ai/providers/types'
import { LAST_REQUEST } from '../src/main/ai/prompt'
import { KnowledgeBook } from '../src/main/knowledge/book'
import { KnowledgeStore } from '../src/main/knowledge/store'
import { policy, recordingProvider, reply, wireText, type Script } from './privacy/helpers'

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

const column = (cid: number, name: string, type: string, pk = 0) => ({ cid, name, type, notnull: false, dflt: null, pk, hidden: 0 })
const schema: SchemaInfo = {
  kind: 'sqlite',
  tables: [
    {
      name: 'auto_enroll_programs',
      type: 'table',
      sql: null,
      columns: [column(0, 'auto_program_id', 'TEXT', 1), column(1, 'program_name', 'TEXT'), column(2, 'owner_email', 'TEXT'), column(3, 'is_active', 'INTEGER')],
      withoutRowid: false,
      rowidAlias: 'rowid',
      pk: ['auto_program_id']
    }
  ],
  views: [],
  indexes: [],
  triggers: [],
  relations: []
}

const rows = (sql: string, columns: string[], data: CellValue[][]): QueryResponse => ({
  results: [{ kind: 'rows', sql, columns: columns.map((name) => ({ name })), rows: data, rowCount: data.length, truncated: false, durationMs: 1 }],
  durationMs: 1,
  tx: false
})

function setup(script: Script, readResults: boolean, book?: KnowledgeBook) {
  const ran: string[] = []
  const steps: AiProgressStep[] = []
  const provider = recordingProvider(script)
  const session = new PrivacySession({ engine: new PrivacyEngine({ schemaDetection: true }), policy, vault: new PiiVault(), host: 'api.example.com' })
  const deps: AskDeps = {
    kind: 'sqlite',
    serverVersion: '3.45.1',
    index: SchemaIndex.fromSchema(schema, 'sqlite'),
    provider: ModelGateway.protected(provider, session),
    settings: { sendSampleValues: false, autoRun: true, schemaBudgetTokens: 8000 },
    readResults,
    connectionId: 'c1',
    ...(book ? { knowledge: book } : {}),
    now: new Date('2026-10-01T12:00:00Z'),
    runQuery: async (sql) => {
      ran.push(sql)
      return /EXPLAIN/.test(sql)
        ? rows(sql, [], [])
        : rows(sql, ['auto_program_id', 'program_name', 'owner_email', 'is_active'], [
            ['LP23090020343724', 'Bullseye', 'ann@corp.io', 1],
            ['LP21010010000001', 'Bullseye (2021)', 'zed@corp.io', 0]
          ])
    },
    distinctValues: async () => null,
    onProgress: (s) => steps.push(s)
  }
  return { deps, requests: provider.requests, ran, steps }
}

const system = (req: ChatRequest) => req.system.map((b) => b.text).join('\n\n')
const lastTool = (req: ChatRequest) => [...req.messages].reverse().find((m) => m.role === 'tool')

describe('working a question out on one database', () => {
  it('looks things up itself, reads the results, and answers with what it found, keeping what it learned on the way', async () => {
    const { store, book } = knowledge()
    const f = setup((req, call) => {
      if (call === 1) {
        return reply({
          toolCalls: [{ id: 't1', name: 'run_query', args: { sql: "SELECT auto_program_id, program_name, owner_email, is_active FROM auto_enroll_programs WHERE program_name LIKE '%Bullseye%'", purpose: 'the Bullseye programs' } }],
          stopReason: 'tool_calls'
        })
      }
      // It sees the rows, with the owners' emails protected, and answers, keeping what it found in the same reply.
      const seen = lastTool(req)!.content
      expect(seen).toContain('LP23090020343724 | Bullseye')
      expect(seen).not.toContain('ann@corp.io')
      return reply({
        text: "**Bullseye** is `LP23090020343724`, the active one; the 2021 program is inactive. I assumed you meant this year's October.",
        toolCalls: [
          {
            id: 't2',
            name: 'learn',
            args: { kind: 'term', name: 'Bullseye', meaning: 'The active marketing program of that name.', sql: "auto_enroll_programs.auto_program_id = 'LP23090020343724'", tables: ['auto_enroll_programs'], source: 'data' }
          }
        ],
        stopReason: 'tool_use'
      })
    }, true, book)
    const result = await askDatabase(f.deps, 'Are we ready for Bullseye October spawning?')

    const rules = system(f.requests[0])
    expect(rules).toContain('by working them out yourself')
    expect(rules).toContain('Find things out before you ask: look up names, ids and codes in the data (run_query)')
    expect(rules).toContain('Do not hand back queries for the user to run instead.')
    expect(f.requests[0].tools!.map((t) => t.name)).toEqual(['propose_query', 'search_schema', 'describe_table', 'sample_values', 'run_query', 'learn', 'save_query', 'run_saved_query'])
    expect(f.ran).toEqual([
      "SELECT auto_program_id, program_name, owner_email, is_active FROM auto_enroll_programs WHERE program_name LIKE '%Bullseye%'",
      // The term's SQL is checked against its table before it is kept.
      "EXPLAIN QUERY PLAN SELECT 1 FROM \"auto_enroll_programs\" WHERE auto_enroll_programs.auto_program_id = 'LP23090020343724'"
    ])
    expect(wireText(f.requests)).not.toMatch(/ann@corp\.io|zed@corp\.io/)
    // Two requests: the learning came with the answer, so nothing was spent on telling the model it was kept.
    expect(f.requests).toHaveLength(2)

    expect(result).toMatchObject({
      kind: 'clarify',
      message: expect.stringContaining('`LP23090020343724`, the active one'),
      queries: [{ database: { connectionId: 'c1', name: 'this database' }, rows: 2 }],
      learned: [{ kind: 'term', connectionId: 'c1', name: 'Bullseye', meaning: 'The active marketing program of that name.' }]
    })
    const kept = (await store.get('c1')).facts
    expect(kept).toMatchObject([{ kind: 'term', name: 'Bullseye', sql: "auto_enroll_programs.auto_program_id = 'LP23090020343724'", tables: ['auto_enroll_programs'], source: 'data', confidence: 0.8 }])
    expect(f.steps).toContainEqual(expect.objectContaining({ stage: 'query', status: 'done', message: 'Queried this database: the Bullseye programs', detail: '2 rows' }))
    expect(f.steps).toContainEqual(expect.objectContaining({ stage: 'knowledge', message: 'Learned "Bullseye"' }))
    expect(f.steps).toContainEqual(expect.objectContaining({ stage: 'done', message: 'Answered' }))
  })

  it('keeps to its request budget, and answers with what it has at the last', async () => {
    const f = setup(() => reply({ toolCalls: [{ id: 't', name: 'run_query', args: { sql: 'SELECT auto_program_id FROM auto_enroll_programs' } }], stopReason: 'tool_calls' }), true)
    await askDatabase(f.deps, 'Check everything')
    expect(f.requests).toHaveLength(6)
    expect(f.requests[5].toolChoice).toBe('none')
    expect(f.requests[4].toolChoice).toBe('auto')
    // The last says so at the end, where it leaves the conversation before it as it was, for the provider's cache.
    expect(f.requests[5].messages.at(-1)).toEqual({ role: 'user', content: LAST_REQUEST })
    expect(f.requests[4].messages.at(-1)!.role).toBe('tool')
    expect(f.steps).toContainEqual(expect.objectContaining({ stage: 'request', message: 'Asking mock-1 (request 6 of 6)' }))

    const fewer = setup(() => reply({ toolCalls: [{ id: 't', name: 'run_query', args: { sql: 'SELECT 1' } }], stopReason: 'tool_calls' }), true)
    fewer.deps.settings.maxRequests = 3
    await askDatabase(fewer.deps, 'Check everything')
    expect(fewer.requests).toHaveLength(3)
  })

  it('writes queries without reading results where the user has not allowed it, and still looks before asking', async () => {
    const f = setup(
      (req, call) =>
        call === 1
          ? reply({ toolCalls: [{ id: 't1', name: 'run_query', args: { sql: 'SELECT * FROM auto_enroll_programs' } }], stopReason: 'tool_calls' })
          : reply({ toolCalls: [{ id: 'p', name: 'propose_query', args: { sql: "SELECT auto_program_id FROM auto_enroll_programs WHERE program_name LIKE '%Bullseye%'", explanation: 'The Bullseye programs.', tables_used: ['auto_enroll_programs'] } }], stopReason: 'tool_calls' }),
      false
    )
    const result = await askDatabase(f.deps, 'Which program is Bullseye?')
    const rules = system(f.requests[0])
    expect(rules).toContain('You translate questions about a database into one read-only SQL query')
    expect(rules).toContain('look up names, ids and codes in the schema and its sample values')
    expect(rules).toContain('say once that you could check it yourself if the user lets Ask read results on this database')
    expect(rules).toContain('Set needs_clarification only when the question cannot be answered without the user.')
    expect(f.requests[0].tools!.map((t) => t.name)).toEqual(['propose_query', 'search_schema', 'describe_table', 'sample_values'])
    expect(lastTool(f.requests[1])!.content).toBe('Results cannot be read on this database: write the query for the user to run instead.')
    expect(f.ran.every((sql) => sql.startsWith('EXPLAIN'))).toBe(true)
    expect(result.kind).toBe('query')
  })

  it('sees what an earlier answer’s query returned in the editor, protected, only where results may be read', async () => {
    const history: AiTurn[] = [
      {
        question: 'Which programs are called Bullseye?',
        sql: "SELECT auto_program_id, owner_email FROM auto_enroll_programs WHERE program_name LIKE '%Bullseye%'",
        result: { columns: ['auto_program_id', 'owner_email'], rows: [['prog-2023-be', 'ann@corp.io'], ['prog-2021-be', null]], rowCount: 2 }
      }
    ]
    const reading = setup(() => reply({ text: 'The first one, prog-2023-be: it is the active program.' }), true)
    await askDatabase(reading.deps, 'Which one do you think it is?', history)
    const said = reading.requests[0].messages[1].content
    expect(said).toContain('When it ran in the editor, it returned 2 rows:')
    expect(said).toContain('prog-2023-be | <|PII:EMAIL:')
    expect(said).toContain('prog-2021-be | NULL')
    expect(wireText(reading.requests)).not.toContain('ann@corp.io')

    const writing = setup(() => reply({ text: 'Run the query to see.' }), false)
    await askDatabase(writing.deps, 'Which one do you think it is?', history)
    expect(writing.requests[0].messages[1].content).not.toContain('When it ran in the editor')
    expect(wireText(writing.requests)).not.toContain('prog-2021-be')
  })
})

describe('where Ask may read results', () => {
  it('is none until chosen, every connection, or the ones chosen', () => {
    expect(normalizeResultsAccess(true)).toEqual({ scope: 'selected', connectionIds: [] })
    expect(normalizeResultsAccess({ scope: 'all', connectionIds: ['c1', 'c1', 3] })).toEqual({ scope: 'all', connectionIds: ['c1'] })
    const none = normalizeResultsAccess(undefined)
    expect(readsResults(none, 'c1')).toBe(false)
    const one = withResultsFor(none, 'c1', true, ['c1', 'c2', 'c3'])
    expect(one).toEqual({ scope: 'selected', connectionIds: ['c1'] })
    expect([readsResults(one, 'c1'), readsResults(one, 'c2'), readsResults(one, undefined)]).toEqual([true, false, false])
    // Leaving one out of every connection lists the others.
    expect(withResultsFor({ scope: 'all', connectionIds: [] }, 'c2', false, ['c1', 'c2', 'c3'])).toEqual({ scope: 'selected', connectionIds: ['c1', 'c3'] })
    expect(withResultsFor(one, 'c1', false, ['c1'])).toEqual({ scope: 'selected', connectionIds: [] })
  })
})
