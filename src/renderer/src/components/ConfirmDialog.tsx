import { useEffect, useRef } from 'react'
import { useStore } from '@/store'
import { Modal } from './Modal'

export function ConfirmDialog() {
  const req = useStore((s) => s.confirmRequest)
  const resolve = useStore((s) => s.resolveConfirm)
  const primaryRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (req) requestAnimationFrame(() => primaryRef.current?.focus())
  }, [req])

  if (!req) return null
  return (
    <Modal title={req.message} onClose={() => resolve(false)} width={460}>
      <div className="confirm-body" data-testid="confirm-dialog">
        {req.detail ? <p>{req.detail}</p> : null}
        <div className="confirm-actions">
          <button className="btn" onClick={() => resolve(false)} ref={req.destructive ? primaryRef : undefined} data-testid="confirm-cancel">
            Cancel
          </button>
          <button
            className={`btn ${req.destructive ? 'danger' : 'primary'}`}
            onClick={() => resolve(true)}
            ref={req.destructive ? undefined : primaryRef}
            data-testid="confirm-ok"
          >
            {req.confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  )
}
