import { useState, type ReactNode } from 'react'
import { BankCategory, CATEGORY_LABELS } from '@core/catalog'
import type { BankItem } from '../model'

interface Props {
  items: BankItem[]
  activeKey: string | null
  /** Shown above the list (the "What did I hear?" lookup). */
  top?: ReactNode
  onSelect: (item: BankItem) => void
  onExtractFromGame: () => void
  onImportAwc: () => void
  onImportCodeWalker: () => void
}

const ORDER: BankCategory[] = ['shared', 'pistol', 'smg', 'rifle', 'shotgun', 'sniper', 'mg', 'heavy', 'other']
const ARCHIVE_ORDER = ['WEAPONS_PLAYER.rpf', 'RESIDENT.rpf', 'Imported']

export function Sidebar({ items, activeKey, top, onSelect, onExtractFromGame, onImportAwc, onImportCodeWalker }: Props) {
  const [query, setQuery] = useState('')
  const imported = items.filter((i) => i.template).length
  const q = query.trim().toLowerCase()
  const shown = q
    ? items.filter((i) => `${i.file} ${i.label} ${i.summary?.label ?? ''} ${i.summary?.weapons.join(' ') ?? ''}`.toLowerCase().includes(q))
    : items
  // with the sound map, banks are grouped by archive; without it, by the catalog's gun categories
  const byArchive = items.some((i) => i.group)
  const groups: { title: string; items: BankItem[] }[] = byArchive
    ? [...new Set([...ARCHIVE_ORDER, ...shown.map((i) => i.group ?? 'Imported')])].map((g) => ({
        title: g,
        items: shown.filter((i) => (i.group ?? 'Imported') === g)
      }))
    : ORDER.map((cat) => ({ title: CATEGORY_LABELS[cat], items: shown.filter((i) => i.category === cat) }))

  return (
    <aside className="sidebar">
      <div className="sidebar-actions">
        {top}
        <button className="btn" onClick={onExtractFromGame} title="Choose, make or save the vanilla pack the original sounds come from">
          Change vanilla pack…
        </button>
        <div className="row gap import-row">
          <button className="btn subtle small" onClick={onImportAwc} title="Import .awc files you exported yourself">
            Import .awc…
          </button>
          <button
            className="btn subtle small"
            onClick={onImportCodeWalker}
            title="Import CodeWalker 'Export XML' output (.awc.xml + wav folder)"
          >
            Import XML…
          </button>
        </div>
        <p className="muted small">
          {imported} bank{imported === 1 ? '' : 's'} in your library{byArchive ? ` · ${items.length} in the game's archives` : ''}.
        </p>
        <input
          type="search"
          placeholder="Filter banks or weapons"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter banks"
        />
      </div>
      <nav className="bank-list" aria-label="Sound banks">
        {groups.map((group) => {
          if (group.items.length === 0) return null
          return (
            <section key={group.title}>
              <h3>{group.title}</h3>
              <ul>
                {group.items.map((item) => (
                  <li key={item.key}>
                    <button
                      className={`bank-item${item.key === activeKey ? ' active' : ''}${item.template ? '' : ' missing'}`}
                      onClick={() => onSelect(item)}
                      title={`${item.pack}/${item.file}${item.summary ? `\n${item.summary.label} · ${item.summary.detail}` : ''}`}
                    >
                      <span className="bank-label">
                        {item.label}
                        {item.certainty === 'guess' && item.category !== 'other' && <span className="guess">?</span>}
                        {item.summary && item.summary.label !== item.label && <span className="bank-summary">{item.summary.label}</span>}
                      </span>
                      <span className="bank-meta">
                        {item.changed > 0 && <span className="badge accent">{item.changed} changed</span>}
                        {item.template ? (
                          <span className="muted">{item.template.streamCount}</span>
                        ) : item.summary ? (
                          <span className="muted" title="Not loaded yet: open it to load it from the vanilla pack">
                            {item.summary.streams}
                          </span>
                        ) : (
                          <span className="muted">not imported</span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
        {shown.length === 0 && <p className="muted small pad">No banks match.</p>}
      </nav>
    </aside>
  )
}
