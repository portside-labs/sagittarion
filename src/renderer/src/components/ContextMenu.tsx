import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export interface MenuItem {
  label?: string
  shortcut?: string
  onClick?: () => void
  disabled?: boolean
  danger?: boolean
  separator?: boolean
  /** A row of the menu's own choosing, such as colour swatches; it closes the menu itself when done. */
  custom?: (close: () => void) => ReactNode
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const nx = x + r.width > window.innerWidth - 8 ? Math.max(8, window.innerWidth - r.width - 8) : x
    const ny = y + r.height > window.innerHeight - 8 ? Math.max(8, window.innerHeight - r.height - 8) : y
    setPos({ x: nx, y: ny })
  }, [x, y])

  useEffect(() => {
    const close = () => onClose()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  }, [onClose])

  return (
    <div ref={ref} className="context-menu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="context-menu-sep" />
        ) : item.custom ? (
          <div key={i} className="context-menu-custom">
            {item.custom(onClose)}
          </div>
        ) : (
          <div
            key={i}
            className={`context-menu-item ${item.disabled ? 'disabled' : ''} ${item.danger ? 'danger' : ''}`}
            onClick={() => {
              if (item.disabled) return
              onClose()
              item.onClick?.()
            }}
          >
            <span>{item.label}</span>
            {item.shortcut ? <span className="kbd">{item.shortcut}</span> : null}
          </div>
        )
      )}
    </div>
  )
}
