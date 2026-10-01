// Instructions: what the user tells the model about their data, global or for chosen connections. Sent with each
// question where they apply, protected like everything else, named in the steps and never shown in the chat.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { emptyInstruction, instructionsFor, MAX_INSTRUCTION_CHARS, type Instruction } from '../src/shared/instructions'
import type { AiProgressStep } from '../src/shared/ai'
import type { SchemaInfo } from '../src/shared/types'
import { InstructionStore } from '../src/main/store/instructions'
import { askDatabase } from '../src/main/ai/nl2sql'
import { SchemaIndex } from '../src/main/ai/schema-index'
import { ModelGateway } from '../src/main/privacy/gateway'
import { PrivacyEngine } from '../src/main/privacy/engine'
import { PrivacySession } from '../src/main/privacy/session'
import { PiiVault } from '../src/main/privacy/vault'
import type { ChatRequest } from '../src/main/ai/providers/types'
import { policy, recordingProvider, reply, wireText } from './privacy/helpers'

let tmp: string
beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'sagittarion-instructions-'))
})
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function instruction(partial: Partial<Instruction>): Instruction {
  return { ...emptyInstruction(), id: partial.name ?? 'x', name: 'x', text: 'Do this.', createdAt: 0, updatedAt: 0, ...partial }
}

describe('which instructions apply', () => {
  it('takes the global ones, then the connection’s own, in the order made', () => {
    const list = [
      instruction({ name: 'Corespec dates', scope: 'selected', connectionIds: ['c1'], createdAt: 1 }),
      instruction({ name: 'Revenue', scope: 'all', createdAt: 3 }),
      instruction({ name: 'Other db', scope: 'selected', connectionIds: ['c2'], createdAt: 2 }),
      instruction({ name: 'Off', scope: 'all', enabled: false, createdAt: 0 }),
      instruction({ name: 'Blank', scope: 'all', text: '   ', createdAt: 0 }),
      instruction({ name: 'Style', scope: 'all', createdAt: 4 })
    ]
    expect(instructionsFor(list, 'c1').map((i) => i.name)).toEqual(['Revenue', 'Style', 'Corespec dates'])
    expect(instructionsFor(list, 'c2').map((i) => i.name)).toEqual(['Revenue', 'Style', 'Other db'])
    // A connection that was never saved still gets the global ones.
    expect(instructionsFor(list, undefined).map((i) => i.name)).toEqual(['Revenue', 'Style'])
  })
})

describe('InstructionStore', () => {
  it('saves, names, switches, deletes and forgets connections', async () => {
    const store = new InstructionStore(path.join(tmp, 'instructions.json'))
    const a = await store.save({ ...emptyInstruction(), text: '  Revenue means paid orders only.\nIn USD.  ' })
    expect(a).toMatchObject({ name: 'Revenue means paid orders only.', text: 'Revenue means paid orders only.\nIn USD.', scope: 'all', enabled: true })
    const b = await store.save({ ...emptyInstruction(), name: 'Dates', text: 'Dates are UTC.', scope: 'selected', connectionIds: ['c1', 'c2', 'c1'] })
    expect(b.connectionIds).toEqual(['c1', 'c2'])
    await expect(store.save({ ...emptyInstruction(), text: ' ' })).rejects.toThrow(/Write the instruction/)
    await expect(store.save({ ...emptyInstruction(), text: 'x'.repeat(MAX_INSTRUCTION_CHARS + 1) })).rejects.toThrow(/under 8,000 characters/)
    expect((await store.setEnabled(a.id, false)).enabled).toBe(false)
    await store.forgetConnection('c1')
    expect((await new InstructionStore(path.join(tmp, 'instructions.json')).list()).map((i) => [i.name, i.enabled, i.connectionIds])).toEqual([
      ['Revenue means paid orders only.', false, []],
      ['Dates', true, ['c2']]
    ])
    await store.remove(a.id)
    expect((await store.list()).map((i) => i.name)).toEqual(['Dates'])
  })
})

describe('instructions in an ask', () => {
  const schema: SchemaInfo = {
    kind: 'sqlite',
    tables: [
      {
        name: 'orders',
        type: 'table',
        sql: null,
        columns: [
          { cid: 0, name: 'id', type: 'INTEGER', notnull: false, dflt: null, pk: 1, hidden: 0 },
          { cid: 1, name: 'total', type: 'REAL', notnull: false, dflt: null, pk: 0, hidden: 0 },
          { cid: 2, name: 'status', type: 'TEXT', notnull: false, dflt: null, pk: 0, hidden: 0 }
        ],
        withoutRowid: false,
        rowidAlias: 'rowid',
        pk: ['id']
      }
    ],
    views: [],
    indexes: [],
    triggers: [],
    relations: []
  }

  it('go to the model after the rules, protected; the steps name them; the answer does not repeat them', async () => {
    const requests: ChatRequest[] = []
    const provider = recordingProvider((req) => {
      requests.push(req)
      return reply({ toolCalls: [{ id: 'p1', name: 'propose_query', args: { sql: "SELECT sum(total) FROM orders WHERE status = 'paid'", explanation: 'Paid orders, summed.', tables_used: ['orders'] } }], stopReason: 'tool_calls' })
    })
    const session = new PrivacySession({ engine: new PrivacyEngine({ schemaDetection: true }), policy, vault: new PiiVault(), host: 'api.example.com' })
    const steps: AiProgressStep[] = []
    const result = await askDatabase(
      {
        kind: 'sqlite',
        serverVersion: '3.45.1',
        index: SchemaIndex.fromSchema(schema, 'sqlite'),
        provider: ModelGateway.protected(provider, session),
        settings: { sendSampleValues: false, autoRun: true, schemaBudgetTokens: 8000 },
        runQuery: async (sql) => ({ results: [{ kind: 'rows', sql, columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 1 }], durationMs: 1, tx: false }),
        distinctValues: async () => null,
        instructions: [
          { name: 'Revenue', text: "Revenue means orders with status = 'paid'. Questions go to finance@corp.io." },
          { name: 'Style', text: 'Prefer explicit column lists over *.' }
        ],
        onProgress: (s) => steps.push(s)
      },
      'What was revenue?'
    )
    const system = requests[0].system.map((b) => b.text)
    const at = system.findIndex((t) => t.startsWith('## Instructions from the user'))
    expect(at).toBeGreaterThan(-1)
    // After the fixed rules, before the schema.
    expect(system.findIndex((t) => t.includes('Rules:'))).toBeLessThan(at)
    expect(system.findIndex((t) => t.includes('## Schema'))).toBeGreaterThan(at)
    expect(system[at]).toContain("### Revenue\nRevenue means orders with status = 'paid'.")
    expect(system[at]).toContain('### Style\nPrefer explicit column lists over *.')
    // Personal data in an instruction is protected like a question's.
    expect(wireText(requests)).not.toContain('finance@corp.io')
    expect(system[at]).toMatch(/Questions go to <\|PII:EMAIL:[0-9A-F]{6}\|>/)
    expect(steps).toContainEqual(expect.objectContaining({ stage: 'instructions', status: 'done', message: 'Following 2 instructions', detail: 'Revenue, Style' }))
    expect(result.kind).toBe('query')
    expect(JSON.stringify(result)).not.toContain('Prefer explicit column lists')
  })
})
