import { describe, expect, it } from 'vitest'
import { blockAt } from '../src/renderer/src/lib/sql-block'

const script = 'select *\nfrom phone_numbers\nwhere shop_id = 1;\n\nselect *\nfrom operating_hours\nwhere shop_id = 1'

describe('blockAt', () => {
  it('returns the contiguous lines around the cursor, blank lines dividing blocks', () => {
    expect(blockAt(script, 0)).toBe('select *\nfrom phone_numbers\nwhere shop_id = 1;')
    expect(blockAt(script, script.length)).toBe('select *\nfrom operating_hours\nwhere shop_id = 1')
    expect(blockAt(script, script.indexOf('operating'))).toBe('select *\nfrom operating_hours\nwhere shop_id = 1')
  })

  it('takes the block above from a blank line, or below when nothing is above', () => {
    const blank = script.indexOf('\n\n') + 1
    expect(blockAt(script, blank)).toBe('select *\nfrom phone_numbers\nwhere shop_id = 1;')
    expect(blockAt('\n\nselect 1', 0)).toBe('select 1')
    expect(blockAt('  \n\n', 1)).toBe('')
  })

  it('treats a script without blank lines as one block', () => {
    expect(blockAt('select 1;\nselect 2;', 3)).toBe('select 1;\nselect 2;')
  })
})
