// The first milestone, exactly as specified: a database value goes out as placeholders, a mock remote provider sees
// only those, and its answer comes back with the real values restored on this side.
import { describe, expect, it } from 'vitest'
import { ModelGateway } from '../../src/main/privacy/gateway'
import { PiiVault } from '../../src/main/privacy/vault'
import { placeholders, recordingProvider, reply, session, wireText } from './helpers'

describe('first milestone', () => {
  it('protects a database value, sends only placeholders, and restores the answer locally', async () => {
    // The value comes out of a database: a free-text notes column.
    const vault = new PiiVault()
    const privacy = session(vault)
    const [stored] = await privacy.protectValues({ table: 'contacts', column: 'notes', declaredType: 'TEXT' }, ['Jack has a phone number that is 867-5309.'])

    expect(stored).toMatch(/^<\|PII:PERSON:[0-9A-F]{6}\|> has a phone number that is <\|PII:PHONE:[0-9A-F]{6}\|>\.$/)
    const [person, phone] = placeholders(stored)

    const provider = recordingProvider(() => reply({ text: `Yes, ${person}'s phone number is ${phone}.` }))
    const gateway = ModelGateway.protected(provider, privacy)
    const res = await gateway.complete({ system: [{ text: 'Answer questions about the note.' }], messages: [{ role: 'user', content: stored }] })

    // The provider received the placeholders and nothing else of the value.
    const sent = wireText(provider.requests)
    expect(provider.requests).toHaveLength(1)
    expect(sent).not.toContain('Jack')
    expect(sent).not.toContain('867-5309')
    expect(sent).toContain('<|PII:')
    expect(sent).toContain(`${person} has a phone number that is ${phone}.`)
    // The mapping never crossed: no vault, no id, no "placeholder = value" line.
    expect(sent).not.toContain(vault.id)
    expect(sent).not.toMatch(/PERSON[^|]*=\s*Jack/)

    // Back on this side, the answer reads normally.
    expect(res.text).toBe(`Yes, ${person}'s phone number is ${phone}.`)
    expect(gateway.restoreText(res.text).text).toBe("Yes, Jack's phone number is 867-5309.")
  })
})
