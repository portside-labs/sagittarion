// Protection runs in the main process before every request, so it has to stay fast on big schemas and must not be
// stalled by hostile input (catastrophic regex backtracking). The bounds are generous; they catch regressions, not
// milliseconds.
import { describe, expect, it } from 'vitest'
import { PiiVault } from '../../src/main/privacy/vault'
import { engine, policy } from './helpers'

async function timed(text: string, role: 'prose' | 'structured' = 'prose'): Promise<number> {
  const e = engine()
  const start = performance.now()
  await e.protectAll([{ text, ctx: { role } }], new PiiVault(), policy)
  await e.verify([{ text, ctx: { role }, where: 'the test', origin: 'local' }], new PiiVault(), policy)
  return performance.now() - start
}

describe('protection performance', () => {
  it('handles a 32k-token schema block and a long free-text value quickly', async () => {
    const lines = Array.from({ length: 1200 }, (_, i) => `table_${i}(id int pk, customer_id int fk->customers.id, status text {paid|pending|refunded}, total numeric, created_at timestamp) ~${i}k rows -- table ${i} of the demo`)
    const schema = lines.join('\n')
    expect(schema.length).toBeGreaterThan(120_000)
    expect(await timed(schema, 'structured')).toBeLessThan(2000)
    const prose = Array.from({ length: 400 }, (_, i) => `Customer ${i} Jack Smith (jack${i}@example.com, 555-867-${String(i).padStart(4, '0')}) asked about order ${i}.`).join(' ')
    expect(await timed(prose)).toBeLessThan(4000)
  })

  it('is not stalled by input built to make regexes backtrack', async () => {
    const hostile = [
      '1'.repeat(20_000),
      '1 '.repeat(10_000),
      '1-'.repeat(10_000),
      'a@'.repeat(10_000),
      `${'a'.repeat(10_000)}@${'b.'.repeat(5_000)}`,
      ':'.repeat(20_000),
      'A:'.repeat(10_000),
      '<|PII:'.repeat(5_000),
      `password is ${'x'.repeat(20_000)}`,
      `-----BEGIN PRIVATE KEY-----${'\nAAAA'.repeat(5_000)}`,
      `https://${'a/'.repeat(10_000)}`,
      `lives in ${'Abc '.repeat(5_000)}`,
      `${'Jack '.repeat(5_000)}`,
      `"${'k'.repeat(60)}": "${'v'.repeat(600)}" `.repeat(200),
      `name,email\n${'x,y\n'.repeat(5_000)}`,
      `WHERE a IN (${"'x',".repeat(3_000)}'y')`
    ]
    for (const text of hostile) expect(await timed(text), text.slice(0, 20)).toBeLessThan(1500)
  })
})
