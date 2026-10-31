import { useEffect, useMemo, useState } from 'react'
import { idEligible, type IdCode, type IdCodes } from '@core/idpack'
import { sanitizePackName } from '@core/pack'
import type { BankSummary, SoundMap } from '@core/usage'
import { weaponLabel, weaponParts, type Weapon, type WeaponIndex } from '@core/weapons'
import type { ExportIdPackResult } from '@shared/ipc'
import { cleanError, fmtBytes } from '../model'
import { CodeLookup } from './CodeLookup'

interface Props {
  map: SoundMap
  codes: IdCodes
  index: WeaponIndex
  weapon: Weapon | null
  summaries: Map<string, BankSummary>
  onFound: (code: IdCode) => void
  onClose: () => void
}

type Scope = 'weapon' | 'guns' | 'all'

/**
 * The in-game ID pack: replaces every sound in the chosen banks with its spoken code so you can hear
 * in game which file plays when, then look the code up.
 */
export function IdPackDialog({ map, codes, index, weapon, summaries, onFound, onClose }: Props) {
  const [scope, setScope] = useState<Scope>(weapon ? 'weapon' : 'guns')
  const [name, setName] = useState('sound-id-pack')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<ExportIdPackResult | null>(null)

  useEffect(() => window.api.onGameProgress(setProgress), [])

  const usable = (key: string): boolean => !!map.banks[key] && !map.banks[key].mc && !map.banks[key].error
  const banks = useMemo(() => {
    let keys: string[]
    if (scope === 'weapon' && weapon) {
      keys = [...new Set(weapon.variants.flatMap((v) => weaponParts(index, v).map((p) => `${p.pack}/${p.bank}`.toLowerCase())))]
    } else if (scope === 'guns') {
      keys = [...summaries.entries()].filter(([, s]) => s.weapons.length > 0).map(([k]) => k)
    } else {
      keys = Object.keys(map.banks)
    }
    return keys.filter(usable).sort()
  }, [scope, weapon, index, summaries, map])
  const sounds = banks.reduce((n, b) => n + map.banks[b].streams.filter((s) => idEligible(map, b, s.id)).length, 0)

  const build = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setProgress('')
    try {
      const r = await window.api.exportIdPack(name, banks)
      if (r) setDone(r)
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Identify sounds in game">
      <div className="modal">
        <header>
          <h2>Identify sounds in game</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close" disabled={busy}>
            ✕
          </button>
        </header>
        <p className="muted small">
          Builds a test pack where every sound in the chosen banks says its code, like “pistol 4”. Install it, play, and look up the codes
          you hear: this settles exactly which file plays when, including sounds the game data can't explain (game code, scripts,
          animations).
        </p>

        {!done && (
          <>
            <fieldset className="scope">
              <legend className="small muted">Which sounds</legend>
              <label className="row gap small">
                <input type="radio" name="scope" checked={scope === 'weapon'} disabled={!weapon} onChange={() => setScope('weapon')} />
                {weapon ? `This gun: ${weaponLabel(weapon)}` : 'This gun (pick one in the Weapons tab)'}
              </label>
              <label className="row gap small">
                <input type="radio" name="scope" checked={scope === 'guns'} onChange={() => setScope('guns')} />
                Every bank with gun sounds
              </label>
              <label className="row gap small">
                <input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} />
                Everything in WEAPONS_PLAYER.rpf and RESIDENT.rpf
              </label>
            </fieldset>
            <p className="small">
              {banks.length} bank{banks.length === 1 ? '' : 's'}, {sounds} sound{sounds === 1 ? '' : 's'}:{' '}
              <span className="muted mono">
                {banks
                  .slice(0, 6)
                  .map((b) => b.split('/')[1])
                  .join(', ')}
                {banks.length > 6 ? ` +${banks.length - 6}` : ''}
              </span>
            </p>
            <label className="field">
              <span>Folder name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
              <small className="muted">Saved in a folder called “{sanitizePackName(name)}”, with ID-LEGEND.txt.</small>
            </label>
          </>
        )}

        {error && <p className="error">{error}</p>}

        {done && (
          <div className="build-result">
            <p className="ok">
              Saved to <span className="mono">{done.folder}</span>{' '}
              <button className="btn subtle small" onClick={() => void window.api.showInFolder(done.archives[0]?.path ?? done.folder)}>
                Show
              </button>
            </p>
            <p className="small">
              {done.labelled} sounds labelled{' '}
              {done.voice ? `with the voice “${done.voice}”` : 'with beeps (no Windows voice was available)'}.
            </p>
            <ul className="small mono">
              {done.archives.map((a) => (
                <li key={a.file}>
                  {a.file} · {fmtBytes(a.size)}
                </li>
              ))}
              <li>ID-LEGEND.txt · README.txt</li>
            </ul>
            {[...done.warnings, ...done.errors].length > 0 && (
              <ul className="warnings small">
                {[...done.warnings, ...done.errors].map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
            <p className="small">
              Install it like a normal pack (<span className="mono">%localappdata%\FiveM\FiveM.app\mods</span>), play, then remove it again.
            </p>
          </div>
        )}

        <CodeLookup codes={codes} onFound={onFound} />

        <footer className="row gap end">
          {busy && <span className="muted small grow">{progress || 'Building the ID pack…'}</span>}
          <button className="btn" onClick={onClose} disabled={busy}>
            {done ? 'Done' : 'Close'}
          </button>
          {!done && (
            <button className="btn primary" onClick={() => void build()} disabled={busy || banks.length === 0}>
              {busy ? 'Building…' : 'Build ID pack…'}
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}
