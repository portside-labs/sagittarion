// Settings → Instructions: what the user tells the model about their data, for every database connection (global) or
// for the ones chosen. Sent with each question, never shown in the chat; the answer's steps name the ones followed.
import { useState } from 'react'
import { MAX_INSTRUCTION_CHARS, emptyInstruction, type Instruction, type InstructionInput } from '@shared/instructions'
import { useStore } from '@/store'
import { errorMessage } from '@/lib/util'
import { Icon } from './Icons'
import { Switch } from './ConnectorsSettings'
import { ScopePicker, scopeText } from './ScopePicker'

function InstructionEditor({ existing, onDone }: { existing: Instruction | null; onDone: (saved: Instruction | null) => void }) {
  const dropInstruction = useStore((s) => s.dropInstruction)
  const confirm = useStore((s) => s.confirm)
  const [draft, setDraft] = useState<InstructionInput>(() => (existing ? { ...existing } : emptyInstruction()))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const length = draft.text.trim().length
  const tooLong = length > MAX_INSTRUCTION_CHARS

  const save = async () => {
    setError(null)
    setBusy(true)
    try {
      onDone(await window.api.instructions.save(draft))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!existing || !(await confirm(`Delete "${existing.name}"?`, 'Questions stop following it.', 'Delete', true))) return
    await window.api.instructions.remove(existing.id)
    dropInstruction(existing.id)
    onDone(null)
  }

  return (
    <div className="setting-editor" data-testid="instruction-editor">
      <div className="field">
        <label>Name</label>
        <input className="text" value={draft.name} placeholder="What revenue means" onChange={(e) => setDraft({ ...draft, name: e.target.value })} data-testid="instruction-name" />
      </div>
      <div className="field">
        <label>Instruction</label>
        <textarea
          className="text instruction-text"
          rows={7}
          value={draft.text}
          placeholder={'Revenue is the sum of orders.total for orders with status = \'paid\', in USD.\nPrefer the reporting schema over raw tables.'}
          onChange={(e) => setDraft({ ...draft, text: e.target.value })}
          data-testid="instruction-text"
        />
        <span className={`hint instruction-count ${tooLong ? 'warn' : ''}`}>
          {length.toLocaleString('en-US')} of {MAX_INSTRUCTION_CHARS.toLocaleString('en-US')} characters. Plain words or markdown; definitions, preferences and conventions work best.
        </span>
      </div>
      <ScopePicker
        scope={draft.scope}
        connectionIds={draft.connectionIds}
        onChange={(scope, connectionIds) => setDraft({ ...draft, scope, connectionIds })}
        testPrefix="instruction"
        hint="All connections makes it a global instruction, followed for every question."
      />
      {error ? (
        <div className="error-box" data-testid="instruction-error">
          {error}
        </div>
      ) : null}
      <div className="setting-editor-actions">
        {existing ? (
          <button type="button" className="btn small ghost danger" onClick={() => void remove()} data-testid="instruction-remove">
            <Icon name="trash" size={12} /> Delete
          </button>
        ) : null}
        <button type="button" className="btn small" onClick={() => onDone(existing)} data-testid="instruction-cancel">
          Cancel
        </button>
        <button type="button" className="btn small primary" onClick={() => void save()} disabled={busy || !draft.text.trim() || tooLong} data-testid="instruction-save">
          {busy ? <span className="spinner tiny" /> : null} {existing ? 'Save' : 'Add instruction'}
        </button>
      </div>
    </div>
  )
}

function InstructionCard({ instruction, open, onToggle }: { instruction: Instruction; open: boolean; onToggle: () => void }) {
  const connections = useStore((s) => s.connections)
  const putInstruction = useStore((s) => s.putInstruction)
  const toast = useStore((s) => s.toast)
  const preview = instruction.text.replace(/\s+/g, ' ').trim()
  const setEnabled = (on: boolean) =>
    void window.api.instructions
      .setEnabled(instruction.id, on)
      .then(putInstruction)
      .catch((e) => toast('error', 'Could not switch the instruction', errorMessage(e)))

  return (
    <div className={`setting-card ${open ? 'open' : ''} ${instruction.enabled ? '' : 'off'}`} data-testid="instruction" data-name={instruction.name}>
      <div className="setting-card-head">
        <Icon name="note" size={13} className="instruction-icon" />
        <button type="button" className="setting-card-title" onClick={onToggle} aria-expanded={open} data-testid="instruction-open">
          <span className="setting-card-name">{instruction.name}</span>
          <span className="setting-card-sub">
            {instruction.scope === 'all' ? 'Global' : scopeText(instruction.scope, instruction.connectionIds, connections)} · {preview}
          </span>
        </button>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} className="setting-card-chevron" />
        <Switch checked={instruction.enabled} onChange={setEnabled} label={instruction.enabled ? `Stop following ${instruction.name}` : `Follow ${instruction.name}`} testId="instruction-enabled" />
      </div>
      {open ? (
        <InstructionEditor
          existing={instruction}
          onDone={(saved) => {
            if (saved) putInstruction(saved)
            onToggle()
          }}
        />
      ) : null}
    </div>
  )
}

export function InstructionsSettings() {
  const instructions = useStore((s) => s.instructions)
  const putInstruction = useStore((s) => s.putInstruction)
  const [adding, setAdding] = useState(false)
  const [open, setOpen] = useState<string | null>(null)

  return (
    <section data-testid="settings-instructions">
      <h2>
        <Icon name="note" /> Instructions
      </h2>
      <p className="hint">
        Tell the model how to read your data: what &ldquo;revenue&rdquo; means, which tables to prefer, how dates are stored. A global instruction applies to every
        question; the rest only on the connections you choose.
      </p>
      <p className="hint privacy">
        <Icon name="shield" size={12} /> Instructions go to the model with each question, protected by Local AI Privacy like the rest, and are not shown in the
        chat. An answer&apos;s steps say which ones it followed.
      </p>
      <div className="setting-list">
        {instructions.map((i) => (
          <InstructionCard key={i.id} instruction={i} open={open === i.id} onToggle={() => setOpen((id) => (id === i.id ? null : i.id))} />
        ))}
        {!instructions.length && !adding ? <div className="setting-empty">No instructions yet.</div> : null}
      </div>
      {adding ? (
        <div className="setting-card open">
          <InstructionEditor
            existing={null}
            onDone={(saved) => {
              setAdding(false)
              if (saved) putInstruction(saved)
            }}
          />
        </div>
      ) : (
        <button type="button" className="btn small setting-add" onClick={() => setAdding(true)} data-testid="instruction-add">
          <Icon name="plus" size={12} /> Add instruction
        </button>
      )}
    </section>
  )
}
