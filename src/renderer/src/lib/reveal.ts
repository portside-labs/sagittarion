// An answer revealed as if typed, at an easing pace: quick while far behind what has arrived and slowing as it
// catches up, so a stream that comes in bursts reads as one steady line, and an answer that arrives whole still
// unfolds rather than landing at once.
import { useEffect, useRef, useState } from 'react'

/** How much of each answer has been shown, by key. Only answers given a start here are revealed; others show whole. */
const shown = new Map<string, number>()

/** Reveal this answer as it arrives, from nothing. */
export function revealFrom(key: string): void {
  shown.set(key, 0)
}

/** Characters to add after `dt` ms with `behind` still to show: about 90 a second when caught up, far more when not. */
export function revealStep(behind: number, dt: number): number {
  return Math.max(1, Math.round(((90 + behind * 4) * dt) / 1000))
}

/** The first `n` characters, never splitting a character written as two code units. */
export function revealedPart(text: string, n: number): string {
  if (n >= text.length) return text
  const code = text.charCodeAt(n - 1)
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? n + 1 : n)
}

/** Markdown cut off mid-way, readable as it stands: an open code fence is closed so what follows is not all code. */
export function closeOpenFence(text: string): string {
  const fences = text.match(/^ {0,3}(?:```|~~~)/gm)?.length ?? 0
  return fences % 2 ? `${text}\n\`\`\`` : text
}

/**
 * The part of `text` to show now. It grows each frame towards all of it; a text that is not a continuation of what was
 * shown (a draft dropped for a tool call) starts again from where the two agree.
 */
export function useReveal(key: string, text: string): string {
  const animate = shown.has(key)
  const [, rerender] = useState(0)
  const count = useRef(animate ? Math.min(shown.get(key) ?? 0, text.length) : text.length)
  const previous = useRef(text)
  if (previous.current !== text) {
    const before = previous.current
    let same = 0
    const limit = Math.min(before.length, text.length, count.current)
    while (same < limit && before.charCodeAt(same) === text.charCodeAt(same)) same++
    count.current = same
    previous.current = text
  }

  useEffect(() => {
    if (!animate) return
    let frame = 0
    let last = performance.now()
    const tick = (now: number) => {
      const behind = text.length - count.current
      if (behind <= 0) {
        shown.set(key, count.current)
        return
      }
      count.current = Math.min(text.length, count.current + revealStep(behind, Math.min(64, now - last)))
      last = now
      shown.set(key, count.current)
      rerender((n) => n + 1)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [key, text, animate])

  return animate ? revealedPart(text, count.current) : text
}
