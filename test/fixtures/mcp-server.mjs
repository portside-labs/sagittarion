// A small MCP server for tests, spoken to over stdio: a read-only lookup, a tool that changes something, one that
// fails, and one that reports what it was started with.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'sagittarion-test-crm', version: '1.2.0' })

server.registerTool(
  'lookup_customer',
  {
    title: 'Look up a customer',
    description: 'Find a customer in the CRM by email address.',
    inputSchema: { email: z.string().describe('The customer email address') },
    // Structured output too, so a client checks it against this schema.
    outputSchema: { email: z.string(), plan: z.string() },
    annotations: { readOnlyHint: true }
  },
  async ({ email }) => ({
    content: [{ type: 'text', text: `Customer ${email}: plan Pro, account manager Shiloh Romo (shiloh.romo@crm.example), since 2021.` }],
    structuredContent: { email, plan: 'Pro' }
  })
)

server.registerTool(
  'flag_account',
  {
    title: 'Flag an account',
    description: 'Flag a customer account for review by the account manager.',
    inputSchema: { email: z.string(), reason: z.string() },
    annotations: { destructiveHint: false }
  },
  async ({ email, reason }) => ({ content: [{ type: 'text', text: `Flagged ${email} for review: ${reason}` }] })
)

server.registerTool('broken', { description: 'Always fails.' }, async () => ({ isError: true, content: [{ type: 'text', text: 'The CRM is down for maintenance.' }] }))

server.registerTool(
  'env',
  { description: 'Report an environment variable the server was started with.', inputSchema: { name: z.string() }, annotations: { readOnlyHint: true } },
  async ({ name }) => ({ content: [{ type: 'text', text: process.env[name] ?? '(unset)' }] })
)

await server.connect(new StdioServerTransport())
