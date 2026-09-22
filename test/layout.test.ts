import { describe, expect, it } from 'vitest'
import { defaultLayout, hasVisible, insertLeaf, isValidLayout, leaves, moveLeaf, removeLeaf, setRatio, swapLeaves, zoneFor, type LayoutNode } from '../src/renderer/src/lib/layout'

describe('query pane layout', () => {
  it('starts with the chat down the right side and validates shapes', () => {
    const l = defaultLayout()
    expect(leaves(l)).toEqual(['editor', 'results', 'chat'])
    expect(l.type === 'split' && l.dir === 'row' && l.b).toEqual({ type: 'pane', id: 'chat' })
    expect(isValidLayout(l)).toBe(true)
    expect(isValidLayout({ type: 'pane', id: 'editor' })).toBe(false) // panes missing
    expect(isValidLayout({ ...l, b: { type: 'pane', id: 'results' } })).toBe(false) // results twice, chat missing
    expect(isValidLayout({ type: 'split', dir: 'diagonal', ratio: 0.5, a: l.type === 'split' ? l.a : l, b: { type: 'pane', id: 'results' } })).toBe(false)
    expect(isValidLayout(null)).toBe(false)
  })

  it('moves a pane to any side of another and swaps on the middle', () => {
    const l = defaultLayout()
    const chatLeft = moveLeaf(l, 'chat', 'editor', 'left')
    expect(leaves(chatLeft)).toEqual(['chat', 'editor', 'results'])
    // the row split that held the chat collapsed, and the editor's slot became a row split
    expect(chatLeft.type === 'split' && chatLeft.dir === 'column' && chatLeft.a.type === 'split' && chatLeft.a.dir === 'row' && chatLeft.a.ratio).toBeCloseTo(0.35)
    const chatBottom = moveLeaf(l, 'chat', 'results', 'bottom')
    expect(leaves(chatBottom)).toEqual(['editor', 'results', 'chat'])
    expect(chatBottom.type === 'split' && chatBottom.dir === 'column' && chatBottom.a).toEqual({ type: 'pane', id: 'editor' })
    const swapped = moveLeaf(l, 'editor', 'results', 'center')
    expect(leaves(swapped)).toEqual(['results', 'editor', 'chat'])
    expect(moveLeaf(l, 'chat', 'chat', 'left')).toBe(l)
    expect(isValidLayout(chatLeft) && isValidLayout(chatBottom) && isValidLayout(swapped)).toBe(true)
  })

  it('picks drop zones by the nearest edge, swaps in the middle, and sticks near boundaries', () => {
    expect(zoneFor(0.05, 0.5, null)).toBe('left')
    expect(zoneFor(0.95, 0.5, null)).toBe('right')
    expect(zoneFor(0.5, 0.1, null)).toBe('top')
    expect(zoneFor(0.5, 0.9, null)).toBe('bottom')
    expect(zoneFor(0.5, 0.5, null)).toBe('center')
    expect(zoneFor(0.64, 0.48, null)).toBe('center')
    // near a corner the closer edge wins
    expect(zoneFor(0.2, 0.1, null)).toBe('top')
    expect(zoneFor(0.1, 0.2, null)).toBe('left')
    // just past the boundary the previous zone is kept, well past it the new one wins
    expect(zoneFor(0.34, 0.5, 'left')).toBe('left')
    expect(zoneFor(0.45, 0.5, 'left')).toBe('center')
    expect(zoneFor(0.3, 0.5, 'center')).toBe('center')
    expect(zoneFor(0.2, 0.5, 'center')).toBe('left')
  })

  it('resizes along a path and clamps the ratio', () => {
    const l = defaultLayout()
    const r = setRatio(l, ['a'], 0.95)
    expect(r.type === 'split' && r.a.type === 'split' && r.a.ratio).toBe(0.9)
    expect(setRatio(l, [], 0.02).type === 'split' && (setRatio(l, [], 0.02) as { ratio: number }).ratio).toBe(0.1)
    expect(setRatio(l, ['b'], 0.3)).toEqual(l) // a pane has no ratio
  })

  it('hides panes without breaking paths', () => {
    const l = defaultLayout()
    const hidden = new Set<'chat'>(['chat'])
    expect(hasVisible(l, hidden)).toBe(true)
    expect(l.type === 'split' && hasVisible(l.a, hidden)).toBe(true)
    expect(l.type === 'split' && hasVisible(l.b, hidden)).toBe(false)
    expect(removeLeaf({ type: 'pane', id: 'chat' } as LayoutNode, 'chat')).toBeNull()
    expect(leaves(insertLeaf(removeLeaf(l, 'chat')!, 'chat', 'results', 'right'))).toEqual(['editor', 'results', 'chat'])
    expect(leaves(swapLeaves(l, 'chat', 'results'))).toEqual(['editor', 'chat', 'results'])
  })
})
