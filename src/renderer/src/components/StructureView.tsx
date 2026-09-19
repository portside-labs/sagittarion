import { useEffect, useState } from 'react'
import type { TableDetails } from '@shared/types'
import { useStore } from '@/store'
import { SqlEditor } from './SqlEditor'
import { errorMessage } from '@/lib/util'

export function StructureView({ table, refreshKey }: { table: string; refreshKey: number }) {
  const session = useStore((s) => s.session)!
  const [details, setDetails] = useState<TableDetails | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    window.api.db
      .tableDetails(session.sessionId, table)
      .then((d) => !cancelled && setDetails(d))
      .catch((e) => !cancelled && setError(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [session.sessionId, table, refreshKey])

  if (error) return <div className="banner error">{error}</div>
  if (!details) return <div className="structure">Loading…</div>

  return (
    <div className="structure" data-testid="structure-view">
      <div className="struct-section">
        <h3>
          Columns <span className="count">{details.columns.length}</span>
          {details.withoutRowid ? <span className="tag">WITHOUT ROWID</span> : null}
          {details.type === 'view' ? <span className="tag">VIEW</span> : null}
        </h3>
        <table className="struct">
          <thead>
            <tr>
              <th>#</th>
              <th>Name</th>
              <th>Type</th>
              <th>Constraints</th>
              <th>Default</th>
            </tr>
          </thead>
          <tbody>
            {details.columns.map((c) => (
              <tr key={c.cid}>
                <td className="muted">{c.cid}</td>
                <td className="mono">{c.name}</td>
                <td className="mono muted">{c.type || '—'}</td>
                <td>
                  {c.pk ? <span className="tag pk">PK{details.pk.length > 1 ? ` ${c.pk}` : ''}</span> : null}
                  {c.notnull ? <span className="tag nn">NOT NULL</span> : null}
                  {c.hidden === 2 ? <span className="tag">GENERATED VIRTUAL</span> : null}
                  {c.hidden === 3 ? <span className="tag">GENERATED STORED</span> : null}
                  {c.hidden === 1 ? <span className="tag">HIDDEN</span> : null}
                </td>
                <td className="mono muted">{c.dflt ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="struct-section">
        <h3>
          Indexes <span className="count">{details.indexes.length}</span>
        </h3>
        {details.indexes.length ? (
          <table className="struct">
            <thead>
              <tr>
                <th>Name</th>
                <th>Columns</th>
                <th>Properties</th>
                <th>SQL</th>
              </tr>
            </thead>
            <tbody>
              {details.indexes.map((i) => (
                <tr key={i.name}>
                  <td className="mono">{i.name}</td>
                  <td className="mono">{i.columns.map((c) => c ?? '<expr>').join(', ')}</td>
                  <td>
                    {i.origin === 'pk' ? (
                      <span className="tag pk">PRIMARY KEY</span>
                    ) : i.origin === 'u' ? (
                      <span className="tag nn">UNIQUE CONSTRAINT</span>
                    ) : i.unique ? (
                      <span className="tag nn">UNIQUE</span>
                    ) : null}
                    {i.partial ? <span className="tag">PARTIAL</span> : null}
                  </td>
                  <td className="mono muted">{i.sql ?? '(automatic)'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="struct-empty">No indexes</div>
        )}
      </div>

      <div className="struct-section">
        <h3>
          Foreign keys <span className="count">{details.foreignKeys.length}</span>
        </h3>
        {details.foreignKeys.length ? (
          <table className="struct">
            <thead>
              <tr>
                <th>Column</th>
                <th>References</th>
                <th>On update</th>
                <th>On delete</th>
              </tr>
            </thead>
            <tbody>
              {details.foreignKeys.map((f) => (
                <tr key={`${f.id}-${f.seq}`}>
                  <td className="mono">{f.from}</td>
                  <td className="mono">
                    {f.table}({f.to ?? 'PK'})
                  </td>
                  <td className="muted">{f.onUpdate}</td>
                  <td className="muted">{f.onDelete}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="struct-empty">No foreign keys</div>
        )}
      </div>

      {details.triggers.length ? (
        <div className="struct-section">
          <h3>
            Triggers <span className="count">{details.triggers.length}</span>
          </h3>
          {details.triggers.map((t) => (
            <div key={t.name} style={{ marginBottom: 12 }}>
              <div className="mono" style={{ marginBottom: 6 }}>
                {t.name}
              </div>
              <div className="struct-sql" style={{ height: Math.min(260, 40 + (t.sql?.split('\n').length ?? 1) * 20) }}>
                <SqlEditor initialValue={t.sql ?? ''} readOnly />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="struct-section">
        <h3>Definition</h3>
        <div className="struct-sql" style={{ height: Math.min(420, 40 + (details.sql?.split('\n').length ?? 1) * 20) }}>
          <SqlEditor initialValue={details.sql ?? '-- no SQL available'} readOnly />
        </div>
      </div>
    </div>
  )
}
