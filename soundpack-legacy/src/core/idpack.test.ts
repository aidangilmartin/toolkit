import { describe, expect, it } from 'vitest'
import { makeBank, sineWave } from './awc/fixtures'
import { parseAwc } from './awc/read'
import { decodeStreamPcm } from './awc/replace'
import { Codec, getFormat } from './awc/types'
import { writeAwc } from './awc/write'
import {
  bankWords,
  buildIdBank,
  codeOf,
  composeClip,
  findByCode,
  idCodes,
  idEligible,
  idLegend,
  layerDelay,
  normalizeCode,
  stereoLeft,
  toneClip
} from './idpack'
import { testMap } from './usage.fixture'

const sine = (samples: number, rate: number, freq: number): Float32Array =>
  Float32Array.from(sineWave(samples, rate, freq), (v) => v / 32768)

describe('ID codes', () => {
  it('turns bank names into words', () => {
    expect(bankWords('ptl_pistol.awc')).toBe('pistol')
    expect(bankWords('smg_micro.awc')).toBe('S M G micro')
    expect(bankWords('mgn_sml_am83_vera.awc')).toBe('machine gun small am 83')
  })

  it('gives every stream a stable, unique code', () => {
    const codes = idCodes(testMap)
    expect(codeOf(codes, 'weapons_player/ptl_pistol.awc', 0xb)?.code).toBe('pistol 2')
    expect(codeOf(codes, 'resident/weapons.awc', 0xd)?.code).toBe('weapons 4')
    expect(codes.byCode.size).toBe(10)
    expect(idCodes(testMap).byCode.get('pistol 2')).toEqual(codes.byCode.get('pistol 2'))
  })

  it('makes clashing bank words unique', () => {
    const map = { ...testMap, banks: { ...testMap.banks, 'weapons_player/pistol.awc': testMap.banks['weapons_player/ptl_pistol.awc'] } }
    const codes = idCodes(map)
    expect(codes.bankWords.get('weapons_player/pistol.awc')).toBe('pistol')
    expect(codes.bankWords.get('weapons_player/ptl_pistol.awc')).toBe('pistol B')
  })

  it('looks up what someone heard', () => {
    const codes = idCodes(testMap)
    expect(normalizeCode('  S M G   Micro, Four ')).toBe('smg micro 4')
    expect(findByCode(codes, 'Pistol three')?.id).toBe(0xc)
    expect(findByCode(codes, 'weapons 4')?.bank).toBe('resident/weapons.awc')
    expect(findByCode(codes, 'player pistol 1')?.id).toBe(0xa)
    expect(findByCode(codes, 'pistol 9')).toBeUndefined()
  })
})

describe('label layout', () => {
  it('pairs stereo channels and staggers layers', () => {
    expect(stereoLeft(testMap, 'resident/weapons.awc', 0xc)).toBe(0xb)
    expect(stereoLeft(testMap, 'resident/weapons.awc', 0xb)).toBeUndefined()
    expect(layerDelay(testMap, 'weapons_player/ptl_pistol.awc', 0xa)).toBe(0) // layer 1
    expect(layerDelay(testMap, 'weapons_player/ptl_pistol.awc', 0xc)).toBeCloseTo(0.7) // layer 2
  })

  it('composes clips with a lead-in, gaps and a −1 dBFS peak', () => {
    const a = new Float32Array([0.5, -0.5])
    const b = new Float32Array([0.25])
    const x = composeClip([a, b], 100, 0.1, 0.05)
    expect(x).toHaveLength(10 + 2 + 5 + 1)
    expect(Math.max(...x.map(Math.abs))).toBeCloseTo(0.891, 3)
    expect(x[0]).toBe(0)
  })

  it('beeps digits when no voice is available', () => {
    const rate = 8000
    const beeps = (n: number): number => {
      const x = toneClip(n, rate)
      let count = 0
      for (let i = 1; i < x.length; i++) if (x[i - 1] === 0 && x[i] !== 0) count++
      return count
    }
    expect(beeps(3)).toBe(3)
    expect(beeps(21)).toBe(3)
    expect(toneClip(10, rate).length).toBeGreaterThan(toneClip(1, rate).length)
  })

  it('skips streams that cannot carry a label', () => {
    expect(idEligible(testMap, 'weapons_player/ptl_pistol.awc', 0xa)).toBe(true)
    const map = { ...testMap, banks: { ...testMap.banks, 'resident/x.awc': { ...testMap.banks['resident/weapons.awc'], mc: true } } }
    expect(idEligible(map, 'resident/x.awc', 0xa)).toBe(false)
  })
})

describe('buildIdBank', () => {
  it('replaces streams with ADPCM labels and keeps the bank within its original size', () => {
    const bank = makeBank()
    const original = writeAwc(bank)
    const label = (_id: number, rate: number): Float32Array => sine(Math.round(rate * 0.2), rate, 440)
    const r = buildIdBank(bank, original.length, (id, rate) => (id === 0x16ef0ea5 || id === 0x02032920 ? label(id, rate) : null))
    expect(r.replaced).toBe(2)
    expect(r.overBudget).toBe(false)
    expect(r.bytes.length).toBeLessThanOrEqual(original.length)
    const out = parseAwc(r.bytes)
    const s = out.streams.find((x) => x.id === 0x16ef0ea5)!
    expect(getFormat(s)?.codec).toBe(Codec.ADPCM)
    expect(getFormat(s)?.sampleRate).toBe(r.rate)
    expect(decodeStreamPcm(s).pcm.length).toBe(Math.round(r.rate * 0.2))
    expect(out.streams.find((x) => x.id === 0x0aa87351)).toEqual(bank.streams.find((x) => x.id === 0x0aa87351))
  })

  it('drops the label rate when the bank would grow', () => {
    const bank = makeBank()
    const original = writeAwc(bank)
    const r = buildIdBank(bank, original.length, (_id, rate) => sine(Math.round(rate * 2.5), rate, 440))
    expect(r.rate).toBe(11025)
    expect(r.overBudget).toBe(false)
    const tooLong = buildIdBank(bank, original.length, (_id, rate) => sine(Math.round(rate * 6), rate, 440))
    expect(tooLong).toMatchObject({ rate: 8000, overBudget: true })
  })
})

describe('legend', () => {
  it('lists every code with what it is for', () => {
    const codes = idCodes(testMap)
    const text = idLegend(testMap, codes, ['weapons_player/ptl_pistol.awc', 'resident/weapons.awc'], 'Microsoft Zira')
    expect(text).toContain('voice: Microsoft Zira')
    expect(text).toContain('WEAPONS_PLAYER.rpf / ptl_pistol.awc')
    expect(text).toMatch(/pistol 2\s+0x0000000B/)
    expect(text).toContain('Your Pistol · Gunshot')
    expect(text).toContain('says "weapons 2", right channel of it')
  })
})
