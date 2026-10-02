// Tool definitions, as a connector such as Atlassian's describes its tools: example site addresses, ids and @mentions
// in the words, sometimes the user's own. They are protected like the rest of a request rather than stopping it, and
// what the model needs to call a tool (its name, property names, patterns, allowed values) stays as it is.
import { describe, expect, it } from 'vitest'
import { ModelGateway } from '../../src/main/privacy/gateway'
import { PrivacyEngine } from '../../src/main/privacy/engine'
import { PrivacySession } from '../../src/main/privacy/session'
import { PiiVault } from '../../src/main/privacy/vault'
import type { ToolDef } from '../../src/main/ai/providers/types'
import { placeholders, policy, recordingProvider, reply, wireText } from './helpers'

const connectorTool = (): ToolDef => ({
  name: 'mcp__atlassian__getConfluencePage',
  description:
    'Get a Confluence page by id. Pass the cloudId from getAccessibleAtlassianResources, such as 1324a887-45db-1bf4-1e99-ef0ff456d421, or the site URL, such as https://your-domain.atlassian.net. Mention people as @jsmith. Pages owned by ann@corp.io are shared.',
  parameters: {
    type: 'object',
    properties: {
      cloudId: { type: 'string', description: 'The site, e.g. 1324a887-45db-1bf4-1e99-ef0ff456d421' },
      pageId: { type: 'string', pattern: '^[0-9]+$', description: 'The page id.' },
      bodyFormat: { type: 'string', enum: ['storage', 'atlas_doc_format'] },
      author: { type: 'string', description: 'username: jsmith' }
    },
    required: ['cloudId', 'pageId']
  }
})

describe('tool definitions', () => {
  it('are protected like the rest of the request instead of stopping it, with what the model calls by left as it is', async () => {
    const provider = recordingProvider(() => reply({ text: 'ok' }))
    const session = new PrivacySession({ engine: new PrivacyEngine({ schemaDetection: true }), policy, vault: new PiiVault(), host: 'api.example.com' })
    const gateway = ModelGateway.protected(provider, session)
    const tools = [connectorTool()]
    const before = JSON.stringify(tools)

    await gateway.complete({ system: [{ text: 'Rules.', structured: true }], messages: [{ role: 'user', content: 'What did ann@corp.io write last week?' }], tools })

    const sent = provider.requests[0]
    const tool = sent.tools![0]
    const words = wireText(sent.tools)
    // The example ids, the site's address and the @mention go as placeholders.
    expect(words).not.toMatch(/1324a887-45db|your-domain\.atlassian\.net|@jsmith|username: jsmith|ann@corp\.io/)
    expect(placeholders(tool.description).length).toBeGreaterThanOrEqual(3)
    // The same person in the question and in a description has the same placeholder in both.
    const asked = placeholders(String(sent.messages[0].content))[0]
    expect(tool.description).toContain(asked)
    // What the model needs to call the tool stays: its name, property names, patterns, allowed values, required list.
    expect(tool.name).toBe('mcp__atlassian__getConfluencePage')
    const params = tool.parameters as any
    expect(Object.keys(params.properties)).toEqual(['cloudId', 'pageId', 'bodyFormat', 'author'])
    expect(params.properties.pageId.pattern).toBe('^[0-9]+$')
    expect(params.properties.bodyFormat.enum).toEqual(['storage', 'atlas_doc_format'])
    expect(params.required).toEqual(['cloudId', 'pageId'])
    // The connector's own definitions, kept for the next request, are untouched.
    expect(JSON.stringify(tools)).toBe(before)
    // What was protected there is counted where it was.
    expect(session.report().counts.EMAIL_ADDRESS).toBe(1)
  })
})
