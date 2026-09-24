import { useLayoutEffect, useState } from 'react'
import { AI_PRESETS, SCHEMA_BUDGETS, type AiProviderKind, type AiSettingsUpdate } from '@shared/ai'
import { useStore, type SettingsTab } from '@/store'
import { Modal } from './Modal'
import { Icon } from './Icons'
import { errorMessage } from '@/lib/util'

const SETTINGS_TABS = [
  { id: 'appearance' as const, label: 'Appearance', icon: 'layout' as const },
  { id: 'ai' as const, label: 'AI', icon: 'chat' as const }
]

const PROVIDER_ORDER: AiProviderKind[] = ['openai', 'anthropic', 'google', 'groq', 'openrouter', 'ollama', 'custom']

export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen)
  const intent = useStore((s) => s.settingsIntent)
  const setOpen = useStore((s) => s.setSettingsOpen)
  const settings = useStore((s) => s.settings)
  const loadSettings = useStore((s) => s.loadSettings)
  const toast = useStore((s) => s.toast)

  const [provider, setProvider] = useState<AiProviderKind>('openai')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [embeddingModel, setEmbeddingModel] = useState('')
  const [key, setKey] = useState('')
  const [sendValues, setSendValues] = useState(false)
  const [autoRun, setAutoRun] = useState(true)
  const [budget, setBudget] = useState<number>(8000)
  const [models, setModels] = useState<string[] | null>(null)
  const [tab, setTab] = useState<SettingsTab>('appearance')
  const ui = useStore((s) => s.ui)
  const setUiPref = useStore((s) => s.setUiPref)

  // A dialog opened for a reason starts on the relevant tab; otherwise it stays where it was left.
  useLayoutEffect(() => {
    if (!open) return
    if (intent?.tab) setTab(intent.tab)
    else if (intent?.provider) setTab('ai')
  }, [open, intent])
  const [busy, setBusy] = useState<null | 'save' | 'test' | 'remove' | 'models'>(null)

  // Load the saved values each time the dialog opens, before the first paint so no stale draft shows.
  useLayoutEffect(() => {
    if (!open || !settings) return
    setProvider(settings.provider)
    setBaseUrl(settings.baseUrl)
    setModel(settings.model)
    setEmbeddingModel(settings.embeddingModel)
    setKey('')
    setSendValues(settings.sendSampleValues)
    setAutoRun(settings.autoRun)
    setBudget(settings.schemaBudgetTokens)
    setModels(null)
    // Opened from the model picker: start on that provider with the model filled in.
    if (intent?.provider && intent.provider !== settings.provider) {
      const p = AI_PRESETS[intent.provider]
      setProvider(intent.provider)
      setBaseUrl(p.baseUrl)
      setModel(intent.model || p.defaultModel)
      setEmbeddingModel('')
    } else if (intent?.model) {
      setModel(intent.model)
    }
  }, [open, settings, intent])

  if (!open) return null

  const preset = AI_PRESETS[provider]
  const switching = settings ? provider !== settings.provider : true
  const hasStoredKey = Boolean(settings?.hasKey) && !switching
  const keyReady = Boolean(key.trim()) || hasStoredKey || !preset.needsKey
  const encryption = settings?.encryptionAvailable ?? true
  const close = () => setOpen(false)

  const overrides = (): AiSettingsUpdate => ({
    provider,
    baseUrl: baseUrl.trim(),
    model: model.trim(),
    embeddingModel: embeddingModel.trim(),
    ...(key.trim() ? { apiKey: key.trim() } : {})
  })

  const changeProvider = (next: AiProviderKind) => {
    const p = AI_PRESETS[next]
    setProvider(next)
    setModels(null)
    if (settings && next === settings.provider) {
      setBaseUrl(settings.baseUrl)
      setModel(settings.model)
      setEmbeddingModel(settings.embeddingModel)
    } else {
      setBaseUrl(p.baseUrl)
      setModel(p.defaultModel)
      setEmbeddingModel('')
    }
  }

  const dirty =
    !settings ||
    switching ||
    key.trim() !== '' ||
    baseUrl.trim() !== settings.baseUrl ||
    model.trim() !== settings.model ||
    embeddingModel.trim() !== settings.embeddingModel ||
    sendValues !== settings.sendSampleValues ||
    autoRun !== settings.autoRun ||
    budget !== settings.schemaBudgetTokens

  const save = async () => {
    setBusy('save')
    try {
      await window.api.settings.update({ ...overrides(), sendSampleValues: sendValues, autoRun, schemaBudgetTokens: budget })
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
      const r = await window.api.settings.testProvider(overrides())
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
      const list = await window.api.settings.listModels(overrides())
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
      await window.api.settings.update({ provider, apiKey: null })
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
        ) : (
        <section>
          <h2>
            <Icon name="chat" /> Ask in plain English
          </h2>
          <p className="hint">
            Questions typed into the Ask box are turned into SQL by a language model of your choice, using your own account. The app sends your
            question, the names and types of the relevant tables, and optionally a few sample values. Generated queries are always run read-only and
            checked with EXPLAIN before they touch your data.
          </p>

          <div className="field">
            <label>Provider</label>
            <select className="select" value={provider} onChange={(e) => changeProvider(e.target.value as AiProviderKind)} data-testid="ai-provider">
              {PROVIDER_ORDER.map((k) => (
                <option key={k} value={k}>
                  {AI_PRESETS[k].label}
                </option>
              ))}
            </select>
            <span className="hint">{preset.notes}</span>
          </div>

          <div className="field">
            <label>Base URL</label>
            <input
              className="text mono"
              value={baseUrl}
              placeholder={preset.baseUrl || 'http://localhost:8000/v1'}
              onChange={(e) => setBaseUrl(e.target.value)}
              spellCheck={false}
              data-testid="ai-base-url"
            />
          </div>

          <div className="field">
            <label>API key{preset.needsKey ? '' : ' (optional)'}</label>
            <div className="row">
              <input
                className="text mono"
                type="password"
                value={key}
                placeholder={hasStoredKey ? `Saved key ending in …${settings?.keyHint}` : preset.needsKey ? 'Paste a key' : 'Not needed for most local servers'}
                onChange={(e) => setKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                data-testid="ai-key"
              />
              <button className="btn" onClick={() => void test()} disabled={busy !== null || !keyReady} title="Check that the provider answers with these settings" data-testid="ai-test">
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
                . Keys are stored encrypted with your system keychain.
              </span>
            ) : null}
            {!encryption ? <span className="hint">This system cannot store secrets securely, so a key cannot be saved.</span> : null}
          </div>

          <div className="field">
            <label>Model</label>
            <div className="row">
              {models && models.length ? (
                <select className="select" value={models.includes(model) ? model : ''} onChange={(e) => setModel(e.target.value)} data-testid="ai-model-select">
                  {!models.includes(model) ? <option value="">{model ? `${model} (not listed)` : 'Choose a model…'}</option> : null}
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <input className="text mono" value={model} placeholder={preset.defaultModel || 'model name'} onChange={(e) => setModel(e.target.value)} spellCheck={false} data-testid="ai-model" />
              )}
              <button className="btn" onClick={() => void fetchModels()} disabled={busy !== null || !keyReady} title="Ask the provider which models are available" data-testid="ai-fetch-models">
                {busy === 'models' ? <span className="spinner" /> : null} Fetch models
              </button>
              {models ? (
                <button className="btn ghost" onClick={() => setModels(null)} title="Type the model name instead">
                  Edit
                </button>
              ) : null}
            </div>
          </div>

          {preset.protocol === 'openai' ? (
            <div className="field">
              <label>Embedding model (optional)</label>
              <input
                className="text mono"
                value={embeddingModel}
                placeholder={preset.defaultEmbeddingModel || 'leave empty for keyword search only'}
                onChange={(e) => setEmbeddingModel(e.target.value)}
                spellCheck={false}
                data-testid="ai-embedding-model"
              />
              <span className="hint">
                Improves table lookup on large schemas by embedding each table's description once (cached on disk). Keyword search is always used;
                embeddings only help when a question uses different words than the schema.
              </span>
            </div>
          ) : null}

          <div className="field">
            <label>Schema context per question</label>
            <select className="select" value={budget} onChange={(e) => setBudget(Number(e.target.value))} data-testid="ai-budget">
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

          <div className="field" style={{ marginTop: 12 }}>
            <label className="checkbox">
              <input type="checkbox" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} data-testid="auto-run" />
              Run generated queries automatically
            </label>
            <span className="hint">Queries run read-only either way; turn this off to review the SQL before it runs.</span>
          </div>

          <div className="field">
            <label className="checkbox">
              <input type="checkbox" checked={sendValues} onChange={(e) => setSendValues(e.target.checked)} data-testid="send-sample-values" />
              Send sample column values to the provider
            </label>
            <span className="hint">
              When on, up to 20 distinct values of short text columns in the tables being queried are included, so words like "paid" can be matched to
              how a status is actually stored. Table and column names and the question itself are always sent.
            </span>
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
