// Column types collapsed into a handful of families, so grids can show a
// glyph instead of "timestamp without time zone".

export type TypeFamily = 'int' | 'float' | 'text' | 'bool' | 'date' | 'time' | 'datetime' | 'json' | 'blob' | 'uuid' | 'array' | 'other'

export interface TypeGlyph {
  family: TypeFamily
  /** One to three characters, or empty when an icon is used instead. */
  glyph: string
  /** Icon name for families drawn as an icon. */
  icon?: 'calendar' | 'clock'
  label: string
}

const RULES: [TypeFamily, RegExp][] = [
  ['array', /\[\]$|^_|^array\b/],
  ['bool', /^bool/],
  ['int', /^(big|small|tiny|medium)?int(eger)?\d*$|^(big|small)?serial\d*$|^int[248]$|^oid$|^unsigned big int$/],
  ['float', /^(double( precision)?|float\d*|real|numeric|decimal|money|number|dec)\b/],
  ['datetime', /^timestamp|^datetime/],
  ['date', /^date$/],
  ['time', /^time\b|^interval/],
  ['json', /json/],
  ['blob', /^(blob|bytea|binary|varbinary|longblob|mediumblob|tinyblob|raw)\b/],
  ['uuid', /^uuid|^guid/],
  ['text', /char|text|clob|citext|string|^name$|^xml$|^enum|^varying/]
]

const GLYPHS: Record<TypeFamily, Omit<TypeGlyph, 'family' | 'label'>> = {
  int: { glyph: '#' },
  float: { glyph: '1.5' },
  text: { glyph: 'Aa' },
  bool: { glyph: 'T/F' },
  date: { glyph: '', icon: 'calendar' },
  time: { glyph: '', icon: 'clock' },
  datetime: { glyph: '', icon: 'calendar' },
  json: { glyph: '{}' },
  blob: { glyph: '01' },
  uuid: { glyph: 'id' },
  array: { glyph: '[]' },
  other: { glyph: '?' }
}

export function classifyType(declType: string | null | undefined): TypeGlyph | null {
  const raw = (declType ?? '').trim()
  if (!raw) return null
  const t = raw.toLowerCase().replace(/\s+/g, ' ')
  let family: TypeFamily = 'other'
  for (const [f, re] of RULES) {
    if (re.test(t)) {
      family = f
      break
    }
  }
  return { family, ...GLYPHS[family], label: raw }
}
