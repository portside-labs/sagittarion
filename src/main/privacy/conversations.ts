// Conversation-scoped vaults, in memory only. A chat keeps its placeholders while it is in use and loses them when
// it is reset, its connection closes, it sits idle, or too many chats are open; its own sealed history brings them
// back when it continues. Unrelated chats never share placeholders.
import { PiiVault } from './vault'

interface Held {
  vault: PiiVault
  used: number
}

export class ConversationVaults {
  private readonly held = new Map<string, Held>()

  constructor(
    private readonly opts: { idleMs: number; max: number } = { idleMs: 15 * 60_000, max: 64 },
    private readonly now: () => number = Date.now
  ) {}

  private static key(sessionId: string, conversationId: string): string {
    return `${sessionId}\u0000${conversationId}`
  }

  vault(sessionId: string, conversationId: string): PiiVault {
    this.sweep()
    const key = ConversationVaults.key(sessionId, conversationId)
    let held = this.held.get(key)
    if (!held) {
      held = { vault: new PiiVault(), used: 0 }
      this.held.set(key, held)
    }
    held.used = this.now()
    // Most recently used last, so the oldest go first when there are too many.
    this.held.delete(key)
    this.held.set(key, held)
    while (this.held.size > this.opts.max) this.held.delete(this.held.keys().next().value!)
    return held.vault
  }

  /** The chat's vault if it is still held; never creates one. */
  peek(sessionId: string, conversationId: string): PiiVault | undefined {
    this.sweep()
    return this.held.get(ConversationVaults.key(sessionId, conversationId))?.vault
  }

  forget(conversationId: string): void {
    for (const key of [...this.held.keys()]) if (key.endsWith(`\u0000${conversationId}`)) this.held.delete(key)
  }

  forgetSession(sessionId: string): void {
    for (const key of [...this.held.keys()]) if (key.startsWith(`${sessionId}\u0000`)) this.held.delete(key)
  }

  get size(): number {
    return this.held.size
  }

  private sweep(): void {
    const cutoff = this.now() - this.opts.idleMs
    for (const [key, h] of this.held) if (h.used < cutoff) this.held.delete(key)
  }
}
