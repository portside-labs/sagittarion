// "Use with": every database connection, or the ones chosen. Connectors and instructions are both scoped this way.
import type { ReactNode } from 'react'
import { KIND_LABELS, type ConnectionConfig } from '@shared/types'
import { useStore } from '@/store'

export type Scope = 'all' | 'selected'

/** "All connections", or the chosen ones by name. */
export function scopeText(scope: Scope, connectionIds: string[], connections: ConnectionConfig[]): string {
  if (scope === 'all') return 'All connections'
  const names = connectionIds.map((id) => connections.find((x) => x.id === id)?.name).filter((n): n is string => Boolean(n))
  if (!names.length) return 'No connections chosen'
  return names.length <= 2 ? names.join(', ') : `${names.length} connections`
}

export function ScopePicker({
  scope,
  connectionIds,
  onChange,
  testPrefix,
  hint
}: {
  scope: Scope
  connectionIds: string[]
  onChange: (scope: Scope, connectionIds: string[]) => void
  /** Test ids: `${testPrefix}-scope-all`, `${testPrefix}-scope-selected`, `${testPrefix}-connection-${name}`. */
  testPrefix: string
  hint?: ReactNode
}) {
  const connections = useStore((s) => s.connections)
  const sorted = [...connections].sort((a, b) => a.name.localeCompare(b.name))
  return (
    <div className="field">
      <label>Use with</label>
      <div className="segmented small">
        <button type="button" className={scope === 'all' ? 'active' : ''} onClick={() => onChange('all', connectionIds)} data-testid={`${testPrefix}-scope-all`}>
          All connections
        </button>
        <button type="button" className={scope === 'selected' ? 'active' : ''} onClick={() => onChange('selected', connectionIds)} data-testid={`${testPrefix}-scope-selected`}>
          Chosen connections
        </button>
      </div>
      {scope === 'selected' ? (
        sorted.length ? (
          <div className="scope-connections">
            {sorted.map((cfg) => (
              <label key={cfg.id} className="checkbox">
                <input
                  type="checkbox"
                  checked={connectionIds.includes(cfg.id)}
                  onChange={(e) => onChange('selected', e.target.checked ? [...connectionIds, cfg.id] : connectionIds.filter((id) => id !== cfg.id))}
                  data-testid={`${testPrefix}-connection-${cfg.name}`}
                />
                {cfg.name}
                <span className="scope-connection-kind">
                  {KIND_LABELS[cfg.kind]}
                  {cfg.group ? ` · ${cfg.group}` : ''}
                </span>
              </label>
            ))}
          </div>
        ) : (
          <span className="hint">No saved connections yet.</span>
        )
      ) : null}
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  )
}
