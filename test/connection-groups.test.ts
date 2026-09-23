import { describe, expect, it } from 'vitest'
import type { ConnectionConfig } from '../src/shared/types'
import { newConnection, normalizeConnection } from '../src/shared/connections'
import { groupConnections, groupNames, loadCollapsedGroups } from '../src/renderer/src/lib/connection-groups'

const conn = (name: string, group?: string): ConnectionConfig => ({ ...newConnection('sqlite'), id: name, name, group })

describe('connection groups', () => {
  it('lists named groups alphabetically, keeping each group in list order, then the loose connections', () => {
    const groups = groupConnections([conn('c', 'Zeta'), conn('a'), conn('b', 'acme'), conn('d', 'Zeta'), conn('e', 'Acme')])
    expect(groups.map((g) => [g.name, g.connections.map((c) => c.name)])).toEqual([
      ['acme', ['b', 'e']],
      ['Zeta', ['c', 'd']],
      [null, ['a']]
    ])
    expect(groupNames([conn('c', 'Zeta'), conn('b', 'acme')])).toEqual(['acme', 'Zeta'])
  })

  it('treats blank names as no group and trims the rest', () => {
    expect(groupConnections([conn('a', '  '), conn('b', ' Ops ')]).map((g) => g.name)).toEqual(['Ops', null])
    expect(normalizeConnection(conn('a', '  ')).group).toBeUndefined()
    expect(normalizeConnection(conn('b', ' Ops ')).group).toBe('Ops')
  })

  it('has no groups at all for an empty list and survives a missing localStorage', () => {
    expect(groupConnections([])).toEqual([])
    expect(loadCollapsedGroups().size).toBe(0)
  })
})
