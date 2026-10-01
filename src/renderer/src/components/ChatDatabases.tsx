// The databases the chat has in context: the connection in front until the first question, then the ones it settled on,
// with others added to ask across them, as when tracing an incident through several systems. The model is told about
// each one and chooses where to look.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { KIND_LABELS } from '@shared/types'
import { normalizeResultsAccess, readsResults, withResultsFor } from '@shared/ai'
import { useStore, type OpenTab } from '@/store'
import { errorMessage } from '@/lib/util'
import { Icon } from './Icons'

/** How a database in the chat is doing, from its connection tab: the dot beside its name. */
function dotFor(tab: OpenTab | undefined): { dot: string; note: string } {
  if (tab?.status === 'live') return { dot: 'connected', note: 'Connected' }
  if (tab?.status === 'connecting') return { dot: 'connecting', note: tab.progress || 'Connecting…' }
  if (tab?.status === 'error') return { dot: 'error', note: tab.error ?? 'Could not connect' }
  return { dot: '', note: 'Connects when the chat asks' }
}

export function ChatDatabases({
  databases,
  following,
  suggestion,
  onChange
}: {
  /** The saved connections in context, by id, the chat's own first. */
  databases: string[]
  /** Nothing asked yet: the chat follows the connection in front, which is all `databases` holds. */
  following: boolean
  /** The connection in front when the chat does not have it: one click adds it. */
  suggestion: string | null
  onChange: (next: string[]) => void
}) {
  const connections = useStore((s) => s.connections)
  const tabs = useStore((s) => s.tabs)
  const ensureSession = useStore((s) => s.ensureSession)
  const toast = useStore((s) => s.toast)
  const settings = useStore((s) => s.settings)
  const loadSettings = useStore((s) => s.loadSettings)
  const access = settings?.agent.readResults

  /** Lets Ask read query results on a database, or stops it: the same setting as in Settings → Models. */
  const toggleResults = async (id: string, name: string) => {
    if (!settings) return
    try {
      const next = withResultsFor(normalizeResultsAccess(access), id, !readsResults(access, id), connections.map((c) => c.id))
      await window.api.settings.update({ agent: { readResults: next } })
      await loadSettings()
    } catch (e) {
      toast('error', `Could not change what Ask reads on ${name}`, errorMessage(e))
    }
  }
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [style, setStyle] = useState<CSSProperties | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const inChat = databases.flatMap((id) => connections.find((c) => c.id === id) ?? [])
  const suggested = suggestion ? connections.find((c) => c.id === suggestion) : undefined
  const candidates = useMemo(() => connections.filter((c) => !databases.includes(c.id)).sort((a, b) => a.name.localeCompare(b.name)), [connections, databases])
  const shown = filter.trim() ? candidates.filter((c) => `${c.name} ${c.group ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase())) : candidates

  const place = useCallback(() => {
    const r = buttonRef.current?.getBoundingClientRect()
    if (!r) return
    const width = 280
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
    setStyle({ left, bottom: window.innerHeight - r.top + 6, width, maxHeight: Math.max(160, Math.min(380, r.top - 14)) })
  }, [])

  useLayoutEffect(() => {
    if (!open) {
      setStyle(null)
      setFilter('')
      return
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.('.chat-db-menu, .chat-db-add')) setOpen(false)
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

  const add = (id: string) => {
    setOpen(false)
    onChange([...databases, id])
    // Connected now rather than at the next question, so a problem shows while the user is still here.
    const name = connections.find((c) => c.id === id)?.name ?? 'the database'
    ensureSession(id).catch((e) => toast('error', `Could not connect to ${name}`, errorMessage(e)))
  }

  return (
    <div className="chat-databases" data-testid="chat-databases">
      {inChat.map((cfg) => {
        const { dot, note } = dotFor(tabs.find((t) => t.connectionId === cfg.id))
        const title = following
          ? `${cfg.name} · ${KIND_LABELS[cfg.kind]} · the connection in front; the chat stays on it once you ask`
          : `${cfg.name} · ${KIND_LABELS[cfg.kind]} · ${note}`
        return (
          <span key={cfg.id} className={`chat-db ${following ? 'following' : ''}`} title={title} data-testid="chat-db" data-name={cfg.name} data-state={dot || 'closed'}>
            <span className={`connector-dot ${dot}`} />
            <span className="chat-db-name">{cfg.name}</span>
            {(() => {
              const reads = readsResults(access, cfg.id)
              return (
                <button
                  type="button"
                  className={`chat-db-results ${reads ? 'on' : ''}`}
                  onClick={() => void toggleResults(cfg.id, cfg.name)}
                  title={
                    reads
                      ? `Ask reads query results on ${cfg.name}, up to 50 rows each, protected by Local AI Privacy, to work questions out itself. Click to stop.`
                      : `Ask writes queries for ${cfg.name} without seeing their results. Click to let it read them, so it can work questions out itself.`
                  }
                  aria-label={reads ? `Stop Ask reading results on ${cfg.name}` : `Let Ask read results on ${cfg.name}`}
                  aria-pressed={reads}
                  data-testid="chat-db-results"
                >
                  <Icon name={reads ? 'eye' : 'eye-off'} size={11} />
                </button>
              )
            })()}
            {following ? null : (
              <button
                type="button"
                className="chat-db-remove"
                onClick={() => onChange(databases.filter((x) => x !== cfg.id))}
                title={`Leave ${cfg.name} out of this chat`}
                aria-label={`Leave ${cfg.name} out of this chat`}
                data-testid="chat-db-remove"
              >
                <Icon name="x" size={10} />
              </button>
            )}
          </span>
        )
      })}
      {suggested ? (
        <button
          type="button"
          className="chat-db suggested"
          onClick={() => onChange([...databases, suggested.id])}
          title={`${suggested.name} is in front but not in this chat: add it to ask across both`}
          data-testid="chat-db-suggested"
          data-name={suggested.name}
        >
          <Icon name="plus" size={10} />
          <span className="chat-db-name">{suggested.name}</span>
        </button>
      ) : null}
      <button
        ref={buttonRef}
        type="button"
        className={`chat-db-add ${open ? 'open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Add a database to this chat, to ask across several"
        data-testid="chat-db-add"
      >
        <Icon name="plus" size={11} />
        {inChat.length > 1 || suggested ? null : <span>Database</span>}
      </button>
      {open && style
        ? createPortal(
            <div className="connectors-menu chat-db-menu" role="menu" style={style} data-testid="chat-db-menu">
              <div className="connectors-menu-title">Add to this chat</div>
              {candidates.length > 8 ? (
                <input className="text chat-db-filter" placeholder="Filter connections" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus data-testid="chat-db-filter" />
              ) : null}
              {shown.map((cfg) => {
                const { dot } = dotFor(tabs.find((t) => t.connectionId === cfg.id))
                return (
                  <button key={cfg.id} type="button" className="connectors-menu-item chat-db-option" role="menuitem" onClick={() => add(cfg.id)} data-testid="chat-db-option" data-name={cfg.name}>
                    <span className={`connector-dot ${dot}`} />
                    <span className="connectors-menu-text">
                      <span className="connectors-menu-name">{cfg.name}</span>
                      <span className="connectors-menu-sub">
                        {KIND_LABELS[cfg.kind]}
                        {cfg.group ? ` · ${cfg.group}` : ''}
                      </span>
                    </span>
                  </button>
                )
              })}
              {!candidates.length ? (
                <div className="connectors-menu-empty">{connections.length > 1 ? 'Every saved connection is in this chat.' : 'Save another connection to ask across databases.'}</div>
              ) : null}
              <div className="connectors-menu-note">The model sees each database&apos;s tables and decides where to look; queries stay read-only.</div>
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
