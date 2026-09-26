import type { ConnectionConfig } from '@shared/types'
import { groupConnections } from './connection-groups'

/** Which group each saved connection is listed under, spelled as the connection list spells it. */
export function groupByConnection(connections: ConnectionConfig[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const g of groupConnections(connections)) {
    if (g.name === null) continue
    for (const c of g.connections) out.set(c.id, g.name)
  }
  return out
}

/** One stop along the tab strip: a tab in no group, or a group with its tabs behind its label. */
export type TabUnit<T> = { kind: 'tab'; tab: T } | { kind: 'group'; name: string; tabs: T[] }

/** The tabs as the strip shows them. A group sits where its first tab is and keeps its own tabs in their order. */
export function tabUnits<T extends { connectionId: string }>(tabs: T[], groupOf: Map<string, string>): TabUnit<T>[] {
  const units: TabUnit<T>[] = []
  const groups = new Map<string, T[]>()
  for (const tab of tabs) {
    const name = groupOf.get(tab.connectionId)
    if (!name) {
      units.push({ kind: 'tab', tab })
      continue
    }
    const members = groups.get(name)
    if (members) members.push(tab)
    else {
      const unit = { kind: 'group' as const, name, tabs: [tab] }
      groups.set(name, unit.tabs)
      units.push(unit)
    }
  }
  return units
}

function flatten<T>(units: TabUnit<T>[]): T[] {
  return units.flatMap((u) => (u.kind === 'tab' ? [u.tab] : u.tabs))
}

/** The tabs with each group's tabs side by side; the same array when that is already so. */
export function clusterTabs<T extends { connectionId: string }>(tabs: T[], groupOf: Map<string, string>): T[] {
  const next = flatten(tabUnits(tabs, groupOf))
  return next.every((t, i) => t === tabs[i]) ? tabs : next
}

function move<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length || to < 0 || to >= list.length) return list
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/**
 * Connection ids in their new order after a drag: a tab moved within its group (`group` names it), or a loose tab
 * or a whole group moved along the strip (`group` null). Tabs never leave their group this way; the group is part
 * of the saved connection.
 */
export function moveTab<T extends { connectionId: string }>(units: TabUnit<T>[], group: string | null, from: number, to: number): string[] {
  const next =
    group === null
      ? move(units, from, to)
      : units.map((u) => (u.kind === 'group' && u.name === group ? { ...u, tabs: move(u.tabs, from, to) } : u))
  return flatten(next).map((t) => t.connectionId)
}

/** The tabs that can be seen: all but those tucked away in a collapsed group. */
export function tabsInSight<T extends { connectionId: string }>(tabs: T[], groupOf: Map<string, string>, collapsed: readonly string[]): T[] {
  if (!collapsed.length) return tabs
  return tabs.filter((t) => {
    const group = groupOf.get(t.connectionId)
    return group === undefined || !collapsed.includes(group)
  })
}

/**
 * The tab to bring to the front when the one there goes out of sight: the nearest that can be seen, looking from
 * `right` onwards first and then from `left` back, as a browser does when a tab closes or its group collapses.
 */
export function nearestTab<T>(tabs: T[], right: number, left: number, canSee: (t: T) => boolean): T | undefined {
  for (let i = Math.max(0, right); i < tabs.length; i++) if (canSee(tabs[i])) return tabs[i]
  for (let i = Math.min(left, tabs.length - 1); i >= 0; i--) if (canSee(tabs[i])) return tabs[i]
  return undefined
}

/**
 * The collapsed groups that still hold: a group goes with its last tab, and the group of the tab in front (`front`,
 * null while the connect screen is up) opens, so that tab is never tucked away. The same array when nothing changes.
 */
export function settleCollapsed(collapsed: string[], tabs: { connectionId: string }[], groupOf: Map<string, string>, front: string | null): string[] {
  if (!collapsed.length) return collapsed
  const open = new Set(tabs.flatMap((t) => groupOf.get(t.connectionId) ?? []))
  const frontGroup = front === null ? undefined : groupOf.get(front)
  const next = collapsed.filter((name) => open.has(name) && name !== frontGroup)
  return next.length === collapsed.length ? collapsed : next
}
