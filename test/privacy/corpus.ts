// The development corpus for Local AI Privacy. Tune against this; never against the holdout set, which must live
// outside this public repository (see eval.test.ts and docs/LOCAL_AI_PRIVACY.md).
//
// Each case lists the values that must be protected. `tier` says what should find them:
//   deterministic  patterns, context rules, schema labels and name lists: recall is asserted
//   semantic       needs the model of Phase 3: measured and reported, not asserted, so the gap stays visible
//   negative       ordinary questions and text: nothing may be protected
import type { SensitiveEntityType } from '../../src/shared/privacy'

export interface CorpusCase {
  id: string
  text: string
  expect: { value: string; type: SensitiveEntityType }[]
  tier: 'deterministic' | 'semantic' | 'negative'
  tags: string[]
}

const c = (id: string, tier: CorpusCase['tier'], tags: string[], text: string, ...expect: [string, SensitiveEntityType][]): CorpusCase => ({
  id,
  text,
  tier,
  tags,
  expect: expect.map(([value, type]) => ({ value, type }))
})

export const CORPUS: CorpusCase[] = [
  // ---------------------------------------------------------------- the spec's examples
  c('spec-1', 'deterministic', ['name'], 'Jack Smith called me.', ['Jack Smith', 'PERSON_NAME']),
  c('spec-2', 'deterministic', ['name', 'phone'], 'Call Jack at 867-5309.', ['Jack', 'PERSON_NAME'], ['867-5309', 'PHONE_NUMBER']),
  c('spec-3', 'deterministic', ['email'], 'My email is jack@example.com.', ['jack@example.com', 'EMAIL_ADDRESS']),
  c('spec-4', 'deterministic', ['relative'], 'My son Jonathan brought me in.', ['Jonathan', 'RELATIVE_NAME']),
  c('spec-5', 'deterministic', ['name', 'relative'], "Send the records to Dr. Richardson's wife Susan.", ['Richardson', 'PERSON_NAME'], ['Susan', 'RELATIVE_NAME']),
  c('spec-6', 'deterministic', ['employer'], 'I work at Acme Corporation.', ['Acme Corporation', 'EMPLOYER']),
  c('spec-7', 'deterministic', ['location'], 'Patient lives behind Coral Gables High School.', ['Coral Gables High School', 'LOCATION']),
  c('spec-8', 'deterministic', ['health'], 'MRN is A192828.', ['A192828', 'MEDICAL_RECORD_NUMBER']),
  c('spec-9', 'deterministic', ['card'], 'My Amex ends in 1234.', ['1234', 'CREDIT_CARD_NUMBER']),
  c('spec-10', 'deterministic', ['card'], 'Security code is 821.', ['821', 'CVV']),
  c('spec-11', 'deterministic', ['secret'], 'My password is hunter2.', ['hunter2', 'PASSWORD']),
  c('spec-12', 'deterministic', ['secret'], 'Authorization: Bearer eyJ...', ['eyJ...', 'ACCESS_TOKEN']),
  c('spec-13', 'deterministic', ['secret'], '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n...', ['-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n...', 'PRIVATE_KEY']),

  // ---------------------------------------------------------------- shapes and formats
  c('punctuation', 'deterministic', ['punctuation', 'phone', 'email'], 'Contact: (555) 867-5309; email—jack.smith@example.org!', ['(555) 867-5309', 'PHONE_NUMBER'], ['jack.smith@example.org', 'EMAIL_ADDRESS']),
  c('unicode', 'deterministic', ['unicode', 'email', 'phone'], 'Écrivez à zoë.dupont@exemple.fr ou appelez le +33 6 12 34 56 78.', ['zoë.dupont@exemple.fr', 'EMAIL_ADDRESS'], ['+33 6 12 34 56 78', 'PHONE_NUMBER']),
  c('spanish', 'deterministic', ['multilingual', 'name', 'phone'], 'Llamé a José García al 612 345 678.', ['José García', 'PERSON_NAME'], ['612 345 678', 'PHONE_NUMBER']),
  c('german', 'deterministic', ['multilingual', 'name', 'phone'], 'Herr Müller erreichen Sie unter Telefon 030 1234567.', ['Müller', 'PERSON_NAME'], ['030 1234567', 'PHONE_NUMBER']),
  c('cyrillic', 'deterministic', ['multilingual', 'name'], 'Звонил Сергей Петров вчера.', ['Сергей Петров', 'PERSON_NAME']),
  c('phones', 'deterministic', ['phone'], 'call 555.867.5309, +1-555-867-5309 or +44 20 7946 0958', ['555.867.5309', 'PHONE_NUMBER'], ['+1-555-867-5309', 'PHONE_NUMBER'], ['+44 20 7946 0958', 'PHONE_NUMBER']),
  c('typo-email', 'deterministic', ['typo', 'email'], 'My emial is jack@exmaple.com', ['jack@exmaple.com', 'EMAIL_ADDRESS']),
  c('lowercase-name', 'deterministic', ['name'], 'show orders for jack smith', ['jack smith', 'PERSON_NAME']),
  c('shouted-name', 'deterministic', ['name'], 'REFUND FOR SARAH CONNOR TODAY', ['SARAH CONNOR', 'PERSON_NAME']),
  c('named', 'deterministic', ['name'], 'customers named Zebulon Quartermaine', ['Zebulon Quartermaine', 'PERSON_NAME']),
  c('ambiguous-first', 'deterministic', ['name'], 'orders for Grace Hopper or Will Smith', ['Grace Hopper', 'PERSON_NAME'], ['Will Smith', 'PERSON_NAME']),
  c('known-surname', 'deterministic', ['name'], 'Refund Tim Thompson and Ada van Wirth today', ['Tim Thompson', 'PERSON_NAME'], ['Ada van Wirth', 'PERSON_NAME']),

  // ---------------------------------------------------------------- structured text
  c('json-nested', 'deterministic', ['json', 'nested'], '{"customer": {"name": "Maria Garcia", "contact": {"email": "maria@x.io", "phone": "+34 612 345 678"}}, "total": 12.5}', ['Maria Garcia', 'PERSON_NAME'], ['maria@x.io', 'EMAIL_ADDRESS'], ['+34 612 345 678', 'PHONE_NUMBER']),
  c('json-card', 'deterministic', ['json', 'nested', 'card'], '{"order": {"billing": {"card_number": "4111111111111111", "cvv": "123", "exp": "12/27"}}}', ['4111111111111111', 'CREDIT_CARD_NUMBER'], ['123', 'CVV'], ['12/27', 'CARD_EXPIRATION']),
  c('sql', 'deterministic', ['sql'], "SELECT * FROM users WHERE email = 'jack@example.com' AND ssn = '123-45-6789' AND first_name = 'Zed'", ['jack@example.com', 'EMAIL_ADDRESS'], ['123-45-6789', 'SSN'], ['Zed', 'PERSON_NAME']),
  c('csv', 'deterministic', ['csv'], 'name,email,phone\nZed Quux,zq@x.org,555-0100\nAnn Lee,al@x.org,555-0101', ['Zed Quux', 'PERSON_NAME'], ['zq@x.org', 'EMAIL_ADDRESS'], ['555-0100', 'PHONE_NUMBER'], ['Ann Lee', 'PERSON_NAME'], ['al@x.org', 'EMAIL_ADDRESS'], ['555-0101', 'PHONE_NUMBER']),
  c('log', 'deterministic', ['log'], '2026-09-24T10:00:01Z INFO login ok user=jsmith ip=203.0.113.7 ua="Mozilla/5.0"', ['jsmith', 'USERNAME'], ['203.0.113.7', 'IP_ADDRESS']),
  c('markdown', 'deterministic', ['markdown'], '**Customer:** Jane Doe  \n**Email:** jane@doe.com\n- SSN: 078-05-1120', ['Jane Doe', 'PERSON_NAME'], ['jane@doe.com', 'EMAIL_ADDRESS'], ['078-05-1120', 'SSN']),
  c('headers', 'deterministic', ['log', 'email'], 'From: Priya Raman <priya@corp.io>\nTo: ops@corp.io\nSubject: refund', ['Priya Raman', 'PERSON_NAME'], ['priya@corp.io', 'EMAIL_ADDRESS'], ['ops@corp.io', 'EMAIL_ADDRESS']),
  c(
    'mixed',
    'deterministic',
    ['mixed', 'card'],
    'Ticket #4521 from jane@doe.com: "Please update my card 5555 5555 5555 4444, exp 01/28. Thanks, Jane"',
    ['jane@doe.com', 'EMAIL_ADDRESS'],
    ['5555 5555 5555 4444', 'CREDIT_CARD_NUMBER'],
    ['01/28', 'CARD_EXPIRATION'],
    ['Jane', 'PERSON_NAME']
  ),
  c(
    'long',
    'deterministic',
    ['long', 'mixed'],
    'Called the customer back at 10:30. Mrs. Okafor confirmed her date of birth 1981-07-14 and her new address, 42 Harbour Road, Apt 3, Leeds LS1 4AP. ' +
      'She asked us to email the statement to ngozi.okafor@mail.co.uk instead of the old account. Her member id W998877665 is unchanged; ' +
      'the payment will come from IBAN DE89 3704 0044 0532 0130 00. Follow up with her daughter Adaeze if she does not answer on 07700 900123.',
    ['Okafor', 'PERSON_NAME'],
    ['1981-07-14', 'DATE_OF_BIRTH'],
    ['42 Harbour Road, Apt 3', 'STREET_ADDRESS'],
    ['LS1 4AP', 'POSTAL_CODE'],
    ['ngozi.okafor@mail.co.uk', 'EMAIL_ADDRESS'],
    ['W998877665', 'HEALTH_INSURANCE_ID'],
    ['DE89 3704 0044 0532 0130 00', 'IBAN'],
    ['Adaeze', 'RELATIVE_NAME'],
    ['07700 900123', 'PHONE_NUMBER']
  ),

  // ---------------------------------------------------------------- identifiers
  c('bank', 'deterministic', ['bank'], 'wire to IBAN GB82 WEST 1234 5698 7654 32, routing 021000021, checking account 00123456789', ['GB82 WEST 1234 5698 7654 32', 'IBAN'], ['021000021', 'ROUTING_NUMBER'], ['00123456789', 'BANK_ACCOUNT_NUMBER']),
  c('network', 'deterministic', ['network'], 'requests from 10.20.30.40 and 2001:db8::1 (mac 00:1A:2B:3C:4D:5E) to https://intranet.example.com/users/417', ['10.20.30.40', 'IP_ADDRESS'], ['2001:db8::1', 'IP_ADDRESS'], ['00:1A:2B:3C:4D:5E', 'MAC_ADDRESS'], ['https://intranet.example.com/users/417', 'URL']),
  c('dob-age', 'deterministic', ['health'], 'DOB: 03/02/1984, she is 42 years old', ['03/02/1984', 'DATE_OF_BIRTH'], ['42', 'AGE']),
  c('gov-ids', 'deterministic', ['government'], "passport no. X1234567 and driver's license D1234-5678; SSN 219-09-9999", ['X1234567', 'PASSPORT_NUMBER'], ['D1234-5678', 'DRIVER_LICENSE'], ['219-09-9999', 'SSN']),
  c('vehicle', 'deterministic', ['vehicle'], 'VIN 1HGCM82633A004352, plate ABC 1234', ['1HGCM82633A004352', 'VEHICLE_IDENTIFIER'], ['ABC 1234', 'LICENSE_PLATE']),
  c('keys', 'deterministic', ['secret'], 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123 and aws AKIAIOSFODNN7EXAMPLE', ['sk-proj-abcdefghijklmnopqrstuvwxyz0123', 'API_KEY'], ['AKIAIOSFODNN7EXAMPLE', 'API_KEY']),
  c('connection-string', 'deterministic', ['secret', 'url'], 'DATABASE_URL=postgres://admin:s3cr3t@db.internal:5432/app', ['postgres://admin:s3cr3t@db.internal:5432/app', 'URL']),
  c('customer-id', 'deterministic', ['id'], 'refund customer id C-99812 and employee #E4521', ['C-99812', 'CUSTOMER_ID']),
  c('uk', 'deterministic', ['government', 'postcode'], 'NINO QQ 12 34 56 C, postcode SW1A 1AA', ['QQ 12 34 56 C', 'NATIONAL_ID'], ['SW1A 1AA', 'POSTAL_CODE']),

  // ---------------------------------------------------------------- needs the semantic model
  c('rare-name', 'semantic', ['name'], 'Xiomara Quispe filed the complaint yesterday.', ['Xiomara Quispe', 'PERSON_NAME']),
  c('typo-password', 'semantic', ['typo', 'secret'], 'my pasword: Tr0ub4dor', ['Tr0ub4dor', 'PASSWORD']),
  c('place', 'semantic', ['location'], 'The patient from Coral Gables was admitted to Mercy West.', ['Coral Gables', 'LOCATION'], ['Mercy West', 'LOCATION']),
  c('spelled-phone', 'semantic', ['phone'], 'reach me on five five five, eight six seven, five three zero nine', ['five five five, eight six seven, five three zero nine', 'PHONE_NUMBER']),
  c('chinese', 'semantic', ['multilingual', 'name'], '王伟住在北京。', ['王伟', 'PERSON_NAME']),
  c('employer-implicit', 'semantic', ['employer'], "She is a nurse at St. Mary's Hospital.", ["St. Mary's Hospital", 'EMPLOYER']),
  c('ambiguous-name', 'semantic', ['name'], 'Bill from accounting approved it.', ['Bill', 'PERSON_NAME']),
  c('unknown-full-name', 'semantic', ['name'], 'Edsger Dijkstra and Guido van Rossum reviewed it.', ['Edsger Dijkstra', 'PERSON_NAME'], ['Guido van Rossum', 'PERSON_NAME']),

  // ---------------------------------------------------------------- nothing to protect
  c('neg-1', 'negative', ['question'], 'top 10 customers by revenue last quarter'),
  c('neg-2', 'negative', ['question'], 'orders from May with totals between 100-2000'),
  c('neg-3', 'negative', ['question'], 'how many users signed up per week this year'),
  c('neg-4', 'negative', ['question'], 'customers in Charlotte and Austin who ordered in June'),
  c('neg-5', 'negative', ['question'], 'Mark all invoices over $5,000 as paid'),
  c('neg-6', 'negative', ['question'], 'average order value by plan for 2025'),
  c('neg-7', 'negative', ['question'], 'show the table named Jordan and its column called status'),
  c('neg-8', 'negative', ['sql'], "SELECT MAX(total), COUNT(*) FROM orders WHERE status = 'paid' GROUP BY region"),
  c('neg-9', 'negative', ['question'], 'list products in category 42 with price between 10.5 and 99.99'),
  c('neg-10', 'negative', ['question'], 'Will the report include weekends?'),
  c('neg-11', 'negative', ['question'], 'version 3.45.1 of SQLite and PostgreSQL 16.2'),
  c('neg-12', 'negative', ['question'], 'orders placed on 2024-03-02 between 09:00 and 17:30'),
  c('neg-13', 'negative', ['question'], 'Which grant programs had the most applicants?'),
  c('neg-14', 'negative', ['question'], 'revenue per store in Paris, London and Sydney'),
  c('neg-15', 'negative', ['question'], 'The password field should never be empty'),
  c('neg-16', 'negative', ['sql'], "SELECT id, token_count FROM runs WHERE token_count > 1000 AND created_at >= now() - interval '7 days'"),
  c('neg-17', 'negative', ['question'], 'users whose password is null or whose email is missing'),
  c('neg-18', 'negative', ['log'], '2026-09-24T10:00:01Z INFO job=nightly-export rows=12045 duration_ms=5321 status=ok'),
  c('neg-19', 'negative', ['question'], 'sales in Austin Texas and Florence Italy during the Summer Sale at Chase Bank on May Day')
]
