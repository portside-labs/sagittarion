import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { SENSITIVE_ENTITY_TYPES, describeCounts } from '../../src/shared/privacy'
import { PiiVault } from '../../src/main/privacy/vault'
import { combine, decide, GENERAL_PII, GENERALIZERS, maskShown, policyById, PolicyError, validatePolicy, type PrivacyPolicy } from '../../src/main/privacy/policy'
import { resolve } from '../../src/main/privacy/resolver'
import { transform } from '../../src/main/privacy/transformer'
import { findDamaged, findMarkers, maskMarkers, parseMarker, pseudonym, safeSlice } from '../../src/main/privacy/markers'
import { engineForSettings } from '../../src/main/privacy/engine'
import { PrivacyBlockedError } from '../../src/main/privacy/errors'
import type { SensitiveDetection } from '../../src/main/privacy/types'
import { engine, placeholders, policy, protectText, sequentialVault, session } from './helpers'

function det(start: number, end: number, text: string, type: SensitiveDetection['type'], extra: Partial<SensitiveDetection> = {}): SensitiveDetection {
  return { start, end, value: text.slice(start, end), type, confidence: 0.9, source: 'deterministic', detector: 'test', ...extra }
}

describe('placeholders', () => {
  it('are well formed, parsed back, and masked out without moving offsets', () => {
    const text = 'a <|PII:PERSON:A81F32|> b <|REDACTED:PASSWORD|> c <|MASKED:CARD:1111|> d <|GENERALIZED:DOB:1984|>'
    const found = findMarkers(text)
    expect(found.map((m) => [m.kind, m.type, m.id ?? m.shown ?? null])).toEqual([
      ['pii', 'PERSON_NAME', 'A81F32'],
      ['redacted', 'PASSWORD', null],
      ['masked', 'CREDIT_CARD_NUMBER', '1111'],
      ['generalized', 'DATE_OF_BIRTH', '1984']
    ])
    expect(parseMarker('<|PII:PHONE:9C8721|>')).toMatchObject({ kind: 'pii', type: 'PHONE_NUMBER', id: '9C8721' })
    expect(parseMarker('x <|PII:PHONE:9C8721|>')).toBeNull()
    const masked = maskMarkers(text)
    expect(masked.length).toBe(text.length)
    expect(masked).not.toContain('PII')
    expect(safeSlice('ab <|PII:PERSON:A81F32|> cd', 10)).toBe('ab ')
  })

  it('tell damaged placeholders from prose that merely mentions the words', () => {
    const damaged = findDamaged('<|PII:PERSON:A81F32> and PII:PHONE:9C8721 and <|pii:email:27a922|> and <|REDACTED:PASSWORD> ok <|PII:PERSON:A81F32|>')
    expect(damaged.map((d) => d.text)).toEqual(['<|PII:PERSON:A81F32>', 'PII:PHONE:9C8721', '<|pii:email:27a922|>', '<|REDACTED:PASSWORD>'])
    expect(findDamaged('No PII: none. Masked: yes. REDACTED: the word')).toEqual([])
  })
})

describe('vault', () => {
  it('issues random placeholders that do not encode the value, and reuses them for the same value', () => {
    const vault = new PiiVault()
    const a = vault.pseudonymFor('Jack', 'PERSON_NAME')
    const b = vault.pseudonymFor('Jack', 'PERSON_NAME')
    const c = new PiiVault().pseudonymFor('Jack', 'PERSON_NAME')
    expect(a.token).toMatch(/^<\|PII:PERSON:[0-9A-F]{6}\|>$/)
    expect(b.token).toBe(a.token)
    expect(c.token).not.toBe(a.token) // another conversation, another placeholder
    expect(a.token).not.toContain('JACK')
    // A relative and a person with the same name are one entity.
    expect(vault.pseudonymFor('Jack', 'RELATIVE_NAME').token).toBe(a.token)
    // Exact values: case matters, because restoration must reproduce the text.
    expect(vault.pseudonymFor('JACK', 'PERSON_NAME').token).not.toBe(a.token)
    expect(vault.resolve(a.token!)?.value).toBe('Jack')
  })

  it('never issues a colliding or reserved id', () => {
    const ids = ['AAAAAA', 'AAAAAA', '0000AB', 'BBBBBB']
    const vault = new PiiVault(() => ids.shift()!)
    expect(vault.pseudonymFor('one', 'PERSON_NAME').token).toBe(pseudonym('PERSON_NAME', 'AAAAAA'))
    expect(vault.pseudonymFor('two', 'PERSON_NAME').token).toBe(pseudonym('PERSON_NAME', 'BBBBBB'))
  })

  it('keeps its values out of JSON, util.inspect, structuredClone and string coercion', () => {
    const vault = new PiiVault()
    vault.pseudonymFor('Jack Smith', 'PERSON_NAME')
    vault.withhold('hunter2', 'PASSWORD', 'redact')
    for (const out of [JSON.stringify(vault), inspect(vault, { showHidden: true, depth: 10 }), String(vault), JSON.stringify(structuredClone(vault)), JSON.stringify({ ...vault })]) {
      expect(out).not.toContain('Jack')
      expect(out).not.toContain('hunter2')
    }
    expect(JSON.parse(JSON.stringify(vault))).toEqual({ id: vault.id, size: 2 })
  })

  it('adopts placeholders from sealed history, as aliases when the value already has one, and refuses conflicts', () => {
    const vault = new PiiVault()
    expect(vault.adopt('<|PII:PERSON:111111|>', 'Jack', 'PERSON_NAME')).toBe('added')
    expect(vault.adopt('<|PII:PERSON:111111|>', 'Jack', 'PERSON_NAME')).toBe('same')
    expect(vault.adopt('<|PII:PERSON:111111|>', 'Sarah', 'PERSON_NAME')).toBe('conflict')
    expect(vault.adopt('<|PII:PERSON:222222|>', 'Jack', 'PERSON_NAME')).toBe('added')
    expect(vault.resolve('<|PII:PERSON:222222|>')?.value).toBe('Jack')
    expect(vault.pseudonymFor('Jack', 'PERSON_NAME').token).toBe('<|PII:PERSON:111111|>')
  })
})

describe('policy', () => {
  it('general-pii v1 covers every type and validates', () => {
    expect(validatePolicy(GENERAL_PII)).toEqual([])
    expect(policyById('general-pii')).toBe(GENERAL_PII)
    for (const t of SENSITIVE_ENTITY_TYPES) expect(GENERAL_PII.entities[t]).toBeDefined()
    expect(decide(policy, 'PERSON_NAME')).toEqual({ action: 'pseudonymize', rehydrate: true })
    expect(decide(policy, 'CREDIT_CARD_NUMBER')).toEqual({ action: 'mask', rehydrate: false })
    for (const t of ['CVV', 'PASSWORD', 'API_KEY', 'ACCESS_TOKEN', 'PRIVATE_KEY'] as const) expect(decide(policy, t)).toEqual({ action: 'redact', rehydrate: false })
    expect(decide(policy, 'CITY').action).toBe('preserve')
  })

  it('rejects policies that cannot be evaluated', () => {
    const broken = { ...GENERAL_PII, version: 0, entities: { ...GENERAL_PII.entities, PASSWORD: { action: 'redact', rehydrate: true }, AGE: { action: 'generalize', minConfidence: 2 }, EMAIL_ADDRESS: { action: 'generalize' } } } as PrivacyPolicy
    const withoutType = { ...GENERAL_PII, entities: { ...GENERAL_PII.entities } } as PrivacyPolicy
    delete (withoutType.entities as Record<string, unknown>).SSN
    expect(validatePolicy(broken)).toEqual([
      'The policy version must be a positive integer.',
      'AGE: the confidence threshold must be between 0 and 1.',
      'EMAIL_ADDRESS cannot be generalized.',
      'PASSWORD: only pseudonyms can be restored.'
    ].sort((a, b) => validatePolicy(broken).indexOf(a) - validatePolicy(broken).indexOf(b)))
    expect(validatePolicy(withoutType)).toEqual(['No rule for SSN.'])
    expect(() => policyById('hipaa-2031')).toThrow(PolicyError)
  })

  it('combines decisions without losing a protection', () => {
    const p = { action: 'pseudonymize', rehydrate: true } as const
    expect(combine(p, { action: 'redact', rehydrate: false })).toEqual({ action: 'redact', rehydrate: false })
    expect(combine(p, { action: 'mask', rehydrate: false })).toEqual({ action: 'pseudonymize', rehydrate: false })
    expect(combine({ action: 'mask', rehydrate: false }, { action: 'generalize', rehydrate: false })).toEqual({ action: 'redact', rehydrate: false })
    expect(combine({ action: 'preserve', rehydrate: false }, p)).toEqual(p)
    expect(maskShown('4111 1111 1111 1111')).toBe('1111')
    expect(maskShown('1234')).toBeUndefined()
    expect(GENERALIZERS.DATE_OF_BIRTH!('1984-03-02')).toBe('1984')
    expect(GENERALIZERS.AGE!('93')).toBe('90+')
    expect(GENERALIZERS.AGE!('42')).toBe('40-49')
    expect(GENERALIZERS.POSTAL_CODE!('33146')).toBe('331XX')
  })
})

describe('span resolution', () => {
  const text = 'Pay 4111 1111 1111 1111 to Jack Smith'
  it('merges overlapping detections into one span, typed by the most reliable source', () => {
    const spans = resolve(
      [
        det(4, 23, text, 'PHONE_NUMBER', { source: 'gliner', confidence: 0.99 }),
        det(4, 23, text, 'CREDIT_CARD_NUMBER', { validated: true }),
        det(27, 31, text, 'PERSON_NAME', { confidence: 0.7 }),
        det(27, 37, text, 'PERSON_NAME', { source: 'gliner', confidence: 0.95 }),
        det(32, 37, text, 'PERSON_NAME', { confidence: 0.6 })
      ],
      policy
    )
    expect(spans.map((s) => [text.slice(s.start, s.end), s.type, s.decision.action])).toEqual([
      ['4111 1111 1111 1111', 'CREDIT_CARD_NUMBER', 'mask'],
      ['Jack Smith', 'PERSON_NAME', 'pseudonymize']
    ])
  })

  it('never lets a model remove a deterministic protection, but lets the schema place a value', () => {
    const t = 'password hunter2 in Jackson'
    // A semantic "not sensitive" cannot exist: it can only add. Here it calls a password a city.
    const spans = resolve([det(9, 16, t, 'PASSWORD'), det(9, 16, t, 'CITY', { source: 'gliner', confidence: 0.99 })], policy)
    expect(spans.map((s) => [s.type, s.decision.action])).toEqual([['PASSWORD', 'redact']])
    // A city column says "Jackson" is a city; the name list thought it was a person. The column wins.
    const city = resolve([det(20, 27, t, 'CITY', { source: 'schema', confidence: 0.85 }), det(20, 27, t, 'PERSON_NAME', { confidence: 0.75 })], policy)
    expect(city.map((s) => [s.type, s.decision.action])).toEqual([['CITY', 'preserve']])
    // Below the threshold is ignored; conservative union keeps the rest.
    expect(resolve([det(0, 8, t, 'PERSON_NAME', { confidence: 0.2 })], policy)).toEqual([])
  })

  it('transforms spans into placeholders, masks and redactions, and refuses bad offsets', () => {
    const vault = sequentialVault()
    const t = 'Jack paid with 4111 1111 1111 1111, pwd hunter2'
    const spans = resolve([det(0, 4, t, 'PERSON_NAME'), det(15, 34, t, 'CREDIT_CARD_NUMBER', { validated: true }), det(40, 47, t, 'PASSWORD')], policy)
    const out = transform(t, spans, vault, policy)
    expect(out.text).toBe('<|PII:PERSON:A00001|> paid with <|MASKED:CARD:1111|>, pwd <|REDACTED:PASSWORD|>')
    expect(out.replacements.map((r) => [r.start, r.end, r.marker])).toEqual([
      [0, 4, '<|PII:PERSON:A00001|>'],
      [15, 34, '<|MASKED:CARD:1111|>'],
      [40, 47, '<|REDACTED:PASSWORD|>']
    ])
    const bad = [{ ...spans[0], start: 3, end: 99 }]
    expect(() => transform(t, bad, vault, policy)).toThrow(PrivacyBlockedError)
  })
})

describe('engine', () => {
  it('keeps pseudonyms consistent within a conversation', async () => {
    const vault = new PiiVault()
    const { text } = await protectText('Jack called Sarah. Jack later emailed Sarah.', vault)
    const [a, b, c, d] = placeholders(text)
    expect(text).toBe(`${a} called ${b}. ${c} later emailed ${d}.`)
    expect([a === c, b === d, a !== b]).toEqual([true, true, true])
    // A later message in the same conversation uses the same placeholders.
    const later = await protectText("What was Jack's phone number?", vault)
    expect(later.text).toBe(`What was ${a}'s phone number?`)
    // Another conversation does not.
    const other = await protectText('Jack called Sarah.', new PiiVault())
    expect(placeholders(other.text)).not.toContain(a)
  })

  it('treats a column as names when most of its sampled values are names', async () => {
    const privacy = session()
    const names = ['Guido Thompson', 'Edsger Dijkstra', 'Tim Allen', 'Ada Lovelace']
    const out = await privacy.protectValues({ table: 'order_summary', column: 'name', declaredType: 'TEXT' }, names)
    expect(out.every((v) => /^<\|PII:PERSON:[0-9A-F]{6}\|>$/.test(v))).toBe(true)
    // Product names stay: the evidence has to be there.
    const products = await privacy.protectValues({ table: 'products', column: 'name' }, ['Widget Pro', 'Gadget Mini', 'Sprocket', 'Flux Capacitor'])
    expect(products).toEqual(['Widget Pro', 'Gadget Mini', 'Sprocket', 'Flux Capacitor'])
  })

  it('does not merge two people who only share a first name', async () => {
    const { text } = await protectText('Jack Smith met Jack Brown, then Jack left.')
    const [smith, brown, jack] = placeholders(text)
    expect(new Set([smith, brown, jack]).size).toBe(3)
  })

  it('protects a value everywhere once any text shows it is sensitive, whatever the order', async () => {
    const e = engine()
    const vault = new PiiVault()
    // "Zed" is not on any name list; only the column says it is a name. The schema line comes first here.
    const out = await e.protectAll(
      [
        { text: 'users(first_name text {Zed})', ctx: { role: 'structured' } },
        { text: 'orders for Zed please', ctx: { role: 'prose' } },
        { text: 'Zed', ctx: { role: 'value', column: { table: 'users', column: 'first_name' }, classification: e.classify({ table: 'users', column: 'first_name' }) } }
      ],
      vault,
      policy
    )
    const [token] = placeholders(out[2].text)
    expect(out.map((o) => o.text)).toEqual([`users(first_name text {${token}})`, `orders for ${token} please`, token])
  })

  it('is idempotent on text that already holds placeholders, and never detects inside them', async () => {
    const vault = new PiiVault()
    const once = await protectText('Email jack@example.com, call 555-867-5309', vault)
    const twice = await protectText(once.text, vault)
    expect(twice.text).toBe(once.text)
    // A model-invented placeholder is left alone; it holds nothing.
    const foreign = await protectText('see <|PII:EMAIL:ABCDEF|> now', vault)
    expect(foreign.text).toBe('see <|PII:EMAIL:ABCDEF|> now')
  })

  it('leaves ordinary database questions untouched', async () => {
    for (const q of [
      'top 10 customers by revenue last quarter',
      'orders from May with totals between 100-2000',
      'how many users signed up per week this year',
      'average time from signup to first purchase per plan',
      'customers in Charlotte and Austin who ordered in June',
      'which products in category 42 sold more than 1,000 units?',
      'show the table named Jordan and the column called status'
    ]) {
      expect((await protectText(q)).text).toBe(q)
    }
  })

  it('fails closed when semantic detection is on without a model', () => {
    expect(() => engineForSettings({ schemaDetection: true, semanticDetection: true })).toThrow(/on-device privacy model is switched on but could not run/)
    expect(engineForSettings({ schemaDetection: false, semanticDetection: false }).describe().detectors).toEqual(['patterns@1', 'names@1', 'known-values@1'])
  })
})

describe('restoration', () => {
  async function setup() {
    const privacy = session(sequentialVault())
    const q = await privacy.seal("Jack's phone is 867-5309, email jack@example.com, card 4111 1111 1111 1111, password hunter2, patient O'Brien")
    return { privacy, q, tokens: placeholders(q.text) }
  }

  it('restores exact placeholders in prose, repeated, adjacent and in punctuation, Markdown, code and tables', async () => {
    const { privacy, q, tokens } = await setup()
    const [jack, phone, email, obrien] = tokens
    expect(q.text).toBe(`${jack}'s phone is ${phone}, email ${email}, card <|MASKED:CARD:1111|>, password <|REDACTED:PASSWORD|>, patient ${obrien}`)
    const answer = [
      `You can contact ${jack} at ${phone}. ${jack} (${email}) — ${jack}${phone}!`,
      `**${jack}** \`${email}\``,
      '```json',
      `{"name": "${obrien}", "phone": "${phone}"}`,
      '```',
      `| name | phone |\n| ${jack} | ${phone} |`
    ].join('\n')
    const r = privacy.restoreText(answer)
    expect(r.text).toBe(
      [
        'You can contact Jack at 867-5309. Jack (jack@example.com) — Jack867-5309!',
        '**Jack** `jack@example.com`',
        '```json',
        `{"name": "O'Brien", "phone": "867-5309"}`,
        '```',
        '| name | phone |\n| Jack | 867-5309 |'
      ].join('\n')
    )
    expect([r.restored, r.withheld, r.unknown, r.damaged]).toEqual([12, 0, [], []])
  })

  it('shows withheld values in words and leaves unknown and damaged placeholders as they are', async () => {
    const { privacy, tokens } = await setup()
    const [jack] = tokens
    const id = jack.slice(13, 19)
    const r = privacy.restoreText(`Card <|MASKED:CARD:1111|>, password <|REDACTED:PASSWORD|>; ${jack}; <|PII:PERSON:FFFFFF|>; <|PII:PERSON:${id}>; PII:PHONE:${id}`)
    expect(r.text).toBe(`Card [card number ending 1111], password [redacted password]; Jack; <|PII:PERSON:FFFFFF|>; <|PII:PERSON:${id}>; PII:PHONE:${id}`)
    expect(r.restored).toBe(1)
    expect(r.withheld).toBe(2)
    expect(r.unknown).toEqual(['<|PII:PERSON:FFFFFF|>'])
    expect(r.damaged).toHaveLength(2)
    // An unknown id is never issued later, so it can never start meaning something.
    const again = privacy.vault.pseudonymFor('someone new', 'PERSON_NAME')
    expect(again.token).not.toBe('<|PII:PERSON:FFFFFF|>')
  })

  it('restores into SQL so a value can never change the statement', async () => {
    const { privacy, tokens } = await setup()
    const [jack, phone, email, obrien] = tokens
    const pg = (sql: string) => privacy.restoreSql(sql, 'postgres')
    const lite = (sql: string) => privacy.restoreSql(sql, 'sqlite')
    expect(pg(`SELECT * FROM p WHERE last_name = '${obrien}' AND name ILIKE '%${jack}%'`).text).toBe("SELECT * FROM p WHERE last_name = 'O''Brien' AND name ILIKE '%Jack%'")
    expect(pg(`SELECT * FROM p WHERE email = ${email} OR id IN (${phone})`).text).toBe("SELECT * FROM p WHERE email = 'jack@example.com' OR id IN ('867-5309')")
    expect(pg(`SELECT E'${obrien}\\n', "${obrien}", $q$${obrien}$q$ -- ${jack}`).text).toBe(`SELECT E'O''Brien\\n', "O'Brien", $q$O'Brien$q$ -- Jack`)
    expect(lite(`SELECT [${jack}], \`${jack}\` FROM t /* ${jack} */`).text).toBe('SELECT [Jack], `Jack` FROM t /* Jack */')
    // Glued to other tokens, a bare placeholder is ambiguous and stays.
    const glued = pg(`SELECT E${jack}`)
    expect([glued.text, glued.withheld]).toEqual([`SELECT E${jack}`, 1])
    // Masked and redacted values stay placeholders in SQL; the caller warns instead of running it.
    const masked = pg("SELECT * FROM cards WHERE pan = '<|MASKED:CARD:1111|>'")
    expect([masked.text, masked.withheld]).toEqual(["SELECT * FROM cards WHERE pan = '<|MASKED:CARD:1111|>'", 1])
  })

  it('escapes hostile values so they stay literals', async () => {
    const privacy = session()
    // Whole values from a name column and an email column become one placeholder each, whatever they contain.
    const [name] = await privacy.protectValues({ table: 'customers', column: 'full_name' }, ["Robert'); DROP TABLE students;--"])
    const [email] = await privacy.protectValues({ table: 'customers', column: 'email' }, ["x'--@evil.io\n/* */ $q$ \\"])
    const [first, second] = [...placeholders(name), ...placeholders(email)]
    expect([name, email]).toEqual([first, second])
    const sql = privacy.restoreSql(`SELECT * FROM c WHERE name = '${first}' OR note = ${second} OR x = E'${second}'`, 'postgres').text
    expect(sql).toBe("SELECT * FROM c WHERE name = 'Robert''); DROP TABLE students;--' OR note = 'x''--@evil.io\n/* */ $q$ \\' OR x = E'x''--@evil.io\n/* */ $q$ \\\\'")
    // Where a value could end the region early, it stays a placeholder.
    const unsafe = [`SELECT 1 -- ${second}`, `SELECT 1 /* ${second} */`, `SELECT $q$${second}$q$`, `SELECT [${first}]`]
    expect(unsafe.map((q, i) => privacy.restoreSql(q, i === 3 ? 'sqlite' : 'postgres')).map((r) => [r.restored, r.withheld])).toEqual([
      [0, 1],
      [0, 1],
      [0, 1],
      [1, 0]
    ])
    expect(privacy.restoreSql(`SELECT 1 -- ${first}`, 'postgres').text).toBe("SELECT 1 -- Robert'); DROP TABLE students;--")
  })
})

describe('verification and failing closed', () => {
  it('passes protected text and flags whatever is left raw, without naming values', async () => {
    const e = engine()
    const vault = new PiiVault()
    const [p] = await e.protectAll([{ text: 'Jack at jack@example.com', ctx: { role: 'prose' } }], vault, policy)
    const ok = await e.verify([{ text: p.text, ctx: { role: 'prose' }, where: 'the question', origin: 'local' }], vault, policy)
    expect(ok).toEqual({ passed: true, findings: [], checked: 1 })
    const leaked = await e.verify(
      [
        { text: `${p.text}; SSN 123-45-6789`, ctx: { role: 'prose' }, where: 'the question', origin: 'local' },
        { text: 'error: value "Jack" is invalid', ctx: { role: 'structured' }, where: 'a database error', origin: 'local' },
        { text: 'broken <|PII:PERSON:A81F32> here', ctx: { role: 'prose' }, where: 'the schema', origin: 'local' },
        { text: 'model said <|PII:PERSON:A81F32> here', ctx: { role: 'prose' }, where: 'an earlier answer', origin: 'model' }
      ],
      vault,
      policy
    )
    expect(leaked.passed).toBe(false)
    expect(leaked.findings).toEqual([
      { where: 'the question', type: 'SSN', problem: 'unprotected-value', count: 1 },
      { where: 'a database error', type: 'PERSON_NAME', problem: 'known-value', count: 1 },
      { where: 'the schema', problem: 'damaged-placeholder', count: 1 }
    ])
    const err = new PrivacyBlockedError('verification-failed', leaked.findings)
    expect(err.message).toBe(
      'Local AI Privacy stopped this request before anything was sent: 1 social security number in the question; 1 person name in a database error; a damaged placeholder in the schema could not be protected.'
    )
    expect(err.message).not.toMatch(/Jack|123-45-6789/)
    expect(describeCounts({ PERSON_NAME: 2, PHONE_NUMBER: 1, EMAIL_ADDRESS: 1, SSN: 1, IBAN: 1 })).toBe('2 person names, 1 email address, 1 IBAN, 1 phone number, 1 other')
  })
})
