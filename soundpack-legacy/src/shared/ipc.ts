/** Contract between the Electron main process and the renderer (exposed as window.api). */

import type { SoundMap } from '../core/usage'
import type { WeaponIndex } from '../core/weapons'

export interface LibraryTemplate {
  pack: string
  file: string
  streamCount: number
  sizeBytes: number
  importedAt: string
  origin: 'awc' | 'codewalker-xml' | 'gta'
  hasNames: boolean
}

export interface TemplateData {
  bytes: Uint8Array
  names: Record<number, string>
}

export interface ImportReport {
  imported: LibraryTemplate[]
  errors: { name: string; message: string }[]
  warnings: string[]
}

export interface GameSettings {
  /** Saved folder, or the auto-detected one before the first scan. */
  gtaPath: string | null
  gtaValid: boolean
  /** True once a folder was confirmed by a successful scan. */
  confirmed: boolean
  bridgeAvailable: boolean
}

/** A self-contained vanilla pack (made by the app, works without GTA V) or original archives only. */
export type VanillaKind = 'self-contained' | 'archives'

export interface VanillaStatus {
  /** null: no vanilla pack yet. */
  kind: VanillaKind | null
  /** When a self-contained pack was made, and how many guns it holds. */
  madeAt: string | null
  weapons: number | null
  /** Archive files in the pack. */
  archives: string[]
  /** E.g. archives that look rebuilt by a mod tool. */
  warnings: string[]
  /** Banks that couldn't be decrypted when the pack was made (multi-channel); they need GTA V's keys. */
  encryptedBanks: number
}

export interface ScanReport {
  weapons: number
  banks: ImportReport
  warnings: string[]
}

export interface StoredWeaponIndex {
  index: WeaponIndex
  scannedAt: string
  /** The game exe changed since the scan (e.g. a game update): suggest scanning again. */
  stale: boolean
  /** Made by an older version without the current gun data: suggest making the pack again. */
  outdated: boolean
  /** There's no vanilla pack (e.g. data from an older version that read the game directly). */
  missingPack: boolean
}

export interface GameInfo {
  gtaPath: string
  exe: string
  gen9: boolean
  codeWalkerVersion: string | null
  keysLoaded: boolean
}

export interface PickedFile {
  name: string
  bytes: Uint8Array
}

export interface ProjectFileSource {
  id: string
  fileName: string
  bytes: Uint8Array
}

export interface OpenedProject {
  path: string
  json: string
  sources: ProjectFileSource[]
}

/** A modified sound bank to pack into its archive. */
export interface BankFile {
  pack: string
  file: string
  bytes: Uint8Array
}

export interface ExportArchivesResult {
  /** Folder holding the rebuilt .rpf files and README.txt. */
  folder: string
  archives: { file: string; path: string; size: number; replaced: string[] }[]
  errors: string[]
}

export interface ExportIdPackResult {
  folder: string
  archives: { file: string; path: string; size: number; replaced: string[] }[]
  /** Streams that got a label. */
  labelled: number
  /** The Windows voice used, or null when the labels are beeps. */
  voice: string | null
  warnings: string[]
  errors: string[]
}

export interface Api {
  listTemplates(): Promise<LibraryTemplate[]>
  /** Opens a file dialog for .awc files, or imports the given paths when provided (drag & drop). */
  importAwcFiles(paths?: string[]): Promise<ImportReport>
  /** Opens a folder dialog for CodeWalker "Export XML" output, or imports the given folders. */
  importCodeWalkerFolders(paths?: string[]): Promise<ImportReport>
  readTemplate(pack: string, file: string): Promise<TemplateData>
  removeTemplate(pack: string, file: string): Promise<void>
  setTemplatePack(pack: string, file: string, newPack: string): Promise<LibraryTemplate>

  getLabels(): Promise<Record<string, string>>
  setLabel(key: string, label: string | null): Promise<void>

  pickAudioFiles(): Promise<PickedFile[]>
  readFiles(paths: string[]): Promise<PickedFile[]>
  /** Absolute path of a dropped File (Electron removed File.path). */
  pathForFile(file: File): string

  saveProject(json: string, sources: ProjectFileSource[], path: string | null): Promise<string | null>
  openProject(): Promise<OpenedProject | null>

  getGameSettings(): Promise<GameSettings>
  /** Opens a folder dialog (or uses `path`) and remembers the GTA V folder. */
  setGtaPath(path?: string): Promise<GameSettings>
  getVanillaStatus(): Promise<VanillaStatus>
  /** Copies a vanilla pack (folder, or .zip of one) into the app; opens a dialog unless `path` is given. */
  importVanillaPack(from: 'folder' | 'zip', path?: string): Promise<VanillaStatus | null>
  /** Makes a self-contained vanilla pack from the GTA V folder. */
  makeVanillaPack(): Promise<VanillaStatus>
  /** Saves the vanilla pack as a .zip (to move it to another PC); returns the path. */
  saveVanillaZip(): Promise<string | null>
  /** Loads every gun and its sound banks from the vanilla pack into the library. */
  loadVanillaPack(): Promise<ScanReport>
  getWeaponIndex(): Promise<StoredWeaponIndex | null>
  /** What every sound in WEAPONS_PLAYER.rpf / RESIDENT.rpf is for (from the vanilla pack). */
  getSoundMap(): Promise<SoundMap | null>
  /** Extracts banks ("pack/bank.awc") from the vanilla pack into the library. */
  loadGameBanks(banks: string[]): Promise<ImportReport>
  onGameProgress(listener: (message: string) => void): () => void

  /** Rebuilds WEAPONS_PLAYER.rpf / RESIDENT.rpf with the banks into a folder the user picks. */
  exportArchives(name: string, banks: BankFile[]): Promise<ExportArchivesResult | null>
  /** Builds the in-game ID pack for the given banks into a folder the user picks. */
  exportIdPack(name: string, banks: string[]): Promise<ExportIdPackResult | null>
  showInFolder(path: string): Promise<void>
  openExternal(url: string): Promise<void>
}

export const IPC = {
  listTemplates: 'templates:list',
  importAwcFiles: 'templates:import-awc',
  importCodeWalkerFolders: 'templates:import-cw',
  readTemplate: 'templates:read',
  removeTemplate: 'templates:remove',
  setTemplatePack: 'templates:set-pack',
  getLabels: 'labels:get',
  setLabel: 'labels:set',
  pickAudioFiles: 'audio:pick',
  readFiles: 'files:read',
  saveProject: 'project:save',
  openProject: 'project:open',
  getGameSettings: 'game:settings',
  setGtaPath: 'game:set-gta',
  getVanillaStatus: 'vanilla:status',
  importVanillaPack: 'vanilla:import',
  makeVanillaPack: 'vanilla:make',
  saveVanillaZip: 'vanilla:save-zip',
  loadVanillaPack: 'vanilla:load',
  getWeaponIndex: 'game:weapon-index',
  getSoundMap: 'game:sound-map',
  loadGameBanks: 'game:load-banks',
  gameProgress: 'game:progress',
  exportArchives: 'export:archives',
  exportIdPack: 'export:id-pack',
  showInFolder: 'shell:show',
  openExternal: 'shell:external'
} as const
