import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PRIVACY, normalizePrivacy } from '../../src/shared/privacy'
import { CredentialStore } from '../../src/main/store/credentials'
import { SettingsStore } from '../../src/main/store/settings'
import type { SecretCodec } from '../../src/main/store/connections'
import { ConversationVaults } from '../../src/main/privacy/conversations'

const codec: SecretCodec = { available: true, encrypt: (p) => `enc:${p}`, decrypt: (c) => (c.startsWith('enc:') ? c.slice(4) : null) }

function withStore(fn: (settings: SettingsStore, dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'privacy-settings-'))
    try {
      await fn(new SettingsStore(path.join(dir, 'settings.json'), new CredentialStore(path.join(dir, 'credentials.json'), codec)), dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

describe('privacy settings', () => {
  it(
    'default to protection on, including for settings written before the feature existed',
    withStore(async (settings, dir) => {
      writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ ai: { provider: 'openai', model: 'gpt-x' } }))
      const s = await settings.get()
      expect(s.privacy).toEqual(DEFAULT_PRIVACY)
      expect(s.privacy).toEqual({ enabled: true, policyId: 'general-pii', schemaDetection: true, semanticDetection: false, protectLocalModels: false })
    })
  )

  it(
    'save changes, and refuse values that are not options',
    withStore(async (settings, dir) => {
      let s = await settings.update({ privacy: { protectLocalModels: true, schemaDetection: false } })
      expect(s.privacy).toMatchObject({ enabled: true, protectLocalModels: true, schemaDetection: false })
      // Semantic detection is kept as chosen: whether the model can run is checked when an ask needs it (and fails
      // closed), and Settings only offers the switch once the model is installed.
      s = await settings.update({ privacy: { semanticDetection: true, policyId: 'hipaa' as never, enabled: 'yes' as never } })
      expect(s.privacy).toEqual({ enabled: true, policyId: 'general-pii', schemaDetection: false, semanticDetection: true, protectLocalModels: true })
      s = await settings.update({ privacy: { enabled: false } })
      expect(s.privacy.enabled).toBe(false)
      expect(JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8')).ai.privacy).toEqual(s.privacy)
      // Other settings are untouched.
      expect(s.agent).toEqual({ schemaBudgetTokens: 8000, autoRun: true, sendSampleValues: false })
    })
  )

  it('normalize anything stored into a complete, valid block', () => {
    expect(normalizePrivacy(undefined)).toEqual(DEFAULT_PRIVACY)
    expect(normalizePrivacy('garbage')).toEqual(DEFAULT_PRIVACY)
    expect(normalizePrivacy({ enabled: false, extra: 1 })).toEqual({ ...DEFAULT_PRIVACY, enabled: false })
  })
})

describe('conversation vaults', () => {
  it('scope placeholders to one chat of one session', () => {
    const vaults = new ConversationVaults()
    const a = vaults.vault('s1', 'chat-a')
    expect(vaults.vault('s1', 'chat-a')).toBe(a)
    expect(vaults.vault('s1', 'chat-b')).not.toBe(a)
    expect(vaults.vault('s2', 'chat-a')).not.toBe(a)
    vaults.vault('s2', 'chat-c')
    // Resetting a chat forgets its placeholders.
    vaults.forget('chat-a')
    expect(vaults.size).toBe(2)
    expect(vaults.vault('s1', 'chat-a')).not.toBe(a)
    // Closing a connection forgets all of its chats.
    vaults.forgetSession('s1')
    expect(vaults.size).toBe(1) // only s2's chat-c is left
  })

  it('drop idle chats and the least recently used when there are too many', () => {
    let now = 0
    const vaults = new ConversationVaults({ idleMs: 1000, max: 2 }, () => now)
    const a = vaults.vault('s', 'a')
    now = 500
    const b = vaults.vault('s', 'b')
    now = 600
    expect(vaults.vault('s', 'a')).toBe(a) // touched again
    vaults.vault('s', 'c') // over the limit: b was used least recently
    expect(vaults.size).toBe(2)
    expect(vaults.vault('s', 'b')).not.toBe(b)
    now = 5000
    vaults.vault('s', 'd') // everything else has been idle too long
    expect(vaults.size).toBe(1)
  })
})
