import { useEffect, useState } from 'react'
import type { ConnectionConfig, DatabaseKind, PostgresConfig, SshConfig, SslMode } from '@shared/types'
import { KIND_LABELS } from '@shared/types'
import { describeTarget, newConnection, normalizeConnection, parsePostgresUrl } from '@shared/connections'
import { useStore } from '@/store'
import { TitleBar } from '@/components/TitleBar'
import { Icon } from '@/components/Icons'
import { RemoteFileBrowser } from '@/components/RemoteFileBrowser'
import { errorMessage } from '@/lib/util'

const COLORS = ['#5b93ff', '#3ecf8e', '#e6a23c', '#ff5f57', '#b57bee', '#38bdf8']
const SSL_MODES: { value: SslMode; label: string; hint: string }[] = [
  { value: 'prefer', label: 'Prefer', hint: 'Encrypt when the server supports it' },
  { value: 'require', label: 'Require', hint: 'Encrypt, do not verify the certificate' },
  { value: 'verify-full', label: 'Verify full', hint: 'Encrypt and verify the certificate and host name' },
  { value: 'disable', label: 'Disable', hint: 'Plain connection' }
]

type Busy = null | 'connect' | 'test' | 'browse'

// ---------------------------------------------------------------------------
// Shared SSH fields (SQLite host, or Postgres tunnel host)
// ---------------------------------------------------------------------------

function SshFields({
  ssh,
  onChange,
  encryption,
  idPrefix
}: {
  ssh: SshConfig
  onChange: (patch: Partial<SshConfig>) => void
  encryption: boolean
  idPrefix: string
}) {
  const pickKey = async () => {
    const p = await window.api.dialog.pickPrivateKey()
    if (p) onChange({ privateKeyPath: p })
  }
  const saveTitle = encryption ? 'Stored encrypted with your OS keychain' : 'Encrypted storage is not available on this system'
  return (
    <div className="form-grid">
      <div className="field">
        <label>SSH host</label>
        <input className="text mono" value={ssh.host} placeholder="db.example.com" onChange={(e) => onChange({ host: e.target.value })} spellCheck={false} data-testid={`${idPrefix}-host`} />
      </div>
      <div className="field">
        <label>SSH port</label>
        <input className="text mono" type="number" min={1} max={65535} value={ssh.port} onChange={(e) => onChange({ port: Number(e.target.value) })} data-testid={`${idPrefix}-port`} />
      </div>
      <div className="field">
        <label>SSH username</label>
        <input className="text mono" value={ssh.username} placeholder="ubuntu" onChange={(e) => onChange({ username: e.target.value })} spellCheck={false} data-testid={`${idPrefix}-user`} />
      </div>
      <div className="field">
        <label>Authentication</label>
        <div className="segmented">
          {(['key', 'agent', 'password'] as const).map((m) => (
            <button key={m} type="button" className={ssh.auth === m ? 'active' : ''} onClick={() => onChange({ auth: m })} data-testid={`${idPrefix}-auth-${m}`}>
              {m === 'key' ? 'Private key' : m === 'agent' ? 'SSH agent' : 'Password'}
            </button>
          ))}
        </div>
      </div>

      {ssh.auth === 'password' && (
        <div className="field full">
          <label>SSH password</label>
          <div className="row">
            <input className="text" type="password" value={ssh.password ?? ''} onChange={(e) => onChange({ password: e.target.value })} autoComplete="off" data-testid={`${idPrefix}-password`} />
            <label className="checkbox" title={saveTitle}>
              <input type="checkbox" checked={!!ssh.savePassword && encryption} disabled={!encryption} onChange={(e) => onChange({ savePassword: e.target.checked })} />
              Save
            </label>
          </div>
        </div>
      )}

      {ssh.auth === 'key' && (
        <>
          <div className="field full">
            <label>Private key</label>
            <div className="row">
              <input
                className="text mono"
                value={ssh.privateKeyPath ?? ''}
                placeholder="~/.ssh/id_ed25519 (auto-detected when empty)"
                onChange={(e) => onChange({ privateKeyPath: e.target.value })}
                spellCheck={false}
              />
              <button className="btn" type="button" onClick={() => void pickKey()}>
                Browse…
              </button>
            </div>
          </div>
          <div className="field full">
            <label>Passphrase</label>
            <div className="row">
              <input
                className="text"
                type="password"
                value={ssh.passphrase ?? ''}
                placeholder="Leave empty for an unencrypted key"
                onChange={(e) => onChange({ passphrase: e.target.value })}
                autoComplete="off"
              />
              <label className="checkbox" title={saveTitle}>
                <input type="checkbox" checked={!!ssh.savePassphrase && encryption} disabled={!encryption} onChange={(e) => onChange({ savePassphrase: e.target.checked })} />
                Save
              </label>
            </div>
          </div>
        </>
      )}

      {ssh.auth === 'agent' && (
        <div className="field full">
          <span className="hint">
            Uses the identities loaded in your running SSH agent (<code>ssh-add -l</code>).
          </span>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function ConnectScreen() {
  const connections = useStore((s) => s.connections)
  const appInfo = useStore((s) => s.appInfo)
  const toast = useStore((s) => s.toast)
  const setSession = useStore((s) => s.setSession)
  const refreshSchema = useStore((s) => s.refreshSchema)
  const loadConnections = useStore((s) => s.loadConnections)
  const confirm = useStore((s) => s.confirm)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [form, setForm] = useState<ConnectionConfig>(() => newConnection('sqlite'))
  /** A brand-new connection shows the type chooser until a type is picked. */
  const [kindChosen, setKindChosen] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<Busy>(null)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [browser, setBrowser] = useState<{ sessionId: string } | null>(null)
  const [initialised, setInitialised] = useState(false)

  useEffect(() => {
    if (initialised) return
    if (connections.length > 0) {
      select(connections[0])
      setInitialised(true)
    }
  }, [connections, initialised])

  const update = (patch: Partial<ConnectionConfig>) => {
    setForm((f) => ({ ...f, ...patch }))
    setDirty(true)
  }
  const updateSsh = (patch: Partial<SshConfig>) => {
    setForm((f) => ({ ...f, ssh: { ...f.ssh, ...patch } }))
    setDirty(true)
  }
  const updatePg = (patch: Partial<PostgresConfig>) => {
    setForm((f) => ({ ...f, pg: { ...(f.pg ?? newConnection('postgres').pg!), ...patch } }))
    setDirty(true)
  }

  function select(c: ConnectionConfig) {
    setSelectedId(c.id)
    setForm(normalizeConnection(c))
    setKindChosen(true)
    setDirty(false)
    setError(null)
  }

  function startNew() {
    setSelectedId(null)
    setForm(newConnection('sqlite'))
    setKindChosen(false)
    setDirty(false)
    setError(null)
  }

  function chooseKind(kind: DatabaseKind) {
    setForm((f) => normalizeConnection({ ...f, kind, remotePath: kind === 'sqlite' ? f.remotePath ?? '' : f.remotePath, pg: kind === 'postgres' ? f.pg : f.pg }))
    setKindChosen(true)
    setDirty(true)
  }

  function validate(needTarget = true): string | null {
    const portOk = (p: number) => Number.isInteger(Number(p)) && Number(p) >= 1 && Number(p) <= 65535
    const needSsh = form.kind === 'sqlite' || form.pg?.tunnel
    if (needSsh) {
      if (!form.ssh.host.trim()) return 'SSH host is required.'
      if (!form.ssh.username.trim()) return 'SSH username is required.'
      if (!portOk(form.ssh.port)) return 'SSH port must be between 1 and 65535.'
    }
    if (form.kind === 'sqlite') {
      if (needTarget && !form.remotePath?.trim()) return 'Enter the path of the SQLite file on the remote host.'
    } else {
      const pg = form.pg
      if (!pg?.host.trim()) return 'Database host is required.'
      if (!portOk(pg.port)) return 'Database port must be between 1 and 65535.'
      if (needTarget && !pg.database.trim()) return 'Database name is required.'
      if (!pg.user.trim()) return 'Database user is required.'
    }
    return null
  }

  async function withProgress<T>(kind: Busy, fn: (requestId: string) => Promise<T>): Promise<T | undefined> {
    setBusy(kind)
    setError(null)
    setProgress('')
    const requestId = crypto.randomUUID()
    const unsub = window.api.session.onProgress((e) => {
      if (e.requestId === requestId) setProgress(e.message)
    })
    try {
      return await fn(requestId)
    } catch (e) {
      setError(errorMessage(e))
      return undefined
    } finally {
      unsub()
      setBusy(null)
      setProgress('')
    }
  }

  const normalised = (): ConnectionConfig => {
    const n = normalizeConnection(form)
    n.name = form.name.trim() || describeTarget(n)
    n.ssh.host = n.ssh.host.trim()
    n.ssh.username = n.ssh.username.trim()
    if (n.remotePath !== undefined) n.remotePath = n.remotePath.trim()
    if (n.pg) {
      n.pg.host = n.pg.host.trim()
      n.pg.database = n.pg.database.trim()
      n.pg.user = n.pg.user.trim()
    }
    return n
  }

  /** Secrets are not returned by the store unless saved, so keep what is in the form. */
  const withSecrets = (saved: ConnectionConfig, source: ConnectionConfig): ConnectionConfig => ({
    ...saved,
    ssh: { ...saved.ssh, password: source.ssh.password, passphrase: source.ssh.passphrase },
    pg: saved.pg ? { ...saved.pg, password: source.pg?.password } : undefined
  })

  async function saveOnly(): Promise<ConnectionConfig> {
    const source = normalised()
    const saved = await window.api.connections.save(source)
    const merged = withSecrets(saved, source)
    setForm(merged)
    setSelectedId(saved.id)
    setDirty(false)
    await loadConnections()
    return merged
  }

  async function connect() {
    const v = validate()
    if (v) return setError(v)
    await withProgress('connect', async (requestId) => {
      const cfg = await saveOnly()
      const info = await window.api.session.open(cfg, { openDatabase: true, requestId })
      setSession(info)
      void refreshSchema()
    })
  }

  async function test() {
    const v = validate()
    if (v) return setError(v)
    await withProgress('test', async (requestId) => {
      const info = await window.api.session.open(normalised(), { openDatabase: true, requestId })
      await window.api.session.close(info.sessionId)
      const db = info.db
      toast('success', 'Connection succeeded', db ? `${db.serverVersion} · ${db.label}` : info.target)
    })
  }

  async function save() {
    const v = validate(false)
    if (v) return setError(v)
    try {
      await saveOnly()
      toast('success', 'Connection saved')
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  async function remove(c: ConnectionConfig, e: React.MouseEvent) {
    e.stopPropagation()
    const ok = await confirm(`Delete connection "${c.name}"?`, 'Saved credentials for it will be removed too.', 'Delete', true)
    if (!ok) return
    await window.api.connections.remove(c.id)
    await loadConnections()
    if (selectedId === c.id) startNew()
  }

  async function browse() {
    const v = validate(false)
    if (v) return setError(v)
    await withProgress('browse', async (requestId) => {
      const info = await window.api.session.open(normalised(), { openDatabase: false, requestId })
      setBrowser({ sessionId: info.sessionId })
    })
  }

  function closeBrowser() {
    if (browser) void window.api.session.close(browser.sessionId)
    setBrowser(null)
  }

  function pasteUrl() {
    void navigator.clipboard.readText().then((text) => {
      const parsed = parsePostgresUrl(text)
      if (!parsed) {
        toast('error', 'Clipboard does not contain a PostgreSQL URL', 'Expected something like postgres://user:password@host:5432/database')
        return
      }
      updatePg(parsed)
      toast('success', 'Connection details filled in from the URL')
    })
  }

  const encryption = appInfo?.encryptionAvailable ?? false
  const disabled = busy !== null
  const pg = form.pg
  const showChooser = !selectedId && !kindChosen

  return (
    <div className="app-frame">
      <TitleBar center={<span className="app-title">SQLite SSH</span>} />
      <div className="connect-screen">
        <aside className="conn-list">
          <div className="conn-list-header">
            <span>Connections</span>
            <button className="btn ghost small" onClick={startNew} title="New connection" data-testid="new-connection">
              <Icon name="plus" /> New
            </button>
          </div>
          <div className="conn-items">
            {connections.length === 0 ? (
              <div className="conn-empty">
                No saved connections yet.
                <br />
                Pick a database type to add one.
              </div>
            ) : (
              connections.map((c) => (
                <div key={c.id} className={`conn-item ${c.id === selectedId ? 'active' : ''}`} onClick={() => select(c)} onDoubleClick={() => void connect()}>
                  <span className="conn-dot" style={c.color ? { background: c.color } : undefined} />
                  <div className="conn-text">
                    <div className="conn-name">{c.name}</div>
                    <div className="conn-sub">{describeTarget(c)}</div>
                    <div className="conn-sub">{c.kind === 'postgres' ? (c.pg?.tunnel ? `via ssh ${c.ssh.username}@${c.ssh.host}` : KIND_LABELS.postgres) : c.remotePath}</div>
                  </div>
                  <span className={`kind-badge ${c.kind}`}>{c.kind === 'postgres' ? 'PG' : 'SQLite'}</span>
                  <button className="btn ghost icon small conn-delete" title="Delete" onClick={(e) => void remove(c, e)}>
                    <Icon name="trash" />
                  </button>
                </div>
              ))
            )}
          </div>
        </aside>

        <section
          className="conn-form"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type !== 'checkbox' && !disabled && !showChooser) {
              e.preventDefault()
              void connect()
            }
          }}
        >
          <div className="conn-form-inner">
            {showChooser ? (
              <>
                <h1>
                  <Icon name="database" size={20} />
                  New connection
                </h1>
                <p className="lede">What kind of database do you want to connect to?</p>
                <div className="kind-chooser">
                  <button type="button" className="kind-card sqlite" onClick={() => chooseKind('sqlite')} data-testid="choose-sqlite">
                    <span className="kind-icon">
                      <Icon name="file" size={18} />
                    </span>
                    <span className="kind-title">SQLite over SSH</span>
                    <span className="kind-desc">A .db or .sqlite file on a server you can reach with SSH. Queries run on that host; the file never leaves it.</span>
                  </button>
                  <button type="button" className="kind-card postgres" onClick={() => chooseKind('postgres')} data-testid="choose-postgres">
                    <span className="kind-icon">
                      <Icon name="database" size={18} />
                    </span>
                    <span className="kind-title">PostgreSQL</span>
                    <span className="kind-desc">A PostgreSQL server reached directly over the network, or through an SSH tunnel when it only listens locally.</span>
                  </button>
                </div>
              </>
            ) : (
              <>
                <h1>
                  <Icon name="database" size={20} />
                  {selectedId ? form.name || 'Connection' : 'New connection'}
                  <span className={`kind-badge ${form.kind}`}>{KIND_LABELS[form.kind]}</span>
                </h1>
                <p className="lede">
                  {form.kind === 'sqlite'
                    ? 'Open an SQLite file that lives on another machine, over SSH. Queries run on the remote host; nothing is copied locally.'
                    : 'Connect to a PostgreSQL server. Use the SSH tunnel option for servers that only accept local connections.'}
                </p>

                <div className="form-grid">
                  <div className="field">
                    <label>Name</label>
                    <input className="text" value={form.name} placeholder="Production analytics" onChange={(e) => update({ name: e.target.value })} data-testid="conn-name" />
                  </div>
                  <div className="field">
                    <label>Database type</label>
                    <div className="segmented">
                      {(['sqlite', 'postgres'] as const).map((k) => (
                        <button key={k} type="button" className={form.kind === k ? 'active' : ''} onClick={() => chooseKind(k)}>
                          {KIND_LABELS[k]}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {form.kind === 'sqlite' ? (
                  <>
                    <div className="form-section">
                      <h2>SSH host</h2>
                      <SshFields ssh={form.ssh} onChange={updateSsh} encryption={encryption} idPrefix="ssh" />
                    </div>
                    <div className="form-section">
                      <h2>Database file</h2>
                      <div className="form-grid">
                        <div className="field full">
                          <label>Path on remote host</label>
                          <div className="row">
                            <input
                              className="text mono"
                              value={form.remotePath ?? ''}
                              placeholder="/var/lib/app/data.sqlite or ~/app.db"
                              onChange={(e) => update({ remotePath: e.target.value })}
                              spellCheck={false}
                              data-testid="remote-path"
                            />
                            <button className="btn" type="button" disabled={disabled} onClick={() => void browse()}>
                              {busy === 'browse' ? <span className="spinner" /> : <Icon name="folder" />} Browse…
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="form-section">
                      <h2>Server</h2>
                      <div className="form-grid">
                        <div className="field">
                          <label>Host</label>
                          <input className="text mono" value={pg?.host ?? ''} placeholder="db.example.com" onChange={(e) => updatePg({ host: e.target.value })} spellCheck={false} data-testid="pg-host" />
                        </div>
                        <div className="field">
                          <label>Port</label>
                          <input className="text mono" type="number" min={1} max={65535} value={pg?.port ?? 5432} onChange={(e) => updatePg({ port: Number(e.target.value) })} data-testid="pg-port" />
                        </div>
                        <div className="field">
                          <label>Database</label>
                          <input className="text mono" value={pg?.database ?? ''} placeholder="app" onChange={(e) => updatePg({ database: e.target.value })} spellCheck={false} data-testid="pg-database" />
                        </div>
                        <div className="field">
                          <label>User</label>
                          <input className="text mono" value={pg?.user ?? ''} placeholder="postgres" onChange={(e) => updatePg({ user: e.target.value })} spellCheck={false} data-testid="pg-user" />
                        </div>
                        <div className="field full">
                          <label>Password</label>
                          <div className="row">
                            <input className="text" type="password" value={pg?.password ?? ''} onChange={(e) => updatePg({ password: e.target.value })} autoComplete="off" data-testid="pg-password" />
                            <label className="checkbox" title={encryption ? 'Stored encrypted with your OS keychain' : 'Encrypted storage is not available on this system'}>
                              <input type="checkbox" checked={!!pg?.savePassword && encryption} disabled={!encryption} onChange={(e) => updatePg({ savePassword: e.target.checked })} />
                              Save
                            </label>
                          </div>
                        </div>
                        <div className="field">
                          <label>SSL</label>
                          <select className="select" value={pg?.sslMode ?? 'prefer'} onChange={(e) => updatePg({ sslMode: e.target.value as SslMode })} title={SSL_MODES.find((m) => m.value === pg?.sslMode)?.hint} data-testid="pg-ssl">
                            {SSL_MODES.map((m) => (
                              <option key={m.value} value={m.value}>
                                {m.label} — {m.hint}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="field">
                          <label>Shortcut</label>
                          <button className="btn" type="button" onClick={pasteUrl} title="Fill the fields from a postgres:// URL in your clipboard">
                            <Icon name="copy" /> Paste connection URL
                          </button>
                        </div>
                      </div>
                    </div>
                    <div className={`form-section ${pg?.tunnel ? 'tunnel' : ''}`}>
                      <label className="checkbox">
                        <input type="checkbox" checked={!!pg?.tunnel} onChange={(e) => updatePg({ tunnel: e.target.checked })} data-testid="pg-tunnel" />
                        Connect through an SSH tunnel
                      </label>
                      {pg?.tunnel ? (
                        <>
                          <p className="hint" style={{ margin: '8px 0 12px' }}>
                            The database host and port above are resolved from the SSH host, so <code>localhost:5432</code> means the server on that machine.
                          </p>
                          <SshFields ssh={form.ssh} onChange={updateSsh} encryption={encryption} idPrefix="tunnel" />
                        </>
                      ) : null}
                    </div>
                  </>
                )}

                <div className="form-section">
                  <h2>Options</h2>
                  <div className="form-grid">
                    <div className="field">
                      <label>Access</label>
                      <label className="checkbox">
                        <input type="checkbox" checked={!!form.readOnly} onChange={(e) => update({ readOnly: e.target.checked })} />
                        Open read-only
                      </label>
                      <span className="hint">
                        {form.kind === 'sqlite' ? 'The file is opened in read-only mode.' : 'Sets the session to read-only transactions by default.'}
                      </span>
                    </div>
                    <div className="field">
                      <label>Colour</label>
                      <div className="swatches">
                        <button type="button" className={`swatch none ${!form.color ? 'active' : ''}`} onClick={() => update({ color: undefined })} title="None" />
                        {COLORS.map((c) => (
                          <button key={c} type="button" className={`swatch ${form.color === c ? 'active' : ''}`} style={{ background: c }} onClick={() => update({ color: c })} />
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="form-actions">
                  <button className="btn" disabled={disabled} onClick={() => void test()}>
                    {busy === 'test' ? <span className="spinner" /> : null} Test
                  </button>
                  <button className="btn" disabled={disabled} onClick={() => void save()}>
                    Save{dirty ? ' *' : ''}
                  </button>
                  <span className="spacer" />
                  <button className="btn primary" disabled={disabled} onClick={() => void connect()} data-testid="connect-button">
                    {busy === 'connect' ? <span className="spinner" /> : <Icon name="arrow-right" />} Connect
                  </button>
                </div>
                {busy && progress ? (
                  <div className="progress-line">
                    <span className="spinner" /> {progress}
                  </div>
                ) : null}
                {error ? <div className="error-box">{error}</div> : null}

                <div className="requirements">
                  {form.kind === 'sqlite' ? (
                    <>
                      The remote host needs <code>python3</code> (any version from 3.5, standard library only). A small helper script is sent over the SSH
                      connection each time you connect; nothing is installed on the server.
                    </>
                  ) : (
                    <>
                      Works with PostgreSQL 12 and newer. Rows are edited by primary key, so tables without one are read-only in the grid.
                    </>
                  )}{' '}
                  Host keys are checked against your <code>~/.ssh/known_hosts</code> and remembered after you accept them.
                </div>
              </>
            )}
          </div>
        </section>
      </div>
      {browser ? (
        <RemoteFileBrowser
          sessionId={browser.sessionId}
          initialPath={form.remotePath}
          onPick={(p) => {
            update({ remotePath: p })
            closeBrowser()
          }}
          onClose={closeBrowser}
        />
      ) : null}
    </div>
  )
}
