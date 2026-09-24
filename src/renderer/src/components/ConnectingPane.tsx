import { useStore, type OpenTab } from '@/store'
import { DbLogo } from './DbLogo'

/** What a connection tab shows before it is connected: progress while connecting, or what went wrong. */
export function ConnectingPane({ tab }: { tab: OpenTab }) {
  const connectTab = useStore((s) => s.connectTab)
  const closeTab = useStore((s) => s.closeTab)
  const showConnectScreen = useStore((s) => s.showConnectScreen)
  return (
    <div className="app-frame connecting-pane" data-testid="connecting-pane" data-status={tab.status}>
      <div className="connecting-card">
        <DbLogo kind={tab.kind} size={36} />
        <h3>{tab.name}</h3>
        <div className="muted">{tab.target}</div>
        {tab.status === 'error' ? (
          <>
            <div className="connecting-error" data-testid="connecting-error">
              {tab.error}
            </div>
            <div className="connecting-actions">
              <button className="btn primary" onClick={() => void connectTab(tab.connectionId)}>
                Try again
              </button>
              <button className="btn" onClick={() => showConnectScreen(tab.connectionId)}>
                Edit connection
              </button>
              <button className="btn ghost" onClick={() => void closeTab(tab.connectionId)}>
                Close tab
              </button>
            </div>
          </>
        ) : tab.status === 'connecting' ? (
          <div className="connecting-status">
            <span className="spinner" /> {tab.progress || 'Connecting…'}
          </div>
        ) : (
          <div className="connecting-actions">
            <button className="btn primary" onClick={() => void connectTab(tab.connectionId)}>
              Connect
            </button>
            <button className="btn ghost" onClick={() => void closeTab(tab.connectionId)}>
              Close tab
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
