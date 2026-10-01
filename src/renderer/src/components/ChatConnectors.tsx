// The chat's side of connectors: a menu beside the model to switch each one on or off for this chat, and the card that
// asks before a tool runs, as in Claude Desktop.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { activeInChat, appliesTo, type ToolApprovalDecision, type ToolApprovalRequest } from '@shared/connectors'
import { useStore } from '@/store'
import { Icon } from './Icons'
import { Switch, connectorStatusText, signInTo } from './ConnectorsSettings'

export function ChatConnectorsButton({
  connectionId,
  overrides,
  onChange
}: {
  /** The chat's database connection, or all of them in a chat across several. */
  connectionId: string | (string | undefined)[] | undefined
  overrides: Record<string, boolean> | undefined
  onChange: (next: Record<string, boolean>) => void
}) {
  const connectors = useStore((s) => s.connectors)
  const putConnector = useStore((s) => s.putConnector)
  const toast = useStore((s) => s.toast)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const [open, setOpen] = useState(false)
  const [style, setStyle] = useState<CSSProperties | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const enabled = connectors.filter((c) => c.enabled)
  const active = enabled.filter((c) => activeInChat(c, connectionId, overrides))

  const place = useCallback(() => {
    const r = buttonRef.current?.getBoundingClientRect()
    if (!r) return
    const width = 280
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))
    setStyle({ left, bottom: window.innerHeight - r.top + 6, width, maxHeight: Math.max(160, Math.min(360, r.top - 14)) })
  }, [])

  useLayoutEffect(() => {
    if (!open) return setStyle(null)
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.('.connectors-menu, .connectors-button')) setOpen(false)
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

  /** The chat's choice for one connector; one that matches its scope is dropped, so a later change in Settings applies. */
  const toggle = (id: string, on: boolean) => {
    const c = connectors.find((x) => x.id === id)
    const next = { ...(overrides ?? {}) }
    if (c && appliesTo(c, connectionId) === on) delete next[id]
    else next[id] = on
    onChange(next)
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`connectors-button ${open ? 'open' : ''} ${active.length ? 'active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={active.length ? `Connectors in this chat: ${active.map((c) => c.name).join(', ')}` : 'Connectors: tools from your other systems'}
        data-testid="connectors-button"
      >
        <Icon name="plug" size={12} />
        {active.length ? <span className="connectors-count">{active.length}</span> : null}
      </button>
      {open && style
        ? createPortal(
            <div className="connectors-menu" role="menu" style={style} data-testid="connectors-menu">
              <div className="connectors-menu-title">Connectors</div>
              {enabled.map((c) => {
                const on = activeInChat(c, connectionId, overrides)
                const usual = appliesTo(c, connectionId)
                return (
                  <div key={c.id} className="connectors-menu-item" data-testid="chat-connector" data-name={c.name}>
                    <span className={`connector-dot ${c.status.state}`} />
                    <span className="connectors-menu-text">
                      <span className="connectors-menu-name">{c.name}</span>
                      <span className="connectors-menu-sub">
                        {c.status.state === 'error'
                          ? 'Could not start'
                          : c.status.state === 'signin' || c.status.state === 'authorizing'
                            ? connectorStatusText(c)
                            : usual
                              ? connectorStatusText(c)
                              : Array.isArray(connectionId)
                                ? 'Not on for these databases by default'
                                : 'Not on for this connection by default'}
                      </span>
                    </span>
                    {c.status.state === 'signin' ? (
                      <button type="button" className="btn small" onClick={() => void signInTo(c, putConnector, toast)} data-testid="chat-connector-sign-in">
                        Sign in
                      </button>
                    ) : null}
                    <Switch checked={on} onChange={(v) => toggle(c.id, v)} label={on ? `Stop using ${c.name} in this chat` : `Use ${c.name} in this chat`} testId="chat-connector-switch" />
                  </div>
                )
              })}
              {!enabled.length ? (
                <div className="connectors-menu-empty">{connectors.length ? 'Every connector is switched off in Settings.' : 'Connect an MCP server to let Ask look things up in your other tools.'}</div>
              ) : null}
              <button
                type="button"
                className="model-item manage"
                role="menuitem"
                onClick={() => {
                  setOpen(false)
                  setSettingsOpen(true, { tab: 'connectors' })
                }}
                data-testid="connectors-manage"
              >
                <Icon name="settings" size={12} /> {connectors.length ? 'Manage connectors…' : 'Add a connector…'}
              </button>
            </div>,
            document.body
          )
        : null}
    </>
  )
}

/** A tool waiting for the user, with exactly what it would be sent. */
export function ToolApprovalCard({ request, onAnswer }: { request: ToolApprovalRequest; onAnswer: (d: ToolApprovalDecision) => void }) {
  const { tool, connector, args } = request
  const name = tool.title ?? tool.name
  const shown = JSON.stringify(args, null, 2)
  return (
    <div className="tool-approval" role="alertdialog" aria-label={`Allow ${connector.name} to use ${name}?`} data-testid="tool-approval">
      <div className="tool-approval-head">
        <Icon name="plug" size={13} />
        <span>
          Allow <b>{connector.name}</b> to use <b>{name}</b>?
        </span>
      </div>
      <div className="tool-approval-note">
        {tool.destructive ? 'It may change or delete things in ' : 'It may change things in '}
        {connector.name}. It gets these values, as they are, from this computer:
      </div>
      {shown !== '{}' ? <pre className="tool-approval-args">{shown}</pre> : null}
      <div className="tool-approval-actions">
        <button type="button" className="btn small primary" onClick={() => onAnswer('once')} data-testid="tool-allow-once">
          Allow once
        </button>
        <button type="button" className="btn small" onClick={() => onAnswer('always')} data-testid="tool-allow-always">
          Always allow
        </button>
        <span className="spacer" />
        <button type="button" className="btn small ghost" onClick={() => onAnswer('deny')} data-testid="tool-deny">
          Deny
        </button>
      </div>
    </div>
  )
}
