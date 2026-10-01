// Past conversations: the ones closed, kept to find and continue, the latest 30 and none older than 30 days.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { ChatHistoryItem } from '@shared/types'
import { useStore } from '@/store'
import { historyMatches, whenText } from '@/lib/chat'
import { errorMessage } from '@/lib/util'
import { Icon } from './Icons'

export function ChatHistoryButton({ onOpened }: { onOpened: () => void }) {
  const openPastChat = useStore((s) => s.openPastChat)
  const connections = useStore((s) => s.connections)
  const toast = useStore((s) => s.toast)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<ChatHistoryItem[] | null>(null)
  const [query, setQuery] = useState('')
  const [style, setStyle] = useState<CSSProperties | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const place = useCallback(() => {
    const r = buttonRef.current?.getBoundingClientRect()
    if (!r) return
    const width = 340
    setStyle({ top: r.bottom + 6, left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)), width, maxHeight: Math.max(200, Math.min(520, window.innerHeight - r.bottom - 20)) })
  }, [])

  useLayoutEffect(() => {
    if (!open) {
      setStyle(null)
      setQuery('')
      return
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, place])

  // The list as it is now, each time it opens.
  useEffect(() => {
    if (!open) return
    let current = true
    setItems(null)
    window.api.chats
      .history()
      .then((list) => current && setItems(list))
      .catch((e) => {
        if (current) setItems([])
        toast('error', 'Could not read past conversations', errorMessage(e))
      })
    return () => {
      current = false
    }
  }, [open, toast])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.('.chat-history, .chat-history-button')) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const reopen = async (id: string) => {
    setOpen(false)
    try {
      await openPastChat(id)
      onOpened()
    } catch (e) {
      toast('error', 'Could not open the conversation', errorMessage(e))
    }
  }

  const forget = async (id: string) => {
    try {
      await window.api.chats.forget(id)
      setItems((list) => (list ? list.filter((i) => i.id !== id) : list))
    } catch (e) {
      toast('error', 'Could not delete the conversation', errorMessage(e))
    }
  }

  const shown = items ? items.filter((i) => historyMatches(i, query)) : []
  const names = (ids: string[]) =>
    ids
      .map((id) => connections.find((c) => c.id === id)?.name)
      .filter(Boolean)
      .join(', ')

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`tab-new chat-history-button ${open ? 'open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Past conversations"
        aria-label="Past conversations"
        data-testid="chat-history-button"
      >
        <Icon name="clock" size={14} />
      </button>
      {open && style
        ? createPortal(
            <div className="connectors-menu chat-history" role="dialog" aria-label="Past conversations" style={style} data-testid="chat-history">
              <input
                className="text chat-history-search"
                placeholder="Search past conversations"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
                data-testid="chat-history-search"
              />
              {items === null ? <div className="connectors-menu-empty">Loading…</div> : null}
              {shown.map((item) => {
                const dbs = names(item.databases)
                return (
                  <div
                    key={item.id}
                    className="chat-history-item"
                    role="button"
                    tabIndex={0}
                    onClick={() => void reopen(item.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void reopen(item.id)
                    }}
                    data-testid="chat-history-item"
                    data-title={item.title}
                  >
                    <span className="chat-history-title">{item.title}</span>
                    <span className="chat-history-meta">
                      {whenText(item.updatedAt)} · {item.questions} question{item.questions === 1 ? '' : 's'}
                      {dbs ? ` · ${dbs}` : ''}
                    </span>
                    {item.preview && item.preview !== item.title ? <span className="chat-history-preview">{item.preview}</span> : null}
                    <button
                      type="button"
                      className="chat-history-delete"
                      onClick={(e) => {
                        e.stopPropagation()
                        void forget(item.id)
                      }}
                      title="Delete this conversation"
                      aria-label={`Delete ${item.title}`}
                      data-testid="chat-history-delete"
                    >
                      <Icon name="trash" size={11} />
                    </button>
                  </div>
                )
              })}
              {items && !shown.length ? (
                <div className="connectors-menu-empty">{items.length ? 'No past conversation matches.' : 'Conversations you close are kept here, to open again.'}</div>
              ) : null}
              <div className="connectors-menu-note">Closed conversations are kept for 30 days, the latest 30.</div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}
