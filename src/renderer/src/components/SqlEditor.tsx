import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Compartment, EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { acceptCompletion, autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { PostgreSQL, SQLite } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'
import { basicSetup } from 'codemirror'
import { boundaryEdit, DEFAULT_EDITOR_PREFS, sqlCompletionSource, type CompletionData, type EditorPrefs } from '@/lib/sql-complete'
import { blockAt } from '@/lib/sql-block'

export interface SqlEditorHandle {
  getValue(): string
  getSelection(): string
  /** The statement block the cursor is in: contiguous non-blank lines. */
  getBlockAtCursor(): string
  setValue(v: string): void
  focus(): void
}

interface Props {
  initialValue?: string
  onChange?: (value: string) => void
  onRun?: () => void
  /** Run everything in the editor (⌘⇧↩). */
  onRunAll?: () => void
  /** Tables and on-demand columns for autocomplete; read on every request, so it may change freely. */
  completion?: CompletionData
  dialect?: 'sqlite' | 'postgres'
  /** Casing, suggestions and aliasing behaviour; read on every keystroke. */
  prefs?: EditorPrefs
  readOnly?: boolean
  placeholder?: string
  className?: string
}

const appTheme = EditorView.theme(
  {
    '&': { backgroundColor: 'var(--bg-editor)', fontSize: '13px', height: '100%' },
    '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55' },
    '.cm-gutters': { backgroundColor: 'var(--bg-editor)', borderRight: '1px solid var(--border)', color: 'var(--text-faint)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.04)' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
    '.cm-content': { padding: '8px 0' },
    '&.cm-focused': { outline: 'none' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--selection) !important' },
    '.cm-tooltip': { backgroundColor: 'var(--bg-elev)', border: '1px solid var(--border-strong)' },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent-strong)' }
  },
  { dark: true }
)

export const SqlEditor = forwardRef<SqlEditorHandle, Props>(function SqlEditor(
  { initialValue = '', onChange, onRun, onRunAll, completion, dialect = 'sqlite', prefs, readOnly = false, placeholder, className },
  ref
) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const schemaComp = useRef(new Compartment())
  const roComp = useRef(new Compartment())
  const keysComp = useRef(new Compartment())
  const onRunRef = useRef(onRun)
  const onRunAllRef = useRef(onRunAll)
  const onChangeRef = useRef(onChange)
  const completionRef = useRef(completion)
  const prefsRef = useRef(prefs ?? DEFAULT_EDITOR_PREFS)
  const dialectRef = useRef(dialect)
  prefsRef.current = prefs ?? DEFAULT_EDITOR_PREFS
  dialectRef.current = dialect
  onRunRef.current = onRun
  onRunAllRef.current = onRunAll
  onChangeRef.current = onChange
  completionRef.current = completion

  /** The completion data as the source sees it: the schema plus the current preferences and dialect. */
  const dataNow = (): CompletionData | null => {
    const c = completionRef.current
    return c ? { ...c, prefs: prefsRef.current, dialect: dialectRef.current } : null
  }

  // The dialect's own keyword list is left out: suggestions come from the statement-aware source only.
  const langExt = () => {
    const d = dialect === 'postgres' ? PostgreSQL : SQLite
    return [d.language, d.language.data.of({ autocomplete: sqlCompletionSource(dataNow) })]
  }

  // The completion keys: the stock bindings for moving and closing, and the user's own keys for accepting.
  const keysExt = (keys: string[]) =>
    Prec.highest(keymap.of([...completionKeymap.filter((b) => b.key !== 'Enter'), ...keys.map((key) => ({ key, run: acceptCompletion }))]))

  // Finishing a word with a space or punctuation re-cases keywords and aliases tables, as the preferences ask.
  const boundaryExt = EditorView.inputHandler.of((v, from, to, text) => {
    if (from !== to) return false
    const edit = boundaryEdit(v.state.sliceDoc(0, from), text, dataNow(), prefsRef.current)
    if (!edit) return false
    v.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, selection: { anchor: edit.from + edit.insert.length }, userEvent: 'input.type' })
    return true
  })
  const roExt = (ro: boolean) => [EditorState.readOnly.of(ro), EditorView.editable.of(!ro)]

  useEffect(() => {
    if (!host.current) return
    const state = EditorState.create({
      doc: initialValue,
      extensions: [
        Prec.highest(
          keymap.of([
            {
              key: 'Shift-Mod-Enter',
              run: () => {
                onRunAllRef.current?.()
                return true
              }
            },
            {
              key: 'Mod-Enter',
              run: () => {
                onRunRef.current?.()
                return true
              }
            }
          ])
        ),
        basicSetup,
        // The stock Enter binding is dropped in favour of the keys chosen in Settings.
        autocompletion({ defaultKeymap: false }),
        keysComp.current.of(keysExt((prefs ?? DEFAULT_EDITOR_PREFS).acceptKeys)),
        keymap.of([indentWithTab]),
        schemaComp.current.of(langExt()),
        boundaryExt,
        roComp.current.of(roExt(readOnly)),
        oneDark,
        appTheme,
        placeholder ? cmPlaceholder(placeholder) : [],
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current?.(u.state.doc.toString())
        })
      ]
    })
    view.current = new EditorView({ state, parent: host.current })
    return () => {
      view.current?.destroy()
      view.current = null
    }
    // The editor is created once; later prop changes go through compartments.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    view.current?.dispatch({ effects: schemaComp.current.reconfigure(langExt()) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialect])

  useEffect(() => {
    view.current?.dispatch({ effects: roComp.current.reconfigure(roExt(readOnly)) })
  }, [readOnly])

  const acceptKeys = (prefs ?? DEFAULT_EDITOR_PREFS).acceptKeys.join(' ')
  useEffect(() => {
    view.current?.dispatch({ effects: keysComp.current.reconfigure(keysExt(acceptKeys ? acceptKeys.split(' ') : [])) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acceptKeys])

  useImperativeHandle(ref, () => ({
    getValue: () => view.current?.state.doc.toString() ?? '',
    getSelection: () => {
      const v = view.current
      if (!v) return ''
      const { from, to } = v.state.selection.main
      return v.state.sliceDoc(from, to)
    },
    getBlockAtCursor: () => {
      const v = view.current
      if (!v) return ''
      return blockAt(v.state.doc.toString(), v.state.selection.main.head)
    },
    setValue: (val: string) => {
      const v = view.current
      if (!v) return
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: val } })
    },
    focus: () => view.current?.focus()
  }))

  return <div ref={host} className={`sql-editor ${className ?? ''}`} data-testid="sql-editor" />
})
