// Deterministic recognizers: formats that can be found without a model, confirmed by a checksum or parser where one
// exists, and context rules ("password is …", "MRN …") for values that only mean something next to their label.
// Every pattern is linear or tightly bounded; none nests unbounded quantifiers, so hostile input cannot stall it.
import type { SensitiveEntityType } from '@shared/privacy'
import type { DetectionContext, SensitiveDataDetector, SensitiveDetection, TextRole } from '../types'
import {
  cardGroupingOk,
  digitsOf,
  isAbaRouting,
  isCardNumber,
  isIban,
  isImei,
  isJwt,
  isNpi,
  isPlausibleIpv6,
  isSsn,
  isVinWithCheckDigit
} from './validators'
import { isIPv4 } from 'node:net'

interface Rule {
  id: string
  type: SensitiveEntityType | ((value: string, match: RegExpMatchArray) => SensitiveEntityType)
  /** Global, with the `d` flag; the value is group `v` when present, else the whole match. */
  pattern: RegExp
  confidence: number
  /** Confirmed by a checksum or parser rather than by shape alone. */
  validated?: boolean
  /** Confirms a candidate; gets the whole text and the offset for checks that look around the value. */
  validate?: (value: string, text: string, start: number) => boolean
  /** Required nearby words, checked in a window before (and optionally after) the match. */
  context?: { words: RegExp; before?: number; after?: number }
  /** Prose only: phrasing heuristics that would misread identifiers in schema text. */
  proseOnly?: boolean
  /** Strip trailing sentence punctuation from the value. */
  trim?: boolean
  metadata?: Record<string, unknown>
}

/** Keywords as a case-insensitive, word-bounded alternation. */
function words(list: string[]): RegExp {
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])(?:${list.join('|')})(?![\\p{L}\\p{N}_])`, 'iu')
}

const PHONE_WORDS = words([
  'phone', 'phones', 'ph', 'tel', 'tele', 'telephone', 'mobile', 'mob', 'cell', 'cellphone', 'fax', 'call', 'calls', 'called', 'calling',
  'text', 'texted', 'sms', 'whatsapp', 'contact', 'reach', 'dial', 'dialed', 'ring', 'number', 'numbers', 'no\\.', '#', 'tlf',
  'tel[eé]fono', 'm[oó]vil', 'celular', 'llamar', 'llam[eé]', 'llama', 't[eé]l[eé]phone', 'portable', 'appeler', 'appel[eé]',
  'telefon', 'handy', 'anrufen', 'telefone', 'ligar', 'n[uú]mero', 'num[eé]ro', 'nummer'
])
const PHONE_WORDS_CJK = /电话|手机|電話|携帯|전화/
const phoneContext = { words: new RegExp(`${PHONE_WORDS.source}|${PHONE_WORDS_CJK.source}`, 'iu'), before: 48, after: 16 }
const CARD_WORDS = words(['card', 'cards', 'credit', 'debit', 'visa', 'mastercard', 'master card', 'amex', 'american express', 'discover', 'cc', 'jcb', 'diners', 'unionpay', 'maestro'])
const SSN_WORDS = words(['ssn', 'ss#', 'ss #', 'social security', 'social sec', 'soc sec', 'ssn#'])
const ROUTING_WORDS = words(['routing', 'aba', 'rtn', 'transit', 'bank'])
const VIN_WORDS = words(['vin', 'vehicle identification', 'chassis'])
const TAX_WORDS = words(['ein', 'fein', 'employer identification', 'tax id', 'tin', 'taxpayer'])

/** Words that follow "password is" without being a password. */
const NOT_A_SECRET = new Set(
  'null empty blank missing required expired not none set unset invalid wrong correct incorrect changed reset weak strong hashed encrypted stored the a an too still being also only never always same different ok fine true false protected hidden redacted unknown forgotten lost updated saved and or is like in stale old new valid secure insecure short long case-sensitive'.split(' ')
)

const DATE =
  '(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/.-]\\d{1,2}[/.-](?:\\d{4}|\\d{2})|(?:\\d{1,2}(?:st|nd|rd|th)?\\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?(?:\\s+\\d{1,2}(?:st|nd|rd|th)?)?,?\\s+\\d{4}|(?:19|20)\\d{2})'

const LABEL_TAIL = '\\s*(?:number|no\\.?|num|nbr|#)?\\s*(?:is|was|:|=|#|-)?\\s*'

const US_STATES =
  'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|PR'

const STREET_SUFFIX =
  'street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way|place|pl|terrace|ter|circle|cir|parkway|pkwy|highway|hwy|square|sq|trail|trl|crescent|cres|close|mews|alley|aly|plaza|plz'

/** First letter either case, the rest as given: for Unicode patterns that cannot use the i flag. */
function ci(list: string[]): string {
  return list.map((w) => `[${w[0].toUpperCase()}${w[0].toLowerCase()}]${w.slice(1)}`).join('|')
}

const TITLE_WORD = "\\p{Lu}[\\p{L}\\p{M}\\p{N}&'’.-]*"

const hasDigit = (v: string) => /\d/.test(v)

const RULES: Rule[] = [
  // ---------------------------------------------------------------- secrets
  {
    id: 'private-key',
    type: 'PRIVATE_KEY',
    pattern: /-----BEGIN (?<kind>(?:[A-Z0-9]+ )*)PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END \k<kind>PRIVATE KEY(?: BLOCK)?-----|(?:\r?\n[A-Za-z0-9+/=.]*)*)/dg,
    confidence: 0.99,
    validated: true
  },
  {
    id: 'jwt',
    type: 'ACCESS_TOKEN',
    pattern: /(?<![A-Za-z0-9_-])(?<v>eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*)/dg,
    confidence: 0.98,
    validated: true,
    validate: isJwt
  },
  {
    id: 'bearer',
    type: 'ACCESS_TOKEN',
    pattern: /(?<auth>\b(?:proxy-)?authorization\s*[:=]\s*)?\b(?:bearer|basic|token|digest)\s+(?<v>eyJ[\w.-]*|[A-Za-z0-9._~+/-]{8,}={0,2})/dgi,
    confidence: 0.92,
    validate: (v) => /^eyJ/.test(v) || v.length >= 16 || /\d/.test(v)
  },
  {
    id: 'api-key',
    type: 'API_KEY',
    pattern:
      /(?<![A-Za-z0-9_-])(?<v>sk-(?:proj-|ant-(?:api\d{2}-|admin\d{2}-)?|live-|test-|svcacct-)?[A-Za-z0-9_-]{20,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}|(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|hf_[A-Za-z0-9]{30,}|npm_[A-Za-z0-9]{36}|shp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}|dop_v1_[a-f0-9]{64}|sq0(?:atp|csp)-[A-Za-z0-9_-]{22,})(?![A-Za-z0-9_-])/dg,
    confidence: 0.97,
    validated: true
  },
  {
    id: 'secret-assignment',
    type: (_v, m) => {
      const key = (m.groups?.key ?? '').toLowerCase()
      if (key.includes('private')) return 'PRIVATE_KEY'
      return key.includes('token') ? 'ACCESS_TOKEN' : 'API_KEY'
    },
    pattern:
      /(?<key>\b(?:api[_-]?key|apikey|api[_-]?secret|secret(?:[_-]?key)?|client[_-]?secret|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|bearer[_-]?token|id[_-]?token|api[_-]?token|private[_-]?key|signing[_-]?key|encryption[_-]?key|webhook[_-]?secret|x-api-key)\b)["']?\s*(?::|=|=>|\bis\b)\s*["']?(?<v>[A-Za-z0-9_\-./+=]{8,512})/dgi,
    confidence: 0.88,
    validate: (v) => (/\d/.test(v) || v.length >= 16) && !NOT_A_SECRET.has(v.toLowerCase())
  },
  {
    id: 'url-credentials',
    type: 'PASSWORD',
    pattern: /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{1,20}:\/\/[^\s:/@<>]{1,128}:(?<v>[^\s/@<>]{1,256})@/dg,
    confidence: 0.95
  },
  {
    id: 'password',
    type: 'PASSWORD',
    pattern:
      /\b(?:password|passwd|passcode|passphrase|pwd|pw|pin(?:\s*code)?|pincode|contraseña|contrasena|mot de passe|kennwort|passwort|senha)\b\s*(?:is|was|:|=|->|=>)\s*["'“‘]?(?<v>[^\s"'”’,;]{1,128})/dgi,
    confidence: 0.9,
    trim: true,
    validate: (v) => !NOT_A_SECRET.has(v.toLowerCase().replace(/[.!?)]+$/, ''))
  },
  {
    // "password hunter2": without "is" or a colon, only a value that looks like a secret counts.
    id: 'password-bare',
    type: 'PASSWORD',
    pattern: /\b(?:password|passwd|passcode|pwd|pw)\s+["'“‘]?(?<v>[^\s"'”’,;]{3,128})/dgi,
    confidence: 0.8,
    trim: true,
    validate: (v) => {
      const bare = v.replace(/[.!?)]+$/, '')
      return !NOT_A_SECRET.has(bare.toLowerCase()) && (/\d/.test(bare) || /[^A-Za-z]/.test(bare) || (/[a-z]/.test(bare) && /[A-Z]/.test(bare)))
    }
  },
  {
    id: 'cvv',
    type: 'CVV',
    pattern: /\b(?:cvv2?|cvc2?|cvn|csc|security\s+code|card\s+(?:verification|security)\s+(?:code|value|number))\b\s*(?:is|was|:|=|#|no\.?)?\s*(?<v>\d{3,4})(?!\d)/dgi,
    confidence: 0.9
  },
  {
    id: 'card-expiry',
    type: 'CARD_EXPIRATION',
    pattern: /\b(?:exp(?:\.|\s+date)?|valid\s+(?:thru|through|until)|good\s+thru)\s*(?:is|:|=|on)?\s*(?<v>(?:0?[1-9]|1[0-2])\s?[/-]\s?(?:\d{4}|\d{2}))(?![\d/-])/dgi,
    confidence: 0.85
  },
  {
    id: 'card-expiry-long',
    type: 'CARD_EXPIRATION',
    pattern: /\b(?:expiry|expiration|expires)(?:\s+date)?\s*(?:is|:|=|on)?\s*(?<v>(?:0?[1-9]|1[0-2])\s?[/-]\s?(?:\d{4}|\d{2}))(?![\d/-])/dgi,
    confidence: 0.8,
    context: { words: CARD_WORDS, before: 80, after: 40 }
  },

  // ---------------------------------------------------------------- payment and banking
  {
    id: 'card',
    type: 'CREDIT_CARD_NUMBER',
    pattern: /(?<![\d.,-])(?<v>\d(?:[ -]?\d){12,18})(?![\d-]|[.,]\d)/dg,
    confidence: 0.97,
    validated: true,
    validate: (v) => isCardNumber(v) && cardGroupingOk(v)
  },
  {
    id: 'card-last4',
    type: 'CREDIT_CARD_NUMBER',
    pattern: /\b(?:ending|ends|ended|last\s+(?:4|four)(?:\s+digits)?)\s*(?:in|with|of|:|is|are|=)?\s*(?<v>\d{4})(?!\d)/dgi,
    confidence: 0.7,
    context: { words: CARD_WORDS, before: 60 },
    metadata: { partial: true }
  },
  {
    id: 'iban',
    type: 'IBAN',
    pattern: /(?<![A-Za-z0-9])(?<v>[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?)(?![A-Za-z0-9])/dg,
    confidence: 0.97,
    validated: true,
    validate: isIban
  },
  {
    id: 'routing',
    type: 'ROUTING_NUMBER',
    pattern: /(?<!\d)(?<v>\d{9})(?!\d)/dg,
    confidence: 0.85,
    validate: isAbaRouting,
    context: { words: ROUTING_WORDS, before: 40 }
  },
  {
    id: 'bank-account',
    type: 'BANK_ACCOUNT_NUMBER',
    pattern: new RegExp(`\\b(?:(?:bank|checking|savings|chequing|current)\\s+account|acct|a/c|account)${LABEL_TAIL}(?<v>\\d[\\d -]{4,20}\\d)(?!\\d)`, 'dgi'),
    confidence: 0.8
  },

  // ---------------------------------------------------------------- government and health ids
  {
    id: 'ssn',
    type: 'SSN',
    pattern: /(?<![\d-])(?<v>\d{3}([- ])\d{2}\2\d{4})(?![\d-])/dg,
    confidence: 0.9,
    validated: true,
    validate: isSsn
  },
  {
    id: 'ssn-plain',
    type: 'SSN',
    pattern: /(?<!\d)(?<v>\d{9})(?!\d)/dg,
    confidence: 0.85,
    validate: isSsn,
    context: { words: SSN_WORDS, before: 40 }
  },
  {
    id: 'ein',
    type: 'TAX_ID',
    pattern: /(?<![\d-])(?<v>\d{2}-\d{7})(?![\d-])/dg,
    confidence: 0.85,
    context: { words: TAX_WORDS, before: 40 }
  },
  {
    id: 'tax-id',
    type: 'TAX_ID',
    pattern: new RegExp(`\\b(?:tax\\s*id|tin|itin|ein|fein|vat(?:\\s*id)?|taxpayer\\s*id)${LABEL_TAIL}(?<v>[A-Z]{0,2}\\d[0-9A-Z-]{5,14})`, 'dgi'),
    confidence: 0.8
  },
  {
    id: 'national-id',
    type: 'NATIONAL_ID',
    pattern: new RegExp(
      `\\b(?:national\\s+(?:id|identity|insurance)(?:\\s+card)?|nino|nin|social\\s+insurance|aadhaa?r|dni|nie|nif|cpf|cnpj|bsn|pesel|curp|personnummer|codice\\s+fiscale|steuer-?id|id\\s+card|identity\\s+card|id\\s+number)${LABEL_TAIL}(?<v>[A-Za-z0-9](?:[A-Za-z0-9.-]|\\s(?=\\d|[A-Za-z](?![A-Za-z0-9]))){4,20}[A-Za-z0-9])`,
      'dgi'
    ),
    confidence: 0.8,
    validate: hasDigit
  },
  {
    id: 'uk-nino',
    type: 'NATIONAL_ID',
    pattern: /(?<![A-Za-z0-9])(?<v>[A-CEGHJ-PR-TW-Z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-D])(?![A-Za-z0-9])/dg,
    confidence: 0.75
  },
  {
    id: 'passport',
    type: 'PASSPORT_NUMBER',
    pattern: new RegExp(`\\bpassport${LABEL_TAIL}(?<v>[A-Za-z0-9]{6,9})(?![A-Za-z0-9])`, 'dgi'),
    confidence: 0.85,
    validate: hasDigit
  },
  {
    id: 'driver-license',
    type: 'DRIVER_LICENSE',
    pattern: new RegExp(`\\b(?:(?:driver'?s?|drivers|driving)\\s+licen[cs]e|dl)${LABEL_TAIL}(?<v>[A-Za-z0-9][A-Za-z0-9-]{3,18})(?![A-Za-z0-9])`, 'dgi'),
    confidence: 0.85,
    validate: hasDigit
  },
  {
    id: 'mrn',
    type: 'MEDICAL_RECORD_NUMBER',
    pattern: new RegExp(
      `\\b(?:mrn|medical\\s+record(?:\\s+(?:number|no\\.?|#))?|patient\\s+(?:id|number|no\\.?|#)|chart\\s+(?:number|no\\.?|#)|health\\s+record\\s+number|nhs\\s+(?:number|no\\.?))\\b\\s*(?:is|was|:|=|#)?\\s*(?<v>[A-Za-z]{0,3}\\d[A-Za-z0-9-]{3,19})`,
      'dgi'
    ),
    confidence: 0.88
  },
  {
    id: 'insurance-id',
    type: 'HEALTH_INSURANCE_ID',
    pattern: new RegExp(`\\b(?:member|policy|subscriber|insurance|medicare|medicaid|beneficiary)\\s+(?:id|number|no\\.?|#)\\b\\s*(?:is|was|:|=|#)?\\s*(?<v>[A-Za-z0-9][A-Za-z0-9-]{4,24})`, 'dgi'),
    confidence: 0.75,
    validate: hasDigit
  },
  {
    id: 'npi',
    type: 'MEDICAL_LICENSE',
    pattern: new RegExp(`\\bnpi${LABEL_TAIL}(?<v>\\d{10})(?!\\d)`, 'dgi'),
    confidence: 0.95,
    validated: true,
    validate: isNpi
  },
  {
    id: 'medical-license',
    type: 'MEDICAL_LICENSE',
    pattern: new RegExp(`\\b(?:dea|medical\\s+licen[cs]e|state\\s+licen[cs]e)${LABEL_TAIL}(?<v>[A-Za-z]{0,2}\\d[A-Za-z0-9-]{4,12})`, 'dgi'),
    confidence: 0.85
  },

  // ---------------------------------------------------------------- contact
  {
    id: 'email',
    type: 'EMAIL_ADDRESS',
    pattern:
      /(?<![\p{L}\p{N}._%+-])(?<v>[\p{L}\p{N}_%+-](?:[\p{L}\p{N}._%+-]{0,62}[\p{L}\p{N}_%+-])?@(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.){1,8}\p{L}{2,24})(?![\p{L}\p{N}-])/dgu,
    confidence: 0.97,
    validated: true,
    // Not the password of scheme://user:password@host, which the credentials rule handles.
    validate: (v, text, start) => !v.slice(0, v.indexOf('@')).includes('..') && !/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@]*:$/.test(text.slice(Math.max(0, start - 160), start))
  },
  {
    id: 'phone-international',
    type: 'PHONE_NUMBER',
    pattern: /(?<![\w+])(?<v>\+\d{1,3}(?:[ .-]?\(\d{1,4}\))?(?:[ .-]?\d{1,4}){2,5})(?!\w)/dg,
    confidence: 0.9,
    validate: (v) => {
      const n = digitsOf(v).length
      return n >= 8 && n <= 15
    }
  },
  {
    id: 'phone-nanp',
    type: 'PHONE_NUMBER',
    pattern: /(?<![\w+])(?<v>(?:1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4})(?![\w-]|\.\d)/dg,
    confidence: 0.9
  },
  {
    id: 'phone-uk-mobile',
    type: 'PHONE_NUMBER',
    pattern: /(?<![\w+])(?<v>07\d{3} ?\d{3} ?\d{3})(?![\w-]|\.\d)/dg,
    confidence: 0.85
  },
  {
    id: 'phone-local',
    type: 'PHONE_NUMBER',
    pattern: /(?<![\w+.-])(?<v>\d{3}[-.]\d{4})(?![\w-]|\.\d)/dg,
    confidence: 0.8,
    context: phoneContext
  },
  {
    id: 'phone-digits',
    type: 'PHONE_NUMBER',
    pattern: /(?<![\w+])(?<v>\d{10,11})(?!\w)/dg,
    confidence: 0.75,
    context: phoneContext
  },
  {
    id: 'phone-grouped',
    type: 'PHONE_NUMBER',
    pattern: /(?<![\w+])(?<v>\(?0?\d{1,4}\)?(?:[ .-]\d{2,8}){1,4})(?![\w-]|\.\d)/dg,
    confidence: 0.7,
    context: phoneContext,
    validate: (v) => {
      const n = digitsOf(v).length
      return n >= 8 && n <= 13 && !/^\d{4}-\d{2}-\d{2}$/.test(v)
    }
  },

  // ---------------------------------------------------------------- network and devices
  {
    id: 'url',
    type: 'URL',
    pattern:
      /(?<v>\b(?:https?|ftp|wss?|postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|sftp|ssh|s3|jdbc:[a-z]+):\/\/[^\s<>"'`{}|\\^\uE000]{2,2048}|\bwww\.[^\s<>"'`{}|\\^\uE000]{3,2048})/dgi,
    confidence: 0.9,
    trim: true
  },
  {
    id: 'ipv4',
    type: 'IP_ADDRESS',
    pattern: /(?<![\d.])(?<v>(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})(?!\d|\.\d)/dg,
    confidence: 0.95,
    validated: true,
    validate: isIPv4
  },
  {
    id: 'ipv6',
    type: 'IP_ADDRESS',
    pattern: /(?<![\w:.])(?<v>[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7})(?![\w:.])/dg,
    confidence: 0.9,
    validated: true,
    validate: isPlausibleIpv6
  },
  {
    id: 'mac',
    type: 'MAC_ADDRESS',
    pattern: /(?<![\w:.-])(?<v>[0-9A-Fa-f]{2}([:-])[0-9A-Fa-f]{2}(?:\2[0-9A-Fa-f]{2}){4}|[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4})(?![\w:.-])/dg,
    confidence: 0.9,
    validated: true,
    validate: (v) => !/^[\d.]+$/.test(v)
  },
  {
    id: 'imei',
    type: 'DEVICE_ID',
    pattern: new RegExp(`\\bimei${LABEL_TAIL}(?<v>\\d{15})(?!\\d)`, 'dgi'),
    confidence: 0.95,
    validated: true,
    validate: isImei
  },
  {
    id: 'device-id',
    type: 'DEVICE_ID',
    pattern: /\b(?:device\s+id|serial\s+(?:number|no\.?|#)|udid|idfa|gaid|android\s+id|advertising\s+id)\b\s*(?:is|:|=|#)?\s*(?<v>[A-Za-z0-9][A-Za-z0-9-]{5,40})/dgi,
    confidence: 0.8,
    validate: hasDigit
  },
  {
    id: 'uuid',
    type: 'OTHER_UNIQUE_IDENTIFIER',
    pattern: /(?<![0-9A-Fa-f-])(?<v>[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})(?![0-9A-Fa-f-])/dg,
    confidence: 0.85,
    validated: true
  },
  {
    id: 'vin',
    type: 'VEHICLE_IDENTIFIER',
    pattern: /(?<![A-Za-z0-9])(?<v>[A-HJ-NPR-Z0-9]{17})(?![A-Za-z0-9])/dg,
    confidence: 0.95,
    validated: true,
    validate: (v) => /[A-Z]/.test(v) && /\d/.test(v) && isVinWithCheckDigit(v)
  },
  {
    id: 'vin-labelled',
    type: 'VEHICLE_IDENTIFIER',
    pattern: /(?<![A-Za-z0-9])(?<v>[A-HJ-NPR-Z0-9]{17})(?![A-Za-z0-9])/dgi,
    confidence: 0.8,
    context: { words: VIN_WORDS, before: 32 },
    validate: (v) => /[A-Za-z]/.test(v) && /\d/.test(v)
  },
  {
    id: 'plate',
    type: 'LICENSE_PLATE',
    pattern: /\b(?:licen[cs]e\s+plate|number\s+plate|registration\s+plate|plate|tag)\s*(?:number|no\.?|#)?\s*(?:is|:|=|#)?\s*(?<v>[A-Za-z0-9]{1,4}(?:[ -][A-Za-z0-9]{1,4})?)(?![A-Za-z0-9])/dgi,
    confidence: 0.8,
    validate: (v) => hasDigit(v) && /[A-Z]/.test(v) && !/[a-z]/.test(v)
  },

  // ---------------------------------------------------------------- dates of birth and ages
  {
    id: 'dob',
    type: 'DATE_OF_BIRTH',
    pattern: new RegExp(`\\b(?:dob|d\\.o\\.b\\.?|date\\s+of\\s+birth|birth\\s?date|birthday|born(?:\\s+on|\\s+in)?)\\s*(?:is|was|:|=|-)?\\s*(?<v>${DATE})(?!\\d)`, 'dgi'),
    confidence: 0.9
  },
  {
    id: 'age',
    type: 'AGE',
    pattern: /\b(?<v>\d{1,3})[- ]?(?:years?|yrs?)[- ]old\b/dgi,
    confidence: 0.8
  },
  {
    id: 'age-labelled',
    type: 'AGE',
    pattern: /\baged?\s*(?:is|:|=|of)?\s*(?<v>\d{1,3})(?!\d)/dgi,
    confidence: 0.75
  },

  // ---------------------------------------------------------------- accounts and people's ids
  {
    id: 'employee-id',
    type: 'EMPLOYEE_ID',
    pattern: /\b(?:employee|emp|staff|badge|payroll)\s*(?:id|#|number|no\.?|num)\b\s*(?:is|:|=|#)?\s*(?<v>[A-Za-z]{0,4}-?\d[A-Za-z0-9-]{0,19})/dgi,
    confidence: 0.8
  },
  {
    id: 'customer-id',
    type: 'CUSTOMER_ID',
    pattern: /\b(?:customer|cust|client)\s*(?:id|#|number|no\.?|num)\b\s*(?:is|:|=|#)?\s*(?<v>[A-Za-z]{0,4}-?\d[A-Za-z0-9-]{0,19})/dgi,
    confidence: 0.8
  },
  {
    id: 'account-id',
    type: 'ACCOUNT_ID',
    pattern: /\baccount\s*(?:id|#)\b\s*(?:is|:|=|#)?\s*(?<v>[A-Za-z]{0,4}-?\d[A-Za-z0-9-]{0,19})/dgi,
    confidence: 0.8
  },
  {
    id: 'username',
    type: 'USERNAME',
    pattern: /\b(?:username|user\s+name|userid|user\s+id|login|screen\s+name|handle)\s*(?:is|:|=)\s*["']?(?<v>[A-Za-z0-9._@-]{3,64})/dgi,
    confidence: 0.8,
    trim: true,
    validate: (v) => !NOT_A_SECRET.has(v.toLowerCase())
  },
  {
    id: 'handle',
    type: 'USERNAME',
    pattern: /(?<![\w.@/])(?<v>@[A-Za-z0-9_]{2,30})(?![\w@]|\.\w)/dg,
    confidence: 0.7
  },

  // ---------------------------------------------------------------- places
  {
    id: 'street-address',
    type: 'STREET_ADDRESS',
    pattern: new RegExp(
      `(?<![\\p{L}\\p{N}])(?<v>\\d{1,6}[A-Za-z]?(?:-\\d{1,4})?\\s+(?:[NSEW]\\.?\\s+|(?:north|south|east|west)\\s+)?(?:[\\p{L}\\p{N}][\\p{L}\\p{N}'.-]*\\s+){1,4}?(?:${STREET_SUFFIX})\\b\\.?(?:,?\\s+(?:apt|apartment|suite|ste|unit|fl|floor|room|rm|#)\\.?\\s*#?[A-Za-z0-9-]{1,6})?)`,
      'dgiu'
    ),
    confidence: 0.85
  },
  {
    id: 'po-box',
    type: 'STREET_ADDRESS',
    pattern: /\b(?<v>p\.?\s?o\.?\s+box\s+\d{1,8})\b/dgi,
    confidence: 0.85
  },
  {
    id: 'zip-after-state',
    type: 'POSTAL_CODE',
    pattern: new RegExp(`,\\s*(?:${US_STATES})\\s+(?<v>\\d{5}(?:-\\d{4})?)(?![\\d-])`, 'dg'),
    confidence: 0.85
  },
  {
    id: 'postal-labelled',
    type: 'POSTAL_CODE',
    pattern: /\b(?:zip(?:\s*code)?|zipcode|postal\s+code|postcode|post\s+code|plz|c[oó]digo\s+postal|code\s+postal)\b\s*(?:is|:|=|#)?\s*(?<v>[A-Za-z0-9](?:[A-Za-z0-9-]|\s(?=\d)){2,8}[A-Za-z0-9])(?![A-Za-z0-9])/dgi,
    confidence: 0.85,
    validate: hasDigit
  },
  {
    id: 'uk-postcode',
    type: 'POSTAL_CODE',
    pattern: /(?<![A-Za-z0-9])(?<v>[A-PR-UWYZ][A-HK-Y]?\d[A-Z\d]? ?\d[ABD-HJLNP-UW-Z]{2})(?![A-Za-z0-9])/dg,
    confidence: 0.8
  },
  {
    id: 'ca-postcode',
    type: 'POSTAL_CODE',
    pattern: /(?<![A-Za-z0-9])(?<v>[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z] ?\d[ABCEGHJ-NPRSTV-Z]\d)(?![A-Za-z0-9])/dg,
    confidence: 0.8
  },
  {
    id: 'lives-at',
    type: 'LOCATION',
    pattern: new RegExp(
      `\\b(?:${ci(['lives', 'live', 'living', 'lived', 'resides', 'reside', 'residing', 'resided', 'staying', 'stays', 'located', 'moved'])})\\s+(?:in|at|on|near|behind|by|beside|next\\s+to|across\\s+from|off|around|to)\\s+(?:the\\s+)?(?<v>${TITLE_WORD}(?:\\s+(?:of\\s+|de\\s+|del\\s+|la\\s+|the\\s+|on\\s+|upon\\s+)?${TITLE_WORD}){0,5})`,
      'dgu'
    ),
    confidence: 0.7,
    proseOnly: true,
    trim: true
  },
  {
    id: 'works-at',
    type: 'EMPLOYER',
    pattern: new RegExp(
      `\\b(?:${ci(['works', 'work', 'worked', 'working', 'employed', 'interns', 'intern', 'interned', 'interning'])})\\s+(?:at|for|with|by)\\s+(?:the\\s+)?(?<v>${TITLE_WORD}(?:\\s+(?:&\\s+|and\\s+|of\\s+|de\\s+)?${TITLE_WORD}){0,4})`,
      'dgu'
    ),
    confidence: 0.7,
    proseOnly: true,
    trim: true
  }
]

function trimValue(value: string): string {
  let v = value.replace(/[.,;:!?'"’”]+$/u, '')
  // A closing bracket belongs to the value only when the value opened one.
  while (/[)\]]$/.test(v)) {
    const open = v.endsWith(')') ? '(' : '['
    const close = v.endsWith(')') ? ')' : ']'
    if (v.split(open).length >= v.split(close).length) break
    v = v.slice(0, -1).replace(/[.,;:!?'"’”]+$/u, '')
  }
  return v
}

export class PatternDetector implements SensitiveDataDetector {
  readonly id = 'patterns'
  readonly version = 1
  readonly roles: readonly TextRole[] = ['prose', 'structured']

  detect(text: string, ctx: DetectionContext): SensitiveDetection[] {
    const out: SensitiveDetection[] = []
    for (const rule of RULES) {
      if (rule.proseOnly && ctx.role === 'structured') continue
      for (const m of text.matchAll(rule.pattern)) {
        const span = m.indices?.groups?.v ?? m.indices?.[0]
        if (!span) continue
        let [start, end] = span
        let value = text.slice(start, end)
        if (rule.trim) {
          value = trimValue(value)
          end = start + value.length
        }
        if (!value || value.includes('\uE000')) continue
        if (rule.validate && !rule.validate(value, text, start)) continue
        if (rule.context) {
          const lo = Math.max(0, start - (rule.context.before ?? 48))
          const window = `${text.slice(lo, start)} ${text.slice(end, end + (rule.context.after ?? 0))}`
          if (!rule.context.words.test(window)) continue
        }
        const type = typeof rule.type === 'function' ? rule.type(value, m) : rule.type
        out.push({
          start,
          end,
          value,
          type,
          confidence: rule.confidence,
          source: 'deterministic',
          detector: `patterns.${rule.id}`,
          validated: rule.validated,
          ...(rule.metadata ? { metadata: rule.metadata } : {})
        })
      }
    }
    return out
  }
}
