import { useMemo, useState } from 'react'
import type { TableMeta } from '@shared/types'
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
  const [collapsed, setCollapsed] = useState<Record<SectionKey, boolean>>({ tables: false, views: false, indexes: true, triggers: true })

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const activeTable = activeTab?.kind === 'table' ? activeTab.table : null
  const q = filter.trim().toLowerCase()
  const match = (name: string) => !q || name.toLowerCase().includes(q)

  const lists = useMemo(() => {
    if (!schema) return null
    return {
      tables: schema.tables.filter((t) => match(t.name) || t.columns.some((c) => q && c.name.toLowerCase().includes(q))),
      views: schema.views.filter((v) => match(v.name)),
      indexes: schema.indexes.filter((i) => match(i.name) || match(i.table)),
      triggers: schema.triggers.filter((t) => match(t.name) || match(t.table))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, q])

  const toggleSection = (k: SectionKey) => setCollapsed((c) => ({ ...c, [k]: !c[k] }))

  const renderTable = (t: TableMeta, icon: IconName) => {
    const isOpen = expanded[t.name] || (q.length > 0 && !match(t.name))
    return (
      <div key={t.name}>
        <div className={`tree-item ${activeTable === t.name ? 'active' : ''}`} onClick={() => openTable(t.name)} title={t.name} data-testid={`tree-${icon}-${t.name}`}>
          <button
            className="tree-toggle"
            onClick={(e) => {
              e.stopPropagation()
              setExpanded((x) => ({ ...x, [t.name]: !isOpen }))
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
              <div key={c.cid} className="tree-col" title={`${c.name} ${c.type}${c.notnull ? ' NOT NULL' : ''}${c.pk ? ' PRIMARY KEY' : ''}`}>
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

  const section = (key: SectionKey, label: string, count: number, body: React.ReactNode) => (
    <div className="tree-section">
      <div className="tree-section-header" onClick={() => toggleSection(key)}>
        <Icon name={collapsed[key] ? 'chevron-right' : 'chevron-down'} size={11} />
        <span>{label}</span>
        <span className="count">{count}</span>
      </div>
      {!collapsed[key] ? body : null}
    </div>
  )

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
            {section(
              'tables',
              'Tables',
              lists.tables.length,
              lists.tables.length ? lists.tables.map((t) => renderTable(t, 'table')) : <div className="tree-empty">No tables</div>
            )}
            {section(
              'views',
              'Views',
              lists.views.length,
              lists.views.length ? lists.views.map((v) => renderTable(v, 'view')) : <div className="tree-empty">No views</div>
            )}
            {section(
              'indexes',
              'Indexes',
              lists.indexes.length,
              lists.indexes.length ? (
                lists.indexes.map((i) => (
                  <div key={i.name} className="tree-item" title={i.sql ?? ''} onClick={() => newQueryTab(i.sql ? i.sql + ';' : `-- ${i.name} is an automatic index`, i.name)}>
                    <span className="tree-toggle placeholder" />
                    <Icon className="tree-icon" name="index" />
                    <span className="tree-name">{i.name}</span>
                    <span className="tree-meta">{i.table}</span>
                  </div>
                ))
              ) : (
                <div className="tree-empty">No indexes</div>
              )
            )}
            {section(
              'triggers',
              'Triggers',
              lists.triggers.length,
              lists.triggers.length ? (
                lists.triggers.map((t) => (
                  <div key={t.name} className="tree-item" title={t.sql ?? ''} onClick={() => newQueryTab((t.sql ?? '') + ';', t.name)}>
                    <span className="tree-toggle placeholder" />
                    <Icon className="tree-icon" name="trigger" />
                    <span className="tree-name">{t.name}</span>
                    <span className="tree-meta">{t.table}</span>
                  </div>
                ))
              ) : (
                <div className="tree-empty">No triggers</div>
              )
            )}
          </>
        )}
      </div>
    </aside>
  )
}
