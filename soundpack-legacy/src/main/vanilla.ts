import { existsSync, readdirSync } from 'node:fs'
import { cp, mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { WeaponIndex } from '../core/weapons'
import type { VanillaKind, VanillaStatus } from '../shared/ipc'
import { runBridge } from './bridge'

/**
 * The vanilla pack the app works from instead of the player's live (possibly modded) game files,
 * kept in its own folder (<userData>/vanilla):
 * - self-contained: made by the bridge's make-vanilla-pack: unencrypted archives plus the gun data,
 *   so it needs neither GTA V nor its keys;
 * - archives: original WEAPONS_PLAYER.rpf / RESIDENT.rpf only; GTA V supplies the keys and gun data.
 */

export const MANIFEST = 'gunpack-vanilla.json'

/** What make-vanilla-pack writes into gunpack-vanilla.json. */
export interface VanillaManifest {
  format: number
  madeAt: string
  madeWith: string | null
  from: { exe: string; gen9: boolean; plainArchives: string[] }
  weapons: number
  banks: number
  archives: { name: string; files: number; size: number }[]
  warnings: string[]
  encryptedBanks: string[]
}

/** The bridge's inspect-vanilla result. */
export interface InspectResult {
  kind: VanillaKind
  root: string
  manifest: VanillaManifest | null
  archives: { name: string; path: string; size: number; encryption: string }[]
  warnings: string[]
}

export function vanillaKind(dir: string): VanillaKind | null {
  if (existsSync(join(dir, MANIFEST))) return 'self-contained'
  if (existsSync(dir) && readdirSync(dir).some((f) => f.toLowerCase().endsWith('.rpf'))) return 'archives'
  return null
}

/**
 * Bridge arguments for reading the original sounds: the pack alone when it's self-contained,
 * otherwise the GTA V folder for keys and data with the pack's archives in place of the install's.
 */
export function sourceArgs(dir: string, gtaPath: string | null): string[] {
  const kind = vanillaKind(dir)
  if (kind === 'self-contained') return ['--vanilla', dir]
  if (!kind) throw new Error('Choose or make a vanilla pack first.')
  if (!gtaPath)
    throw new Error('Your vanilla pack only holds the original archives: choose your GTA V folder for the keys and the gun data.')
  return ['--gta', gtaPath, '--vanilla', dir]
}

export async function vanillaStatus(bridge: string, dir: string): Promise<VanillaStatus> {
  const kind = vanillaKind(dir)
  if (!kind) return { kind: null, madeAt: null, weapons: null, archives: [], warnings: [], encryptedBanks: 0 }
  const r = await runBridge<InspectResult>(bridge, ['inspect-vanilla', '--in', dir])
  return {
    kind,
    madeAt: r.manifest?.madeAt ?? null,
    weapons: r.manifest?.weapons ?? null,
    archives: r.archives.map((a) => a.name),
    warnings: [...(r.manifest?.warnings ?? []), ...r.warnings],
    encryptedBanks: r.manifest?.encryptedBanks.length ?? 0
  }
}

/** Swaps a fully written pack folder in for the current one. */
async function swapIn(next: string, dir: string): Promise<void> {
  const old = `${dir}.old`
  await rm(old, { recursive: true, force: true })
  if (existsSync(dir)) await rename(dir, old)
  await rename(next, dir)
  await rm(old, { recursive: true, force: true })
}

/**
 * Copies a vanilla pack (a folder, or a .zip of one) into `dir`. A self-contained pack is copied
 * whole; from anything else only WEAPONS_PLAYER.rpf / RESIDENT.rpf are kept. Nothing changes if the
 * source isn't a vanilla pack.
 */
export async function importPack(bridge: string, src: string, dir: string, progress?: (m: string) => void): Promise<void> {
  const staging = `${dir}.import`
  const next = `${dir}.next`
  await rm(staging, { recursive: true, force: true })
  await rm(next, { recursive: true, force: true })
  try {
    const zipped = src.toLowerCase().endsWith('.zip')
    if (zipped) await runBridge(bridge, ['unzip', '--in', src, '--out', staging], progress)
    const found = await runBridge<InspectResult>(bridge, ['inspect-vanilla', '--in', zipped ? staging : src])
    if (found.kind === 'self-contained') {
      progress?.('Copying the vanilla pack')
      if (zipped) await rename(found.root, next)
      else await cp(found.root, next, { recursive: true })
    } else {
      await mkdir(next, { recursive: true })
      for (const a of found.archives) {
        progress?.(`Copying ${a.name}`)
        await cp(a.path, join(next, a.name))
      }
    }
    await swapIn(next, dir)
  } finally {
    await rm(staging, { recursive: true, force: true })
    await rm(next, { recursive: true, force: true })
  }
}

/**
 * Makes a self-contained pack from a GTA V install into `dir`. When the current pack holds original
 * archives, they're used in place of the install's.
 */
export async function makePack(
  bridge: string,
  gtaPath: string,
  dir: string,
  opts: { names?: string; appVersion?: string; progress?: (m: string) => void } = {}
): Promise<void> {
  const next = `${dir}.next`
  await rm(next, { recursive: true, force: true })
  try {
    const plain = vanillaKind(dir) === 'archives' ? ['--vanilla', dir] : []
    await runBridge(
      bridge,
      [
        'make-vanilla-pack',
        '--gta',
        gtaPath,
        ...plain,
        '--out',
        next,
        ...(opts.names ? ['--names', opts.names] : []),
        ...(opts.appVersion ? ['--app-version', opts.appVersion] : [])
      ],
      opts.progress
    )
    await swapIn(next, dir)
  } finally {
    await rm(next, { recursive: true, force: true })
  }
}

/** Every bank ("pack/bank.awc") the guns in an index use. */
export function gunBanks(index: Pick<WeaponIndex, 'containers'>): string[] {
  return [...new Set(Object.values(index.containers).map((c) => `${c.pack}/${c.bank}`))].sort()
}
