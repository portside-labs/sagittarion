import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ChatHistoryItem, SavedChat } from '@shared/types'

/** The conversations kept once closed: the latest 30, none older than 30 days. */
export const HISTORY_LIMIT = 30
export const HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000

type Kept = SavedChat & { id: string; updatedAt: number }

interface Message {
  role?: unknown
  text?: unknown
  ts?: unknown
  result?: { kind?: unknown; message?: unknown; explanation?: unknown }
}

function lastActivity(chat: SavedChat): number {
  let at = 0
  for (const m of chat.messages as Message[]) if (typeof m?.ts === 'number' && m.ts > at) at = m.ts
  return at
}

function questions(chat: SavedChat): string[] {
  return (chat.messages as Message[]).flatMap((m) => (m?.role === 'user' && typeof m.text === 'string' ? [m.text] : []))
}

/** What a closed conversation is listed with, and searched by. */
export function historyItem(chat: Kept): ChatHistoryItem {
  const asked = questions(chat)
  const words: string[] = []
  for (const m of chat.messages as Message[]) {
    if (m?.role === 'user' && typeof m.text === 'string') words.push(m.text)
    const said = m?.result?.message ?? m?.result?.explanation
    if (typeof said === 'string') words.push(said)
  }
  return {
    id: chat.id,
    title: chat.title || asked[0]?.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Conversation',
    updatedAt: chat.updatedAt,
    questions: asked.length,
    preview: asked[0]?.replace(/\s+/g, ' ').trim().slice(0, 140) ?? '',
    databases: Array.isArray(chat.databases) ? chat.databases : [],
    text: words.join('\n').slice(0, 4000)
  }
}

/** Closed conversations, in chat-history.json, so they can be found and continued. */
export class ChatHistoryStore {
  private cache: Kept[] | null = null

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now
  ) {}

  private async load(): Promise<Kept[]> {
    if (this.cache) return this.cache
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'))
      const list: Kept[] = Array.isArray(parsed?.chats) ? parsed.chats.filter((c: any) => c && typeof c.id === 'string' && Array.isArray(c.messages)) : []
      this.cache = this.prune(list)
    } catch {
      this.cache = []
    }
    return this.cache
  }

  /** The latest first, at most HISTORY_LIMIT, none older than HISTORY_TTL_MS. */
  private prune(list: Kept[]): Kept[] {
    const cutoff = this.now() - HISTORY_TTL_MS
    return list
      .filter((c) => c.updatedAt >= cutoff)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, HISTORY_LIMIT)
  }

  private async persist(list: Kept[]): Promise<void> {
    this.cache = list
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    await fs.writeFile(tmp, JSON.stringify({ version: 1, chats: list }), { encoding: 'utf8', mode: 0o600 })
    await fs.rename(tmp, this.file)
  }

  async list(): Promise<ChatHistoryItem[]> {
    return this.prune(await this.load()).map(historyItem)
  }

  async get(id: string): Promise<SavedChat | null> {
    const found = (await this.load()).find((c) => c.id === id)
    return found ? { ...found } : null
  }

  /** Keeps a closed conversation, replacing an earlier copy of it. One with nothing asked is not worth keeping. */
  async put(chat: SavedChat): Promise<void> {
    if (typeof chat?.id !== 'string' || !chat.id || !Array.isArray(chat.messages) || !questions(chat).length) return
    const kept: Kept = { ...chat, id: chat.id, updatedAt: lastActivity(chat) || this.now() }
    await this.persist(this.prune([kept, ...(await this.load()).filter((c) => c.id !== chat.id)]))
  }

  async remove(id: string): Promise<void> {
    const list = await this.load()
    if (list.some((c) => c.id === id)) await this.persist(list.filter((c) => c.id !== id))
  }
}
