import { describe, expect, it } from 'vitest'
import type { ConnectionConfig } from '../src/shared/types'
import { newConnection } from '../src/shared/connections'
import { clusterTabs, groupByConnection, moveTab, nearestTab, settleCollapsed, tabUnits, tabsInSight } from '../src/renderer/src/lib/tab-groups'

const conn = (id: string, group?: string): ConnectionConfig => ({ ...newConnection('sqlite'), id, name: id, group })
const tab = (connectionId: string) => ({ connectionId })
const ids = (list: { connectionId: string }[]) => list.map((t) => t.connectionId)

describe('tab groups', () => {
  // a, b and e are in Prod (spelled two ways), c in Ops, d in no group.
  const groupOf = groupByConnection([conn('a', 'Prod'), conn('b', 'prod'), conn('c', 'Ops'), conn('d'), conn('e', ' Prod ')])

  it('names each connection’s group as the connection list does', () => {
    expect([...groupOf.entries()]).toEqual([
      ['c', 'Ops'],
      ['a', 'Prod'],
      ['b', 'Prod'],
      ['e', 'Prod']
    ])
  })

  it('keeps a group where its first tab is, with its tabs side by side in their order', () => {
    const units = tabUnits([tab('b'), tab('d'), tab('c'), tab('a')], groupOf)
    expect(units.map((u) => (u.kind === 'tab' ? u.tab.connectionId : `${u.name}: ${ids(u.tabs)}`))).toEqual(['Prod: b,a', 'd', 'Ops: c'])
    const tabs = [tab('b'), tab('d'), tab('a')]
    expect(ids(clusterTabs(tabs, groupOf))).toEqual(['b', 'a', 'd'])
    const clustered = [tab('b'), tab('a'), tab('d')]
    expect(clusterTabs(clustered, groupOf)).toBe(clustered)
  })

  it('moves a tab within its group, and a loose tab or a whole group along the strip', () => {
    const units = tabUnits([tab('d'), tab('a'), tab('b'), tab('e'), tab('c')], groupOf)
    expect(moveTab(units, 'Prod', 2, 0)).toEqual(['d', 'e', 'a', 'b', 'c'])
    expect(moveTab(units, null, 2, 0)).toEqual(['c', 'd', 'a', 'b', 'e'])
    expect(moveTab(units, null, 0, 1)).toEqual(['a', 'b', 'e', 'd', 'c'])
    expect(moveTab(units, 'Ops', 0, 0)).toEqual(['d', 'a', 'b', 'e', 'c'])
    expect(moveTab(units, null, 0, 9)).toEqual(['d', 'a', 'b', 'e', 'c'])
  })

  it('hides the tabs of a collapsed group and brings forward the nearest one in sight', () => {
    const tabs = [tab('d'), tab('a'), tab('b'), tab('c')]
    expect(ids(tabsInSight(tabs, groupOf, ['Prod']))).toEqual(['d', 'c'])
    expect(tabsInSight(tabs, groupOf, [])).toBe(tabs)
    const canSee = (t: { connectionId: string }) => groupOf.get(t.connectionId) !== 'Prod'
    // Collapsing Prod (a, b at 1-2) from the front: the tab to its right first, then the one to its left.
    expect(nearestTab(tabs, 3, 0, canSee)?.connectionId).toBe('c')
    expect(nearestTab(tabs.slice(0, 3), 3, 0, canSee)?.connectionId).toBe('d')
    expect(nearestTab([tab('a'), tab('b')], 2, -1, canSee)).toBeUndefined()
  })

  it('lets a collapsed group go with its last tab, and never keeps the tab in front tucked away', () => {
    const tabs = [tab('a'), tab('c'), tab('d')]
    const collapsed = ['Prod', 'Ops']
    expect(settleCollapsed(collapsed, tabs, groupOf, 'd')).toBe(collapsed)
    expect(settleCollapsed(collapsed, tabs, groupOf, null)).toBe(collapsed)
    expect(settleCollapsed(collapsed, tabs, groupOf, 'a')).toEqual(['Ops'])
    expect(settleCollapsed(collapsed, [tab('c'), tab('d')], groupOf, 'd')).toEqual(['Ops'])
    expect(settleCollapsed(['Gone'], tabs, groupOf, null)).toEqual([])
  })
})
