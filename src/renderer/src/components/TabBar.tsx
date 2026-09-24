import { useSession } from '@/session-store'
import { Icon } from './Icons'
import { modKey } from '@/lib/util'

export function TabBar() {
  const tabs = useSession((s) => s.tabs)
  const activeTabId = useSession((s) => s.activeTabId)
  const setActiveTab = useSession((s) => s.setActiveTab)
  const closeTab = useSession((s) => s.closeTab)
  const newQueryTab = useSession((s) => s.newQueryTab)
  const dirtyTabs = useSession((s) => s.dirtyTabs)

  return (
    <div className="tabbar">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`tab ${tab.id === activeTabId ? 'active' : ''}`}
          onClick={() => setActiveTab(tab.id)}
          onAuxClick={(e) => {
            if (e.button === 1) void closeTab(tab.id)
          }}
          title={tab.title}
          data-testid={`tab-${tab.title}`}
        >
          <Icon name={tab.kind === 'table' ? 'table' : 'code'} size={13} />
          <span className="tab-title">{tab.title}</span>
          {dirtyTabs[tab.id] ? <span className="tab-dirty">●</span> : null}
          <button
            className="tab-close"
            title="Close tab"
            onClick={(e) => {
              e.stopPropagation()
              void closeTab(tab.id)
            }}
          >
            <Icon name="x" size={11} />
          </button>
        </div>
      ))}
      <button className="tab-new" onClick={() => newQueryTab()} title={`New query (${modKey}T)`} data-testid="new-query-tab">
        <Icon name="plus" />
      </button>
    </div>
  )
}
