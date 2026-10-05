import type { DatabaseKind } from '@shared/types'
import type { ToolDef } from './providers/types'

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Rows of a query's result the model sees: enough to follow a trail, not a dump. */
export const RESULT_ROWS = 50
/** About 3,000 tokens of them at most: wide rows show fewer. */
export const RESULT_CHARS = 12_000

/**
 * Finding things out before asking, for every chat: the model looks names and dates up, asks only when it cannot find
 * out, and says what it assumed.
 */
function lookFirst(opts: { readResults: boolean; connectors: boolean }): string[] {
  const where = [opts.readResults ? 'the data (run_query)' : 'the schema and its sample values', opts.connectors ? "the user's connected tools (the mcp__ tools)" : '']
    .filter(Boolean)
    .join(' and ')
  return [
    `- Find things out before you ask: look up names, ids and codes in ${where}, and resolve dates such as "October" or "last week" against today.`,
    '- Ask only when you cannot find out, or when two answers are equally likely; then say what you found and which you would use. Otherwise make the reasonable choice and say briefly what you assumed.'
  ]
}

/**
 * Business knowledge: the model reads the question in the business's terms, relies on what is known as far as its
 * source allows, and keeps what it learns without asking, in replies it sends anyway.
 */
function knowledgeLines(opts: { readResults: boolean }): string[] {
  return [
    '- People ask in their business\'s words. Read the question against "What this team means" first, when there is one: a term there means what it says here, and a runbook query that fits is where the answer starts.',
    opts.readResults
      ? '- When a runbook query answers the question, run it with run_saved_query instead of writing a new one; adapt its SQL when the question differs.'
      : '- When a runbook query answers the question, use its SQL with the values filled in instead of writing a new one; adapt it when the question differs.',
    '- What the user told you is settled; what was checked in the data is reliable; what is unchecked is a working guess, to check in the data only when the answer turns on it. Never ask the user to confirm something you know or can look up: say in a few words what you took their words to mean, so they can correct you.',
    '- Keep what you learn, without asking: call learn for what a business word means here, a rule the user tells you, a correction, or which tables make up a part of the business; call save_query for a query that answers a business question likely to come again. Call them in the same reply as your answer or your other tool calls, never on their own. Keep what helps with later questions, not one-off details.'
  ]
}

/** Requests cost the user money: the model is told how many it has, and how to need fewer. */
function budgetLine(maxRequests: number): string {
  return `- You have at most ${maxRequests} requests to the model for this question, this one included. Use few: call tools that do not depend on each other together, in one reply; get what you need in as few queries as possible (join and aggregate in SQL instead of querying step by step); and answer as soon as you can.`
}

export interface RuleOptions {
  /** Business knowledge is kept for this database: the learn and save_query tools are on. */
  learning?: boolean
  /** The most requests the ask may make. */
  maxRequests?: number
}

export function systemRules(
  kind: DatabaseKind,
  serverVersion: string,
  today: string,
  defaultSchema?: string,
  tools = true,
  connectors = false,
  readResults = false,
  extra: RuleOptions = {}
): string {
  const dialect = kind === 'postgres' ? 'PostgreSQL' : 'SQLite'
  const investigating = tools && readResults
  const lines = [
    investigating
      ? `You answer questions about a ${dialect} (${serverVersion}) database by working them out yourself: run read-only queries, read their results${connectors ? ", look things up in the user's connected tools" : ''}, then answer.`
      : `You translate questions about a database into one read-only SQL query for ${dialect} (${serverVersion}).`,
    '',
    'Rules:',
    '- Use only tables and columns that appear in the schema excerpt or that a tool returned. Never invent names.',
    tools
      ? '- If the excerpt lacks a table or column you need, call search_schema or describe_table before answering. Use sample_values to learn how a column encodes its values.'
      : '- If the excerpt lacks something you need, say so in needs_clarification instead of guessing.',
    ...(investigating
      ? [`- To look at data, call run_query with one read-only SELECT (or WITH ... SELECT); you get up to ${RESULT_ROWS} rows back. Select only the columns you need.`]
      : []),
    investigating ? '- Every query is read-only: one SELECT, or WITH ... SELECT. Never modify data or schema.' : '- Return exactly one statement: SELECT, or WITH ... SELECT. Never modify data or schema.',
    kind === 'postgres'
      ? `- Schema-qualify tables outside "${defaultSchema ?? 'public'}". Compare free text case-insensitively with ILIKE; use exact values when the schema lists them in braces.`
      : '- Compare free text case-insensitively with LIKE; use exact values when the schema lists them in braces. Dates are ISO-8601 text; use date() and strftime() for date arithmetic.',
    '- Join along the listed foreign keys (fk->table.column). Prefer explicit JOIN ... ON.',
    '- Add LIMIT 200 to queries that list rows unless the question states a count. Aggregates and counts need no LIMIT.',
    `- Today is ${today}. Resolve relative periods such as "last month" against that date.`,
    '- Values in braces after a column are real sample values; match them exactly.',
    ...(tools ? lookFirst({ readResults: investigating, connectors }) : []),
    ...(tools && extra.learning ? knowledgeLines({ readResults: investigating }) : []),
    ...(tools && extra.maxRequests ? [budgetLine(extra.maxRequests)] : [])
  ]
  if (investigating) {
    lines.push(
      '- When the user asks how things stand, what happened, or whether something is ready, work through it and answer in plain text (markdown): what you checked and what you found, with the numbers. Do not hand back queries for the user to run instead.',
      '- When the user wants a query to run, or rows to look at in the editor, call propose_query.'
    )
  } else if (tools) {
    lines.push(
      '- You cannot see query results here. When answering needs you to see data, write the query that shows it, and say once that you could check it yourself if the user lets Ask read results on this database.',
      '- When ready, call propose_query. Set needs_clarification only when the question cannot be answered without the user.'
    )
  } else {
    lines.push(
      '- Respond with a single JSON object: {"sql": "...", "explanation": "...", "tables_used": ["..."], "assumptions": ["..."], "needs_clarification": null}. Set needs_clarification to a question only when the request cannot be answered without the user.'
    )
  }
  if (connectors) {
    lines.push(
      investigating
        ? '- Tools whose names start with mcp__ come from connectors the user linked: other systems, such as documents, runbooks, tickets or a CRM. Use them for what the database does not hold, then check what they say against the data.'
        : '- Tools whose names start with mcp__ come from connectors the user linked: other systems, such as an issue tracker or a CRM. Use them when the question needs something the database does not hold, then write the query as usual. If a connector alone answers the question, reply in plain text instead of calling propose_query.'
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
      needs_clarification: { type: ['string', 'null'], description: 'A question for the user when the request cannot be answered confidently.' },
      title: { type: 'string', description: 'Only when asked to name the conversation: its name.' }
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

const QUERY_SQL = { type: 'string', description: "One SELECT or WITH ... SELECT statement in the database's dialect." }
// Tool definitions are checked, not protected, on their way out: their examples must not be values a user might have.
const QUERY_PURPOSE = { type: 'string', description: 'What you are looking for, in a few words, e.g. "orders placed by the customer".' }

export const RUN_QUERY_TOOL: ToolDef = {
  name: 'run_query',
  description: `Run one read-only SELECT and see up to ${RESULT_ROWS} rows of its result. Protected values appear as placeholders.`,
  parameters: { type: 'object', properties: { sql: QUERY_SQL, purpose: QUERY_PURPOSE }, required: ['sql'] }
}

// Learning: kept at once, without a yes from the user, and needing no reply, so they ride along with replies the model
// sends anyway rather than costing requests of their own.
const LEARN_PROPERTIES = {
  kind: {
    type: 'string',
    enum: ['term', 'rule', 'domain'],
    description: 'term: a word or phrase the business uses. rule: a convention the team follows. domain: a part of the business and the tables that hold it.'
  },
  name: { type: 'string', description: 'term: the word or phrase as the business says it. rule: a short title. domain: its name, after the names of any domains above it, joined by " › ".' },
  meaning: { type: 'string', description: 'What it means here, in a sentence or two.' },
  sql: { type: 'string', description: 'term: the SQL condition or expression that picks it out, with table names rather than aliases. Leave out when there is none.' },
  tables: { type: 'array', items: { type: 'string' }, description: 'The tables it involves; for a domain, the tables in it.' },
  aliases: { type: 'array', items: { type: 'string' }, description: 'Other ways the business says it.' },
  source: { type: 'string', enum: ['user', 'data', 'inferred'], description: 'user: the user said so. data: you checked it in the data. inferred: your reading of names, unchecked.' }
}
const LEARN_DESCRIPTION =
  'Keep something you learned about this business for later questions, without asking the user: what a word means here, a rule the team follows, or a part of the business and its tables. Call it again with a correction when the user corrects you. It needs no reply: call it in the same reply as your answer or your other tool calls.'

export const LEARN_TOOL: ToolDef = {
  name: 'learn',
  description: LEARN_DESCRIPTION,
  parameters: { type: 'object', properties: LEARN_PROPERTIES, required: ['kind', 'name', 'meaning', 'source'] }
}

const SAVE_PROPERTIES = {
  name: { type: 'string', description: 'A short name for what it answers, in business terms.' },
  purpose: { type: 'string', description: 'The business question it answers.' },
  sql: { type: 'string', description: 'One read-only SELECT or WITH ... SELECT, with a :name parameter for each value that changes between questions.' },
  params: {
    type: 'array',
    description: 'Its parameters.',
    items: {
      type: 'object',
      properties: { name: { type: 'string' }, description: { type: 'string' }, example: { type: 'string', description: 'Its value in this question.' } },
      required: ['name']
    }
  },
  domain: { type: 'string', description: 'The domain it belongs to, when known.' }
}
const SAVE_DESCRIPTION =
  "Keep a query that answers a business question in this database's runbook, so the same kind of question is answered with it next time. Make the values that change between questions (names, ids, dates) :name parameters. It needs no reply: call it in the same reply as your answer."

export const SAVE_QUERY_TOOL: ToolDef = {
  name: 'save_query',
  description: SAVE_DESCRIPTION,
  parameters: { type: 'object', properties: SAVE_PROPERTIES, required: ['name', 'purpose', 'sql'] }
}

const RUN_SAVED_PROPERTIES = {
  id: { type: 'string', description: 'The runbook id, such as q3.' },
  values: {
    type: 'array',
    description: 'A value for each parameter.',
    items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'] }
  }
}

export const RUN_SAVED_TOOL: ToolDef = {
  name: 'run_saved_query',
  description: `Run a query from the runbook with a value for each of its parameters, and see up to ${RESULT_ROWS} rows of its result.`,
  parameters: { type: 'object', properties: RUN_SAVED_PROPERTIES, required: ['id'] }
}

/** Tools that change nothing the model waits on: answered here, and never worth a request of their own. */
export const KEEPING_TOOLS = new Set(['learn', 'save_query'])

/**
 * The tools of a chat on one database: run_query where the user lets the model read results; learn and save_query
 * where business knowledge is kept, with run_saved_query where results can be read too.
 */
export function singleTools(readResults: boolean, learning = false): ToolDef[] {
  return [...TOOLS, ...(readResults ? [RUN_QUERY_TOOL] : []), ...(learning ? [LEARN_TOOL, SAVE_QUERY_TOOL, ...(readResults ? [RUN_SAVED_TOOL] : [])] : [])]
}

/** Asked of the first question of a conversation, so its name comes with the answer rather than in a request of its own. */
export const TITLE_REQUEST =
  '\n\n(This question starts a new conversation. Name it for a small tab too: two to four words in Title Case, naming the subject. Give the name in propose_query\'s title, or, in a reply in words, alone on its first line as "Title: …".)'

/** Said with the last request of an ask, so the model answers with what it has instead of looking further. */
export const LAST_REQUEST = '(That was the last lookup this question can have: answer now, with what you found.)'

// ---------------------------------------------------------------------------
// Across several databases: a chat that has more than one in context
// ---------------------------------------------------------------------------

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

/** `readable`: the keys of the databases whose results the model may read. */
export function acrossRules(dbs: PromptDatabase[], today: string, opts: { tools: boolean; readable: string[]; connectors: boolean } & RuleOptions): string {
  const reading = opts.tools && opts.readable.length > 0
  const some = reading && opts.readable.length < dbs.length
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
    reading
      ? `- To look at data, call run_query with one read-only SELECT (or WITH ... SELECT) for one database; you get back up to ${RESULT_ROWS} rows. Use what one database shows to query the next: the same id, order, account or time window.${some ? ` You can read results from ${opts.readable.map((k) => `"${k}"`).join(', ')} only; for the others, write the queries.` : ''}`
      : '- You cannot see query results: write the queries that would answer the question, and say once that you could check them yourself if the user lets Ask read results on these databases.',
    '- Values can be placeholders such as <|PII:EMAIL:3F2A9C|>. The same value has the same placeholder in every database, so use them to match records across databases, and copy them exactly, including the <| and |>, into SQL.',
    '- Write each query in its database\'s dialect. PostgreSQL: ILIKE for free text, schema-qualify tables outside the default schema. SQLite: LIKE for free text; dates are ISO-8601 text, compared and shifted with date() and strftime().',
    '- Every query is read-only: one SELECT, or WITH ... SELECT. Never modify data or schema.',
    '- Join along the listed foreign keys (fk->table.column) within a database. Databases cannot be joined in SQL: query each, then connect what they return.',
    '- Add LIMIT 200 to queries that list rows unless the question states a count. Select only the columns you need.',
    `- Today is ${today}. Resolve relative periods such as "yesterday" or "last week" against that date.`,
    '- Values in braces after a column are real sample values; match them exactly.',
    ...(opts.tools ? lookFirst({ readResults: reading, connectors: opts.connectors }) : []),
    ...(opts.tools && opts.learning ? knowledgeLines({ readResults: reading }) : []),
    ...(opts.tools && opts.maxRequests ? [budgetLine(opts.maxRequests)] : []),
    opts.tools
      ? reading
        ? '- When the user asks what happened, how things stand or whether something is ready, work through it and answer in plain text (markdown): for a trace, a short timeline naming the database, the time and the records at each step. Do not paste whole result tables, or hand back queries for the user to run instead. When they want a query to run, call propose_query with the database key.'
        : '- When ready, call propose_query with the database key. Set needs_clarification only when the question cannot be answered without the user.'
      : '- Respond with a single JSON object: {"database": "key", "sql": "...", "explanation": "...", "tables_used": ["..."], "assumptions": ["..."], "needs_clarification": null}.'
  ]
  if (opts.connectors) {
    lines.push(
      '- Tools whose names start with mcp__ come from connectors the user linked: other systems, such as an issue tracker or a CRM. Use them when the question needs something the databases do not hold.'
    )
  }
  return lines.join('\n')
}

/**
 * The tools of a chat across databases: the same ones, each with the database it is for; run_query to read data on
 * those in `readable`; and, where business knowledge is kept, learn and save_query for one database, with
 * run_saved_query on those whose results can be read.
 */
export function acrossTools(keys: string[], readable: string[], learning = false): ToolDef[] {
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
  if (readable.length) {
    tools.push({
      name: 'run_query',
      description: `Run one read-only SELECT on a database and see up to ${RESULT_ROWS} rows. Protected values appear as placeholders, the same in every database.`,
      parameters: {
        type: 'object',
        properties: { database: { ...database, enum: readable }, sql: QUERY_SQL, purpose: QUERY_PURPOSE },
        required: ['database', 'sql']
      }
    })
  }
  if (learning) {
    tools.push(
      withDatabase(LEARN_TOOL, LEARN_DESCRIPTION.replace('about this business', 'about the business behind one database')),
      withDatabase(SAVE_QUERY_TOOL, SAVE_DESCRIPTION.replace("this database's runbook", "one database's runbook"))
    )
    if (readable.length) {
      const run = withDatabase(RUN_SAVED_TOOL, `Run a query from one database's runbook with a value for each of its parameters, and see up to ${RESULT_ROWS} rows.`)
      ;(run.parameters as any).properties.database = { ...database, enum: readable }
      tools.push(run)
    }
  }
  return tools
}
