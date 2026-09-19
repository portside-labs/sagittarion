import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ConnectionConfig, StoredConnection } from '@shared/types'

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
      this.cache = Array.isArray(parsed?.connections) ? parsed.connections : []
    } catch {
      this.cache = []
    }
    return this.cache!
  }

  private async persist(list: StoredConnection[]): Promise<void> {
    this.cache = list
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    await fs.writeFile(tmp, JSON.stringify({ version: 1, connections: list }, null, 2), 'utf8')
    await fs.rename(tmp, this.file)
  }

  private toConfig(stored: StoredConnection): ConnectionConfig {
    const { encryptedPassword, encryptedPassphrase, ...rest } = stored
    const cfg: ConnectionConfig = { ...rest }
    if (encryptedPassword) {
      const p = this.codec.decrypt(encryptedPassword)
      if (p !== null) cfg.password = p
    }
    if (encryptedPassphrase) {
      const p = this.codec.decrypt(encryptedPassphrase)
      if (p !== null) cfg.passphrase = p
    }
    return cfg
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

  async save(cfg: ConnectionConfig): Promise<ConnectionConfig> {
    const list = await this.load()
    const now = Date.now()
    const id = cfg.id || randomUUID()
    const existing = list.find((c) => c.id === id)
    const { password, passphrase, ...rest } = cfg
    const stored: StoredConnection = {
      ...rest,
      id,
      name: cfg.name?.trim() || `${cfg.username}@${cfg.host}`,
      port: Number(cfg.port) || 22,
      createdAt: existing?.createdAt ?? now
    }
    if (cfg.savePassword && password && this.codec.available) {
      stored.encryptedPassword = this.codec.encrypt(password) ?? undefined
    } else if (cfg.savePassword && existing?.encryptedPassword && password === undefined) {
      stored.encryptedPassword = existing.encryptedPassword
    }
    if (cfg.savePassphrase && passphrase && this.codec.available) {
      stored.encryptedPassphrase = this.codec.encrypt(passphrase) ?? undefined
    } else if (cfg.savePassphrase && existing?.encryptedPassphrase && passphrase === undefined) {
      stored.encryptedPassphrase = existing.encryptedPassphrase
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
}
