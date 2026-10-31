import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react'
import { decodeStreamPcm } from '@core/awc/replace'
import { getFormat } from '@core/awc/types'
import { fileLabel, gunFiles, sameSoundsAs, sharingNote, shotSharing, type GunFile, type HeardBy } from '@core/describe'
import { findOnset, pickChannel, shapeAudio } from '@core/dsp'
import { bankKey, findAssignment, type Project, type StreamRef } from '@core/project'
import { newPlanState, planFiring, seededRng, shotRoles, type Environment, type Listener, type Voice } from '@core/soundgraph'
import {
  audienceVariants,
  fireRate,
  GROUP_LABELS,
  roleLabel,
  usesAutoSound,
  weaponLabel,
  weaponParts,
  type Weapon,
  type WeaponIndex
} from '@core/weapons'
import { decodeAudio, player } from '../audio'
import { fmtDuration, refKey, type LoadedTemplate, type SourceEntry } from '../model'
import { mixdown, renderPreview, toFloat, type ResolvedWave } from '../preview'
import { Waveform } from './Waveform'

interface Props {
  index: WeaponIndex
  weapon: Weapon
  /** Readable names for hashes (from the sound map), for sound set entries and conditions. */
  names: Record<string, string>
  templates: Map<string, LoadedTemplate>
  ensureBank: (pack: string, bank: string) => void
  project: Project
  sources: Map<string, SourceEntry>
  selection: StreamRef[]
  focus: StreamRef | null
  playing: string | null
  onSelect: (refs: StreamRef[], focus: StreamRef | null) => void
  onPlayPart: (ref: StreamRef, which: 'original' | 'new') => void
  onDropFiles: (files: File[], refs: StreamRef[]) => void
  onError: (message: string) => void
}

const HEARD_BY: Record<HeardBy, string> = { you: 'You', others: 'Others', everyone: 'Everyone' }

/** Quick selections for a part, shown when they differ from "Select all": your files, others', this gun's own. */
function selectChoices(files: GunFile[]): [string, GunFile[]][] {
  const choices: [string, GunFile[]][] = [
    ['Yours', files.filter((f) => f.heardBy !== 'others')],
    ["Others'", files.filter((f) => f.heardBy !== 'you')],
    ["Only this gun's", files.filter((f) => shotSharing(f).length === 0)]
  ]
  return choices.filter(([, picked]) => picked.length > 0 && picked.length < files.length)
}
const DISTANCES: [number, string][] = [
  [0, 'At the gun'],
  [10, '10 m away'],
  [25, '25 m away'],
  [50, '50 m away'],
  [100, '100 m away'],
  [300, '300 m away']
]

const toRef = (f: GunFile): StreamRef => ({ pack: f.pack, file: f.bank, streamId: f.streamId })

interface Recording {
  name: string
  samples: Float32Array
  sampleRate: number
}

export function WeaponView(props: Props) {
  const { index, weapon, templates, project, sources, selection, focus, playing } = props
  const [listenAs, setListenAs] = useState<'you' | 'npc'>('you')
  const [distance, setDistance] = useState(0)
  const [environment, setEnvironment] = useState<Environment>('outdoor')
  const [burst, setBurst] = useState(false)
  const [suppressed, setSuppressed] = useState(false)
  const [seed, setSeed] = useState(1)
  const [busy, setBusy] = useState<string | null>(null)
  const [last, setLast] = useState<{ which: 'original' | 'yours'; samples: Float32Array; approximations: string[] } | null>(null)
  const [recording, setRecording] = useState<Recording | null>(null)
  const [dropRole, setDropRole] = useState<string | null>(null)
  const originals = useRef(new Map<string, ResolvedWave>())
  const shaped = useRef(new Map<string, ResolvedWave>())

  const variants = useMemo(() => audienceVariants(index, weapon), [index, weapon])
  const variant = listenAs === 'npc' && variants.others ? variants.others : variants.player
  const sections = useMemo(() => gunFiles(index, weapon, props.names), [index, weapon, props.names])
  const twins = useMemo(() => sameSoundsAs(index, weapon), [index, weapon])
  // this gun's names for its parts (an automatic gun's rapid fire is its gunshot)
  const partLabel = (role: string): string => sections.find((s) => s.role === role)?.label ?? roleLabel(role)
  const hasSuppressed = !!variant?.roles.suppressed
  const fullAuto = !!variant && usesAutoSound(index, weapon, variant)

  useEffect(() => {
    setLast(null)
    setSuppressed(false)
    setListenAs('you')
    setRecording(null)
  }, [weapon.name])

  // load every bank this weapon uses (both audiences)
  useEffect(() => {
    const banks = new Set<string>()
    for (const v of weapon.variants) for (const p of weaponParts(index, v)) banks.add(`${p.pack}\n${p.bank}`)
    for (const b of banks) {
      const [pack, bank] = b.split('\n')
      props.ensureBank(pack, bank)
    }
  }, [index, weapon])

  const ordered = sections.flatMap((s) => s.files.map(toRef))
  const fileCount = new Set(ordered.map(refKey)).size
  const selected = new Set(selection.map(refKey))

  const resolve =
    (which: 'original' | 'yours') =>
    (v: Voice): ResolvedWave | null => {
      const c = index.containers[String(v.container)]
      if (!c) return null
      const ref = { pack: c.pack, file: c.bank, streamId: v.file }
      const t = templates.get(bankKey(c.pack, c.bank))
      const stream = t?.byId.get(v.file)
      const fmt = stream ? getFormat(stream) : undefined
      if (!stream || !fmt) return null
      if (which === 'yours') {
        const a = findAssignment(project, ref)
        if (a?.action === 'silence') return null
        const src = a?.action === 'replace' && a.sourceId ? sources.get(a.sourceId) : undefined
        if (a && src) {
          const key = `${refKey(ref)}|${a.sourceId}|${JSON.stringify(a.shape)}|${fmt.sampleRate}`
          let w = shaped.current.get(key)
          if (!w) {
            const s = shapeAudio(src.audio, a.shape, fmt.sampleRate)
            const headroom = a.shape.headroom === 'template' ? fmt.headroom : a.shape.headroom
            w = { samples: toFloat(s.pcm), sampleRate: s.sampleRate, gainDb: -headroom / 100 }
            shaped.current.set(key, w)
          }
          return w
        }
      }
      let w = originals.current.get(refKey(ref))
      if (!w) {
        const { pcm, sampleRate } = decodeStreamPcm(stream)
        w = { samples: toFloat(pcm), sampleRate, gainDb: -fmt.headroom / 100 }
        originals.current.set(refKey(ref), w)
      }
      return w
    }

  const preview = async (which: 'original' | 'yours'): Promise<void> => {
    if (!variant) return
    const tag = `preview:${weapon.name}:${which}`
    if (playing === tag) return player.stop()
    setBusy(which)
    try {
      // the same seed for both, so original and yours pick the same random variations
      const state = newPlanState(seededRng(seed))
      const listener: Listener = { distance, environment }
      const roles = shotRoles(variant, environment, suppressed)
      const voices = planFiring(index, weapon, variant, state, { shots: burst ? 5 : 1, roles, listener })
      const buffer = await renderPreview(voices, resolve(which), { environment, presets: index.environment })
      if (!buffer) {
        props.onError(
          which === 'yours'
            ? 'Everything in this shot is silenced.'
            : distance > 0
              ? 'Nothing of this shot is audible from that far.'
              : "This gun's sound banks aren't in your library. Load the vanilla pack again."
        )
        return
      }
      player.playBuffer(tag, buffer)
      setLast({ which, samples: mixdown(buffer), approximations: [...state.approximations] })
    } catch (e) {
      props.onError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  /** A recording of the real in-game shot, aligned to its first transient for A/B against the preview. */
  const loadRecording = async (): Promise<void> => {
    const [file] = await window.api.pickAudioFiles()
    if (!file) return
    try {
      const audio = await decodeAudio(file.name, file.bytes)
      const mono = pickChannel(audio, 'mix')
      const onset = findOnset(mono, -40)
      const samples = mono.slice(Math.max(0, onset - Math.round(audio.sampleRate * 0.005)))
      // match the preview's loudness (peak) so the two compare by sound, not level
      let peak = 0
      for (const x of samples) peak = Math.max(peak, Math.abs(x))
      let target = 0
      for (const x of last?.samples ?? []) target = Math.max(target, Math.abs(x))
      const gain = peak > 0 ? (target || 0.5) / peak : 1
      setRecording({ name: file.name, samples: samples.map((x) => x * gain), sampleRate: audio.sampleRate })
    } catch (e) {
      props.onError((e as Error).message)
    }
  }

  const click = (e: MouseEvent, ref: StreamRef): void => {
    const k = refKey(ref)
    if (e.shiftKey && focus) {
      const a = ordered.findIndex((r) => refKey(r) === refKey(focus))
      const b = ordered.findIndex((r) => refKey(r) === k)
      if (a >= 0 && b >= 0) return props.onSelect(ordered.slice(Math.min(a, b), Math.max(a, b) + 1), focus)
    }
    if (e.ctrlKey || e.metaKey) {
      return props.onSelect(selected.has(k) ? selection.filter((r) => refKey(r) !== k) : [...selection, ref], ref)
    }
    props.onSelect([ref], ref)
  }

  const drop = (e: DragEvent, refs: StreamRef[]): void => {
    e.preventDefault()
    e.stopPropagation()
    setDropRole(null)
    const files = [...e.dataTransfer.files]
    if (files.length) props.onDropFiles(files, refs)
  }

  const rpm = fireRate(weapon)
  const changedHere = new Set(ordered.filter((r) => findAssignment(project, r)).map(refKey)).size
  const recTag = `recording:${weapon.name}`

  return (
    <section className="bank-view weapon-view">
      <header className="bank-header">
        <div>
          <h2>{weaponLabel(weapon)}</h2>
          <p className="muted small">
            {GROUP_LABELS[weapon.group] ?? weapon.group} · <span className="mono">{weapon.name}</span>
            {rpm ? ` · ${rpm} rounds/min` : ''} · {fileCount} files{changedHere ? ` · ${changedHere} changed` : ''}
          </p>
          {twins.length > 0 && (
            <p className="small warn-text">
              {twins.map(weaponLabel).join(', ')} {twins.length === 1 ? 'uses' : 'use'} exactly the same sounds: changing one changes{' '}
              {twins.length === 1 ? 'both' : 'all of them'}.
            </p>
          )}
        </div>
      </header>

      <div className="preview-bar">
        <div className="row gap wrap">
          <button
            className={`btn${playing === `preview:${weapon.name}:original` ? ' playing' : ''}`}
            onClick={() => void preview('original')}
            disabled={!!busy}
          >
            {busy === 'original' ? 'Rendering…' : '▶ Original'}
          </button>
          <button
            className={`btn primary${playing === `preview:${weapon.name}:yours` ? ' playing' : ''}`}
            onClick={() => void preview('yours')}
            disabled={!!busy}
          >
            {busy === 'yours' ? 'Rendering…' : '▶ Yours'}
          </button>
          <button className="btn subtle" onClick={() => setSeed((s) => s + 1)} title="Pick a different set of the game's random variations">
            🎲 Variation
          </button>
          <span className="segmented small" role="radiogroup" aria-label="Shots">
            <button className={!burst ? 'on' : ''} onClick={() => setBurst(false)} aria-pressed={!burst}>
              Single
            </button>
            <button className={burst ? 'on' : ''} onClick={() => setBurst(true)} aria-pressed={burst}>
              {fullAuto ? 'Full auto ×5' : 'Burst ×5'}
            </button>
          </span>
          {hasSuppressed && (
            <label className="small row gap">
              <input type="checkbox" checked={suppressed} onChange={(e) => setSuppressed(e.target.checked)} /> Suppressor
            </label>
          )}
        </div>
        <div className="row gap wrap">
          <label className="small">
            Hear it{' '}
            <select value={distance} onChange={(e) => setDistance(Number(e.target.value))} aria-label="Distance">
              {DISTANCES.map(([d, label]) => (
                <option key={d} value={d}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="small">
            <select value={environment} onChange={(e) => setEnvironment(e.target.value as Environment)} aria-label="Where">
              <option value="outdoor">Outdoors</option>
              <option value="interior">Indoors</option>
              <option value="tunnel">In a tunnel</option>
            </select>
          </label>
          {variants.others && (
            <label className="small">
              Fired by{' '}
              <select value={listenAs} onChange={(e) => setListenAs(e.target.value as 'you' | 'npc')} aria-label="Fired by">
                <option value="you">You</option>
                <option value="npc">Another player / NPC</option>
              </select>
            </label>
          )}
          {recording ? (
            <span className="row gap small">
              <button
                className={`btn subtle small${playing === recTag ? ' playing' : ''}`}
                onClick={() => player.toggle(recTag, recording.samples, recording.sampleRate)}
                title={recording.name}
              >
                {playing === recTag ? '■' : '▶'} Recording
              </button>
              <button className="icon-btn small" onClick={() => setRecording(null)} aria-label="Remove recording">
                ✕
              </button>
            </span>
          ) : (
            <button
              className="btn subtle small"
              onClick={() => void loadRecording()}
              title="Load a recording of this gun firing in GTA V (OBS, Audacity…) to compare it with the preview"
            >
              Compare with in-game recording…
            </button>
          )}
        </div>
        {last && (
          <Waveform
            samples={last.samples}
            tone={last.which === 'yours' ? 'new' : 'original'}
            label={last.which === 'yours' ? 'Yours' : 'Original'}
            height={56}
          />
        )}
        {recording && <Waveform samples={recording.samples} label="In-game recording" height={56} />}
        <p className="muted small preview-note">
          Built from the game's data: every layer, variation, level, pitch, delay, filter, mix category, distance curve, crossfade and
          envelope{burst && rpm ? `, at ${rpm} rounds/min` : ''}. Approximated: the reverb
          {last && last.approximations.length > 0 ? `, ${last.approximations.join(', ')}` : ''}.
        </p>
      </div>

      <p className="muted small legend">
        Heard by: <b>You</b> = your own gun · <b>Others</b> = how other players and NPCs hear it · <b>Everyone</b> = both. A replacement
        changes exactly the sounds you select; files other guns fire too say so, and you're asked before they change.
      </p>

      <div className="table-wrap">
        {sections.length === 0 && (
          <p className="muted pad">No sounds for this gun were found in your library. Try loading the vanilla pack again.</p>
        )}
        {sections.map((section) => {
          const refs = section.files.map(toRef)
          return (
            <section
              key={section.role}
              className={`role-group${dropRole === section.role ? ' drop' : ''}`}
              onDragOver={(e) => {
                e.preventDefault()
                setDropRole(section.role)
              }}
              onDragLeave={() => setDropRole((r) => (r === section.role ? null : r))}
              onDrop={(e) => drop(e, refs)}
            >
              <div className="role-header">
                <h3>{section.label}</h3>
                <span className="muted small role-meaning" title={section.meaning}>
                  {section.meaning}
                </span>
                <span className="row gap select-buttons">
                  <button className="btn subtle small" onClick={() => props.onSelect(refs, refs[0])}>
                    Select all
                  </button>
                  {selectChoices(section.files).map(([label, files]) => (
                    <button
                      key={label}
                      className="btn subtle small"
                      onClick={() => props.onSelect(files.map(toRef), files[0] ? toRef(files[0]) : null)}
                    >
                      {label}
                    </button>
                  ))}
                </span>
              </div>
              <table className="streams">
                <tbody>
                  {section.files.map((f) => {
                    const ref = toRef(f)
                    const k = refKey(ref)
                    const t = templates.get(bankKey(f.pack, f.bank))
                    const summary = t?.summaries.find((s) => s.id === f.streamId)
                    const a = findAssignment(project, ref)
                    const src = a?.sourceId ? sources.get(a.sourceId) : undefined
                    const tagOrig = `orig:${bankKey(f.pack, f.bank)}:${f.streamId}`
                    const tagNew = `new:${bankKey(f.pack, f.bank)}:${f.streamId}`
                    return (
                      <tr
                        key={k}
                        className={`${selected.has(k) ? 'selected' : ''}${focus && refKey(focus) === k ? ' focus' : ''}`}
                        onClick={(e) => click(e, ref)}
                        onDoubleClick={() => props.onPlayPart(ref, 'original')}
                        onDrop={(e) => drop(e, selected.has(k) ? selection : [ref])}
                      >
                        <td className="col-play">
                          <button
                            className={`icon-btn${playing === tagOrig ? ' playing' : ''}`}
                            onClick={(e) => {
                              e.stopPropagation()
                              props.onPlayPart(ref, 'original')
                            }}
                            aria-label="Play original"
                            disabled={!summary}
                          >
                            {playing === tagOrig ? '■' : '▶'}
                          </button>
                        </td>
                        <td className="desc-cell">
                          <span className="desc" title={f.text}>
                            {f.text}
                          </span>
                          <span className="muted small mono file-label">
                            {fileLabel(f)}
                            {f.alsoRoles.length > 0 && (
                              <span className="also"> · also used for: {f.alsoRoles.map(partLabel).join(', ')}</span>
                            )}
                            {sharingNote(f) && (
                              <span className={shotSharing(f).length ? 'shared-with' : 'shared-minor'} title={sharingNote(f)!.title}>
                                {' '}
                                · {sharingNote(f)!.text}
                              </span>
                            )}
                          </span>
                        </td>
                        <td className={`heard heard-${f.heardBy}`}>{HEARD_BY[f.heardBy]}</td>
                        <td className="col-num">{summary ? fmtDuration(summary.duration) : t ? '—' : '…'}</td>
                        <td>
                          <div className="status-cell">
                            {!t && <span className="badge warn">bank not loaded</span>}
                            {a?.action === 'silence' && <span className="badge warn">Silenced</span>}
                            {a?.action === 'replace' && (
                              <>
                                <button
                                  className={`icon-btn small${playing === tagNew ? ' playing' : ''}`}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    props.onPlayPart(ref, 'new')
                                  }}
                                  aria-label="Play replacement"
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
            </section>
          )
        })}
      </div>
    </section>
  )
}
