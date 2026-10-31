import type { AudioData } from './wav'

export type ChannelMode = 'mix' | 'left' | 'right'

/** How a source file is shaped before it goes into a stream. */
export interface ShapeSettings {
  channel: ChannelMode
  trimSilence: boolean
  /** Level (dBFS) that counts as the start of the sound when trimming. */
  trimThresholdDb: number
  startOffsetMs: number
  /** 0 = keep full length. */
  maxLengthMs: number
  fadeInMs: number
  fadeOutMs: number
  gainDb: number
  normalize: boolean
  normalizeDb: number
  /** 'template' keeps the replaced stream's rate. */
  sampleRate: 'template' | number
  /** 'template' keeps the replaced stream's headroom (millibels). */
  headroom: 'template' | number
}

export const DEFAULT_SHAPE: ShapeSettings = {
  channel: 'mix',
  trimSilence: true,
  trimThresholdDb: -50,
  startOffsetMs: 0,
  maxLengthMs: 0,
  fadeInMs: 0,
  fadeOutMs: 20,
  gainDb: 0,
  normalize: true,
  normalizeDb: -1,
  sampleRate: 'template',
  headroom: 'template'
}

export const dbToGain = (db: number): number => Math.pow(10, db / 20)
export const gainToDb = (g: number): number => (g > 0 ? 20 * Math.log10(g) : -Infinity)

export function pickChannel(audio: AudioData, mode: ChannelMode): Float32Array {
  const ch = audio.channels
  if (ch.length === 0) return new Float32Array(0)
  if (ch.length === 1) return ch[0].slice()
  if (mode === 'left') return ch[0].slice()
  if (mode === 'right') return ch[1].slice()
  const out = new Float32Array(ch[0].length)
  for (const c of ch) for (let i = 0; i < out.length; i++) out[i] += c[i]
  for (let i = 0; i < out.length; i++) out[i] /= ch.length
  return out
}

export function peak(x: Float32Array): number {
  let p = 0
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i])
    if (a > p) p = a
  }
  return p
}

/** Index of the first sample at or above the threshold (0 if none). */
export function findOnset(x: Float32Array, thresholdDb: number): number {
  const t = dbToGain(thresholdDb)
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) >= t) return i
  return 0
}

/** Windowed-sinc resampler (Blackman window, 32 zero crossings each side). */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to || x.length === 0) return x.slice()
  const ratio = to / from
  const outLen = Math.max(1, Math.round(x.length * ratio))
  const out = new Float32Array(outLen)
  const cutoff = Math.min(1, ratio) * 0.95
  const half = 32
  const radius = half / cutoff
  for (let n = 0; n < outLen; n++) {
    const t = n / ratio
    const lo = Math.max(0, Math.ceil(t - radius))
    const hi = Math.min(x.length - 1, Math.floor(t + radius))
    let acc = 0
    for (let k = lo; k <= hi; k++) {
      const d = t - k
      const u = d * cutoff
      const sinc = u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u)
      const wpos = d / radius
      const win = 0.42 + 0.5 * Math.cos(Math.PI * wpos) + 0.08 * Math.cos(2 * Math.PI * wpos)
      acc += x[k] * sinc * win
    }
    out[n] = acc * cutoff
  }
  return out
}

function fade(x: Float32Array, samples: number, atEnd: boolean): void {
  const n = Math.min(samples, x.length)
  for (let i = 0; i < n; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * (i + 1)) / (n + 1))
    if (atEnd) x[x.length - 1 - i] *= g
    else x[i] *= g
  }
}

/** Deterministic TPDF dither so identical inputs always build identical files. */
export function toInt16(x: Float32Array, dither = true): { pcm: Int16Array; clipped: number } {
  const pcm = new Int16Array(x.length)
  let seed = 0x9e3779b9
  const rnd = (): number => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 4294967296
  }
  let clipped = 0
  for (let i = 0; i < x.length; i++) {
    let v = x[i] * 32767
    if (dither) v += rnd() - rnd()
    v = Math.round(v)
    if (v > 32767) {
      v = 32767
      clipped++
    } else if (v < -32768) {
      v = -32768
      clipped++
    }
    pcm[i] = v
  }
  return { pcm, clipped }
}

export interface ShapeResult {
  pcm: Int16Array
  sampleRate: number
  clipped: number
  durationMs: number
  peakDb: number
}

/**
 * Turns a decoded source into the mono 16-bit wave written to a stream:
 * channel → trim → offset → max length → resample → normalize → gain → fades → 16-bit.
 */
export function shapeAudio(audio: AudioData, s: ShapeSettings, templateRate: number): ShapeResult {
  let x = pickChannel(audio, s.channel)
  const srcRate = audio.sampleRate
  let start = s.trimSilence ? findOnset(x, s.trimThresholdDb) : 0
  start += Math.round((Math.max(0, s.startOffsetMs) * srcRate) / 1000)
  let end = x.length
  if (s.maxLengthMs > 0) end = Math.min(end, start + Math.round((s.maxLengthMs * srcRate) / 1000))
  x = x.slice(Math.min(start, x.length), Math.max(Math.min(start, x.length), end))

  const rate = Math.round(s.sampleRate === 'template' ? templateRate : s.sampleRate)
  if (!(rate >= 8000 && rate <= 65535)) throw new Error(`Output sample rate ${rate} Hz is outside 8000–65535 Hz.`)
  x = resample(x, srcRate, rate)

  let g = dbToGain(s.gainDb)
  if (s.normalize) {
    const p = peak(x)
    if (p > 0) g *= dbToGain(s.normalizeDb) / p
  }
  if (g !== 1) for (let i = 0; i < x.length; i++) x[i] *= g
  fade(x, Math.round((Math.max(0, s.fadeInMs) * rate) / 1000), false)
  fade(x, Math.round((Math.max(0, s.fadeOutMs) * rate) / 1000), true)

  const { pcm, clipped } = toInt16(x)
  return { pcm, sampleRate: rate, clipped, durationMs: (pcm.length / rate) * 1000, peakDb: gainToDb(peak(x)) }
}
