import { useMemo, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { hex8 } from '@core/hash'
import type { IdCode } from '@core/idpack'
import { pairOf } from '@core/pairs'
import type { ProjectBank } from '@core/project'
import { streamSummary, usageText, type StreamUsage } from '@core/usage'
import { assignmentMap, BankItem, fmtDuration, fmtRate, LoadedTemplate, pairsFor, SourceEntry, streamName } from '../model'

interface Props {
  item: BankItem
  template: LoadedTemplate | null
  loadError: string | null
  bank: ProjectBank | undefined
  labels: Record<string, string>
  sources: Map<string, SourceEntry>
  selection: number[]
  focusId: number | null
  playing: string | null
  onSelect: (ids: number[], focus: number | null) => void
  onPlay: (id: number, which: 'original' | 'new') => void
  onDropFiles: (files: File[], ids: number[]) => void
  onExtractFromGame: () => void
  onImportAwc: () => void
  onImportCodeWalker: () => void
  onRemoveTemplate: () => void
  onChangePack: (pack: string) => void
  /** What a stream is for, from the sound map (null without a map). */
  usageOf?: (id: number) => StreamUsage | null
  /** The stream's ID-pack code. */
  codeOf?: (id: number) => IdCode | undefined
  /** Loads this bank from the game into the library (when the sound map lists it). */
  onLoadFromGame?: () => void
  loadingFromGame?: boolean
}

type Filter = 'all' | 'changed' | 'unchanged' | 'unused'
type Sort = 'id' | 'length' | 'name'

export function BankView(props: Props) {
  const { item, template, bank, labels, selection, focusId, playing } = props
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<Sort>('id')
  const [dropRow, setDropRow] = useState<number | null>(null)

  const assignments = useMemo(() => assignmentMap(bank), [bank])
  const pairs = useMemo(() => (template ? pairsFor(template, bank) : []), [template, bank])

  const usage = useMemo(() => {
    const m = new Map<number, StreamUsage>()
    if (!template || !props.usageOf) return m
    for (const s of template.summaries) {
      const u = props.usageOf(s.id)
      if (u) m.set(s.id, u)
    }
    return m
  }, [template, props.usageOf])

  const rows = useMemo(() => {
    if (!template) return []
    const q = query.trim().toLowerCase()
    let list = template.summaries.map((s) => {
      const u = usage.get(s.id)
      return { ...s, name: streamName(template, s.id, labels), usage: u, summary: u ? streamSummary(u) : '', code: props.codeOf?.(s.id) }
    })
    if (q)
      list = list.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          hex8(r.id).toLowerCase().includes(q.replace(/^0x/, '')) ||
          (r.usage && usageText(r.usage).includes(q)) ||
          (r.code && r.code.code.toLowerCase() === q)
      )
    if (filter === 'changed') list = list.filter((r) => assignments.has(r.id))
    if (filter === 'unchanged') list = list.filter((r) => !assignments.has(r.id))
    if (filter === 'unused') list = list.filter((r) => r.usage?.status === 'unused')
    if (sort === 'length') list.sort((a, b) => b.duration - a.duration)
    if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name))
    return list
  }, [template, labels, query, filter, sort, assignments, usage, props.codeOf])

  if (!item.template) {
    return (
      <section className="bank-view empty-state">
        <h2>{item.label}</h2>
        <p className="muted mono">
          {item.pack}/{item.file}
        </p>
        {item.summary && (
          <p>
            <b>{item.summary.label}</b> · {item.summary.detail}
          </p>
        )}
        {props.onLoadFromGame ? (
          <>
            <p>
              This bank isn't in your library yet. Load it from the vanilla pack to listen to it, see what each sound is for and replace
              them.
            </p>
            <div className="row gap">
              <button className="btn primary" onClick={props.onLoadFromGame} disabled={props.loadingFromGame}>
                {props.loadingFromGame ? 'Loading…' : 'Load from pack'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              This sound bank isn't in your library. Loading the vanilla pack adds every bank the guns use; other banks can be imported by
              hand.
            </p>
            <div className="row gap">
              <button className="btn primary" onClick={props.onExtractFromGame}>
                Vanilla pack…
              </button>
            </div>
          </>
        )}
        <p className="muted small">
          Comes from <span className="mono">{item.pack === 'resident' ? 'RESIDENT.rpf' : 'WEAPONS_PLAYER.rpf'}</span> in the vanilla pack.
          Already exported <span className="mono">{item.file}</span> yourself?{' '}
          <button className="btn subtle small" onClick={props.onImportAwc}>
            Import .awc…
          </button>
          <button className="btn subtle small" onClick={props.onImportCodeWalker}>
            Import CodeWalker XML…
          </button>
        </p>
      </section>
    )
  }

  if (props.loadError) {
    return (
      <section className="bank-view empty-state">
        <h2>{item.label}</h2>
        <p className="error">{props.loadError}</p>
        <button className="btn danger" onClick={props.onRemoveTemplate}>
          Remove from library
        </button>
      </section>
    )
  }

  if (!template) return <section className="bank-view empty-state muted">Loading…</section>

  const visibleIds = rows.map((r) => r.id)
  const selected = new Set(selection)

  const clickRow = (e: MouseEvent, id: number): void => {
    if (e.shiftKey && focusId !== null) {
      const a = visibleIds.indexOf(focusId)
      const b = visibleIds.indexOf(id)
      if (a >= 0 && b >= 0) {
        const range = visibleIds.slice(Math.min(a, b), Math.max(a, b) + 1)
        props.onSelect(e.ctrlKey || e.metaKey ? [...new Set([...selection, ...range])] : range, focusId)
        return
      }
    }
    if (e.ctrlKey || e.metaKey) {
      props.onSelect(selected.has(id) ? selection.filter((x) => x !== id) : [...selection, id], id)
      return
    }
    props.onSelect([id], id)
  }

  const onKey = (e: KeyboardEvent): void => {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return
    const idx = focusId === null ? -1 : visibleIds.indexOf(focusId)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = visibleIds[Math.max(0, Math.min(visibleIds.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)))]
      if (next !== undefined) {
        props.onSelect([next], next)
        document.getElementById(`row-${next}`)?.scrollIntoView({ block: 'nearest' })
      }
    } else if (e.key === ' ' && focusId !== null) {
      e.preventDefault()
      props.onPlay(focusId, e.shiftKey && assignments.get(focusId)?.action === 'replace' ? 'new' : 'original')
    } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      props.onSelect(visibleIds, visibleIds[0] ?? null)
    }
  }

  const drop = (e: DragEvent, id: number): void => {
    e.preventDefault()
    e.stopPropagation()
    setDropRow(null)
    const files = [...e.dataTransfer.files]
    if (files.length) props.onDropFiles(files, selected.has(id) ? selection : [id])
  }

  return (
    <section className="bank-view">
      <header className="bank-header">
        <div>
          <h2>
            {item.label}
            {item.certainty === 'guess' && item.category !== 'other' && (
              <span className="badge" title="This label is inferred from the file name. Listen to confirm.">
                label is a guess
              </span>
            )}
          </h2>
          <p className="muted mono small">
            audio/sfx/{item.pack}/{item.file} · {template.summaries.length} streams ·{' '}
            {item.template.origin === 'gta'
              ? 'from the vanilla pack'
              : item.template.origin === 'codewalker-xml'
                ? 'from CodeWalker XML'
                : 'from .awc'}
          </p>
          {item.summary && (
            <p className="small">
              <b>{item.summary.label}</b> · {item.summary.detail}
            </p>
          )}
          {item.note && <p className="note small">{item.note}</p>}
        </div>
        <div className="row gap">
          <label className="small muted">
            Wave pack{' '}
            <select value={item.pack} onChange={(e) => props.onChangePack(e.target.value)} aria-label="Wave pack folder">
              {[...new Set(['weapons_player', 'resident', item.pack])].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <button className="btn subtle" onClick={props.onRemoveTemplate} title="Remove this template from your library">
            Remove
          </button>
        </div>
      </header>

      <div className="toolbar">
        <input
          type="search"
          placeholder={usage.size ? 'Filter by name, id, code or what it is for (e.g. echo)' : 'Filter by name, label or id'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter streams"
        />
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="Show">
          <option value="all">All streams</option>
          <option value="changed">Changed</option>
          <option value="unchanged">Unchanged</option>
          {usage.size > 0 && <option value="unused">Unused in the game data</option>}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
          <option value="id">Sort: id</option>
          <option value="length">Sort: longest</option>
          <option value="name">Sort: name</option>
        </select>
        <span className="muted small">
          {selection.length > 0 ? `${selection.length} selected · ` : ''}↑↓ move · Space listen · Shift+Space new
        </span>
      </div>

      <div className="table-wrap" tabIndex={0} onKeyDown={onKey}>
        <table className="streams">
          <thead>
            <tr>
              <th className="col-play" />
              {props.codeOf && (
                <th className="col-code" title="The stream's number in the ID pack (its code is the bank's words + this number)">
                  #
                </th>
              )}
              <th>Name</th>
              {usage.size > 0 && <th>Used for</th>}
              <th className="col-id">Id</th>
              <th className="col-num">Length</th>
              <th className="col-num">Rate</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const a = assignments.get(r.id)
              const p = pairOf(pairs, r.id)
              const src = a?.sourceId ? props.sources.get(a.sourceId) : undefined
              const tagOrig = `orig:${item.key}:${r.id}`
              const tagNew = `new:${item.key}:${r.id}`
              return (
                <tr
                  key={r.id}
                  id={`row-${r.id}`}
                  className={`${selected.has(r.id) ? 'selected' : ''}${r.id === focusId ? ' focus' : ''}${dropRow === r.id ? ' drop' : ''}${r.editable ? '' : ' disabled'}`}
                  onClick={(e) => clickRow(e, r.id)}
                  onDoubleClick={() => props.onPlay(r.id, 'original')}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDropRow(r.id)
                  }}
                  onDragLeave={() => setDropRow((d) => (d === r.id ? null : d))}
                  onDrop={(e) => drop(e, r.id)}
                >
                  <td className="col-play">
                    <button
                      className={`icon-btn${playing === tagOrig ? ' playing' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        props.onPlay(r.id, 'original')
                      }}
                      aria-label="Play original"
                      title="Play original"
                      disabled={!r.editable}
                    >
                      {playing === tagOrig ? '■' : '▶'}
                    </button>
                  </td>
                  {props.codeOf && (
                    <td className="col-code muted" title={r.code ? `ID pack code: "${r.code.code}"` : undefined}>
                      {r.code?.index ?? ''}
                    </td>
                  )}
                  <td className="name-cell">
                    <span>{r.name}</span>
                    {p && <span className="badge pair">{p.side === 'left' ? 'L' : 'R'}</span>}
                    {r.looping && <span className="badge">loop</span>}
                  </td>
                  {usage.size > 0 && (
                    <td className={`usage-cell small${r.usage?.status === 'unused' ? ' muted' : ''}`} title={r.summary}>
                      {r.summary}
                    </td>
                  )}
                  <td className="col-id mono muted">{hex8(r.id)}</td>
                  <td className="col-num">{r.editable ? fmtDuration(r.duration) : '—'}</td>
                  <td className="col-num muted">{r.editable ? fmtRate(r.sampleRate) : '—'}</td>
                  <td>
                    <div className="status-cell">
                      {a?.action === 'silence' && <span className="badge warn">Silenced</span>}
                      {a?.action === 'replace' && (
                        <>
                          <button
                            className={`icon-btn small${playing === tagNew ? ' playing' : ''}`}
                            onClick={(e) => {
                              e.stopPropagation()
                              props.onPlay(r.id, 'new')
                            }}
                            aria-label="Play replacement"
                            title="Play replacement"
                          >
                            {playing === tagNew ? '■' : '▶'}
                          </button>
                          <span className="badge accent" title={src?.info.fileName}>
                            {src?.info.fileName ?? 'missing audio'}
                            {a.shape.channel !== 'mix' ? ` (${a.shape.channel === 'left' ? 'L' : 'R'})` : ''}
                          </span>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {rows.length === 0 && <p className="muted center pad">No streams match.</p>}
      </div>
    </section>
  )
}
