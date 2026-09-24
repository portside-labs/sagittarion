import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ObjectKind, ObjectSummary } from '@shared/types'
import { tableKey } from '@shared/connections'
import { useSession } from '@/session-store'
import { Icon, type IconName } from './Icons'
import { buildRows, KIND_LABELS, ROW_HEIGHT, type TreeRow } from '@/lib/tree'

const ICONS: Record<ObjectKind, IconName> = { table: 'table', view: 'view', function: 'function', index: 'index', trigger: 'trigger' }
/** Databases up to this many tables open every schema and view group up front. */
const AUTO_EXPAND_TABLES = 2000

function functionMeta(o: ObjectSummary): string {
  if (o.subtype === 'procedure') return 'procedure'
  if (o.subtype === 'aggregate') return 'aggregate'
  if (o.subtype === 'window') return 'window'
  if (o.subtype === 'trigger-function') return 'trigger'
  return o.returns ?? ''
}

export function Sidebar({ width }: { width: number }) {
  const session = useSession((s) => s.session)
  const catalog = useSession((s) => s.catalog)
  const catalogError = useSession((s) => s.catalogError)
  const catalogLoading = useSession((s) => s.catalogLoading)
  const names = useSession((s) => s.names)
  const groups = useSession((s) => s.groups)
  const tables = useSession((s) => s.tables)
  const search = useSession((s) => s.search)
  const refreshSchema = useSession((s) => s.refreshSchema)
  const loadGroup = useSession((s) => s.loadGroup)
  const loadTable = useSession((s) => s.loadTable)
  const runSearch = useSession((s) => s.runSearch)
  const openTable = useSession((s) => s.openTable)
  const openDefinition = useSession((s) => s.openDefinition)
  const tabs = useSession((s) => s.tabs)
  const activeTabId = useSession((s) => s.activeTabId)

  const [filter, setFilter] = useState('')
  const deferredFilter = useDeferredValue(filter)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  // A new session means new keys; forget what was open.
  useEffect(() => {
    setExpanded({})
    setFilter('')
  }, [session?.sessionId])

  // The server search adds indexes, functions, unloaded tables and column matches to the local filter.
  useEffect(() => {
    const q = deferredFilter.trim()
    const t = setTimeout(() => void runSearch(q), 150)
    return () => clearTimeout(t)
  }, [deferredFilter, runSearch])

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const activeTable = activeTab?.kind === 'table' ? tableKey({ schema: activeTab.schema, name: activeTab.table }) : null
  const autoExpand = (catalog?.totalTables ?? 0) <= AUTO_EXPAND_TABLES
  const defaultSchema = catalog?.defaultSchema

  const rows = useMemo<TreeRow[]>(
    () => (catalog ? buildRows({ catalog, names, groups, tables, expanded, filter: deferredFilter, search: search.result, searching: search.loading, activeTable, autoExpand }) : []),
    [catalog, names, groups, tables, expanded, deferredFilter, search, activeTable, autoExpand]
  )

  const toggle = (row: TreeRow) => {
    if (row.type === 'schema' || row.type === 'group') {
      const next = !row.open
      setExpanded((x) => ({ ...x, [row.key]: next }))
      if (row.type === 'group' && next && row.kind !== 'table' && row.kind !== 'view' && !groups[row.key]) void loadGroup(row.schema, row.kind)
    } else if (row.type === 'object' && row.hasChildren) {
      const next = !row.open
      setExpanded((x) => ({ ...x, [row.key]: next }))
      if (next) void loadTable({ schema: row.obj.schema, name: row.obj.name })
    }
  }

  const activate = (row: TreeRow) => {
    if (row.type === 'object') {
      const o = row.obj
      if (o.kind === 'table' || o.kind === 'view') openTable({ schema: o.schema, name: o.name })
      else void openDefinition({ kind: o.kind, schema: o.schema, name: o.name, id: o.id })
    } else if (row.type === 'more') {
      void loadGroup(row.schema, row.kind, true)
    } else {
      toggle(row)
    }
  }

  const testId = (o: ObjectSummary) => `tree-${o.kind}-${o.schema && o.schema !== defaultSchema ? `${o.schema}.` : ''}${o.name}`

  const renderRow = (row: TreeRow): ReactNode => {
    const indent = { paddingLeft: 4 + row.depth * 14 }
    switch (row.type) {
      case 'schema':
        return (
          <div key={row.key} className="tree-item tree-row" style={indent} onClick={() => toggle(row)} title={`Schema ${row.schema}`} data-testid={`tree-schema-${row.schema}`}>
            <button className="tree-toggle" tabIndex={-1}>
              <Icon name={row.open ? 'chevron-down' : 'chevron-right'} size={12} />
            </button>
            <Icon className="tree-icon" name="database" />
            <span className="tree-name">{row.schema}</span>
            <span className="tree-meta">{row.count.toLocaleString()}</span>
          </div>
        )
      case 'group':
        return (
          <div key={row.key} className="tree-section-header tree-row" style={indent} onClick={() => toggle(row)} data-testid={`tree-group-${row.scope}-${row.kind}`}>
            <Icon name={row.open ? 'chevron-down' : 'chevron-right'} size={11} />
            <span>{KIND_LABELS[row.kind]}</span>
            <span className="count">{row.count.toLocaleString()}</span>
            {row.loading ? <span className="spinner tiny" /> : null}
          </div>
        )
      case 'object': {
        const o = row.obj
        const isTable = o.kind === 'table' || o.kind === 'view'
        const meta = isTable ? (o.columnCount ?? '') : o.kind === 'function' ? functionMeta(o) : (o.table ?? '')
        const title = o.kind === 'function' ? `${o.name}(${o.args ?? ''})${o.returns ? ` → ${o.returns}` : ''}${o.language ? ` [${o.language}]` : ''}` : `${o.schema ? `${o.schema}.` : ''}${o.name}${o.comment ? ` — ${o.comment}` : ''}`
        return (
          <div key={row.key} className={`tree-item tree-row ${row.active ? 'active' : ''}`} style={indent} onClick={() => activate(row)} title={title} data-testid={testId(o)}>
            {row.hasChildren ? (
              <button
                className="tree-toggle"
                onClick={(e) => {
                  e.stopPropagation()
                  toggle(row)
                }}
                tabIndex={-1}
              >
                <Icon name={row.open ? 'chevron-down' : 'chevron-right'} size={12} />
              </button>
            ) : (
              <span className="tree-toggle placeholder" />
            )}
            <Icon className="tree-icon" name={ICONS[o.kind]} />
            <span className="tree-name">{o.name}</span>
            <span className="tree-meta">{meta}</span>
          </div>
        )
      }
      case 'column': {
        const c = row.col
        return (
          <div key={row.key} className={`tree-col tree-row ${row.hit ? 'hit' : ''}`} style={indent} title={`${c.name} ${c.type}${c.notnull ? ' NOT NULL' : ''}${c.pk ? ' PRIMARY KEY' : ''}${c.extra ? ` ${c.extra}` : ''}`}>
            {c.pk ? <Icon className="tree-icon" name="key" size={11} /> : <span style={{ width: 11, flex: '0 0 auto' }} />}
            <span className="col-name">{c.name}</span>
            <span className="col-type">{c.type || '—'}</span>
          </div>
        )
      }
      case 'more':
        return (
          <div key={row.key} className="tree-item tree-row more" style={indent} onClick={() => activate(row)} data-testid={`tree-more-${row.scope}-${row.kind}`}>
            <span className="tree-toggle placeholder" />
            <Icon className="tree-icon" name="chevron-down" size={12} />
            <span className="tree-name">Load more</span>
            <span className="tree-meta">{row.remaining.toLocaleString()} left</span>
          </div>
        )
      case 'info':
        return (
          <div key={row.key} className="tree-empty tree-row" style={indent}>
            {row.spinner ? <span className="spinner tiny" /> : null}
            <span>{row.text}</span>
          </div>
        )
    }
  }

  const progress = names.total > 0 && !names.complete ? Math.min(99, Math.round((names.loaded / names.total) * 100)) : null

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-header">
        <div className="search">
          <Icon className="icon" name="search" size={13} />
          <input className="text" placeholder="Filter objects" value={filter} onChange={(e) => setFilter(e.target.value)} spellCheck={false} data-testid="tree-filter" />
          {filter ? (
            <button className="btn ghost icon small clear" title="Clear filter" onClick={() => setFilter('')}>
              <Icon name="x" size={11} />
            </button>
          ) : null}
        </div>
        <button className="btn ghost icon small" title="Refresh schema" onClick={() => void refreshSchema()} disabled={catalogLoading}>
          {catalogLoading ? <span className="spinner" /> : <Icon name="refresh" />}
        </button>
      </div>
      {progress !== null ? (
        <div className="names-progress" title={`Loading table names: ${names.loaded.toLocaleString()} of ${names.total.toLocaleString()}`} data-testid="names-progress">
          <div className="bar" style={{ width: `${progress}%` }} />
        </div>
      ) : null}
      {catalogError ? <div className="sidebar-error">{catalogError}</div> : null}
      {!catalog ? <div className="tree">{!catalogError ? <div className="tree-empty">Loading schema…</div> : null}</div> : <VirtualList rows={rows} render={renderRow} />}
    </aside>
  )
}

/** Draws only the rows in view, so a schema with thousands of tables costs a few dozen DOM nodes. */
function VirtualList({ rows, render }: { rows: TreeRow[]; render: (row: TreeRow) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(800)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setHeight(el.clientHeight || 800)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const total = rows.length * ROW_HEIGHT
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 8)
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + 8)

  return (
    <div ref={ref} className="tree vtree" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} data-testid="tree">
      <div style={{ height: total, position: 'relative' }}>
        <div style={{ position: 'absolute', top: start * ROW_HEIGHT, left: 0, right: 0 }}>{rows.slice(start, end).map(render)}</div>
      </div>
    </div>
  )
}
