import { useMemo, useState, type ReactNode } from 'react'
import type { IndexMeta, TableMeta, TriggerMeta } from '@shared/types'
import { sameTable, tableLabel } from '@shared/connections'
import { useStore } from '@/store'
import { Icon, type IconName } from './Icons'

type SectionKey = 'tables' | 'views' | 'indexes' | 'triggers'

export function Sidebar({ width }: { width: number }) {
  const schema = useStore((s) => s.schema)
  const schemaError = useStore((s) => s.schemaError)
  const schemaLoading = useStore((s) => s.schemaLoading)
  const refreshSchema = useStore((s) => s.refreshSchema)
  const openTable = useStore((s) => s.openTable)
  const newQueryTab = useStore((s) => s.newQueryTab)
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)

  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ indexes: true, triggers: true })

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const activeRef = activeTab?.kind === 'table' ? { schema: activeTab.schema, name: activeTab.table } : null
  const q = filter.trim().toLowerCase()
  const match = (name: string) => !q || name.toLowerCase().includes(q)
  const defaultSchema = schema?.defaultSchema

  const lists = useMemo(() => {
    if (!schema) return null
    const tableMatch = (t: TableMeta) => match(t.name) || (t.schema ? match(`${t.schema}.${t.name}`) : false) || (q.length > 0 && t.columns.some((c) => c.name.toLowerCase().includes(q)))
    return {
      tables: schema.tables.filter(tableMatch),
      views: schema.views.filter(tableMatch),
      indexes: schema.indexes.filter((i) => match(i.name) || match(i.table)),
      triggers: schema.triggers.filter((t) => match(t.name) || match(t.table))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, q])

  const isCollapsed = (key: string) => Boolean(collapsed[key])
  const toggleCollapsed = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }))

  const renderTable = (t: TableMeta, icon: IconName) => {
    const key = `${t.schema ?? ''}.${t.name}`
    const isOpen = expanded[key] || (q.length > 0 && !match(t.name))
    const ref = { schema: t.schema, name: t.name }
    return (
      <div key={key}>
        <div
          className={`tree-item ${activeRef && sameTable(activeRef, ref) ? 'active' : ''}`}
          onClick={() => openTable(ref)}
          title={tableLabel(ref, defaultSchema)}
          data-testid={`tree-${icon}-${t.schema && t.schema !== defaultSchema ? `${t.schema}.` : ''}${t.name}`}
        >
          <button
            className="tree-toggle"
            onClick={(e) => {
              e.stopPropagation()
              setExpanded((x) => ({ ...x, [key]: !isOpen }))
            }}
            tabIndex={-1}
          >
            <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={12} />
          </button>
          <Icon className="tree-icon" name={icon} />
          <span className="tree-name">{t.name}</span>
          <span className="tree-meta">{t.columns.length}</span>
        </div>
        {isOpen ? (
          <div className="tree-children">
            {t.columns.map((c) => (
              <div key={c.cid} className="tree-col" title={`${c.name} ${c.type}${c.notnull ? ' NOT NULL' : ''}${c.pk ? ' PRIMARY KEY' : ''}${c.extra ? ` ${c.extra}` : ''}`}>
                {c.pk ? <Icon className="tree-icon" name="key" size={11} /> : <span style={{ width: 11 }} />}
                <span className="col-name">{c.name}</span>
                <span className="col-type">{c.type || '—'}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    )
  }

  const section = (key: string, label: string, count: number, body: ReactNode) => (
    <div className="tree-section" key={key}>
      <div className="tree-section-header" onClick={() => toggleCollapsed(key)}>
        <Icon name={isCollapsed(key) ? 'chevron-right' : 'chevron-down'} size={11} />
        <span>{label}</span>
        <span className="count">{count}</span>
      </div>
      {!isCollapsed(key) ? body : null}
    </div>
  )

  const tablesAndViews = (tables: TableMeta[], views: TableMeta[], keyPrefix = '') => (
    <>
      {section(`${keyPrefix}tables`, 'Tables', tables.length, tables.length ? tables.map((t) => renderTable(t, 'table')) : <div className="tree-empty">No tables</div>)}
      {section(`${keyPrefix}views`, 'Views', views.length, views.length ? views.map((v) => renderTable(v, 'view')) : <div className="tree-empty">No views</div>)}
    </>
  )

  const renderIndex = (i: IndexMeta) => (
    <div key={`${i.schema ?? ''}.${i.name}`} className="tree-item" title={i.sql ?? ''} onClick={() => newQueryTab(i.sql ? i.sql + ';' : `-- ${i.name} is an automatic index`, i.name)}>
      <span className="tree-toggle placeholder" />
      <Icon className="tree-icon" name="index" />
      <span className="tree-name">{i.name}</span>
      <span className="tree-meta">{tableLabel({ schema: i.schema, name: i.table }, defaultSchema)}</span>
    </div>
  )
  const renderTrigger = (t: TriggerMeta) => (
    <div key={`${t.schema ?? ''}.${t.name}`} className="tree-item" title={t.sql ?? ''} onClick={() => newQueryTab((t.sql ?? '') + ';', t.name)}>
      <span className="tree-toggle placeholder" />
      <Icon className="tree-icon" name="trigger" />
      <span className="tree-name">{t.name}</span>
      <span className="tree-meta">{tableLabel({ schema: t.schema, name: t.table }, defaultSchema)}</span>
    </div>
  )

  // Postgres databases with more than one schema get a schema level in the tree.
  const groupBySchema = schema?.kind === 'postgres' && (schema.schemas?.length ?? 0) > 1
  let body: ReactNode = null
  if (lists && schema) {
    if (groupBySchema) {
      const names = schema.schemas ?? []
      body = names.map((name) => {
        const tables = lists.tables.filter((t) => t.schema === name)
        const views = lists.views.filter((v) => v.schema === name)
        if (q && tables.length === 0 && views.length === 0) return null
        const key = `schema:${name}`
        const open = !isCollapsed(key)
        return (
          <div className="tree-schema" key={key}>
            <div className="tree-item" onClick={() => toggleCollapsed(key)} title={`Schema ${name}`}>
              <button className="tree-toggle" tabIndex={-1}>
                <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
              </button>
              <Icon className="tree-icon" name="database" />
              <span className="tree-name">{name}</span>
              <span className="tree-meta">{tables.length + views.length}</span>
            </div>
            {open ? <div className="tree-schema-body">{tablesAndViews(tables, views, `${name}:`)}</div> : null}
          </div>
        )
      })
    } else {
      body = tablesAndViews(lists.tables, lists.views)
    }
  }

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-header">
        <div className="search">
          <Icon className="icon" name="search" size={13} />
          <input className="text" placeholder="Filter objects" value={filter} onChange={(e) => setFilter(e.target.value)} spellCheck={false} />
        </div>
        <button className="btn ghost icon small" title="Refresh schema" onClick={() => void refreshSchema()} disabled={schemaLoading}>
          {schemaLoading ? <span className="spinner" /> : <Icon name="refresh" />}
        </button>
      </div>
      <div className="tree">
        {schemaError ? <div className="sidebar-error">{schemaError}</div> : null}
        {!lists ? (
          !schemaError ? <div className="tree-empty">Loading schema…</div> : null
        ) : (
          <>
            {body}
            {section('indexes', 'Indexes', lists.indexes.length, lists.indexes.length ? lists.indexes.map(renderIndex) : <div className="tree-empty">No indexes</div>)}
            {section('triggers', 'Triggers', lists.triggers.length, lists.triggers.length ? lists.triggers.map(renderTrigger) : <div className="tree-empty">No triggers</div>)}
          </>
        )}
      </div>
    </aside>
  )
}
