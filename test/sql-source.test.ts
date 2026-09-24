import { describe, expect, it } from 'vitest'
import { editableSource } from '../src/renderer/src/lib/sql-source'

describe('editableSource', () => {
  it('finds the one table of a plain select, with or without a schema, alias, filters or a semicolon', () => {
    expect(editableSource('select * from phone_numbers where shop_id = 1;')).toEqual({ name: 'phone_numbers' })
    expect(editableSource('SELECT id, name\nFROM public.users u WHERE u.id > 3 ORDER BY id LIMIT 5')).toEqual({ schema: 'public', name: 'users' })
    expect(editableSource('select * from "Weird Name" as w')).toEqual({ name: 'Weird Name' })
    expect(editableSource('-- note\nselect id from users /* all */')).toEqual({ name: 'users' })
  })

  it('refuses anything whose rows do not map back to one table', () => {
    for (const sql of [
      'select count(*) from users',
      'select distinct name from users',
      'select u.id, o.total from users u join orders o on o.user_id = u.id',
      'select * from users, orders',
      'select name from users group by name',
      'select * from users union select * from admins',
      'select * from (select * from users) t',
      'with u as (select * from users) select * from u',
      'update users set name = 1',
      'select id, upper(name) from users'
    ]) {
      expect(editableSource(sql), sql).toBeNull()
    }
  })
})
