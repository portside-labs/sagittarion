// The chat beside the connections: conversations in tabs, kept while the user moves between connections, each with
// the databases it has in context.
import type { AiProgressEvent, AiResult } from '@shared/ai'
import type { SavedChat, WorkspaceState } from '@shared/types'

export type ChatStep = AiProgressEvent & { endedAt?: number }

export type ChatMessage =
  | { id: string; role: 'user'; text: string; ts: number }
  | {
      id: string
      role: 'assistant'
      question: string
      ts: number
      status: 'working' | 'done'
      steps: ChatStep[]
      result?: AiResult
      error?: string
      stepsOpen?: boolean
      /** The queries the model ran on its way to the answer are listed. */
      queriesOpen?: boolean
      /** The answer's query went into the editor in front and ran, as it arrived. */
      autoRan?: boolean
      /** The answer as the model writes it, while it streams; not kept. */
      draft?: string
      endedAt?: number
      /** The ask behind this answer, for "What was sent". Not kept across relaunches: that record lives in memory. */
      requestId?: string
    }

export interface ChatState {
  /** Its tab in the chat pane. */
  id: string
  /** The model's short name for it, from its first question; until then the question names the tab. */
  title?: string
  messages: ChatMessage[]
  input: string
  requestId: string | null
  /** Scopes Local AI Privacy's placeholders to this chat. New for every chat and after a relaunch; never saved. */
  conversationId: string
  /** Connectors this chat switched on or off over their usual scope, by id. */
  connectors?: Record<string, boolean>
  /**
   * The saved connections in context, by id; with more than one, questions are answered across all of them. Empty
   * until the first question: until then the chat follows the connection in front.
   */
  databases?: string[]
  /** An answer came while the user was not looking at this conversation. In memory only. */
  unread?: boolean
}

/**
 * Where a conversation stands, for the dot on its tab: answering, waiting for the user to allow a tool, asking the user
 * something, finished with an answer not yet seen, failed, or nothing to do.
 */
export type ChatStatus = 'idle' | 'working' | 'approval' | 'question' | 'done' | 'error'

/** `approval`: a tool in the conversation's ask waits for the user's yes or no. */
export function chatStatus(chat: Pick<ChatState, 'messages' | 'requestId' | 'unread'>, approval: boolean): ChatStatus {
  if (chat.requestId) return approval ? 'approval' : 'working'
  const last = [...chat.messages].reverse().find((m) => m.role === 'assistant')
  if (!last || last.role !== 'assistant') return 'idle'
  // A question back to the user stays open until they reply.
  if (!last.error && last.result?.kind === 'clarify' && /\?\s*$/.test(last.result.message)) return 'question'
  if (!chat.unread || last.result?.kind === 'cancelled') return 'idle'
  return last.error ? 'error' : 'done'
}

/** How urgent a status is, for the one dot the folded chat shows for all its conversations. */
export function statusRank(status: ChatStatus, unread: boolean): number {
  if (status === 'approval') return 6
  if (status === 'question') return unread ? 5 : 2
  if (status === 'error') return 4
  if (status === 'done') return 3
  if (status === 'working') return 1
  return 0
}

export const STATUS_LABELS: Record<ChatStatus, string> = {
  idle: 'Nothing waiting',
  working: 'Answering…',
  approval: 'Waiting for you: a tool needs your permission',
  question: 'Waiting for your reply',
  done: 'New answer',
  error: 'The answer failed'
}

export function emptyChat(): ChatState {
  return { id: crypto.randomUUID(), messages: [], input: '', requestId: null, conversationId: crypto.randomUUID() }
}

/** A chat's tab title: the model's name for it, else its first question cut at a word, else "New chat". */
export function chatTitle(chat: Pick<ChatState, 'messages' | 'title'>, max = 28): string {
  if (chat.title?.trim()) return chat.title.trim()
  const first = chat.messages.find((m) => m.role === 'user')
  const text = first && first.role === 'user' ? first.text.replace(/\s+/g, ' ').trim() : ''
  if (!text) return 'New chat'
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`
}

/** A saved chat, with anything that was still running marked as cut short. */
export function restoreChat(saved: SavedChat | undefined): ChatState {
  if (!saved || !Array.isArray(saved.messages)) return emptyChat()
  const messages = (saved.messages as ChatMessage[]).map((m): ChatMessage => {
    if (m.role !== 'assistant') return m
    // What an answer sent is held in memory only, so it cannot be inspected after a relaunch.
    const { requestId: _gone, ...rest } = m
    return rest.status === 'working' ? { ...rest, status: 'done', error: rest.error ?? 'Stopped before it finished.' } : rest
  })
  const databases = Array.isArray(saved.databases) ? saved.databases.filter((id): id is string => typeof id === 'string') : []
  return {
    id: typeof saved.id === 'string' && saved.id ? saved.id : crypto.randomUUID(),
    ...(typeof saved.title === 'string' && saved.title.trim() ? { title: saved.title.trim() } : {}),
    messages,
    input: typeof saved.input === 'string' ? saved.input : '',
    requestId: null,
    conversationId: crypto.randomUUID(),
    ...(databases.length ? { databases } : {})
  }
}

export function saveChat(chat: ChatState): SavedChat {
  // A draft being written is not kept: the answer is, once it has come.
  const messages = chat.messages.map((m) => {
    if (m.role !== 'assistant' || m.draft === undefined) return m
    const { draft: _draft, ...rest } = m
    return rest
  })
  return {
    id: chat.id,
    ...(chat.title ? { title: chat.title } : {}),
    messages,
    input: chat.input,
    ...(chat.databases?.length ? { databases: chat.databases } : {})
  }
}

/**
 * The chats to bring back from a workspace: its tabs; the one chat it had before there were tabs; or, from before the
 * chat moved out of the query tabs, each of those that has a conversation, on the connection it was on, the latest in
 * front.
 */
export function chatsFromWorkspace(state: WorkspaceState): { chats: SavedChat[]; activeChatId?: string } {
  if (Array.isArray(state.chats) && state.chats.length) return { chats: state.chats, activeChatId: state.activeChatId }
  if (state.chat) return { chats: [state.chat] }
  const found: { chat: SavedChat; at: number }[] = []
  for (const conn of state.connections ?? []) {
    for (const tab of conn.tabs ?? []) {
      const chat = tab.kind === 'query' ? tab.snapshot?.chat : undefined
      if (!chat || !Array.isArray(chat.messages) || !chat.messages.length) continue
      const at = Math.max(...chat.messages.map((m) => (typeof (m as { ts?: unknown }).ts === 'number' ? (m as { ts: number }).ts : 0)))
      found.push({ chat: { ...chat, databases: [conn.connectionId, ...(chat.databases ?? []).filter((id) => id !== conn.connectionId)] }, at })
    }
  }
  found.sort((a, b) => a.at - b.at)
  return { chats: found.map((f) => f.chat) }
}

/** A workspace without the chats its query tabs held before, once they are brought along. */
export function withoutTabChats(state: WorkspaceState): WorkspaceState {
  return {
    ...state,
    connections: (state.connections ?? []).map((conn) => ({
      ...conn,
      tabs: (conn.tabs ?? []).map((tab) => {
        if (tab.kind !== 'query' || !tab.snapshot?.chat) return tab
        const { chat: _moved, ...snapshot } = tab.snapshot
        return { ...tab, snapshot }
      })
    }))
  }
}

/**
 * The tabs once one is closed: the one beside it comes to the front if it was in front, and closing the last leaves a
 * new, empty chat, so there is always one to type in.
 */
export function closeChatTab(chats: ChatState[], id: string, activeChatId: string): { chats: ChatState[]; activeChatId: string } {
  const at = chats.findIndex((c) => c.id === id)
  if (at < 0) return { chats, activeChatId }
  const rest = chats.filter((c) => c.id !== id)
  if (!rest.length) {
    const fresh = emptyChat()
    return { chats: [fresh], activeChatId: fresh.id }
  }
  if (activeChatId !== id) return { chats: rest, activeChatId }
  return { chats: rest, activeChatId: rest[Math.min(at, rest.length - 1)].id }
}

/** When a conversation last moved, as the history lists it: "just now", "5m ago", "Yesterday", "Sep 28". */
export function whenText(ts: number, now = Date.now()): string {
  const minutes = Math.floor((now - ts) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  const day = (t: number) => {
    const d = new Date(t)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  const days = Math.round((day(now) - day(ts)) / 86_400_000)
  if (days === 0) return `${hours}h ago`
  if (days === 1) return 'Yesterday'
  const date = new Date(ts)
  if (days < 7) return date.toLocaleDateString('en-US', { weekday: 'long' })
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Whether a past conversation matches a search: every word, in its name, first question or what was said. */
export function historyMatches(item: { title: string; preview: string; text: string }, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = `${item.title}\n${item.preview}\n${item.text}`.toLowerCase()
  return words.every((w) => hay.includes(w))
}
