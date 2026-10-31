import type { StreamRef } from '@core/project'
import { refKey } from '../model'

/** A change to sounds where some are also part of other guns' shots. */
export interface SharedChange {
  /** What will happen, e.g. "Replace with shot.wav". */
  what: string
  refs: StreamRef[]
  /** The selected sounds other guns fire too. */
  shared: StreamRef[]
  guns: string[]
  apply: (refs: StreamRef[]) => void
}

interface Props {
  change: SharedChange
  onClose: () => void
  onNothingLeft: () => void
}

const MAX_NAMES = 8

/** "This sound is", "These sounds are" or "2 of the 5 sounds are". */
export const whichSounds = (shared: number, total: number): string =>
  shared < total ? `${shared} of the ${total} sounds are` : total === 1 ? 'This sound is' : 'These sounds are'

/** Asks before a change reaches other guns: change them too, only this gun's own files, or cancel. */
export function SharedConfirm({ change, onClose, onNothingLeft }: Props) {
  const shared = new Set(change.shared.map(refKey))
  const own = change.refs.filter((r) => !shared.has(refKey(r)))
  const names =
    change.guns.slice(0, MAX_NAMES).join(', ') + (change.guns.length > MAX_NAMES ? ` and ${change.guns.length - MAX_NAMES} more` : '')
  const run = (refs: StreamRef[]): void => {
    onClose()
    if (refs.length) change.apply(refs)
    else onNothingLeft()
  }
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Also used by other guns">
      <div className="modal">
        <header>
          <h2>Also used by other guns</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <p>
          {whichSounds(change.shared.length, change.refs.length)} also part of the shot of{' '}
          {change.guns.length === 1 ? 'another gun' : `${change.guns.length} other guns`}: {names}.
        </p>
        <p className="muted small">
          GTA V builds many shots from shared layers. Changing a shared sound changes those guns too, in your pack and in game.
        </p>
        <footer className="row gap end">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" onClick={() => run(own)} disabled={own.length === 0}>
            Only this gun's files ({own.length})
          </button>
          <button className="btn primary" onClick={() => run(change.refs)}>
            {change.what}: change them too
          </button>
        </footer>
      </div>
    </div>
  )
}
