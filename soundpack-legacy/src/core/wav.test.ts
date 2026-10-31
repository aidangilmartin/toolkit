import { describe, expect, it } from 'vitest'
import { ByteWriter } from './binary'
import { encodeWav16, parseWav } from './wav'

function wavHeader(w: ByteWriter, format: number, channels: number, rate: number, bits: number, dataBytes: number): void {
  w.ascii('RIFF')
  w.u32(36 + dataBytes + 12)
  w.ascii('WAVE')
  w.ascii('LIST') // unknown chunk before fmt must be skipped
  w.u32(4)
  w.ascii('INFO')
  w.ascii('fmt ')
  w.u32(16)
  w.u16(format)
  w.u16(channels)
  w.u32(rate)
  w.u32((rate * channels * bits) / 8)
  w.u16((channels * bits) / 8)
  w.u16(bits)
  w.ascii('data')
  w.u32(dataBytes)
}

describe('wav', () => {
  it('round-trips 16-bit mono exactly', () => {
    const pcm = Int16Array.from([0, 1, -1, 32767, -32768, 1234])
    const wav = parseWav(encodeWav16(pcm, 22050))
    expect(wav.sampleRate).toBe(22050)
    expect(Array.from(wav.int16!)).toEqual(Array.from(pcm))
    expect(wav.channels[0][3]).toBeCloseTo(32767 / 32768)
  })

  it('reads 24-bit stereo and float', () => {
    const w = new ByteWriter()
    wavHeader(w, 1, 2, 48000, 24, 12)
    for (const v of [0x400000, -0x400000, 0x7fffff, 0]) {
      w.u8(v & 0xff)
      w.u8((v >> 8) & 0xff)
      w.u8((v >> 16) & 0xff)
    }
    const wav = parseWav(w.toBytes())
    expect(wav.channels.length).toBe(2)
    expect(wav.channels[0][0]).toBeCloseTo(0.5)
    expect(wav.channels[1][0]).toBeCloseTo(-0.5)
    expect(wav.int16).toBeUndefined()

    const f = new ByteWriter()
    wavHeader(f, 3, 1, 44100, 32, 8)
    const dv = new DataView(new ArrayBuffer(8))
    dv.setFloat32(0, 0.25, true)
    dv.setFloat32(4, -1, true)
    f.bytes(new Uint8Array(dv.buffer))
    expect(Array.from(parseWav(f.toBytes()).channels[0])).toEqual([0.25, -1])
  })

  it('rejects non-wav data', () => {
    expect(() => parseWav(new Uint8Array(64))).toThrow()
  })
})
