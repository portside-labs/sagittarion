// Connectors: MCP servers whose tools the Ask chat can use. A real stdio server (test/fixtures/mcp-server.mjs) stands
// in for a CRM, so starting, listing, calling and failing are the real thing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  activeInChat,
  appliesTo,
  defaultPermission,
  describeConnector,
  emptyConnector,
  joinCommandLine,
  modelToolName,
  parseKeyValueLines,
  splitCommandLine,
  type ConnectorInput,
  type ToolApprovalDecision
} from '../src/shared/connectors'
import type { SchemaInfo } from '../src/shared/types'
import type { AiProgressStep } from '../src/shared/ai'
import { ConnectorStore, connectorInfo, type Connector } from '../src/main/connectors/store'
import { ConnectorManager } from '../src/main/connectors/manager'
import { connectorsForAsk, inputSchema, resultText } from '../src/main/connectors/ask'
import { askDatabase } from '../src/main/ai/nl2sql'
import { SchemaIndex } from '../src/main/ai/schema-index'
import { ModelGateway } from '../src/main/privacy/gateway'
import { PrivacyEngine } from '../src/main/privacy/engine'
import { PrivacySession } from '../src/main/privacy/session'
import { PiiVault } from '../src/main/privacy/vault'
import { noopCodec, type SecretCodec } from '../src/main/store/connections'
import type { ChatRequest } from '../src/main/ai/providers/types'
import { policy, recordingProvider, reply, wireText } from './privacy/helpers'

const FIXTURE = path.resolve(__dirname, 'fixtures', 'mcp-server.mjs')
const codec: SecretCodec = { available: true, encrypt: (p) => `enc:${Buffer.from(p).toString('base64')}`, decrypt: (c) => (c.startsWith('enc:') ? Buffer.from(c.slice(4), 'base64').toString() : null) }

let tmp: string
beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'sagittarion-connectors-'))
})
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function crm(overrides: Partial<ConnectorInput> = {}): ConnectorInput {
  return { ...emptyConnector(), name: 'CRM', command: process.execPath, args: [FIXTURE], ...overrides }
}

function manager(): ConnectorManager {
  return new ConnectorManager({ clientInfo: { name: 'sagittarion-test', version: '0.0.0' }, path: async () => process.env.PATH ?? '', connectTimeoutMs: 15_000 })
}

describe('connector scope and tools', () => {
  it('is on everywhere, or only for the connections chosen; a chat can say otherwise', () => {
    const all = { id: 'a', enabled: true, scope: 'all' as const, connectionIds: [] }
    const some = { id: 's', enabled: true, scope: 'selected' as const, connectionIds: ['c1'] }
    expect(appliesTo(all, 'c9')).toBe(true)
    expect(appliesTo(some, 'c1')).toBe(true)
    expect(appliesTo(some, 'c2')).toBe(false)
    expect(appliesTo(some, undefined)).toBe(false)
    expect(appliesTo({ ...all, enabled: false }, 'c1')).toBe(false)
    expect(activeInChat(some, 'c2', { s: true })).toBe(true)
    expect(activeInChat(all, 'c1', { a: false })).toBe(false)
    // Switched off in Settings, no chat can use it.
    expect(activeInChat({ ...some, enabled: false }, 'c1', { s: true })).toBe(false)
  })

  it('lets read-only tools run, and asks first for the rest', () => {
    expect(defaultPermission({ readOnly: true })).toBe('allow')
    expect(defaultPermission({ readOnly: false })).toBe('ask')
  })

  it('names tools for the model within every provider limit, without clashes', () => {
    const taken = new Set<string>()
    expect(modelToolName('CRM', 'lookup_customer', taken)).toBe('mcp__crm__lookup_customer')
    expect(modelToolName('CRM', 'lookup_customer', taken)).toBe('mcp__crm__lookup_customer_2')
    const long = modelToolName('My Very Long Connector Name (prod)', 'a.tool/with spaces and a very long name indeed, really', taken)
    expect(long).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    expect(long.startsWith('mcp__my_very_long_connect__')).toBe(true)
  })

  it('reads a command line typed in one field, and writes it back', () => {
    const parts = splitCommandLine(`npx -y @scope/server --dir "/Users/me/My Files" --name 'it''s' --x=a\\ b`)
    expect(parts).toEqual(['npx', '-y', '@scope/server', '--dir', '/Users/me/My Files', '--name', 'its', '--x=a b'])
    expect(splitCommandLine(joinCommandLine(['node', '/a b/server.js', "it's", '']))).toEqual(['node', '/a b/server.js', "it's", ''])
    expect(describeConnector({ transport: 'stdio', command: 'uvx', args: ['mcp-server-git'], url: '' })).toBe('uvx mcp-server-git')
    expect(parseKeyValueLines('API_KEY=abc=def\n\n  BAD\nREGION = eu ', '=')).toEqual({ API_KEY: 'abc=def', REGION: 'eu' })
    expect(parseKeyValueLines('Authorization: Bearer x:y', ':')).toEqual({ Authorization: 'Bearer x:y' })
  })

  it('shapes results and schemas for the model', () => {
    expect(resultText({ content: [{ type: 'text', text: 'one' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] })).toBe('one\n\n[image left out]')
    expect(resultText({ content: [], structuredContent: { n: 1 } })).toBe('{\n  "n": 1\n}')
    expect(resultText({ content: [{ type: 'text', text: 'x'.repeat(30_000) }] })).toMatch(/more characters cut\]$/)
    expect(inputSchema({ name: 't', inputSchema: { type: 'object', $schema: 'http://json-schema.org/draft-07/schema#' } as never })).toEqual({ type: 'object', properties: {} })
  })
})

describe('ConnectorStore', () => {
  it('encrypts secrets, keeps them when left blank, and never shows them', async () => {
    const file = path.join(tmp, 'connectors.json')
    const store = new ConnectorStore(file, codec)
    const saved = await store.save(crm({ env: { API_TOKEN: 's3cret', REGION: 'eu' } }))
    expect(saved.env).toEqual({ API_TOKEN: 's3cret', REGION: 'eu' })
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain('s3cret')
    // Blank (null) keeps the saved value; a key left out is dropped.
    const again = await store.save({ ...crm({ env: { API_TOKEN: null } }), id: saved.id })
    expect(again.env).toEqual({ API_TOKEN: 's3cret' })
    await store.setToolPermission(saved.id, 'flag_account', 'never')
    const kept = await store.save({ ...crm({ name: 'CRM (prod)', env: { API_TOKEN: null } }), id: saved.id })
    expect(kept.toolPermissions).toEqual({ flag_account: 'never' })
    const info = connectorInfo(kept, { state: 'idle', tools: [] })
    expect(info.envKeys).toEqual(['API_TOKEN'])
    expect(JSON.stringify(info)).not.toContain('s3cret')
    await store.remove(saved.id)
    expect(await store.list()).toEqual([])
  })

  it('without a keyring keeps secrets for the session, then asks for them again', async () => {
    const file = path.join(tmp, 'plain.json')
    const store = new ConnectorStore(file, noopCodec)
    const saved = await store.save(crm({ env: { API_TOKEN: 's3cret' } }))
    expect(saved.env).toEqual({ API_TOKEN: 's3cret' })
    expect(readFileSync(file, 'utf8')).not.toContain('s3cret')
    expect((await store.get(saved.id))?.env.API_TOKEN).toBe('s3cret')
    // After a relaunch the value is gone, and Settings asks for it.
    const relaunched = await new ConnectorStore(file, noopCodec).get(saved.id)
    expect(relaunched?.env).toEqual({})
    expect(connectorInfo(relaunched!, { state: 'idle', tools: [] })).toMatchObject({ envKeys: ['API_TOKEN'], missingSecrets: ['API_TOKEN'] })
  })

  it('forgets a deleted database connection', async () => {
    const store = new ConnectorStore(path.join(tmp, 'scoped.json'), codec)
    const saved = await store.save(crm({ scope: 'selected', connectionIds: ['c1', 'c2'] }))
    await store.forgetConnection('c1')
    expect((await store.get(saved.id))?.connectionIds).toEqual(['c2'])
  })
})

describe('ConnectorManager', () => {
  it('starts a local server, lists its tools and calls them', async () => {
    const store = new ConnectorStore(path.join(tmp, 'live.json'), codec)
    const c = await store.save(crm({ env: { CRM_TOKEN: 'tok-123' } }))
    const m = manager()
    try {
      await m.ensure(c)
      const status = m.status(c)
      expect(status.state).toBe('connected')
      expect(status.server).toEqual({ name: 'sagittarion-test-crm', version: '1.2.0' })
      const byName = Object.fromEntries(status.tools.map((t) => [t.name, t]))
      expect(byName.lookup_customer).toMatchObject({ title: 'Look up a customer', readOnly: true, destructive: false })
      expect(byName.flag_account).toMatchObject({ readOnly: false, destructive: false })
      // No annotations: MCP's default is that it may destroy something.
      expect(byName.broken).toMatchObject({ readOnly: false, destructive: true })
      const looked = await m.call(c, 'lookup_customer', { email: 'ann@corp.io' })
      expect(resultText(looked)).toContain('Customer ann@corp.io: plan Pro')
      // Started with its own environment variables.
      expect(resultText(await m.call(c, 'env', { name: 'CRM_TOKEN' }))).toBe('tok-123')
      const failed = await m.call(c, 'broken', {})
      expect(failed.isError).toBe(true)
      // Settings changed: the next use starts it again with the new ones.
      const changed = await store.save({ ...crm({ env: { CRM_TOKEN: 'tok-456' } }), id: c.id })
      expect(resultText(await m.call(changed, 'env', { name: 'CRM_TOKEN' }))).toBe('tok-456')
      await m.stop(c.id, true)
      expect(m.status(changed)).toMatchObject({ state: 'idle' })
      expect(m.status(changed).tools.length).toBe(4)
    } finally {
      await m.dispose()
    }
  })

  it('says plainly why a server could not start', async () => {
    const store = new ConnectorStore(path.join(tmp, 'broken.json'), codec)
    const m = manager()
    try {
      const missing = await store.save(crm({ name: 'Ghost', command: 'definitely-not-a-command-sagittarion', args: [] }))
      await expect(m.ensure(missing)).rejects.toThrow(/Could not find "definitely-not-a-command-sagittarion"/)
      expect(m.status(missing).state).toBe('error')
      const dies = await store.save(crm({ name: 'Dies', args: ['-e', 'console.error("bad config: no API key"); process.exit(1)'] }))
      await expect(m.ensure(dies)).rejects.toThrow(/bad config: no API key/)
      const off = await store.setEnabled(dies.id, false)
      expect(m.status(off).state).toBe('off')
    } finally {
      await m.dispose()
    }
  })
})

/** A small CRM schema for asks. */
function schema(): SchemaInfo {
  const col = (name: string, type: string, pk = 0) => ({ cid: 0, name, type, notnull: false, dflt: null, pk, hidden: 0 })
  return {
    kind: 'sqlite',
    tables: [{ name: 'orders', type: 'table', sql: null, columns: [col('id', 'INTEGER', 1), col('customer_email', 'TEXT'), col('total', 'REAL')], withoutRowid: false, rowidAlias: 'rowid', pk: ['id'] }],
    views: [],
    indexes: [],
    triggers: [],
    relations: []
  }
}

describe('Ask with connectors', () => {
  async function setup(permissions: Record<string, 'allow' | 'ask' | 'never'> = {}) {
    const store = new ConnectorStore(path.join(tmp, `ask-${Math.random().toString(36).slice(2)}.json`), codec)
    let c: Connector = await store.save(crm({ scope: 'selected', connectionIds: ['c1'] }))
    for (const [tool, p] of Object.entries(permissions)) c = await store.setToolPermission(c.id, tool, p)
    return { store, connector: c, manager: manager() }
  }

  it('offers the tools of connectors on for the connection, and none elsewhere', async () => {
    const { store, manager: m } = await setup({ broken: 'never' })
    try {
      const steps: AiProgressStep[] = []
      const tools = await connectorsForAsk({ store, manager: m, connectionId: 'c1', approve: async () => 'deny', onProgress: (s) => steps.push(s) })
      expect(tools?.tools.map((t) => t.name).sort()).toEqual(['mcp__crm__env', 'mcp__crm__flag_account', 'mcp__crm__lookup_customer'])
      expect(tools?.label('mcp__crm__lookup_customer')).toBe('CRM: Look up a customer')
      expect(steps.at(-1)).toMatchObject({ stepId: 'connectors', status: 'done', detail: '3 tools from CRM' })
      expect(await connectorsForAsk({ store, manager: m, connectionId: 'c2', approve: async () => 'deny' })).toBeUndefined()
      // Unless the chat turns it on.
      expect((await connectorsForAsk({ store, manager: m, connectionId: 'c2', overrides: { [(await store.list())[0].id]: true }, approve: async () => 'deny' }))?.tools.length).toBe(3)
    } finally {
      await m.dispose()
    }
  })

  it('asks before a tool that changes things; "always" stops asking', async () => {
    const { store, connector, manager: m } = await setup()
    try {
      const asked: { tool: string; args: Record<string, unknown> }[] = []
      let answer: ToolApprovalDecision = 'deny'
      const tools = (await connectorsForAsk({
        store,
        manager: m,
        connectionId: 'c1',
        approve: async (_c, tool, args) => {
          asked.push({ tool: tool.name, args })
          return answer
        }
      }))!
      // Read-only: runs without asking.
      expect((await tools.call('mcp__crm__lookup_customer', { email: 'ann@corp.io' })).content).toContain('plan Pro')
      expect(asked).toEqual([])
      const denied = await tools.call('mcp__crm__flag_account', { email: 'ann@corp.io', reason: 'late payments' })
      expect(denied).toMatchObject({ declined: true })
      expect(asked).toEqual([{ tool: 'flag_account', args: { email: 'ann@corp.io', reason: 'late payments' } }])
      answer = 'always'
      expect((await tools.call('mcp__crm__flag_account', { email: 'ann@corp.io', reason: 'late payments' })).content).toBe('Flagged ann@corp.io for review: late payments')
      expect((await store.get(connector.id))?.toolPermissions).toEqual({ flag_account: 'allow' })
      expect((await tools.call('mcp__crm__flag_account', { email: 'zed@corp.io', reason: 'audit' })).content).toContain('Flagged zed@corp.io')
      expect(asked.length).toBe(2)
    } finally {
      await m.dispose()
    }
  })

  it('gives the connector real values and protects its reply before the model sees it', async () => {
    const { store, manager: m } = await setup()
    try {
      const requests: ChatRequest[] = []
      const provider = recordingProvider((req, call) => {
        requests.push(req)
        if (call === 1) {
          // The model only ever saw a placeholder for the email in the question, and passes that on.
          const email = [...wireText(req.messages).matchAll(/<\|PII:EMAIL:[0-9A-F]{6}\|>/g)].map((x) => x[0])[0]
          return reply({ toolCalls: [{ id: 't1', name: 'mcp__crm__lookup_customer', args: { email } }], stopReason: 'tool_calls' })
        }
        return reply({ toolCalls: [{ id: 'p1', name: 'propose_query', args: { sql: 'SELECT count(*) FROM orders', explanation: 'Orders.', tables_used: ['orders'] } }], stopReason: 'tool_calls' })
      })
      const session = new PrivacySession({ engine: new PrivacyEngine({ schemaDetection: true }), policy, vault: new PiiVault(), host: 'api.example.com' })
      const connectors = await connectorsForAsk({ store, manager: m, connectionId: 'c1', approve: async () => 'deny' })
      const steps: AiProgressStep[] = []
      const result = await askDatabase(
        {
          kind: 'sqlite',
          serverVersion: '3.45.1',
          index: SchemaIndex.fromSchema(schema(), 'sqlite'),
          provider: ModelGateway.protected(provider, session),
          settings: { sendSampleValues: false, autoRun: true, schemaBudgetTokens: 8000 },
          runQuery: async (sql) => ({ results: [{ kind: 'rows', sql, columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 1 }], durationMs: 1, tx: false }),
          distinctValues: async () => null,
          connectors,
          onProgress: (s) => steps.push(s)
        },
        'What plan is radia@corp.io on, and how many orders do they have?'
      )
      expect(result.kind).toBe('query')
      expect(requests[0].tools?.some((t) => t.name === 'mcp__crm__lookup_customer')).toBe(true)
      expect(requests[0].system.map((b) => b.text).join('\n')).toContain('mcp__')
      // What the connector returned reached the model with its personal data replaced.
      const toolReply = requests[1].messages.find((x) => x.role === 'tool')!
      expect(toolReply.content).toContain('plan Pro')
      expect(toolReply.content).not.toContain('radia@corp.io')
      expect(toolReply.content).not.toContain('shiloh.romo@crm.example')
      expect(wireText(requests)).not.toContain('radia@corp.io')
      // The connector itself got the real email: its reply names it before protection, so the placeholder is the same.
      const placeholder = /<\|PII:EMAIL:[0-9A-F]{6}\|>/.exec(wireText(requests[0].messages))![0]
      expect(toolReply.content).toContain(`Customer ${placeholder}: plan Pro`)
      expect(steps.some((s) => s.message === 'Model used CRM: Look up a customer' && s.status === 'done')).toBe(true)
      // Both emails were withheld: the one in the question and the one in the connector's reply.
      if (result.kind === 'query') expect(result.privacy?.counts.EMAIL_ADDRESS).toBe(2)
    } finally {
      await m.dispose()
    }
  })
})
