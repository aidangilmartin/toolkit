import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bridgeExe as exe, fixtureBank, testAwcKey as key } from '../../tests/fakeGame'
import { sineWave } from '../core/awc/fixtures'
import { parseAwc } from '../core/awc/read'
import { replaceStreamAudio } from '../core/awc/replace'
import { writeAwc } from '../core/awc/write'
import { runBridge, type ExtractResult } from './bridge'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'gsm-rpf-'))

interface BuildResult {
  archives: { pack: string; file: string; path: string; files: number; size: number; replaced: string[] }[]
  errors: { pack: string; file: string; error: string }[]
}

/** A bank with one stream replaced, the way the app's export produces it. */
function modifiedBank(): Uint8Array {
  const awc = parseAwc(fixtureBank())
  const streams = awc.streams.map((s) => (s.id === 0x16ef0ea5 ? replaceStreamAudio(s, sineWave(30000, 44100, 330, 0.7), 44100) : s))
  return writeAwc({ ...awc, streams })
}

async function fakeGame(dir: string, banks: Record<string, Uint8Array>): Promise<string> {
  const args: string[] = []
  for (const [path, bytes] of Object.entries(banks)) {
    const [pack, file] = path.split('/')
    const p = join(dir, file)
    writeFileSync(p, bytes)
    args.push(pack === 'resident' ? '--resident-awc' : '--weapons-player-awc', p)
  }
  const game = join(dir, 'Grand Theft Auto V')
  await runBridge(exe, ['make-test-game', '--out', game, '--test-awc-key', key, ...args])
  return game
}

function isOpenRpf(path: string): boolean {
  const b = readFileSync(path)
  return b.readUInt32LE(0) === 0x52504637 && b.readUInt32LE(12) === 0x4e45504f
}

describe.skipIf(!existsSync(exe))('build-rpf (integration)', () => {
  it('rebuilds WEAPONS_PLAYER.rpf and RESIDENT.rpf as OPEN archives with the new banks', async () => {
    const work = tmp()
    const game = await fakeGame(work, {
      'weapons_player/ptl_pistol.awc': fixtureBank(),
      'weapons_player/smg_smg.awc': fixtureBank(),
      'resident/weapons.awc': fixtureBank()
    })
    const newBank = join(work, 'new.awc')
    writeFileSync(newBank, modifiedBank())
    const out = join(work, 'export')
    const progress: string[] = []
    const r = await runBridge<BuildResult>(
      exe,
      [
        'build-rpf',
        '--gta',
        game,
        '--no-keys',
        '--out',
        out,
        '--bank',
        `weapons_player/ptl_pistol.awc=${newBank}`,
        '--bank',
        `resident/weapons.awc=${newBank}`,
        '--bank',
        `resident/nope.awc=${newBank}`,
        '--bank',
        `dlc_heist/guns.awc=${newBank}`
      ],
      (m) => progress.push(m)
    )
    expect(r.archives.map((a) => [a.file, a.files, a.replaced])).toEqual([
      ['WEAPONS_PLAYER.rpf', 2, ['ptl_pistol.awc']],
      ['RESIDENT.rpf', 1, ['weapons.awc']]
    ])
    expect(r.errors.map((e) => `${e.pack}/${e.file}`)).toEqual(['dlc_heist/guns.awc', 'resident/nope.awc'])
    expect(progress).toContain('Rebuilding WEAPONS_PLAYER.rpf (2/2)')
    expect(progress).toContain('Checking RESIDENT.rpf')
    for (const a of r.archives) expect(isOpenRpf(a.path)).toBe(true)

    // drop the rebuilt archives into another game folder and read them back like the game would
    const game2 = join(work, 'game2')
    mkdirSync(join(game2, 'x64', 'audio', 'sfx'), { recursive: true })
    writeFileSync(join(game2, 'gta5.exe'), 'MZ')
    for (const a of r.archives) copyFileSync(a.path, join(game2, 'x64', 'audio', 'sfx', a.file))
    const ex = await runBridge<ExtractResult>(exe, [
      'extract',
      '--gta',
      game2,
      '--no-keys',
      '--test-awc-key',
      key,
      '--out',
      join(work, 'check')
    ])
    expect(ex.errors).toEqual([])
    const byName = new Map(ex.extracted.map((e) => [`${e.pack}/${e.file}`, e]))
    expect(byName.get('weapons_player/ptl_pistol.awc')!.wasEncrypted).toBe(false)
    expect(new Uint8Array(readFileSync(byName.get('weapons_player/ptl_pistol.awc')!.path))).toEqual(modifiedBank())
    expect(new Uint8Array(readFileSync(byName.get('resident/weapons.awc')!.path))).toEqual(modifiedBank())
    // the untouched bank was copied as-is (still AWC-encrypted, which the game decrypts itself)
    const smg = byName.get('weapons_player/smg_smg.awc')!
    expect(smg.wasEncrypted).toBe(true)
    expect(parseAwc(new Uint8Array(readFileSync(smg.path))).streams).toEqual(parseAwc(fixtureBank()).streams)
  })

  it('handles large banks quickly', async () => {
    const work = tmp()
    const big = parseAwc(fixtureBank())
    // ~40 MB of audio across the bank
    const streams = big.streams.map((s, i) => replaceStreamAudio(s, sineWave(7_000_000, 44100, 200 + i * 50, 0.5), 44100))
    const bytes = writeAwc({ ...big, streams })
    expect(bytes.byteLength).toBeGreaterThan(40_000_000)
    const game = await fakeGame(work, { 'resident/weapons.awc': bytes, 'resident/explosions.awc': fixtureBank() })
    const newBank = join(work, 'new.awc')
    writeFileSync(newBank, modifiedBank())
    const started = Date.now()
    const r = await runBridge<BuildResult>(exe, [
      'build-rpf',
      '--gta',
      game,
      '--no-keys',
      '--out',
      join(work, 'export'),
      '--bank',
      `resident/explosions.awc=${newBank}`
    ])
    const seconds = (Date.now() - started) / 1000
    expect(r.archives[0].size).toBeGreaterThan(40_000_000)
    expect(seconds).toBeLessThan(30)
  }, 120_000)
})
