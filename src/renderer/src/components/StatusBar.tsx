import { useStore } from '@/store'

export function StatusBar() {
  const session = useStore((s) => s.session)
  const inTransaction = useStore((s) => s.inTransaction)
  const status = useStore((s) => s.status)
  if (!session) return null
  const db = session.db
  return (
    <div className="statusbar">
      <span className="status-item">
        <span className="dot ok" />
        {session.target}
      </span>
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
