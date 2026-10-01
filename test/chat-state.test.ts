// The chat beside the connections: conversations in tabs, kept with the workspace, and brought along from the query
// tabs that each had one.
import { describe, expect, it } from 'vitest'
import type { WorkspaceState } from '../src/shared/types'
import { chatStatus, chatTitle, chatsFromWorkspace, closeChatTab, emptyChat, restoreChat, saveChat, statusRank, withoutTabChats, type ChatState } from '../src/renderer/src/lib/chat'

const message = (ts: number, text = 'q') => ({ id: `m${ts}`, role: 'user', text, ts })

function workspace(partial: Partial<WorkspaceState>): WorkspaceState {
  return { version: 1, activeConnectionId: null, showConnect: false, connections: [], ...partial }
}

describe('a conversation in the workspace', () => {
  it('comes back as it was saved, with an answer that was still running marked as cut short', () => {
    const chat = restoreChat({
      id: 'tab-1',
      messages: [message(1), { id: 'a', role: 'assistant', question: 'q', ts: 2, status: 'working', steps: [], requestId: 'r1' }],
      input: 'half typed',
      databases: ['c1', 'c2']
    })
    expect(chat.id).toBe('tab-1')
    expect(chat.input).toBe('half typed')
    expect(chat.databases).toEqual(['c1', 'c2'])
    expect(chat.requestId).toBeNull()
    expect(chat.messages[1]).toMatchObject({ status: 'done', error: 'Stopped before it finished.' })
    expect(chat.messages[1]).not.toHaveProperty('requestId')
    expect(saveChat(chat)).toEqual({ id: 'tab-1', messages: chat.messages, input: 'half typed', databases: ['c1', 'c2'] })
    // Placeholders are scoped to the conversation in memory only: a new scope after a relaunch.
    expect(restoreChat(saveChat(chat)).conversationId).not.toBe(chat.conversationId)
  })

  it('is named by the question it began with', () => {
    expect(chatTitle(emptyChat())).toBe('New chat')
    expect(chatTitle({ messages: [message(1, '  Which   orders were refunded?  ')] } as unknown as ChatState)).toBe('Which orders were refunded?')
    // Too long for a tab, cut at a word.
    expect(chatTitle({ messages: [message(1, 'Trace the refund for order 1042 from billing to support and the warehouse')] } as unknown as ChatState)).toBe(
      'Trace the refund for order…'
    )
    // Once the model has named it, that name.
    expect(chatTitle({ title: 'Refund Trace', messages: [message(1, 'Trace the refund for order 1042')] } as unknown as ChatState)).toBe('Refund Trace')
  })

  it('brings back its tabs; or the one chat from before tabs; or each query tab’s chat, the latest in front', () => {
    const tabs = workspace({ chats: [{ id: 'a', messages: [], input: '' }, { id: 'b', messages: [], input: '' }], activeChatId: 'a', chat: { messages: [], input: 'old' } })
    expect(chatsFromWorkspace(tabs)).toEqual({ chats: tabs.chats, activeChatId: 'a' })
    expect(chatsFromWorkspace(workspace({ chat: { messages: [], input: 'one' } }))).toEqual({ chats: [{ messages: [], input: 'one' }] })

    const old = workspace({
      connections: [
        {
          connectionId: 'c1',
          activeTabId: 't1',
          queryCounter: 1,
          tabs: [{ id: 't1', kind: 'query', title: 'Query 1', snapshot: { sql: '', limit: 1000, chat: { messages: [message(9, 'latest')], input: 'x', databases: ['c3'] } } }]
        },
        {
          connectionId: 'c2',
          activeTabId: 't2',
          queryCounter: 2,
          tabs: [
            { id: 't2', kind: 'query', title: 'Query 1', snapshot: { sql: '', limit: 1000, chat: { messages: [message(5, 'earlier')], input: '' } } },
            { id: 't3', kind: 'query', title: 'Query 2', snapshot: { sql: '', limit: 1000, chat: { messages: [], input: '' } } }
          ]
        }
      ]
    })
    expect(chatsFromWorkspace(old)).toEqual({
      chats: [
        { messages: [message(5, 'earlier')], input: '', databases: ['c2'] },
        { messages: [message(9, 'latest')], input: 'x', databases: ['c1', 'c3'] }
      ]
    })
    const cleaned = withoutTabChats(old)
    expect(JSON.stringify(cleaned)).not.toContain('"chat"')
    expect(cleaned.connections[1].tabs[0]).toMatchObject({ id: 't2', snapshot: { sql: '', limit: 1000 } })
    expect(chatsFromWorkspace(workspace({}))).toEqual({ chats: [] })
  })
})

describe('closing a conversation tab', () => {
  const tab = (id: string) => ({ ...emptyChat(), id })

  it('brings the one beside it to the front, and always leaves one to type in', () => {
    const chats = [tab('a'), tab('b'), tab('c')]
    expect(closeChatTab(chats, 'b', 'b')).toMatchObject({ activeChatId: 'c' })
    expect(closeChatTab(chats, 'c', 'c')).toMatchObject({ activeChatId: 'b' })
    // Closing one behind keeps the one in front.
    const behind = closeChatTab(chats, 'a', 'c')
    expect(behind.chats.map((c) => c.id)).toEqual(['b', 'c'])
    expect(behind.activeChatId).toBe('c')
    const last = closeChatTab([tab('a')], 'a', 'a')
    expect(last.chats).toHaveLength(1)
    expect(last.chats[0].id).not.toBe('a')
    expect(last.activeChatId).toBe(last.chats[0].id)
    expect(closeChatTab(chats, 'zz', 'a')).toEqual({ chats, activeChatId: 'a' })
  })
})

describe('the dot on a conversation tab', () => {
  const answer = (partial: Record<string, unknown>) => ({ id: 'a', role: 'assistant', question: 'q', ts: 2, status: 'done', steps: [], ...partial })
  const chat = (partial: Partial<ChatState> & { messages?: unknown[] }) => ({ ...emptyChat(), ...partial }) as ChatState
  const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, requests: 1, toolCalls: 0, provider: 'mock', model: 'm' }

  it('is quiet with nothing waiting, and while the model answers', () => {
    expect(chatStatus(emptyChat(), false)).toBe('idle')
    expect(chatStatus(chat({ requestId: 'r1' }), false)).toBe('working')
    // Seen, a finished answer asks for nothing.
    expect(chatStatus(chat({ messages: [message(1), answer({ result: { kind: 'clarify', message: 'Here it is.', usage } })] }), false)).toBe('idle')
  })

  it('asks for the user while a tool waits, or the model asked them something', () => {
    expect(chatStatus(chat({ requestId: 'r1' }), true)).toBe('approval')
    const asked = chat({ messages: [message(1), answer({ result: { kind: 'clarify', message: 'Which month do you mean?', usage } })] })
    expect(chatStatus(asked, false)).toBe('question')
    // Answered by the user's next question, it no longer waits.
    expect(chatStatus({ ...asked, requestId: 'r2' }, false)).toBe('working')
  })

  it('marks an answer or a failure that came while the user looked elsewhere, until they see it', () => {
    const done = chat({ unread: true, messages: [message(1), answer({ result: { kind: 'clarify', message: 'Done.', usage } })] })
    expect(chatStatus(done, false)).toBe('done')
    expect(chatStatus({ ...done, unread: false }, false)).toBe('idle')
    expect(chatStatus(chat({ unread: true, messages: [message(1), answer({ error: 'The provider refused.' })] }), false)).toBe('error')
    expect(chatStatus(chat({ unread: true, messages: [message(1), answer({ result: { kind: 'cancelled', usage } })] }), false)).toBe('idle')
  })

  it('folded, shows the most urgent of all the conversations', () => {
    const ranked = (['idle', 'working', 'done', 'error', 'question', 'approval'] as const).map((s) => statusRank(s, true))
    expect([...ranked].sort((a, b) => a - b)).toEqual(ranked)
    // A question already seen ranks below a new answer.
    expect(statusRank('question', false)).toBeLessThan(statusRank('done', true))
  })
})
