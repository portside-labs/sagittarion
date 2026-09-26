import { useSession } from '@/session-store'
import { useStore } from '@/store'
import { KIND_LABELS } from '@shared/types'

export function StatusBar() {
  const session = useSession((s) => s.session)
  const inTransaction = useSession((s) => s.inTransaction)
  const status = useSession((s) => s.status)
  const tab = useStore((s) => s.tabs.find((t) => t.session?.sessionId === session?.sessionId))
  if (!session) return null
  const db = session.db
  const link = tab?.link
  // The dot says whether the database is connected: green, red once the connection drops, amber while it reconnects.
  const [dot, state] = link === 'reconnecting' ? ['warn busy', 'reconnecting'] : link ? ['err', 'disconnected'] : ['ok', 'connected']
  return (
    <div className="statusbar">
      <span className="status-item status-session" title={`${session.name} · ${state}`}>
        <span className={`dot ${dot}`} data-testid="status-dot" data-state={state} />
        <strong>{session.name}</strong>
        <span className="status-kind">({KIND_LABELS[session.kind]})</span>
      </span>
      <span className="status-item">{session.target}</span>
      {db ? (
        <>
          <span className="status-item mono" title={db.label}>
            {db.label}
          </span>
          <span className="status-item">{[db.serverVersion, ...db.details.map((d) => `${d.label} ${d.value}`)].join(' · ')}</span>
          {db.readonly ? <span className="status-item status-ro">read-only</span> : null}
        </>
      ) : null}
      <span className="spacer" />
      {link === 'down' ? (
        <span className="status-item status-link" title={tab?.linkMessage} data-testid="status-link" data-link="down">
          Disconnected · reconnects on next use
        </span>
      ) : link === 'reconnecting' ? (
        <span className="status-item status-link busy" title={tab?.linkMessage} data-testid="status-link" data-link="reconnecting">
          <span className="spinner tiny" /> Reconnecting…
        </span>
      ) : null}
      {inTransaction ? <span className="status-item status-warn">Transaction open</span> : null}
      <span className="status-item">{status}</span>
    </div>
  )
}
