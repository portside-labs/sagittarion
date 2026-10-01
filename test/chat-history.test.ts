// Conversations once closed: kept to find and continue, the latest 30 and none older than 30 days. And the names
// their tabs get from the model.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChatHistoryStore, HISTORY_LIMIT, HISTORY_TTL_MS } from '../src/main/store/chat-history'
import { cleanTitle, conversationTitle } from '../src/main/ai/title'
import { ModelGateway } from '../src/main/privacy/gateway'
import { PrivacyEngine } from '../src/main/privacy/engine'
import { PrivacySession } from '../src/main/privacy/session'
import { PiiVault } from '../src/main/privacy/vault'
import { closeOpenFence, revealedPart, revealStep } from '../src/renderer/src/lib/reveal'
import { historyMatches, whenText } from '../src/renderer/src/lib/chat'
import { policy, recordingProvider, reply, wireText } from './privacy/helpers'

let tmp: string
beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'sagittarion-history-'))
})
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const DAY = 24 * 60 * 60 * 1000
const chat = (id: string, at: number, question = `Question ${id}`) => ({
  id,
  title: `Chat ${id}`,
  input: '',
  databases: ['c1'],
  messages: [
    { id: `${id}-q`, role: 'user', text: question, ts: at },
    { id: `${id}-a`, role: 'assistant', question, ts: at, status: 'done', steps: [], result: { kind: 'clarify', message: `About ${id}: refunds went out.` } }
  ]
})

describe('ChatHistoryStore', () => {
  it('keeps closed conversations, latest first, and gives one back to continue', async () => {
    let now = 10 * DAY
    const file = path.join(tmp, 'a.json')
    const store = new ChatHistoryStore(file, () => now)
    await store.put(chat('a', now - 3000))
    await store.put(chat('b', now - 1000, 'Which refunds failed last week?'))
    // Nothing asked: nothing to keep.
    await store.put({ id: 'empty', messages: [], input: 'half typed' })
    const list = await new ChatHistoryStore(file, () => now).list()
    expect(list.map((i) => i.id)).toEqual(['b', 'a'])
    expect(list[0]).toMatchObject({ title: 'Chat b', questions: 1, preview: 'Which refunds failed last week?', databases: ['c1'], updatedAt: now - 1000 })
    expect(list[0].text).toContain('refunds went out')
    expect((await store.get('a'))?.messages).toHaveLength(2)
    // Closed again after more questions, it replaces its earlier copy.
    now += 5000
    await store.put({ ...chat('a', now), messages: [...chat('a', now - 3000).messages, ...chat('a', now).messages] })
    expect((await store.list()).map((i) => [i.id, i.questions])).toEqual([
      ['a', 2],
      ['b', 1]
    ])
    await store.remove('a')
    expect((await store.list()).map((i) => i.id)).toEqual(['b'])
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('keeps the latest 30, none older than 30 days', async () => {
    let now = 100 * DAY
    const store = new ChatHistoryStore(path.join(tmp, 'b.json'), () => now)
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) await store.put(chat(`c${i}`, now - (HISTORY_LIMIT + 5 - i) * 1000))
    const list = await store.list()
    expect(list).toHaveLength(HISTORY_LIMIT)
    expect(list[list.length - 1].id).toBe('c5')
    now += HISTORY_TTL_MS - 20 * 1000
    // Those last moved more than 20 seconds before the first was kept are past 30 days now: c15 to c34 are left.
    expect((await store.list()).map((i) => i.id)).toEqual(Array.from({ length: 20 }, (_, k) => `c${34 - k}`))
    expect(HISTORY_TTL_MS).toBe(30 * DAY)
  })
})

describe('a tab’s name from the model', () => {
  it('is tidied into a short line', () => {
    expect(cleanTitle('"Refund Trace for Ann."')).toBe('Refund Trace for Ann')
    expect(cleanTitle('Title: Monthly Revenue\nBecause the question asks about revenue.')).toBe('Monthly Revenue')
    expect(cleanTitle('**Late Orders By Region In The Northern Warehouses**')).toBe('Late Orders By Region In…')
    expect(cleanTitle('  ')).toBeNull()
  })

  it('is asked for through the gateway, protected like the question, and restored for the tab', async () => {
    const provider = recordingProvider((req) => {
      const marker = /<\|PII:EMAIL:[0-9A-F]{6}\|>/.exec(JSON.stringify(req.messages))![0]
      return reply({ text: `Refunds for ${marker}` })
    })
    const session = new PrivacySession({ engine: new PrivacyEngine({ schemaDetection: true }), policy, vault: new PiiVault(), host: 'api.example.com' })
    const title = await conversationTitle(ModelGateway.protected(provider, session), 'Did zed@corp.io get his refund?')
    expect(title).toBe('Refunds for zed@corp.io')
    expect(wireText(provider.requests)).not.toContain('zed@corp.io')
    expect(provider.requests[0].maxTokens).toBe(24)
    // A provider that fails leaves the tab its question.
    const failing = recordingProvider(() => {
      throw new Error('down')
    })
    expect(await conversationTitle(ModelGateway.protected(failing, session), 'Anything?')).toBeNull()
  })
})

describe('the chat pane', () => {
  it('reveals an answer at an easing pace, quick when far behind', () => {
    expect(revealStep(0, 16)).toBe(1)
    expect(revealStep(1000, 16)).toBeGreaterThan(50)
    expect(revealStep(1000, 16)).toBeGreaterThan(revealStep(100, 16))
    expect(revealedPart('ab😀cd', 3)).toBe('ab😀')
    expect(closeOpenFence('Here:\n```sql\nSELECT 1')).toBe('Here:\n```sql\nSELECT 1\n```')
    expect(closeOpenFence('```sql\nSELECT 1\n```\nDone.')).toBe('```sql\nSELECT 1\n```\nDone.')
  })

  it('lists past conversations by when they last moved, and finds them by any of their words', () => {
    const now = new Date(2026, 9, 1, 15, 0).getTime()
    expect(whenText(now - 20_000, now)).toBe('just now')
    expect(whenText(now - 5 * 60_000, now)).toBe('5m ago')
    expect(whenText(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(whenText(new Date(2026, 8, 30, 9).getTime(), now)).toBe('Yesterday')
    expect(whenText(new Date(2026, 8, 12).getTime(), now)).toBe('Sep 12')
    const item = { title: 'Refund Trace', preview: 'Did Ann get her refund?', text: 'Ann was refunded on Tuesday from billing.' }
    expect(historyMatches(item, 'billing ann')).toBe(true)
    expect(historyMatches(item, 'warehouse')).toBe(false)
    expect(historyMatches(item, '  ')).toBe(true)
  })
})
