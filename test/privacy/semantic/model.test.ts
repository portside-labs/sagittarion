// The on-device model inside the privacy engine, with a stand-in for the model: what it is shown, what its labels
// become, that it can add protection but never take it away, and that any failure stops the ask.
import { describe, expect, it } from 'vitest'
import { PrivacyEngine, engineForSettings } from '../../../src/main/privacy/engine'
import { PrivacyBlockedError } from '../../../src/main/privacy/errors'
import { GlinerDetector } from '../../../src/main/privacy/semantic/detector'
import { GLINER_PII_BASE as manifest } from '../../../src/main/privacy/semantic/manifest'
import { unsupportedReason } from '../../../src/main/privacy/semantic/platform'
import type { RawSpan } from '../../../src/main/privacy/semantic/runtime'
import type { ColumnClassification, SemanticSensitiveDataDetector, SensitiveDetection } from '../../../src/main/privacy/types'
import { PiiVault } from '../../../src/main/privacy/vault'
import { policy } from '../helpers'

const label = (name: string) => manifest.labels.findIndex((l) => l.label === name)

/** A model that knows a few phrases, and records every text it is shown. */
function fakeModel(known: Record<string, string>) {
  const seen: string[][] = []
  const recognize = async (texts: string[]): Promise<RawSpan[][]> => {
    seen.push(texts)
    return texts.map((t) => {
      const out: RawSpan[] = []
      for (const [phrase, l] of Object.entries(known)) for (let i = t.indexOf(phrase); i >= 0; i = t.indexOf(phrase, i + 1)) out.push({ start: i, end: i + phrase.length, label: label(l), score: 0.9 })
      return out.sort((a, b) => a.start - b.start)
    })
  }
  return { seen, detector: new GlinerDetector(recognize, manifest) }
}

describe('the model as a detector', () => {
  it('turns labels into entity types and drops what cannot be a value', async () => {
    const { detector } = fakeModel({ 'Xiomara Quispe': 'name', 'May 3': 'date', password: 'password', Tr0ub4dor: 'password', Lima: 'location city', '!!': 'name', customer_name: 'name' })
    const [found] = await detector.detect(['Xiomara Quispe from Lima, password Tr0ub4dor, on May 3 !! (customer_name)'])
    expect(found.map((d) => [d.value, d.type, d.source, d.detector])).toEqual([
      ['Xiomara Quispe', 'PERSON_NAME', 'gliner', 'gliner.name'],
      ['Lima', 'CITY', 'gliner', 'gliner.location-city'],
      ['Tr0ub4dor', 'PASSWORD', 'gliner', 'gliner.password']
    ])
    expect(detector.model).toEqual({ id: 'gliner-pii-base', version: '1.0', sha256: manifest.files.find((f) => f.path === manifest.graph)!.sha256 })
  })

  it('reads each distinct text once, and never sends text without a letter or digit', async () => {
    const { detector, seen } = fakeModel({ Ana: 'name' })
    await detector.detect(['Ana', 'Ana', '---', 'hi'])
    await detector.detect(['Ana', 'hi', 'Bob'])
    expect(seen).toEqual([['Ana', 'hi'], ['Bob']])
    const [first] = await detector.detect(['Ana'])
    first[0].value = 'changed'
    expect((await detector.detect(['Ana']))[0][0].value).toBe('Ana')
    detector.forget()
    await detector.detect(['Ana'])
    expect(seen.at(-1)).toEqual(['Ana'])
  })

  it('refuses an answer for the wrong number of texts', async () => {
    const detector = new GlinerDetector(async () => [], manifest)
    await expect(detector.detect(['one'])).rejects.toThrow(/different number/)
  })
})

describe('the engine with the model', () => {
  const engineWith = (semantic: SemanticSensitiveDataDetector) => new PrivacyEngine({ schemaDetection: true, semantic })

  it('protects what only the model finds, and restores it on this computer', async () => {
    const { detector } = fakeModel({ 'Xiomara Quispe': 'name' })
    const engine = engineWith(detector)
    const vault = new PiiVault()
    const q = 'orders for Xiomara Quispe last week'
    const p = await engine.protect(q, { role: 'prose' }, vault, policy)
    expect(p.text).toMatch(/^orders for <\|PII:PERSON:[0-9A-F]{6}\|> last week$/)
    expect(engine.restoreText(p.text, vault, policy).text).toBe(q)
    expect(engine.describe().detectors).toContain('gliner@1.0')
    expect(engine.describe().semanticModel?.id).toBe('gliner-pii-base')
  })

  it('reads texts as they are, ignores what it finds in a placeholder, and asks once per pass', async () => {
    const { detector, seen } = fakeModel({ 'Xiomara Quispe': 'name', PERSON: 'name', 'Dr. <|PII': 'name' })
    const engine = engineWith(detector)
    const vault = new PiiVault()
    const [first] = await engine.protectAll([{ text: 'Xiomara Quispe called', ctx: { role: 'prose' } }], vault, policy)
    const marker = first.replacements[0].marker
    // Round 1 found the name; round 2 read the text with its placeholder and found only things inside it.
    expect(seen).toEqual([['Xiomara Quispe called'], [`${marker} called`]])
    expect(first.text).toBe(`${marker} called`)
    const out = await engine.protectAll(
      [
        { text: `Dr. ${first.text}`, ctx: { role: 'prose' } },
        { text: 'and Xiomara Quispe again', ctx: { role: 'prose' } },
        { text: 'a third text', ctx: { role: 'prose' } }
      ],
      vault,
      policy
    )
    // "Dr. <|PII…" reaches into the placeholder: dropped, not cut back to "Dr.".
    expect(out[0].text).toBe(`Dr. ${marker} called`)
    expect(out[1].text).toBe(`and ${marker} again`)
    // Three texts, one call per pass, each text read once.
    expect(seen.slice(2).every((texts) => texts.length <= 3)).toBe(true)
    expect(new Set(seen.flat()).size).toBe(seen.flat().length)
  })

  it('reads prose and free text, not values their column already identifies, nor codes', async () => {
    const { detector, seen } = fakeModel({})
    const engine = engineWith(detector)
    const cls = (content: ColumnClassification['content'], type: ColumnClassification['type'] = null): ColumnClassification => ({ type, content, confidence: 0.9, rule: 't' })
    await engine.protectAll(
      [
        { text: 'a note about Ana', ctx: { role: 'value', column: { column: 'notes' }, classification: cls('free-text') } },
        { text: 'ana@example.com', ctx: { role: 'value', column: { column: 'email' }, classification: cls('identifier', 'EMAIL_ADDRESS') } },
        { text: 'PAID', ctx: { role: 'value', column: { column: 'status' }, classification: cls('categorical') } },
        { text: 'users(id, name)', ctx: { role: 'structured' } },
        { text: 'who is Ana?', ctx: { role: 'prose' } }
      ],
      new PiiVault(),
      policy
    )
    expect(seen[0]).toEqual(['a note about Ana', 'who is Ana?'])
  })

  it('adds protection but never takes it away', async () => {
    // The model calls an email address a city, which the policy keeps: the pattern's protection still stands.
    const { detector } = fakeModel({ 'jack@example.com': 'location city', Paris: 'location city' })
    const p = await engineWith(detector).protect('mail jack@example.com about Paris', { role: 'prose' }, new PiiVault(), policy)
    expect(p.text).toMatch(/^mail <\|PII:EMAIL:[0-9A-F]{6}\|> about Paris$/)
  })

  it('stops the ask when the model fails, and lets a cancelled ask be a cancellation', async () => {
    const failing: SemanticSensitiveDataDetector = { id: 'gliner', model: { id: 'm', version: '1', sha256: 'x' }, detect: async () => Promise.reject(new Error('The on-device model stopped unexpectedly.')) }
    const err = await engineWith(failing)
      .protect('Ana called', { role: 'prose' }, new PiiVault(), policy)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PrivacyBlockedError)
    expect((err as PrivacyBlockedError).reason).toBe('semantic-unavailable')
    expect((err as Error).message).toBe(
      'Local AI Privacy stopped this request before anything was sent: the on-device privacy model is switched on but could not run (The on-device model stopped unexpectedly). Download it again or switch it off in Settings.'
    )

    const controller = new AbortController()
    const slow: SemanticSensitiveDataDetector = {
      ...failing,
      detect: (_texts, signal) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)))
    }
    const pending = engineWith(slow).protect('Ana called', { role: 'prose' }, new PiiVault(), policy, controller.signal)
    controller.abort(new Error('cancelled'))
    await expect(pending).rejects.toThrow('cancelled')
  })

  it('refuses offsets that do not fit the text', async () => {
    const bad: SemanticSensitiveDataDetector = {
      id: 'gliner',
      model: { id: 'm', version: '1', sha256: 'x' },
      detect: async (texts) => texts.map((t): SensitiveDetection[] => [{ start: 0, end: t.length + 5, value: t, type: 'PERSON_NAME', confidence: 0.9, source: 'gliner', detector: 'gliner.name' }])
    }
    await expect(engineWith(bad).protect('Ana', { role: 'prose' }, new PiiVault(), policy)).rejects.toMatchObject({ reason: 'invalid-offsets' })
  })

  it('never protects a table or column name, whoever finds it, so the SQL can still use it', async () => {
    // The model reads a lone table name as an organization, as GLiNER does with "inspection_inspector" (0.53).
    const { detector } = fakeModel({ inspection_inspector: 'organization', 'Acme Corp': 'organization' })
    const engine = engineWith(detector)
    engine.useIdentifiers(['inspections', 'inspection_inspector', 'public.inspection_inspector', 'user_id'])
    const vault = new PiiVault()
    const p = await engine.protect('join inspection_inspector for Acme Corp', { role: 'prose' }, vault, policy)
    expect(p.text).toMatch(/^join inspection_inspector for <\|PII:ORG:[0-9A-F]{6}\|>$/)
    // A name already in the vault from before (an older chat) is not spread into the schema either.
    vault.pseudonymFor('inspection_inspector', 'ORGANIZATION')
    const schema = await engine.protect('inspection_inspector(inspection_id int, user_id int)', { role: 'structured' }, vault, policy)
    expect(schema.text).toBe('inspection_inspector(inspection_id int, user_id int)')
  })

  it("does not read the provider's own replies and tool calls", async () => {
    const { detector, seen } = fakeModel({})
    await engineWith(detector).protectAll(
      [
        { text: 'which inspections failed?', ctx: { role: 'prose' } },
        { text: 'I will look at the inspections table.', ctx: { role: 'prose', origin: 'model' } },
        { text: 'inspections', ctx: { role: 'prose', origin: 'model' } }
      ],
      new PiiVault(),
      policy
    )
    expect(seen.flat()).toEqual(['which inspections failed?'])
  })

  it("ignores the model's password label on a lone database value, not in a sentence", async () => {
    const { detector } = fakeModel({ x7Hj2kQ: 'password' })
    const engine = engineWith(detector)
    const value = await engine.protect('x7Hj2kQ', { role: 'value', column: { column: 'invite_code' }, classification: { type: null, content: 'unknown', confidence: 0.5, rule: 't' } }, new PiiVault(), policy)
    expect(value.text).toBe('x7Hj2kQ')
    const prose = await engine.protect('my pasword is x7Hj2kQ', { role: 'prose' }, new PiiVault(), policy)
    expect(prose.text).toBe('my pasword is <|REDACTED:PASSWORD|>')
  })

  it('fails closed when switched on without a model', () => {
    expect(() => engineForSettings({ schemaDetection: true, semanticDetection: true }, null)).toThrow(/switched on but could not run \(it is not installed\)/)
    expect(() => engineForSettings({ schemaDetection: true, semanticDetection: true }, null, 'The on-device model needs 64-bit Windows.')).toThrow(/needs 64-bit Windows\)/)
  })
})

describe('where the model can run', () => {
  it('matches the platforms onnxruntime-node ships binaries for', () => {
    expect(unsupportedReason({ platform: 'darwin', arch: 'arm64', release: '23.0.0' })).toBeNull()
    expect(unsupportedReason({ platform: 'darwin', arch: 'arm64', release: '25.5.0' })).toBeNull()
    expect(unsupportedReason({ platform: 'darwin', arch: 'arm64', release: '22.6.0' })).toMatch(/macOS 14/)
    expect(unsupportedReason({ platform: 'darwin', arch: 'x64', release: '23.0.0' })).toMatch(/Apple silicon/)
    expect(unsupportedReason({ platform: 'win32', arch: 'x64', release: '10.0.22631' })).toBeNull()
    expect(unsupportedReason({ platform: 'win32', arch: 'arm64', release: '10.0.22631' })).toBeNull()
    expect(unsupportedReason({ platform: 'win32', arch: 'ia32', release: '10.0.19045' })).toMatch(/64-bit Windows/)
    expect(unsupportedReason({ platform: 'linux', arch: 'x64', release: '6.8.0', glibc: '2.28' })).toBeNull()
    expect(unsupportedReason({ platform: 'linux', arch: 'arm64', release: '6.8.0', glibc: '2.39' })).toBeNull()
    expect(unsupportedReason({ platform: 'linux', arch: 'x64', release: '4.15.0', glibc: '2.27' })).toMatch(/glibc 2.28/)
    expect(unsupportedReason({ platform: 'linux', arch: 'x64', release: '6.8.0' })).toMatch(/glibc/)
    expect(unsupportedReason({ platform: 'freebsd', arch: 'x64', release: '14.0' })).toMatch(/not available/)
  })
})
