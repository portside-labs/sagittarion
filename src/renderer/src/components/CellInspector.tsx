import { useEffect, useState } from 'react'
import { isTagged, type CellValue } from '@shared/types'
import type { GridColumn } from './DataGrid'
import { Icon } from './Icons'
import { hexDump, inspectorText, parseCellInput, storageClass, valueLength } from '@/lib/format'
import { copyText } from '@/lib/util'

export function CellInspector({
  column,
  value,
  editable,
  onStage,
  onClose,
  rowLabel
}: {
  column: GridColumn | null
  value: CellValue | undefined
  editable: boolean
  onStage?: (v: CellValue) => void
  onClose: () => void
  rowLabel?: string
}) {
  const original = value === undefined ? null : value
  const originalText = value === undefined ? '' : original === null ? '' : inspectorText(original)
  const [draft, setDraft] = useState(originalText)
  const isBlob = isTagged(original) && original.$type === 'blob'

  useEffect(() => {
    setDraft(originalText)
  }, [originalText, column?.name, rowLabel])

  const changed = draft !== originalText
  const canEdit = editable && !!column && !column.readOnly && !!onStage

  return (
    <aside className="inspector" data-testid="inspector">
      <div className="inspector-header">
        <span>Cell</span>
        <button className="btn ghost icon small" onClick={onClose} title="Close inspector">
          <Icon name="x" />
        </button>
      </div>
      <div className="inspector-body">
        {!column || value === undefined ? (
          <div className="placeholder">Select a cell to inspect it.</div>
        ) : (
          <>
            <dl className="kv">
              <dt>Column</dt>
              <dd title={column.name}>{column.name}</dd>
              <dt>Declared</dt>
              <dd>{column.declType || '—'}</dd>
              <dt>Stored as</dt>
              <dd>{original === null ? 'NULL' : storageClass(original)}</dd>
              <dt>Length</dt>
              <dd>{valueLength(original)}</dd>
              {rowLabel ? (
                <>
                  <dt>Row</dt>
                  <dd>{rowLabel}</dd>
                </>
              ) : null}
            </dl>
            {isBlob ? (
              <pre className="hex">{hexDump(original as any)}</pre>
            ) : (
              <textarea
                className="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                readOnly={!canEdit}
                placeholder={original === null ? 'NULL' : ''}
                spellCheck={false}
              />
            )}
            <div className="inspector-actions">
              <button className="btn small" onClick={() => void copyText(original === null ? '' : inspectorText(original))}>
                <Icon name="copy" /> Copy
              </button>
              {canEdit ? (
                <>
                  <button className="btn small" disabled={original === null} onClick={() => onStage!(null)} title="Stage NULL for this cell">
                    Set NULL
                  </button>
                  <span className="spacer" style={{ flex: 1 }} />
                  <button className="btn small primary" disabled={!changed || isBlob} onClick={() => onStage!(parseCellInput(draft, column.declType))}>
                    Stage change
                  </button>
                </>
              ) : null}
            </div>
          </>
        )}
      </div>
    </aside>
  )
}
