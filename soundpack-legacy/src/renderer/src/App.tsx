import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { decodeStreamPcm } from '@core/awc/replace'
import { getFormat } from '@core/awc/types'
import { buildBanks, type BuildResult } from '@core/build'
import { DEFAULT_SHAPE, shapeAudio, type ChannelMode, type ShapeSettings } from '@core/dsp'
import {
  addSource,
  assignAcross,
  bankKey,
  clearAcross,
  findAssignment,
  findBank,
  linkPair,
  newProject,
  parseProject,
  serializeProject,
  setChannel,
  silenceAcross,
  unlinkPair,
  updateShapeAcross,
  type Project,
  type StreamRef
} from '@core/project'
import { gunFiles, shotSharing } from '@core/describe'
import { codeOf, idCodes, type IdCode } from '@core/idpack'
import { bankSummary, stereoPairs, streamSummary, streamUsage, type BankSummary, type SoundMap, type StreamUsage } from '@core/usage'
import { weaponParts } from '@core/weapons'
import type { AudioData } from '@core/wav'
import type { ExportArchivesResult, ImportReport, LibraryTemplate, PickedFile, ScanReport, StoredWeaponIndex } from '@shared/ipc'
import { decodeAudio, player } from './audio'
import { BankView } from './components/BankView'
import { CodeLookup } from './components/CodeLookup'
import { ExportDialog } from './components/ExportDialog'
import { HelpDialog } from './components/HelpDialog'
import { IdPackDialog } from './components/IdPackDialog'
import { Inspector } from './components/Inspector'
import { Setup } from './components/Setup'
import { SharedConfirm, whichSounds, type SharedChange } from './components/SharedConfirm'
import { Sidebar } from './components/Sidebar'
import { WeaponList } from './components/WeaponList'
import { WeaponView } from './components/WeaponView'
import {
  bankItems,
  cleanError,
  labelKey,
  loadTemplate,
  pairsFor,
  refKey,
  type BankItem,
  type LoadedTemplate,
  type SourceEntry
} from './model'

type Toast = { kind: 'info' | 'error'; text: string }
type Tab = 'weapons' | 'banks'

const NO_NAMES: Record<string, string> = {}

const AUDIO_RE = /\.(wav|mp3|ogg|flac|m4a|aac|opus|webm)$/i

export function App() {
  const [ready, setReady] = useState(false)
  const [weaponIndex, setWeaponIndex] = useState<StoredWeaponIndex | null>(null)
  const [tab, setTab] = useState<Tab>('weapons')
  const [weaponName, setWeaponName] = useState<string | null>(null)
  const [sharedChange, setSharedChange] = useState<SharedChange | null>(null)
  const [library, setLibrary] = useState<LibraryTemplate[]>([])
  const [loaded, setLoaded] = useState<Map<string, LoadedTemplate>>(new Map())
  const [loadErrors, setLoadErrors] = useState<Map<string, string>>(new Map())
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [selection, setSelection] = useState<StreamRef[]>([])
  const [focus, setFocus] = useState<StreamRef | null>(null)
  const [project, setProjectState] = useState<Project>(newProject)
  const [projectPath, setProjectPath] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [sources, setSources] = useState<Map<string, SourceEntry>>(new Map())
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [playing, setPlaying] = useState<string | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const [dialog, setDialog] = useState<'export' | 'help' | 'rescan' | 'idpack' | null>(null)
  const [soundMap, setSoundMap] = useState<SoundMap | null>(null)
  const [loadingBanks, setLoadingBanks] = useState<Set<string>>(new Set())
  const toastTimer = useRef<number | undefined>(undefined)
  const mapRef = useRef<SoundMap | null>(null)
  mapRef.current = soundMap
  const loading = useRef(new Set<string>())

  const notify = useCallback((kind: Toast['kind'], text: string) => {
    setToast({ kind, text })
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), kind === 'error' ? 9000 : 4500)
  }, [])

  const setProject = useCallback((fn: (p: Project) => Project) => {
    setProjectState(fn)
    setDirty(true)
  }, [])

  const select = useCallback((refs: StreamRef[], f: StreamRef | null) => {
    setSelection(refs)
    setFocus(f)
  }, [])

  useEffect(() => player.subscribe(setPlaying), [])
  useEffect(() => {
    void Promise.all([window.api.listTemplates(), window.api.getLabels(), window.api.getWeaponIndex(), window.api.getSoundMap()]).then(
      ([lib, lab, idx, map]) => {
        setLibrary(lib)
        setLabels(lab)
        setWeaponIndex(idx)
        setSoundMap(map)
        if (idx?.index.weapons.length) setWeaponName(idx.index.weapons[0].name)
        setReady(true)
      }
    )
  }, [])

  const index = weaponIndex?.index ?? null
  const weapon = index?.weapons.find((w) => w.name === weaponName) ?? null
  // what every bank holds and every stream is for, from the sound map
  const summaries = useMemo(() => {
    if (!soundMap) return null
    const keys = Object.keys(soundMap.banks).sort(
      (a, b) => soundMap.banks[b].archive.localeCompare(soundMap.banks[a].archive) || a.localeCompare(b)
    )
    return new Map<string, BankSummary>(keys.map((k) => [k, bankSummary(soundMap, k)]))
  }, [soundMap])
  const codes = useMemo(() => (soundMap ? idCodes(soundMap) : null), [soundMap])
  const usageCache = useMemo(() => new Map<string, StreamUsage>(), [soundMap])
  const usageOf = useCallback(
    (pack: string, file: string, id: number): StreamUsage | null => {
      if (!soundMap) return null
      const key = `${bankKey(pack, file)}:${id}`
      let u = usageCache.get(key)
      if (!u) usageCache.set(key, (u = streamUsage(soundMap, pack, file, id)))
      return u
    },
    [soundMap, usageCache]
  )
  const gunSections = useMemo(
    () => (index && weapon ? gunFiles(index, weapon, soundMap?.names ?? NO_NAMES) : []),
    [index, weapon, soundMap]
  )
  const items = useMemo(() => bankItems(library, project, summaries), [library, project, summaries])
  const activeItem = items.find((i) => i.key === activeKey) ?? null
  const activeTemplate = activeKey ? (loaded.get(activeKey) ?? null) : null
  const activeBank = activeItem ? findBank(project, activeItem.pack, activeItem.file) : undefined

  /** Loads a template from the library once; concurrent requests share the work. */
  const ensureLoaded = useCallback(async (pack: string, file: string): Promise<LoadedTemplate> => {
    const key = bankKey(pack, file)
    const t = loadTemplate(pack, file, await window.api.readTemplate(pack, file), mapRef.current ? stereoPairs(mapRef.current, key) : [])
    setLoaded((m) => (m.has(key) ? m : new Map(m).set(key, t)))
    return t
  }, [])

  const ensureBank = useCallback(
    (pack: string, file: string) => {
      const key = bankKey(pack, file)
      if (loaded.has(key) || loading.current.has(key) || loadErrors.has(key)) return
      if (!library.some((t) => bankKey(t.pack, t.file) === key)) return
      loading.current.add(key)
      ensureLoaded(pack, file)
        .catch((e: Error) => setLoadErrors((m) => new Map(m).set(key, e.message)))
        .finally(() => loading.current.delete(key))
    },
    [loaded, loadErrors, library, ensureLoaded]
  )

  useEffect(() => {
    if (activeItem?.template) ensureBank(activeItem.pack, activeItem.file)
  }, [activeItem, ensureBank])

  const changedByWeapon = useMemo(() => {
    const m = new Map<string, number>()
    if (!index) return m
    for (const w of index.weapons) {
      const keys = new Set<string>()
      for (const v of w.variants) {
        for (const p of weaponParts(index, v)) {
          const ref = { pack: p.pack, file: p.bank, streamId: p.streamId }
          if (findAssignment(project, ref)) keys.add(refKey(ref))
        }
      }
      if (keys.size) m.set(w.name, keys.size)
    }
    return m
  }, [index, project])

  const refreshLibrary = async (): Promise<LibraryTemplate[]> => {
    const list = await window.api.listTemplates()
    setLibrary(list)
    return list
  }

  const forget = (keys: string[]): void => {
    setLoaded((m) => {
      const next = new Map(m)
      keys.forEach((k) => next.delete(k))
      return next
    })
    setLoadErrors((m) => {
      const next = new Map(m)
      keys.forEach((k) => next.delete(k))
      return next
    })
  }

  const handleReport = async (report: ImportReport): Promise<void> => {
    if (report.imported.length) {
      const keys = report.imported.map((t) => bankKey(t.pack, t.file))
      forget(keys)
      await refreshLibrary()
      if (tab === 'banks') {
        setActiveKey(keys[0])
        select([], null)
      }
    }
    if (report.errors.length) notify('error', report.errors.map((e) => `${e.name}: ${e.message}`).join('\n'))
    else if (report.imported.length) notify('info', `Imported ${report.imported.map((t) => t.file).join(', ')}`)
  }

  const onScanned = async (report: ScanReport): Promise<void> => {
    // every bank from the previous source is gone or replaced by the pack's
    setLoaded(new Map())
    setLoadErrors(new Map())
    await refreshLibrary()
    const [idx, map] = await Promise.all([window.api.getWeaponIndex(), window.api.getSoundMap()])
    setWeaponIndex(idx)
    setSoundMap(map)
    if (idx && !idx.index.weapons.some((w) => w.name === weaponName)) setWeaponName(idx.index.weapons[0]?.name ?? null)
    setTab('weapons')
    setDialog(null)
    select([], null)
    const failed = report.banks.errors.length
    notify(
      failed ? 'error' : 'info',
      `Loaded the vanilla pack: ${report.weapons} guns and ${report.banks.imported.length} sound banks.${failed ? ` ${failed} banks failed: ${report.banks.errors.map((e) => e.name).join(', ')}` : ''}`
    )
  }

  /** Extracts a bank the sound map lists from the vanilla pack into the library. */
  const loadFromGame = async (key: string): Promise<void> => {
    if (loadingBanks.has(key)) return
    setLoadingBanks((s) => new Set(s).add(key))
    try {
      const report = await window.api.loadGameBanks([key])
      if (report.imported.length) {
        forget(report.imported.map((t) => bankKey(t.pack, t.file)))
        await refreshLibrary()
      }
      if (report.errors.length) notify('error', report.errors.map((e) => `${e.name}: ${e.message}`).join('\n'))
    } catch (e) {
      notify('error', cleanError(e))
    } finally {
      setLoadingBanks((s) => {
        const next = new Set(s)
        next.delete(key)
        return next
      })
    }
  }

  /** Jumps to the stream behind an ID-pack code, loading its bank from the game if needed. */
  const findCode = (code: IdCode): void => {
    const [pack, file] = code.bank.split('/')
    const ref = { pack, file, streamId: code.id }
    setDialog(null)
    setTab('banks')
    setActiveKey(code.bank)
    select([ref], ref)
    if (!library.some((t) => bankKey(t.pack, t.file) === code.bank)) void loadFromGame(code.bank)
    window.setTimeout(() => document.getElementById(`row-${code.id}`)?.scrollIntoView({ block: 'center' }), 300)
  }

  const importAwc = async (paths?: string[]): Promise<void> => handleReport(await window.api.importAwcFiles(paths))
  const importCodeWalker = async (paths?: string[]): Promise<void> => handleReport(await window.api.importCodeWalkerFolders(paths))

  const addSourceFiles = async (files: PickedFile[]): Promise<SourceEntry[]> => {
    const added: SourceEntry[] = []
    for (const f of files) {
      try {
        const audio = await decodeAudio(f.name, f.bytes)
        const frames = audio.channels[0]?.length ?? 0
        const info = {
          id: crypto.randomUUID(),
          fileName: f.name,
          channels: audio.channels.length,
          sampleRate: audio.sampleRate,
          durationMs: (frames / audio.sampleRate) * 1000
        }
        added.push({ info, bytes: f.bytes, audio })
      } catch (e) {
        notify('error', (e as Error).message)
      }
    }
    if (added.length) {
      setSources((m) => {
        const next = new Map(m)
        added.forEach((s) => next.set(s.info.id, s))
        return next
      })
      setProject((p) => added.reduce((acc, s) => addSource(acc, s.info), p))
    }
    return added
  }

  const pickSources = async (): Promise<SourceEntry[]> => addSourceFiles(await window.api.pickAudioFiles())

  /** The selected files other guns fire too (gunshot, report, echo…), and those guns. */
  const sharedIn = (refs: StreamRef[]): { refs: StreamRef[]; guns: string[] } => {
    if (tab !== 'weapons') return { refs: [], guns: [] }
    const wanted = new Set(refs.map(refKey))
    const shared: StreamRef[] = []
    const guns = new Set<string>()
    for (const section of gunSections) {
      for (const f of section.files) {
        const ref = { pack: f.pack, file: f.bank, streamId: f.streamId }
        const others = shotSharing(f)
        if (!others.length || !wanted.has(refKey(ref))) continue
        if (!shared.some((r) => refKey(r) === refKey(ref))) shared.push(ref)
        others.forEach((o) => guns.add(o.gun))
      }
    }
    return { refs: shared, guns: [...guns].sort((a, b) => a.localeCompare(b)) }
  }

  /** Changes the selection, asking first when that would also change other guns' shots. */
  const guarded = (refs: StreamRef[], what: string, apply: (refs: StreamRef[]) => void): void => {
    const shared = sharedIn(refs)
    if (!shared.refs.length) return apply(refs)
    setSharedChange({ what, refs, shared: shared.refs, guns: shared.guns, apply })
  }

  const pairsOf = (pack: string, file: string) => {
    const t = loaded.get(bankKey(pack, file))
    return t ? pairsFor(t, findBank(project, pack, file)) : []
  }

  const assign = (sourceId: string, refs: StreamRef[], sourceOverride?: SourceEntry): void => {
    const src = sourceOverride ?? sources.get(sourceId)
    if (!src) return
    guarded(refs, `Replace with ${src.info.fileName}`, (chosen) => assignNow(src, chosen))
  }

  const assignNow = (src: SourceEntry, refs: StreamRef[]): void => {
    const targets = refs.filter((r) => {
      const t = loaded.get(bankKey(r.pack, r.file))
      return !t || t.summaries.find((s) => s.id === r.streamId)?.editable !== false
    })
    if (!targets.length) return notify('error', 'None of the selected sounds can be replaced.')
    const prev = focus ? findAssignment(project, focus) : undefined
    setProject((p) => assignAcross(p, targets, src.info, prev?.action === 'replace' ? prev.shape : DEFAULT_SHAPE, pairsOf))
  }

  const dropFilesOnStreams = async (files: File[], refs: StreamRef[]): Promise<void> => {
    const audio = files.filter((f) => AUDIO_RE.test(f.name))
    if (!audio.length) return notify('error', 'Drop an audio file (WAV, MP3, OGG, FLAC).')
    const picked = await window.api.readFiles(audio.map((f) => window.api.pathForFile(f)))
    const [first] = await addSourceFiles(picked)
    if (first) assign(first.info.id, refs, first)
  }

  const onWindowDrop = async (e: DragEvent): Promise<void> => {
    e.preventDefault()
    const files = [...e.dataTransfer.files]
    const paths = files.map((f) => window.api.pathForFile(f))
    const awc = paths.filter((p) => /\.awc$/i.test(p))
    const xml = paths.filter((p) => /\.xml$/i.test(p))
    const audio = paths.filter((p) => AUDIO_RE.test(p))
    if (awc.length) await importAwc(awc)
    if (xml.length) await importCodeWalker(xml)
    if (audio.length) {
      const added = await addSourceFiles(await window.api.readFiles(audio))
      if (added.length) notify('info', `Added ${added.map((s) => s.info.fileName).join(', ')}. Select sounds and press Assign.`)
    }
  }

  const play = (ref: StreamRef, which: 'original' | 'new'): void => {
    const t = loaded.get(bankKey(ref.pack, ref.file))
    const stream = t?.byId.get(ref.streamId)
    if (!stream) return
    const tag = `${which === 'original' ? 'orig' : 'new'}:${bankKey(ref.pack, ref.file)}:${ref.streamId}`
    try {
      if (which === 'original') {
        const { pcm, sampleRate } = decodeStreamPcm(stream)
        return player.toggle(tag, pcm, sampleRate)
      }
      const a = findAssignment(project, ref)
      const src = a?.sourceId ? sources.get(a.sourceId) : undefined
      const fmt = getFormat(stream)
      if (!a || !src || !fmt) return
      const shaped = shapeAudio(src.audio, a.shape, fmt.sampleRate)
      player.toggle(tag, shaped.pcm, shaped.sampleRate)
    } catch (e) {
      notify('error', (e as Error).message)
    }
  }

  const confirmDiscard = (): boolean => !dirty || window.confirm('Discard unsaved changes to this project?')

  const newProj = (): void => {
    if (!confirmDiscard()) return
    setProjectState(newProject())
    setSources(new Map())
    setProjectPath(null)
    setDirty(false)
    select([], null)
  }

  const openProj = async (): Promise<void> => {
    if (!confirmDiscard()) return
    try {
      const opened = await window.api.openProject()
      if (!opened) return
      const p = parseProject(opened.json)
      const map = new Map<string, SourceEntry>()
      for (const s of opened.sources) {
        const info = p.sources.find((x) => x.id === s.id)
        if (!info) continue
        try {
          map.set(s.id, { info, bytes: s.bytes, audio: await decodeAudio(s.fileName, s.bytes) })
        } catch (e) {
          notify('error', (e as Error).message)
        }
      }
      setProjectState(p)
      setSources(map)
      setProjectPath(opened.path)
      setDirty(false)
      select([], null)
      const missing = p.banks.filter((b) => !library.some((t) => bankKey(t.pack, t.file) === bankKey(b.pack, b.file)))
      if (missing.length)
        notify('error', `These sound banks aren't in your library — load the vanilla pack again: ${missing.map((b) => b.file).join(', ')}`)
    } catch (e) {
      notify('error', (e as Error).message)
    }
  }

  const saveProj = async (saveAs = false): Promise<void> => {
    try {
      const used = project.sources.filter((s) => sources.has(s.id))
      const path = await window.api.saveProject(
        serializeProject({ ...project, sources: used }),
        used.map((s) => ({ id: s.id, fileName: s.fileName, bytes: sources.get(s.id)!.bytes })),
        saveAs ? null : projectPath
      )
      if (path) {
        setProjectPath(path)
        setDirty(false)
        notify('info', `Saved ${path}`)
      }
    } catch (e) {
      notify('error', (e as Error).message)
    }
  }

  const build = async (): Promise<BuildResult> => {
    const templates = new Map<string, LoadedTemplate['awc']>()
    const names = new Map<string, Record<number, string>>()
    for (const b of project.banks.filter((x) => x.assignments.length)) {
      const t =
        loaded.get(bankKey(b.pack, b.file)) ??
        (await ensureLoaded(b.pack, b.file).catch(() => {
          throw new Error(`${b.pack}/${b.file} isn't in your library. Load the vanilla pack again first.`)
        }))
      templates.set(bankKey(b.pack, b.file), t.awc)
      const n: Record<number, string> = { ...t.names }
      for (const a of b.assignments) {
        const l = labels[labelKey(b.pack, b.file, a.streamId)]
        if (l) n[a.streamId] = l
      }
      names.set(bankKey(b.pack, b.file), n)
    }
    const audio = new Map<string, AudioData>([...sources].map(([id, s]) => [id, s.audio]))
    return buildBanks({ project, templates, sources: audio, names })
  }

  const exportArchives = async (result: BuildResult, packName: string): Promise<ExportArchivesResult | null> =>
    window.api.exportArchives(
      packName,
      result.banks.map((b) => ({ pack: b.pack, file: b.file, bytes: b.bytes }))
    )

  const setLabel = async (ref: StreamRef, text: string): Promise<void> => {
    await window.api.setLabel(labelKey(ref.pack, ref.file, ref.streamId), text || null)
    setLabels(await window.api.getLabels())
  }

  const selectBank = (item: BankItem): void => {
    if (item.key !== activeKey) select([], null)
    setActiveKey(item.key)
  }

  const removeTemplate = async (): Promise<void> => {
    if (!activeItem) return
    if (!window.confirm(`Remove ${activeItem.file} from your template library? Your project keeps its assignments.`)) return
    await window.api.removeTemplate(activeItem.pack, activeItem.file)
    forget([activeItem.key])
    await refreshLibrary()
  }

  const changePack = async (pack: string): Promise<void> => {
    if (!activeItem || pack === activeItem.pack) return
    try {
      const t = await window.api.setTemplatePack(activeItem.pack, activeItem.file, pack)
      await refreshLibrary()
      setActiveKey(bankKey(t.pack, t.file))
    } catch (e) {
      notify('error', cleanError(e))
    }
  }

  const projectTitle = projectPath ? projectPath.split(/[\\/]/).pop() : 'Untitled project'
  const changedCount = project.banks.reduce((n, b) => n + b.assignments.length, 0)

  useEffect(() => {
    document.title = `${dirty ? '• ' : ''}${projectTitle} — Gun Soundpack Maker`
  }, [dirty, projectTitle])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveProj(e.shiftKey)
      }
      if (e.key === 'Escape') player.stop()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!ready) return <div className="app" />

  if (!index || weaponIndex?.missingPack) {
    return (
      <div className="app">
        <Setup mode="welcome" onDone={(r) => void onScanned(r)} />
      </div>
    )
  }

  const bankSelection = activeItem ? selection.filter((r) => bankKey(r.pack, r.file) === activeItem.key) : []
  const usageRef = focus ?? selection[0] ?? null
  // the focused file's short description: its part of the gun, or what the game data uses it for
  const focusTitle = ((): string | undefined => {
    if (!usageRef) return undefined
    if (tab === 'weapons') {
      for (const s of gunSections) {
        const f = s.files.find((x) => bankKey(x.pack, x.bank) === bankKey(usageRef.pack, usageRef.file) && x.streamId === usageRef.streamId)
        if (f) return `${s.label}: ${f.text}`
      }
      return undefined
    }
    const u = usageOf(usageRef.pack, usageRef.file, usageRef.streamId)
    return u ? streamSummary(u) || undefined : undefined
  })()
  const sharedSelection = sharedIn(selection)

  const inspector = (
    <Inspector
      templates={loaded}
      project={project}
      refs={selection}
      focus={focus}
      labels={labels}
      sources={sources}
      playing={playing}
      context={
        sharedSelection.refs.length > 0 ? (
          <p className="note small" title={sharedSelection.guns.join(', ')}>
            {whichSounds(sharedSelection.refs.length, selection.length)} also part of the shot of{' '}
            {sharedSelection.guns.length === 1 ? sharedSelection.guns[0] : `${sharedSelection.guns.length} other guns`}. You'll be asked
            before they change.
          </p>
        ) : undefined
      }
      title={selection.length === 1 ? focusTitle : undefined}
      emptyHint={
        tab === 'weapons' ? (
          <>
            <p>Pick a sound part of this gun to replace it, or “Select all” on a part.</p>
            <p className="small">Drop an audio file onto a part to replace it in one go. ▶ Original / ▶ Yours plays the full gunshot.</p>
          </>
        ) : undefined
      }
      onPlay={play}
      onAssign={(id, refs) => assign(id, refs)}
      onAddSources={pickSources}
      onDropFiles={(files, refs) => void dropFilesOnStreams(files, refs)}
      onSilence={(refs) => guarded(refs, 'Silence', (chosen) => setProject((p) => silenceAcross(p, chosen)))}
      onReset={(refs) => setProject((p) => clearAcross(p, refs))}
      onShape={(refs, patch: Partial<ShapeSettings>) => setProject((p) => updateShapeAcross(p, refs, patch))}
      onChannel={(ref, ch: ChannelMode) => setProject((p) => setChannel(p, ref.pack, ref.file, ref.streamId, ch))}
      onLink={(l, r) => setProject((p) => linkPair(p, l.pack, l.file, l.streamId, r.streamId))}
      onUnlink={(ref) => setProject((p) => unlinkPair(p, ref.pack, ref.file, ref.streamId))}
      onLabel={(ref, text) => void setLabel(ref, text)}
    />
  )

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={(e) => void onWindowDrop(e)}>
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            ◉
          </span>
          Gun Soundpack Maker
        </div>
        <nav className="tabs" role="tablist" aria-label="View">
          <button
            role="tab"
            aria-selected={tab === 'weapons'}
            className={tab === 'weapons' ? 'on' : ''}
            onClick={() => {
              setTab('weapons')
              select([], null)
            }}
          >
            Weapons
          </button>
          <button
            role="tab"
            aria-selected={tab === 'banks'}
            className={tab === 'banks' ? 'on' : ''}
            onClick={() => {
              setTab('banks')
              select([], null)
            }}
          >
            Sound banks
          </button>
        </nav>
        <div className="project-name muted">
          {projectTitle}
          {dirty ? ' •' : ''}
        </div>
        <div className="row gap">
          <button className="btn subtle" onClick={newProj}>
            New
          </button>
          <button className="btn subtle" onClick={() => void openProj()}>
            Open…
          </button>
          <button className="btn subtle" onClick={() => void saveProj()} title="Ctrl+S">
            Save
          </button>
          <button className="btn subtle" onClick={() => void saveProj(true)} title="Ctrl+Shift+S">
            Save as…
          </button>
          <button className="btn subtle" onClick={() => setDialog('help')}>
            Help
          </button>
          <button
            className="btn subtle"
            onClick={() => setDialog('idpack')}
            disabled={!soundMap}
            title={soundMap ? 'Build a test pack where every sound says its code' : 'Load the vanilla pack again to map every sound first'}
          >
            Identify in game…
          </button>
          <button className="btn primary" onClick={() => setDialog('export')} disabled={changedCount === 0}>
            Export{changedCount ? ` (${changedCount})` : ''}
          </button>
        </div>
      </header>

      {tab === 'weapons' ? (
        <main className="workspace">
          <WeaponList
            weapons={index.weapons}
            selected={weaponName}
            changed={changedByWeapon}
            stale={!!weaponIndex?.stale}
            outdated={!!weaponIndex?.outdated}
            onSelect={(name) => {
              setWeaponName(name)
              select([], null)
            }}
            onRescan={() => setDialog('rescan')}
          />
          {weapon ? (
            <WeaponView
              index={index}
              weapon={weapon}
              templates={loaded}
              ensureBank={ensureBank}
              project={project}
              sources={sources}
              names={soundMap?.names ?? NO_NAMES}
              selection={selection}
              focus={focus}
              playing={playing}
              onSelect={select}
              onPlayPart={play}
              onDropFiles={(files, refs) => void dropFilesOnStreams(files, refs)}
              onError={(m) => notify('error', m)}
            />
          ) : (
            <section className="bank-view empty-state muted">Pick a gun on the left.</section>
          )}
          {inspector}
        </main>
      ) : (
        <main className="workspace">
          <Sidebar
            items={items}
            activeKey={activeKey}
            top={codes ? <CodeLookup codes={codes} onFound={findCode} compact /> : undefined}
            onSelect={selectBank}
            onExtractFromGame={() => setDialog('rescan')}
            onImportAwc={() => void importAwc()}
            onImportCodeWalker={() => void importCodeWalker()}
          />
          {activeItem ? (
            <BankView
              item={activeItem}
              template={activeTemplate}
              loadError={loadErrors.get(activeItem.key) ?? null}
              bank={activeBank}
              labels={labels}
              sources={sources}
              selection={bankSelection.map((r) => r.streamId)}
              focusId={focus && activeItem && bankKey(focus.pack, focus.file) === activeItem.key ? focus.streamId : null}
              playing={playing}
              onSelect={(ids, f) =>
                select(
                  ids.map((id) => ({ pack: activeItem.pack, file: activeItem.file, streamId: id })),
                  f === null ? null : { pack: activeItem.pack, file: activeItem.file, streamId: f }
                )
              }
              onPlay={(id, which) => play({ pack: activeItem.pack, file: activeItem.file, streamId: id }, which)}
              onDropFiles={(files, ids) =>
                void dropFilesOnStreams(
                  files,
                  ids.map((id) => ({ pack: activeItem.pack, file: activeItem.file, streamId: id }))
                )
              }
              onExtractFromGame={() => setDialog('rescan')}
              onImportAwc={() => void importAwc()}
              onImportCodeWalker={() => void importCodeWalker()}
              onRemoveTemplate={() => void removeTemplate()}
              onChangePack={(pack) => void changePack(pack)}
              usageOf={soundMap ? (id) => usageOf(activeItem.pack, activeItem.file, id) : undefined}
              codeOf={codes ? (id) => codeOf(codes, activeItem.key, id) : undefined}
              onLoadFromGame={summaries?.has(activeItem.key) ? () => void loadFromGame(activeItem.key) : undefined}
              loadingFromGame={loadingBanks.has(activeItem.key)}
            />
          ) : (
            <section className="bank-view empty-state">
              <h2>Sound banks</h2>
              <p>
                Every sound bank in your library, stream by stream. Use the Weapons tab for the normal workflow; this view is for banks and
                streams the weapon list doesn't cover.
              </p>
            </section>
          )}
          {activeTemplate && activeItem ? inspector : <aside className="inspector" />}
        </main>
      )}

      {toast && (
        <div className={`toast ${toast.kind}`} role="status" onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}

      {dialog === 'export' && (
        <ExportDialog
          project={project}
          onChange={(patch) => setProject((p) => ({ ...p, ...patch }))}
          onBuild={build}
          onExport={exportArchives}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'help' && <HelpDialog onClose={() => setDialog(null)} />}
      {dialog === 'idpack' && soundMap && codes && summaries && (
        <IdPackDialog
          map={soundMap}
          codes={codes}
          index={index}
          weapon={weapon}
          summaries={summaries}
          onFound={findCode}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'rescan' && <Setup mode="rescan" onDone={(r) => void onScanned(r)} onClose={() => setDialog(null)} />}
      {sharedChange && (
        <SharedConfirm
          change={sharedChange}
          onClose={() => setSharedChange(null)}
          onNothingLeft={() => notify('error', 'Every selected sound is shared with other guns, so nothing was changed.')}
        />
      )}
    </div>
  )
}
