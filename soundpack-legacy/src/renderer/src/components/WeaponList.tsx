import { useMemo, useState } from 'react'
import { GROUP_LABELS, GROUP_ORDER, weaponLabel, type Weapon } from '@core/weapons'

interface Props {
  weapons: Weapon[]
  selected: string | null
  changed: Map<string, number>
  onSelect: (name: string) => void
  onRescan: () => void
  stale: boolean
  /** Scanned by an older version: no sound usage map yet. */
  outdated?: boolean
}

export function WeaponList({ weapons, selected, changed, onSelect, onRescan, stale, outdated }: Props) {
  const [query, setQuery] = useState('')
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = weapons.filter((w) => !q || weaponLabel(w).toLowerCase().includes(q) || w.name.toLowerCase().includes(q))
    const order = [...GROUP_ORDER, ...new Set(list.map((w) => w.group).filter((g) => !GROUP_ORDER.includes(g)))]
    return order
      .map((g) => ({ group: g, items: list.filter((w) => w.group === g).sort((a, b) => weaponLabel(a).localeCompare(weaponLabel(b))) }))
      .filter((g) => g.items.length > 0)
  }, [weapons, query])

  return (
    <aside className="sidebar">
      <div className="sidebar-actions">
        <input
          type="search"
          placeholder={`Search ${weapons.length} guns`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search guns"
        />
        {(stale || outdated) && (
          <p className="note small">
            {stale
              ? 'GTA V was updated since the pack was loaded.'
              : 'This vanilla pack was made by an older version: make it again to see what every sound is for.'}{' '}
            <button className="btn subtle small" onClick={onRescan}>
              Vanilla pack…
            </button>
          </p>
        )}
      </div>
      <nav className="bank-list" aria-label="Guns">
        {groups.map((g) => (
          <section key={g.group}>
            <h3>{GROUP_LABELS[g.group] ?? g.group.replace(/^GROUP_/, '')}</h3>
            <ul>
              {g.items.map((w) => (
                <li key={w.name}>
                  <button className={`bank-item${w.name === selected ? ' active' : ''}`} onClick={() => onSelect(w.name)} title={w.name}>
                    <span className="bank-label">{weaponLabel(w)}</span>
                    <span className="bank-meta">
                      {(changed.get(w.name) ?? 0) > 0 && <span className="badge accent">{changed.get(w.name)} changed</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {groups.length === 0 && <p className="muted small pad">No guns match.</p>}
      </nav>
      <div className="sidebar-actions">
        <button className="btn subtle small" onClick={onRescan}>
          Change vanilla pack…
        </button>
      </div>
    </aside>
  )
}
