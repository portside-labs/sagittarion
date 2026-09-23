import { useStore } from '@/store'
import { Icon } from './Icons'

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  if (!toasts.length) return null
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind} ${t.detail ? 'has-detail' : ''} ${t.leaving ? 'leaving' : ''}`} role="status">
          <div className="toast-body">
            <div className="toast-msg">{t.message}</div>
            {t.detail ? <div className="toast-detail">{t.detail}</div> : null}
          </div>
          <button className="btn ghost icon small" onClick={() => dismiss(t.id)} title="Dismiss">
            <Icon name="x" />
          </button>
        </div>
      ))}
    </div>
  )
}
