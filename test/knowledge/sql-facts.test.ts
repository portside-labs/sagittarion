// Reading what a statement says about the database: the tables, joins and values the app learns from.
import { describe, expect, it } from 'vitest'
import { analyzeSql, definitionFacts, sameSqlKey } from '../../src/main/knowledge/sql-facts'

describe('reading a query', () => {
  it('finds the tables it reads, by their aliases, and leaves out its CTEs and functions', () => {
    const f = analyzeSql(`
      WITH recent AS (SELECT * FROM sys_jobs WHERE created_ts > '2026-06-01'),
           totals (program, n) AS (SELECT program_id, count(*) FROM recent GROUP BY 1)
      SELECT p.program_name, t.n, extract(year FROM now())
      FROM auto_enroll_programs AS p
      JOIN totals t ON t.program = p.auto_program_id
      LEFT JOIN "Marketing"."Campaigns" c ON c.program_id = p.auto_program_id, generate_series(1, 3) g
      WHERE p.is_active IS DISTINCT FROM false`)
    expect(f.reads).toEqual([
      { name: 'sys_jobs' },
      { name: 'auto_enroll_programs', alias: 'p' },
      { schema: 'Marketing', name: 'Campaigns', alias: 'c' }
    ])
    expect(f.writes).toEqual([])
    expect(f.joins).toEqual([
      { left: { qualifier: 't', column: 'program' }, right: { qualifier: 'p', column: 'auto_program_id' } },
      { left: { qualifier: 'c', column: 'program_id' }, right: { qualifier: 'p', column: 'auto_program_id' } }
    ])
  })

  it('reads comma joins, schema-qualified names and joins written in WHERE', () => {
    const f = analyzeSql('SELECT * FROM billing.invoices i, billing.customers c WHERE i.customer_id = billing.c.id AND i.total > 10')
    expect(f.reads).toEqual([
      { schema: 'billing', name: 'invoices', alias: 'i' },
      { schema: 'billing', name: 'customers', alias: 'c' }
    ])
    expect(f.joins).toEqual([{ left: { qualifier: 'i', column: 'customer_id' }, right: { qualifier: 'c', column: 'id' } }])
  })

  it('keeps the text values columns are compared with, as names in questions will be', () => {
    const f = analyzeSql(
      "SELECT * FROM auto_enroll_programs p WHERE p.program_name ILIKE '%Bullseye%' AND lower(p.region) = 'north east' AND status IN ('active', 'paused') AND 'gold' = tier AND p.code::text = 'BX-1' AND note LIKE '%a%b%' AND kind NOT LIKE 'test%'"
    )
    expect(f.values).toEqual([
      { column: { qualifier: 'p', column: 'program_name' }, value: 'Bullseye' },
      { column: { qualifier: 'p', column: 'region' }, value: 'north east' },
      { column: { column: 'status' }, value: 'active' },
      { column: { column: 'status' }, value: 'paused' },
      { column: { column: 'tier' }, value: 'gold' },
      { column: { qualifier: 'p', column: 'code' }, value: 'BX-1' }
    ])
  })

  it('gives the same shape to the same query with other values', () => {
    const a = analyzeSql("SELECT count(*) FROM sys_jobs WHERE job_type IN ('spawn', 'merge') AND created_ts >= '2026-06-01' LIMIT 50;")
    const b = analyzeSql("select COUNT(*) from sys_jobs where job_type in ('spawn') and created_ts >= '2025-01-01' limit 10")
    expect(a.shape).toBe(b.shape)
    expect(a.shape).toBe('select count ( * ) from sys_jobs where job_type in ( ? ) and created_ts >= ? limit ?')
    expect(analyzeSql('SELECT 1 FROM t WHERE a = $1').shape).toBe(analyzeSql("SELECT 1 FROM t WHERE a = 'x'").shape)
  })

  it('finds :parameters, but not casts or array slices', () => {
    const f = analyzeSql("SELECT * FROM jobs j WHERE j.program = :program AND j.created_ts >= :since::date AND j.tags[1:2] = '{}' AND :program <> ''")
    expect(f.params).toEqual(['program', 'since'])
  })

  it('reads string bodies as strings, so a value with SQL in it is not a table', () => {
    const f = analyzeSql("SELECT * FROM notes WHERE body = 'see FROM orders JOIN users' AND x = $$ FROM secrets $$")
    expect(f.reads).toEqual([{ name: 'notes' }])
  })
})

describe('reading a definition', () => {
  it('finds what a trigger or function writes, and the function a PostgreSQL trigger runs', () => {
    expect(definitionFacts('CREATE TRIGGER orders_touch_user AFTER UPDATE ON orders BEGIN UPDATE users SET name = name WHERE id = NEW.user_id; END').writes).toEqual([{ name: 'users' }])
    const fn = definitionFacts(`CREATE OR REPLACE FUNCTION public.log_run() RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        SELECT program_name INTO prog FROM auto_enroll_programs WHERE auto_program_id = NEW.program_id;
        INSERT INTO audit.job_log (job_id, program) VALUES (NEW.id, prog);
        UPDATE ONLY job_counts SET n = n + 1 WHERE program = prog;
        DELETE FROM job_queue WHERE id = NEW.id;
        INSERT INTO job_stats (program, n) SELECT program, 1 FROM job_counts ON CONFLICT (program) DO UPDATE SET n = excluded.n;
        RETURN NEW;
      END $function$`)
    expect(fn.reads).toEqual([{ name: 'auto_enroll_programs' }, { name: 'job_counts' }])
    expect(fn.writes).toEqual([{ schema: 'audit', name: 'job_log' }, { name: 'job_counts' }, { name: 'job_queue' }, { name: 'job_stats' }])
    expect(definitionFacts('CREATE TRIGGER t AFTER INSERT OR UPDATE ON public.sys_jobs FOR EACH ROW EXECUTE FUNCTION public.log_run()').calls).toEqual(['public.log_run'])
  })

  it('compares SQL by its words, not its spacing', () => {
    expect(sameSqlKey('SELECT  *\n FROM t ;')).toBe(sameSqlKey('select * from t'))
  })
})
