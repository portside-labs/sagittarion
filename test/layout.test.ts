import { describe, expect, it } from 'vitest'
import { defaultLayout, hasVisible, insertLeaf, isValidLayout, leaves, moveLeaf, removeLeaf, setRatio, swapLeaves, withoutLeaf, zoneFor, type LayoutNode } from '../src/renderer/src/lib/layout'

describe('query pane layout', () => {
  it('starts with the editor above the results and validates shapes', () => {
    const l = defaultLayout()
    expect(leaves(l)).toEqual(['editor', 'results'])
    expect(l.type === 'split' && l.dir).toBe('column')
    expect(isValidLayout(l)).toBe(true)
    expect(isValidLayout({ type: 'pane', id: 'editor' })).toBe(false) // results missing
    expect(isValidLayout({ ...l, b: { type: 'pane', id: 'editor' } })).toBe(false) // editor twice
    expect(isValidLayout({ type: 'split', dir: 'diagonal', ratio: 0.5, a: { type: 'pane', id: 'editor' }, b: { type: 'pane', id: 'results' } })).toBe(false)
    expect(isValidLayout(null)).toBe(false)
  })

  it('brings a layout from when the chat was a pane along without it', () => {
    const old = {
      type: 'split',
      dir: 'row',
      ratio: 0.7,
      a: { type: 'split', dir: 'row', ratio: 0.4, a: { type: 'pane', id: 'results' }, b: { type: 'pane', id: 'editor' } },
      b: { type: 'pane', id: 'chat' }
    }
    expect(isValidLayout(old)).toBe(false)
    const now = withoutLeaf(old, 'chat')
    expect(isValidLayout(now)).toBe(true)
    // The split that held the chat gives way to its other side, which keeps its own shape.
    expect(now).toEqual({ type: 'split', dir: 'row', ratio: 0.4, a: { type: 'pane', id: 'results' }, b: { type: 'pane', id: 'editor' } })
    expect(withoutLeaf(null, 'chat')).toBeNull()
  })

  it('moves a pane to any side of another and swaps on the middle', () => {
    const l = defaultLayout()
    const side = moveLeaf(l, 'results', 'editor', 'right')
    expect(leaves(side)).toEqual(['editor', 'results'])
    expect(side.type === 'split' && side.dir).toBe('row')
    const above = moveLeaf(l, 'results', 'editor', 'top')
    expect(leaves(above)).toEqual(['results', 'editor'])
    const swapped = moveLeaf(l, 'editor', 'results', 'center')
    expect(leaves(swapped)).toEqual(['results', 'editor'])
    expect(moveLeaf(l, 'editor', 'editor', 'left')).toBe(l)
    expect(isValidLayout(side) && isValidLayout(above) && isValidLayout(swapped)).toBe(true)
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
    const r = setRatio(l, [], 0.95)
    expect(r.type === 'split' && r.ratio).toBe(0.9)
    expect(setRatio(l, [], 0.02).type === 'split' && (setRatio(l, [], 0.02) as { ratio: number }).ratio).toBe(0.1)
    expect(setRatio(l, ['b'], 0.3)).toEqual(l) // a pane has no ratio
  })

  it('hides panes without breaking paths', () => {
    const l = defaultLayout()
    const hidden = new Set<'results'>(['results'])
    expect(hasVisible(l, hidden)).toBe(true)
    expect(l.type === 'split' && hasVisible(l.a, hidden)).toBe(true)
    expect(l.type === 'split' && hasVisible(l.b, hidden)).toBe(false)
    expect(removeLeaf({ type: 'pane', id: 'results' } as LayoutNode, 'results')).toBeNull()
    expect(leaves(insertLeaf(removeLeaf(l, 'results')!, 'results', 'editor', 'right'))).toEqual(['editor', 'results'])
    expect(leaves(swapLeaves(l, 'editor', 'results'))).toEqual(['results', 'editor'])
  })
})
