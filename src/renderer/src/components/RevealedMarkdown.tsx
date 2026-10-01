import { useLayoutEffect } from 'react'
import { closeOpenFence, useReveal } from '@/lib/reveal'
import { ChatMarkdown } from './ChatMarkdown'

/**
 * An answer in markdown, revealed smoothly as it arrives when it is new, and whole when it is not. `onGrow` follows
 * along as it lengthens, e.g. to keep the conversation scrolled to its end.
 */
export function RevealedMarkdown({
  revealKey,
  text,
  dialect,
  className,
  onGrow
}: {
  revealKey: string
  text: string
  dialect: 'sqlite' | 'postgres'
  className?: string
  onGrow?: () => void
}) {
  const visible = useReveal(revealKey, text)
  const writing = visible.length < text.length
  useLayoutEffect(() => {
    onGrow?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.length])
  return <ChatMarkdown text={writing ? closeOpenFence(visible) : visible} dialect={dialect} className={`${className ?? ''}${writing ? ' writing' : ''}`} />
}
