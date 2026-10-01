// Answers in words: rendered as markdown, safely, and kept whole however long they run.
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatMarkdown } from '../src/renderer/src/components/ChatMarkdown'
import { askDatabase } from '../src/main/ai/nl2sql'
import { SchemaIndex } from '../src/main/ai/schema-index'
import { ModelGateway } from '../src/main/privacy/gateway'
import type { SchemaInfo } from '../src/shared/types'
import { recordingProvider, reply } from './privacy/helpers'

function html(text: string): string {
  return renderToStaticMarkup(createElement(ChatMarkdown, { text, dialect: 'postgres' }))
}

describe('answers as markdown', () => {
  it('renders headings, lists, emphasis, links and tables', () => {
    const out = html(
      [
        '## Setting up the client',
        '',
        'Install it with **npm**, then call `createClient()`:',
        '',
        '1. Add the package',
        '2. Read the [docs](https://context7.com/docs)',
        '',
        '- [x] done',
        '',
        '| Option | Default |',
        '| --- | --- |',
        '| `retries` | 3 |'
      ].join('\n')
    )
    expect(out).toContain('<h2>Setting up the client</h2>')
    expect(out).toContain('<strong>npm</strong>')
    expect(out).toContain('<code class="md-code">createClient()</code>')
    expect(out).toMatch(/<ol>\s*<li>Add the package<\/li>/)
    expect(out).toContain('<a href="https://context7.com/docs" title="https://context7.com/docs">docs</a>')
    expect(out).toContain('type="checkbox"')
    expect(out).toMatch(/<div class="md-table"><table>.*<th>Option<\/th>.*<td><code class="md-code">retries<\/code><\/td>/s)
  })

  it('highlights SQL fences like the editor, and shows other code as it is', () => {
    const out = html('```sql\nSELECT id FROM users WHERE email = \'a@b.io\'\n```\n\n```js\nconst x = a < b && c\n```')
    expect(out).toMatch(/<pre class="chat-sql"><span class="[^"]+">SELECT<\/span>/)
    expect(out).toContain('<pre class="chat-code" data-language="js">const x = a &lt; b &amp;&amp; c</pre>')
  })

  it('never turns a reply into markup, runs scripts or fetches images', () => {
    const out = html('Hi <script>alert(1)</script> <img src="https://evil.example/x.png" onerror="alert(2)">\n\n[click](javascript:alert(3)) ![logo](https://evil.example/logo.png)')
    // HTML in a reply is shown as text, not made into elements or attributes.
    expect(out).not.toMatch(/<script|<img|\sonerror="/i)
    expect(out).toContain('Hi &lt;script&gt;alert(1)&lt;/script&gt;')
    // A script link is emptied, and a remote image becomes its description.
    expect(out).toContain('<a href="" title="">click</a>')
    expect(out).toContain('[image: logo]')
  })
})

describe('answers in words', () => {
  const schema: SchemaInfo = {
    kind: 'sqlite',
    tables: [{ name: 'users', type: 'table', sql: null, columns: [{ cid: 0, name: 'id', type: 'INTEGER', notnull: false, dflt: null, pk: 1, hidden: 0 }], withoutRowid: false, rowidAlias: 'rowid', pk: ['id'] }],
    views: [],
    indexes: [],
    triggers: [],
    relations: []
  }
  const ask = (text: string, stopReason: string) =>
    askDatabase(
      {
        kind: 'sqlite',
        serverVersion: '3.45.1',
        index: SchemaIndex.fromSchema(schema, 'sqlite'),
        provider: ModelGateway.unprotected(
          recordingProvider(() => reply({ text, stopReason })),
          'privacy-off',
          'test.invalid'
        ),
        settings: { sendSampleValues: false, autoRun: true, schemaBudgetTokens: 8000 },
        runQuery: async () => ({ results: [], durationMs: 0, tx: false }),
        distinctValues: async () => null
      },
      'How do I configure retries in the client library?'
    )

  it('keeps a long answer whole', async () => {
    const long = `## Retries\n\n${'Each request is retried with backoff. '.repeat(120)}The end.`
    const result = await ask(long, 'end_turn')
    expect(result).toMatchObject({ kind: 'clarify', message: long })
    expect(result.kind === 'clarify' && result.cutShort).toBeFalsy()
  })

  it('says when the model stopped at its length limit', async () => {
    expect(await ask('## Retries\n\nEach request is', 'max_tokens')).toMatchObject({ kind: 'clarify', cutShort: true })
    expect(await ask('Each request is', 'length')).toMatchObject({ kind: 'clarify', cutShort: true })
  })
})
