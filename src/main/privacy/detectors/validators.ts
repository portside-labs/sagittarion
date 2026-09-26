// Checksums and parsers that turn a pattern match into a confirmed one.
import { isIPv4, isIPv6 } from 'node:net'

export function digitsOf(s: string): string {
  return s.replace(/\D/g, '')
}

export function luhn(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

/** A payment card number: right length for its network, a known issuer prefix, and a valid Luhn check digit. */
export function isCardNumber(raw: string): boolean {
  const d = digitsOf(raw)
  if (d.length < 13 || d.length > 19 || !luhn(d)) return false
  if (/^(\d)\1+$/.test(d)) return false
  const p2 = Number(d.slice(0, 2))
  const p3 = Number(d.slice(0, 3))
  const p4 = Number(d.slice(0, 4))
  const p6 = Number(d.slice(0, 6))
  if (d[0] === '4') return [13, 16, 19].includes(d.length) // Visa
  if ((p2 >= 51 && p2 <= 55) || (p4 >= 2221 && p4 <= 2720)) return d.length === 16 // Mastercard
  if (p2 === 34 || p2 === 37) return d.length === 15 // American Express
  if (p4 === 6011 || p2 === 65 || (p3 >= 644 && p3 <= 649) || (p6 >= 622126 && p6 <= 622925)) return d.length >= 16 // Discover
  if (p4 >= 3528 && p4 <= 3589) return d.length >= 16 // JCB
  if ((p3 >= 300 && p3 <= 305) || p2 === 36 || p2 === 38 || p2 === 39) return d.length >= 14 // Diners Club
  if (p2 === 62) return d.length >= 16 // UnionPay
  if ([5018, 5020, 5038, 5893, 6304, 6759, 6761, 6762, 6763].includes(p4)) return d.length >= 12 // Maestro
  return false
}

/** Grouping looks like a card as printed: no separators, or groups of four (Amex 4-6-5). */
export function cardGroupingOk(raw: string): boolean {
  if (/^\d+$/.test(raw)) return true
  const groups = raw.split(/[ -]/)
  if (new Set(raw.replace(/\d/g, '')).size > 1) return false
  const lens = groups.map((g) => g.length).join(',')
  return /^(4,)*[1-4]$|^4(,4)+(,[1-4])?$/.test(lens) || lens === '4,6,5' || lens === '4,6,4'
}

/** IBAN: country code, check digits, and the mod-97 check. */
export function isIban(raw: string): boolean {
  const s = raw.replace(/\s+/g, '').toUpperCase()
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false
  const rearranged = s.slice(4) + s.slice(0, 4)
  let rem = 0
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0)
    const chunk = code >= 65 ? String(code - 55) : ch
    for (const c of chunk) rem = (rem * 10 + (c.charCodeAt(0) - 48)) % 97
  }
  return rem === 1
}

/** US ABA routing number: valid Federal Reserve prefix and the 3-7-1 checksum. */
export function isAbaRouting(raw: string): boolean {
  const d = digitsOf(raw)
  if (d.length !== 9) return false
  const prefix = Number(d.slice(0, 2))
  if (!((prefix >= 0 && prefix <= 12) || (prefix >= 21 && prefix <= 32) || (prefix >= 61 && prefix <= 72) || prefix === 80)) return false
  const n = [...d].map(Number)
  return (3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5] + n[8])) % 10 === 0
}

/** A US social security number that could have been issued: area not 000, 666 or 9xx; group and serial not zero. */
export function isSsn(raw: string): boolean {
  const d = digitsOf(raw)
  if (d.length !== 9) return false
  const area = d.slice(0, 3)
  return area !== '000' && area !== '666' && d[0] !== '9' && d.slice(3, 5) !== '00' && d.slice(5) !== '0000'
}

const VIN_VALUES: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9
}
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2]

/** A 17-character VIN with the North American check digit in position 9. */
export function isVinWithCheckDigit(raw: string): boolean {
  const v = raw.toUpperCase()
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return false
  let sum = 0
  for (let i = 0; i < 17; i++) {
    const ch = v[i]
    const value = /\d/.test(ch) ? Number(ch) : VIN_VALUES[ch]
    if (value === undefined) return false
    sum += value * VIN_WEIGHTS[i]
  }
  const check = sum % 11
  return v[8] === (check === 10 ? 'X' : String(check))
}

/** A JSON Web Token: the first segment decodes to a JSON header. */
export function isJwt(raw: string): boolean {
  const [head] = raw.split('.')
  try {
    const json = Buffer.from(head.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const parsed = JSON.parse(json)
    return Boolean(parsed) && typeof parsed === 'object'
  } catch {
    return false
  }
}

export function isIp(raw: string): boolean {
  return isIPv4(raw) || isIPv6(raw)
}

/** IPv6 candidates must look like an address, not a Postgres cast such as ::date. */
export function isPlausibleIpv6(raw: string): boolean {
  if (!isIPv6(raw)) return false
  const groups = raw.split(':').filter(Boolean)
  return groups.length >= 3 || (raw.includes('::') && groups.length >= 2)
}

/** A 15-digit IMEI with a valid Luhn check digit. */
export function isImei(raw: string): boolean {
  const d = digitsOf(raw)
  return d.length === 15 && luhn(d)
}

/** US NPI: ten digits, Luhn over "80840" + the number. */
export function isNpi(raw: string): boolean {
  const d = digitsOf(raw)
  return d.length === 10 && /^[12]/.test(d) && luhn(`80840${d}`)
}
