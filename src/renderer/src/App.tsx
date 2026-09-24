import { useEffect } from 'react'
import { applyAccent } from './lib/theme'
import { isModKey } from './lib/util'
import { getSessionStore, useStore } from './store'
import { SessionContext } from './session-store'
import { ConnectScreen } from './screens/ConnectScreen'
import { Workspace } from './screens/Workspace'
import { ConnectionTabs } from './components/ConnectionTabs'
import { ConnectingPane } from './components/ConnectingPane'
import { Toasts } from './components/Toasts'
import { ConfirmDialog } from './components/ConfirmDialog'
import { SettingsDialog } from './components/SettingsDialog'

export default function App() {
  const init = useStore((s) => s.init)
  const tabs = useStore((s) => s.tabs)
  const activeConnectionId = useStore((s) => s.activeConnectionId)
  const showConnect = useStore((s) => s.showConnect)
  const ui = useStore((s) => s.ui)
  const activateTab = useStore((s) => s.activateTab)
  const platform = useStore((s) => s.appInfo?.platform)
  const active = tabs.find((t) => t.connectionId === activeConnectionId) ?? null
  const connectVisible = showConnect || !active

  // The accent follows the connection in front; white on the connect screen and for connections without a colour.
  useEffect(() => {
    applyAccent(connectVisible ? undefined : active?.color)
  }, [connectVisible, active?.color])

  // The top rows leave room for the traffic lights on macOS.
  useEffect(() => {
    document.documentElement.classList.toggle('mac', platform === 'darwin')
    document.body.classList.toggle('mac', platform === 'darwin')
  }, [platform])

  useEffect(() => {
    void init()
  }, [init])

  // ⌘⇧] and ⌘⇧[ step through the connection tabs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isModKey(e) || !e.shiftKey) return
      const forward = e.key === ']' || e.key === '}'
      const back = e.key === '[' || e.key === '{'
      if (!forward && !back) return
      const { tabs: open, activeConnectionId: current } = useStore.getState()
      if (open.length < 2) return
      e.preventDefault()
      const idx = Math.max(0, open.findIndex((t) => t.connectionId === current))
      activateTab(open[(idx + (forward ? 1 : -1) + open.length) % open.length].connectionId)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activateTab])

  return (
    <div className={`app-shell tabs-${ui.connectionTabs} ${tabs.length ? 'has-tabs' : ''}`}>
      {tabs.length ? <ConnectionTabs /> : null}
      <div className="app-view">
        {tabs.map((t) => {
          const isActive = t.connectionId === activeConnectionId && !showConnect
          const store = t.session ? getSessionStore(t.session.sessionId) : undefined
          return (
            <div key={t.connectionId} className="session-slot" hidden={!isActive} data-testid="session-slot">
              {t.status === 'live' && store ? (
                <SessionContext.Provider value={store}>
                  <Workspace active={isActive} />
                </SessionContext.Provider>
              ) : (
                <ConnectingPane tab={t} />
              )}
            </div>
          )
        })}
        {connectVisible ? <ConnectScreen /> : null}
      </div>
      <SettingsDialog />
      <ConfirmDialog />
      <Toasts />
    </div>
  )
}
