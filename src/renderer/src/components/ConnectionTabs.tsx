import type { CSSProperties } from 'react'
import { useStore } from '@/store'
import { DbLogo } from './DbLogo'
import { Icon } from './Icons'

/** The connection tabs, as a strip across the top or a rail down the left, plus a "+" for one more. */
export function ConnectionTabs() {
  const tabs = useStore((s) => s.tabs)
  const activeConnectionId = useStore((s) => s.activeConnectionId)
  const showConnect = useStore((s) => s.showConnect)
  const activateTab = useStore((s) => s.activateTab)
  const closeTab = useStore((s) => s.closeTab)
  const showConnectScreen = useStore((s) => s.showConnectScreen)
  const mode = useStore((s) => s.ui.connectionTabs)
  const vertical = mode === 'vertical'

  return (
    <div className={vertical ? 'conn-rail' : 'conn-tabs'} role="tablist" aria-label="Open connections" data-testid="connection-tabs">
      {tabs.map((t) => {
        const active = t.connectionId === activeConnectionId && !showConnect
        const state = t.status === 'live' ? '' : t.status === 'connecting' ? ' · connecting' : t.status === 'error' ? ' · not connected' : ' · not connected yet'
        return (
          <div
            key={t.connectionId}
            className={`conn-tab status-${t.status} ${active ? 'active' : ''}`}
            role="tab"
            aria-selected={active}
            title={`${t.name} · ${t.target}${state}`}
            style={t.color ? ({ '--tab-color': t.color } as CSSProperties) : undefined}
            onClick={() => activateTab(t.connectionId)}
            onAuxClick={(e) => {
              if (e.button === 1) void closeTab(t.connectionId)
            }}
            data-testid="conn-tab"
            data-status={t.status}
          >
            {vertical ? (
              <span className="conn-tab-logo">
                <DbLogo kind={t.kind} size={20} />
              </span>
            ) : (
              <span className="conn-tab-dot" />
            )}
            <span className="conn-tab-name">{t.name}</span>
            <button
              className="conn-tab-close"
              title={t.status === 'live' ? 'Disconnect' : 'Close tab'}
              onClick={(e) => {
                e.stopPropagation()
                void closeTab(t.connectionId)
              }}
              data-testid="conn-tab-close"
            >
              <Icon name="x" size={11} />
            </button>
          </div>
        )
      })}
      <button className={`conn-tab-add ${showConnect ? 'active' : ''}`} title="Open another connection" onClick={() => showConnectScreen()} data-testid="conn-tab-add">
        <Icon name="plus" size={13} />
      </button>
    </div>
  )
}
