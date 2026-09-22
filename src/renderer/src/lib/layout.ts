// The query tab's pane layout: a binary tree of splits whose leaves are the
// editor, the chat and the results. Pure functions so the tree can be tested.

export type PaneId = 'editor' | 'chat' | 'results'
export type Side = 'left' | 'right' | 'top' | 'bottom' | 'center'
export type Path = ('a' | 'b')[]

export type LayoutNode =
  | { type: 'pane'; id: PaneId }
  | { type: 'split'; dir: 'row' | 'column'; /** Share of the first child, 0.1 to 0.9. */ ratio: number; a: LayoutNode; b: LayoutNode }

export const PANE_IDS: PaneId[] = ['editor', 'chat', 'results']

/** Editor above results on the left, the chat down the whole right side. */
export function defaultLayout(): LayoutNode {
  return {
    type: 'split',
    dir: 'row',
    ratio: 0.7,
    a: { type: 'split', dir: 'column', ratio: 0.5, a: { type: 'pane', id: 'editor' }, b: { type: 'pane', id: 'results' } },
    b: { type: 'pane', id: 'chat' }
  }
}

export function leaves(node: LayoutNode): PaneId[] {
  return node.type === 'pane' ? [node.id] : [...leaves(node.a), ...leaves(node.b)]
}

/** True for a well-formed tree that holds each pane exactly once. */
export function isValidLayout(value: unknown): value is LayoutNode {
  const ok = (n: any): boolean => {
    if (!n || typeof n !== 'object') return false
    if (n.type === 'pane') return PANE_IDS.includes(n.id)
    return n.type === 'split' && (n.dir === 'row' || n.dir === 'column') && typeof n.ratio === 'number' && n.ratio > 0 && n.ratio < 1 && ok(n.a) && ok(n.b)
  }
  if (!ok(value)) return false
  const ids = leaves(value as LayoutNode)
  return ids.length === PANE_IDS.length && new Set(ids).size === ids.length && PANE_IDS.every((id) => ids.includes(id))
}

export function hasVisible(node: LayoutNode, hidden: Set<PaneId>): boolean {
  return node.type === 'pane' ? !hidden.has(node.id) : hasVisible(node.a, hidden) || hasVisible(node.b, hidden)
}

export function clampRatio(r: number): number {
  return Math.min(0.9, Math.max(0.1, r))
}

export function setRatio(node: LayoutNode, path: Path, ratio: number): LayoutNode {
  if (node.type === 'pane') return node
  if (!path.length) return { ...node, ratio: clampRatio(ratio) }
  const [head, ...rest] = path
  return head === 'a' ? { ...node, a: setRatio(node.a, rest, ratio) } : { ...node, b: setRatio(node.b, rest, ratio) }
}

/** The tree without a pane; a split with one child left collapses into that child. */
export function removeLeaf(node: LayoutNode, id: PaneId): LayoutNode | null {
  if (node.type === 'pane') return node.id === id ? null : node
  const a = removeLeaf(node.a, id)
  const b = removeLeaf(node.b, id)
  if (!a) return b
  if (!b) return a
  return a === node.a && b === node.b ? node : { ...node, a, b }
}

/** Splits the target pane and puts the new pane on the given side of it. */
export function insertLeaf(node: LayoutNode, id: PaneId, targetId: PaneId, side: Side, share = 0.35): LayoutNode {
  if (node.type === 'pane') {
    if (node.id !== targetId) return node
    const leaf: LayoutNode = { type: 'pane', id }
    switch (side) {
      case 'left':
        return { type: 'split', dir: 'row', ratio: share, a: leaf, b: node }
      case 'right':
        return { type: 'split', dir: 'row', ratio: 1 - share, a: node, b: leaf }
      case 'top':
        return { type: 'split', dir: 'column', ratio: share, a: leaf, b: node }
      case 'bottom':
        return { type: 'split', dir: 'column', ratio: 1 - share, a: node, b: leaf }
      default:
        return node
    }
  }
  return { ...node, a: insertLeaf(node.a, id, targetId, side, share), b: insertLeaf(node.b, id, targetId, side, share) }
}

export function swapLeaves(node: LayoutNode, x: PaneId, y: PaneId): LayoutNode {
  if (node.type === 'pane') return node.id === x ? { type: 'pane', id: y } : node.id === y ? { type: 'pane', id: x } : node
  return { ...node, a: swapLeaves(node.a, x, y), b: swapLeaves(node.b, x, y) }
}

/** Drop a pane onto a side of another pane, or onto its middle to swap places. */
export function moveLeaf(node: LayoutNode, id: PaneId, targetId: PaneId, side: Side): LayoutNode {
  if (id === targetId) return node
  if (side === 'center') return swapLeaves(node, id, targetId)
  const without = removeLeaf(node, id)
  if (!without) return node
  return insertLeaf(without, id, targetId, side)
}

/** The cursor must be at least this far (as a fraction of the pane) from every edge to mean "swap". */
export const CENTER_MIN = 0.32
/** How far past a boundary the cursor must go before the highlighted zone changes. */
export const STICKY = 0.05

/** Picks the edge nearest the cursor, or the middle when the cursor is well inside; keeps the previous choice near a boundary. */
export function zoneFor(x: number, y: number, prev: Side | null): Side {
  const dist: Record<Side, number> = { left: x, right: 1 - x, top: y, bottom: 1 - y, center: Math.min(x, 1 - x, y, 1 - y) }
  const edges: Side[] = ['left', 'right', 'top', 'bottom']
  let best: Side = edges.reduce((a, b) => (dist[a] <= dist[b] ? a : b))
  if (dist[best] > CENTER_MIN) best = 'center'
  if (prev && prev !== best) {
    const keep = prev === 'center' ? dist.center > CENTER_MIN - STICKY : dist[prev] <= CENTER_MIN + STICKY && dist[prev] <= dist[best] + STICKY
    if (keep) return prev
  }
  return best
}
