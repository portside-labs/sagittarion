// The chat's place in the window: down the right side, beside whichever connection is in front, resizable, and folded
// to a strip at the edge when hidden. It stays mounted while folded, so an answer being worked on carries on.
import { useStore, CHAT_WIDTH } from '@/store'
import { chatStatus, statusRank, STATUS_LABELS, type ChatStatus } from '@/lib/chat'
import { AskPanel } from './AskPanel'
import { ChatDot } from './ChatDot'
import { Splitter } from './Splitter'

export function ChatPane() {
  const open = useStore((s) => s.chatOpen)
  const setOpen = useStore((s) => s.setChatOpen)
  const width = useStore((s) => s.chatWidth)
  const setWidth = useStore((s) => s.setChatWidth)
  const chats = useStore((s) => s.chats)
  const approvals = useStore((s) => s.approvals)

  // Folded, the strip shows the most urgent of the conversations' states.
  let top: { status: ChatStatus; unread: boolean } = { status: 'idle', unread: false }
  for (const c of chats) {
    const status = chatStatus(c, Boolean(c.requestId) && approvals.some((a) => a.requestId === c.requestId))
    const unread = Boolean(c.unread)
    if (statusRank(status, unread) > statusRank(top.status, top.unread)) top = { status, unread }
  }

  return (
    <>
      {open ? <Splitter onResize={(dx) => setWidth(useStore.getState().chatWidth - dx)} /> : null}
      <aside className="chat-pane" style={{ width, minWidth: CHAT_WIDTH.min }} hidden={!open} data-testid="chat-pane">
        <AskPanel onCollapse={() => setOpen(false)} />
      </aside>
      {open ? null : (
        <button
          className={`ask-strip status-${top.status}`}
          onClick={() => setOpen(true)}
          title={top.status === 'idle' ? 'Ask in plain English' : `Ask: ${STATUS_LABELS[top.status]}`}
          data-testid="ask-strip"
        >
          <ChatDot status={top.status} unread={top.unread} />
          <span className="ask-strip-label">Ask</span>
        </button>
      )}
    </>
  )
}
