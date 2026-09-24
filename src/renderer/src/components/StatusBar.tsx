import { useSession } from '@/session-store'
import { KIND_LABELS } from '@shared/types'

export function StatusBar() {
  const session = useSession((s) => s.session)
  const inTransaction = useSession((s) => s.inTransaction)
  const status = useSession((s) => s.status)
  if (!session) return null
  const db = session.db
  return (
    <div className="statusbar">
      <span className="status-item status-session" title={session.name}>
        <span className="dot ok" style={session.color ? { background: session.color, boxShadow: 'none' } : undefined} />
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
      {inTransaction ? <span className="status-item status-warn">Transaction open</span> : null}
      <span className="status-item">{status}</span>
    </div>
  )
}
