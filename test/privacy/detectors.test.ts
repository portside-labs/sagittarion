import { describe, expect, it } from 'vitest'
import { PatternDetector } from '../../src/main/privacy/detectors/patterns'
import { NameDetector } from '../../src/main/privacy/detectors/names'
import { classifyColumn, LabeledValueDetector, splitWords } from '../../src/main/privacy/detectors/schema'
import { KnownValueDetector } from '../../src/main/privacy/detectors/known-values'
import { cardGroupingOk, isAbaRouting, isCardNumber, isIban, isJwt, isNpi, isPlausibleIpv6, isSsn, isVinWithCheckDigit, luhn } from '../../src/main/privacy/detectors/validators'
import { PiiVault } from '../../src/main/privacy/vault'
import { resolve } from '../../src/main/privacy/resolver'
import { GENERAL_PII } from '../../src/main/privacy/policy'
import type { SensitiveDetection, TextRole } from '../../src/main/privacy/types'

const patterns = new PatternDetector()
const names = new NameDetector()
const labels = new LabeledValueDetector()

function found(detections: SensitiveDetection[]): [string, string][] {
  return detections.map((d) => [d.type, d.value])
}
/** What the recognizers find once overlapping candidates are merged, as the engine sees it. */
const scan = (text: string, role: TextRole = 'prose') => resolve(patterns.detect(text, { role }), GENERAL_PII).map((s) => [s.type, text.slice(s.start, s.end)])
const people = (text: string) => found(names.detect(text, { role: 'prose' }))
const labelled = (text: string) => found(labels.detect(text, { role: 'prose' }))

describe('validators', () => {
  it('check the checksums the recognizers rely on', () => {
    expect(luhn('4111111111111111')).toBe(true)
    expect(luhn('4111111111111112')).toBe(false)
    expect(isCardNumber('4111 1111 1111 1111')).toBe(true)
    expect(isCardNumber('378282246310005')).toBe(true) // Amex
    expect(isCardNumber('1234567812345670')).toBe(false) // Luhn-valid, no issuer
    expect(isCardNumber('4444444444444448')).toBe(true)
    expect(isCardNumber('0000000000000000')).toBe(false)
    expect(cardGroupingOk('4111 1111 1111 1111')).toBe(true)
    expect(cardGroupingOk('3782 822463 10005')).toBe(true)
    expect(cardGroupingOk('41111 11111 11111 1')).toBe(false)
    expect(isIban('GB82 WEST 1234 5698 7654 32')).toBe(true)
    expect(isIban('DE89370400440532013000')).toBe(true)
    expect(isIban('GB82 WEST 1234 5698 7654 33')).toBe(false)
    expect(isAbaRouting('021000021')).toBe(true)
    expect(isAbaRouting('021000022')).toBe(false)
    expect(isSsn('123-45-6789')).toBe(true)
    expect(isSsn('000-12-3456')).toBe(false)
    expect(isSsn('666-12-3456')).toBe(false)
    expect(isSsn('923-45-6789')).toBe(false)
    expect(isSsn('123-00-6789')).toBe(false)
    expect(isVinWithCheckDigit('1HGCM82633A004352')).toBe(true)
    expect(isVinWithCheckDigit('1HGCM82633A004353')).toBe(false)
    expect(isJwt('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig')).toBe(true)
    expect(isNpi('1234567893')).toBe(true)
    expect(isPlausibleIpv6('2001:db8::8a2e:370:7334')).toBe(true)
    expect(isPlausibleIpv6('::add')).toBe(false)
  })
})

describe('pattern recognizers', () => {
  it('find contact details in their usual shapes', () => {
    expect(scan('mail jack.smith+work@example.co.uk now')).toEqual([['EMAIL_ADDRESS', 'jack.smith+work@example.co.uk']])
    expect(scan('écrire à zoë@exemple.fr.')).toEqual([['EMAIL_ADDRESS', 'zoë@exemple.fr']])
    expect(scan('call (555) 867-5309 or 555.867.5309 or +1 555 867 5309')).toEqual([
      ['PHONE_NUMBER', '(555) 867-5309'],
      ['PHONE_NUMBER', '555.867.5309'],
      ['PHONE_NUMBER', '+1 555 867 5309']
    ])
    expect(scan('+44 20 7946 0958')).toEqual([['PHONE_NUMBER', '+44 20 7946 0958']])
    // Seven digits need a reason to be a phone number.
    expect(scan('Jack has a phone number that is 867-5309.')).toEqual([['PHONE_NUMBER', '867-5309']])
    expect(scan('totals between 100-2000 and 867-5309')).toEqual([])
    expect(scan('mobile 06 12 34 56 78')).toEqual([['PHONE_NUMBER', '06 12 34 56 78']])
    expect(scan('texted on 2024-01-15')).toEqual([])
  })

  it('confirm payment and bank numbers with their checksums', () => {
    expect(scan('card 4111 1111 1111 1111 ok')).toEqual([['CREDIT_CARD_NUMBER', '4111 1111 1111 1111']])
    expect(scan('order 4111 1111 1111 1112')).toEqual([])
    expect(scan('amex 378282246310005')).toEqual([['CREDIT_CARD_NUMBER', '378282246310005']])
    expect(scan('My Amex ends in 1234.')).toEqual([['CREDIT_CARD_NUMBER', '1234']])
    expect(scan('the invoice ends in 1234')).toEqual([])
    expect(scan('cvv 123, exp 12/27, security code is 4321')).toEqual([
      ['CVV', '123'],
      ['CARD_EXPIRATION', '12/27'],
      ['CVV', '4321']
    ])
    expect(scan('subscription expires 12/27')).toEqual([])
    expect(scan('IBAN GB82 WEST 1234 5698 7654 32')).toEqual([['IBAN', 'GB82 WEST 1234 5698 7654 32']])
    expect(scan('routing 021000021')).toEqual([['ROUTING_NUMBER', '021000021']])
    expect(scan('order 021000021')).toEqual([])
    expect(scan('checking account number 12345678')).toEqual([['BANK_ACCOUNT_NUMBER', '12345678']])
  })

  it('find government, health and vehicle ids by format or by label', () => {
    expect(scan('SSN 123-45-6789')).toEqual([['SSN', '123-45-6789']])
    expect(scan('ssn: 123456789')).toEqual([['SSN', '123456789']])
    expect(scan('invoice 123456789')).toEqual([])
    expect(scan('MRN is A192828.')).toEqual([['MEDICAL_RECORD_NUMBER', 'A192828']])
    expect(scan('passport no. X1234567')).toEqual([['PASSPORT_NUMBER', 'X1234567']])
    expect(scan("driver's license D1234-5678")).toEqual([['DRIVER_LICENSE', 'D1234-5678']])
    expect(scan('EIN 12-3456789')).toEqual([['TAX_ID', '12-3456789']])
    expect(scan('NINO AB 12 34 56 C')).toEqual([['NATIONAL_ID', 'AB 12 34 56 C']])
    expect(scan('member id W123456789')).toEqual([['HEALTH_INSURANCE_ID', 'W123456789']])
    expect(scan('NPI 1234567893')).toEqual([['MEDICAL_LICENSE', '1234567893']])
    expect(scan('VIN 1HGCM82633A004352 plate ABC 1234')).toEqual([
      ['VEHICLE_IDENTIFIER', '1HGCM82633A004352'],
      ['LICENSE_PLATE', 'ABC 1234']
    ])
  })

  it('find secrets, including partial and malformed ones', () => {
    expect(scan('My password is hunter2.')).toEqual([['PASSWORD', 'hunter2']])
    expect(scan('users whose password is null')).toEqual([])
    expect(scan('pwd=Tr0ub4dor&3')).toEqual([['PASSWORD', 'Tr0ub4dor&3']])
    expect(scan('Authorization: Bearer eyJ...')).toEqual([['ACCESS_TOKEN', 'eyJ...']])
    expect(scan('the bearer of bad news')).toEqual([])
    expect(scan('key sk-proj-abcdefghijklmnopqrstuvwxyz0123 and AKIAIOSFODNN7EXAMPLE')).toEqual([
      ['API_KEY', 'sk-proj-abcdefghijklmnopqrstuvwxyz0123'],
      ['API_KEY', 'AKIAIOSFODNN7EXAMPLE']
    ])
    expect(scan('api_key: "a1b2c3d4e5f6g7h8"')).toEqual([['API_KEY', 'a1b2c3d4e5f6g7h8']])
    expect(scan('api_key is required')).toEqual([])
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
    expect(scan(`token ${jwt}`)).toEqual([['ACCESS_TOKEN', jwt]])
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'
    expect(scan(`here: ${key} thanks`)).toEqual([['PRIVATE_KEY', key]])
    expect(scan('-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n...')).toEqual([['PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n...']])
    // The password inside a connection URL is not mistaken for an email; the whole URL is withheld.
    const url = resolve(patterns.detect('postgres://admin:s3cr3t@db.internal:5432/app', { role: 'prose' }), GENERAL_PII)
    expect(url.map((s) => [s.type, s.decision.action])).toEqual([['URL', 'redact']])
    expect(url[0].members.map((m) => m.type).sort()).toEqual(['PASSWORD', 'URL'])
  })

  it('find network and device identifiers without mistaking versions and casts', () => {
    expect(scan('from 10.0.0.12.')).toEqual([['IP_ADDRESS', '10.0.0.12']])
    expect(scan('SQLite 3.45.1 on 1500.1.0.2.5')).toEqual([])
    expect(scan('fe80::1 and 2001:db8::8a2e:370:7334')).toEqual([
      ['IP_ADDRESS', 'fe80::1'],
      ['IP_ADDRESS', '2001:db8::8a2e:370:7334']
    ])
    expect(scan("select '2024-01-01'::date, x::add, at 10:30:45")).toEqual([])
    expect(scan('mac 00:1A:2B:3C:4D:5E')).toEqual([['MAC_ADDRESS', '00:1A:2B:3C:4D:5E']])
    expect(scan('see https://example.com/a?b=c).')).toEqual([['URL', 'https://example.com/a?b=c']])
    expect(scan('id 3fa85f64-5717-4562-b3fc-2c963f66afa6')).toEqual([['OTHER_UNIQUE_IDENTIFIER', '3fa85f64-5717-4562-b3fc-2c963f66afa6']])
    expect(scan('IMEI 490154203237518')).toEqual([['DEVICE_ID', '490154203237518']])
  })

  it('find dates of birth, places and employers from their phrasing', () => {
    expect(scan('DOB 1984-03-02, born on March 2, 1984')).toEqual([
      ['DATE_OF_BIRTH', '1984-03-02'],
      ['DATE_OF_BIRTH', 'March 2, 1984']
    ])
    expect(scan('orders placed on 2024-03-02')).toEqual([])
    expect(scan('I am 42 years old')).toEqual([['AGE', '42']])
    expect(scan('lives at 123 Main Street, Apt 4B')).toEqual([['STREET_ADDRESS', '123 Main Street, Apt 4B']])
    expect(scan('3 dr visits last week')).toEqual([])
    expect(scan('Springfield, IL 62701')).toEqual([['POSTAL_CODE', '62701']])
    expect(scan('order ID 12345')).toEqual([])
    expect(scan('SW1A 1AA and K1A 0B1')).toEqual([
      ['POSTAL_CODE', 'SW1A 1AA'],
      ['POSTAL_CODE', 'K1A 0B1']
    ])
    expect(scan('Patient lives behind Coral Gables High School.')).toEqual([['LOCATION', 'Coral Gables High School']])
    expect(scan('I work at Acme Corporation.')).toEqual([['EMPLOYER', 'Acme Corporation']])
    // Phrasing heuristics stay out of schema text.
    expect(scan('I work at Acme Corporation.', 'structured')).toEqual([])
  })
})

describe('name heuristics', () => {
  it('find names from titles, relations and introductions', () => {
    expect(people("Send the records to Dr. Richardson's wife Susan.")).toEqual(
      expect.arrayContaining([
        ['PERSON_NAME', 'Richardson'],
        ['RELATIVE_NAME', 'Susan']
      ])
    )
    expect(people('My son Jonathan brought me in.')).toContainEqual(['RELATIVE_NAME', 'Jonathan'])
    expect(people('customers named Zebulon Quartermaine')).toContainEqual(['PERSON_NAME', 'Zebulon Quartermaine'])
    expect(people('users called jack')).toContainEqual(['PERSON_NAME', 'jack'])
    expect(people('Hi Team, thanks')).toEqual([])
    expect(people('the table named Orders and a column called Status')).toEqual([])
  })

  it('use the gazetteer for common names, with surnames, apostrophes and accents', () => {
    expect(people('Jack Smith called me.')).toContainEqual(['PERSON_NAME', 'Jack Smith'])
    expect(people("Jack's order")).toContainEqual(['PERSON_NAME', 'Jack'])
    expect(people('Seán O’Brien and José García-Márquez')).toEqual([
      ['PERSON_NAME', 'Seán O’Brien'],
      ['PERSON_NAME', 'José García-Márquez']
    ])
    expect(people('orders for jack smith')).toContainEqual(['PERSON_NAME', 'jack smith'])
    expect(people('JACK SMITH ORDERED')).toContainEqual(['PERSON_NAME', 'JACK SMITH'])
    expect(people('Звонил Сергей Петров')).toContainEqual(['PERSON_NAME', 'Сергей Петров'])
    expect(people('我的名字是王伟 named 王伟')).toContainEqual(['PERSON_NAME', '王伟'])
  })

  it('leave words that are also names alone without context', () => {
    expect(people('Will you show invoices from May and June in Charlotte, Austin or Jordan?')).toEqual([])
    expect(people('Mark as paid. Grant access. Max revenue.')).toEqual([])
    expect(people('SELECT MAX(total) FROM orders WHERE status = ANY(ARRAY[1])')).toEqual([])
    expect(people('Show me the top customers')).toEqual([])
  })
})

describe('schema detection', () => {
  it('splits and classifies column names', () => {
    expect(splitWords('firstName')).toEqual(['first', 'name'])
    expect(splitWords('IPAddress')).toEqual(['ip', 'address'])
    expect(splitWords('address_line1')).toEqual(['address', 'line', '1'])
    const cls = (column: string, table?: string, declaredType?: string) => {
      const c = classifyColumn({ column, table, declaredType })
      return [c.type, c.content]
    }
    expect(cls('email')).toEqual(['EMAIL_ADDRESS', 'identifier'])
    expect(cls('work_email')).toEqual(['EMAIL_ADDRESS', 'identifier'])
    expect(cls('email_address')).toEqual(['EMAIL_ADDRESS', 'identifier'])
    expect(cls('email_verified', 'users', 'BOOLEAN')).toEqual([null, 'categorical'])
    expect(cls('email_count')).toEqual([null, 'unknown'])
    expect(cls('phone_number')).toEqual(['PHONE_NUMBER', 'identifier'])
    expect(cls('date_of_birth', 'patients', 'DATE')).toEqual(['DATE_OF_BIRTH', 'identifier'])
    expect(cls('ssn')).toEqual(['SSN', 'identifier'])
    expect(cls('card_number')).toEqual(['CREDIT_CARD_NUMBER', 'identifier'])
    expect(cls('ip_address')).toEqual(['IP_ADDRESS', 'identifier'])
    expect(cls('billing_address')).toEqual(['STREET_ADDRESS', 'identifier'])
    expect(cls('first_name')).toEqual(['PERSON_NAME', 'identifier'])
    expect(cls('customer_name')).toEqual(['PERSON_NAME', 'identifier'])
    expect(cls('name', 'customers')).toEqual(['PERSON_NAME', 'identifier'])
    expect(cls('name', 'products')).toEqual([null, 'unknown'])
    expect(cls('product_name')).toEqual([null, 'unknown'])
    expect(cls('state', 'orders')).toEqual([null, 'categorical'])
    expect(cls('state', 'customers')).toEqual(['STATE', 'identifier'])
    expect(cls('notes')).toEqual([null, 'free-text'])
    expect(cls('payload', 'events', 'JSONB')).toEqual([null, 'free-text'])
    expect(cls('status')).toEqual([null, 'categorical'])
    expect(cls('password_hash')).toEqual(['PASSWORD', 'identifier'])
    expect(classifyColumn({ column: 'c7', comment: 'Customer email, verified' }).type).toBe('EMAIL_ADDRESS')
  })

  it('reads labelled values in JSON, logs, headers, SQL and CSV', () => {
    expect(labelled('{"name": "Maria Garcia", "email": "maria@x.io", "total": 12}')).toEqual([
      ['PERSON_NAME', 'Maria Garcia'],
      ['EMAIL_ADDRESS', 'maria@x.io']
    ])
    expect(labelled('{"name": "orders_2024_q1"}')).toEqual([])
    expect(labelled('user=jsmith ip=192.168.1.20 msg="login ok"')).toEqual([
      ['USERNAME', 'jsmith'],
      ['IP_ADDRESS', '192.168.1.20']
    ])
    expect(labelled('Name: Zed Quux\nPhone: 555-0100\nNote: call back')).toEqual([
      ['PERSON_NAME', 'Zed Quux'],
      ['PHONE_NUMBER', '555-0100']
    ])
    expect(labelled("WHERE u.first_name = 'Zed' AND last_name LIKE '%O''Brien%' AND status = 'paid'")).toEqual([
      ['PERSON_NAME', 'Zed'],
      ['PERSON_NAME', "O''Brien"]
    ])
    expect(labelled("WHERE ssn IN ('123-45-6789', '987-65-4321')")).toEqual([
      ['SSN', '123-45-6789'],
      ['SSN', '987-65-4321']
    ])
    // Cities are recognised too; the policy decides they may be sent.
    expect(labelled('name,email,city\nZed Quux,zq@x.org,Paris\n"Doe, Jane",jd@x.org,Lyon')).toEqual([
      ['PERSON_NAME', 'Zed Quux'],
      ['EMAIL_ADDRESS', 'zq@x.org'],
      ['CITY', 'Paris'],
      ['PERSON_NAME', 'Doe, Jane'],
      ['EMAIL_ADDRESS', 'jd@x.org'],
      ['CITY', 'Lyon']
    ])
  })
})

describe('known values', () => {
  it('matches protected values exactly, on word boundaries, including their SQL-escaped form', () => {
    const vault = new PiiVault()
    vault.pseudonymFor("O'Brien", 'PERSON_NAME')
    vault.pseudonymFor('Ann', 'PERSON_NAME')
    vault.withhold('hunter2', 'PASSWORD', 'redact')
    vault.pseudonymFor('Al', 'PERSON_NAME') // too short to match on its own
    const known = new KnownValueDetector()
    const hits = known.detect("Ann and O'Brien; WHERE n = 'O''Brien'; annual Anna; hunter2! Al", vault)
    expect(hits.map((d) => [d.value, d.metadata?.canonical])).toEqual([
      ["O'Brien", "O'Brien"],
      ["O''Brien", "O'Brien"],
      ['Ann', 'Ann'],
      ['hunter2', 'hunter2']
    ])
    expect(hits.every((d) => d.validated && d.confidence === 1)).toBe(true)
  })
})
