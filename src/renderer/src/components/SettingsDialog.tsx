import { useLayoutEffect, useState } from 'react'
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
import { useStore, type SettingsTab } from '@/store'
import { ACCEPT_KEY_OPTIONS } from '@/lib/sql-complete'
import { Modal } from './Modal'
import { Icon } from './Icons'
import { errorMessage } from '@/lib/util'

const SETTINGS_TABS = [
  { id: 'appearance' as const, label: 'Appearance', icon: 'layout' as const },
  { id: 'editor' as const, label: 'Editor', icon: 'code' as const },
  { id: 'ai' as const, label: 'AI', icon: 'chat' as const }
]

/** The connection as it is being edited, before it is saved. */
interface Draft {
  type: ConnectionType
  provider: ProviderId
  baseUrl: string
  model: string
  embeddingModel: string
}

const DEFAULT_AGENT: AgentSettings = { schemaBudgetTokens: 8000, autoRun: true, sendSampleValues: false }

function draftFrom(c: AiConnection, model?: string): Draft {
  return { type: c.type, provider: c.provider, baseUrl: c.baseUrl, model: model || c.defaultModel, embeddingModel: c.embeddingModel }
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

  const [draft, setDraft] = useState<Draft>({ type: 'byok', provider: 'openai', baseUrl: PROVIDERS.openai.baseUrl, model: PROVIDERS.openai.defaultModel, embeddingModel: '' })
  const [key, setKey] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [models, setModels] = useState<string[] | null>(null)
  const [agent, setAgent] = useState<AgentSettings>(DEFAULT_AGENT)
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
    else if (intent?.provider) setTab('ai')
  }, [open, intent])

  // Load the saved values each time the dialog opens, before the first paint so no stale draft shows.
  useLayoutEffect(() => {
    if (!open || !settings) return
    const current = activeConnection(settings)
    setDraft(current ? draftFrom(current, settings.activeModel) : draftForProvider('openai'))
    setKey('')
    setModels(null)
    setAdvanced(false)
    setAgent(settings.agent)
    // Opened from the model picker: start on that provider with the model filled in.
    if (intent?.provider) setDraft(draftForProvider(intent.provider, intent.model))
    else if (intent?.model) setDraft((d) => ({ ...d, model: intent.model! }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, settings, intent])

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
    agent.schemaBudgetTokens !== settings.agent.schemaBudgetTokens

  const save = async () => {
    setBusy('save')
    try {
      await window.api.settings.update({ connection: input(), agent })
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
      await loadSettings()
      toast('success', `${preset.label} key removed`)
    } catch (e) {
      toast('error', 'Could not remove the key', errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const openLink = (url: string) => (e: React.MouseEvent) => {
    e.preventDefault()
    void window.api.app.openExternal(url)
  }

  const privacy =
    draft.type === 'local'
      ? `Questions and schema details go only to the server at ${draft.baseUrl.trim() || 'the base URL'}. Nothing reaches Portside Labs.`
      : draft.type === 'byok'
        ? `Questions and the relevant schema go straight to ${preset.label} with your key. Nothing reaches Portside Labs.`
        : 'Questions go through Portside Labs to the model provider. Database credentials never do.'

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
        ) : (
        <section data-testid="settings-ai">
          <h2>
            <Icon name="chat" /> AI connection
          </h2>
          <p className="hint">
            Questions typed into the Ask box are turned into SQL by a model of your choice. Bring your own key, run a model locally, or use Managed AI
            when it arrives. The database client is yours; the cloud is optional.
          </p>

          <div className="ai-type-tiles" data-testid="ai-types">
            {CONNECTION_TYPES.map((t) => {
              const available = t.type !== 'managed'
              return (
                <button
                  key={t.type}
                  type="button"
                  className={`ai-type-tile ${draft.type === t.type ? 'active' : ''}`}
                  onClick={() => chooseType(t.type)}
                  disabled={!available}
                  aria-pressed={draft.type === t.type}
                  data-testid={`ai-type-${t.type}`}
                >
                  <span className="ai-type-head">
                    <span className="ai-type-label">{t.label}</span>
                    {!available ? <span className="badge coming-soon">Coming soon</span> : null}
                  </span>
                  <span className="ai-type-blurb">{t.blurb}</span>
                  <span className="ai-type-account">{t.account}</span>
                </button>
              )
            })}
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
              how a status is actually stored. Table and column names and the question itself are always sent.
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
          {tab === 'ai' ? (
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
