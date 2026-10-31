import { describe, expect, it } from 'vitest'
import { DEFAULT_SHAPE, findOnset, gainToDb, peak, pickChannel, resample, shapeAudio, toInt16 } from './dsp'

const tone = (n: number, rate: number, freq: number, amp = 0.5): Float32Array =>
  Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * freq * i) / rate) * amp)

/** Dominant frequency estimate from zero crossings. */
function zeroCrossFreq(x: Float32Array, rate: number): number {
  let c = 0
  for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 !== x[i] < 0) c++
  return (c / 2) * (rate / x.length)
}

describe('dsp', () => {
  it('picks and mixes channels', () => {
    const audio = { sampleRate: 1, channels: [Float32Array.from([1, 1]), Float32Array.from([0, -1])] }
    expect(Array.from(pickChannel(audio, 'mix'))).toEqual([0.5, 0])
    expect(Array.from(pickChannel(audio, 'left'))).toEqual([1, 1])
    expect(Array.from(pickChannel(audio, 'right'))).toEqual([0, -1])
  })

  it('finds the onset', () => {
    const x = new Float32Array(100)
    x[40] = 0.5
    expect(findOnset(x, -20)).toBe(40)
    expect(findOnset(new Float32Array(10), -20)).toBe(0)
  })

  it('resamples keeping length ratio and pitch', () => {
    const x = tone(48000, 48000, 1000)
    const y = resample(x, 48000, 32000)
    expect(y.length).toBe(32000)
    expect(zeroCrossFreq(y, 32000)).toBeCloseTo(1000, -1)
    expect(peak(y.subarray(1000, 31000))).toBeCloseTo(0.5, 1)
    const up = resample(x, 48000, 44100)
    expect(up.length).toBe(44100)
    expect(zeroCrossFreq(up, 44100)).toBeCloseTo(1000, -1)
  })

  it('removes content above the new Nyquist when downsampling', () => {
    const y = resample(tone(48000, 48000, 20000), 48000, 22050)
    expect(peak(y.subarray(2000, 20000))).toBeLessThan(0.02)
  })

  it('converts to 16-bit with clipping count', () => {
    const { pcm, clipped } = toInt16(Float32Array.from([0, 0.5, 2, -2]), false)
    expect(Array.from(pcm)).toEqual([0, 16384, 32767, -32768])
    expect(clipped).toBe(2)
  })

  it('shapes a source: trim, normalize, fade, length, rate', () => {
    const rate = 48000
    const x = new Float32Array(rate)
    x.set(tone(24000, rate, 500, 0.25), 4800) // 100 ms of silence first
    const out = shapeAudio({ sampleRate: rate, channels: [x] }, { ...DEFAULT_SHAPE, maxLengthMs: 250, fadeOutMs: 0 }, 32000)
    expect(out.sampleRate).toBe(32000)
    expect(out.pcm.length).toBe(8000)
    expect(Math.abs(out.pcm[0])).toBeLessThan(2000) // starts at the onset, not 100 ms of silence
    expect(out.peakDb).toBeCloseTo(-1, 1)
    expect(out.clipped).toBe(0)

    const faded = shapeAudio({ sampleRate: rate, channels: [tone(rate, rate, 500)] }, { ...DEFAULT_SHAPE, fadeOutMs: 50 }, 48000)
    expect(Math.abs(faded.pcm[faded.pcm.length - 1])).toBeLessThan(50)

    const loud = shapeAudio(
      { sampleRate: rate, channels: [tone(rate, rate, 500)] },
      { ...DEFAULT_SHAPE, normalize: false, gainDb: 12, sampleRate: 44100 },
      48000
    )
    expect(loud.sampleRate).toBe(44100)
    expect(loud.clipped).toBeGreaterThan(0)
    expect(gainToDb(0.5)).toBeCloseTo(-6.02, 1)
  })

  it('rejects impossible output rates', () => {
    expect(() =>
      shapeAudio({ sampleRate: 48000, channels: [tone(10, 48000, 1)] }, { ...DEFAULT_SHAPE, sampleRate: 96000 }, 48000)
    ).toThrow()
  })
})
