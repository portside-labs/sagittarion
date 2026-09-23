import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConnectionConfig, DatabaseKind, PostgresConfig, SshConfig, SshProfile, SslMode } from '@shared/types'
import { KIND_LABELS } from '@shared/types'
import { DbLogo } from '@/components/DbLogo'
import { defaultSsh, describeSsh, describeTarget, newConnection, normalizeConnection, parsePostgresUrl, resolveSshProfile, usesSsh } from '@shared/connections'
import { useStore } from '@/store'
import { Icon } from '@/components/Icons'
import { RemoteFileBrowser } from '@/components/RemoteFileBrowser'
import { ContextMenu, type MenuItem } from '@/components/ContextMenu'
import { groupConnections, groupNames, loadCollapsedGroups, saveCollapsedGroups } from '@/lib/connection-groups'
import { errorMessage } from '@/lib/util'

const COLORS = ['#5b93ff', '#3ecf8e', '#e6a23c', '#ff5f57', '#b57bee', '#38bdf8']
const SSL_MODES: { value: SslMode; label: string; hint: string }[] = [
  { value: 'prefer', label: 'Prefer', hint: 'Encrypt when the server supports it' },
  { value: 'require', label: 'Require', hint: 'Encrypt, do not verify the certificate' },
  { value: 'verify-full', label: 'Verify full', hint: 'Encrypt and verify the certificate and host name' },
  { value: 'disable', label: 'Disable', hint: 'Plain connection' }
]

type Busy = null | 'connect' | 'test' | 'browse'

/** Whether to store the SSH fields being typed as a reusable profile, and under which name. */
interface ProfileDraft {
  save: boolean
  name: string
}

const AUTH_LABELS: Record<SshConfig['auth'], string> = { key: 'private key', agent: 'SSH agent', password: 'password' }

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
// SSH host: a saved profile, or details typed here (optionally saved as one)
// ---------------------------------------------------------------------------

function SshSection({
  form,
  profiles,
  draft,
  encryption,
  idPrefix,
  onSsh,
  onProfile,
  onDraft,
  onForget
}: {
  form: ConnectionConfig
  profiles: SshProfile[]
  draft: ProfileDraft
  encryption: boolean
  idPrefix: string
  onSsh: (patch: Partial<SshConfig>) => void
  onProfile: (id: string | undefined, prefill?: SshConfig) => void
  onDraft: (d: ProfileDraft) => void
  onForget: (p: SshProfile) => void
}) {
  const active = form.sshProfileId ? profiles.find((p) => p.id === form.sshProfileId) : undefined
  const edit = () => {
    if (!active) return
    const { id: _id, name, createdAt: _c, lastUsedAt: _l, ...ssh } = active
    onProfile(undefined, ssh)
    onDraft({ save: true, name })
  }
  return (
    <>
      {profiles.length ? (
        <div className="field ssh-profile-pick">
          <label>SSH profile</label>
          <select className="select" value={active ? active.id : ''} onChange={(e) => onProfile(e.target.value || undefined)} data-testid={`${idPrefix}-profile-select`}>
            <option value="">Enter details below</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {active ? (
        <div className="ssh-profile-summary" data-testid={`${idPrefix}-profile-summary`}>
          <Icon name="terminal" />
          <span className="mono">
            {describeSsh(active)} · {AUTH_LABELS[active.auth]}
          </span>
          <span className="spacer" />
          <button className="btn small" type="button" onClick={edit} title="Change these details; saving keeps the profile up to date" data-testid={`${idPrefix}-profile-edit`}>
            Edit
          </button>
          <button className="btn small ghost" type="button" onClick={() => onForget(active)} title="Delete this profile" data-testid={`${idPrefix}-profile-forget`}>
            Forget
          </button>
        </div>
      ) : (
        <>
          <SshFields ssh={form.ssh} onChange={onSsh} encryption={encryption} idPrefix={idPrefix} />
          <div className="save-profile">
            <label className="checkbox">
              <input type="checkbox" checked={draft.save} onChange={(e) => onDraft({ ...draft, save: e.target.checked })} data-testid={`${idPrefix}-save-profile`} />
              Save as an SSH profile to reuse for other connections
            </label>
            {draft.save ? (
              <input
                className="text save-profile-name"
                value={draft.name}
                placeholder={form.ssh.host ? `${form.ssh.username || 'user'}@${form.ssh.host}` : 'Profile name, e.g. Production box'}
                onChange={(e) => onDraft({ ...draft, name: e.target.value })}
                data-testid={`${idPrefix}-profile-name`}
              />
            ) : null}
          </div>
        </>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function ConnectScreen() {
  const connections = useStore((s) => s.connections)
  const sshProfiles = useStore((s) => s.sshProfiles)
  const sshProfilesLoaded = useStore((s) => s.sshProfilesLoaded)
  const loadSshProfiles = useStore((s) => s.loadSshProfiles)
  const appInfo = useStore((s) => s.appInfo)
  const toast = useStore((s) => s.toast)
  const setSession = useStore((s) => s.setSession)
  const refreshSchema = useStore((s) => s.refreshSchema)
  const loadConnections = useStore((s) => s.loadConnections)
  const confirm = useStore((s) => s.confirm)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)

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
  const [draft, setDraft] = useState<ProfileDraft>({ save: false, name: '' })
  /** 'new' while a group name is being typed in the form instead of picked from the list. */
  const [groupMode, setGroupMode] = useState<'new' | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => loadCollapsedGroups())
  const [groupMenu, setGroupMenu] = useState<{ x: number; y: number; name: string } | null>(null)
  const [connMenu, setConnMenu] = useState<{ x: number; y: number; conn: ConnectionConfig } | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const [renamingGroup, setRenamingGroup] = useState<{ from: string; value: string } | null>(null)
  const renameInFlight = useRef(false)
  const groups = useMemo(() => groupConnections(connections), [connections])
  const names = useMemo(() => groupNames(connections), [connections])

  // Open the most recent connection once both it and the profile list are known.
  useEffect(() => {
    if (initialised || !sshProfilesLoaded) return
    if (connections.length > 0) {
      select(connections[0])
      setInitialised(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections, sshProfilesLoaded, initialised])

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
    const cfg = normalizeConnection(c)
    // A profile that was deleted leaves the connection without SSH details; the form asks for them again.
    if (cfg.sshProfileId && sshProfilesLoaded && !sshProfiles.some((p) => p.id === cfg.sshProfileId)) cfg.sshProfileId = undefined
    setSelectedId(c.id)
    setForm(cfg)
    setKindChosen(true)
    setDirty(false)
    setError(null)
    setDraft({ save: false, name: '' })
    setGroupMode(null)
  }

  function startNew() {
    setSelectedId(null)
    setForm(newConnection('sqlite'))
    setKindChosen(false)
    setDirty(false)
    setError(null)
    setDraft({ save: false, name: '' })
    setGroupMode(null)
  }

  /** Point the connection at a saved profile, or back at typed details (optionally prefilled from a profile). */
  function useProfile(id: string | undefined, prefill?: SshConfig) {
    setForm((f) => ({ ...f, sshProfileId: id, ssh: prefill ?? (id ? defaultSsh() : f.ssh) }))
    setDirty(true)
  }

  async function forgetProfile(p: SshProfile) {
    const ok = await confirm(`Forget SSH profile "${p.name}"?`, 'Connections that use it will ask for SSH details again.', 'Forget', true)
    if (!ok) return
    await window.api.sshProfiles.remove(p.id)
    await loadSshProfiles()
    setForm((f) => (f.sshProfileId === p.id ? { ...f, sshProfileId: undefined } : f))
  }

  function chooseKind(kind: DatabaseKind) {
    setForm((f) => normalizeConnection({ ...f, kind, remotePath: kind === 'sqlite' ? f.remotePath ?? '' : f.remotePath, pg: kind === 'postgres' ? f.pg : f.pg }))
    setKindChosen(true)
    setDirty(true)
  }

  function validate(needTarget = true): string | null {
    const portOk = (p: number) => Number.isInteger(Number(p)) && Number(p) >= 1 && Number(p) <= 65535
    const profileActive = Boolean(form.sshProfileId && sshProfiles.some((p) => p.id === form.sshProfileId))
    if (usesSsh(form) && !profileActive) {
      if (!form.ssh.host.trim()) return 'SSH host is required.'
      if (!form.ssh.username.trim()) return 'SSH username is required.'
      if (!portOk(form.ssh.port)) return 'SSH port must be between 1 and 65535.'
      if (draft.save && !draft.name.trim()) return 'Give the SSH profile a name, or untick "Save as an SSH profile".'
    }
    if (form.kind === 'sqlite') {
      if (needTarget && !form.remotePath?.trim()) return form.remote ? 'Enter the path of the SQLite file on the SSH host.' : 'Choose the SQLite file to open.'
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
    const shown = resolveSshProfile(n, sshProfiles)
    n.name = form.name.trim() || (n.kind === 'sqlite' && !n.remote ? n.remotePath?.trim().split(/[\\/]/).pop() || 'SQLite file' : describeTarget(shown))
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

  /** Stores the typed SSH details as a profile (updating one with the same name) and points the connection at it. */
  async function saveDraftProfile(cfg: ConnectionConfig): Promise<ConnectionConfig> {
    if (!usesSsh(cfg) || cfg.sshProfileId || !draft.save || !draft.name.trim()) return cfg
    const name = draft.name.trim()
    const existing = sshProfiles.find((p) => p.name.toLowerCase() === name.toLowerCase())
    const profile = await window.api.sshProfiles.save({ ...cfg.ssh, id: existing?.id ?? '', name })
    await loadSshProfiles()
    setDraft({ save: false, name: '' })
    return { ...cfg, sshProfileId: profile.id, ssh: defaultSsh() }
  }

  async function saveOnly(): Promise<ConnectionConfig> {
    const source = await saveDraftProfile(normalised())
    const saved = await window.api.connections.save(source)
    const merged = withSecrets(saved, source)
    setForm(merged)
    setSelectedId(saved.id)
    setDirty(false)
    setGroupMode(null)
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

  /** A copy of a saved connection opens in the form with its name selected, ready to be renamed. */
  async function duplicate(c: ConnectionConfig, e?: React.MouseEvent) {
    e?.stopPropagation()
    try {
      const copy = await window.api.connections.duplicate(c.id)
      select(copy)
      await loadConnections()
      requestAnimationFrame(() => {
        nameInputRef.current?.focus()
        nameInputRef.current?.select()
      })
    } catch (err) {
      toast('error', 'Could not duplicate the connection', errorMessage(err))
    }
  }

  const connMenuItems = (c: ConnectionConfig): MenuItem[] => [
    { label: 'Duplicate', onClick: () => void duplicate(c) },
    { separator: true },
    { label: 'Delete…', danger: true, onClick: () => void remove(c) }
  ]

  async function remove(c: ConnectionConfig, e?: React.MouseEvent) {
    e?.stopPropagation()
    const ok = await confirm(`Delete connection "${c.name}"?`, 'Saved credentials for it will be removed too.', 'Delete', true)
    if (!ok) return
    await window.api.connections.remove(c.id)
    await loadConnections()
    if (selectedId === c.id) startNew()
  }

  const toggleGroup = (name: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      saveCollapsedGroups(next)
      return next
    })
  }

  /** Moves connections into a group (null for none) and keeps the open form in step without touching its other edits. */
  async function moveToGroup(members: ConnectionConfig[], to: string | null) {
    await window.api.connections.setGroup(members.map((c) => c.id), to)
    if (members.some((c) => c.id === selectedId)) setForm((f) => ({ ...f, group: to ?? undefined }))
    await loadConnections()
  }

  async function renameGroup(from: string, to: string) {
    if (renameInFlight.current) return
    setRenamingGroup(null)
    const name = to.trim()
    if (!name || name === from) return
    renameInFlight.current = true
    try {
      const members = groups.find((g) => g.name === from)?.connections ?? []
      await moveToGroup(members, name)
      setCollapsedGroups((prev) => {
        if (!prev.has(from)) return prev
        const next = new Set(prev)
        next.delete(from)
        next.add(name)
        saveCollapsedGroups(next)
        return next
      })
    } catch (e) {
      toast('error', 'Could not rename the group', errorMessage(e))
    } finally {
      renameInFlight.current = false
    }
  }

  async function removeGroup(name: string) {
    const members = groups.find((g) => g.name === name)?.connections ?? []
    const ok = await confirm(`Remove the group "${name}"?`, 'Its connections are kept and listed on their own.', 'Remove group')
    if (!ok) return
    try {
      await moveToGroup(members, null)
    } catch (e) {
      toast('error', 'Could not remove the group', errorMessage(e))
    }
  }

  const groupMenuItems = (name: string): MenuItem[] => [
    { label: 'Rename group…', onClick: () => setRenamingGroup({ from: name, value: name }) },
    {
      label: 'New connection in this group',
      onClick: () => {
        startNew()
        setForm((f) => ({ ...f, group: name }))
      }
    },
    { separator: true },
    { label: 'Remove group', danger: true, onClick: () => void removeGroup(name) }
  ]

  async function browse() {
    if (form.kind === 'sqlite' && !form.remote) {
      const picked = await window.api.dialog.pickSqliteFile(form.remotePath)
      if (picked) update({ remotePath: picked })
      return
    }
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
      <div className="connect-screen">
        <aside className="conn-list">
          <div className="conn-list-header">
            <span className="spacer" />
            <button className="btn ghost small" onClick={startNew} title="New connection" data-testid="new-connection">
              <Icon name="plus" /> New
            </button>
          </div>
          <div className="conn-section-header tree-section-header">
            <span>Connections</span>
            {connections.length ? <span className="count">{connections.length}</span> : null}
          </div>
          <div className="conn-items">
            {connections.length === 0 ? (
              <div className="conn-empty">
                No saved connections yet.
                <br />
                Pick a database type to add one.
              </div>
            ) : (
              groups.map((g) => {
                const collapsed = g.name !== null && collapsedGroups.has(g.name)
                const renaming = g.name !== null && renamingGroup?.from === g.name ? renamingGroup : null
                return (
                  <div key={g.name ?? '\u0000'} className={`conn-group ${g.name !== null ? 'named' : ''}`} data-group={g.name ?? undefined}>
                    {g.name === null ? null : renaming ? (
                      <div className="conn-group-header renaming">
                        <Icon name="folder" size={13} />
                        <input
                          className="text"
                          autoFocus
                          value={renaming.value}
                          onChange={(e) => setRenamingGroup({ from: renaming.from, value: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void renameGroup(renaming.from, renaming.value)
                            if (e.key === 'Escape') setRenamingGroup(null)
                          }}
                          onBlur={() => void renameGroup(renaming.from, renaming.value)}
                          data-testid="conn-group-rename"
                        />
                      </div>
                    ) : (
                      <div
                        className="conn-group-header"
                        onClick={() => toggleGroup(g.name!)}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          setGroupMenu({ x: e.clientX, y: e.clientY, name: g.name! })
                        }}
                        title={collapsed ? 'Show these connections' : 'Hide these connections'}
                        data-testid="conn-group-header"
                      >
                        <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} />
                        <span className="conn-group-name">{g.name}</span>
                        <span className="count">{g.connections.length}</span>
                        <button
                          className="btn ghost icon small conn-group-menu"
                          title="Group options"
                          onClick={(e) => {
                            e.stopPropagation()
                            const r = e.currentTarget.getBoundingClientRect()
                            setGroupMenu({ x: r.left, y: r.bottom + 4, name: g.name! })
                          }}
                          data-testid="conn-group-options"
                        >
                          <Icon name="settings" size={12} />
                        </button>
                      </div>
                    )}
                    {collapsed
                      ? null
                      : g.connections.map((c) => (
                <div
                  key={c.id}
                  className={`conn-item ${c.id === selectedId ? 'active' : ''}`}
                  onClick={() => select(c)}
                  onDoubleClick={() => void connect()}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setConnMenu({ x: e.clientX, y: e.clientY, conn: c })
                  }}
                >
                  <span className="conn-dot" style={c.color ? { background: c.color } : undefined} />
                  <div className="conn-text">
                    <div className="conn-name">{c.name}</div>
                    <div className="conn-sub">{describeTarget(resolveSshProfile(c, sshProfiles))}</div>
                    <div className="conn-sub">{c.kind === 'postgres' ? (c.pg?.tunnel ? `via ssh ${describeSsh(resolveSshProfile(c, sshProfiles).ssh)}` : KIND_LABELS.postgres) : c.remotePath}</div>
                  </div>
                  <span className={`conn-kind ${c.kind}`}>
                    <DbLogo kind={c.kind} size={20} />
                  </span>
                  <button className="btn ghost icon small conn-duplicate" title="Duplicate" onClick={(e) => void duplicate(c, e)} data-testid="conn-duplicate">
                    <Icon name="copy" />
                  </button>
                  <button className="btn ghost icon small conn-delete" title="Delete" onClick={(e) => void remove(c, e)} data-testid="conn-delete">
                    <Icon name="trash" />
                  </button>
                </div>
                        ))}
                  </div>
                )
              })
            )}
          </div>
          {groupMenu ? <ContextMenu x={groupMenu.x} y={groupMenu.y} items={groupMenuItems(groupMenu.name)} onClose={() => setGroupMenu(null)} /> : null}
          {connMenu ? <ContextMenu x={connMenu.x} y={connMenu.y} items={connMenuItems(connMenu.conn)} onClose={() => setConnMenu(null)} /> : null}
        </aside>

        <div className="connect-main">
          <div className="connect-topbar">
            <button className="btn ghost icon small" title="Settings" onClick={() => setSettingsOpen(true)} data-testid="open-settings">
              <Icon name="settings" />
            </button>
          </div>
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
                  <button type="button" className="kind-card sqlite" onClick={() => chooseKind('sqlite')} title="An SQLite file on a host you reach over SSH" data-testid="choose-sqlite">
                    <span className="kind-icon sqlite">
                      <DbLogo kind="sqlite" size={46} />
                    </span>
                    <span className="kind-title">SQLite</span>
                  </button>
                  <button type="button" className="kind-card postgres" onClick={() => chooseKind('postgres')} title="A PostgreSQL server, directly or through an SSH tunnel" data-testid="choose-postgres">
                    <span className="kind-icon postgres">
                      <DbLogo kind="postgres" size={48} />
                    </span>
                    <span className="kind-title">PostgreSQL</span>
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="conn-head">
                  <h1 className="conn-title">{selectedId ? form.name || 'Connection' : 'New connection'}</h1>
                  <div className="conn-kind-line" data-testid="conn-kind">
                    <DbLogo kind={form.kind} size={20} />
                    <span>{KIND_LABELS[form.kind]}</span>
                  </div>
                </div>

                <div className="form-grid">
                  <div className="field">
                    <label>Name</label>
                    <input ref={nameInputRef} className="text" value={form.name} placeholder="Production analytics" onChange={(e) => update({ name: e.target.value })} data-testid="conn-name" />
                  </div>
                  <div className="field">
                    <label>Group</label>
                    {groupMode === 'new' ? (
                      <div className="group-new">
                        <input
                          className="text"
                          autoFocus
                          value={form.group ?? ''}
                          placeholder="e.g. Acme or Production"
                          onChange={(e) => update({ group: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                              setGroupMode(null)
                              update({ group: undefined })
                            }
                          }}
                          data-testid="conn-group-name"
                        />
                        <button
                          className="btn ghost icon"
                          title="Cancel"
                          onClick={() => {
                            setGroupMode(null)
                            update({ group: undefined })
                          }}
                        >
                          <Icon name="x" size={12} />
                        </button>
                      </div>
                    ) : (
                      <select
                        className="select"
                        value={!form.group ? '' : names.includes(form.group) ? form.group : '__unsaved__'}
                        onChange={(e) => {
                          const v = e.target.value
                          if (v === '__new__') {
                            setGroupMode('new')
                            update({ group: '' })
                          } else update({ group: v || undefined })
                        }}
                        data-testid="conn-group"
                      >
                        <option value="">No group</option>
                        {names.map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                        {form.group && !names.includes(form.group) ? <option value="__unsaved__">{form.group}</option> : null}
                        <option value="__new__">New group…</option>
                      </select>
                    )}
                    <span className="hint">Keeps related connections together, such as one app's environments.</span>
                  </div>
                </div>

                {form.kind === 'sqlite' ? (
                  <>
                    <div className="form-section">
                      <h2>Database file</h2>
                      <div className="form-grid">
                        <div className="field full">
                          <label>{form.remote ? 'Path on the SSH host' : 'Path on this computer'}</label>
                          <div className="row">
                            <input
                              className="text mono"
                              value={form.remotePath ?? ''}
                              placeholder={form.remote ? '/var/lib/app/data.sqlite or ~/app.db' : '~/Documents/app.db'}
                              onChange={(e) => update({ remotePath: e.target.value })}
                              spellCheck={false}
                              data-testid="sqlite-path"
                            />
                            <button className="btn" type="button" disabled={disabled} onClick={() => void browse()} data-testid="sqlite-browse">
                              {busy === 'browse' ? <span className="spinner" /> : <Icon name="folder" />} Browse…
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className={`form-section ${form.remote ? 'tunnel' : ''}`}>
                      <label className="checkbox">
                        <input type="checkbox" checked={!!form.remote} onChange={(e) => update({ remote: e.target.checked })} data-testid="sqlite-remote" />
                        The file is on another machine: connect over SSH
                      </label>
                      {form.remote ? (
                        <>
                          <p className="hint" style={{ margin: '8px 0 12px' }}>
                            Queries run on that host through a small Python helper sent over the connection; the file never leaves it.
                          </p>
                          <SshSection form={form} profiles={sshProfiles} draft={draft} encryption={encryption} idPrefix="ssh" onSsh={updateSsh} onProfile={useProfile} onDraft={setDraft} onForget={(p) => void forgetProfile(p)} />
                        </>
                      ) : null}
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
                          <SshSection form={form} profiles={sshProfiles} draft={draft} encryption={encryption} idPrefix="tunnel" onSsh={updateSsh} onProfile={useProfile} onDraft={setDraft} onForget={(p) => void forgetProfile(p)} />
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
                  {form.kind === 'sqlite' && !form.remote ? (
                    <>
                      Needs <code>python3</code> on this computer (any version from 3.5, standard library only); on macOS the Xcode Command Line Tools or
                      Homebrew provide it. The file is opened in place.
                    </>
                  ) : form.kind === 'sqlite' ? (
                    <>
                      The remote host needs <code>python3</code> (any version from 3.5, standard library only). A small helper script is sent over the SSH
                      connection each time you connect; nothing is installed on the server.
                    </>
                  ) : (
                    <>
                      Works with PostgreSQL 12 and newer. Rows are edited by primary key, so tables without one are read-only in the grid.
                    </>
                  )}
                  {usesSsh(form) ? (
                    <>
                      {' '}
                      Host keys are checked against your <code>~/.ssh/known_hosts</code> and remembered after you accept them.
                    </>
                  ) : null}
                </div>
              </>
            )}
          </div>
        </section>
        </div>
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
