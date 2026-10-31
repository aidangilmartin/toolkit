import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bridgeExe as exe, fixtureBank, makeFakeGame, makeFakeVanillaPack, testAwcKey as key } from '../../tests/fakeGame'
import { parseAwc } from '../core/awc/read'
import { decodeStreamPcm, replaceStreamAudio } from '../core/awc/replace'
import { writeAwc } from '../core/awc/write'
import type { WeaponIndex } from '../core/weapons'
import { runBridge, type BuildRpfResult, type ExtractResult, type ScanResult } from './bridge'
import { gunBanks, importPack, makePack, sourceArgs, vanillaKind, vanillaStatus, type VanillaManifest } from './vanilla'

const KEY_ARGS = JSON.stringify(['--no-keys', '--test-awc-key', key])
const PISTOL = 0x16ef0ea5

/** The fake game's banks are AWC-encrypted with a test key; everything else must work without it. */
const withTestKey = async <T>(fn: () => Promise<T>): Promise<T> => {
  process.env.GSM_BRIDGE_EXTRA_ARGS = KEY_ARGS
  try {
    return await fn()
  } finally {
    delete process.env.GSM_BRIDGE_EXTRA_ARGS
  }
}

const streamsOf = (path: string) => parseAwc(new Uint8Array(readFileSync(path))).streams

// each test makes fake games and packs through the bridge: allow for a busy machine
describe.skipIf(!existsSync(exe))('vanilla packs (integration)', { timeout: 30_000 }, () => {
  afterEach(() => {
    delete process.env.GSM_BRIDGE_EXTRA_ARGS
  })

  it('makes a self-contained pack that works without GTA V or its keys', async () => {
    const work = mkdtempSync(join(tmpdir(), 'gsm-vanilla-'))
    const game = await makeFakeGame(work, { key, smgBank: true })
    const dir = join(work, 'profile', 'vanilla')
    await withTestKey(() => makePack(exe, game, dir, { appVersion: '1.2.3' }))

    expect(vanillaKind(dir)).toBe('self-contained')
    const manifest = JSON.parse(readFileSync(join(dir, 'gunpack-vanilla.json'), 'utf8')) as VanillaManifest
    expect(manifest).toMatchObject({ format: 1, madeWith: '1.2.3', weapons: 2, encryptedBanks: [] })
    expect(manifest.archives.map((a) => a.name).sort()).toEqual(['RESIDENT.rpf', 'WEAPONS_PLAYER.rpf'])
    // the fake game's archives are OPEN, unlike Rockstar's: flagged as possibly modded
    expect(manifest.warnings.some((w) => w.includes("isn't encrypted the way Rockstar ships it"))).toBe(true)
    const index = JSON.parse(readFileSync(join(dir, 'weapon-index.json'), 'utf8')) as WeaponIndex
    expect(index.game.gtaPath).toBe('')
    expect(gunBanks(index)).toEqual(['resident/weapons.awc', 'weapons_player/ptl_pistol.awc', 'weapons_player/smg_smg.awc'])
    expect(existsSync(join(dir, 'sound-map.json'))).toBe(true)

    // no key, no game: every bank reads, already decrypted
    expect(sourceArgs(dir, null)).toEqual(['--vanilla', dir])
    const ex = await runBridge<ExtractResult>(exe, ['extract', ...sourceArgs(dir, null), '--out', join(work, 'ex')])
    expect(ex.errors).toEqual([])
    expect(ex.extracted.map((e) => `${e.pack}/${e.file}`).sort()).toEqual([
      'resident/explosions.awc',
      'resident/weapons.awc',
      'weapons_player/ptl_pistol.awc',
      'weapons_player/smg_smg.awc'
    ])
    expect(ex.extracted.every((e) => !e.wasEncrypted)).toBe(true)
    for (const e of ex.extracted) expect(streamsOf(e.path)).toEqual(parseAwc(fixtureBank()).streams)

    // export rebuilds from the pack
    const bank = parseAwc(fixtureBank())
    const target = bank.streams.find((s) => s.id === PISTOL)!
    const pcm = new Int16Array(4000).map((_, i) => (i % 50) * 300)
    const changed = writeAwc({ ...bank, streams: bank.streams.map((s) => (s === target ? replaceStreamAudio(s, pcm, 32000) : s)) })
    writeFileSync(join(work, 'mine.awc'), changed)
    const built = await runBridge<BuildRpfResult>(exe, [
      'build-rpf',
      ...sourceArgs(dir, null),
      '--out',
      join(work, 'export'),
      '--bank',
      `weapons_player/ptl_pistol.awc=${join(work, 'mine.awc')}`
    ])
    expect(built.errors).toEqual([])
    expect(built.archives.map((a) => [a.file, a.replaced])).toEqual([['WEAPONS_PLAYER.rpf', ['ptl_pistol.awc']]])

    const status = await vanillaStatus(exe, dir)
    expect(status).toMatchObject({ kind: 'self-contained', weapons: 2, encryptedBanks: 0 })
    expect(status.archives.sort()).toEqual(['RESIDENT.rpf', 'WEAPONS_PLAYER.rpf'])
  })

  it('imports a zipped pack and plain original archives, and leaves the pack alone on a bad pick', async () => {
    const work = mkdtempSync(join(tmpdir(), 'gsm-vanilla-zip-'))
    const { zip, game } = await makeFakeVanillaPack(work)
    const dir = join(work, 'profile', 'vanilla')

    await importPack(exe, zip, dir)
    expect(vanillaKind(dir)).toBe('self-contained')
    expect(existsSync(join(dir, 'x64', 'audio', 'sfx', 'WEAPONS_PLAYER.rpf'))).toBe(true)
    expect(existsSync(`${dir}.import`) || existsSync(`${dir}.next`)).toBe(false)

    mkdirSync(join(work, 'empty'))
    await expect(importPack(exe, join(work, 'empty'), dir)).rejects.toThrow(/No vanilla pack here/)
    expect(vanillaKind(dir)).toBe('self-contained')

    // a backup of WEAPONS_PLAYER.rpf somewhere in a folder
    const backup = join(work, 'backup', 'nested')
    mkdirSync(backup, { recursive: true })
    copyFileSync(join(game, 'x64', 'audio', 'sfx', 'WEAPONS_PLAYER.rpf'), join(backup, 'WEAPONS_PLAYER.rpf'))
    await importPack(exe, join(work, 'backup'), dir)
    expect(vanillaKind(dir)).toBe('archives')
    const status = await vanillaStatus(exe, dir)
    expect(status.archives).toEqual(['WEAPONS_PLAYER.rpf'])
    expect(status.warnings.some((w) => w.includes("There's no RESIDENT.rpf here"))).toBe(true)
    expect(() => sourceArgs(dir, null)).toThrow(/choose your GTA V folder/)
    expect(sourceArgs(dir, game)).toEqual(['--gta', game, '--vanilla', dir])
  })

  it('takes the original archives in place of a modded install', async () => {
    const work = mkdtempSync(join(tmpdir(), 'gsm-vanilla-plain-'))
    for (const d of ['a', 'b']) mkdirSync(join(work, d))
    const original = await makeFakeGame(join(work, 'a'), { key })
    const modded = await makeFakeGame(join(work, 'b'), { key })
    // mod the second game: its pistol body becomes a saw tooth
    const bank = parseAwc(fixtureBank())
    const saw = new Int16Array(6000).map((_, i) => (i % 100) * 200)
    const moddedBank = writeAwc({ ...bank, streams: bank.streams.map((s) => (s.id === PISTOL ? replaceStreamAudio(s, saw, 32000) : s)) })
    writeFileSync(join(work, 'mod.awc'), moddedBank)
    await withTestKey(() =>
      runBridge(exe, [
        'build-rpf',
        '--gta',
        modded,
        '--out',
        join(work, 'mod'),
        '--bank',
        `weapons_player/ptl_pistol.awc=${join(work, 'mod.awc')}`
      ])
    )
    copyFileSync(join(work, 'mod', 'WEAPONS_PLAYER.rpf'), join(modded, 'x64', 'audio', 'sfx', 'WEAPONS_PLAYER.rpf'))

    const pistolPcm = async (args: string[], out: string): Promise<Int16Array> => {
      const r = await withTestKey(() => runBridge<ScanResult>(exe, ['scan', ...args, '--out', out]))
      const e = r.extracted.find((b) => b.file === 'ptl_pistol.awc')!
      return decodeStreamPcm(parseAwc(new Uint8Array(readFileSync(e.path))).streams.find((s) => s.id === PISTOL)!).pcm
    }
    const fromMod = await pistolPcm(['--gta', modded], join(work, 's1'))
    expect(Array.from(fromMod.slice(0, 5))).toEqual(Array.from(saw.slice(0, 5)))

    const plain = join(work, 'plain')
    mkdirSync(plain)
    copyFileSync(join(original, 'x64', 'audio', 'sfx', 'WEAPONS_PLAYER.rpf'), join(plain, 'WEAPONS_PLAYER.rpf'))
    const fromPlain = await pistolPcm(['--gta', modded, '--vanilla', plain], join(work, 's2'))
    const want = decodeStreamPcm(bank.streams.find((s) => s.id === PISTOL)!).pcm
    expect(Array.from(fromPlain.slice(0, 50))).toEqual(Array.from(want.slice(0, 50)))
  })
})
