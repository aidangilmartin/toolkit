import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { makeBank } from '../src/core/awc/fixtures'
import { writeAwc } from '../src/core/awc/write'
import { bridgePath, runBridge } from '../src/main/bridge'

/** Helpers for tests that run the real CodeWalker bridge against a fake GTA V folder. */

export const repoRoot = resolve(__dirname, '..')
export const bridgeExe = bridgePath({ isPackaged: false, resourcesPath: '', appPath: repoRoot })
export const testAwcKey = Buffer.from(Array.from({ length: 16 }, (_, i) => i + 1)).toString('base64')
const fixtures = join(repoRoot, 'tests', 'fixtures', 'game')

/** The synthetic test bank without its deliberately malformed gesture chunk (CodeWalker parses those strictly). */
export function fixtureBank(): Uint8Array {
  const b = makeBank()
  return writeAwc({ ...b, streams: b.streams.filter((s) => s.chunks.some((c) => c.kind === 'format')) })
}

/**
 * Builds a fake GTA V folder: OPEN (unencrypted) archives holding AWC-encrypted banks
 * (weapons_player/ptl_pistol, resident/weapons, resident/explosions, and weapons_player/smg_smg
 * with `smgBank`), audio metadata (tests/fixtures/game/*.rel.xml), weapons.meta and a weapon clip
 * dictionary. Returns the game folder.
 */
export async function makeFakeGame(
  dir: string,
  opts: { key?: string; wholeFile?: boolean; metadata?: boolean; smgBank?: boolean } = {}
): Promise<string> {
  const bank = join(dir, 'ptl_pistol.awc')
  const smg = join(dir, 'smg_smg.awc')
  const shared = join(dir, 'weapons.awc')
  const explosions = join(dir, 'explosions.awc')
  writeFileSync(bank, fixtureBank())
  writeFileSync(smg, fixtureBank())
  writeFileSync(shared, fixtureBank())
  writeFileSync(explosions, fixtureBank())
  const game = join(dir, 'Grand Theft Auto V')
  const metadata =
    opts.metadata === false
      ? []
      : [
          '--rel',
          join(fixtures, 'sounds.dat54.rel.xml'),
          '--rel',
          join(fixtures, 'game.dat151.rel.xml'),
          '--rel',
          join(fixtures, 'curves.dat16.rel.xml'),
          '--rel',
          join(fixtures, 'categories.dat22.rel.xml'),
          '--weapons-meta',
          join(fixtures, 'weapons.meta'),
          '--ycd-xml',
          join(fixtures, 'weapons@pistol.ycd.xml')
        ]
  await runBridge(bridgeExe, [
    'make-test-game',
    '--out',
    game,
    ...(opts.key ? ['--test-awc-key', opts.key] : []),
    ...(opts.wholeFile ? ['--whole-file'] : []),
    '--weapons-player-awc',
    bank,
    ...(opts.smgBank ? ['--weapons-player-awc', smg] : []),
    '--resident-awc',
    shared,
    '--resident-awc',
    explosions,
    ...metadata
  ])
  return game
}

/**
 * A self-contained vanilla pack made from a fake game (its banks AWC-encrypted with the test key),
 * and a .zip of it. Returns the pack folder, the zip and the game it came from.
 */
export async function makeFakeVanillaPack(
  dir: string,
  opts: { smgBank?: boolean } = {}
): Promise<{ pack: string; zip: string; game: string }> {
  const game = await makeFakeGame(dir, { key: testAwcKey, smgBank: opts.smgBank })
  const pack = join(dir, 'vanilla-pack')
  await runBridge(bridgeExe, ['make-vanilla-pack', '--gta', game, '--out', pack, '--no-keys', '--test-awc-key', testAwcKey])
  const zip = join(dir, 'vanilla-pack.zip')
  await runBridge(bridgeExe, ['zip', '--in', pack, '--out', zip])
  return { pack, zip, game }
}
