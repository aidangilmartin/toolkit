import { describe, expect, it } from 'vitest'
import { decodeAdpcm, encodeAdpcm } from './adpcm'
import { makeBank, makeStream, sineWave } from './fixtures'
import { computePeaks } from './peak'
import { parseAwc } from './read'
import { bytesToPcm, decodeStreamPcm, replaceStreamAudio, silenceStream } from './replace'
import { AwcError, AwcFlags, Codec, getDataChunk, getFormat, getPeakChunk, summarizeStream } from './types'
import { writeAwc } from './write'

function strip(file: ReturnType<typeof parseAwc>): unknown {
  return file.streams.map((s) => ({ id: s.id, chunks: s.chunks }))
}

describe('writeAwc / parseAwc', () => {
  it('round-trips a bank', () => {
    const bank = makeBank()
    const bytes = writeAwc(bank)
    const parsed = parseAwc(bytes)
    expect(parsed.version).toBe(1)
    expect(parsed.flags).toBe(0xff01)
    expect(parsed.streams.map((s) => s.id)).toEqual([...bank.streams.map((s) => s.id)].sort((a, b) => a - b))
    const byId = new Map(bank.streams.map((s) => [s.id, s]))
    for (const s of parsed.streams) {
      expect(s.chunks).toEqual(byId.get(s.id)!.chunks)
    }
    // writing the parsed file again is byte-identical
    expect(writeAwc(parsed)).toEqual(bytes)
  })

  it('lays out the header like the game expects', () => {
    const bank = makeBank()
    const bytes = writeAwc(bank)
    const view = new DataView(bytes.buffer)
    expect(view.getUint32(0, true)).toBe(0x54414441)
    const count = view.getInt32(8, true)
    expect(count).toBe(4)
    const totalChunks = bank.streams.reduce((n, s) => n + s.chunks.length, 0)
    const dataOffset = 16 + count * 2 + count * 4 + totalChunks * 8
    expect(view.getInt32(12, true)).toBe(dataOffset)

    // chunk indices are cumulative chunk counts in (sorted) stream order
    const sorted = [...bank.streams].sort((a, b) => a.id - b.id)
    let acc = 0
    sorted.forEach((s, i) => {
      expect(view.getUint16(16 + i * 2, true)).toBe(acc)
      acc += s.chunks.length
    })
    // stream info packs chunk count into the top 3 bits
    const info0 = view.getUint32(16 + count * 2, true)
    expect(info0 & 0x1fffffff).toBe(sorted[0].id)
    expect(info0 >>> 29).toBe(sorted[0].chunks.length)

    // every data chunk is 16-byte aligned, markers 4-byte aligned, formats come first
    let p = 16 + count * 2 + count * 4
    const chunks: { tag: number; size: number; offset: number }[] = []
    for (let i = 0; i < totalChunks; i++) {
      const raw = view.getBigUint64(p, true)
      p += 8
      chunks.push({ tag: Number(raw >> 56n), size: Number((raw >> 28n) & 0xfffffffn), offset: Number(raw & 0xfffffffn) })
    }
    for (const c of chunks) {
      if (c.tag === 0x55) expect(c.offset % 16).toBe(0)
      if (c.tag === 0xbd) expect(c.offset % 4).toBe(0)
    }
    const byOffset = [...chunks].sort((a, b) => a.offset - b.offset)
    expect(byOffset[0].tag).toBe(0xfa)
    expect(byOffset[byOffset.length - 1].tag).toBe(0x55)
    expect(byOffset[0].offset).toBe(dataOffset)
    const last = byOffset[byOffset.length - 1]
    expect(bytes.byteLength).toBe(last.offset + last.size)
  })

  it('keeps unknown chunks verbatim', () => {
    const parsed = parseAwc(writeAwc(makeBank()))
    const raw = parsed.streams.find((s) => s.id === 0x01020304)!.chunks[0]
    expect(raw.kind).toBe('raw')
    expect(raw.kind === 'raw' && Array.from(raw.bytes)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('omits chunk indices when the flag is off', () => {
    const bank = { ...makeBank(), flags: 0xff00 }
    const parsed = parseAwc(writeAwc(bank))
    expect(parsed.flags & AwcFlags.chunkIndices).toBe(0)
    expect(strip(parsed)).toEqual(strip(parseAwc(writeAwc(makeBank()))))
  })

  it('rejects encrypted, console and multichannel files with clear errors', () => {
    const good = writeAwc(makeBank())
    const enc = good.slice()
    enc[0] ^= 0xff
    expect(() => parseAwc(enc)).toThrowError(expect.objectContaining({ code: 'encrypted' }))
    const be = good.slice()
    be.set([0x54, 0x41, 0x44, 0x41], 0) // "TADA"
    expect(() => parseAwc(be)).toThrowError(expect.objectContaining({ code: 'big-endian' }))
    const flagged = good.slice()
    new DataView(flagged.buffer).setUint16(6, 0xff03, true)
    expect(() => parseAwc(flagged)).toThrowError(expect.objectContaining({ code: 'encrypted' }))
    const multi = good.slice()
    new DataView(multi.buffer).setUint16(6, 0xff05, true)
    expect(() => parseAwc(multi)).toThrowError(expect.objectContaining({ code: 'multichannel' }))
    expect(() => parseAwc(new Uint8Array(4))).toThrowError(AwcError)
  })

  it('reports truncated files as corrupt', () => {
    const good = writeAwc(makeBank())
    expect(() => parseAwc(good.slice(0, good.length - 10))).toThrowError(expect.objectContaining({ code: 'corrupt' }))
  })
})

describe('computePeaks', () => {
  it('matches the CodeWalker formula', () => {
    const pcm = new Int16Array(4096 * 3 + 100)
    pcm[5] = -1000
    pcm[4096 + 7] = 20000
    pcm[4096 * 2 + 1] = 32767
    const { first, blocks } = computePeaks(pcm)
    expect(first).toBe(2000)
    expect(Array.from(blocks)).toEqual([40000, 65534])
  })

  it('has no block values for short waves', () => {
    expect(computePeaks(new Int16Array(5000)).blocks.length).toBe(0)
    expect(computePeaks(new Int16Array(10)).blocks.length).toBe(0)
    expect(computePeaks(new Int16Array(4096 * 2)).blocks.length).toBe(1)
  })
})

describe('ADPCM', () => {
  it('decodes what it encodes with small error', () => {
    const pcm = sineWave(10000, 32000, 440, 0.6)
    const enc = encodeAdpcm(pcm)
    expect(enc.byteLength).toBe(2048 * 2 + 4 + Math.ceil((10000 - 4088 * 2) / 2))
    const dec = decodeAdpcm(enc, pcm.length)
    // IMA ADPCM needs a few dozen samples to adapt its step size; compare after that
    let err = 0
    for (let i = 200; i < pcm.length; i++) err = Math.max(err, Math.abs(dec[i] - pcm[i]))
    expect(err).toBeLessThan(1500)
  })
})

describe('replaceStreamAudio', () => {
  it('rebuilds format, data and peaks', () => {
    const stream = makeStream(0x1234, sineWave(20000, 44100, 220), 44100, { peak: true, markers: true })
    const pcm = sineWave(4096 * 4 + 1, 48000, 100, 0.9)
    const out = replaceStreamAudio(stream, pcm, 48000)
    const fmt = getFormat(out)!
    expect(fmt.samples).toBe(pcm.length)
    expect(fmt.sampleRate).toBe(48000)
    expect(fmt.codec).toBe(Codec.PCM)
    expect(fmt.headroom).toBe(350)
    expect(fmt.peak! >>> 16).toBe(0x1234)
    expect(fmt.peak! & 0xffff).toBe(computePeaks(pcm).first)
    expect(getDataChunk(out)!.bytes.byteLength).toBe(pcm.length * 2)
    expect(Array.from(bytesToPcm(getDataChunk(out)!.bytes))).toEqual(Array.from(pcm))
    expect(getPeakChunk(out)!.values.length).toBe(3)
    // original untouched
    expect(getFormat(stream)!.samples).toBe(20000)
  })

  it('drops the peak chunk when the new wave is short and honours headroom override', () => {
    const stream = makeStream(0x1234, sineWave(20000, 44100, 220), 44100, { peak: true })
    expect(getPeakChunk(stream)).toBeUndefined()
    const withPeak = replaceStreamAudio(stream, sineWave(9000, 44100, 220), 44100)
    expect(getPeakChunk(withPeak)!.values.length).toBe(1)
    const short = replaceStreamAudio(withPeak, sineWave(100, 44100, 220), 44100, { headroom: -150 })
    expect(getPeakChunk(short)).toBeUndefined()
    expect(getFormat(short)!.headroom).toBe(-150)
  })

  it('drops markers past the new end and survives a write/parse cycle', () => {
    const stream = makeStream(0x1234, sineWave(20000, 44100, 220), 44100, { markers: true })
    const out = replaceStreamAudio(stream, sineWave(5, 44100, 220), 44100)
    expect(out.chunks.find((c) => c.kind === 'markers')).toMatchObject({ markers: [] })
    const file = parseAwc(writeAwc({ version: 1, flags: 0xff01, streams: [out] }))
    expect(getFormat(file.streams[0])!.samples).toBe(5)
  })

  it('rejects invalid sample rates', () => {
    const stream = makeStream(1, sineWave(10, 44100, 220), 44100)
    expect(() => replaceStreamAudio(stream, new Int16Array(10), 96000)).toThrowError(AwcError)
  })

  it('silences a stream with a tiny wave', () => {
    const out = silenceStream(makeStream(1, sineWave(10000, 44100, 220), 44100, { peak: true }))
    expect(getFormat(out)!.samples).toBe(128)
    expect(getFormat(out)!.sampleRate).toBe(48000)
    expect(getFormat(out)!.peak! & 0xffff).toBe(0)
  })

  it('decodes PCM and ADPCM streams for preview', () => {
    const pcm = sineWave(5000, 32000, 440)
    const s = makeStream(1, pcm, 32000)
    expect(Array.from(decodeStreamPcm(s).pcm)).toEqual(Array.from(pcm))
    const adpcm = {
      id: 2,
      chunks: s.chunks.map((c) =>
        c.kind === 'format'
          ? { ...c, format: { ...c.format, codec: Codec.ADPCM } }
          : c.kind === 'data'
            ? { ...c, bytes: encodeAdpcm(pcm) }
            : c
      )
    }
    expect(decodeStreamPcm(adpcm).pcm.length).toBe(5000)
    expect(summarizeStream(adpcm).editable).toBe(true)
  })
})
