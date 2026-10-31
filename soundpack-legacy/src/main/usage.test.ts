import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { bridgeExe as exe, fixtureBank, makeFakeGame, testAwcKey as key } from '../../tests/fakeGame'
import { parseAwc } from '../core/awc/read'
import { Codec, getFormat } from '../core/awc/types'
import { joaat } from '../core/hash'
import { codeOf, findByCode, idCodes } from '../core/idpack'
import { streamUsage, type SoundMap } from '../core/usage'
import { runBridge, type ExtractResult, type ScanResult } from './bridge'
import { buildIdPack } from './idPack'

const PISTOL = 0x16ef0ea5 // body_a: gunshot (random pick 1 of 2), report, slow-mo
const BODY_B = 0x02032920 // body_b: gunshot (pick 2 of 2), slow-mo, reload set + reload animation
const MECH = 0x0aa87351 // gunshot layer 2, slow-mo false branch, echo near

describe.skipIf(!existsSync(exe))('sound usage map (integration)', () => {
  let work: string
  let game: string
  let map: SoundMap

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'gsm-usage-'))
    game = await makeFakeGame(work, { key })
    const names = join(work, 'names.txt')
    writeFileSync(names, ['game.slowmo', 'hud_soundset', 'beep', 'audio', 'explosion_grenade', 'reload'].join('\n'))
    const r = await runBridge<ScanResult>(exe, [
      'scan',
      '--gta',
      game,
      '--out',
      join(work, 'out'),
      '--no-keys',
      '--test-awc-key',
      key,
      '--names',
      names
    ])
    map = JSON.parse(readFileSync(r.mapPath, 'utf8')) as SoundMap
  })

  it('lists every stream of every bank in both archives', () => {
    expect(Object.keys(map.banks).sort()).toEqual(['resident/explosions.awc', 'resident/weapons.awc', 'weapons_player/ptl_pistol.awc'])
    for (const bank of Object.values(map.banks)) expect(bank.streams.map((s) => s.id).sort()).toEqual([BODY_B, MECH, PISTOL].sort())
    expect(map.banks['resident/explosions.awc'].archive).toBe('RESIDENT.rpf')
    expect(map.animationTags).toBe(1)
  })

  it('traces a gun stream to every part that plays it', () => {
    const u = streamUsage(map, 'weapons_player', 'ptl_pistol.awc', PISTOL)
    expect(u.status).toBe('used')
    const parts = u.descriptions.map((d) => `${d.audience} ${d.who} ${d.what}`).sort()
    expect(parts).toEqual(['you Pistol Distant report', 'you Pistol Gunshot', 'you Pistol Slow-mo gunshot'])
    const shot = u.descriptions.find((d) => d.what === 'Gunshot')!
    expect(shot.when).toEqual(['layer 1 of 2, played together', 'random pick 1 of 2 (25% of the time)'])
    const slowmo = u.descriptions.find((d) => d.what === 'Slow-mo gunshot')!
    expect(slowmo.when[0]).toBe('when game.slowmo passes its check against 0.5')
  })

  it('finds reload sounds through the weapon setting and the animation tag', () => {
    const u = streamUsage(map, 'weapons_player', 'ptl_pistol.awc', BODY_B)
    const reload = u.descriptions.filter((d) => d.what.startsWith('Reload') || d.audience === 'anim')
    expect(reload.map((d) => d.what).sort()).toEqual(['Reload sounds', 'audio tag at 40% of the clip · entry "reload"'])
    expect(reload.find((d) => d.audience === 'anim')!.who).toBe('Animation weapons@pistol / reload_pistol')
    expect(u.descriptions.find((d) => d.what === 'Reload sounds')!.when).toEqual(['sound set entry "reload"'])
  })

  it('explains crossfades, stereo pairs, NPC variants, sound sets, code and unused streams', () => {
    const near = streamUsage(map, 'weapons_player', 'ptl_pistol.awc', MECH).descriptions.find((d) => d.what === 'Echo / tail')!
    expect(near.when).toEqual(['close range (fades out between 20 m and 80 m)'])
    const far = streamUsage(map, 'resident', 'weapons.awc', BODY_B).descriptions
    // the SMG's echo is this same file, whole
    expect(far.map((d) => `${d.what}: ${d.when.join(', ')}`).sort()).toEqual([
      'Echo / tail: ',
      'Echo / tail: at a distance (fades in between 20 m and 80 m)',
      'Heft: left channel'
    ])
    expect(streamUsage(map, 'resident', 'weapons.awc', MECH).descriptions[0].when).toEqual(['right channel'])

    const shared = streamUsage(map, 'resident', 'weapons.awc', PISTOL).descriptions
    const npc = shared.find((d) => d.what === 'Gunshot')!
    expect(npc.weapons).toEqual([{ weapon: 'WEAPON_PISTOL', label: 'Pistol', category: 'fallback' }])
    expect(npc.audience).toBe('others')
    expect(shared.find((d) => d.audience === 'code')!.summary).toBe('Sound set hud_soundset · entry "beep"')

    const boom = streamUsage(map, 'resident', 'explosions.awc', PISTOL).descriptions[0]
    expect(boom.who).toBe('Explosion explosion_grenade')
    expect(boom.what).toBe('Explosion')
    expect(streamUsage(map, 'resident', 'explosions.awc', BODY_B).status).toBe('code')
    expect(streamUsage(map, 'resident', 'explosions.awc', MECH).status).toBe('unused')
    expect(map.consumers[String(joaat('explosion_boom'))]).toEqual([
      { kind: 'game', owner: joaat('explosion_grenade'), field: 'ExplosionSound' }
    ])
  })

  it('builds an ID pack whose sounds say their codes, with a legend', async () => {
    const folder = join(work, 'idpack')
    mkdirSync(folder)
    const progress: string[] = []
    const banks = ['weapons_player/ptl_pistol.awc', 'resident/explosions.awc']
    const r = await buildIdPack({
      bridge: exe,
      source: ['--gta', game],
      map,
      banks,
      folder,
      tmp: mkdtempSync(join(tmpdir(), 'gsm-idtmp-')),
      progress: (m) => progress.push(m),
      extraArgs: ['--no-keys', '--test-awc-key', key]
    })
    // no Windows voices here: the labels are beeps
    expect(r.voice).toBeNull()
    expect(r.warnings.some((w) => w.includes('No Windows voice'))).toBe(true)
    expect(r.errors).toEqual([])
    expect(r.labelled).toBe(6)
    expect(r.archives.map((a) => a.file).sort()).toEqual(['RESIDENT.rpf', 'WEAPONS_PLAYER.rpf'])
    expect(progress.some((p) => p.startsWith('Labelling'))).toBe(true)

    const legend = readFileSync(join(folder, 'ID-LEGEND.txt'), 'utf8')
    const codes = idCodes(map)
    const code = codeOf(codes, 'resident/explosions.awc', PISTOL)!.code
    expect(legend).toContain(code)
    expect(legend).toContain('Explosion explosion_grenade · Explosion')
    expect(findByCode(codes, code)?.bank).toBe('resident/explosions.awc')
    expect(readFileSync(join(folder, 'README.txt'), 'utf8')).toContain('Sound ID pack')

    // read the rebuilt archives back as a game would
    const game2 = await makeFakeGame(mkdtempSync(join(tmpdir(), 'gsm-usage2-')), { key, metadata: false })
    for (const a of r.archives) copyFileSync(a.path, join(game2, 'x64', 'audio', 'sfx', a.file))
    const out = join(work, 'readback')
    const x = await runBridge<ExtractResult>(exe, ['extract', '--gta', game2, '--out', out, '--no-keys', '--test-awc-key', key])
    const pistol = parseAwc(new Uint8Array(readFileSync(x.extracted.find((e) => e.file === 'ptl_pistol.awc')!.path)))
    for (const s of pistol.streams) {
      const f = getFormat(s)
      if (!f) continue
      expect(f.codec).toBe(Codec.ADPCM)
      expect(f.sampleRate).toBeLessThanOrEqual(16000)
    }
    // banks that weren't chosen are untouched
    const weapons = parseAwc(new Uint8Array(readFileSync(x.extracted.find((e) => e.file === 'weapons.awc')!.path)))
    expect(weapons.streams).toEqual(parseAwc(fixtureBank()).streams)
  })
})
