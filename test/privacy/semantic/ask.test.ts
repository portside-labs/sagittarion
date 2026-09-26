// The ask loop with the on-device model on, where it once broke: the model read the provider's own
// describe_table call, took the table name for an organization, and the name vanished from everything the provider
// saw; the provider put the placeholder in its SQL, which came back as a quoted string. Table names must stay names.
import { describe, expect, it } from 'vitest'
import type { ColumnInfo, SchemaInfo, TableMeta } from '../../../src/shared/types'
import { SchemaIndex } from '../../../src/main/ai/schema-index'
import { askDatabase } from '../../../src/main/ai/nl2sql'
import type { ChatRequest } from '../../../src/main/ai/providers/types'
import { ModelGateway } from '../../../src/main/privacy/gateway'
import { PrivacyEngine } from '../../../src/main/privacy/engine'
import { PrivacySession } from '../../../src/main/privacy/session'
import { GlinerDetector } from '../../../src/main/privacy/semantic/detector'
import { GLINER_PII_BASE as manifest } from '../../../src/main/privacy/semantic/manifest'
import type { RawSpan } from '../../../src/main/privacy/semantic/runtime'
import { PiiVault } from '../../../src/main/privacy/vault'
import { policy, recordingProvider, reply } from '../helpers'

const col = (name: string, type: string, pk = 0): ColumnInfo => ({ cid: 0, name, type, notnull: false, dflt: null, pk, hidden: 0 })
const table = (name: string, columns: ColumnInfo[]): TableMeta => ({ name, type: 'table', sql: null, columns, withoutRowid: false, rowidAlias: 'rowid', pk: columns.filter((c) => c.pk > 0).map((c) => c.name) })
const schema: SchemaInfo = {
  kind: 'postgres',
  tables: [
    table('users', [col('id', 'integer', 1), col('email', 'text'), col('first_name', 'text')]),
    table('inspections', [col('id', 'integer', 1), col('owner_name', 'text')]),
    table('inspection_inspector', [col('id', 'integer', 1), col('inspection_id', 'integer'), col('user_id', 'integer')])
  ],
  views: [],
  indexes: [],
  triggers: [],
  relations: []
} as unknown as SchemaInfo

/** A model that reads every "inspection_inspector" as an organization and "Shiloh Romo" as a person. */
const model = new GlinerDetector(async (texts) =>
  texts.map((t) => {
    const spans: RawSpan[] = []
    for (const [phrase, label] of [
      ['inspection_inspector', 5],
      ['Shiloh Romo', 0]
    ] as const)
      for (let i = t.indexOf(phrase); i >= 0; i = t.indexOf(phrase, i + 1)) spans.push({ start: i, end: i + phrase.length, label, score: 0.53 })
    return spans.sort((a, b) => a.start - b.start)
  }), manifest)

describe('asking with the on-device model', () => {
  it('keeps table names usable in SQL while protecting the people in the question', async () => {
    const tableArg = (req: ChatRequest) => req.messages.flatMap((m) => ('toolCalls' in m ? (m.toolCalls ?? []) : [])).find((c) => c.id === 'c2')?.args.table as string
    const provider = recordingProvider((req, n) => {
      if (n === 1) return reply({ text: 'Let me look at the tables.', toolCalls: [{ id: 'c2', name: 'describe_table', args: { table: 'inspection_inspector' } }] })
      // The provider writes SQL with the name as it sees it in its own earlier call.
      const email = /<\|PII:EMAIL:[0-9A-F]{6}\|>/.exec(req.messages[0].content as string)![0]
      const sql = `SELECT i.owner_name FROM inspections i JOIN ${tableArg(req)} ii ON ii.inspection_id = i.id JOIN users u ON u.id = ii.user_id WHERE u.email = '${email}' LIMIT 5`
      return reply({ toolCalls: [{ id: 'c3', name: 'propose_query', args: { sql, explanation: 'Owners.', tables_used: ['inspections'] } }] })
    })
    const session = new PrivacySession({ engine: new PrivacyEngine({ schemaDetection: true, semantic: model }), policy, vault: new PiiVault(), host: 'api.anthropic.com' })
    const ran: string[] = []
    const result = await askDatabase(
      {
        kind: 'postgres',
        serverVersion: '18.6',
        index: SchemaIndex.fromSchema(schema, 'postgres'),
        provider: ModelGateway.protected(provider, session),
        settings: { sendSampleValues: false, autoRun: true, schemaBudgetTokens: 8000 },
        runQuery: async (sql) => {
          ran.push(sql)
          if (/'inspection_inspector'|<\|/.test(sql)) throw new Error('syntax error')
          return { results: [{ kind: 'rows', sql, columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 1 }], durationMs: 1, tx: false }
        },
        distinctValues: async () => null
      },
      "Who was Shiloh Romo's (i.e. shiloh@romo.io) last 5 customers?"
    )
    expect(result.kind).toBe('query')
    expect(ran[0]).toContain('JOIN inspection_inspector ii')
    expect(ran[0]).toContain("u.email = 'shiloh@romo.io'")
    const sent = JSON.stringify(provider.requests)
    // The person was protected; the table was not.
    expect(sent).not.toMatch(/Shiloh|shiloh@romo\.io/)
    expect(sent).not.toMatch(/PII:ORG/)
    expect(JSON.stringify(provider.requests[1].messages)).toContain('"table":"inspection_inspector"')
  })
})
