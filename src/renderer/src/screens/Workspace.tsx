import { useEffect, useState } from 'react'
import { useStore } from '@/store'
import { TitleBar } from '@/components/TitleBar'
import { Sidebar } from '@/components/Sidebar'
import { Splitter } from '@/components/Splitter'
import { TabBar } from '@/components/TabBar'
import { StatusBar } from '@/components/StatusBar'
import { TableTab } from '@/components/TableTab'
import { QueryTab } from '@/components/QueryTab'
import { Icon } from '@/components/Icons'
import { clamp, isModKey, modKey } from '@/lib/util'

export const REFRESH_EVENT = 'sagittarion:refresh'

export function Workspace() {
  const session = useStore((s) => s.session)!
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const newQueryTab = useStore((s) => s.newQueryTab)
  const closeTab = useStore((s) => s.closeTab)
  const refreshSchema = useStore((s) => s.refreshSchema)
  const disconnect = useStore((s) => s.disconnect)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const [sidebarWidth, setSidebarWidth] = useState(() => Number(localStorage.getItem('sidebarWidth')) || 260)

  useEffect(() => {
    localStorage.setItem('sidebarWidth', String(sidebarWidth))
  }, [sidebarWidth])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isModKey(e)) return
      const k = e.key.toLowerCase()
      if (k === 't') {
        e.preventDefault()
        newQueryTab()
      } else if (k === 'w') {
        e.preventDefault()
        if (activeTabId) void closeTab(activeTabId)
      } else if (k === 'r') {
        e.preventDefault()
        if (e.shiftKey) void refreshSchema()
        else window.dispatchEvent(new CustomEvent(REFRESH_EVENT, { detail: activeTabId }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeTabId, newQueryTab, closeTab, refreshSchema])

  return (
    <div className="app-frame workspace">
      <TitleBar
        left={
          <span className="session-badge" title={session.db?.label}>
            <span className="dot ok" style={session.color ? { background: session.color, boxShadow: 'none' } : undefined} />
            <strong>{session.name}</strong>
            <span className={`kind-badge ${session.kind}`}>{session.kind === 'postgres' ? 'PG' : 'SQLite'}</span>
            <span className="path">{session.db?.label}</span>
          </span>
        }
        right={
          <>
            <button className="btn small" onClick={() => newQueryTab()} title={`New query (${modKey}T)`}>
              <Icon name="code" /> New query
            </button>
            <button className="btn small" onClick={() => void refreshSchema()} title={`Refresh schema (${modKey}⇧R)`}>
              <Icon name="refresh" /> Schema
            </button>
            <button className="btn small" onClick={() => void disconnect()} title="Disconnect" data-testid="disconnect-button">
              <Icon name="unplug" /> Disconnect
            </button>
            <button className="btn ghost icon small" title="Settings" onClick={() => setSettingsOpen(true)} data-testid="open-settings">
              <Icon name="settings" />
            </button>
          </>
        }
      />
      <div className="workspace-body">
        <Sidebar width={sidebarWidth} />
        <Splitter onResize={(dx) => setSidebarWidth((w) => clamp(w + dx, 180, 560))} />
        <div className="main-area">
          <TabBar />
          <div className="tab-panes">
            {tabs.length === 0 ? (
              <div className="empty-state">
                <Icon name="database" size={34} />
                <h3>{session.kind === 'sqlite' ? session.db?.label.split('/').pop() : session.db?.label}</h3>
                <div>Pick a table on the left, or open a query tab.</div>
                <div className="hints">
                  <span className="kbd">{modKey}T</span>
                  <span>New query</span>
                  <span className="kbd">{modKey}↩</span>
                  <span>Run query</span>
                  <span className="kbd">{modKey}R</span>
                  <span>Refresh current tab</span>
                  <span className="kbd">{modKey}W</span>
                  <span>Close tab</span>
                </div>
              </div>
            ) : null}
            {tabs.map((tab) => (
              <div key={tab.id} className="tab-pane" hidden={tab.id !== activeTabId}>
                {tab.kind === 'table' ? <TableTab tab={tab} active={tab.id === activeTabId} /> : <QueryTab tab={tab} active={tab.id === activeTabId} />}
              </div>
            ))}
          </div>
        </div>
      </div>
      <StatusBar />
    </div>
  )
}
