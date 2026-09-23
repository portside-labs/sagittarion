import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SshProfile, StoredSshProfile } from '@shared/types'
import { defaultSsh } from '@shared/connections'
import type { SecretCodec } from './connections'

/** Saved SSH hosts, reusable by reference from any connection. Secrets are encrypted like connection secrets. */
export class SshProfileStore {
  private cache: StoredSshProfile[] | null = null

  constructor(
    private readonly file: string,
    private readonly codec: SecretCodec
  ) {}

  private async load(): Promise<StoredSshProfile[]> {
    if (this.cache) return this.cache
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'))
      const list = Array.isArray(parsed?.profiles) ? parsed.profiles : []
      this.cache = list.filter((p: any) => p && typeof p.id === 'string' && typeof p.name === 'string')
    } catch {
      this.cache = []
    }
    return this.cache!
  }

  private async persist(list: StoredSshProfile[]): Promise<void> {
    this.cache = list
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    await fs.writeFile(tmp, JSON.stringify({ version: 1, profiles: list }, null, 2), 'utf8')
    await fs.rename(tmp, this.file)
  }

  private decrypt(cipher: string | undefined): string | undefined {
    if (!cipher) return undefined
    const plain = this.codec.decrypt(cipher)
    return plain === null ? undefined : plain
  }

  private toProfile(stored: StoredSshProfile): SshProfile {
    const { encryptedPassword, encryptedPassphrase, ...rest } = stored
    const p: SshProfile = { ...defaultSsh(), ...rest, password: this.decrypt(encryptedPassword), passphrase: this.decrypt(encryptedPassphrase) }
    p.port = Number(p.port) || 22
    return p
  }

  async list(): Promise<SshProfile[]> {
    const list = await this.load()
    return list.map((p) => this.toProfile(p)).sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || a.name.localeCompare(b.name))
  }

  async get(id: string): Promise<SshProfile | undefined> {
    const s = (await this.load()).find((p) => p.id === id)
    return s ? this.toProfile(s) : undefined
  }

  async save(input: SshProfile): Promise<SshProfile> {
    const list = await this.load()
    const id = input.id || randomUUID()
    const existing = list.find((p) => p.id === id)
    const { password, passphrase, ...rest } = input
    const keepOrEncrypt = (flag: boolean | undefined, plain: string | undefined, previous: string | undefined): string | undefined => {
      if (!flag) return undefined
      if (plain && this.codec.available) return this.codec.encrypt(plain) ?? undefined
      if (plain === undefined) return previous
      return undefined
    }
    const stored: StoredSshProfile = {
      ...rest,
      id,
      name: input.name.trim() || `${input.username}@${input.host}`,
      host: input.host.trim(),
      username: input.username.trim(),
      port: Number(input.port) || 22,
      createdAt: existing?.createdAt ?? Date.now(),
      encryptedPassword: keepOrEncrypt(input.savePassword, password, existing?.encryptedPassword),
      encryptedPassphrase: keepOrEncrypt(input.savePassphrase, passphrase, existing?.encryptedPassphrase)
    }
    const idx = list.findIndex((p) => p.id === id)
    if (idx >= 0) list[idx] = stored
    else list.push(stored)
    await this.persist(list)
    return this.toProfile(stored)
  }

  async touch(id: string): Promise<void> {
    const list = await this.load()
    const s = list.find((p) => p.id === id)
    if (!s) return
    s.lastUsedAt = Date.now()
    await this.persist(list)
  }

  async remove(id: string): Promise<void> {
    const list = await this.load()
    await this.persist(list.filter((p) => p.id !== id))
  }
}
