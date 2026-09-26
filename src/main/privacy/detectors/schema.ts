// Database awareness: what a column holds, from its table and column names, declared type and comment. The same
// classifier reads field names in text, so "email": "…" in JSON, email=… in a log line, email = '…' in SQL and an
// email column of a CSV are recognised by their label. Classifications are per request and never stored.
import type { SensitiveEntityType } from '@shared/privacy'
import type { ColumnClassification, ColumnContext, DetectionContext, SensitiveDataDetector, SensitiveDetection, TextRole } from '../types'

type Content = ColumnClassification['content']

interface ColumnRule {
  id: string
  type: SensitiveEntityType | null
  content: Content
  confidence: number
  /** Whole names, separators removed: "first_name" -> "firstname". */
  full?: string[]
  /** The last meaningful word: "work_email" -> "email". */
  last?: string[]
  /** Only in tables that hold people (users, customers, patients…). */
  personTable?: boolean
}

const rule = (id: string, type: SensitiveEntityType | null, content: Content, confidence: number, full: string, last = '', personTable = false): ColumnRule => ({
  id,
  type,
  content,
  confidence,
  full: full.split(/\s+/).filter(Boolean),
  last: last.split(/\s+/).filter(Boolean),
  personTable
})

/** Checked in order; the first match wins, so "email_address" is an email before it is an address. */
const RULES: ColumnRule[] = [
  rule('password', 'PASSWORD', 'identifier', 0.97, 'password passwd pwd passwordhash hashedpassword passhash passwordsalt pin pincode passcode secretanswer securityanswer passwordresettoken', 'password passwd pwd passcode'),
  rule('private-key', 'PRIVATE_KEY', 'identifier', 0.97, 'privatekey sshkey pem rsakey pgpkey privkey', ''),
  rule('api-key', 'API_KEY', 'identifier', 0.95, 'apikey apisecret secret secretkey clientsecret accesskey accesskeyid secretaccesskey webhooksecret signingkey encryptionkey', 'apikey secret'),
  rule('token', 'ACCESS_TOKEN', 'identifier', 0.93, 'token accesstoken refreshtoken authtoken sessiontoken bearertoken idtoken resettoken verificationtoken apitoken jwt sessionid pushtoken devicetoken', 'token'),
  rule('email', 'EMAIL_ADDRESS', 'identifier', 0.95, 'email emailaddress emailaddr mail email1 email2 useremail contactemail', 'email emails'),
  rule('phone', 'PHONE_NUMBER', 'identifier', 0.95, 'phone phonenumber telephone tel mobile mobilenumber cell cellphone fax faxnumber msisdn contactnumber', 'phone telephone mobile cell cellphone fax msisdn tel'),
  rule('ssn', 'SSN', 'identifier', 0.97, 'ssn socialsecuritynumber socialsecurity socialsecurityno ssnlast4', 'ssn'),
  rule('national-id', 'NATIONAL_ID', 'identifier', 0.9, 'nationalid nationalidnumber nin nino nationalinsurance nationalinsurancenumber sin socialinsurancenumber aadhaar aadhar cpf dni nie nif bsn pesel personnummer codicefiscale curp idcardnumber', ''),
  rule('passport', 'PASSPORT_NUMBER', 'identifier', 0.95, 'passport passportno passportnumber passportnum', 'passport'),
  rule('driver-license', 'DRIVER_LICENSE', 'identifier', 0.93, 'driverslicense driverlicense driverslicence driverlicence dlnumber dlno drivinglicence drivinglicense licensenumber', ''),
  rule('tax-id', 'TAX_ID', 'identifier', 0.93, 'taxid tin ein fein itin vatnumber vatid taxnumber taxidnumber abn gstin', ''),
  rule('mrn', 'MEDICAL_RECORD_NUMBER', 'identifier', 0.93, 'mrn medicalrecordnumber medicalrecordno medicalrecord patientid patientnumber chartnumber healthrecordnumber nhsnumber', 'mrn'),
  rule('insurance', 'HEALTH_INSURANCE_ID', 'identifier', 0.9, 'insuranceid insurancenumber policynumber subscriberid medicareid medicaidid healthplanid memberid', ''),
  rule('medical-license', 'MEDICAL_LICENSE', 'identifier', 0.9, 'npi deanumber medicallicense medicallicensenumber', 'npi'),
  rule('card', 'CREDIT_CARD_NUMBER', 'identifier', 0.97, 'cardnumber creditcard creditcardnumber ccnumber cc pan cardno cardnum debitcard paymentcard primaryaccountnumber', ''),
  rule('cvv', 'CVV', 'identifier', 0.97, 'cvv cvc cvv2 cvc2 securitycode cardcode csc cardverificationcode', 'cvv cvc'),
  rule('card-expiry', 'CARD_EXPIRATION', 'identifier', 0.9, 'cardexpiry cardexp exp expiry expdate expmonth expyear cardexpiration ccexp cardexpirydate', ''),
  rule('iban', 'IBAN', 'identifier', 0.97, 'iban ibannumber', 'iban'),
  rule('routing', 'ROUTING_NUMBER', 'identifier', 0.93, 'routingnumber aba abanumber routing sortcode bsb transitnumber', ''),
  rule('bank-account', 'BANK_ACCOUNT_NUMBER', 'identifier', 0.93, 'accountnumber acctnumber acctno bankaccount bankaccountnumber accountno checkingaccount savingsaccount', ''),
  rule('ip', 'IP_ADDRESS', 'identifier', 0.95, 'ip ipaddress ipaddr clientip remoteip remoteaddr lastloginip sourceip srcip destip userip ipv4 ipv6 xforwardedfor', 'ip'),
  rule('mac', 'MAC_ADDRESS', 'identifier', 0.95, 'mac macaddress macaddr hwaddr', ''),
  rule('device', 'DEVICE_ID', 'identifier', 0.9, 'deviceid udid imei serialnumber serialno advertisingid idfa gaid androidid deviceserial', 'udid imei'),
  rule('plate', 'LICENSE_PLATE', 'identifier', 0.9, 'licenseplate plate platenumber vehiclereg numberplate', ''),
  rule('vin', 'VEHICLE_IDENTIFIER', 'identifier', 0.95, 'vin vinnumber chassisnumber', 'vin'),
  rule('dob', 'DATE_OF_BIRTH', 'identifier', 0.95, 'dob dateofbirth birthdate birthday birthdt bday', 'dob birthdate birthday'),
  rule('age', 'AGE', 'identifier', 0.85, 'age ageyears', ''),
  rule('username', 'USERNAME', 'identifier', 0.9, 'username user usr login loginname handle screenname userhandle accountname samaccountname upn', 'username'),
  rule('employee-id', 'EMPLOYEE_ID', 'identifier', 0.9, 'employeeid empid employeenumber staffid staffnumber badgenumber badgeid payrollid workerid', ''),
  rule('customer-id', 'CUSTOMER_ID', 'identifier', 0.85, 'customerid custid customernumber clientnumber', ''),
  rule('account-id', 'ACCOUNT_ID', 'identifier', 0.8, 'accountid acctid', ''),
  rule('street', 'STREET_ADDRESS', 'identifier', 0.9, 'address streetaddress street address1 address2 addressline1 addressline2 addr addr1 addr2 homeaddress mailingaddress billingaddress shippingaddress streetname housenumber residentialaddress', 'address street'),
  rule('postal', 'POSTAL_CODE', 'identifier', 0.9, 'zip zipcode postalcode postcode postal zip5 zip4 billingzip shippingzip', 'zip zipcode postcode'),
  rule('city', 'CITY', 'identifier', 0.85, 'city town municipality homecity billingcity shippingcity', 'city'),
  rule('state', 'STATE', 'identifier', 0.8, 'province region stateprovince statecode county', 'province', true),
  rule('state-person', 'STATE', 'identifier', 0.8, 'state', '', true),
  rule('country', 'COUNTRY', 'identifier', 0.85, 'country countrycode countryname', 'country'),
  rule('location', 'LOCATION', 'identifier', 0.85, 'latitude longitude lat lng lon geo geolocation coordinates gps geom geography latlng', ''),
  rule('url', 'URL', 'identifier', 0.85, 'url website homepage profileurl avatarurl webpage linkedin twitter facebook instagram socialurl', 'url website'),
  rule('biometric', 'BIOMETRIC_IDENTIFIER', 'identifier', 0.9, 'biometric faceid facetemplate voiceprint retinascan irisscan palmprint biometrictemplate fingerprinttemplate', 'biometric'),
  rule('employer', 'EMPLOYER', 'identifier', 0.8, 'employer employername company companyname organization organisation workplace', 'employer', true),
  rule('occupation', 'OCCUPATION', 'identifier', 0.8, 'occupation jobtitle profession job', 'occupation profession', true),
  rule('person-name', 'PERSON_NAME', 'identifier', 0.95, 'firstname lastname fullname givenname familyname surname middlename maidenname fname lname mname preferredname legalname mothersmaidenname nextofkin', 'surname forename'),
  rule('name', 'PERSON_NAME', 'identifier', 0.8, 'name displayname nickname', '', true),
  rule('free-text', null, 'free-text', 0.9, '', 'notes note description desc comments comment message messages body content details detail payload metadata meta remarks remark bio biography about summary text memo reason feedback review narrative transcript log logs subject observations symptoms diagnosis instructions answer response request extra attributes properties context freetext additionalinfo info'),
  rule('categorical', null, 'categorical', 0.8, '', 'status state type kind category plan tier level code flag currency unit method channel source medium stage priority severity mode role gender sex language locale timezone tz format color colour size brand sku')
]

/** Words before "name" that make it a person's: customer_name, emergency_contact_name. */
const PERSON_ROLES = new Set(
  'customer patient employee user member contact client owner holder cardholder account recipient sender beneficiary guardian parent mother father spouse emergency student teacher doctor physician nurse agent rep representative manager supervisor author reviewer assignee reporter buyer seller tenant landlord driver passenger guest applicant candidate lead person player coach volunteer donor subscriber billing shipping first last full given family middle maiden display nick legal preferred kin'.split(
    ' '
  )
)

const PERSON_TABLES = new Set(
  'user customer client patient employee staff member contact person people student applicant candidate guest subscriber lead author doctor physician owner tenant resident driver passenger volunteer donor recipient beneficiary profile account holder parent guardian teacher agent'.split(
    ' '
  )
)

/** Words that only qualify a column name: phone_number -> phone. */
const QUALIFIERS = new Set('number num no nbr value text raw primary main digits enc encrypted masked plain full'.split(' '))

export function splitWords(name: string): string[] {
  return name
    .replace(/"/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/)
    .map((w) => w.toLowerCase())
    .filter(Boolean)
}

function singular(w: string): string {
  if (w === 'people') return 'person'
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`
  if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) return w.slice(0, -1)
  return w
}

const UNKNOWN: ColumnClassification = { type: null, confidence: 0, content: 'unknown', rule: 'none' }

const COMMENT_HINTS: [RegExp, SensitiveEntityType][] = [
  [/\be-?mail\b/i, 'EMAIL_ADDRESS'],
  [/\bphone|telephone|mobile number\b/i, 'PHONE_NUMBER'],
  [/\bsocial security|\bssn\b/i, 'SSN'],
  [/\bdate of birth|\bbirth ?date|\bdob\b/i, 'DATE_OF_BIRTH'],
  [/\b(?:first|last|full|given|family) name|\bsurname\b/i, 'PERSON_NAME'],
  [/\bstreet address|\bhome address|\bmailing address/i, 'STREET_ADDRESS'],
  [/\bcard number|\bcredit card\b/i, 'CREDIT_CARD_NUMBER'],
  [/\bpassword|\bpasscode\b/i, 'PASSWORD'],
  [/\bip address\b/i, 'IP_ADDRESS'],
  [/\bmedical record|\bmrn\b/i, 'MEDICAL_RECORD_NUMBER']
]

/** What a column holds, from its name first, then its comment. Deterministic; nothing is remembered. */
export function classifyColumn(col: ColumnContext): ColumnClassification {
  const words = splitWords(col.column)
  if (!words.length) return UNKNOWN
  const declared = (col.declaredType ?? '').toLowerCase()
  const tableWords = col.table ? splitWords(col.table.split('.').pop() ?? col.table).map(singular) : []
  const personTable = tableWords.some((w) => PERSON_TABLES.has(w))
  let core = [...words]
  while (core.length > 1 && (QUALIFIERS.has(core[core.length - 1]) || /^\d+$/.test(core[core.length - 1]))) core = core.slice(0, -1)
  const full = words.join('')
  const coreFull = core.join('')
  const last = core[core.length - 1]
  const boolean = /^(bool|boolean|bit)\b/.test(declared)
  const json = /^(json|jsonb|xml)\b/.test(declared)
  // A flag cannot hold an email or a name, whatever it is called.
  if (boolean) return { type: null, confidence: 0.9, content: 'categorical', rule: 'boolean' }

  for (const r of RULES) {
    if (r.personTable && !personTable) continue
    const hit = r.full?.includes(full) || r.full?.includes(coreFull) || r.last?.includes(last)
    if (!hit) continue
    return { type: r.type, confidence: r.confidence, content: r.content, rule: r.id }
  }
  // "customer_name", "emergency_contact_name": a name whose owner is a person.
  if (last === 'name' && core.length >= 2 && PERSON_ROLES.has(core[core.length - 2])) {
    return { type: 'PERSON_NAME', confidence: 0.9, content: 'identifier', rule: 'role-name' }
  }
  if (json) return { type: null, confidence: 0.9, content: 'free-text', rule: 'json' }
  if (col.comment) {
    for (const [re, type] of COMMENT_HINTS) if (re.test(col.comment)) return { type, confidence: 0.7, content: 'identifier', rule: 'comment' }
  }
  return UNKNOWN
}

// ---------------------------------------------------------------------------
// Labelled values in text
// ---------------------------------------------------------------------------

/** One to four name-like words, "Last, First" included. */
const PERSONISH = /^(?:\p{Lu}[\p{L}\p{M}'’.-]*|\p{Ll}[\p{L}\p{M}'’-]*)(?:,?\s+(?:\p{Lu}[\p{L}\p{M}'’.-]*|\p{Ll}[\p{L}\p{M}'’-]*)){0,3}$/u

/** How a field label classifies its value; a bare "name" counts only for values shaped like a name. */
function classifyLabel(key: string, value: string): ColumnClassification | null {
  const cls = classifyColumn({ column: key })
  if (cls.type && cls.content === 'identifier') return cls
  if (splitWords(key).join('') === 'name' && PERSONISH.test(value.trim())) return { type: 'PERSON_NAME', confidence: 0.6, content: 'identifier', rule: 'label-name' }
  return null
}

const JSON_PAIR = /"(?<key>[A-Za-z_][\w\- ]{0,63})"\s*:\s*(?:"(?<v>(?:[^"\\\n]|\\.){1,512})"|(?<n>-?\d[\d.\-]{2,40}))/dg
const ASSIGNMENT = /(?<![\w.\-])(?<key>[A-Za-z_][\w.\-]{0,63})=(?:"(?<q>[^"\n]{1,256})"|'(?<sq>[^'\n]{1,256})'|(?<v>[^\s"'&;,|<>{}[\]]{1,256}))/dg
const HEADER_LINE = /(?:^|\n)[ \t]*(?<key>[A-Za-z_][\w.\- ]{0,40}?)[ \t]*:[ \t]+(?<v>[^\n]{1,200})/dg
const SQL_COMPARE = /(?<![\w$"])(?<key>[A-Za-z_][\w$]*|"[^"\n]{1,63}")\s*(?:=|<>|!=|\bI?LIKE\b|\bNOT\s+I?LIKE\b)\s*'(?<v>(?:[^'\n]|''){1,256})'/dgi
const SQL_IN = /(?<![\w$"])(?<key>[A-Za-z_][\w$]*|"[^"\n]{1,63}")\s+(?:NOT\s+)?IN\s*\((?<list>(?:\s*'(?:[^'\n]|''){0,256}'\s*,?){1,100})\)/dgi

function csvFields(line: string, delimiter: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  let i = 0
  while (i <= line.length) {
    if (line[i] === '"') {
      let j = i + 1
      while (j < line.length && !(line[j] === '"' && line[j + 1] !== '"')) j += line[j] === '"' ? 2 : 1
      out.push({ start: i + 1, end: j })
      i = j + 1
      if (line[i] === delimiter) i++
      else if (i < line.length) return []
    } else {
      const j = line.indexOf(delimiter, i)
      const end = j < 0 ? line.length : j
      out.push({ start: i, end })
      if (j < 0) break
      i = j + 1
      if (i === line.length) out.push({ start: i, end: i })
    }
  }
  return out
}

export class LabeledValueDetector implements SensitiveDataDetector {
  readonly id = 'schema'
  readonly version = 1
  readonly roles: readonly TextRole[] = ['prose']

  detect(text: string, _ctx: DetectionContext): SensitiveDetection[] {
    const out: SensitiveDetection[] = []
    const add = (key: string, start: number, end: number, rule: string) => {
      let value = text.slice(start, end)
      // LIKE patterns: the wildcards stay visible, the value inside is protected.
      const lead = /^[%_]*/.exec(value)?.[0].length ?? 0
      const trail = /[%_]*$/.exec(value.slice(lead))?.[0].length ?? 0
      start += lead
      end -= trail
      value = text.slice(start, end).trim()
      if (!value || value.includes('\uE000')) return
      const cls = classifyLabel(key.replace(/"/g, ''), value)
      if (!cls?.type) return
      const offset = text.slice(start, end).indexOf(value)
      out.push({ start: start + offset, end: start + offset + value.length, value, type: cls.type, confidence: cls.confidence, source: 'schema', detector: `schema.${rule}`, metadata: { rule: cls.rule } })
    }
    if (text.includes(':') || text.includes('"')) {
      for (const m of text.matchAll(JSON_PAIR)) {
        const g = m.indices?.groups?.v ?? m.indices?.groups?.n
        if (g) add(m.groups?.key ?? '', g[0], g[1], 'json')
      }
    }
    if (text.includes('=')) {
      for (const m of text.matchAll(ASSIGNMENT)) {
        const g = m.indices?.groups?.q ?? m.indices?.groups?.sq ?? m.indices?.groups?.v
        if (g) add(m.groups?.key ?? '', g[0], g[1], 'assignment')
      }
    }
    if (text.includes(':')) {
      for (const m of text.matchAll(HEADER_LINE)) {
        const g = m.indices?.groups?.v
        if (!g) continue
        const end = g[0] + text.slice(g[0], g[1]).replace(/[\s,;"']+$/, '').length
        add(m.groups?.key ?? '', g[0], end, 'label')
      }
    }
    if (text.includes("'")) {
      for (const m of text.matchAll(SQL_COMPARE)) {
        const g = m.indices?.groups?.v
        if (g) add(m.groups?.key ?? '', g[0], g[1], 'sql')
      }
      for (const m of text.matchAll(SQL_IN)) {
        const g = m.indices?.groups?.list
        if (!g) continue
        for (const lit of text.slice(g[0], g[1]).matchAll(/'((?:[^'\n]|''){1,256})'/g)) {
          const s = g[0] + (lit.index ?? 0) + 1
          add(m.groups?.key ?? '', s, s + lit[1].length, 'sql')
        }
      }
    }
    this.csv(text, out)
    return out
  }

  /** A header row names the columns of the lines below it. */
  private csv(text: string, out: SensitiveDetection[]): void {
    const firstBreak = text.indexOf('\n')
    if (firstBreak < 0) return
    const header = text.slice(0, firstBreak).replace(/\r$/, '')
    const delimiter = [',', '\t', ';', '|'].find((d) => header.includes(d))
    if (!delimiter) return
    const names = csvFields(header, delimiter).map((f) => header.slice(f.start, f.end).trim())
    if (names.length < 2 || !names.every((n) => /^[A-Za-z_][\w .\-]{0,63}$/.test(n))) return
    const classes = names.map((n) => classifyColumn({ column: n }))
    const bareName = names.map((n) => splitWords(n).join('') === 'name')
    if (!classes.some((c, i) => (c.type && c.content === 'identifier') || bareName[i])) return
    let pos = firstBreak + 1
    for (const raw of text.slice(pos).split('\n')) {
      const line = raw.replace(/\r$/, '')
      const fields = csvFields(line, delimiter)
      if (fields.length === names.length) {
        fields.forEach((f, i) => {
          const value = line.slice(f.start, f.end)
          const cls = classes[i].type && classes[i].content === 'identifier' ? classes[i] : bareName[i] ? classifyLabel(names[i], value) : null
          if (!cls?.type || cls.content !== 'identifier' || !value.trim()) return
          const lead = value.length - value.trimStart().length
          const v = value.trim()
          out.push({ start: pos + f.start + lead, end: pos + f.start + lead + v.length, value: v, type: cls.type, confidence: cls.confidence, source: 'schema', detector: 'schema.csv', metadata: { rule: cls.rule } })
        })
      }
      pos += raw.length + 1
    }
  }
}
