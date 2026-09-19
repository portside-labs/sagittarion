import { useCallback, useEffect, useState } from 'react'
import type { FileEntry, ReaddirResult } from '@shared/types'
import { Modal } from './Modal'
import { Icon } from './Icons'
import { formatBytes } from '@/lib/format'
import { errorMessage } from '@/lib/util'

const DB_RE = /\.(db|sqlite|sqlite3|db3|s3db|sl3)$/i

function posixDirname(p: string): string {
  const idx = p.lastIndexOf('/')
  if (idx <= 0) return '/'
  return p.slice(0, idx)
}

export function RemoteFileBrowser({
  sessionId,
  initialPath,
  onPick,
  onClose
}: {
  sessionId: string
  initialPath?: string
  onPick: (path: string) => void
  onClose: () => void
}) {
  const [listing, setListing] = useState<ReaddirResult | null>(null)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<FileEntry | null>(null)
  const [showHidden, setShowHidden] = useState(false)

  const load = useCallback(
    async (dir: string) => {
      setLoading(true)
      setError(null)
      try {
        const res = await window.api.sftp.readdir(sessionId, dir)
        setListing(res)
        setInput(res.path)
        setSelected(null)
      } catch (e) {
        setError(errorMessage(e))
      } finally {
        setLoading(false)
      }
    },
    [sessionId]
  )

  useEffect(() => {
    const start = initialPath?.trim()
    void load(start && start.startsWith('/') ? posixDirname(start) : start && start.startsWith('~') ? posixDirname(start) : '.')
  }, [initialPath, load])

  const entries = (listing?.entries ?? []).filter((e) => showHidden || !e.name.startsWith('.'))

  const pick = () => {
    if (selected && !selected.isDir) onPick(selected.path)
  }

  return (
    <Modal
      title="Choose a database on the remote host"
      onClose={onClose}
      width={720}
      footer={
        <>
          <label className="checkbox">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
            Show hidden files
          </label>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!selected || selected.isDir} onClick={pick}>
            Select
          </button>
        </>
      }
    >
      <div className="fb-path">
        <button className="btn icon" title="Parent directory" disabled={!listing?.parent} onClick={() => listing?.parent && load(listing.parent)}>
          <Icon name="arrow-up" />
        </button>
        <button className="btn icon" title="Home directory" onClick={() => load('.')}>
          <Icon name="home" />
        </button>
        <input
          className="text mono"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void load(input)
          }}
          spellCheck={false}
        />
        <button className="btn" onClick={() => load(input)}>
          Go
        </button>
      </div>
      <div className="fb-list">
        {error ? (
          <div className="fb-empty" style={{ color: '#ffb4b0' }}>
            {error}
          </div>
        ) : entries.length === 0 && !loading ? (
          <div className="fb-empty">Empty directory</div>
        ) : (
          entries.map((e) => {
            const isDb = !e.isDir && DB_RE.test(e.name)
            return (
              <div
                key={e.path}
                className={`fb-row ${e.isDir ? 'dir' : ''} ${isDb ? 'db' : ''} ${selected?.path === e.path ? 'selected' : ''}`}
                onClick={() => setSelected(e)}
                onDoubleClick={() => (e.isDir ? void load(e.path) : onPick(e.path))}
              >
                <Icon className="fb-icon" name={e.isDir ? 'folder' : isDb ? 'database' : 'file'} />
                <span className="fb-name">
                  {e.name}
                  {e.isSymlink ? ' →' : ''}
                </span>
                <span className="fb-size">{e.isDir ? '' : formatBytes(e.size)}</span>
                <span className="fb-date">{e.mtime ? new Date(e.mtime).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''}</span>
              </div>
            )
          })
        )}
      </div>
      <div className="fb-status">
        {loading ? <span className="spinner" /> : null}
        <span className="mono">{selected ? selected.path : listing?.path ?? ''}</span>
      </div>
    </Modal>
  )
}
