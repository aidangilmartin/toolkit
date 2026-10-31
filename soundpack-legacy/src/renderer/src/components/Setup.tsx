import { useEffect, useState } from 'react'
import type { GameSettings, ScanReport, VanillaStatus } from '@shared/ipc'
import { cleanError } from '../model'

interface Props {
  /** "welcome" fills the window on first launch; "rescan" is a dialog. */
  mode: 'welcome' | 'rescan'
  onDone: (report: ScanReport) => void
  onClose?: () => void
}

type Busy = 'import' | 'make' | 'load' | 'zip' | null

const fmtDate = (iso: string | null): string => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '')

/**
 * Where the original sounds come from: a vanilla pack (made by the app, or original archives),
 * kept in the app's own folder so the live game files are never read while you work.
 */
export function Setup({ mode, onDone, onClose }: Props) {
  const [settings, setSettings] = useState<GameSettings | null>(null)
  const [status, setStatus] = useState<VanillaStatus | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [savedZip, setSavedZip] = useState<string | null>(null)

  useEffect(() => {
    void window.api.getGameSettings().then(setSettings)
    void window.api
      .getVanillaStatus()
      .then(setStatus)
      .catch((e) => setError(cleanError(e)))
    return window.api.onGameProgress(setProgress)
  }, [])

  const run = async (what: Busy, task: () => Promise<void>): Promise<void> => {
    setBusy(what)
    setError(null)
    setProgress('Starting')
    try {
      await task()
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(null)
    }
  }

  const load = async (): Promise<void> => {
    const report = await window.api.loadVanillaPack()
    if (report.weapons === 0) throw new Error('No guns were found in this vanilla pack.')
    onDone(report)
  }

  const choose = (from: 'folder' | 'zip'): Promise<void> =>
    run('import', async () => {
      const next = await window.api.importVanillaPack(from)
      if (!next) return
      setStatus(next)
      setSavedZip(null)
      // a pack the app made has everything; original archives also need the GTA V folder
      if (next.kind === 'self-contained' || settings?.gtaValid) await load()
    })

  const make = (): Promise<void> =>
    run('make', async () => {
      setStatus(await window.api.makeVanillaPack())
      setSavedZip(null)
      await load()
    })

  const saveZip = (): Promise<void> =>
    run('zip', async () => {
      const path = await window.api.saveVanillaZip()
      if (path) setSavedZip(path)
    })

  const browse = async (): Promise<void> => {
    setError(null)
    try {
      setSettings(await window.api.setGtaPath())
    } catch (e) {
      setError(cleanError(e))
    }
  }

  const bridge = settings?.bridgeAvailable !== false
  const archivesOnly = status?.kind === 'archives'
  const canLoad = !!status?.kind && (status.kind === 'self-contained' || !!settings?.gtaValid)

  const card = (
    <div className={mode === 'welcome' ? 'setup-card' : 'modal'} role={mode === 'rescan' ? 'dialog' : undefined} aria-label="Set up">
      <header>
        <h2>{mode === 'welcome' ? 'Welcome to Gun Soundpack Maker' : 'Vanilla pack'}</h2>
        {onClose && (
          <button className="icon-btn" onClick={onClose} aria-label="Close" disabled={!!busy}>
            ✕
          </button>
        )}
      </header>
      <p className="muted">
        The app works from a <b>vanilla pack</b>: GTA V's original gun sounds, kept in the app's own folder. Your game files aren't read
        while you work, so sound mods in your game never change what ▶ Original plays.
      </p>

      {!bridge && (
        <p className="error">
          The game-file bridge isn't built. Run <span className="mono">npm run build:bridge</span> (needs the .NET 8 SDK), then restart the
          app.
        </p>
      )}

      {status?.kind && (
        <div className="pack-status" aria-label="Current vanilla pack">
          {status.kind === 'self-contained' ? (
            <span className="ok">
              ✓ Vanilla pack: {status.weapons ?? '?'} guns{status.madeAt ? `, made ${fmtDate(status.madeAt)}` : ''}. Works without GTA V.
            </span>
          ) : (
            <span className="ok">✓ Original archives: {status.archives.join(', ')}. GTA V supplies the keys and the gun data.</span>
          )}
          {status.warnings.map((w) => (
            <span key={w} className="warn-text small">
              {w}
            </span>
          ))}
          {status.encryptedBanks > 0 && (
            <span className="muted small">{status.encryptedBanks} multi-channel banks stay encrypted (no gun uses them).</span>
          )}
          <span className="row gap">
            <button className="btn subtle small" onClick={() => void saveZip()} disabled={!!busy}>
              {busy === 'zip' ? 'Saving…' : 'Save as .zip…'}
            </button>
            {savedZip && <span className="muted small mono">Saved to {savedZip}</span>}
          </span>
        </div>
      )}

      <section className="setup-option">
        <h3>Use a vanilla pack</h3>
        <p className="muted small">
          A pack this app made (a folder, or a .zip of one: works on any PC, with or without GTA V), or original{' '}
          <span className="mono">WEAPONS_PLAYER.rpf</span> / <span className="mono">RESIDENT.rpf</span> you kept as a backup.
        </p>
        <div className="row gap">
          <button className="btn" onClick={() => void choose('zip')} disabled={!!busy || !bridge}>
            {busy === 'import' ? 'Copying…' : 'Choose .zip…'}
          </button>
          <button className="btn" onClick={() => void choose('folder')} disabled={!!busy || !bridge}>
            Choose folder…
          </button>
        </div>
      </section>

      <section className="setup-option">
        <h3>{archivesOnly ? 'GTA V folder' : 'Make one from GTA V'}</h3>
        <p className="muted small">
          {archivesOnly
            ? 'Original archives need your GTA V install for the decryption keys and the gun data. Making a pack from it gives you one that works without GTA V.'
            : 'Copies the original sounds and gun data out of a GTA V install, once. Modded game? Verify the game files in Steam or the Rockstar Games Launcher first, or use a backup of the original archives.'}
        </p>
        <div className="path-row">
          <div>
            <span className="field-title">GTA V folder</span>
            <span className="mono small path">{settings?.gtaPath ?? 'Not found automatically'}</span>
            {settings && (
              <span className={settings.gtaValid ? 'ok small' : 'error small'}>
                {settings.gtaValid
                  ? '✓ gta5.exe found'
                  : settings.gtaPath
                    ? '✕ gta5.exe is not in this folder'
                    : 'Choose the folder that contains gta5.exe'}
              </span>
            )}
          </div>
          <button className="btn" onClick={() => void browse()} disabled={!!busy}>
            Browse…
          </button>
        </div>
        <div className="row gap">
          <button className="btn primary" onClick={() => void make()} disabled={!settings?.gtaValid || !bridge || !!busy}>
            {busy === 'make' ? 'Making…' : 'Make vanilla pack'}
          </button>
        </div>
      </section>

      {error && <p className="error">{error}</p>}

      <footer className="row gap end">
        {busy && <span className="muted small grow">{progress || 'Working…'}</span>}
        {onClose && (
          <button className="btn" onClick={onClose} disabled={!!busy}>
            Cancel
          </button>
        )}
        {status?.kind && (
          <button className="btn primary" onClick={() => void run('load', load)} disabled={!canLoad || !bridge || !!busy}>
            {busy === 'load' ? 'Loading…' : mode === 'welcome' ? 'Find my guns' : 'Load again'}
          </button>
        )}
      </footer>
      {mode === 'welcome' && (
        <p className="muted small">
          Uses CodeWalker by dexyfex to read the game's archives, with the decryption keys from your own gta5.exe. Making a pack takes a
          moment.
        </p>
      )}
    </div>
  )

  return mode === 'welcome' ? <div className="setup">{card}</div> : <div className="modal-backdrop">{card}</div>
}
