import { useLayoutEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { flushSync } from 'react-dom'
import { clamp } from './util'

/** How far the pointer travels before a press becomes a drag rather than a click. */
const THRESHOLD = 4

/** Bumped each time an item is picked up or let go, so a glide still finishing from an earlier drop stays out of the way. */
const moves = new WeakMap<HTMLElement, number>()
const nextMove = (el: HTMLElement) => {
  const n = (moves.get(el) ?? 0) + 1
  moves.set(el, n)
  return n
}

/**
 * Drag to reorder, for lists marked up in the DOM: a list carries data-sort-list, its items data-sort-item, and a
 * drag starts on a data-sort-handle, which is the item itself or a label inside it. Lists may nest, as a tab group
 * does inside the tab strip. The other items slide out of the way while dragging; on drop, `onSort` gets the list
 * and the item's old and new index, and the item settles into its new place. Escape puts everything back.
 * Spread the result on the outermost list: a press that turned into a drag is not also a click.
 */
export function useDragSort(axis: 'x' | 'y', onSort: (list: HTMLElement, from: number, to: number) => void) {
  const onSortRef = useRef(onSort)
  const swallowClick = useRef(false)
  useLayoutEffect(() => {
    onSortRef.current = onSort
  })

  const pos = (r: DOMRect) => (axis === 'x' ? r.left : r.top)
  const size = (r: DOMRect) => (axis === 'x' ? r.width : r.height)
  const shift = (px: number) => (px ? (axis === 'x' ? `translateX(${px}px)` : `translateY(${px}px)`) : '')
  const itemsOf = (list: HTMLElement) => [...list.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el.hasAttribute('data-sort-item'))

  function onPointerDown(e: ReactPointerEvent) {
    if (e.button !== 0 || !e.isPrimary) return
    const target = e.target as HTMLElement
    const handle = target.closest('[data-sort-handle]')
    if (!handle || target.closest('button')) return
    let item = handle.closest<HTMLElement>('[data-sort-item]')
    let list = item?.parentElement
    // The only item of a nested list takes the item holding that list along, as the only tab of a group moves the group.
    while (item && list && itemsOf(list).length < 2) {
      const outer = list.closest<HTMLElement>('[data-sort-item]')
      if (!outer) break
      item = outer
      list = outer.parentElement
    }
    if (!item || !list?.hasAttribute('data-sort-list')) return
    const items = itemsOf(list)
    const from = items.indexOf(item)
    if (items.length < 2 || from < 0) return
    const { pointerId, clientX: startX, clientY: startY } = e
    let drag: { rects: DOMRect[]; step: number; min: number; max: number; to: number } | null = null

    const begin = () => {
      const rects = items.map((el) => el.getBoundingClientRect())
      const r = rects[from]
      const last = rects[rects.length - 1]
      // The others move by the dragged item's size plus the gap to its neighbour.
      const gap = from < rects.length - 1 ? pos(rects[from + 1]) - pos(r) - size(r) : pos(r) - pos(rects[from - 1]) - size(rects[from - 1])
      drag = { rects, step: size(r) + gap, min: pos(rects[0]) - pos(r), max: pos(last) + size(last) - pos(r) - size(r), to: from }
      nextMove(item)
      item.style.transition = ''
      list.classList.add('sorting')
      item.classList.add('dragging')
      document.documentElement.classList.add('drag-sorting')
      try {
        item.setPointerCapture(pointerId)
      } catch {
        /* the window listeners still see the pointer */
      }
    }

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      if (!drag) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < THRESHOLD) return
        begin()
      }
      // The list changed under the drag, e.g. a connection dropped: let go rather than sort a stale list.
      if (!items.every((el) => el.isConnected)) return finish(false, false)
      const d = drag!
      const delta = clamp(axis === 'x' ? ev.clientX - startX : ev.clientY - startY, d.min, d.max)
      item.style.transform = shift(delta)
      // An item gives way once the dragged one's leading edge passes its middle.
      const r = d.rects[from]
      const lead = pos(r) + delta + (delta > 0 ? size(r) : 0)
      const middle = (i: number) => pos(d.rects[i]) + size(d.rects[i]) / 2
      let to = from
      if (delta > 0) for (let i = from + 1; i < items.length && lead > middle(i); i++) to = i
      else if (delta < 0) for (let i = from - 1; i >= 0 && lead < middle(i); i--) to = i
      d.to = to
      items.forEach((el, i) => {
        if (i !== from) el.style.transform = shift(from < i && i <= to ? -d.step : to <= i && i < from ? d.step : 0)
      })
    }

    /** `released` is false when the drag ends with the button still down; the click on letting go is swallowed too. */
    const finish = (commit: boolean, released = true) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey, true)
      if (!drag) return
      const { to } = drag
      drag = null
      document.documentElement.classList.remove('drag-sorting')
      const dropped = item.getBoundingClientRect()
      // Transitions off first, so the others land in their new places without animating back from the old ones.
      list.classList.remove('sorting')
      for (const el of items) el.style.transform = ''
      const current = itemsOf(list)
      const intact = current.length === items.length && current.every((el, i) => el === items[i])
      if (commit && intact && to !== from) flushSync(() => onSortRef.current(list, from, to))
      // Glide from where it was let go into its slot.
      const offset = axis === 'x' ? dropped.left - item.getBoundingClientRect().left : dropped.top - item.getBoundingClientRect().top
      const move = nextMove(item)
      const settled = () => {
        if (moves.get(item) !== move) return
        item.style.transition = ''
        item.classList.remove('dragging')
      }
      if (Math.abs(offset) < 0.5 || matchMedia('(prefers-reduced-motion: reduce)').matches) settled()
      else {
        item.style.transform = shift(offset)
        void item.offsetWidth
        item.style.transition = 'transform 140ms ease-out'
        item.style.transform = ''
        item.addEventListener('transitionend', settled, { once: true })
        setTimeout(settled, 220)
      }
      // The click that follows the pointerup belongs to the drag.
      swallowClick.current = true
      const release = () => setTimeout(() => (swallowClick.current = false), 0)
      if (released) release()
      else window.addEventListener('pointerup', release, { once: true })
    }
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finish(true)
    }
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finish(false)
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !drag) return
      ev.preventDefault()
      ev.stopPropagation()
      finish(false, false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey, true)
  }

  function onClickCapture(e: ReactMouseEvent) {
    if (!swallowClick.current) return
    e.stopPropagation()
    e.preventDefault()
  }

  return { onPointerDown, onClickCapture }
}
