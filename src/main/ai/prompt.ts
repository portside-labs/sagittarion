import type { DatabaseKind } from '@shared/types'
import type { ToolDef } from './providers/types'

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function systemRules(kind: DatabaseKind, serverVersion: string, today: string, defaultSchema?: string, tools = true, connectors = false): string {
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
  if (connectors) {
    lines.push(
      '- Tools whose names start with mcp__ come from connectors the user linked: other systems, such as an issue tracker or a CRM. Use them when the question needs something the database does not hold, then write the query as usual. If a connector alone answers the question, reply in plain text instead of calling propose_query.'
    )
  }
  return lines.join('\n')
}

/**
 * The user's own instructions for this database. They come after the fixed rules, which win where the two disagree:
 * an instruction cannot make the query write, or name a table the schema does not have. In a chat across databases,
 * one written for some of them names their keys.
 */
export function instructionsPrompt(list: { name: string; text: string; databases?: string[] }[], across = false): string {
  const lines = [
    '## Instructions from the user',
    across
      ? 'The user wrote these. Follow them, unless one asks for something the rules above forbid. One marked "only for" applies to queries on those databases alone.'
      : 'The user wrote these for questions on this database. Follow them, unless one asks for something the rules above forbid.'
  ]
  for (const i of list) {
    const only = across && i.databases?.length ? ` (only for ${i.databases.map((k) => `"${k}"`).join(', ')})` : ''
    lines.push('', `### ${i.name.trim() || 'Instruction'}${only}`, i.text.trim())
  }
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

// ---------------------------------------------------------------------------
// Across several databases: a chat that has more than one in context
// ---------------------------------------------------------------------------

/** Rows of a query's result the model sees: enough to follow a trail, not a dump. */
export const RESULT_ROWS = 50
/** About 3,000 tokens of them at most: wide rows show fewer. */
export const RESULT_CHARS = 12_000

export interface PromptDatabase {
  /** What the model calls it in tools. */
  key: string
  name: string
  kind: DatabaseKind
  serverVersion: string
  defaultSchema?: string
}

function dialectName(kind: DatabaseKind): string {
  return kind === 'postgres' ? 'PostgreSQL' : 'SQLite'
}

export function acrossRules(dbs: PromptDatabase[], today: string, opts: { tools: boolean; readResults: boolean; connectors: boolean }): string {
  const lines = [
    'You answer questions across several databases at once, often for someone tracing what happened: when, where and how records changed.',
    '',
    'Databases, by the key that tools take:',
    ...dbs.map((d) => `- "${d.key}": ${d.name}, ${dialectName(d.kind)} ${d.serverVersion}${d.kind === 'postgres' && d.defaultSchema ? ` (default schema "${d.defaultSchema}")` : ''}`),
    '',
    'Rules:',
    '- Each schema excerpt below belongs to one database. A query uses only the tables and columns of its own database. Never invent names.',
    opts.tools
      ? '- Every tool takes the database key. Call search_schema or describe_table when an excerpt lacks what you need, and sample_values to learn how a column encodes its values.'
      : '- If an excerpt lacks something you need, say so in needs_clarification instead of guessing.',
    opts.tools && opts.readResults
      ? `- To look at data, call run_query with one read-only SELECT (or WITH ... SELECT) for one database; you get back up to ${RESULT_ROWS} rows. Use what one database shows to query the next: the same id, order, account or time window.`
      : '- You cannot see query results: write the queries that would answer the question.',
    '- Values can be placeholders such as <|PII:EMAIL:3F2A9C|>. The same value has the same placeholder in every database, so use them to match records across databases, and copy them exactly, including the <| and |>, into SQL.',
    '- Write each query in its database\'s dialect. PostgreSQL: ILIKE for free text, schema-qualify tables outside the default schema. SQLite: LIKE for free text; dates are ISO-8601 text, compared and shifted with date() and strftime().',
    '- Every query is read-only: one SELECT, or WITH ... SELECT. Never modify data or schema.',
    '- Join along the listed foreign keys (fk->table.column) within a database. Databases cannot be joined in SQL: query each, then connect what they return.',
    '- Add LIMIT 200 to queries that list rows unless the question states a count. Select only the columns you need.',
    `- Today is ${today}. Resolve relative periods such as "yesterday" or "last week" against that date.`,
    '- Values in braces after a column are real sample values; match them exactly.',
    opts.tools
      ? opts.readResults
        ? '- When the user wants to know what happened, answer in plain text (markdown): a short timeline or trace naming the database, the time and the records at each step. Do not paste whole result tables. When they want a query to run, call propose_query with the database key.'
        : '- When ready, call propose_query with the database key. When the question is ambiguous, set needs_clarification instead of guessing.'
      : '- Respond with a single JSON object: {"database": "key", "sql": "...", "explanation": "...", "tables_used": ["..."], "assumptions": ["..."], "needs_clarification": null}.'
  ]
  if (opts.connectors) {
    lines.push(
      '- Tools whose names start with mcp__ come from connectors the user linked: other systems, such as an issue tracker or a CRM. Use them when the question needs something the databases do not hold.'
    )
  }
  return lines.join('\n')
}

/** The tools of a chat across databases: the same ones, each with the database it is for; and run_query to read data. */
export function acrossTools(keys: string[], readResults: boolean): ToolDef[] {
  const database = { type: 'string', enum: keys, description: 'The database, by its key.' }
  const withDatabase = (t: ToolDef, description: string): ToolDef => {
    const params = t.parameters as { properties: Record<string, unknown>; required: string[] }
    return { name: t.name, description, parameters: { type: 'object', properties: { database, ...params.properties }, required: ['database', ...params.required] } }
  }
  const tools = [
    withDatabase(PROPOSE_TOOL, 'Return a final read-only SQL query for one database, or ask for clarification.'),
    withDatabase(SEARCH_TOOL, 'Find tables in one database whose names or columns match words.'),
    withDatabase(DESCRIBE_TOOL, 'Return every column of a table in one database, with types, keys, foreign keys and known sample values.'),
    withDatabase(SAMPLE_TOOL, 'Return up to 20 distinct values of a column in one database.')
  ]
  if (readResults) {
    tools.push({
      name: 'run_query',
      description: `Run one read-only SELECT on a database and see up to ${RESULT_ROWS} rows. Protected values appear as placeholders, the same in every database.`,
      parameters: {
        type: 'object',
        properties: {
          database,
          sql: { type: 'string', description: 'One SELECT or WITH ... SELECT statement in the database\'s dialect.' },
          purpose: { type: 'string', description: 'What you are looking for, in a few words, e.g. "orders placed by the customer".' }
        },
        required: ['database', 'sql']
      }
    })
  }
  return tools
}
