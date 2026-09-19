import { useEffect, useState } from 'react'
import type { ConnectionConfig } from '@shared/types'
import { useStore } from '@/store'
import { TitleBar } from '@/components/TitleBar'
import { Icon } from '@/components/Icons'
import { RemoteFileBrowser } from '@/components/RemoteFileBrowser'
import { errorMessage } from '@/lib/util'

const COLORS = ['#5b93ff', '#3ecf8e', '#e6a23c', '#ff5f57', '#b57bee', '#38bdf8']

function emptyConfig(): ConnectionConfig {
  return {
    id: '',
    name: '',
    host: '',
    port: 22,
    username: '',
    auth: 'key',
    remotePath: '',
    readOnly: false,
    savePassword: true,
    savePassphrase: true
  }
}

type Busy = null | 'connect' | 'test' | 'browse'

export function ConnectScreen() {
  const connections = useStore((s) => s.connections)
  const appInfo = useStore((s) => s.appInfo)
  const toast = useStore((s) => s.toast)
  const setSession = useStore((s) => s.setSession)
  const refreshSchema = useStore((s) => s.refreshSchema)
  const loadConnections = useStore((s) => s.loadConnections)
  const confirm = useStore((s) => s.confirm)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [form, setForm] = useState<ConnectionConfig>(emptyConfig())
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

  function select(c: ConnectionConfig) {
    setSelectedId(c.id)
    setForm({ ...emptyConfig(), ...c })
    setDirty(false)
    setError(null)
  }

  function newConnection() {
    setSelectedId(null)
    setForm(emptyConfig())
    setDirty(false)
    setError(null)
  }

  function validate(needPath = true): string | null {
    if (!form.host.trim()) return 'Host is required.'
    if (!form.username.trim()) return 'Username is required.'
    if (!Number.isInteger(Number(form.port)) || Number(form.port) < 1 || Number(form.port) > 65535) return 'Port must be between 1 and 65535.'
    if (needPath && !form.remotePath.trim()) return 'Enter the path of the SQLite file on the remote host.'
    return null
  }

  async function withProgress<T>(kind: Busy, fn: (requestId: string) => Promise<T>): Promise<T | undefined> {
    setBusy(kind)
    setError(null)
    setProgress('')
    const requestId = crypto.randomUUID()
    const unsub = window.api.ssh.onProgress((e) => {
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

  const normalised = (): ConnectionConfig => ({
    ...form,
    host: form.host.trim(),
    username: form.username.trim(),
    port: Number(form.port) || 22,
    remotePath: form.remotePath.trim(),
    name: form.name.trim() || `${form.username.trim()}@${form.host.trim()}`
  })

  async function saveOnly(): Promise<ConnectionConfig> {
    const saved = await window.api.connections.save(normalised())
    const merged = { ...saved, password: form.password, passphrase: form.passphrase }
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
      const info = await window.api.ssh.connect(cfg, { openDatabase: true, requestId })
      setSession(info)
      void refreshSchema()
    })
  }

  async function test() {
    const v = validate()
    if (v) return setError(v)
    await withProgress('test', async (requestId) => {
      const info = await window.api.ssh.connect(normalised(), { openDatabase: true, requestId })
      await window.api.ssh.disconnect(info.sessionId)
      toast(
        'success',
        'Connection succeeded',
        `SQLite ${info.db?.sqliteVersion} via ${info.interpreter} (Python ${info.db?.pythonVersion}) on ${info.db?.hostname}`
      )
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
    if (selectedId === c.id) newConnection()
  }

  async function browse() {
    const v = validate(false)
    if (v) return setError(v)
    await withProgress('browse', async (requestId) => {
      const info = await window.api.ssh.connect(normalised(), { openDatabase: false, requestId })
      setBrowser({ sessionId: info.sessionId })
    })
  }

  function closeBrowser() {
    if (browser) void window.api.ssh.disconnect(browser.sessionId)
    setBrowser(null)
  }

  async function pickKey() {
    const p = await window.api.dialog.pickPrivateKey()
    if (p) update({ privateKeyPath: p })
  }

  const encryption = appInfo?.encryptionAvailable ?? false
  const disabled = busy !== null

  return (
    <div className="app-frame">
      <TitleBar center={<span className="app-title">SQLite SSH</span>} />
      <div className="connect-screen">
        <aside className="conn-list">
          <div className="conn-list-header">
            <span>Connections</span>
            <button className="btn ghost small" onClick={newConnection} title="New connection">
              <Icon name="plus" /> New
            </button>
          </div>
          <div className="conn-items">
            {connections.length === 0 ? (
              <div className="conn-empty">
                No saved connections yet.
                <br />
                Fill in the form to add one.
              </div>
            ) : (
              connections.map((c) => (
                <div key={c.id} className={`conn-item ${c.id === selectedId ? 'active' : ''}`} onClick={() => select(c)} onDoubleClick={() => void connect()}>
                  <span className="conn-dot" style={c.color ? { background: c.color } : undefined} />
                  <div className="conn-text">
                    <div className="conn-name">{c.name}</div>
                    <div className="conn-sub">
                      {c.username}@{c.host}
                      {c.port !== 22 ? `:${c.port}` : ''}
                    </div>
                    <div className="conn-sub">{c.remotePath}</div>
                  </div>
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
            if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type !== 'checkbox' && !disabled) {
              e.preventDefault()
              void connect()
            }
          }}
        >
          <div className="conn-form-inner">
            <h1>
              <Icon name="database" size={20} />
              {selectedId ? form.name || 'Connection' : 'New connection'}
            </h1>
            <p className="lede">Open an SQLite file that lives on another machine, over SSH. Queries run on the remote host; nothing is copied locally.</p>

            <div className="form-grid">
              <div className="field full">
                <label>Name</label>
                <input className="text" value={form.name} placeholder="Production analytics" onChange={(e) => update({ name: e.target.value })} />
              </div>
              <div className="field">
                <label>Host</label>
                <input className="text mono" value={form.host} placeholder="db.example.com" onChange={(e) => update({ host: e.target.value })} spellCheck={false} />
              </div>
              <div className="field">
                <label>Port</label>
                <input
                  className="text mono"
                  type="number"
                  min={1}
                  max={65535}
                  value={form.port}
                  onChange={(e) => update({ port: Number(e.target.value) })}
                />
              </div>
              <div className="field">
                <label>Username</label>
                <input className="text mono" value={form.username} placeholder="ubuntu" onChange={(e) => update({ username: e.target.value })} spellCheck={false} />
              </div>
              <div className="field">
                <label>Authentication</label>
                <div className="segmented">
                  {(['key', 'agent', 'password'] as const).map((m) => (
                    <button key={m} type="button" className={form.auth === m ? 'active' : ''} onClick={() => update({ auth: m })}>
                      {m === 'key' ? 'Private key' : m === 'agent' ? 'SSH agent' : 'Password'}
                    </button>
                  ))}
                </div>
              </div>

              {form.auth === 'password' && (
                <div className="field full">
                  <label>Password</label>
                  <div className="row">
                    <input className="text" type="password" value={form.password ?? ''} onChange={(e) => update({ password: e.target.value })} autoComplete="off" />
                    <label className="checkbox" title={encryption ? 'Stored encrypted with your OS keychain' : 'Encrypted storage is not available on this system'}>
                      <input type="checkbox" checked={!!form.savePassword && encryption} disabled={!encryption} onChange={(e) => update({ savePassword: e.target.checked })} />
                      Save
                    </label>
                  </div>
                </div>
              )}

              {form.auth === 'key' && (
                <>
                  <div className="field full">
                    <label>Private key</label>
                    <div className="row">
                      <input
                        className="text mono"
                        value={form.privateKeyPath ?? ''}
                        placeholder="~/.ssh/id_ed25519 (auto-detected when empty)"
                        onChange={(e) => update({ privateKeyPath: e.target.value })}
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
                        value={form.passphrase ?? ''}
                        placeholder="Leave empty for an unencrypted key"
                        onChange={(e) => update({ passphrase: e.target.value })}
                        autoComplete="off"
                      />
                      <label className="checkbox" title={encryption ? 'Stored encrypted with your OS keychain' : 'Encrypted storage is not available on this system'}>
                        <input type="checkbox" checked={!!form.savePassphrase && encryption} disabled={!encryption} onChange={(e) => update({ savePassphrase: e.target.checked })} />
                        Save
                      </label>
                    </div>
                  </div>
                </>
              )}

              {form.auth === 'agent' && (
                <div className="field full">
                  <span className="hint">
                    Uses the identities loaded in your running SSH agent (<code>ssh-add -l</code>).
                  </span>
                </div>
              )}
            </div>

            <div className="form-section">
              <h2>Database</h2>
              <div className="form-grid">
                <div className="field full">
                  <label>Path on remote host</label>
                  <div className="row">
                    <input
                      className="text mono"
                      value={form.remotePath}
                      placeholder="/var/lib/app/data.sqlite or ~/app.db"
                      onChange={(e) => update({ remotePath: e.target.value })}
                      spellCheck={false}
                    />
                    <button className="btn" type="button" disabled={disabled} onClick={() => void browse()}>
                      {busy === 'browse' ? <span className="spinner" /> : <Icon name="folder" />} Browse…
                    </button>
                  </div>
                </div>
                <div className="field">
                  <label>Options</label>
                  <label className="checkbox">
                    <input type="checkbox" checked={!!form.readOnly} onChange={(e) => update({ readOnly: e.target.checked })} />
                    Open read-only
                  </label>
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
              The remote host needs <code>python3</code> (any version from 3.5, standard library only). A small helper script is sent over the SSH
              connection each time you connect; nothing is installed on the server. Host keys are checked against your <code>~/.ssh/known_hosts</code>{' '}
              and remembered after you accept them.
            </div>
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
