// How business knowledge changes: learned, confirmed, corrected, refused, used, forgotten; and how it is kept on disk.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { emptyKnowledge } from '../../src/shared/knowledge'
import { forgetLearned, keepInRunbook, learnDomain, learnFact, noteRunbookRun, recordQuery, reinforce } from '../../src/main/knowledge/learn'
import { KnowledgeStore, LIMITS, sanitizeKnowledge } from '../../src/main/knowledge/store'
import { KnowledgeBook, runFacts } from '../../src/main/knowledge/book'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'knowledge-'))
  dirs.push(dir)
  return dir
}

const term = (over: Partial<Parameters<typeof learnFact>[1]> = {}) => ({
  kind: 'term' as const,
  name: 'Bullseye',
  meaning: 'The marketing program members are auto-enrolled into in October.',
  sql: "auto_enroll_programs.program_name = 'Bullseye'",
  tables: ['auto_enroll_programs'],
  source: 'inferred' as const,
  ...over
})

describe('learning a term', () => {
  it('adds it, trusted as far as its source', () => {
    const k = emptyKnowledge()
    const out = learnFact(k, term({ source: 'data', question: 'How did Bullseye do?' }))
    expect(out.kind).toBe('added')
    expect(k.facts).toMatchObject([{ name: 'Bullseye', source: 'data', confidence: 0.8, uses: 0, learnedFrom: 'How did Bullseye do?' }])
  })

  it('confirms the same thing said again, in other words or by an alias, taking the stronger source', () => {
    const k = emptyKnowledge()
    learnFact(k, term())
    const again = learnFact(k, term({ name: 'bullseye', meaning: 'An October auto-enrol marketing program.', aliases: ['Bulls Eye'], source: 'user' }))
    expect(again.kind).toBe('confirmed')
    expect(k.facts).toHaveLength(1)
    expect(k.facts[0]).toMatchObject({ source: 'user', confidence: 0.95, aliases: ['Bulls Eye'], meaning: 'An October auto-enrol marketing program.' })
    // Found by its alias too.
    expect(learnFact(k, term({ name: 'Bulls Eye', source: 'inferred' })).kind).toBe('confirmed')
    // SQL added to a term known only in words is more of the same, not a correction.
    const k2 = emptyKnowledge()
    learnFact(k2, term({ sql: undefined }))
    expect(learnFact(k2, term()).kind).toBe('confirmed')
    expect(k2.facts[0].sql).toBe("auto_enroll_programs.program_name = 'Bullseye'")
  })

  it('takes a correction, keeping what it meant before, and undoes it when forgotten', () => {
    const k = emptyKnowledge()
    learnFact(k, term())
    reinforce(k, [k.facts[0].id], 0.1)
    const out = learnFact(k, term({ sql: "auto_enroll_programs.auto_program_id = 'LP21010010000001'", meaning: 'The 2021 program.', source: 'user' }))
    expect(out.kind).toBe('corrected')
    expect(k.facts[0]).toMatchObject({ meaning: 'The 2021 program.', source: 'user', confidence: 0.95, uses: 0 })
    expect(k.facts[0].replaced).toMatchObject([{ meaning: 'The marketing program members are auto-enrolled into in October.', source: 'inferred' }])
    expect(forgetLearned(k, { kind: 'term', id: k.facts[0].id, corrected: true })).toBe(true)
    expect(k.facts[0]).toMatchObject({ meaning: 'The marketing program members are auto-enrolled into in October.', sql: "auto_enroll_programs.program_name = 'Bullseye'", source: 'inferred' })
    // Forgotten when it was new.
    expect(forgetLearned(k, { kind: 'term', id: k.facts[0].id })).toBe(true)
    expect(k.facts).toEqual([])
  })

  it('does not let a guess replace what the user said', () => {
    const k = emptyKnowledge()
    learnFact(k, term({ source: 'user' }))
    const out = learnFact(k, term({ sql: 'auto_enroll_programs.is_active = 1', meaning: 'Any active program.', source: 'data' }))
    expect(out.kind).toBe('refused')
    expect(k.facts[0].sql).toBe("auto_enroll_programs.program_name = 'Bullseye'")
  })

  it('gains confidence with use, never past what its source allows', () => {
    const k = emptyKnowledge()
    learnFact(k, term())
    for (let i = 0; i < 20; i++) reinforce(k, [k.facts[0].id], 0.05)
    expect(k.facts[0]).toMatchObject({ uses: 20, confidence: 0.75 })
  })
})

describe('domains and the runbook', () => {
  it('adds up the tables of a domain, and keeps a stronger description', () => {
    const k = emptyKnowledge()
    learnDomain(k, { path: 'Marketing > Programs', description: 'Programs members join.', tables: ['auto_enroll_programs'], source: 'inferred' })
    const out = learnDomain(k, { path: 'marketing › programs', description: 'Marketing programs and their members.', tables: ['auto_enroll_members'], source: 'user' })
    expect(out.kind).toBe('updated')
    expect(k.domains).toMatchObject([
      { path: 'Marketing › Programs', description: 'Marketing programs and their members.', tables: ['auto_enroll_programs', 'auto_enroll_members'], source: 'user' }
    ])
  })

  it('keeps a query once by its shape, counts its runs, and numbers entries for the model to call', () => {
    const k = emptyKnowledge()
    const input = { name: 'Program job results', purpose: 'How a program’s jobs went since a date', sql: 'SELECT count(*) FROM sys_jobs WHERE program = :program AND created_ts >= :since', params: [{ name: 'program' }, { name: 'since' }], tables: ['sys_jobs'], source: 'data' as const, question: 'How did Bullseye do?' }
    expect(keepInRunbook(k, input).entry.id).toBe('q1')
    const again = keepInRunbook(k, { ...input, name: 'Jobs per program', question: 'How did Gold do?' })
    expect(again).toMatchObject({ kind: 'updated', entry: { id: 'q1', name: 'Jobs per program', questions: ['How did Gold do?', 'How did Bullseye do?'] } })
    expect(keepInRunbook(k, { ...input, name: 'Other', sql: 'SELECT 1 FROM sys_jobs' }).entry.id).toBe('q2')
    noteRunbookRun(k, 'q1', true, 'How did Bullseye do in May?')
    noteRunbookRun(k, 'q1', false)
    expect(k.runbook[0]).toMatchObject({ runs: 1, failures: 1, questions: ['How did Bullseye do in May?', 'How did Gold do?', 'How did Bullseye do?'] })
    expect(forgetLearned(k, { kind: 'query', id: 'q2' })).toBe(true)
    expect(k.runbook.map((r) => r.id)).toEqual(['q1'])
    expect(sanitizeKnowledge(JSON.parse(JSON.stringify(k))).nextQuery).toBe(3)
  })
})

describe('what queries teach', () => {
  it('counts a query by its shape, with its joins and the values it compared columns with', () => {
    const k = emptyKnowledge()
    const sql = "SELECT j.id FROM sys_jobs j JOIN auto_enroll_programs p ON p.auto_program_id = j.program_id WHERE p.program_name = 'Bullseye'"
    const facts = runFacts(sql)
    expect(facts).toEqual({
      tables: ['sys_jobs', 'auto_enroll_programs'],
      joins: [{ from: 'auto_enroll_programs', to: 'sys_jobs', via: 'auto_enroll_programs.auto_program_id = sys_jobs.program_id' }],
      values: [{ column: 'auto_enroll_programs.program_name', value: 'Bullseye' }]
    })
    recordQuery(k, { sql, ...facts, by: 'user', ok: true })
    recordQuery(k, { sql: sql.replace('Bullseye', 'Gold'), ...runFacts(sql.replace('Bullseye', 'Gold')), by: 'model', question: 'How did Gold do?', ok: true })
    recordQuery(k, { sql: 'SELECT nope FROM sys_jobs', tables: ['sys_jobs'], joins: [], values: [], by: 'user', ok: false })
    expect(k.queries).toMatchObject([
      { count: 2, by: 'user', question: 'How did Gold do?', sql: sql.replace('Bullseye', 'Gold'), errors: 0 },
      { count: 1, errors: 1 }
    ])
    expect(k.links).toMatchObject([{ kind: 'join', count: 2 }])
    expect(k.values.map((v) => [v.value, v.column])).toEqual([
      ['Bullseye', 'auto_enroll_programs.program_name'],
      ['Gold', 'auto_enroll_programs.program_name']
    ])
  })
})

describe('the store', () => {
  it('keeps each connection in a file of its own, written soon after a change and readable again', async () => {
    const dir = tempDir()
    const store = new KnowledgeStore(dir, 5)
    const book = new KnowledgeBook(store, 'conn-1')
    await book.learn(term())
    await book.ran("SELECT * FROM auto_enroll_programs WHERE program_name = 'Bullseye'", { by: 'user', ok: true })
    await store.flush()
    const file = path.join(dir, 'conn-1.json')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const again = new KnowledgeStore(dir)
    const k = await again.get('conn-1')
    expect(k.facts.map((f) => f.name)).toEqual(['Bullseye'])
    expect(k.values).toMatchObject([{ value: 'Bullseye', column: 'auto_enroll_programs.program_name' }])
    // A malformed entry is dropped, not trusted.
    expect(sanitizeKnowledge({ facts: [{ id: 'x', name: 'n' }, ...JSON.parse(readFileSync(file, 'utf8')).facts] }).facts).toHaveLength(1)
    await again.forgetConnection('conn-1')
    expect((await again.get('conn-1')).facts).toEqual([])
  })

  it('writes what changed before the app exits', async () => {
    const dir = tempDir()
    const store = new KnowledgeStore(dir, 60_000)
    await new KnowledgeBook(store, 'c').learn(term())
    store.flushSync()
    expect(JSON.parse(readFileSync(path.join(dir, 'c.json'), 'utf8')).facts).toHaveLength(1)
  })

  it('keeps within its limits, letting the least used and oldest go first, what the user said last', async () => {
    const store = new KnowledgeStore(tempDir(), 5)
    await store.change('c', (k) => {
      learnFact(k, term({ name: 'told', source: 'user' }), 0)
      for (let i = 0; i < LIMITS.facts + 5; i++) learnFact(k, term({ name: `t${i}`, meaning: `m${i}` }), 1000 + i)
    })
    const k = await store.get('c')
    expect(k.facts).toHaveLength(LIMITS.facts)
    expect(k.facts.some((f) => f.name === 'told')).toBe(true)
  })

  it('recognises an answer’s query when the user runs it, and counts the answer’s terms as holding up', async () => {
    const store = new KnowledgeStore(tempDir(), 5)
    const book = new KnowledgeBook(store, 'c')
    const fact = (await book.learn(term())).fact
    const sql = "SELECT count(*) FROM auto_enroll_programs WHERE program_name = 'Bullseye'"
    book.answered(sql, { facts: [fact.id], question: 'How many Bullseye programs?' })
    await book.editorRun(`${sql.replace('count(*)', 'COUNT(*)')};`, true)
    const k = await store.get('c')
    expect(k.facts[0].uses).toBe(1)
    expect(k.facts[0].confidence).toBeCloseTo(0.6)
    expect(k.queries).toMatchObject([{ by: 'user', question: 'How many Bullseye programs?', count: 1 }])
    // Once: running it again is just a run.
    await book.editorRun(sql, true)
    expect((await store.get('c')).facts[0].uses).toBe(1)
  })
})
