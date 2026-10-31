import { useEffect, useState } from 'react'
import type { BuildResult } from '@core/build'
import { PACK_ARCHIVES, sanitizePackName } from '@core/pack'
import type { Project } from '@core/project'
import type { ExportArchivesResult } from '@shared/ipc'
import { cleanError, fmtBytes } from '../model'

interface Props {
  project: Project
  onChange: (patch: Partial<Project>) => void
  onBuild: () => Promise<BuildResult>
  onExport: (result: BuildResult, packName: string) => Promise<ExportArchivesResult | null>
  onClose: () => void
}

const ARCHIVE_ROLE: Record<string, string> = {
  'WEAPONS_PLAYER.rpf': 'weapon sound banks',
  'RESIDENT.rpf': 'shared sound banks'
}

export function ExportDialog({ project, onChange, onBuild, onExport, onClose }: Props) {
  const [busy, setBusy] = useState<'build' | 'export' | null>('build')
  const [progress, setProgress] = useState('')
  const [result, setResult] = useState<BuildResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [exported, setExported] = useState<ExportArchivesResult | null>(null)

  useEffect(() => window.api.onGameProgress(setProgress), [])

  useEffect(() => {
    let live = true
    // let the dialog paint before the (synchronous) audio processing starts
    const t = setTimeout(() => {
      onBuild()
        .then((r) => live && setResult(r))
        .catch((e) => live && setError(cleanError(e)))
        .finally(() => live && setBusy(null))
    }, 30)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [])

  const exportNow = async (): Promise<void> => {
    if (!result) return
    setBusy('export')
    setError(null)
    setProgress('')
    try {
      const r = await onExport(result, sanitizePackName(project.resourceName))
      if (r) setExported(r)
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(null)
    }
  }

  const name = sanitizePackName(project.resourceName)

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Export sound pack">
      <div className="modal">
        <header>
          <h2>Export sound pack</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close" disabled={busy === 'export'}>
            ✕
          </button>
        </header>
        <p className="muted small">
          Rebuilds the original sound archives from your vanilla pack with your sounds: <span className="mono">WEAPONS_PLAYER.rpf</span> and{' '}
          <span className="mono">RESIDENT.rpf</span>, ready to drag into your mods folder. Your game files are not changed.
        </p>
        <label className="field">
          <span>Pack name</span>
          <input value={project.resourceName} onChange={(e) => onChange({ resourceName: e.target.value })} disabled={!!busy} />
          <small className="muted">Saved in a folder called “{name}”.</small>
        </label>

        {error && <p className="error">{error}</p>}

        {result && !exported && (
          <div className="build-result">
            <ul className="small">
              {result.archives.map((a) => {
                const banks = result.banks.filter((b) => PACK_ARCHIVES[b.pack] === a)
                return (
                  <li key={a}>
                    <b className="mono">{a}</b> — {ARCHIVE_ROLE[a] ?? ''}:{' '}
                    {banks.map((b) => `${b.file} (${b.replaced} replaced${b.silenced ? `, ${b.silenced} silenced` : ''})`).join(', ')}
                  </li>
                )
              })}
            </ul>
            {result.warnings.length > 0 && (
              <ul className="warnings small">
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {exported && (
          <div className="build-result">
            <p className="ok">
              Saved to <span className="mono">{exported.folder}</span>{' '}
              <button
                className="btn subtle small"
                onClick={() => void window.api.showInFolder(exported.archives[0]?.path ?? exported.folder)}
              >
                Show
              </button>
            </p>
            <ul className="small mono">
              {exported.archives.map((a) => (
                <li key={a.file}>
                  {a.file} · {fmtBytes(a.size)}
                </li>
              ))}
              <li>README.txt</li>
            </ul>
            {exported.errors.length > 0 && (
              <ul className="warnings small">
                {exported.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
            <p className="small">
              <b>FiveM:</b> drag the .rpf files into <span className="mono">%localappdata%\FiveM\FiveM.app\mods</span>.
              <br />
              <b>Single player:</b> put them in <span className="mono">GTA V\mods\x64\audio\sfx</span> (OpenIV.asi).
              <br />
              <span className="muted">Don't overwrite the originals in the game folder — FiveM needs those untouched.</span>
            </p>
          </div>
        )}

        <footer className="row gap end">
          {busy && (
            <span className="muted small grow">{busy === 'build' ? 'Preparing your sounds…' : progress || 'Rebuilding archives…'}</span>
          )}
          <button className="btn" onClick={onClose} disabled={busy === 'export'}>
            {exported ? 'Done' : 'Close'}
          </button>
          {!exported && (
            <button className="btn primary" onClick={() => void exportNow()} disabled={!result || !!busy}>
              {busy === 'export' ? 'Exporting…' : 'Export…'}
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}
