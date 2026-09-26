import { useMemo, type CSSProperties } from 'react'
import { useStore, type OpenTab } from '@/store'
import { useDragSort } from '@/lib/drag-sort'
import { groupByConnection, moveTab, tabUnits } from '@/lib/tab-groups'
import { DbLogo } from './DbLogo'
import { Icon } from './Icons'

/**
 * The connection tabs, as a strip across the top or a rail down the left, plus a "+" for one more. The tabs of a
 * connection group sit together behind the group's label, as a browser's tab groups do: a click on the label folds
 * the group up to just the label, and another opens it. Tabs drag into a new order within their group, and a group
 * drags along by its label.
 */
export function ConnectionTabs() {
  const tabs = useStore((s) => s.tabs)
  const connections = useStore((s) => s.connections)
  const groupStyles = useStore((s) => s.groupStyles)
  const collapsedTabGroups = useStore((s) => s.collapsedTabGroups)
  const toggleTabGroup = useStore((s) => s.toggleTabGroup)
  const activeConnectionId = useStore((s) => s.activeConnectionId)
  const showConnect = useStore((s) => s.showConnect)
  const activateTab = useStore((s) => s.activateTab)
  const closeTab = useStore((s) => s.closeTab)
  const reorderTabs = useStore((s) => s.reorderTabs)
  const showConnectScreen = useStore((s) => s.showConnectScreen)
  const mode = useStore((s) => s.ui.connectionTabs)
  const vertical = mode === 'vertical'
  const groupOf = useMemo(() => groupByConnection(connections), [connections])
  const units = tabUnits(tabs, groupOf)
  const sort = useDragSort(vertical ? 'y' : 'x', (list, from, to) => reorderTabs(moveTab(units, list.dataset.group ?? null, from, to)))

  const renderTab = (t: OpenTab, group?: string) => {
    const active = t.connectionId === activeConnectionId && !showConnect
    const color = group ? groupStyles[group]?.color : undefined
    const state =
      t.status === 'live'
        ? t.link === 'down'
          ? ' · disconnected, reconnects on next use'
          : t.link === 'reconnecting'
            ? ' · reconnecting'
            : ''
        : t.status === 'connecting'
          ? ' · connecting'
          : t.status === 'error'
            ? ' · not connected'
            : ' · not connected yet'
    return (
      <div
        key={t.connectionId}
        className={`conn-tab status-${t.status} ${t.link ? `link-${t.link}` : ''} ${active ? 'active' : ''}`}
        role="tab"
        aria-selected={active}
        title={`${t.name} · ${t.target}${group ? ` · ${group}` : ''}${state}`}
        style={color ? ({ '--tab-color': color } as CSSProperties) : undefined}
        onClick={() => activateTab(t.connectionId)}
        onAuxClick={(e) => {
          if (e.button === 1) void closeTab(t.connectionId)
        }}
        data-sort-item
        data-sort-handle
        data-testid="conn-tab"
        data-status={t.status}
        data-link={t.link ?? 'up'}
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
  }

  return (
    <div className={vertical ? 'conn-rail' : 'conn-tabs'} role="tablist" aria-label="Open connections" data-testid="connection-tabs" data-sort-list {...sort}>
      {units.map((u) => {
        if (u.kind === 'tab') return renderTab(u.tab)
        const color = groupStyles[u.name]?.color
        const collapsed = collapsedTabGroups.includes(u.name)
        const count = u.tabs.length === 1 ? '1 connection' : `${u.tabs.length} connections`
        return (
          <div
            key={`group:${u.name}`}
            className={`conn-tab-group ${color ? 'tinted' : ''} ${collapsed ? 'collapsed' : ''}`}
            style={color ? ({ '--group-color': color } as CSSProperties) : undefined}
            role="presentation"
            data-sort-item
            data-group={u.name}
            data-testid="conn-tab-group"
          >
            <span
              className="conn-tab-group-label"
              role="button"
              tabIndex={0}
              aria-expanded={!collapsed}
              title={`${u.name} · ${count} · click to ${collapsed ? 'show' : 'hide'} them`}
              onClick={() => toggleTabGroup(u.name)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault()
                toggleTabGroup(u.name)
              }}
              data-sort-handle
              data-testid="conn-tab-group-label"
            >
              <span className="conn-tab-group-name">{u.name}</span>
              {collapsed ? <span className="conn-tab-group-count">{u.tabs.length}</span> : null}
            </span>
            {/* The outer box folds shut; the inner one is the list its tabs are dragged along. */}
            <div className="conn-tab-group-tabs" inert={collapsed}>
              <div className="conn-tab-group-list" data-sort-list data-group={u.name}>
                {u.tabs.map((t) => renderTab(t, u.name))}
              </div>
            </div>
          </div>
        )
      })}
      <button className={`conn-tab-add ${showConnect ? 'active' : ''}`} title="Open another connection" onClick={() => showConnectScreen()} data-testid="conn-tab-add">
        <Icon name="plus" size={13} />
      </button>
    </div>
  )
}
