import { createHash, createHmac } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface KnownHostEntry {
  host: string
  port: number
  keyType: string
  fingerprint: string
  /** base64 of the raw public key blob */
  key: string
  addedAt: number
}

export type HostKeyStatus = 'trusted' | 'unknown' | 'mismatch'

export interface HostKeyCheck {
  status: HostKeyStatus
  keyType: string
  fingerprint: string
  /** Where the trust decision came from. */
  source?: 'app' | 'openssh'
  previous?: KnownHostEntry
}

export function parseKeyType(key: Buffer): string {
  if (key.length < 4) return 'unknown'
  const len = key.readUInt32BE(0)
  if (len <= 0 || len > 64 || key.length < 4 + len) return 'unknown'
  return key.subarray(4, 4 + len).toString('ascii')
}

export function fingerprintSha256(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

export function humanKeyType(keyType: string): string {
  const map: Record<string, string> = {
    'ssh-ed25519': 'ED25519',
    'ssh-rsa': 'RSA',
    'rsa-sha2-256': 'RSA',
    'rsa-sha2-512': 'RSA',
    'ecdsa-sha2-nistp256': 'ECDSA',
    'ecdsa-sha2-nistp384': 'ECDSA',
    'ecdsa-sha2-nistp521': 'ECDSA',
    'ssh-dss': 'DSA'
  }
  return map[keyType] ?? keyType
}

/**
 * Check a host key against an OpenSSH known_hosts file's contents.
 * Supports plain, comma-separated and hashed (|1|salt|hash) host fields,
 * plus [host]:port for non-standard ports.
 */
export function matchOpenSshKnownHosts(
  content: string,
  host: string,
  port: number,
  key: Buffer
): 'match' | 'mismatch' | 'none' {
  const keyB64 = key.toString('base64')
  const keyType = parseKeyType(key)
  const lowerHost = host.toLowerCase()
  const names = port === 22 ? [lowerHost] : [`[${lowerHost}]:${port}`]
  let sawMismatch = false

  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    let fields = line.split(/\s+/)
    let marker = ''
    if (fields[0].startsWith('@')) {
      marker = fields[0]
      fields = fields.slice(1)
    }
    if (fields.length < 3) continue
    if (marker === '@cert-authority') continue
    const [hostField, type, b64] = fields
    if (type !== keyType) continue
    const matched = hostField.startsWith('|1|')
      ? hashedHostMatches(hostField, names)
      : hostField
          .split(',')
          .map((h) => h.toLowerCase())
          .some((h) => names.includes(h))
    if (!matched) continue
    if (b64 === keyB64) {
      if (marker === '@revoked') return 'mismatch'
      return 'match'
    }
    sawMismatch = true
  }
  return sawMismatch ? 'mismatch' : 'none'
}

function hashedHostMatches(field: string, names: string[]): boolean {
  const parts = field.split('|')
  if (parts.length < 4) return false
  const salt = Buffer.from(parts[2], 'base64')
  const hash = parts[3]
  return names.some((n) => createHmac('sha1', salt).update(n).digest('base64') === hash)
}

/**
 * The app's own trust store (JSON), consulted before the user's OpenSSH
 * known_hosts file. Keys accepted through the app's prompt are saved here.
 */
export class KnownHostsStore {
  private cache: KnownHostEntry[] | null = null

  constructor(
    private readonly file: string,
    private readonly opensshKnownHosts?: string
  ) {}

  async load(): Promise<KnownHostEntry[]> {
    if (this.cache) return this.cache
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      this.cache = Array.isArray(parsed) ? parsed : []
    } catch {
      this.cache = []
    }
    return this.cache
  }

  async find(host: string, port: number): Promise<KnownHostEntry | undefined> {
    const list = await this.load()
    return list.find((e) => e.host.toLowerCase() === host.toLowerCase() && e.port === port)
  }

  async save(entry: KnownHostEntry): Promise<void> {
    const list = await this.load()
    const idx = list.findIndex((e) => e.host.toLowerCase() === entry.host.toLowerCase() && e.port === entry.port)
    if (idx >= 0) list[idx] = entry
    else list.push(entry)
    await this.persist(list)
  }

  async remove(host: string, port: number): Promise<void> {
    const list = await this.load()
    await this.persist(list.filter((e) => !(e.host.toLowerCase() === host.toLowerCase() && e.port === port)))
  }

  async check(host: string, port: number, key: Buffer): Promise<HostKeyCheck> {
    const keyType = parseKeyType(key)
    const fingerprint = fingerprintSha256(key)
    const known = await this.find(host, port)
    if (known) {
      if (known.key === key.toString('base64')) {
        return { status: 'trusted', keyType, fingerprint, source: 'app' }
      }
      return { status: 'mismatch', keyType, fingerprint, source: 'app', previous: known }
    }
    if (this.opensshKnownHosts) {
      try {
        const content = await fs.readFile(this.opensshKnownHosts, 'utf8')
        const result = matchOpenSshKnownHosts(content, host, port, key)
        if (result === 'match') return { status: 'trusted', keyType, fingerprint, source: 'openssh' }
        if (result === 'mismatch') return { status: 'mismatch', keyType, fingerprint, source: 'openssh' }
      } catch {
        /* no known_hosts file */
      }
    }
    return { status: 'unknown', keyType, fingerprint }
  }

  entryFor(host: string, port: number, key: Buffer): KnownHostEntry {
    return {
      host,
      port,
      keyType: parseKeyType(key),
      fingerprint: fingerprintSha256(key),
      key: key.toString('base64'),
      addedAt: Date.now()
    }
  }

  private async persist(list: KnownHostEntry[]): Promise<void> {
    this.cache = list
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8')
    await fs.rename(tmp, this.file)
  }
}
