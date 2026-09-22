import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Compartment, EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { PostgreSQL, sql, SQLite } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'
import { basicSetup } from 'codemirror'

export interface SqlEditorHandle {
  getValue(): string
  getSelection(): string
  setValue(v: string): void
  focus(): void
}

interface Props {
  initialValue?: string
  onChange?: (value: string) => void
  onRun?: () => void
  schema?: Record<string, any>
  defaultSchema?: string
  dialect?: 'sqlite' | 'postgres'
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
  { initialValue = '', onChange, onRun, schema, defaultSchema, dialect = 'sqlite', readOnly = false, placeholder, className },
  ref
) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const schemaComp = useRef(new Compartment())
  const roComp = useRef(new Compartment())
  const onRunRef = useRef(onRun)
  const onChangeRef = useRef(onChange)
  onRunRef.current = onRun
  onChangeRef.current = onChange

  const langExt = (s?: Record<string, any>) =>
    sql({ dialect: dialect === 'postgres' ? PostgreSQL : SQLite, schema: s, defaultSchema, upperCaseKeywords: true })
  const roExt = (ro: boolean) => [EditorState.readOnly.of(ro), EditorView.editable.of(!ro)]

  useEffect(() => {
    if (!host.current) return
    const state = EditorState.create({
      doc: initialValue,
      extensions: [
        Prec.highest(
          keymap.of([
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
        keymap.of([indentWithTab]),
        schemaComp.current.of(langExt(schema)),
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
    view.current?.dispatch({ effects: schemaComp.current.reconfigure(langExt(schema)) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, defaultSchema, dialect])

  useEffect(() => {
    view.current?.dispatch({ effects: roComp.current.reconfigure(roExt(readOnly)) })
  }, [readOnly])

  useImperativeHandle(ref, () => ({
    getValue: () => view.current?.state.doc.toString() ?? '',
    getSelection: () => {
      const v = view.current
      if (!v) return ''
      const { from, to } = v.state.selection.main
      return v.state.sliceDoc(from, to)
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
