import { STATUS_LABELS, type ChatStatus } from '@/lib/chat'

/**
 * A conversation's state as a dot: quiet while nothing waits or the model is answering, and standing out when the user
 * is needed: a tool to allow, a question to answer, an answer not yet seen.
 */
export function ChatDot({ status, unread }: { status: ChatStatus; unread?: boolean }) {
  const label = STATUS_LABELS[status]
  return <span className={`chat-dot ${status} ${unread ? 'fresh' : ''}`} role="img" aria-label={label} title={label} data-status={status} data-testid="chat-dot" />
}
