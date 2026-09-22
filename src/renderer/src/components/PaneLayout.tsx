import { useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Splitter } from './Splitter'
import { Icon } from './Icons'
import { clampRatio, hasVisible, zoneFor, type LayoutNode, type PaneId, type Path, type Side } from '@/lib/layout'

const MIME = 'application/x-sagittarion-pane'
const PANE_TITLES: Record<PaneId, string> = { editor: 'SQL', chat: 'Ask', results: 'Results' }

/** Spread onto the element that starts a drag, usually the pane header. */
export interface DragHandleProps {
  draggable: true
  onDragStart: (e: DragEvent) => void
  onDragEnd: (e: DragEvent) => void
}

export function PaneHeader({ title, handle, children, testId }: { title: string; handle: DragHandleProps; children?: ReactNode; testId?: string }) {
  return (
    <div className="pane-header" {...handle} data-testid={testId} title="Drag to move this pane; drop it on the edge of another">
      <Icon className="pane-grip" name="grip" size={12} />
      <span className="pane-title">{title}</span>
      {children}
    </div>
  )
}

interface Hover {
  id: PaneId
  zone: Side
}

interface Props {
  layout: LayoutNode
  hidden: Set<PaneId>
  render: (id: PaneId, handle: DragHandleProps) => ReactNode
  onRatio: (path: Path, ratio: number) => void
  onMove: (id: PaneId, target: PaneId, side: Side) => void
}

/** Renders the split tree: resizable with splitters, rearranged by dragging pane headers. */
export function PaneLayout({ layout, hidden, render, onRatio, onMove }: Props) {
  const [dragging, setDragging] = useState<PaneId | null>(null)
  const [hover, setHover] = useState<Hover | null>(null)
  const handleFor = (id: PaneId): DragHandleProps => ({
    draggable: true,
    onDragStart: (e) => {
      e.dataTransfer.setData(MIME, id)
      e.dataTransfer.effectAllowed = 'move'
      setDragging(id)
    },
    onDragEnd: () => {
      setDragging(null)
      setHover(null)
    }
  })
  const ctx: Ctx = {
    hidden,
    render,
    handleFor,
    dragging,
    hover,
    setHover,
    onRatio,
    onMove: (id, target, side) => {
      setDragging(null)
      setHover(null)
      onMove(id, target, side)
    }
  }
  return <div className={`layout-root ${dragging ? 'dragging' : ''}`}>{hasVisible(layout, hidden) ? <Node node={layout} path={[]} ctx={ctx} /> : null}</div>
}

interface Ctx {
  hidden: Set<PaneId>
  render: (id: PaneId, handle: DragHandleProps) => ReactNode
  handleFor: (id: PaneId) => DragHandleProps
  dragging: PaneId | null
  hover: Hover | null
  setHover: (h: Hover | null) => void
  onRatio: (path: Path, ratio: number) => void
  onMove: (id: PaneId, target: PaneId, side: Side) => void
}

function Node({ node, path, ctx }: { node: LayoutNode; path: Path; ctx: Ctx }) {
  if (node.type === 'pane') return <PaneSlot id={node.id} ctx={ctx} />
  const showA = hasVisible(node.a, ctx.hidden)
  const showB = hasVisible(node.b, ctx.hidden)
  if (!showA && !showB) return null
  if (!showA) return <Node node={node.b} path={[...path, 'b']} ctx={ctx} />
  if (!showB) return <Node node={node.a} path={[...path, 'a']} ctx={ctx} />
  return <SplitView node={node} path={path} ctx={ctx} />
}

function SplitView({ node, path, ctx }: { node: Extract<LayoutNode, { type: 'split' }>; path: Path; ctx: Ctx }) {
  const ref = useRef<HTMLDivElement>(null)
  const isRow = node.dir === 'row'
  // Read the real sizes on every step so a drag stays right even while the tree re-renders.
  const resize = (delta: number) => {
    const el = ref.current
    if (!el) return
    const whole = el.getBoundingClientRect()
    const first = el.firstElementChild?.getBoundingClientRect()
    const size = isRow ? whole.width : whole.height
    const current = first ? (isRow ? first.width : first.height) : size * node.ratio
    if (size > 0) ctx.onRatio(path, clampRatio((current + delta) / size))
  }
  return (
    <div ref={ref} className={`layout-split ${node.dir}`}>
      <div className="layout-child" style={{ flex: `${node.ratio} 1 0%` }}>
        <Node node={node.a} path={[...path, 'a']} ctx={ctx} />
      </div>
      <Splitter direction={isRow ? 'vertical' : 'horizontal'} onResize={resize} />
      <div className="layout-child" style={{ flex: `${1 - node.ratio} 1 0%` }}>
        <Node node={node.b} path={[...path, 'b']} ctx={ctx} />
      </div>
    </div>
  )
}

function zoneAt(e: DragEvent, prev: Side | null): Side {
  const r = e.currentTarget.getBoundingClientRect()
  return zoneFor((e.clientX - r.left) / Math.max(1, r.width), (e.clientY - r.top) / Math.max(1, r.height), prev)
}

function dropLabel(source: PaneId, target: PaneId, zone: Side): string {
  const s = PANE_TITLES[source]
  const t = PANE_TITLES[target]
  switch (zone) {
    case 'left':
      return `${s} left of ${t}`
    case 'right':
      return `${s} right of ${t}`
    case 'top':
      return `${s} above ${t}`
    case 'bottom':
      return `${s} below ${t}`
    default:
      return `Swap ${s} and ${t}`
  }
}

function PaneSlot({ id, ctx }: { id: PaneId; ctx: Ctx }) {
  const active = Boolean(ctx.dragging && ctx.dragging !== id)
  const zone = ctx.hover?.id === id ? ctx.hover.zone : null
  return (
    <div
      className={`pane-slot ${active ? 'droppable' : ''}`}
      data-pane={id}
      onDragOver={(e) => {
        if (!active) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const z = zoneAt(e, zone)
        if (z !== zone) ctx.setHover({ id, zone: z })
      }}
      onDrop={(e) => {
        if (!active) return
        e.preventDefault()
        const src = (e.dataTransfer.getData(MIME) || ctx.dragging) as PaneId
        if (src && src !== id) ctx.onMove(src, id, zoneAt(e, zone))
      }}
    >
      {ctx.render(id, ctx.handleFor(id))}
      {active && zone && ctx.dragging ? (
        <div className={`drop-zone ${zone}`}>
          <span className="drop-label">{dropLabel(ctx.dragging, id, zone)}</span>
        </div>
      ) : null}
    </div>
  )
}
