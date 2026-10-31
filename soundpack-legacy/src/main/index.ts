import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { installReadme, PACK_ARCHIVES, sanitizePackName } from '../core/pack'
import type { SoundMap } from '../core/usage'
import type { WeaponIndex } from '../core/weapons'
import {
  IPC,
  type BankFile,
  type ExportArchivesResult,
  type ExportIdPackResult,
  type ImportReport,
  type GameSettings,
  type ProjectFileSource,
  type ScanReport,
  type StoredWeaponIndex,
  type VanillaStatus
} from '../shared/ipc'
import { bridgePath, runBridge, type BuildRpfResult, type ExtractResult, type ScanResult } from './bridge'
import { buildIdPack } from './idPack'
import { detectGtaFolder, isGtaFolder } from './gamePaths'
import { LabelStore, SettingsStore, TemplateLibrary } from './library'
import { packProject, unpackProject } from './projectFile'
import { gunBanks, importPack, makePack, sourceArgs, vanillaKind, vanillaStatus } from './vanilla'

// Lets automated tests run against a throwaway profile.
if (process.env.GSM_USER_DATA) app.setPath('userData', process.env.GSM_USER_DATA)

const AUDIO_EXTENSIONS = ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'webm']

let win: BrowserWindow | null = null
let library: TemplateLibrary
let labels: LabelStore
let settings: SettingsStore<{ gtaPath: string }>

const bridgeExe = (): string => bridgePath({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() })
const indexPath = (): string => join(app.getPath('userData'), 'weapon-index.json')
const indexMetaPath = (): string => join(app.getPath('userData'), 'weapon-index.meta.json')
const mapPath = (): string => join(app.getPath('userData'), 'sound-map.json')
/** The vanilla pack the app works from (see vanilla.ts). */
const vanillaDir = (): string => join(app.getPath('userData'), 'vanilla')
/** An optional list of known names (one per line) the user can drop in to get readable hashes. */
const namesPath = (): string => join(app.getPath('userData'), 'names.txt')

/** The weapon index version that comes with a sound usage map. */
const INDEX_VERSION = 3

/** Asks before replacing files of ours in an existing export folder, then removes them. */
async function clearExportFolder(folder: string, files: string[]): Promise<boolean> {
  const existing = files.filter((f) => existsSync(join(folder, f)))
  if (existing.length) {
    const opts = {
      type: 'warning' as const,
      buttons: ['Replace', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `"${basename(folder)}" already has ${existing.join(', ')}.`,
      detail: 'Replacing overwrites those files.'
    }
    const answer = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    if (answer.response !== 0) return false
    for (const f of existing) await rm(join(folder, f), { force: true })
  }
  await mkdir(folder, { recursive: true })
  return true
}

async function gameSettings(): Promise<GameSettings> {
  const s = await settings.get()
  const gtaPath = s.gtaPath ?? detectGtaFolder() ?? null
  return {
    gtaPath,
    gtaValid: !!gtaPath && isGtaFolder(gtaPath),
    confirmed: !!s.gtaPath && existsSync(indexPath()),
    bridgeAvailable: existsSync(bridgeExe())
  }
}

/** Size + modified time of the game exe, to notice game updates after a scan. */
async function exeSignature(gtaPath: string): Promise<string | null> {
  for (const exe of ['gta5.exe', 'GTA5.exe', 'gta5_enhanced.exe']) {
    try {
      const st = await stat(join(gtaPath, exe))
      return `${st.size}:${Math.round(st.mtimeMs)}`
    } catch {
      // try the next name
    }
  }
  return null
}

const progress = (message: string): void => win?.webContents.send(IPC.gameProgress, message)

/** Bridge arguments for the original sounds: the vanilla pack (plus the GTA V folder for an archives-only pack). */
async function source(): Promise<string[]> {
  const game = await gameSettings()
  return sourceArgs(vanillaDir(), game.gtaValid ? game.gtaPath : null)
}

/** Forgets the gun data of the previous pack, so the app asks to load the new one. */
async function forgetLoadedPack(): Promise<void> {
  for (const p of [indexPath(), indexMetaPath(), mapPath()]) await rm(p, { force: true })
  cachedMap = null
}

let cachedMap: SoundMap | null = null

async function readSoundMap(): Promise<SoundMap | null> {
  if (cachedMap) return cachedMap
  if (!existsSync(mapPath())) return null
  cachedMap = JSON.parse(await readFile(mapPath(), 'utf8')) as SoundMap
  return cachedMap
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    backgroundColor: '#14161a',
    title: 'Gun Soundpack Maker',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function pick(options: OpenDialogOptions): Promise<string[]> {
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  return result.canceled ? [] : result.filePaths
}

async function readPicked(paths: string[]): Promise<{ name: string; bytes: Uint8Array }[]> {
  return Promise.all(paths.map(async (p) => ({ name: basename(p), bytes: new Uint8Array(await readFile(p)) })))
}

function registerIpc(): void {
  ipcMain.handle(IPC.listTemplates, () => library.list())

  ipcMain.handle(IPC.importAwcFiles, async (_e, paths?: string[]) => {
    const files = paths?.length
      ? paths
      : await pick({
          title: 'Import .awc sound banks',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'AWC sound bank', extensions: ['awc'] }]
        })
    return library.importAwc(files)
  })

  ipcMain.handle(IPC.importCodeWalkerFolders, async (_e, paths?: string[]) => {
    const files = paths?.length
      ? paths
      : await pick({
          title: 'Import CodeWalker XML export (.awc.xml)',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'CodeWalker AWC XML', extensions: ['xml'] }]
        })
    return library.importCodeWalker(files)
  })

  ipcMain.handle(IPC.readTemplate, (_e, pack: string, file: string) => library.read(pack, file))
  ipcMain.handle(IPC.removeTemplate, (_e, pack: string, file: string) => library.remove(pack, file))
  ipcMain.handle(IPC.setTemplatePack, (_e, pack: string, file: string, newPack: string) => library.setPack(pack, file, newPack))

  ipcMain.handle(IPC.getLabels, () => labels.get())
  ipcMain.handle(IPC.setLabel, (_e, key: string, label: string | null) => labels.set(key, label))

  ipcMain.handle(IPC.pickAudioFiles, async () =>
    readPicked(
      await pick({
        title: 'Add sounds',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Audio', extensions: AUDIO_EXTENSIONS }]
      })
    )
  )

  ipcMain.handle(IPC.readFiles, (_e, paths: string[]) => {
    const ok = paths.filter((p) => AUDIO_EXTENSIONS.some((ext) => p.toLowerCase().endsWith(`.${ext}`)))
    return readPicked(ok)
  })

  ipcMain.handle(IPC.saveProject, async (_e, json: string, sources: ProjectFileSource[], path: string | null) => {
    let target = path
    if (!target) {
      const r = win
        ? await dialog.showSaveDialog(win, {
            title: 'Save project',
            defaultPath: 'my_gunpack.gunpack',
            filters: [{ name: 'Gun soundpack project', extensions: ['gunpack'] }]
          })
        : await dialog.showSaveDialog({ defaultPath: 'my_gunpack.gunpack' })
      if (r.canceled || !r.filePath) return null
      target = r.filePath.toLowerCase().endsWith('.gunpack') ? r.filePath : `${r.filePath}.gunpack`
    }
    await writeFile(target, packProject(json, sources))
    return target
  })

  ipcMain.handle(IPC.openProject, async () => {
    const [path] = await pick({
      title: 'Open project',
      properties: ['openFile'],
      filters: [{ name: 'Gun soundpack project', extensions: ['gunpack'] }]
    })
    if (!path) return null
    return { path, ...unpackProject(new Uint8Array(await readFile(path))) }
  })

  ipcMain.handle(IPC.exportArchives, async (_e, name: string, banks: BankFile[]): Promise<ExportArchivesResult | null> => {
    const original = await source()
    const [parent] = await pick({ title: 'Choose where to save the sound pack', properties: ['openDirectory', 'createDirectory'] })
    if (!parent) return null
    const packName = sanitizePackName(name)
    const folder = join(parent, packName)
    if (!(await clearExportFolder(folder, ['README.txt', ...Object.values(PACK_ARCHIVES)]))) return null

    const tmp = await mkdtemp(join(tmpdir(), 'gsm-export-'))
    try {
      const lines: string[] = []
      for (const b of banks) {
        const path = join(tmp, `${b.pack}__${b.file}`)
        await writeFile(path, b.bytes)
        lines.push(`${b.pack}/${b.file}=${path}`)
      }
      const list = join(tmp, 'banks.txt')
      await writeFile(list, lines.join('\n'))
      const args = ['build-rpf', ...original, '--out', folder, '--bank-list', list]
      const result = await runBridge<BuildRpfResult>(bridgeExe(), args, progress)
      const files = result.archives.map((a) => a.file)
      await writeFile(join(folder, 'README.txt'), installReadme(packName, files).replace(/\n/g, '\r\n'))
      return {
        folder,
        archives: result.archives.map((a) => ({ file: a.file, path: a.path, size: a.size, replaced: a.replaced })),
        errors: result.errors.map((e) => `${e.pack}/${e.file}: ${e.error}`)
      }
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  ipcMain.handle(IPC.exportIdPack, async (_e, name: string, banks: string[]): Promise<ExportIdPackResult | null> => {
    const original = await source()
    const map = await readSoundMap()
    if (!map) throw new Error('Load the vanilla pack again first: the ID pack needs the sound map.')
    const [parent] = await pick({ title: 'Choose where to save the ID pack', properties: ['openDirectory', 'createDirectory'] })
    if (!parent) return null
    const folder = join(parent, sanitizePackName(name))
    if (!(await clearExportFolder(folder, ['README.txt', 'ID-LEGEND.txt', ...Object.values(PACK_ARCHIVES)]))) return null
    const tmp = await mkdtemp(join(tmpdir(), 'gsm-idpack-'))
    try {
      return await buildIdPack({ bridge: bridgeExe(), source: original, map, banks, folder, tmp, progress })
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  ipcMain.handle(IPC.getGameSettings, () => gameSettings())

  ipcMain.handle(IPC.setGtaPath, async (_e, path?: string) => {
    const dir = path ?? (await pick({ title: 'Select your Grand Theft Auto V folder', properties: ['openDirectory'] }))[0]
    if (!dir) return gameSettings()
    if (!isGtaFolder(dir)) throw new Error(`gta5.exe was not found in ${dir}. Choose the folder GTA V is installed in.`)
    await settings.update({ gtaPath: dir })
    return gameSettings()
  })

  ipcMain.handle(IPC.getVanillaStatus, (): Promise<VanillaStatus> => vanillaStatus(bridgeExe(), vanillaDir()))

  ipcMain.handle(IPC.importVanillaPack, async (_e, from: 'folder' | 'zip', path?: string): Promise<VanillaStatus | null> => {
    const src =
      path ??
      (
        await pick(
          from === 'zip'
            ? { title: 'Choose a vanilla pack (.zip)', properties: ['openFile'], filters: [{ name: 'Vanilla pack', extensions: ['zip'] }] }
            : { title: 'Choose a vanilla pack folder', properties: ['openDirectory'] }
        )
      )[0]
    if (!src) return null
    await importPack(bridgeExe(), src, vanillaDir(), progress)
    await forgetLoadedPack()
    return vanillaStatus(bridgeExe(), vanillaDir())
  })

  ipcMain.handle(IPC.makeVanillaPack, async (): Promise<VanillaStatus> => {
    const s = await gameSettings()
    if (!s.gtaPath || !s.gtaValid) throw new Error('Choose your GTA V folder first (the one containing gta5.exe).')
    await makePack(bridgeExe(), s.gtaPath, vanillaDir(), {
      names: existsSync(namesPath()) ? namesPath() : undefined,
      appVersion: app.getVersion(),
      progress
    })
    await settings.update({ gtaPath: s.gtaPath })
    await forgetLoadedPack()
    return vanillaStatus(bridgeExe(), vanillaDir())
  })

  ipcMain.handle(IPC.saveVanillaZip, async (): Promise<string | null> => {
    if (!vanillaKind(vanillaDir())) throw new Error('There is no vanilla pack to save yet.')
    const opts = {
      title: 'Save the vanilla pack',
      defaultPath: 'gta-v-vanilla-pack.zip',
      filters: [{ name: 'Vanilla pack', extensions: ['zip'] }]
    }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    const target = r.filePath.toLowerCase().endsWith('.zip') ? r.filePath : `${r.filePath}.zip`
    await runBridge(bridgeExe(), ['zip', '--in', vanillaDir(), '--out', target], progress)
    return target
  })

  ipcMain.handle(IPC.loadVanillaPack, async (): Promise<ScanReport> => {
    const dir = vanillaDir()
    const kind = vanillaKind(dir)
    const original = await source()
    const out = await mkdtemp(join(tmpdir(), 'gsm-load-'))
    try {
      let result: { extracted: ExtractResult['extracted']; errors: ExtractResult['errors']; weapons: number; warnings: string[] }
      let indexFile: string
      let soundMapFile: string
      if (kind === 'self-contained') {
        indexFile = join(dir, 'weapon-index.json')
        soundMapFile = join(dir, 'sound-map.json')
        const index = JSON.parse(await readFile(indexFile, 'utf8')) as WeaponIndex
        const banks = gunBanks(index)
        const extract = banks.length
          ? await runBridge<ExtractResult>(
              bridgeExe(),
              ['extract', ...original, '--out', out, ...banks.flatMap((b) => ['--bank', b])],
              progress
            )
          : { extracted: [], errors: [] }
        result = { ...extract, weapons: index.weapons.length, warnings: index.warnings ?? [] }
      } else {
        const names = existsSync(namesPath()) ? ['--names', namesPath()] : []
        const scan = await runBridge<ScanResult>(bridgeExe(), ['scan', ...original, '--out', out, ...names], progress)
        indexFile = scan.indexPath
        soundMapFile = scan.mapPath
        result = scan
      }
      progress('Adding sound banks to your library')
      // banks read from an earlier source (e.g. the live game) must not stand in for the originals
      for (const t of await library.list()) if (t.origin === 'gta') await library.remove(t.pack, t.file)
      const banks = await library.importExtracted(result.extracted)
      banks.errors.push(...result.errors.map((e) => ({ name: `${e.pack}/${e.file}`, message: e.error })))
      await writeFile(indexPath(), await readFile(indexFile))
      await writeFile(mapPath(), await readFile(soundMapFile))
      cachedMap = null
      const game = await gameSettings()
      const gtaPath = kind === 'archives' ? game.gtaPath : null
      await writeFile(
        indexMetaPath(),
        JSON.stringify({ kind, gtaPath, exe: gtaPath ? await exeSignature(gtaPath) : null, scannedAt: new Date().toISOString() })
      )
      return { weapons: result.weapons, banks, warnings: result.warnings }
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  })

  ipcMain.handle(IPC.getWeaponIndex, async (): Promise<StoredWeaponIndex | null> => {
    if (!existsSync(indexPath())) return null
    const index = JSON.parse(await readFile(indexPath(), 'utf8')) as WeaponIndex
    let meta: { gtaPath?: string; exe?: string | null; scannedAt?: string } = {}
    try {
      meta = JSON.parse(await readFile(indexMetaPath(), 'utf8'))
    } catch {
      // older scans have no metadata
    }
    const now = meta.gtaPath ? await exeSignature(meta.gtaPath) : null
    return {
      index,
      scannedAt: meta.scannedAt ?? '',
      stale: !!meta.exe && !!now && meta.exe !== now,
      outdated: (index.version ?? 1) < INDEX_VERSION || !existsSync(mapPath()),
      missingPack: !vanillaKind(vanillaDir())
    }
  })

  ipcMain.handle(IPC.getSoundMap, () => readSoundMap())

  ipcMain.handle(IPC.loadGameBanks, async (_e, banks: string[]): Promise<ImportReport> => {
    const original = await source()
    const out = await mkdtemp(join(tmpdir(), 'gsm-extract-'))
    try {
      const result = await runBridge<ExtractResult>(
        bridgeExe(),
        ['extract', ...original, '--out', out, ...banks.flatMap((b) => ['--bank', b])],
        progress
      )
      const report = await library.importExtracted(result.extracted)
      report.errors.push(...result.errors.map((e) => ({ name: `${e.pack}/${e.file}`, message: e.error })))
      return report
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  })

  ipcMain.handle(IPC.showInFolder, (_e, path: string) => shell.showItemInFolder(path))
  ipcMain.handle(IPC.openExternal, (_e, url: string) => {
    if (/^https:\/\//.test(url)) return shell.openExternal(url)
  })
}

app.whenReady().then(() => {
  library = new TemplateLibrary(join(app.getPath('userData'), 'templates'))
  labels = new LabelStore(join(app.getPath('userData'), 'labels.json'))
  settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'))
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
