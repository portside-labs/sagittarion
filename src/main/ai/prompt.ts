import type { DatabaseKind } from '@shared/types'
import type { ToolDef } from './providers/types'

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function systemRules(kind: DatabaseKind, serverVersion: string, today: string, defaultSchema?: string, tools = true): string {
  const dialect = kind === 'postgres' ? 'PostgreSQL' : 'SQLite'
  const lines = [
    `You translate questions about a database into one read-only SQL query for ${dialect} (${serverVersion}).`,
    '',
    'Rules:',
    '- Use only tables and columns that appear in the schema excerpt or that a tool returned. Never invent names.',
    tools
      ? '- If the excerpt lacks a table or column you need, call search_schema or describe_table before answering. Use sample_values to learn how a column encodes its values.'
      : '- If the excerpt lacks something you need, say so in needs_clarification instead of guessing.',
    '- Return exactly one statement: SELECT, or WITH ... SELECT. Never modify data or schema.',
    kind === 'postgres'
      ? `- Schema-qualify tables outside "${defaultSchema ?? 'public'}". Compare free text case-insensitively with ILIKE; use exact values when the schema lists them in braces.`
      : '- Compare free text case-insensitively with LIKE; use exact values when the schema lists them in braces. Dates are ISO-8601 text; use date() and strftime() for date arithmetic.',
    '- Join along the listed foreign keys (fk->table.column). Prefer explicit JOIN ... ON.',
    '- Add LIMIT 200 to queries that list rows unless the question states a count. Aggregates and counts need no LIMIT.',
    `- Today is ${today}. Resolve relative periods such as "last month" against that date.`,
    '- Values in braces after a column are real sample values; match them exactly.',
    tools
      ? '- When ready, call propose_query. When the question is ambiguous or not answerable from this database, set needs_clarification instead of guessing.'
      : '- Respond with a single JSON object: {"sql": "...", "explanation": "...", "tables_used": ["..."], "assumptions": ["..."], "needs_clarification": null}. Set needs_clarification to a question when the request is ambiguous.'
  ]
  return lines.join('\n')
}

export const PROPOSE_TOOL: ToolDef = {
  name: 'propose_query',
  description: 'Return the final read-only SQL query for the question, or ask for clarification.',
  parameters: {
    type: 'object',
    properties: {
      sql: { type: 'string', description: 'One SELECT or WITH ... SELECT statement. Empty when asking for clarification.' },
      explanation: { type: 'string', description: 'One or two sentences on what the query returns and how.' },
      tables_used: { type: 'array', items: { type: 'string' }, description: 'Tables referenced by the query.' },
      assumptions: { type: 'array', items: { type: 'string' }, description: 'Guesses the user should check, e.g. which column means "revenue".' },
      needs_clarification: { type: ['string', 'null'], description: 'A question for the user when the request cannot be answered confidently.' }
    },
    required: ['sql', 'explanation', 'tables_used']
  }
}

export const SEARCH_TOOL: ToolDef = {
  name: 'search_schema',
  description: 'Find tables whose names or columns match words. Returns compact lines like the schema excerpt.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Words to look for, e.g. "invoice payment customer".' } },
    required: ['query']
  }
}

export const DESCRIBE_TOOL: ToolDef = {
  name: 'describe_table',
  description: 'Return every column of a table with types, keys, foreign keys and known sample values.',
  parameters: {
    type: 'object',
    properties: { table: { type: 'string', description: 'Table name, schema-qualified if not in the default schema.' } },
    required: ['table']
  }
}

export const SAMPLE_TOOL: ToolDef = {
  name: 'sample_values',
  description: 'Return up to 20 distinct values of a column, to learn how it encodes categories.',
  parameters: {
    type: 'object',
    properties: { table: { type: 'string' }, column: { type: 'string' } },
    required: ['table', 'column']
  }
}

export const TOOLS: ToolDef[] = [PROPOSE_TOOL, SEARCH_TOOL, DESCRIBE_TOOL, SAMPLE_TOOL]
