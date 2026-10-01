// MCP clients for the user's connectors: started when first needed (Settings shows a connector, or an ask uses one),
// shared by every chat, and stopped after a while unused. A local connector is a child process spoken to over stdio; a
// remote one is reached over Streamable HTTP, or SSE for servers that predate it.
import { EventEmitter } from 'node:events'
import os from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ToolListChangedNotificationSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js'
import type { ConnectorStatus, ConnectorTool } from '@shared/connectors'
import type { Connector } from './store'

export interface ConnectorManagerOptions {
  clientInfo: { name: string; version: string }
  /** The PATH local connectors run with. */
  path: () => Promise<string>
  /** How long a connector may sit unused before it is stopped. */
  idleMs?: number
  connectTimeoutMs?: number
  callTimeoutMs?: number
}

interface Live {
  /** The settings it was started with; a change restarts it. */
  key: string
  client: Client | null
  starting: Promise<Client> | null
  status: ConnectorStatus
  /** The tools as the server describes them, input schemas included; kept after it stops, for Settings. */
  tools: Tool[]
  /** The last lines a local server wrote to stderr, for the message when it fails. */
  stderr: string[]
  idle: NodeJS.Timeout | null
  calls: number
}

/** Fields that decide what is started; anything else (name, scope, permissions) changes nothing for a running one. */
function fingerprint(c: Connector): string {
  return JSON.stringify(c.transport === 'http' ? ['http', c.url, c.headers] : ['stdio', c.command, c.args, c.env])
}

export function toConnectorTool(t: Tool): ConnectorTool {
  const readOnly = t.annotations?.readOnlyHint === true
  return {
    name: t.name,
    title: t.title ?? t.annotations?.title ?? undefined,
    description: t.description ?? undefined,
    readOnly,
    // MCP's default: a tool that is not read-only may be destructive unless it says otherwise.
    destructive: !readOnly && t.annotations?.destructiveHint !== false
  }
}

/** What went wrong, in words a user can act on. */
export function connectorError(err: unknown, c: Connector, stderr: string[]): string {
  const raw = err instanceof Error ? err.message : String(err)
  const tail = stderr.join('\n').trim().slice(-600)
  if ((err as NodeJS.ErrnoException)?.code === 'ENOENT' || /\bENOENT\b/.test(raw)) {
    return `Could not find "${c.command}". Install it, or give its full path (run "which ${c.command}" in a terminal).`
  }
  if (err instanceof StreamableHTTPError || /\b40[13]\b/.test(raw)) {
    if (/\b401\b/.test(raw) || (err instanceof StreamableHTTPError && err.code === 401)) {
      return 'The server refused the connection (401). It may need an API key in a header such as Authorization; sign-in with OAuth is not supported yet.'
    }
  }
  if (/timed out|timeout/i.test(raw)) return `The server did not answer in time.${tail ? `\n${tail}` : ''}`
  if (/connection closed/i.test(raw)) return `The server stopped while starting.${tail ? `\n${tail}` : ' It printed nothing.'}`
  return tail ? `${raw}\n${tail}` : raw
}

export class ConnectorManager extends EventEmitter {
  private readonly live = new Map<string, Live>()
  private readonly opts: Required<ConnectorManagerOptions>

  constructor(opts: ConnectorManagerOptions) {
    super()
    this.opts = { idleMs: 10 * 60_000, connectTimeoutMs: 30_000, callTimeoutMs: 120_000, ...opts }
  }

  /** How a connector is doing, with the tools it last listed. */
  status(c: Connector): ConnectorStatus {
    const l = this.live.get(c.id)
    const tools = (l?.tools ?? []).map(toConnectorTool)
    if (!c.enabled) return { state: 'off', tools }
    if (!l || l.key !== fingerprint(c)) return { state: 'idle', tools: [] }
    return { ...l.status, tools }
  }

  /** The tools a running connector offers, input schemas included. */
  tools(id: string): Tool[] {
    return this.live.get(id)?.tools ?? []
  }

  private set(id: string, l: Live, status: Omit<ConnectorStatus, 'tools'>): void {
    l.status = { ...status, tools: l.tools.map(toConnectorTool) }
    this.emit('status', id)
  }

  private transportFor(c: Connector, path: string, l: Live, sse: boolean): Transport {
    if (c.transport === 'http') {
      const url = new URL(c.url)
      const requestInit: RequestInit = { headers: c.headers }
      if (sse) {
        // The event stream is opened with a plain fetch, which needs the headers too.
        return new SSEClientTransport(url, { requestInit, eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, headers: { ...(init?.headers as Record<string, string>), ...c.headers } }) } })
      }
      return new StreamableHTTPClientTransport(url, { requestInit })
    }
    const transport = new StdioClientTransport({
      command: c.command,
      args: c.args,
      env: { ...getDefaultEnvironment(), PATH: path, ...c.env },
      cwd: os.homedir(),
      stderr: 'pipe'
    })
    transport.stderr?.on('data', (chunk: Buffer) => {
      l.stderr.push(...chunk.toString('utf8').split('\n').filter((s) => s.trim()))
      if (l.stderr.length > 20) l.stderr.splice(0, l.stderr.length - 20)
    })
    return transport
  }

  private async open(c: Connector, l: Live, sse: boolean): Promise<Client> {
    const client = new Client(this.opts.clientInfo, { capabilities: {} })
    const transport = this.transportFor(c, c.transport === 'stdio' ? await this.opts.path() : '', l, sse)
    await client.connect(transport, { timeout: this.opts.connectTimeoutMs })
    return client
  }

  /** Connects over the connector's transport; a remote server from before Streamable HTTP is tried over SSE. */
  private async openAny(c: Connector, l: Live): Promise<Client> {
    try {
      return await this.open(c, l, false)
    } catch (err) {
      if (c.transport !== 'http' || (err instanceof StreamableHTTPError && err.code === 401)) throw err
      return this.open(c, l, true).catch(() => Promise.reject(err))
    }
  }

  private async start(c: Connector, l: Live): Promise<Client> {
    this.set(c.id, l, { state: 'connecting' })
    let opened: Client | null = null
    try {
      const client = await this.openAny(c, l)
      opened = client
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        if (l.client !== client) return
        l.tools = await this.listTools(client).catch(() => l.tools)
        this.set(c.id, l, l.status)
      })
      client.onclose = () => {
        if (l.client !== client) return
        l.client = null
        // Stopped on purpose (idle, settings changed) or by the server: either way it starts again when next needed.
        this.set(c.id, l, l.status.state === 'connected' ? { state: 'idle' } : l.status)
      }
      const tools = await this.listTools(client)
      // Stopped or restarted from Settings while it was starting: this client is not wanted any more.
      if (this.live.get(c.id) !== l) throw new Error('The connector was stopped while it started.')
      l.tools = tools
      l.client = client
      const server = client.getServerVersion()
      this.set(c.id, l, { state: 'connected', ...(server ? { server: { name: server.name, version: server.version } } : {}) })
      return client
    } catch (err) {
      await opened?.close().catch(() => {})
      this.set(c.id, l, { state: 'error', error: connectorError(err, c, l.stderr) })
      throw new Error(l.status.error)
    }
  }

  private async listTools(client: Client): Promise<Tool[]> {
    const out: Tool[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: this.opts.connectTimeoutMs })
      out.push(...page.tools)
      cursor = page.nextCursor
    } while (cursor)
    return out
  }

  /** A running client for the connector, started (or restarted, when its settings changed) if need be. */
  async ensure(c: Connector): Promise<Client> {
    if (!c.enabled) throw new Error(`${c.name} is switched off.`)
    const key = fingerprint(c)
    let l = this.live.get(c.id)
    if (l && l.key !== key) {
      await this.stop(c.id)
      l = undefined
    }
    if (!l) {
      l = { key, client: null, starting: null, status: { state: 'idle', tools: [] }, tools: [], stderr: [], idle: null, calls: 0 }
      this.live.set(c.id, l)
    }
    if (l.client) {
      this.touch(c.id, l)
      return l.client
    }
    const live = l
    live.starting ??= this.start(c, live).finally(() => (live.starting = null))
    const client = await live.starting
    this.touch(c.id, live)
    return client
  }

  /** Starts the connector afresh and lists its tools again. */
  async refresh(c: Connector): Promise<void> {
    await this.stop(c.id)
    if (c.enabled) await this.ensure(c)
  }

  async call(c: Connector, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const client = await this.ensure(c)
    const l = this.live.get(c.id)!
    l.calls++
    try {
      return (await client.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: this.opts.callTimeoutMs, resetTimeoutOnProgress: true })) as CallToolResult
    } finally {
      l.calls--
      this.touch(c.id, l)
    }
  }

  private touch(id: string, l: Live): void {
    if (l.idle) clearTimeout(l.idle)
    l.idle = setTimeout(() => {
      if (l.calls > 0) return this.touch(id, l)
      void this.stop(id, true)
    }, this.opts.idleMs)
    l.idle.unref?.()
  }

  /** Stops a connector's client (and process). With `keepTools`, Settings still lists what it offered. */
  async stop(id: string, keepTools = false): Promise<void> {
    const l = this.live.get(id)
    if (!l) return
    if (l.idle) clearTimeout(l.idle)
    l.idle = null
    const client = l.client
    l.client = null
    if (!keepTools) this.live.delete(id)
    else this.set(id, l, { state: 'idle' })
    await client?.close().catch(() => {})
    if (!keepTools) this.emit('status', id)
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.stop(id)))
  }
}
