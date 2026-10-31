import { describe, expect, it } from 'vitest'
import { makeBank } from './awc/fixtures'
import { parseAwc } from './awc/read'
import { decodeStreamPcm } from './awc/replace'
import { getFormat } from './awc/types'
import { buildBanks } from './build'
import { DEFAULT_SHAPE } from './dsp'
import { assignSource, bankKey, newProject, silenceStreams } from './project'

const tone = (n: number): Float32Array => Float32Array.from({ length: n }, (_, i) => Math.sin(i / 5) * 0.8)

describe('buildBanks', () => {
  const template = makeBank()
  const templates = new Map([
    [bankKey('weapons_player', 'ptl_pistol.awc'), template],
    [bankKey('resident', 'weapons.awc'), template]
  ])
  const source = { id: 's1', fileName: 'shot.wav', channels: 1, sampleRate: 48000, durationMs: 250 }
  const sources = new Map([['s1', { sampleRate: 48000, channels: [tone(12000)] }]])

  it('replaces and silences streams, copying the rest untouched', () => {
    let project = { ...newProject(), resourceName: 'Test Pack' }
    project = assignSource(
      project,
      'weapons_player',
      'ptl_pistol.awc',
      [0x16ef0ea5],
      source,
      { ...DEFAULT_SHAPE, trimSilence: false, fadeOutMs: 0 },
      []
    )
    project = silenceStreams(project, 'weapons_player', 'ptl_pistol.awc', [0x02032920])
    const result = buildBanks({ project, templates, sources })

    expect(result.packName).toBe('test_pack')
    expect(result.archives).toEqual(['WEAPONS_PLAYER.rpf'])
    expect(result.banks.map((b) => [b.pack, b.file, b.replaced, b.silenced])).toEqual([['weapons_player', 'ptl_pistol.awc', 1, 1]])
    // which files others hear comes from the gun's data (the gun view), not from the archive name
    expect(result.warnings).toEqual([])

    const awc = parseAwc(result.banks[0].bytes)
    const replaced = awc.streams.find((s) => s.id === 0x16ef0ea5)!
    expect(getFormat(replaced)!.sampleRate).toBe(44100) // template rate kept
    expect(getFormat(replaced)!.samples).toBe(Math.round(12000 * (44100 / 48000)))
    expect(getFormat(awc.streams.find((s) => s.id === 0x02032920)!)!.samples).toBe(128)
    const untouched = awc.streams.find((s) => s.id === 0x0aa87351)!
    const orig = template.streams.find((s) => s.id === 0x0aa87351)!
    expect(Array.from(decodeStreamPcm(untouched).pcm)).toEqual(Array.from(decodeStreamPcm(orig).pcm))
  })

  it('rebuilds both archives when both packs change', () => {
    let project = assignSource(newProject(), 'weapons_player', 'ptl_pistol.awc', [0x16ef0ea5], source, DEFAULT_SHAPE, [])
    project = assignSource(project, 'resident', 'weapons.awc', [0x16ef0ea5], source, DEFAULT_SHAPE, [])
    const r = buildBanks({ project, templates, sources })
    expect(r.archives).toEqual(['WEAPONS_PLAYER.rpf', 'RESIDENT.rpf'])
    expect(r.warnings).toEqual([])
  })

  it('skips banks outside the two archives', () => {
    let project = assignSource(newProject(), 'dlc_heist', 'guns.awc', [1], source, DEFAULT_SHAPE, [])
    expect(() => buildBanks({ project, templates, sources })).toThrow(/Nothing to export/)
    project = assignSource(project, 'weapons_player', 'ptl_pistol.awc', [0x16ef0ea5], source, DEFAULT_SHAPE, [])
    const r = buildBanks({ project, templates, sources })
    expect(r.warnings).toContain('dlc_heist/guns.awc is skipped: only WEAPONS_PLAYER.rpf and RESIDENT.rpf can be rebuilt.')
  })

  it('fails clearly when something is missing', () => {
    const project = assignSource(newProject(), 'weapons_player', 'smg_smg.awc', [1], source, DEFAULT_SHAPE, [])
    expect(() => buildBanks({ project, templates, sources })).toThrow(/smg_smg.awc isn't in your library/)
    const p2 = assignSource(newProject(), 'weapons_player', 'ptl_pistol.awc', [0x16ef0ea5], source, DEFAULT_SHAPE, [])
    expect(() => buildBanks({ project: p2, templates, sources: new Map() })).toThrow(/audio file/)
  })

  it('warns about streams missing from the template', () => {
    const project = assignSource(newProject(), 'weapons_player', 'ptl_pistol.awc', [0x0aa87351, 42], source, DEFAULT_SHAPE, [])
    const r = buildBanks({ project, templates, sources, names: new Map([[bankKey('weapons_player', 'ptl_pistol.awc'), { 42: 'ghost' }]]) })
    expect(r.warnings).toContain("ptl_pistol.awc ghost is not in the game's bank and was skipped.")
  })
})
