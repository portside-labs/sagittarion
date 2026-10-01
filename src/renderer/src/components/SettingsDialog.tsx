import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  BYOK_PROVIDERS,
  CONNECTION_TYPES,
  LOCAL_PROVIDERS,
  PROVIDERS,
  SCHEMA_BUDGETS,
  activeConnection,
  type AgentSettings,
  type AiConnection,
  type AiConnectionInput,
  type ConnectionType,
  type ProviderId
} from '@shared/ai'
import { DEFAULT_PRIVACY, PRIVACY_POLICIES, classifyEndpoint, privacyApplies, type PrivacyPolicyId, type PrivacySettings, type SemanticModelStatus } from '@shared/privacy'
import { formatBytes } from '@shared/export'
import { useStore, type SettingsTab } from '@/store'
import { ACCEPT_KEY_OPTIONS } from '@/lib/sql-complete'
import { CODE_FONTS, SYNTAX_PALETTES, THEMES, type SyntaxId, type ThemeId } from '@/lib/theme'
import { Modal } from './Modal'
import { Icon } from './Icons'
import { ConnectorsSettings } from './ConnectorsSettings'
import { InstructionsSettings } from './InstructionsSettings'
import { errorMessage } from '@/lib/util'

/** The sidebar, in alphabetical order so a new section lands in its place. */
const SETTINGS_TABS = [
  { id: 'models' as const, label: 'Models', icon: 'chat' as const },
  { id: 'appearance' as const, label: 'Appearance', icon: 'layout' as const },
  { id: 'connectors' as const, label: 'Connectors', icon: 'plug' as const },
  { id: 'instructions' as const, label: 'Instructions', icon: 'note' as const },
  { id: 'editor' as const, label: 'Editor', icon: 'code' as const }
].sort((a, b) => a.label.localeCompare(b.label))

/** Managed AI stays out of Settings until it is available. */
const OFFERED_TYPES = CONNECTION_TYPES.filter((t) => t.type !== 'managed')
/** "No account needed" only tells the kinds apart beside Managed AI, which needs one. */
const SHOW_ACCOUNT = OFFERED_TYPES.some((t) => t.type === 'managed')

/** The connection as it is being edited, before it is saved. */
interface Draft {
  type: ConnectionType
  provider: ProviderId
  baseUrl: string
  model: string
  embeddingModel: string
}

const DEFAULT_AGENT: AgentSettings = { schemaBudgetTokens: 8000, autoRun: true, sendSampleValues: false, readResults: true }

function draftFrom(c: AiConnection, model?: string): Draft {
  return { type: c.type, provider: c.provider, baseUrl: c.baseUrl, model: model || c.defaultModel, embeddingModel: c.embeddingModel }
}

const MODEL_BADGE: Record<SemanticModelStatus['state'], string | null> = {
  installed: 'Installed',
  'not-installed': 'Not installed',
  unsupported: 'Not available here',
  failed: 'Not installed',
  downloading: null
}

/** The on-device model's download, progress and removal, under its switch. */
/** Bars standing in for a statement, as [kind, width]: keywords, names and a string, in the code colours. */
const PREVIEW_LINES: [string, number][][] = [
  [['kw', 18], ['tx', 22], ['kw', 12], ['tx', 20]],
  [['kw', 14], ['tx', 16], ['str', 34]],
  [['kw', 16], ['tx', 8]]
]

/** A small picture of the window in a theme's colours: the title bar, the side panel and the editor. */
function ThemePreview({ theme }: { theme: ThemeId }) {
  return (
    <span className="theme-preview" data-theme={theme} aria-hidden="true">
      <span className="theme-preview-bar" />
      <span className="theme-preview-side">
        {[70, 52, 62].map((w, i) => (
          <span key={i} className="theme-preview-line">
            <span style={{ width: `${w}%` }} />
          </span>
        ))}
      </span>
      <span className="theme-preview-main">
        {PREVIEW_LINES.map((line, i) => (
          <span key={i} className="theme-preview-line">
            {line.map(([kind, w], j) => (
              <span key={j} className={kind} style={{ width: w }} />
            ))}
          </span>
        ))}
      </span>
    </span>
  )
}

/** Three lines of SQL in a set of code colours: a palette's own, or a theme's when `theme` is given instead. */
function SyntaxPreview({ syntax, theme }: { syntax?: SyntaxId; theme?: ThemeId }) {
  return (
    <span className="syntax-preview" data-syntax={syntax} data-theme={theme} aria-hidden="true">
      <span>
        <span className="kw">SELECT</span> name <span className="kw">FROM</span> users
      </span>
      <span>
        <span className="kw">WHERE</span> city = <span className="str">'Oslo'</span>
      </span>
      <span>
        {'  '}
        <span className="kw">AND</span> age &gt; <span className="num">42</span> <span className="cmt">-- ok</span>
      </span>
    </span>
  )
}

function ModelControls({ status, onInstall, onCancel, onRemove }: { status: SemanticModelStatus; onInstall: () => void; onCancel: () => void; onRemove: () => void }) {
  const m = status.model
  const bytes = (n: number) => formatBytes(n).replace(' ', '\u00a0')
  const size = bytes(m.size)
  const about = `${m.name} ${m.version} by ${m.publisher}, ${m.license}, ${size}`
  if (status.state === 'unsupported') {
    return (
      <span className="hint warn" data-testid="privacy-model-status">
        {status.message}
      </span>
    )
  }
  if (status.state === 'downloading') {
    const pct = Math.min(100, Math.round(((status.received ?? 0) / m.size) * 100))
    return (
      <div className="model-row" data-testid="privacy-model-status">
        <div className="model-progress" role="progressbar" aria-label="Downloading the on-device model" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div style={{ width: `${pct}%` }} />
        </div>
        <span className="hint">
          Downloading {bytes(status.received ?? 0)} of {size}
        </span>
        <button type="button" className="btn small ghost" onClick={onCancel} data-testid="privacy-model-cancel">
          Cancel
        </button>
      </div>
    )
  }
  if (status.state === 'installed') {
    return (
      <div className="model-row" data-testid="privacy-model-status">
        <span className="hint">{about}. It loads when a question needs it and unloads after ten quiet minutes.</span>
        <button type="button" className="btn small ghost" onClick={onRemove} data-testid="privacy-model-remove">
          <Icon name="trash" size={12} /> Remove
        </button>
      </div>
    )
  }
  return (
    <div className="model-row" data-testid="privacy-model-status">
      {status.state === 'failed' ? <span className="hint warn">{status.message}</span> : null}
      <span className="hint">
        {about}. Downloaded once from {m.source}, and every file is checked against its pinned SHA-256 before the model runs.
      </span>
      <button type="button" className="btn small" onClick={onInstall} data-testid="privacy-model-install">
        <Icon name="download" size={12} /> {status.state === 'failed' ? 'Try again' : `Download (${size})`}
      </button>
    </div>
  )
}

export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen)
  const intent = useStore((s) => s.settingsIntent)
  const setOpen = useStore((s) => s.setSettingsOpen)
  const settings = useStore((s) => s.settings)
  const loadSettings = useStore((s) => s.loadSettings)
  const toast = useStore((s) => s.toast)
  const ui = useStore((s) => s.ui)
  const setUiPref = useStore((s) => s.setUiPref)
  const themeSyntax = THEMES.find((t) => t.id === ui.theme)?.syntax

  const [draft, setDraft] = useState<Draft>({ type: 'byok', provider: 'openai', baseUrl: PROVIDERS.openai.baseUrl, model: PROVIDERS.openai.defaultModel, embeddingModel: '' })
  const [key, setKey] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [models, setModels] = useState<string[] | null>(null)
  const [agent, setAgent] = useState<AgentSettings>(DEFAULT_AGENT)
  const [privacySettings, setPrivacySettings] = useState<PrivacySettings>(DEFAULT_PRIVACY)
  const [modelStatus, setModelStatus] = useState<SemanticModelStatus | null>(null)
  const [tab, setTab] = useState<SettingsTab>('appearance')
  const [busy, setBusy] = useState<null | 'save' | 'test' | 'remove' | 'models'>(null)

  /** The saved connection for a provider, or a fresh draft from its preset. */
  const draftForProvider = (provider: ProviderId, model?: string): Draft => {
    const existing = settings?.connections.find((c) => c.provider === provider)
    if (existing) return draftFrom(existing, model)
    const preset = PROVIDERS[provider]
    return { type: preset.type, provider, baseUrl: preset.baseUrl, model: model || preset.defaultModel, embeddingModel: '' }
  }

  // A dialog opened for a reason starts on the relevant tab; otherwise it stays where it was left.
  useLayoutEffect(() => {
    if (!open) return
    if (intent?.tab) setTab(intent.tab)
    else if (intent?.provider) setTab('models')
  }, [open, intent])

  // Load the saved values each time the dialog opens, before the first paint so no stale draft shows. Only once per
  // opening: an action that saves one setting straight away (removing a key, installing the model) refreshes the
  // saved settings without discarding what is being edited.
  const loaded = useRef(false)
  useLayoutEffect(() => {
    if (!open) {
      loaded.current = false
      return
    }
    if (!settings || loaded.current) return
    loaded.current = true
    const current = activeConnection(settings)
    setDraft(current ? draftFrom(current, settings.activeModel) : draftForProvider('openai'))
    setKey('')
    setModels(null)
    setAdvanced(false)
    setAgent(settings.agent)
    setPrivacySettings(settings.privacy ?? DEFAULT_PRIVACY)
    // Opened from the model picker: start on that provider with the model filled in.
    if (intent?.provider) setDraft(draftForProvider(intent.provider, intent.model))
    else if (intent?.model) setDraft((d) => ({ ...d, model: intent.model! }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, settings, intent])

  // The on-device model's status while the dialog is open, with download progress as it arrives.
  useEffect(() => {
    if (!open) return
    let live = true
    void window.api.privacyModel.status().then((s) => live && setModelStatus(s))
    const off = window.api.privacyModel.onStatus((s) => setModelStatus(s))
    return () => {
      live = false
      off()
    }
  }, [open])

  if (!open) return null

  const preset = PROVIDERS[draft.provider]
  const active = activeConnection(settings)
  /** The saved connection this draft edits, when there is one for the provider. */
  const saved = settings?.connections.find((c) => c.provider === draft.provider) ?? null
  const hasStoredKey = Boolean(saved?.hasCredential)
  const keyReady = Boolean(key.trim()) || hasStoredKey || !preset.needsKey
  const encryption = settings?.encryptionAvailable ?? true
  const close = () => setOpen(false)

  const input = (): AiConnectionInput => ({
    id: saved?.id,
    type: draft.type,
    provider: draft.provider,
    baseUrl: draft.baseUrl.trim(),
    defaultModel: draft.model.trim(),
    embeddingModel: draft.embeddingModel.trim(),
    ...(key.trim() ? { apiKey: key.trim() } : {})
  })

  const chooseType = (type: ConnectionType) => {
    if (type === 'managed' || type === draft.type) return
    // The saved connection of that type, the active one first; else the type's first provider.
    const candidates = settings?.connections.filter((c) => c.type === type) ?? []
    const pick = candidates.find((c) => c.id === settings?.activeConnectionId) ?? candidates[0]
    setDraft(pick ? draftFrom(pick) : draftForProvider(type === 'byok' ? BYOK_PROVIDERS[0] : LOCAL_PROVIDERS[0]))
    setKey('')
    setModels(null)
  }

  const chooseProvider = (provider: ProviderId) => {
    setDraft(draftForProvider(provider))
    setKey('')
    setModels(null)
  }

  const dirty =
    !settings ||
    !active ||
    active.provider !== draft.provider ||
    key.trim() !== '' ||
    draft.baseUrl.trim() !== active.baseUrl ||
    draft.model.trim() !== (settings.activeModel || active.defaultModel) ||
    draft.embeddingModel.trim() !== active.embeddingModel ||
    agent.autoRun !== settings.agent.autoRun ||
    agent.sendSampleValues !== settings.agent.sendSampleValues ||
    (agent.readResults !== false) !== (settings.agent.readResults !== false) ||
    agent.schemaBudgetTokens !== settings.agent.schemaBudgetTokens ||
    (Object.keys(DEFAULT_PRIVACY) as (keyof PrivacySettings)[]).some((k) => privacySettings[k] !== (settings.privacy ?? DEFAULT_PRIVACY)[k])

  const save = async () => {
    setBusy('save')
    try {
      await window.api.settings.update({ connection: input(), agent, privacy: privacySettings })
      // The form shows what was saved, as the main process normalized it.
      loaded.current = false
      await loadSettings()
      toast('success', 'Settings saved')
      setKey('')
    } catch (e) {
      toast('error', 'Could not save settings', errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const test = async () => {
    setBusy('test')
    try {
      const r = await window.api.settings.testProvider(input())
      toast(r.ok ? 'success' : 'error', r.ok ? `${preset.label} works` : `${preset.label} test failed`, r.message)
    } catch (e) {
      toast('error', `Could not reach ${preset.label}`, errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const fetchModels = async () => {
    setBusy('models')
    try {
      const list = await window.api.settings.listModels(input())
      setModels(list)
      if (!list.length) toast('info', 'No models listed', 'The server answered but listed no models. Type the model name by hand.')
    } catch (e) {
      toast('error', 'Could not list models', errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const removeKey = async () => {
    setBusy('remove')
    try {
      await window.api.settings.update({ connection: { id: saved?.id, type: draft.type, provider: draft.provider, apiKey: null } })
      loaded.current = false
      await loadSettings()
      toast('success', `${preset.label} key removed`)
    } catch (e) {
      toast('error', 'Could not remove the key', errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const installModel = async () => {
    try {
      const s = await window.api.privacyModel.install()
      setModelStatus(s)
      if (s.state === 'installed') {
        // Downloading it is asking for it: switched on and saved now, not left for a Save that closing would skip.
        // Only this setting is saved; anything else being edited stays as it is.
        await window.api.settings.update({ privacy: { semanticDetection: true } })
        setPrivacySettings((p) => ({ ...p, semanticDetection: true }))
        await loadSettings()
        toast('success', 'On-device model installed and switched on')
      } else if (s.state === 'failed') toast('error', 'The model was not installed', s.message)
    } catch (e) {
      toast('error', 'The model was not installed', errorMessage(e))
    }
  }

  const removeModel = async () => {
    try {
      setModelStatus(await window.api.privacyModel.remove())
      loaded.current = false
      await loadSettings()
      toast('success', 'On-device model removed')
    } catch (e) {
      toast('error', 'Could not remove the model', errorMessage(e))
    }
  }

  const openLink = (url: string) => (e: React.MouseEvent) => {
    e.preventDefault()
    void window.api.app.openExternal(url)
  }

  const endpoint = classifyEndpoint(draft.baseUrl.trim() || preset.baseUrl)
  const protection = privacyApplies(privacySettings, endpoint.trust)
  const privacy =
    draft.type === 'local'
      ? `Questions and schema details go only to the server at ${draft.baseUrl.trim() || 'the base URL'}${protection.protect ? ', after sensitive values are replaced on this computer' : ''}. Nothing reaches Portside Labs.`
      : draft.type === 'byok'
        ? `Questions and the relevant schema go straight to ${preset.label} with your key${protection.protect ? ', after sensitive values are replaced on this computer' : ''}. Nothing reaches Portside Labs.`
        : 'Questions go through Portside Labs to the model provider. Database credentials never do.'
  const policyInfo = PRIVACY_POLICIES[privacySettings.policyId] ?? PRIVACY_POLICIES['general-pii']
  const readers = privacySettings.semanticDetection ? ' by the rules and the on-device model' : ' by the rules'
  const protectionStatus = !privacySettings.enabled
    ? 'Local AI Privacy is off: questions, sample values and database errors are sent to the model as they are.'
    : endpoint.trust === 'this-device'
      ? privacySettings.protectLocalModels
        ? `${endpoint.host} is this computer, and requests to it are protected too,${readers}.`
        : `${endpoint.host} is this computer, so requests to it are sent as they are. Turn on the option above to protect them as well.`
      : `${endpoint.host} is outside this computer: every request to it is protected${readers} and checked before it is sent.`
  const setPrivacy = (patch: Partial<PrivacySettings>) => setPrivacySettings((p) => ({ ...p, ...patch }))
  // Offered once the model is installed; always possible to switch off.
  const semanticSwitchable = modelStatus?.state === 'installed' || privacySettings.semanticDetection

  return (
    <Modal title="Settings" onClose={close} width={760} header={false} className="settings-modal">
      <div className="settings-body" data-testid="settings-dialog">
        <nav className="settings-nav" aria-label="Settings sections">
          {SETTINGS_TABS.map((t) => (
            <button key={t.id} className={`settings-nav-item ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)} data-testid={`settings-tab-${t.id}`}>
              <Icon name={t.icon} /> {t.label}
            </button>
          ))}
        </nav>
        <div className="settings-content">
        <div className="settings-scroll">
        {tab === 'appearance' ? (
          <section data-testid="settings-appearance">
            <h2>
              <Icon name="layout" /> Appearance
            </h2>
            <div className="field">
              <label>Connection tabs</label>
              <div className="segmented" data-testid="connection-tabs-mode">
                <button type="button" className={ui.connectionTabs === 'horizontal' ? 'active' : ''} onClick={() => setUiPref({ connectionTabs: 'horizontal' })}>
                  Horizontal
                </button>
                <button type="button" className={ui.connectionTabs === 'vertical' ? 'active' : ''} onClick={() => setUiPref({ connectionTabs: 'vertical' })}>
                  Vertical
                </button>
              </div>
              <span className="hint">Open connections are listed as tabs across the top of the window, or as a rail down its left edge.</span>
            </div>
            <div className="field">
              <label>Theme</label>
              <div className="choice-tiles" data-testid="theme-choices">
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`choice-tile ${ui.theme === t.id ? 'active' : ''}`}
                    onClick={() => setUiPref({ theme: t.id })}
                    aria-pressed={ui.theme === t.id}
                    data-testid={`theme-${t.id}`}
                  >
                    <ThemePreview theme={t.id} />
                    <span className="choice-tile-label">{t.label}</span>
                  </button>
                ))}
              </div>
              <span className="hint">Colours for the window, the editor and the code.</span>
            </div>

            <h2 className="section-gap">
              <Icon name="code" /> Code
            </h2>
            <div className="field">
              <label>Syntax colours</label>
              <div className="choice-tiles" data-testid="syntax-choices">
                <button
                  type="button"
                  className={`choice-tile ${ui.syntax === null ? 'active' : ''}`}
                  onClick={() => setUiPref({ syntax: null })}
                  aria-pressed={ui.syntax === null}
                  data-testid="syntax-theme"
                >
                  <SyntaxPreview theme={ui.theme} />
                  <span className="choice-tile-label">
                    Theme default <span className="choice-tile-note">{SYNTAX_PALETTES.find((p) => p.id === themeSyntax)?.label}</span>
                  </span>
                </button>
                {SYNTAX_PALETTES.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`choice-tile ${ui.syntax === p.id ? 'active' : ''}`}
                    onClick={() => setUiPref({ syntax: p.id })}
                    aria-pressed={ui.syntax === p.id}
                    data-testid={`syntax-${p.id}`}
                  >
                    <SyntaxPreview syntax={p.id} />
                    <span className="choice-tile-label">{p.label}</span>
                  </button>
                ))}
              </div>
              <span className="hint">Keywords, strings, numbers and comments, wherever SQL is shown. Theme default changes along with the theme.</span>
            </div>
            <div className="field">
              <label>Font</label>
              <div className="choice-tiles" data-testid="font-choices">
                <button
                  type="button"
                  className={`choice-tile ${ui.codeFont === null ? 'active' : ''}`}
                  onClick={() => setUiPref({ codeFont: null })}
                  aria-pressed={ui.codeFont === null}
                  data-testid="font-theme"
                >
                  <span className="font-sample">WHERE id &gt;= 10</span>
                  <span className="choice-tile-label">Theme default</span>
                </button>
                {CODE_FONTS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className={`choice-tile ${ui.codeFont === f.id ? 'active' : ''}`}
                    onClick={() => setUiPref({ codeFont: f.id })}
                    aria-pressed={ui.codeFont === f.id}
                    data-testid={`font-${f.id}`}
                  >
                    <span className="font-sample" style={{ fontFamily: f.family }}>
                      WHERE id &gt;= 10
                    </span>
                    <span className="choice-tile-label">{f.label}</span>
                  </button>
                ))}
              </div>
              <span className="hint">For the SQL pane only; the chat and the rest of the window keep theirs.</span>
            </div>
          </section>
        ) : tab === 'editor' ? (
          <section data-testid="settings-editor">
            <h2>
              <Icon name="code" /> Editor
            </h2>
            <div className="field">
              <label>Keyword casing</label>
              <div className="segmented" data-testid="editor-keyword-case">
                <button type="button" className={ui.keywordCase === 'upper' ? 'active' : ''} onClick={() => setUiPref({ keywordCase: 'upper' })}>
                  Uppercase
                </button>
                <button type="button" className={ui.keywordCase === 'lower' ? 'active' : ''} onClick={() => setUiPref({ keywordCase: 'lower' })}>
                  Lowercase
                </button>
                <button type="button" className={ui.keywordCase === 'off' ? 'active' : ''} onClick={() => setUiPref({ keywordCase: 'off' })}>
                  As typed
                </button>
              </div>
              <span className="hint">Keywords such as SELECT and FROM are re-cased as you finish typing them. Table and column names are left as they are.</span>
            </div>
            <div className="field">
              <label className="checkbox">
                <input type="checkbox" checked={ui.autocomplete} onChange={(e) => setUiPref({ autocomplete: e.target.checked })} data-testid="editor-autocomplete" />
                Suggest as you type
              </label>
              <span className="hint">Tables after FROM and JOIN, columns after SELECT, WHERE and the like, and keywords only where one can follow.</span>
            </div>
            <div className="field">
              <label>Accept a suggestion with</label>
              <div className="check-row" data-testid="editor-accept-keys">
                {ACCEPT_KEY_OPTIONS.map((o) => (
                  <label key={o.key} className="checkbox">
                    <input
                      type="checkbox"
                      checked={ui.acceptKeys.includes(o.key)}
                      disabled={!ui.autocomplete}
                      onChange={(e) => setUiPref({ acceptKeys: e.target.checked ? [...ui.acceptKeys.filter((k) => k !== o.key), o.key] : ui.acceptKeys.filter((k) => k !== o.key) })}
                      data-testid={`editor-accept-${o.key.toLowerCase()}`}
                    />
                    {o.label}
                  </label>
                ))}
              </div>
              <span className="hint">Any of these takes the highlighted suggestion; with none chosen, suggestions are picked with the mouse. Arrow keys still move through the list.</span>
            </div>
            <div className="field">
              <label className="checkbox">
                <input type="checkbox" checked={ui.autoAlias} onChange={(e) => setUiPref({ autoAlias: e.target.checked })} data-testid="editor-auto-alias" />
                Alias tables automatically
              </label>
              <span className="hint">FROM phone_numbers becomes FROM phone_numbers pn when the name is typed or picked from a suggestion.</span>
            </div>
          </section>
        ) : tab === 'connectors' ? (
          <ConnectorsSettings />
        ) : tab === 'instructions' ? (
          <InstructionsSettings />
        ) : (
        <section data-testid="settings-models">
          <h2>
            <Icon name="chat" /> Model provider
          </h2>
          <p className="hint">
            Questions typed into the Ask box are turned into SQL by a model of your choice. Bring your own key or run a model locally. The database
            client is yours; the cloud is optional.
          </p>

          <div className="ai-type-tiles" data-testid="ai-types">
            {OFFERED_TYPES.map((t) => (
              <button
                key={t.type}
                type="button"
                className={`ai-type-tile ${draft.type === t.type ? 'active' : ''}`}
                onClick={() => chooseType(t.type)}
                aria-pressed={draft.type === t.type}
                data-testid={`ai-type-${t.type}`}
              >
                <span className="ai-type-head">
                  <span className="ai-type-label">{t.label}</span>
                </span>
                <span className="ai-type-blurb">{t.blurb}</span>
                {SHOW_ACCOUNT ? <span className="ai-type-account">{t.account}</span> : null}
              </button>
            ))}
          </div>

          {draft.type === 'byok' ? (
            <div className="field">
              <label>Provider</label>
              <select className="select" value={draft.provider} onChange={(e) => chooseProvider(e.target.value as ProviderId)} data-testid="ai-provider">
                {BYOK_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {PROVIDERS[p].label}
                  </option>
                ))}
              </select>
              <span className="hint">{preset.notes}</span>
            </div>
          ) : (
            <div className="field">
              <label>Server</label>
              <select className="select" value={draft.provider} onChange={(e) => chooseProvider(e.target.value as ProviderId)} data-testid="ai-local-type">
                {LOCAL_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {PROVIDERS[p].label}
                  </option>
                ))}
              </select>
              <span className="hint">{preset.notes}</span>
            </div>
          )}

          {draft.type === 'local' ? (
            <div className="field">
              <label>Base URL</label>
              <input
                className="text mono"
                value={draft.baseUrl}
                placeholder={preset.baseUrl || 'http://localhost:8000/v1'}
                onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                spellCheck={false}
                data-testid="ai-base-url"
              />
            </div>
          ) : null}

          <div className="field">
            <label>API key{preset.needsKey ? '' : ' (optional)'}</label>
            <div className="row">
              <input
                className="text mono"
                type="password"
                value={key}
                placeholder={hasStoredKey ? `Saved key ending in …${saved?.credentialHint ?? ''}` : preset.needsKey ? 'Paste a key' : 'Not needed for most local servers'}
                onChange={(e) => setKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                data-testid="ai-key"
              />
              <button className="btn" onClick={() => void test()} disabled={busy !== null || !keyReady} title="Check that the connection answers with these settings" data-testid="ai-test">
                {busy === 'test' ? <span className="spinner" /> : null} Test
              </button>
              {hasStoredKey ? (
                <button className="btn danger" onClick={() => void removeKey()} disabled={busy !== null}>
                  Remove
                </button>
              ) : null}
            </div>
            {preset.keyUrl ? (
              <span className="hint">
                Get a key at{' '}
                <a href={preset.keyUrl} onClick={openLink(preset.keyUrl)}>
                  {preset.keyUrl.replace(/^https?:\/\//, '')}
                </a>
                . Keys are stored encrypted with your system keychain, never in plain text.
              </span>
            ) : null}
            {!encryption ? <span className="hint">This system cannot store secrets securely, so a key cannot be saved.</span> : null}
          </div>

          <div className="field">
            <label>Model</label>
            <div className="row">
              {models && models.length ? (
                <select className="select" value={models.includes(draft.model) ? draft.model : ''} onChange={(e) => setDraft({ ...draft, model: e.target.value })} data-testid="ai-model-select">
                  {!models.includes(draft.model) ? <option value="">{draft.model ? `${draft.model} (not listed)` : 'Choose a model…'}</option> : null}
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <input className="text mono" value={draft.model} placeholder={preset.defaultModel || 'model name'} onChange={(e) => setDraft({ ...draft, model: e.target.value })} spellCheck={false} data-testid="ai-model" />
              )}
              <button className="btn" onClick={() => void fetchModels()} disabled={busy !== null || !keyReady} title="Ask the connection which models are available" data-testid="ai-fetch-models">
                {busy === 'models' ? <span className="spinner" /> : null} Fetch models
              </button>
              {models ? (
                <button className="btn ghost" onClick={() => setModels(null)} title="Type the model name instead">
                  Edit
                </button>
              ) : null}
            </div>
          </div>

          <button type="button" className="disclosure" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced} data-testid="ai-advanced">
            <Icon name={advanced ? 'chevron-down' : 'chevron-right'} size={12} /> Advanced
          </button>
          {advanced ? (
            <>
              {draft.type === 'byok' ? (
                <div className="field">
                  <label>Base URL</label>
                  <input className="text mono" value={draft.baseUrl} placeholder={preset.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} spellCheck={false} data-testid="ai-base-url" />
                  <span className="hint">Only change this for a proxy or a compatible gateway in front of {preset.label}.</span>
                </div>
              ) : null}
              {preset.protocol === 'openai' ? (
                <div className="field">
                  <label>Embedding model (optional)</label>
                  <input
                    className="text mono"
                    value={draft.embeddingModel}
                    placeholder={preset.defaultEmbeddingModel || 'leave empty for keyword search only'}
                    onChange={(e) => setDraft({ ...draft, embeddingModel: e.target.value })}
                    spellCheck={false}
                    data-testid="ai-embedding-model"
                  />
                  <span className="hint">
                    Improves table lookup on large schemas by embedding each table's description once (cached on disk). Keyword search is always used;
                    embeddings only help when a question uses different words than the schema.
                  </span>
                </div>
              ) : null}
            </>
          ) : null}

          <p className="hint privacy" data-testid="ai-privacy">
            {privacy}
          </p>

          <h2 className="section-gap">
            <Icon name="shield" /> Privacy &amp; data protection
          </h2>
          <div className="field">
            <label className="checkbox">
              <input type="checkbox" checked={privacySettings.enabled} onChange={(e) => setPrivacy({ enabled: e.target.checked })} data-testid="privacy-enabled" />
              Protect sensitive data before it leaves this device
            </label>
            <span className="hint">
              Names, contact details, ids, card numbers and secrets in questions, sample values and database errors are replaced with
              placeholders on this computer before a request is sent. The model answers with the placeholders and the real values are put
              back here, so the chat and the SQL look as usual. The mapping never leaves this computer, and no account is needed.
            </span>
          </div>
          {privacySettings.enabled ? (
            <>
              <div className="field">
                <label>Detection</label>
                <div className="privacy-detectors" data-testid="privacy-detectors">
                  <div className="privacy-detector">
                    <span className="privacy-detector-name">Pattern recognizers</span>
                    <span className="badge">Always on</span>
                    <span className="hint">Emails, phone numbers, card and account numbers, government ids, keys and tokens, checked with checksums where they exist.</span>
                  </div>
                  <div className="privacy-detector">
                    <label className="checkbox">
                      <input type="checkbox" checked={privacySettings.schemaDetection} onChange={(e) => setPrivacy({ schemaDetection: e.target.checked })} data-testid="privacy-schema" />
                      Database schema detection
                    </label>
                    <span className="hint">Columns such as email, date_of_birth or card_number are recognised by name, and so are labelled values in JSON, logs and SQL.</span>
                  </div>
                  <div className="privacy-detector" data-testid="privacy-model">
                    <label className={`checkbox ${semanticSwitchable ? '' : 'disabled'}`}>
                      <input
                        type="checkbox"
                        checked={privacySettings.semanticDetection}
                        disabled={!semanticSwitchable}
                        onChange={(e) => setPrivacy({ semanticDetection: e.target.checked })}
                        data-testid="privacy-semantic"
                      />
                      On-device model
                    </label>
                    {modelStatus && MODEL_BADGE[modelStatus.state] ? (
                      <span className={`badge ${modelStatus.state === 'installed' ? '' : 'coming-soon'}`}>{MODEL_BADGE[modelStatus.state]}</span>
                    ) : null}
                    <span className="hint">
                      Finds names, places and organizations that patterns miss, such as a surname without a title or a hospital mentioned in passing. It runs on
                      this computer in a process of its own; nothing it reads leaves.
                    </span>
                    {modelStatus ? (
                      <ModelControls status={modelStatus} onInstall={() => void installModel()} onCancel={() => void window.api.privacyModel.cancel()} onRemove={() => void removeModel()} />
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="field">
                <label>Privacy policy</label>
                <select className="select" value={privacySettings.policyId} onChange={(e) => setPrivacy({ policyId: e.target.value as PrivacyPolicyId })} data-testid="privacy-policy">
                  {Object.values(PRIVACY_POLICIES).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label} (v{p.version})
                    </option>
                  ))}
                </select>
                <span className="hint">{policyInfo.description}</span>
              </div>
              <div className="field">
                <label className="checkbox">
                  <input type="checkbox" checked={privacySettings.protectLocalModels} onChange={(e) => setPrivacy({ protectLocalModels: e.target.checked })} data-testid="privacy-local" />
                  Also protect models on this computer
                </label>
                <span className="hint">Ollama, LM Studio and other servers at localhost see the data as it is unless this is on.</span>
              </div>
            </>
          ) : null}
          <p className="hint privacy" data-testid="privacy-status">
            {protectionStatus}
          </p>

          <h2 className="section-gap">
            <Icon name="database" /> Database context
          </h2>
          <div className="field">
            <label>Schema context per question</label>
            <select className="select" value={agent.schemaBudgetTokens} onChange={(e) => setAgent({ ...agent, schemaBudgetTokens: Number(e.target.value) })} data-testid="ai-budget">
              {SCHEMA_BUDGETS.map((b) => (
                <option key={b} value={b}>
                  up to ~{(b / 1000).toFixed(0)}k tokens
                </option>
              ))}
            </select>
            <span className="hint">
              Small schemas are always sent whole. When a schema is larger than this, only the tables most related to the question are sent and the
              model can look up more on demand.
            </span>
          </div>
          <div className="field">
            <label className="checkbox">
              <input type="checkbox" checked={agent.sendSampleValues} onChange={(e) => setAgent({ ...agent, sendSampleValues: e.target.checked })} data-testid="send-sample-values" />
              Send sample column values with the schema
            </label>
            <span className="hint">
              When on, up to 20 distinct values of short text columns in the tables being queried are included, so words like "paid" can be matched to
              how a status is actually stored. Table and column names and the question itself are always sent; with Local AI Privacy on, sensitive values
              among them are replaced with placeholders first.
            </span>
          </div>
          <div className="field">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={agent.readResults !== false}
                onChange={(e) => setAgent({ ...agent, readResults: e.target.checked })}
                data-testid="read-results"
              />
              Let the model read query results in chats across databases
            </label>
            <span className="hint">
              When a chat has more than one database in context, the model can run read-only queries and read up to 50 rows of each result, to follow a
              record from one database to the next and lay out what happened. With Local AI Privacy on, sensitive values in the results are replaced
              with placeholders first, the same placeholder for the same value in every database. A chat on one database never sends results.
            </span>
          </div>

          <h2 className="section-gap">
            <Icon name="lock" /> Query safety
          </h2>
          <div className="field">
            <label className="checkbox">
              <input type="checkbox" checked={agent.autoRun} onChange={(e) => setAgent({ ...agent, autoRun: e.target.checked })} data-testid="auto-run" />
              Run generated queries automatically
            </label>
            <span className="hint">Generated queries are read-only and checked with EXPLAIN before they run. Turn this off to review the SQL first.</span>
          </div>
        </section>
        )}
        </div>
        <div className="settings-actions">
          <span className="spacer" />
          <button className="btn" onClick={close}>
            Close
          </button>
          {tab === 'models' ? (
            <button className="btn primary" onClick={() => void save()} disabled={busy !== null || !dirty} data-testid="settings-save">
              {busy === 'save' ? <span className="spinner" /> : null} Save
            </button>
          ) : null}
        </div>
        </div>
      </div>
    </Modal>
  )
}
