// Recall: what is known that bears on a question, found without a model call; the outline of domains; how data moves.
import { describe, expect, it } from 'vitest'
import { emptyKnowledge, type Knowledge } from '../../src/shared/knowledge'
import type { Relation, SchemaInfo, TableMeta } from '../../src/shared/types'
import { SchemaIndex } from '../../src/main/ai/schema-index'
import { domainMap } from '../../src/main/knowledge/domains'
import { scanFlow } from '../../src/main/knowledge/flow'
import { keepInRunbook, learnDomain, learnFact, recordQuery } from '../../src/main/knowledge/learn'
import { recall, renderRecall, tableNotes } from '../../src/main/knowledge/recall'
import { runFacts } from '../../src/main/knowledge/book'

const col = (cid: number, name: string, type = 'TEXT', pk = 0) => ({ cid, name, type, notnull: false, dflt: null, pk, hidden: 0 })
const table = (name: string, columns: string[], type: 'table' | 'view' = 'table'): TableMeta => ({
  name,
  type,
  sql: null,
  columns: columns.map((c, i) => col(i, c, i === 0 ? 'INTEGER' : 'TEXT', i === 0 ? 1 : 0)),
  withoutRowid: false,
  rowidAlias: 'rowid',
  pk: [columns[0]]
})
const fk = (from: string, column: string, to: string, refColumn: string): Relation => ({ table: from, column, refTable: to, refColumn })

/** A schema like a real one: programs, jobs, billing, and enough else that it gets an outline from its names. */
function schema(): SchemaInfo {
  const tables = [
    table('auto_enroll_programs', ['auto_program_id', 'program_name', 'is_active']),
    table('auto_enroll_members', ['member_id', 'auto_program_id', 'email']),
    table('auto_enroll_runs', ['run_id', 'auto_program_id', 'started_ts']),
    table('sys_jobs', ['id', 'job_type', 'program_id', 'created_ts', 'status']),
    table('sys_job_runs', ['id', 'job_id', 'duration_ms']),
    table('job_log', ['id', 'job_id', 'note']),
    table('billing_invoices', ['id', 'customer_id', 'total']),
    table('billing_customers', ['id', 'name']),
    table('billing_payments', ['id', 'invoice_id', 'amount']),
    table('refund_requests', ['id', 'invoice_id', 'reason']),
    ...Array.from({ length: 14 }, (_, i) => table(`audit_event_${i}`, ['id', 'payload']))
  ]
  return {
    kind: 'sqlite',
    tables,
    views: [table('job_summary', ['job_type', 'n'], 'view')],
    indexes: [],
    triggers: [],
    relations: [
      fk('auto_enroll_members', 'auto_program_id', 'auto_enroll_programs', 'auto_program_id'),
      fk('auto_enroll_runs', 'auto_program_id', 'auto_enroll_programs', 'auto_program_id'),
      fk('sys_jobs', 'program_id', 'auto_enroll_programs', 'auto_program_id'),
      fk('sys_job_runs', 'job_id', 'sys_jobs', 'id'),
      fk('billing_invoices', 'customer_id', 'billing_customers', 'id'),
      fk('billing_payments', 'invoice_id', 'billing_invoices', 'id'),
      fk('refund_requests', 'invoice_id', 'billing_invoices', 'id')
    ]
  }
}

function learned(index: SchemaIndex): Knowledge {
  const k = emptyKnowledge()
  learnFact(k, { kind: 'term', name: 'Bullseye', aliases: ['Bulls Eye'], meaning: 'The October auto-enrol marketing program.', sql: "auto_enroll_programs.program_name = 'Bullseye'", tables: ['auto_enroll_programs'], source: 'user' })
  learnFact(k, { kind: 'term', name: 'spawn', meaning: 'Jobs that create members.', sql: "sys_jobs.job_type = 'spawn'", tables: ['sys_jobs'], source: 'data' })
  learnFact(k, { kind: 'term', name: 'churn', meaning: 'Customers who stopped paying.', tables: ['billing_customers'], source: 'inferred' })
  learnFact(k, { kind: 'rule', name: 'Test programs', meaning: 'Leave out programs whose name starts with TEST.', tables: [], source: 'user' })
  learnDomain(k, { path: 'Marketing › Programs', description: 'Programs members are enrolled in automatically.', tables: ['auto_enroll_programs', 'auto_enroll_members', 'auto_enroll_runs'], source: 'user' })
  keepInRunbook(k, {
    name: 'Program job performance',
    purpose: 'How a program’s jobs performed since a date: runs, failures and duration.',
    sql: 'SELECT j.status, count(*) FROM sys_jobs j JOIN auto_enroll_programs p ON p.auto_program_id = j.program_id WHERE p.program_name = :program AND j.created_ts >= :since GROUP BY 1',
    params: [{ name: 'program', description: 'the program’s name' }, { name: 'since', description: 'a date' }],
    tables: ['sys_jobs', 'auto_enroll_programs'],
    questions: [],
    source: 'data',
    question: 'How did the Gold program jobs perform since May?'
  } as any)
  for (const sql of ["SELECT count(*) FROM billing_invoices i JOIN refund_requests r ON r.invoice_id = i.id WHERE r.reason = 'October Push'", "SELECT * FROM sys_jobs WHERE status = 'failed'"]) {
    recordQuery(k, { sql, ...runFacts(sql, index), by: 'user', ok: true })
  }
  return k
}

describe('recall', () => {
  const index = SchemaIndex.fromSchema(schema(), 'sqlite')

  it('finds the terms, runbook queries and domains a business question uses, and the tables they point at', () => {
    const k = learned(index)
    const r = recall(k, domainMap(index, k), 'How have the Bullseye marketing program jobs performed since June?', index)
    expect(r.terms.map((f) => f.name)).toEqual(['Bullseye'])
    expect(r.runbook.map((q) => q.id)).toEqual(['q1'])
    expect(r.rules.map((f) => f.name)).toEqual(['Test programs'])
    expect(r.domains[0].path).toBe('Marketing › Programs')
    expect(r.tables.slice(0, 2)).toEqual(['auto_enroll_programs', 'sys_jobs'])
    // Matched by an alias, as a phrase, whatever its case.
    expect(recall(k, domainMap(index, k), 'what did bulls eye do', index).terms.map((f) => f.name)).toEqual(['Bullseye'])
    // A word inside another word is not the term.
    expect(recall(k, domainMap(index, k), 'show the spawning queue', index).terms).toEqual([])
  })

  it('finds a name in the question that earlier queries compared a column with', () => {
    const k = learned(index)
    const r = recall(k, domainMap(index, k), 'How many refunds came from the October Push?', index)
    expect(r.values).toEqual([{ value: 'October Push', column: 'refund_requests.reason' }])
    expect(r.tables).toContain('refund_requests')
    expect(r.examples.map((q) => q.sql)).toEqual(["SELECT count(*) FROM billing_invoices i JOIN refund_requests r ON r.invoice_id = i.id WHERE r.reason = 'October Push'"])
    expect(r.flows).toMatchObject([{ kind: 'join', via: 'billing_invoices.id = refund_requests.invoice_id' }])
  })

  it('writes it for the prompt, saying how far each thing is trusted', () => {
    const k = learned(index)
    const text = renderRecall(recall(k, domainMap(index, k), 'How did Bullseye jobs perform since June?', index), { runSaved: true })
    expect(text).toContain('## What this team means')
    expect(text).toContain(`- "Bullseye" (also "Bulls Eye"), told by the user: The October auto-enrol marketing program. SQL: auto_enroll_programs.program_name = 'Bullseye'`)
    expect(text).toContain('Runbook (run_saved_query with the id and values, or use the SQL in propose_query):')
    expect(text).toContain('- q1 "Program job performance" (program: the program’s name; since: a date): How a program’s jobs performed since a date')
    expect(text).toContain('- Test programs, told by the user: Leave out programs whose name starts with TEST.')
    expect(text).toContain('- Marketing › Programs, told by the user: Programs members are enrolled in automatically. Tables: auto_enroll_programs, auto_enroll_members, auto_enroll_runs')
    expect(text).toMatch(/Other parts of this database: .*billing \(4 tables\)/)
    expect(text.length).toBeLessThan(6000)
    // Nothing known: nothing to say.
    expect(renderRecall(recall(emptyKnowledge(), domainMap(SchemaIndex.fromSchema({ ...schema(), tables: schema().tables.slice(0, 3) }, 'sqlite'), emptyKnowledge()), 'anything', index), { runSaved: false })).toBe('')
  })
})

describe('domains', () => {
  it('outlines a schema by its names and keys, after the domains learned', () => {
    const index = SchemaIndex.fromSchema(schema(), 'sqlite')
    const k = learned(index)
    const map = domainMap(index, k)
    const paths = map.domains.map((d) => [d.path, d.source, d.tables])
    expect(paths).toContainEqual(['Marketing › Programs', 'user', ['auto_enroll_programs', 'auto_enroll_members', 'auto_enroll_runs']])
    expect(paths).toContainEqual(['billing', 'structure', ['billing_customers', 'billing_invoices', 'billing_payments', 'refund_requests']])
    expect(paths).toContainEqual(['sys', 'structure', ['sys_job_runs', 'sys_jobs']])
    expect(map.of('auto_enroll_members').map((d) => d.path)).toEqual(['Marketing › Programs'])
    // Small schemas get no outline from names: only what was learned.
    const small = SchemaIndex.fromSchema({ ...schema(), tables: schema().tables.slice(0, 6) }, 'sqlite')
    expect(domainMap(small, k).domains.map((d) => d.source)).toEqual(['user'])
  })

  it('adds what is known about a table to its description', () => {
    const index = SchemaIndex.fromSchema(schema(), 'sqlite')
    const k = learned(index)
    k.links.push({ from: 'sys_jobs', to: 'job_log', kind: 'writes', via: 'trigger log_job', count: 1, lastAt: Date.now() })
    expect(tableNotes(k, domainMap(index, k), 'sys_jobs')).toEqual([
      'domain: sys',
      `terms: "spawn" (sys_jobs.job_type = 'spawn')`,
      'runbook: q1 "Program job performance"',
      'data flow: sys_jobs → job_log: written by trigger log_job'
    ])
  })
})

describe('how data moves', () => {
  it('reads triggers, the functions they run and views, for the tables in play', async () => {
    const index = SchemaIndex.fromSchema(schema(), 'sqlite')
    const asked: string[] = []
    const { links, scanned } = await scanFlow(
      index,
      {
        async triggers(ref) {
          asked.push(`triggers ${ref.name}`)
          return ref.name === 'sys_jobs'
            ? [
                { name: 'log_job', sql: 'CREATE TRIGGER log_job AFTER INSERT ON sys_jobs FOR EACH ROW EXECUTE FUNCTION public.write_log()' },
                { name: 'touch_runs', sql: 'CREATE TRIGGER touch_runs AFTER UPDATE ON sys_jobs BEGIN UPDATE sys_job_runs SET duration_ms = 0 WHERE job_id = NEW.id; END' }
              ]
            : []
        },
        async definition(ref) {
          asked.push(`${ref.kind} ${ref.schema ?? ''}.${ref.name}`)
          if (ref.kind === 'function') return 'CREATE FUNCTION public.write_log() RETURNS trigger AS $$ BEGIN INSERT INTO job_log (job_id) SELECT id FROM auto_enroll_runs LIMIT 1; RETURN NEW; END $$ LANGUAGE plpgsql'
          if (ref.name === 'job_summary') return 'SELECT j.job_type, count(*) AS n FROM sys_jobs j JOIN sys_job_runs r ON r.job_id = j.id GROUP BY 1'
          return null
        }
      },
      ['sys_jobs', 'job_summary']
    )
    expect(asked).toEqual(['triggers sys_jobs', 'function public.write_log', 'view .job_summary'])
    expect(links).toEqual([
      { from: 'sys_jobs', to: 'job_log', kind: 'writes', via: 'trigger log_job (function public.write_log)' },
      { from: 'auto_enroll_runs', to: 'job_log', kind: 'feeds', via: 'function public.write_log' },
      { from: 'sys_jobs', to: 'sys_job_runs', kind: 'writes', via: 'trigger touch_runs' },
      { from: 'sys_jobs', to: 'job_summary', kind: 'feeds', via: 'view job_summary' },
      { from: 'sys_job_runs', to: 'job_summary', kind: 'feeds', via: 'view job_summary' }
    ])
    expect(scanned).toEqual(['sys_jobs', 'job_summary'])
  })
})
