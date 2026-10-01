// Connectors: MCP servers whose tools the Ask chat can use, as connectors do in Claude Desktop. A connector is on for
// every database connection or only for the ones chosen; a chat can still switch one off, or on where it is not
// automatic. Each of its tools runs freely, after the user approves it, or never.

export type ConnectorTransport = 'stdio' | 'http'
export type ConnectorScope = 'all' | 'selected'
export type ToolPermission = 'allow' | 'ask' | 'never'

/**
 * A connector as the renderer edits it. Secret values (environment variables, headers) never come back from the main
 * process, so a key whose value is null keeps the value saved for it.
 */
export interface ConnectorInput {
  /** Empty for a new connector. */
  id: string
  name: string
  enabled: boolean
  transport: ConnectorTransport
  /** A local command and its arguments, run with the user's login shell PATH. */
  command: string
  args: string[]
  env: Record<string, string | null>
  /** A remote server's address, spoken to over Streamable HTTP (or SSE, for older servers). */
  url: string
  headers: Record<string, string | null>
  /**
   * For a remote server that signs in with OAuth but cannot register apps itself: the client ID (and secret, a secret
   * like the headers) the user registered with it. Empty for the usual case, where Sagittarion registers itself.
   */
  oauthClientId: string
  oauthClientSecret: string | null
  scope: ConnectorScope
  /** The saved database connections it is on for, when scope is "selected". */
  connectionIds: string[]
}

/** `signin`: the server wants the user to sign in (OAuth); `authorizing`: waiting for them to, in their browser. */
export type ConnectorState = 'off' | 'idle' | 'connecting' | 'connected' | 'error' | 'signin' | 'authorizing'

export interface ConnectorTool {
  /** The tool's name on its server. */
  name: string
  title?: string
  description?: string
  /** The server says the tool only reads (MCP's readOnlyHint). */
  readOnly: boolean
  /** The server says the tool may destroy or overwrite something (MCP's destructiveHint). */
  destructive: boolean
}

export interface ConnectorStatus {
  state: ConnectorState
  error?: string
  server?: { name: string; version: string }
  tools: ConnectorTool[]
}

/** A connector as the renderer shows it: its settings without the secret values, and how it is doing. */
export interface ConnectorInfo extends Omit<ConnectorInput, 'env' | 'headers' | 'oauthClientSecret'> {
  /** Signed in with OAuth: tokens are saved for it (encrypted), and renewed as they run out. */
  signedIn: boolean
  oauthClientSecretSet: boolean
  /** Names of the environment variables and headers set; their values stay in the main process. */
  envKeys: string[]
  headerKeys: string[]
  /** Keys whose values could not be saved (no keyring) and are gone since a relaunch: to be typed again. */
  missingSecrets: string[]
  /** By tool name; a tool missing here takes defaultPermission. */
  toolPermissions: Record<string, ToolPermission>
  status: ConnectorStatus
}

/** A tool the model wants to run and the user must approve first. */
export interface ToolApprovalRequest {
  requestId: string
  approvalId: string
  connector: { id: string; name: string }
  tool: ConnectorTool
  /** The arguments as the connector will receive them: placeholders already turned back into their values. */
  args: Record<string, unknown>
}

/** "once" runs it this time; "always" also sets the tool to run without asking from now on. */
export type ToolApprovalDecision = 'once' | 'always' | 'deny'

export function emptyConnector(): ConnectorInput {
  return { id: '', name: '', enabled: true, transport: 'stdio', command: '', args: [], env: {}, url: '', headers: {}, oauthClientId: '', oauthClientSecret: null, scope: 'all', connectionIds: [] }
}

/** Tools that only read run without asking; anything else asks first, as in Claude Desktop. */
export function defaultPermission(tool: Pick<ConnectorTool, 'readOnly'>): ToolPermission {
  return tool.readOnly ? 'allow' : 'ask'
}

export function permissionFor(connector: Pick<ConnectorInfo, 'toolPermissions'>, tool: ConnectorTool): ToolPermission {
  return connector.toolPermissions[tool.name] ?? defaultPermission(tool)
}

/** Whether a connector is on for a database connection, or for any of a chat's, before the chat says otherwise. */
export function appliesTo(connector: Pick<ConnectorInput, 'enabled' | 'scope' | 'connectionIds'>, connection: string | (string | undefined)[] | undefined): boolean {
  if (!connector.enabled) return false
  if (connector.scope === 'all') return true
  const ids = Array.isArray(connection) ? connection : [connection]
  return ids.some((id) => Boolean(id) && connector.connectionIds.includes(id!))
}

/** Whether a connector takes part in a chat: the chat's own choice where it made one, otherwise the connector's scope. */
export function activeInChat(
  connector: Pick<ConnectorInput, 'id' | 'enabled' | 'scope' | 'connectionIds'>,
  connection: string | (string | undefined)[] | undefined,
  overrides?: Record<string, boolean>
): boolean {
  if (!connector.enabled) return false
  const chosen = overrides?.[connector.id]
  return chosen === undefined ? appliesTo(connector, connection) : chosen
}

function slug(text: string, max: number): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max)
  return s || 'tool'
}

/**
 * The name a connector's tool goes by with the model: mcp__<connector>__<tool>, kept within every provider's limit of
 * 64 letters, digits, underscores and hyphens. `taken` holds the names already handed out in the same request; a clash
 * gets a number.
 */
export function modelToolName(connectorName: string, toolName: string, taken: Set<string> = new Set()): string {
  const base = `mcp__${slug(connectorName, 20)}__${slug(toolName, 36)}`.slice(0, 62)
  let name = base
  for (let i = 2; taken.has(name); i++) name = `${base.slice(0, 62 - String(i).length - 1)}_${i}`
  taken.add(name)
  return name
}

export function isConnectorToolName(name: string): boolean {
  return name.startsWith('mcp__')
}

/** Splits a command line typed in one field, honouring single and double quotes and backslash escapes. */
export function splitCommandLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i]
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (ch === '\\' && i + 1 < line.length) {
      cur += line[++i]
      started = true
    } else if (/\s/.test(ch)) {
      if (started) out.push(cur)
      cur = ''
      started = false
    } else {
      cur += ch
      started = true
    }
  }
  if (started) out.push(cur)
  return out
}

/** The command line for a command and its arguments, quoted where needed, for editing in one field. */
export function joinCommandLine(parts: string[]): string {
  return parts.map((p) => (p === '' ? "''" : /[\s'"\\$`]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p)).join(' ')
}

/** "KEY=value" lines into pairs; blank lines and lines without "=" are skipped. */
export function parseKeyValueLines(text: string, separator: '=' | ':'): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const at = line.indexOf(separator)
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    if (key) out[key] = line.slice(at + 1).trim()
  }
  return out
}

/** Where a connector reaches, in a line: its command or its address. */
export function describeConnector(c: Pick<ConnectorInput, 'transport' | 'command' | 'args' | 'url'>): string {
  if (c.transport === 'http') return c.url
  return joinCommandLine([c.command, ...c.args].filter((p, i) => i > 0 || p))
}
