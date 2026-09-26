import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { describeCounts, ENTITY_TYPES, type AiTranscript, type AiTranscriptEntry } from '@shared/privacy'
import { formatBytes } from '@shared/export'
import { useStore } from '@/store'
import { copyText, errorMessage } from '@/lib/util'
import { countMatches, markText, readableRequest, readableResponse, type WireSection } from '@/lib/wire-view'
import { Modal } from './Modal'
import { Icon } from './Icons'

/** How many protected values show before "Show all". */
const LEGEND_ROWS = 6

function Marked({ text, query, legend }: { text: string; query: string; legend: Map<string, AiTranscriptEntry> }): ReactNode {
  return markText(text, query).map((p, i) => {
    if (p.kind === 'match') return <mark key={i}>{p.text}</mark>
    if (p.kind === 'placeholder') {
      const e = legend.get(p.text)
      const title = e ? `${ENTITY_TYPES[e.type].label}${e.value !== undefined ? `: ${e.value} (stayed on this computer)` : ''}` : 'Placeholder'
      return (
        <span key={i} className="wire-ph" title={title}>
          {p.text}
        </span>
      )
    }
    return p.text
  })
}

function whereWent(t: AiTranscript): string {
  if (t.blocked) return `Local AI Privacy stopped this ask. ${t.blocked.replace(/^Local AI Privacy stopped this request before anything was sent: /, '')}`
  if (!t.protected) {
    return t.exemption === 'this-device'
      ? 'Sent as it is: the model runs on this computer, and protecting local models is off in Settings.'
      : 'Sent as it is: Local AI Privacy is off in Settings.'
  }
  const n = t.report ? Object.values(t.report.counts).reduce((s, c) => s + (c ?? 0), 0) : 0
  const what = n && t.report ? `replaced ${describeCounts(t.report.counts, 6)} with placeholders` : 'found nothing to replace'
  const model = t.report?.engine?.semanticModel ? ' The rules and the on-device model both read every request.' : ''
  return `Local AI Privacy ${what} and checked every request on this computer before it left.${model}${t.report?.policy ? ` Policy ${t.report.policy.id} v${t.report.policy.version}.` : ''}`
}

function legendStatus(e: AiTranscriptEntry): ReactNode {
  if (e.occurrences === 0) {
    return (
      <span className="exchange-ok" title="Counted on the exact bytes of every request, including the JSON-escaped form">
        <Icon name="check" size={11} /> not in what was sent
      </span>
    )
  }
  return (
    <span className="exchange-warn" title="The same characters occur in what was sent. Show values and search for it to see where.">
      appears {e.occurrences}× in what was sent
    </span>
  )
}

function legendValue(e: AiTranscriptEntry, showing: boolean): ReactNode {
  if (e.action !== 'pseudonymize' || !e.restorable) return <span className="exchange-muted">{e.action === 'redact' ? 'removed' : e.action === 'mask' ? 'masked' : e.action === 'generalize' ? 'generalized' : 'not restored'}; never shown</span>
  if (e.value !== undefined) return <span className="exchange-value">{e.value}</span>
  return <span className="exchange-muted">{showing ? 'no longer in memory' : '••••••'}</span>
}

/** Exactly what one ask sent to the model provider and got back, for the user to check. */
export function ExchangeInspector({ requestId, onClose }: { requestId: string; onClose: () => void }) {
  const toast = useStore((s) => s.toast)
  const [transcript, setTranscript] = useState<AiTranscript | null | undefined>(undefined)
  const [showValues, setShowValues] = useState(false)
  const [allRows, setAllRows] = useState(false)
  const [current, setCurrent] = useState(0)
  const [side, setSide] = useState<'sent' | 'received'>('sent')
  const [view, setView] = useState<'readable' | 'raw'>('readable')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Set<number>>(new Set())

  // Values cross into this window only while "Show values" is on; turning it off fetches the transcript without them.
  useEffect(() => {
    let cancelled = false
    window.api.ai
      .transcript(requestId, { values: showValues })
      .then((t) => !cancelled && setTranscript(t))
      .catch((e) => {
        if (!cancelled) {
          setTranscript(null)
          toast('error', 'Could not load what was sent', errorMessage(e))
        }
      })
    return () => {
      cancelled = true
    }
  }, [requestId, showValues, toast])

  const legend = useMemo(() => new Map((transcript?.legend ?? []).map((e) => [e.marker, e])), [transcript])
  const exchanges = transcript?.exchanges ?? []
  const exchange = exchanges[Math.min(current, Math.max(0, exchanges.length - 1))]
  const body = exchange ? (side === 'sent' ? exchange.request : exchange.response) : null
  const sections: WireSection[] = useMemo(() => (exchange ? (side === 'sent' ? readableRequest(exchange.request) : readableResponse(exchange.response)) : []), [exchange, side])
  const sentMatches = useMemo(() => countMatches(exchanges.map((x) => x.request), query), [exchanges, query])
  const receivedMatches = useMemo(() => countMatches(exchanges.map((x) => x.response), query), [exchanges, query])
  const sentTotal = sentMatches.reduce((a, b) => a + b, 0)
  const receivedTotal = receivedMatches.reduce((a, b) => a + b, 0)
  const [sentBytes, receivedBytes] = useMemo(() => {
    const size = (s: string | null) => (s ? new TextEncoder().encode(s).length : 0)
    return [exchanges.reduce((n, x) => n + size(x.request), 0), exchanges.reduce((n, x) => n + size(x.response), 0)]
  }, [exchanges])
  const rows = allRows ? (transcript?.legend ?? []) : (transcript?.legend ?? []).slice(0, LEGEND_ROWS)

  const copy = async () => {
    if (body === null || body === undefined) return
    await copyText(body)
    toast('success', side === 'sent' ? 'Request body copied' : 'Response body copied')
  }

  const toggle = (i: number) =>
    setOpen((o) => {
      const next = new Set(o)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  let content: ReactNode
  if (transcript === undefined) content = <div className="exchange-empty">Loading…</div>
  else if (transcript === null)
    content = (
      <div className="exchange-empty">
        This exchange is no longer held. What each answer sent is kept in memory while the app runs, for the most recent answers only.
      </div>
    )
  else
    content = (
      <>
        <div className="exchange-summary" data-testid="exchange-summary">
          <div className="exchange-headline">
            <Icon name="shield" size={13} />
            <span>
              {exchanges.length} request{exchanges.length === 1 ? '' : 's'} to <strong>{transcript.host}</strong>
              {exchanges.length ? ` · ${formatBytes(sentBytes)} sent · ${formatBytes(receivedBytes)} received` : ''}
            </span>
          </div>
          <p>{whereWent(transcript)}</p>
          <p className="exchange-muted">Shown exactly as it went over the network. Headers are left out because they carry your API key, and values in the address's query string are blanked.</p>
        </div>

        {transcript.legend.length ? (
          <div className="exchange-legend" data-testid="exchange-legend">
            <div className="exchange-legend-head">
              <span className="exchange-title">Protected values</span>
              <label className={`checkbox ${transcript.valuesAvailable ? '' : 'disabled'}`} title={transcript.valuesAvailable ? 'Values are shown on this computer only' : 'This chat no longer holds its values in memory'}>
                <input type="checkbox" checked={showValues} disabled={!transcript.valuesAvailable} onChange={(e) => setShowValues(e.target.checked)} data-testid="exchange-show-values" />
                Show values on this computer
              </label>
            </div>
            <table>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.marker}>
                    <td>
                      <span className="wire-ph">{e.marker}</span>
                    </td>
                    <td className="exchange-muted">{ENTITY_TYPES[e.type].label}</td>
                    <td className="exchange-muted">from {e.where}</td>
                    <td>{legendValue(e, showValues)}</td>
                    <td>{legendStatus(e)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {transcript.legend.length > LEGEND_ROWS ? (
              <button className="btn ghost small" onClick={() => setAllRows(!allRows)}>
                {allRows ? 'Show fewer' : `Show all ${transcript.legend.length}`}
              </button>
            ) : null}
          </div>
        ) : null}

        {exchanges.length ? (
          <>
            <div className="exchange-toolbar">
              {exchanges.length > 1 ? (
                <div className="segmented small" data-testid="exchange-picker">
                  {exchanges.map((x, i) => (
                    <button key={x.n} className={i === current ? 'active' : ''} onClick={() => setCurrent(i)} title={`${x.method} ${x.url} · ${x.durationMs} ms`}>
                      {x.n} · {x.kind}
                      {query && sentMatches[i] ? ' •' : ''}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="segmented small">
                <button className={side === 'sent' ? 'active' : ''} onClick={() => setSide('sent')} data-testid="exchange-sent">
                  Sent
                </button>
                <button className={side === 'received' ? 'active' : ''} onClick={() => setSide('received')} data-testid="exchange-received">
                  Received
                </button>
              </div>
              <div className="segmented small">
                <button className={view === 'readable' ? 'active' : ''} onClick={() => setView('readable')}>
                  Readable
                </button>
                <button className={view === 'raw' ? 'active' : ''} onClick={() => setView('raw')} data-testid="exchange-raw">
                  Raw
                </button>
              </div>
              <span className="spacer" />
              <button className="btn small ghost" onClick={() => void copy()} disabled={!body} title="Copy the exact body">
                <Icon name="copy" size={12} /> Copy
              </button>
            </div>
            <div className="exchange-find">
              <input className="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Check a value: search everything that was sent…" spellCheck={false} data-testid="exchange-search" />
              {query.trim() ? (
                <span className={sentTotal ? 'exchange-warn' : 'exchange-ok'} data-testid="exchange-search-result">
                  {sentTotal ? `found ${sentTotal}× in what was sent` : 'not in anything that was sent'}
                  {receivedTotal ? ` · ${receivedTotal}× in what came back` : ''}
                </span>
              ) : null}
            </div>
            <div className="exchange-content" data-testid="exchange-content">
              <div className="exchange-endpoint">
                {exchange.method} {exchange.url}
                {side === 'received' ? ` · ${exchange.status ?? 'no status'}${exchange.error ? ` · ${exchange.error}` : ''}` : ''} · {exchange.durationMs} ms
                {(side === 'sent' ? exchange.truncated?.request : exchange.truncated?.response) ? ' · too large to keep whole; the beginning is shown' : ''}
              </div>
              {view === 'raw' ? (
                <pre className="wire-raw">{body === null ? 'No response arrived.' : <Marked text={body} query={query} legend={legend} />}</pre>
              ) : (
                sections.map((s, i) => {
                  const folded = s.collapsed && !open.has(i)
                  return (
                    <div className="wire-section" key={`${s.label}-${i}`}>
                      <button className="wire-section-label" onClick={() => s.collapsed && toggle(i)} disabled={!s.collapsed}>
                        {s.collapsed ? <Icon name={folded ? 'chevron-right' : 'chevron-down'} size={10} /> : null}
                        {s.label}
                      </button>
                      {folded ? (
                        <div className="wire-folded" onClick={() => toggle(i)}>
                          {(s.summary ?? s.text.split('\n').find((l) => /\w/.test(l)) ?? '').trim().slice(0, 120)} · {formatBytes(new TextEncoder().encode(s.text).length)}
                          {query.trim() && countMatches([s.text], query)[0] ? ' · has matches' : ''}
                        </div>
                      ) : (
                        <pre className={`wire-text ${s.json ? 'json' : ''}`}>
                          <Marked text={s.text} query={query} legend={legend} />
                        </pre>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </>
        ) : (
          <div className="exchange-empty">Nothing was sent to {transcript.host} for this answer.</div>
        )}
      </>
    )

  return (
    <Modal title="What was sent to the model" onClose={onClose} width={1000} className="exchange-modal">
      <div className="exchange-body" data-testid="exchange-inspector">
        {content}
      </div>
    </Modal>
  )
}
