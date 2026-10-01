// Settings → Connectors: MCP servers whose tools the chat can use, as connectors are in Claude Desktop. Each has a
// switch, a scope (every database connection, or chosen ones) and a permission per tool.
import { useEffect, useState } from 'react'
import {
  describeConnector,
  emptyConnector,
  joinCommandLine,
  parseKeyValueLines,
  permissionFor,
  splitCommandLine,
  type ConnectorInfo,
  type ConnectorInput,
  type ConnectorTool,
  type ToolPermission
} from '@shared/connectors'
import { useStore } from '@/store'
import { errorMessage } from '@/lib/util'
import { Icon } from './Icons'
import { ScopePicker, scopeText } from './ScopePicker'

/** Stands for a saved secret in the editor: left as it is, the saved value is kept. */
const MASK = '••••••••'

const PERMISSION_LABELS: Record<ToolPermission, string> = { allow: 'Always allow', ask: 'Ask first', never: 'Never' }

/** Signs in to a connector: its sign-in page opens in the browser, and the connector runs once the user is back. */
export async function signInTo(c: ConnectorInfo, put: (info: ConnectorInfo) => void, toast: (kind: 'error', message: string, detail?: string) => void): Promise<void> {
  try {
    put(await window.api.connectors.signIn(c.id))
  } catch (e) {
    toast('error', `Could not sign in to ${c.name}`, errorMessage(e))
  }
}

/** An on/off switch. */
export function Switch({ checked, onChange, label, testId, disabled }: { checked: boolean; onChange: (on: boolean) => void; label: string; testId?: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} title={label} className={`switch ${checked ? 'on' : ''}`} disabled={disabled} onClick={() => onChange(!checked)} data-testid={testId}>
      <span className="switch-knob" />
    </button>
  )
}

/** How a connector is doing, in a few words. */
export function connectorStatusText(c: ConnectorInfo): string {
  const n = c.status.tools.length
  const tools = `${n} tool${n === 1 ? '' : 's'}`
  switch (c.status.state) {
    case 'off':
      return 'Off'
    case 'connecting':
      return 'Starting…'
    case 'connected':
      return tools
    case 'error':
      return 'Could not start'
    case 'signin':
      return 'Sign in needed'
    case 'authorizing':
      return 'Signing in…'
    default:
      return n ? tools : 'Not started yet'
  }
}

interface Draft {
  name: string
  transport: 'stdio' | 'http'
  commandLine: string
  envText: string
  url: string
  headersText: string
  oauthClientId: string
  oauthClientSecret: string
  scope: 'all' | 'selected'
  connectionIds: string[]
}

function draftFrom(c: ConnectorInfo | null): Draft {
  if (!c) return { name: '', transport: 'stdio', commandLine: '', envText: '', url: '', headersText: '', oauthClientId: '', oauthClientSecret: '', scope: 'all', connectionIds: [] }
  const masked = (k: string) => (c.missingSecrets.includes(k) ? '' : MASK)
  return {
    name: c.name,
    transport: c.transport,
    commandLine: joinCommandLine([c.command, ...c.args].filter((p, i) => i > 0 || p)),
    envText: c.envKeys.map((k) => `${k}=${masked(k)}`).join('\n'),
    url: c.url,
    headersText: c.headerKeys.map((k) => `${k}: ${masked(k)}`).join('\n'),
    oauthClientId: c.oauthClientId,
    oauthClientSecret: c.oauthClientSecretSet ? masked('Client secret') : '',
    scope: c.scope,
    connectionIds: c.connectionIds
  }
}

/** The draft as the main process takes it: a secret still showing the mask keeps its saved value. */
function inputFrom(d: Draft, existing: ConnectorInfo | null): ConnectorInput {
  const secrets = (text: string, separator: '=' | ':') => {
    const out: Record<string, string | null> = {}
    for (const [k, v] of Object.entries(parseKeyValueLines(text, separator))) out[k] = v === MASK ? null : v
    return out
  }
  const [command = '', ...args] = splitCommandLine(d.commandLine)
  return {
    ...emptyConnector(),
    id: existing?.id ?? '',
    enabled: existing?.enabled ?? true,
    name: d.name.trim(),
    transport: d.transport,
    command,
    args,
    env: d.transport === 'stdio' ? secrets(d.envText, '=') : {},
    url: d.url.trim(),
    headers: d.transport === 'http' ? secrets(d.headersText, ':') : {},
    oauthClientId: d.transport === 'http' ? d.oauthClientId.trim() : '',
    // The mask keeps the saved secret; an empty field removes it.
    oauthClientSecret: d.oauthClientSecret === MASK ? null : d.oauthClientSecret.trim(),
    scope: d.scope,
    connectionIds: d.scope === 'selected' ? d.connectionIds : []
  }
}

function ConnectorEditor({ existing, onDone }: { existing: ConnectorInfo | null; onDone: (saved: ConnectorInfo | null) => void }) {
  const encryption = useStore((s) => s.appInfo?.encryptionAvailable ?? true)
  const [draft, setDraft] = useState<Draft>(() => draftFrom(existing))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [ownClient, setOwnClient] = useState(Boolean(existing?.oauthClientId))
  const missing = existing?.missingSecrets ?? []

  const save = async () => {
    setError(null)
    setBusy(true)
    try {
      onDone(await window.api.connectors.save(inputFrom(draft, existing)))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="setting-editor" data-testid="connector-editor">
      <div className="field">
        <label>Name</label>
        <input className="text" value={draft.name} placeholder="GitHub" onChange={(e) => setDraft({ ...draft, name: e.target.value })} data-testid="connector-name" />
      </div>
      <div className="field">
        <label>Server</label>
        <div className="segmented small">
          <button type="button" className={draft.transport === 'stdio' ? 'active' : ''} onClick={() => setDraft({ ...draft, transport: 'stdio' })} data-testid="connector-type-stdio">
            Local command
          </button>
          <button type="button" className={draft.transport === 'http' ? 'active' : ''} onClick={() => setDraft({ ...draft, transport: 'http' })} data-testid="connector-type-http">
            Remote URL
          </button>
        </div>
      </div>
      {draft.transport === 'stdio' ? (
        <>
          <div className="field">
            <label>Command</label>
            <input
              className="text mono"
              value={draft.commandLine}
              placeholder="npx -y @modelcontextprotocol/server-github"
              spellCheck={false}
              onChange={(e) => setDraft({ ...draft, commandLine: e.target.value })}
              data-testid="connector-command"
            />
            <span className="hint">As you would type it in a terminal. It runs on this computer, with your login shell&apos;s PATH.</span>
          </div>
          <div className="field">
            <label>Environment variables</label>
            <textarea
              className="text mono"
              rows={3}
              value={draft.envText}
              placeholder={'GITHUB_TOKEN=ghp_…'}
              spellCheck={false}
              onChange={(e) => setDraft({ ...draft, envText: e.target.value })}
              data-testid="connector-env"
            />
            <span className="hint">One per line, NAME=value. Values are saved encrypted and never shown again; leave {MASK} to keep one.</span>
          </div>
        </>
      ) : (
        <>
          <div className="field">
            <label>URL</label>
            <input className="text mono" value={draft.url} placeholder="https://mcp.example.com/mcp" spellCheck={false} onChange={(e) => setDraft({ ...draft, url: e.target.value })} data-testid="connector-url" />
            <span className="hint">Streamable HTTP, or SSE for older servers. A server that wants you to sign in shows a Sign in button once it is added.</span>
          </div>
          <div className="field">
            <label>Headers</label>
            <textarea
              className="text mono"
              rows={2}
              value={draft.headersText}
              placeholder="Authorization: Bearer …"
              spellCheck={false}
              onChange={(e) => setDraft({ ...draft, headersText: e.target.value })}
              data-testid="connector-headers"
            />
            <span className="hint">One per line, Name: value. Values are saved encrypted and never shown again; leave {MASK} to keep one.</span>
          </div>
          <button type="button" className="disclosure" onClick={() => setOwnClient(!ownClient)} aria-expanded={ownClient} data-testid="connector-oauth-advanced">
            <Icon name={ownClient ? 'chevron-down' : 'chevron-right'} size={12} /> Sign-in app
          </button>
          {ownClient ? (
            <div className="field">
              <label>OAuth client</label>
              <div className="field-pair">
                <input
                  className="text mono"
                  value={draft.oauthClientId}
                  placeholder="Client ID"
                  spellCheck={false}
                  onChange={(e) => setDraft({ ...draft, oauthClientId: e.target.value })}
                  data-testid="connector-oauth-client-id"
                />
                <input
                  className="text mono"
                  type="password"
                  value={draft.oauthClientSecret}
                  placeholder="Client secret (if it has one)"
                  spellCheck={false}
                  onChange={(e) => setDraft({ ...draft, oauthClientSecret: e.target.value })}
                  data-testid="connector-oauth-client-secret"
                />
              </div>
              <span className="hint">
                Only for a server that cannot register apps itself. Register one with it whose redirect URL is http://127.0.0.1/callback (any port), and give
                its ID here. Most servers need nothing here: Sagittarion registers itself when you sign in.
              </span>
            </div>
          ) : null}
        </>
      )}
      {missing.length ? (
        <span className="hint warn">
          Type {missing.length === 1 ? 'the value' : 'the values'} for {missing.join(', ')} again: this computer has no keyring to save {missing.length === 1 ? 'it' : 'them'} in, so {missing.length === 1 ? 'it lasts' : 'they last'} only until Sagittarion quits.
        </span>
      ) : !encryption ? (
        <span className="hint warn">This computer has no keyring, so secrets last only until Sagittarion quits.</span>
      ) : null}
      <ScopePicker
        scope={draft.scope}
        connectionIds={draft.connectionIds}
        onChange={(scope, connectionIds) => setDraft({ ...draft, scope, connectionIds })}
        testPrefix="connector"
        hint="Where it is used without asking. In any chat it can still be switched on or off from the chat's connectors menu."
      />
      {error ? (
        <div className="error-box" data-testid="connector-error">
          {error}
        </div>
      ) : null}
      <div className="setting-editor-actions">
        <button type="button" className="btn small" onClick={() => onDone(null)} data-testid="connector-cancel">
          Cancel
        </button>
        <button type="button" className="btn small primary" onClick={() => void save()} disabled={busy} data-testid="connector-save">
          {busy ? <span className="spinner tiny" /> : null} {existing ? 'Save' : 'Add connector'}
        </button>
      </div>
    </div>
  )
}

function ToolRow({ connector, tool }: { connector: ConnectorInfo; tool: ConnectorTool }) {
  const putConnector = useStore((s) => s.putConnector)
  const toast = useStore((s) => s.toast)
  const permission = permissionFor(connector, tool)
  return (
    <div className="connector-tool" data-testid="connector-tool" data-tool={tool.name}>
      <div className="connector-tool-text">
        <span className="connector-tool-name">
          {tool.title ?? tool.name}
          <span className={`connector-tool-kind ${tool.readOnly ? 'read' : tool.destructive ? 'destructive' : 'write'}`}>{tool.readOnly ? 'read-only' : tool.destructive ? 'may delete' : 'changes things'}</span>
        </span>
        {tool.description ? <span className="connector-tool-description">{tool.description}</span> : null}
      </div>
      <select
        className="select small"
        value={permission}
        aria-label={`When ${tool.title ?? tool.name} may run`}
        onChange={(e) =>
          void window.api.connectors
            .setToolPermission(connector.id, tool.name, e.target.value as ToolPermission)
            .then(putConnector)
            .catch((err) => toast('error', 'Could not change the permission', errorMessage(err)))
        }
        data-testid="tool-permission"
      >
        {(Object.keys(PERMISSION_LABELS) as ToolPermission[]).map((p) => (
          <option key={p} value={p}>
            {PERMISSION_LABELS[p]}
          </option>
        ))}
      </select>
    </div>
  )
}

function ConnectorCard({ c, open, onToggle }: { c: ConnectorInfo; open: boolean; onToggle: () => void }) {
  const connections = useStore((s) => s.connections)
  const putConnector = useStore((s) => s.putConnector)
  const dropConnector = useStore((s) => s.dropConnector)
  const toast = useStore((s) => s.toast)
  const confirm = useStore((s) => s.confirm)
  const [editing, setEditing] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const s = c.status
  const signIn = () => void signInTo(c, putConnector, toast)
  const signOut = () =>
    void window.api.connectors
      .signOut(c.id)
      .then(putConnector)
      .catch((e) => toast('error', `Could not sign out of ${c.name}`, errorMessage(e)))

  const setEnabled = (on: boolean) =>
    void window.api.connectors
      .setEnabled(c.id, on)
      .then(putConnector)
      .catch((e) => toast('error', 'Could not switch the connector', errorMessage(e)))
  const refresh = async () => {
    setRefreshing(true)
    try {
      putConnector(await window.api.connectors.refresh(c.id))
    } finally {
      setRefreshing(false)
    }
  }
  const remove = async () => {
    if (!(await confirm(`Remove ${c.name}?`, 'Its settings and saved secrets are deleted. Chats stop using it.', 'Remove', true))) return
    await window.api.connectors.remove(c.id)
    dropConnector(c.id)
  }

  return (
    <div className={`setting-card ${open ? 'open' : ''} ${c.enabled ? '' : 'off'}`} data-testid="connector" data-name={c.name}>
      <div className="setting-card-head">
        <span className={`status-dot connector-dot ${s.state}`} title={connectorStatusText(c)} />
        <button type="button" className="setting-card-title" onClick={onToggle} aria-expanded={open} data-testid="connector-configure">
          <span className="setting-card-name">{c.name}</span>
          <span className="setting-card-sub">
            {connectorStatusText(c)} · {scopeText(c.scope, c.connectionIds, connections)}
          </span>
        </button>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} className="setting-card-chevron" />
        <Switch checked={c.enabled} onChange={setEnabled} label={c.enabled ? `Switch ${c.name} off` : `Switch ${c.name} on`} testId="connector-enabled" />
      </div>
      {open ? (
        editing ? (
          <ConnectorEditor
            existing={c}
            onDone={(saved) => {
              if (saved) putConnector(saved)
              setEditing(false)
            }}
          />
        ) : (
          <div className="setting-card-body">
            <div className="connector-where mono">{describeConnector(c)}</div>
            <div className={`connector-status ${s.state}`} data-testid="connector-status">
              {s.state === 'error' ? (
                <span className="connector-error">{s.error}</span>
              ) : s.state === 'connected' ? (
                <span>
                  Running{s.server ? ` ${s.server.name} ${s.server.version}` : ''}
                  {c.signedIn ? ', signed in' : ''}.
                </span>
              ) : s.state === 'connecting' ? (
                <span>Starting…</span>
              ) : s.state === 'signin' ? (
                <span>The server wants you to sign in. Your browser opens its sign-in page; then come back here.</span>
              ) : s.state === 'authorizing' ? (
                <span>Finish signing in in your browser. This updates when you have.</span>
              ) : s.state === 'off' ? (
                <span>Off: no chat can use it.</span>
              ) : (
                <span>Starts when a chat uses it.</span>
              )}
              {c.enabled && s.state === 'signin' ? (
                <button type="button" className="btn small primary" onClick={signIn} data-testid="connector-sign-in">
                  <Icon name="key" size={12} /> Sign in
                </button>
              ) : c.enabled && s.state === 'authorizing' ? (
                <button type="button" className="btn small ghost" onClick={() => void window.api.connectors.cancelSignIn(c.id)} data-testid="connector-sign-in-cancel">
                  Cancel
                </button>
              ) : c.enabled ? (
                <button type="button" className="btn small ghost" onClick={() => void refresh()} disabled={refreshing} data-testid="connector-refresh">
                  {refreshing ? <span className="spinner tiny" /> : <Icon name="refresh" size={12} />} {s.state === 'error' ? 'Try again' : 'Reconnect'}
                </button>
              ) : null}
            </div>
            {s.tools.length ? (
              <div className="connector-tools">
                <div className="connector-tools-head">
                  <span>Tools</span>
                  <span className="hint">Read-only tools run freely; the rest ask first, unless you say otherwise.</span>
                </div>
                {s.tools.map((t) => (
                  <ToolRow key={t.name} connector={c} tool={t} />
                ))}
              </div>
            ) : null}
            <div className="setting-editor-actions">
              <button type="button" className="btn small ghost danger" onClick={() => void remove()} data-testid="connector-remove">
                <Icon name="trash" size={12} /> Remove
              </button>
              {c.signedIn ? (
                <button type="button" className="btn small ghost" onClick={signOut} title="Forget this connector's sign-in" data-testid="connector-sign-out">
                  Sign out
                </button>
              ) : null}
              <button type="button" className="btn small" onClick={() => setEditing(true)} data-testid="connector-edit">
                Edit
              </button>
            </div>
          </div>
        )
      ) : null}
    </div>
  )
}

export function ConnectorsSettings() {
  const connectors = useStore((s) => s.connectors)
  const putConnector = useStore((s) => s.putConnector)
  const [adding, setAdding] = useState(false)
  const [open, setOpen] = useState<string | null>(null)

  // Started when shown, so their tools, or why they could not start, appear here.
  useEffect(() => {
    for (const c of useStore.getState().connectors) {
      if (c.enabled && c.status.state === 'idle' && !c.status.tools.length) void window.api.connectors.start(c.id).catch(() => {})
    }
  }, [])

  return (
    <section data-testid="settings-connectors">
      <h2>
        <Icon name="plug" /> Connectors
      </h2>
      <p className="hint">
        Connect MCP servers so Ask can use your other tools, such as an issue tracker, a CRM or your files. Each connector is on for every database connection, or only
        for the ones you choose.
      </p>
      <p className="hint privacy">
        <Icon name="shield" size={12} /> Connectors sit on your side of Local AI Privacy, like the database: they receive real values, and what they send back is
        protected before it reaches the model.
      </p>
      <div className="setting-list">
        {connectors.map((c) => (
          <ConnectorCard key={c.id} c={c} open={open === c.id} onToggle={() => setOpen((id) => (id === c.id ? null : c.id))} />
        ))}
        {!connectors.length && !adding ? <div className="setting-empty">No connectors yet.</div> : null}
      </div>
      {adding ? (
        <div className="setting-card open">
          <ConnectorEditor
            existing={null}
            onDone={(saved) => {
              setAdding(false)
              if (saved) {
                putConnector(saved)
                setOpen(saved.id)
              }
            }}
          />
        </div>
      ) : (
        <button type="button" className="btn small setting-add" onClick={() => setAdding(true)} data-testid="connector-add">
          <Icon name="plus" size={12} /> Add connector
        </button>
      )}
    </section>
  )
}
