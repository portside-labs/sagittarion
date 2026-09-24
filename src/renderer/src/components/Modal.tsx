import { useEffect, type ReactNode } from 'react'
import { Icon } from './Icons'

export function Modal({
  title,
  children,
  footer,
  onClose,
  width,
  header = true,
  className
}: {
  /** Names the dialog for assistive technology; shown in the header when there is one. */
  title: string
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
  width?: number
  /** Without the header bar the dialog keeps a small close control in its corner. */
  header?: boolean
  className?: string
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${className ?? ''}`} style={width ? { width } : undefined} role="dialog" aria-label={title}>
        {header ? (
          <div className="modal-header">
            <span>{title}</span>
            <button className="btn ghost icon small" onClick={onClose} title="Close">
              <Icon name="x" />
            </button>
          </div>
        ) : (
          <button className="btn ghost icon small modal-close-floating" onClick={onClose} title="Close">
            <Icon name="x" />
          </button>
        )}
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  )
}
