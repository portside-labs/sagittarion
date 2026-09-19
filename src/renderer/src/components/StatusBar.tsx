import { useStore } from '@/store'
import { formatBytes } from '@/lib/format'

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
        {session.username}@{session.host}
        {session.port !== 22 ? `:${session.port}` : ''}
      </span>
      {db ? (
        <>
          <span className="status-item mono" title={db.path}>
            {db.path}
          </span>
          <span className="status-item">
            SQLite {db.sqliteVersion} · {session.interpreter} {db.pythonVersion} · {formatBytes(db.fileSize)} · {db.journalMode}
          </span>
          {db.readonly ? <span className="status-item status-ro">read-only</span> : null}
        </>
      ) : null}
      <span className="spacer" />
      {inTransaction ? <span className="status-item status-warn">Transaction open</span> : null}
      <span className="status-item">{status}</span>
    </div>
  )
}
