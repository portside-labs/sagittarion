import { useRef, useState } from 'react'

export function Splitter({
  direction = 'vertical',
  onResize,
  onEnd
}: {
  /** vertical = a vertical bar that resizes horizontally; horizontal = a horizontal bar. */
  direction?: 'vertical' | 'horizontal'
  onResize: (delta: number) => void
  onEnd?: () => void
}) {
  const [dragging, setDragging] = useState(false)
  const last = useRef(0)

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    last.current = direction === 'vertical' ? e.clientX : e.clientY
    setDragging(true)
    const prevCursor = document.body.style.cursor
    document.body.style.cursor = direction === 'vertical' ? 'col-resize' : 'row-resize'
    const move = (ev: MouseEvent) => {
      const cur = direction === 'vertical' ? ev.clientX : ev.clientY
      const delta = cur - last.current
      last.current = cur
      if (delta) onResize(delta)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = prevCursor
      setDragging(false)
      onEnd?.()
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return <div className={`splitter ${direction} ${dragging ? 'dragging' : ''}`} onMouseDown={onMouseDown} />
}
