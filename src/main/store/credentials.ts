import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SecretCodec } from './connections'

interface StoredCredentials {
  version: 1
  /** reference -> encrypted secret */
  secrets: Record<string, string>
}

/**
 * Secrets for AI connections, encrypted with the OS keychain codec and addressed by reference.
 * Settings hold only the reference, never the secret.
 */
export class CredentialStore {
  private cache: StoredCredentials | null = null

  constructor(
    private readonly file: string,
    private readonly codec: SecretCodec
  ) {}

  get available(): boolean {
    return this.codec.available
  }

  private async load(): Promise<StoredCredentials> {
    if (this.cache) return this.cache
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'))
      this.cache = { version: 1, secrets: parsed?.secrets && typeof parsed.secrets === 'object' ? parsed.secrets : {} }
    } catch {
      this.cache = { version: 1, secrets: {} }
    }
    return this.cache
  }

  private async persist(s: StoredCredentials): Promise<void> {
    this.cache = s
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(s, null, 2), 'utf8')
    await fs.rename(tmp, this.file)
  }

  /** The secret, or null when there is none or it cannot be decrypted on this machine. */
  async get(ref: string): Promise<string | null> {
    const cipher = (await this.load()).secrets[ref]
    if (!cipher) return null
    return this.codec.decrypt(cipher)
  }

  /** The last four characters, for placeholders. */
  async hint(ref: string): Promise<string | null> {
    const plain = await this.get(ref)
    return plain ? plain.slice(-4) : null
  }

  async set(ref: string, plain: string): Promise<void> {
    if (!this.codec.available) throw new Error('This system cannot store secrets securely, so the key was not saved.')
    const cipher = this.codec.encrypt(plain)
    if (!cipher) throw new Error('Could not encrypt the key.')
    const s = await this.load()
    await this.persist({ ...s, secrets: { ...s.secrets, [ref]: cipher } })
  }

  async remove(ref: string): Promise<void> {
    const s = await this.load()
    if (!(ref in s.secrets)) return
    const secrets = { ...s.secrets }
    delete secrets[ref]
    await this.persist({ ...s, secrets })
  }

  /** Takes an already encrypted secret as-is, for settings written before this store existed. */
  async importEncrypted(ref: string, cipher: string): Promise<void> {
    const s = await this.load()
    await this.persist({ ...s, secrets: { ...s.secrets, [ref]: cipher } })
  }
}
