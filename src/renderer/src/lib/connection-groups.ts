import type { ConnectionConfig } from '@shared/types'

export interface ConnectionGroup {
  /** null for connections in no group; they are listed after the named groups. */
  name: string | null
  connections: ConnectionConfig[]
}

const compare = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' })

/**
 * Named groups in alphabetical order, each keeping the list's own order, then the ungrouped connections.
 * Names are matched case-insensitively so "prod" and "Prod" do not split; the first spelling seen is shown.
 */
export function groupConnections(list: ConnectionConfig[]): ConnectionGroup[] {
  const named = new Map<string, ConnectionConfig[]>()
  const loose: ConnectionConfig[] = []
  for (const c of list) {
    const name = c.group?.trim()
    if (!name) {
      loose.push(c)
      continue
    }
    const key = [...named.keys()].find((k) => compare(k, name) === 0) ?? name
    const members = named.get(key) ?? []
    members.push(c)
    named.set(key, members)
  }
  const out: ConnectionGroup[] = [...named.entries()].sort(([a], [b]) => compare(a, b)).map(([name, connections]) => ({ name, connections }))
  if (loose.length) out.push({ name: null, connections: loose })
  return out
}

/** Every group name in use, alphabetically. */
export function groupNames(list: ConnectionConfig[]): string[] {
  return groupConnections(list).flatMap((g) => (g.name ? [g.name] : []))
}

const COLLAPSED_KEY = 'connGroupsCollapsed'

/** Groups the user folded up, remembered per machine. */
export function loadCollapsedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    const arr: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

export function saveCollapsedGroups(collapsed: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]))
  } catch {
    /* storage may be unavailable; the fold state is only a convenience */
  }
}
