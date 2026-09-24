import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CredentialStore } from '../src/main/store/credentials'
import { SettingsStore } from '../src/main/store/settings'
import { noopCodec, type SecretCodec } from '../src/main/store/connections'

/** Reversible stand-in for OS encryption. */
const codec: SecretCodec = {
  available: true,
  encrypt: (plain) => `enc:${plain}`,
  decrypt: (cipher) => (cipher.startsWith('enc:') ? cipher.slice(4) : null)
}

function stores(dir: string, c: SecretCodec = codec) {
  const credentials = new CredentialStore(path.join(dir, 'credentials.json'), c)
  return { credentials, settings: new SettingsStore(path.join(dir, 'settings.json'), credentials) }
}

describe('AI settings', () => {
  it('migrates the provider-centric layout into connections without anyone retyping a key', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ai-settings-'))
    try {
      writeFileSync(
        path.join(dir, 'settings.json'),
        JSON.stringify({
          ai: {
            provider: 'anthropic',
            baseUrl: 'https://api.anthropic.com',
            model: 'claude-x',
            embeddingModel: '',
            sendSampleValues: true,
            autoRun: false,
            schemaBudgetTokens: 16000,
            keys: { anthropic: 'enc:sk-ant-1', openai: 'enc:sk-oa-1', custom: 'enc:tok' }
          }
        })
      )
      const { settings } = stores(dir)
      const s = await settings.get()
      expect(s.connections.map((c) => [c.provider, c.type, c.hasCredential, c.credentialHint])).toEqual([
        ['anthropic', 'byok', true, 'nt-1'],
        ['openai', 'byok', true, 'oa-1'],
        ['openai-compatible', 'local', true, 'tok']
      ])
      expect(s.activeConnectionId).toBe(s.connections[0].id)
      expect(s.activeModel).toBe('claude-x')
      expect(s.agent).toEqual({ schemaBudgetTokens: 16000, autoRun: false, sendSampleValues: true })
      expect((await settings.resolve()).apiKey).toBe('sk-ant-1')
      // The secret left the settings file for the credential store, still encrypted.
      const raw = readFileSync(path.join(dir, 'settings.json'), 'utf8')
      expect(raw).not.toContain('sk-ant-1')
      expect(raw).not.toContain('enc:')
      expect(JSON.parse(raw).ai.version).toBe(2)
      expect(readFileSync(path.join(dir, 'credentials.json'), 'utf8')).toContain('enc:sk-ant-1')
      // Reading again is a no-op: same connections, same ids.
      const again = await stores(dir).settings.get()
      expect(again.connections.map((c) => c.id)).toEqual(s.connections.map((c) => c.id))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps one connection per provider, stores keys by reference and switches models', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ai-settings-'))
    try {
      const { settings } = stores(dir)
      let s = await settings.update({ connection: { type: 'byok', provider: 'openai', apiKey: 'sk-1', defaultModel: 'gpt-x' } })
      const openai = s.connections[0]
      expect([openai.provider, openai.hasCredential, s.activeModel, s.activeConnectionId === openai.id]).toEqual(['openai', true, 'gpt-x', true])
      s = await settings.update({ connection: { type: 'local', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', defaultModel: 'qwen3' } })
      expect(s.connections.map((c) => c.provider)).toEqual(['openai', 'ollama'])
      expect(s.activeConnectionId).toBe(s.connections[1].id)
      s = await settings.update({ activeConnectionId: openai.id, activeModel: 'gpt-y' })
      expect([s.activeConnectionId, s.activeModel, s.connections[0].defaultModel]).toEqual([openai.id, 'gpt-y', 'gpt-y'])
      // Editing the same provider again updates it instead of adding a second one; a null key removes the stored one.
      s = await settings.update({ connection: { type: 'byok', provider: 'openai', apiKey: null } })
      expect(s.connections.length).toBe(2)
      expect(s.connections[0].hasCredential).toBe(false)
      expect((await settings.resolve({ type: 'byok', provider: 'openai', apiKey: 'sk-2', defaultModel: 'm' })).apiKey).toBe('sk-2')
      const local = await settings.resolve({ type: 'local', provider: 'ollama' })
      expect([local.connection.baseUrl, local.connection.defaultModel, local.apiKey]).toEqual(['http://localhost:11434/v1', 'qwen3', null])
      await expect(settings.update({ connection: { type: 'managed', provider: 'managed' } })).rejects.toThrow(/not available yet/)
      expect(readFileSync(path.join(dir, 'settings.json'), 'utf8')).not.toContain('sk-')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses to store a key when the system cannot encrypt, and keeps settings usable', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ai-settings-'))
    try {
      const { settings } = stores(dir, noopCodec)
      await expect(settings.update({ connection: { type: 'byok', provider: 'openai', apiKey: 'sk-1' } })).rejects.toThrow(/securely/)
      const s = await settings.update({ agent: { autoRun: false } })
      expect(s.encryptionAvailable).toBe(false)
      expect(s.agent.autoRun).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
