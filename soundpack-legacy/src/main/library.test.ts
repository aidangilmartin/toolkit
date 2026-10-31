import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeBank, sineWave } from '../core/awc/fixtures'
import { parseAwc } from '../core/awc/read'
import { writeAwc } from '../core/awc/write'
import { encodeWav16 } from '../core/wav'
import { LabelStore, TemplateLibrary } from './library'
import { packProject, unpackProject } from './projectFile'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'gsm-'))

describe('TemplateLibrary', () => {
  it('imports, lists, moves and removes binary banks', async () => {
    const src = tmp()
    writeFileSync(join(src, 'PTL_PISTOL.awc'), writeAwc(makeBank()))
    writeFileSync(join(src, 'weapons.awc'), writeAwc(makeBank()))
    writeFileSync(join(src, 'broken.awc'), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]))
    const lib = new TemplateLibrary(join(tmp(), 'templates'))
    const report = await lib.importAwc(['PTL_PISTOL.awc', 'weapons.awc', 'broken.awc'].map((f) => join(src, f)))
    expect(report.imported.map((t) => `${t.pack}/${t.file}`)).toEqual(['weapons_player/ptl_pistol.awc', 'resident/weapons.awc'])
    expect(report.errors).toEqual([{ name: 'broken.awc', message: expect.stringMatching(/encrypted/) }])

    const list = await lib.list()
    expect(list.map((t) => [t.pack, t.file, t.streamCount, t.origin])).toEqual([
      ['resident', 'weapons.awc', 4, 'awc'],
      ['weapons_player', 'ptl_pistol.awc', 4, 'awc']
    ])
    const data = await lib.read('weapons_player', 'ptl_pistol.awc')
    expect(parseAwc(data.bytes).streams.length).toBe(4)

    const moved = await lib.setPack('weapons_player', 'ptl_pistol.awc', 'dlc_test')
    expect(moved.pack).toBe('dlc_test')
    await expect(lib.setPack('dlc_test', 'ptl_pistol.awc', '../evil')).rejects.toThrow(/Invalid wave pack/)
    await lib.remove('dlc_test', 'ptl_pistol.awc')
    expect((await lib.list()).length).toBe(1)
  })

  it('imports CodeWalker XML exports with their wav folder', async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'smg_smg'))
    writeFileSync(join(dir, 'smg_smg', 'smg_shot_l.wav'), encodeWav16(sineWave(500, 32000, 300), 32000))
    writeFileSync(
      join(dir, 'smg_smg.awc.xml'),
      `<AudioWaveContainer><Version value="1" /><ChunkIndices value="True" /><Streams><Item><Name>smg_shot_l</Name><FileName>smg_shot_l.wav</FileName><Chunks><Item><Type>data</Type></Item><Item><Type>format</Type><Codec>PCM</Codec><Samples value="500" /><SampleRate value="32000" /><Headroom value="0" /><PlayBegin value="0" /><PlayEnd value="0" /><LoopBegin value="0" /><LoopEnd value="0" /><LoopPoint value="-1" /></Item></Chunks></Item></Streams></AudioWaveContainer>`
    )
    const lib = new TemplateLibrary(join(tmp(), 'templates'))
    const report = await lib.importCodeWalker([dir])
    expect(report.errors).toEqual([])
    expect(report.imported[0]).toMatchObject({ pack: 'weapons_player', file: 'smg_smg.awc', origin: 'codewalker-xml', hasNames: true })
    const data = await lib.read('weapons_player', 'smg_smg.awc')
    expect(Object.values(data.names)).toEqual(['smg_shot_l'])
  })
})

describe('LabelStore', () => {
  it('stores and clears labels', async () => {
    const store = new LabelStore(join(tmp(), 'labels.json'))
    await store.set('a', '  Shot 1 ')
    await store.set('b', 'x')
    await store.set('b', '')
    expect(await store.get()).toEqual({ a: 'Shot 1' })
  })
})

describe('project files', () => {
  it('round-trips project json and source audio', () => {
    const zip = packProject('{"x":1}', [{ id: 's1', fileName: 'my shot.wav', bytes: new Uint8Array([1, 2, 3]) }])
    const back = unpackProject(zip)
    expect(back.json).toBe('{"x":1}')
    expect(back.sources).toEqual([{ id: 's1', fileName: 'my shot.wav', bytes: new Uint8Array([1, 2, 3]) }])
    expect(() => unpackProject(new Uint8Array([1, 2, 3]))).toThrow(/gunpack/)
  })
})
