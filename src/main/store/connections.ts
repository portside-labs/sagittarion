import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ConnectionConfig, StoredConnection } from '@shared/types'
import { describeTarget, normalizeConnection } from '@shared/connections'

export interface SecretCodec {
  readonly available: boolean
  encrypt(plain: string): string | null
  decrypt(cipher: string): string | null
}

/** Codec used when OS-level encryption is unavailable: secrets are simply not persisted. */
export const noopCodec: SecretCodec = {
  available: false,
  encrypt: () => null,
  decrypt: () => null
}

/** Accepts the pre-multi-database file layout (SSH fields at the top level) as well as the current one. */
export function migrateStored(raw: any): StoredConnection | null {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null
  if (raw.ssh && typeof raw.ssh === 'object') return raw as StoredConnection
  if (typeof raw.host === 'string') {
    const { host, port, username, auth, savePassword, privateKeyPath, savePassphrase, encryptedPassword, encryptedPassphrase, remotePath, ...rest } = raw
    return {
      ...rest,
      kind: 'sqlite',
      remotePath,
      ssh: { host, port: Number(port) || 22, username, auth: auth ?? 'key', savePassword, privateKeyPath, savePassphrase, encryptedPassword, encryptedPassphrase }
    }
  }
  return null
}

export class ConnectionStore {
  private cache: StoredConnection[] | null = null

  constructor(
    private readonly file: string,
    private readonly codec: SecretCodec
  ) {}

  private async load(): Promise<StoredConnection[]> {
    if (this.cache) return this.cache
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      const list = Array.isArray(parsed?.connections) ? parsed.connections : []
      this.cache = list.map(migrateStored).filter((c: StoredConnection | null): c is StoredConnection => c !== null)
    } catch {
      this.cache = []
    }
    return this.cache!
  }

  private async persist(list: StoredConnection[]): Promise<void> {
    this.cache = list
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    await fs.writeFile(tmp, JSON.stringify({ version: 2, connections: list }, null, 2), 'utf8')
    await fs.rename(tmp, this.file)
  }

  private decrypt(cipher: string | undefined): string | undefined {
    if (!cipher) return undefined
    const plain = this.codec.decrypt(cipher)
    return plain === null ? undefined : plain
  }

  private toConfig(stored: StoredConnection): ConnectionConfig {
    const { ssh, pg, ...rest } = stored
    const { encryptedPassword, encryptedPassphrase, ...sshRest } = ssh
    const cfg: ConnectionConfig = {
      ...rest,
      ssh: { ...sshRest, password: this.decrypt(encryptedPassword), passphrase: this.decrypt(encryptedPassphrase) }
    }
    if (pg) {
      const { encryptedPassword: pgCipher, ...pgRest } = pg
      cfg.pg = { ...pgRest, password: this.decrypt(pgCipher) }
    }
    return normalizeConnection(cfg)
  }

  async list(): Promise<ConnectionConfig[]> {
    const list = await this.load()
    return list
      .map((s) => this.toConfig(s))
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || a.name.localeCompare(b.name))
  }

  async get(id: string): Promise<ConnectionConfig | undefined> {
    const list = await this.load()
    const s = list.find((c) => c.id === id)
    return s ? this.toConfig(s) : undefined
  }

  async save(input: ConnectionConfig): Promise<ConnectionConfig> {
    const list = await this.load()
    const cfg = normalizeConnection(input)
    const now = Date.now()
    const id = cfg.id || randomUUID()
    const existing = list.find((c) => c.id === id)
    const { ssh, pg, ...rest } = cfg
    const { password: sshPassword, passphrase, ...sshRest } = ssh
    const stored: StoredConnection = {
      ...rest,
      id,
      name: cfg.name?.trim() || describeTarget(cfg),
      createdAt: existing?.createdAt ?? now,
      ssh: { ...sshRest }
    }
    const keepOrEncrypt = (flag: boolean | undefined, plain: string | undefined, previous: string | undefined): string | undefined => {
      if (!flag) return undefined
      if (plain && this.codec.available) return this.codec.encrypt(plain) ?? undefined
      if (plain === undefined) return previous
      return undefined
    }
    stored.ssh.encryptedPassword = keepOrEncrypt(ssh.savePassword, sshPassword, existing?.ssh.encryptedPassword)
    stored.ssh.encryptedPassphrase = keepOrEncrypt(ssh.savePassphrase, passphrase, existing?.ssh.encryptedPassphrase)
    if (cfg.kind === 'postgres' && pg) {
      const { password: pgPassword, ...pgRest } = pg
      stored.pg = { ...pgRest, encryptedPassword: keepOrEncrypt(pg.savePassword, pgPassword, existing?.pg?.encryptedPassword) }
    } else {
      delete stored.pg
    }
    const idx = list.findIndex((c) => c.id === id)
    if (idx >= 0) list[idx] = stored
    else list.push(stored)
    await this.persist(list)
    return this.toConfig(stored)
  }

  async touch(id: string): Promise<void> {
    const list = await this.load()
    const s = list.find((c) => c.id === id)
    if (!s) return
    s.lastUsedAt = Date.now()
    await this.persist(list)
  }

  async remove(id: string): Promise<void> {
    const list = await this.load()
    await this.persist(list.filter((c) => c.id !== id))
  }

  /** A copy of a saved connection, secrets included, named "<name> copy" (numbered when that name is taken). */
  async duplicate(id: string): Promise<ConnectionConfig> {
    const list = await this.load()
    const source = list.find((c) => c.id === id)
    if (!source) throw new Error('That connection no longer exists.')
    const taken = new Set(list.map((c) => c.name.toLowerCase()))
    const base = `${source.name.replace(/ copy(?: \d+)?$/i, '')} copy`
    let name = base
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`
    const copy: StoredConnection = { ...structuredClone(source), id: randomUUID(), name, createdAt: Date.now() }
    delete copy.lastUsedAt
    list.push(copy)
    await this.persist(list)
    return this.toConfig(copy)
  }

  /** Moves connections into a group, or out of any group when it is null. */
  async setGroup(ids: string[], group: string | null): Promise<void> {
    const list = await this.load()
    const name = group?.trim()
    const wanted = new Set(ids)
    for (const c of list) {
      if (!wanted.has(c.id)) continue
      if (name) c.group = name
      else delete c.group
    }
    await this.persist(list)
  }
}
