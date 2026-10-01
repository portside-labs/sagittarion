// The connectors an ask may use: those on for the chat, started, their tools named for the model, and each call run
// through its permission: freely, after the user approves it, or not at all.
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { AiProgressStep } from '@shared/ai'
import { activeInChat, defaultPermission, modelToolName, type ConnectorTool, type ToolApprovalDecision } from '@shared/connectors'
import type { AgentConnectors } from '../ai/nl2sql'
import { TOOLS } from '../ai/prompt'
import type { ToolDef } from '../ai/providers/types'
import { toConnectorTool, type ConnectorManager } from './manager'
import type { Connector, ConnectorStore } from './store'

/** About 6,000 tokens: plenty for a lookup, and a runaway listing cannot swamp the request. */
const MAX_RESULT_CHARS = 24_000

export interface ConnectorAskDeps {
  store: ConnectorStore
  manager: ConnectorManager
  /** The saved database connections in the chat: its own, and any others it has in context. */
  connectionId: string | (string | undefined)[] | undefined
  /** The chat's own choices, by connector id. */
  overrides?: Record<string, boolean>
  /** Asks the user whether a tool may run, with the arguments it would get. */
  approve(connector: Connector, tool: ConnectorTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolApprovalDecision>
  /** A tool's permission changed during the ask ("Always allow"). */
  onChange?(connector: Connector): void
  onProgress?(step: AiProgressStep): void
  signal?: AbortSignal
}

/** What a tool returned, as text for the model: its text and embedded resources; images and audio are left out. */
export function resultText(r: CallToolResult): string {
  const parts: string[] = []
  for (const c of r.content ?? []) {
    if (c.type === 'text') parts.push(c.text)
    else if (c.type === 'resource') parts.push('text' in c.resource && typeof c.resource.text === 'string' ? c.resource.text : `[binary resource ${c.resource.uri}]`)
    else if (c.type === 'resource_link') parts.push(`[resource ${c.name}: ${c.uri}]`)
    else parts.push(`[${c.type} left out]`)
  }
  if (!parts.length && r.structuredContent) parts.push(JSON.stringify(r.structuredContent, null, 2))
  const text = parts.join('\n\n').trim()
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[… ${(text.length - MAX_RESULT_CHARS).toLocaleString('en-US')} more characters cut]` : text
}

/** A tool's input schema as every provider takes it: an object, without the keys some reject. */
export function inputSchema(t: Tool): Record<string, unknown> {
  const { $schema: _s, $id: _i, ...schema } = (t.inputSchema ?? {}) as Record<string, unknown>
  return { ...schema, type: 'object', properties: (schema.properties as Record<string, unknown> | undefined) ?? {} }
}

function describe(c: Connector, t: Tool, info: ConnectorTool): string {
  const what = (t.description ?? info.title ?? t.name).trim()
  return `${what}\n(From the "${c.name}" connector; ${info.readOnly ? 'read-only' : 'may change things'}.)`
}

export async function connectorsForAsk(deps: ConnectorAskDeps): Promise<AgentConnectors | undefined> {
  const active = (await deps.store.list()).filter((c) => activeInChat(c, deps.connectionId, deps.overrides))
  if (!active.length) return undefined
  const note = (step: AiProgressStep) => deps.onProgress?.(step)
  note({ stepId: 'connectors', stage: 'tool', status: 'running', message: active.length === 1 ? `Starting ${active[0].name}` : `Starting ${active.length} connectors` })
  const started = await Promise.all(
    active.map(async (c) => {
      try {
        await deps.manager.ensure(c)
        return c
      } catch (err) {
        note({ stepId: `connector:${c.id}`, stage: 'tool', status: 'error', message: `${c.name} is unavailable`, detail: err instanceof Error ? err.message.split('\n')[0] : String(err) })
        return null
      }
    })
  )
  const ready = started.filter((c): c is Connector => c !== null)

  const taken = new Set(TOOLS.map((t) => t.name))
  const byName = new Map<string, { connector: Connector; tool: Tool; info: ConnectorTool }>()
  const tools: ToolDef[] = []
  for (const c of ready) {
    for (const t of deps.manager.tools(c.id)) {
      const info = toConnectorTool(t)
      if ((c.toolPermissions[t.name] ?? defaultPermission(info)) === 'never') continue
      const name = modelToolName(c.name, t.name, taken)
      byName.set(name, { connector: c, tool: t, info })
      tools.push({ name, description: describe(c, t, info), parameters: inputSchema(t) })
    }
  }
  note({
    stepId: 'connectors',
    stage: 'tool',
    status: ready.length ? 'done' : 'error',
    message: active.length === 1 ? `Starting ${active[0].name}` : `Starting ${active.length} connectors`,
    detail: ready.length ? `${tools.length} tool${tools.length === 1 ? '' : 's'} from ${ready.map((c) => c.name).join(', ')}` : 'none could start'
  })
  if (!tools.length) return undefined

  return {
    tools,
    label: (name) => {
      const e = byName.get(name)
      return e ? `${e.connector.name}: ${e.info.title ?? e.tool.name}` : undefined
    },
    async call(name, args, signal) {
      const e = byName.get(name)
      if (!e) return { content: `Unknown tool ${name}.`, isError: true }
      // Read again: "Always allow" earlier in this ask, or a change in Settings, applies at once.
      const current = (await deps.store.get(e.connector.id)) ?? e.connector
      const permission = current.toolPermissions[e.tool.name] ?? defaultPermission(e.info)
      if (permission === 'never') return { content: 'This tool is switched off in Settings. Do not call it again.', declined: true }
      if (permission === 'ask') {
        const decision = await deps.approve(current, e.info, args, signal)
        if (decision === 'deny') return { content: 'The user declined to run this tool. Do not call it again in this answer; carry on with what you have.', declined: true }
        if (decision === 'always') {
          const updated = await deps.store.setToolPermission(current.id, e.tool.name, 'allow')
          deps.onChange?.(updated)
        }
      }
      const result = await deps.manager.call(current, e.tool.name, args, signal)
      const text = resultText(result)
      return result.isError ? { content: text || 'The tool reported an error.', isError: true } : { content: text }
    }
  }
}
