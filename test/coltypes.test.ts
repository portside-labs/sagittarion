import { describe, expect, it } from 'vitest'
import { classifyType } from '../src/shared/coltypes'

describe('column type glyphs', () => {
  it('maps SQLite and Postgres type names onto short glyphs', () => {
    const f = (t: string) => classifyType(t)?.family
    expect(f('INTEGER')).toBe('int')
    expect(f('bigint')).toBe('int')
    expect(f('serial')).toBe('int')
    expect(f('REAL')).toBe('float')
    expect(f('numeric(12,2)')).toBe('float')
    expect(f('double precision')).toBe('float')
    expect(f('TEXT')).toBe('text')
    expect(f('character varying(255)')).toBe('text')
    expect(f('boolean')).toBe('bool')
    expect(f('timestamp without time zone')).toBe('datetime')
    expect(f('timestamptz')).toBe('datetime')
    expect(f('date')).toBe('date')
    expect(f('time with time zone')).toBe('time')
    expect(f('interval')).toBe('time')
    expect(f('jsonb')).toBe('json')
    expect(f('bytea')).toBe('blob')
    expect(f('BLOB')).toBe('blob')
    expect(f('uuid')).toBe('uuid')
    expect(f('integer[]')).toBe('array')
    expect(f('_text')).toBe('array')
    expect(f('tsvector')).toBe('other')
    expect(classifyType('')).toBeNull()
    expect(classifyType(undefined)).toBeNull()
  })

  it('keeps the full name for the tooltip and uses icons for dates and times', () => {
    const ts = classifyType('timestamp without time zone')!
    expect(ts.label).toBe('timestamp without time zone')
    expect(ts.icon).toBe('calendar')
    expect(ts.glyph).toBe('')
    expect(classifyType('time')!.icon).toBe('clock')
    expect(classifyType('INTEGER')!.glyph).toBe('#')
    expect(classifyType('jsonb')!.glyph).toBe('{}')
  })
})
