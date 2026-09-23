import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ConnectionStore, noopCodec, type SecretCodec } from '../src/main/store/connections'
import { newConnection } from '../src/shared/connections'

/** Reversible stand-in for OS encryption, so secrets can be checked after a copy. */
const codec: SecretCodec = {
  available: true,
  encrypt: (plain) => `enc:${plain}`,
  decrypt: (cipher) => (cipher.startsWith('enc:') ? cipher.slice(4) : null)
}

describe('ConnectionStore.duplicate', () => {
  it('copies a connection with its secrets and group under a numbered "copy" name', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'conn-store-'))
    try {
      const store = new ConnectionStore(path.join(dir, 'connections.json'), codec)
      const original = await store.save({
        ...newConnection('sqlite'),
        name: 'Marbles',
        group: 'Acme',
        remote: true,
        remotePath: '/srv/marbles.db',
        ssh: { host: 'db.example.com', port: 22, username: 'ubuntu', auth: 'password', password: 'hunter2', savePassword: true, savePassphrase: true }
      })
      const first = await store.duplicate(original.id)
      expect(first.id).not.toBe(original.id)
      expect(first.name).toBe('Marbles copy')
      expect(first.group).toBe('Acme')
      expect(first.remotePath).toBe('/srv/marbles.db')
      expect(first.ssh.password).toBe('hunter2')
      expect(first.lastUsedAt).toBeUndefined()

      const second = await store.duplicate(original.id)
      expect(second.name).toBe('Marbles copy 2')
      const third = await store.duplicate(second.id)
      expect(third.name).toBe('Marbles copy 3')

      // The copy is on disk, not just in memory.
      const reread = new ConnectionStore(path.join(dir, 'connections.json'), codec)
      expect((await reread.list()).map((c) => c.name).sort()).toEqual(['Marbles', 'Marbles copy', 'Marbles copy 2', 'Marbles copy 3'])
      await expect(store.duplicate('nope')).rejects.toThrow(/no longer exists/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still copies when secrets cannot be stored', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'conn-store-'))
    try {
      const store = new ConnectionStore(path.join(dir, 'connections.json'), noopCodec)
      const original = await store.save({ ...newConnection('sqlite'), name: 'Local', remotePath: '/tmp/a.db' })
      const copy = await store.duplicate(original.id)
      expect(copy.name).toBe('Local copy')
      expect(copy.remotePath).toBe('/tmp/a.db')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
