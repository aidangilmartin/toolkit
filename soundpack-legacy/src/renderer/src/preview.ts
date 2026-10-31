import type { Environment, Voice } from '@core/soundgraph'
import type { EnvironmentPresets } from '@core/weapons'

/**
 * Renders a planned gunshot (see @core/soundgraph) the way the game layers it: every wave at its
 * time, level, pitch, pan, filters and envelope, plus an environment reverb standing in for the
 * game's runtime reverb (the one part the game data can't describe). Indoors, the wetness, delay
 * and filter come from the game's typical interior weapon metrics when the scan found them.
 */

export interface RenderEnvironment {
  environment: Environment
  presets?: EnvironmentPresets
}

export interface ResolvedWave {
  samples: Float32Array
  sampleRate: number
  /** Extra gain for this wave (the game applies the wave's headroom). */
  gainDb: number
}

export type WaveResolver = (voice: Voice) => ResolvedWave | null

const RATE = 48000
const MAX_SECONDS = 15
const dB = (db: number): number => Math.pow(10, db / 20)

const TAIL: Record<Environment, number> = { outdoor: 2.6, interior: 0.9, tunnel: 2.2 }
const SEND: Record<Environment, number> = { outdoor: 0.22, interior: 0.35, tunnel: 0.45 }

/** Procedural impulse responses: open-air slapback + long tail, a dense small room, or a long hard tunnel. */
function impulse(ctx: BaseAudioContext, env: Environment): AudioBuffer {
  const len = Math.floor(TAIL[env] * RATE)
  const buf = ctx.createBuffer(2, len, RATE)
  let seed = 0x2545f491
  const rnd = (): number => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return ((seed >>> 0) / 4294967296) * 2 - 1
  }
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch)
    let lp = 0
    for (let i = 0; i < len; i++) {
      const t = i / RATE
      const decay =
        env === 'outdoor' ? Math.exp(-t * 2.4) * Math.min(1, t / 0.04) : env === 'tunnel' ? Math.exp(-t * 2.8) : Math.exp(-t * 7.5)
      // darken the tail over time like air absorption
      const k = env === 'outdoor' ? Math.min(0.97, 0.55 + t * 0.25) : env === 'tunnel' ? 0.5 : 0.35
      lp = lp * k + rnd() * (1 - k)
      d[i] = lp * decay * (env === 'interior' ? 1.1 : 1.6)
    }
    if (env === 'tunnel') {
      // regular flutter echoes between the walls
      for (let k = 1; k * 0.045 < TAIL.tunnel; k++) {
        const at = Math.floor((k * 0.045 + ch * 0.003) * RATE)
        if (at < len) d[at] += 0.5 * Math.exp(-k * 0.12)
      }
    }
    if (env === 'outdoor') {
      for (const [ms, g] of [
        [85, 0.45],
        [160, 0.3],
        [310, 0.22],
        [540, 0.12]
      ]) {
        const at = Math.floor(((ms + ch * 7) / 1000) * RATE)
        if (at < len) d[at] += g
      }
    }
  }
  return buf
}

/** Volume: the header's attack/release fades, then a volume envelope (in dB) if the voice has one. */
function applyVolume(param: AudioParam, v: Voice, peakDb: number, end: number): void {
  const t0 = v.time
  const env = v.envelope?.target === 'volume' ? v.envelope : null
  if (env) {
    env.times.forEach((t, i) => {
      const at = t0 + t
      const value = dB(peakDb + env.values[i])
      if (i === 0) param.setValueAtTime(value, at)
      else param.linearRampToValueAtTime(value, at)
    })
    return
  }
  const peak = dB(peakDb)
  const attack = v.attackMs / 1000
  if (attack > 0) {
    param.setValueAtTime(0, t0)
    param.linearRampToValueAtTime(peak, t0 + attack)
  } else {
    param.setValueAtTime(peak, t0)
  }
  if (v.releaseMs > 0 && end > t0 + attack) {
    param.setValueAtTime(peak, Math.max(t0 + attack, end - v.releaseMs / 1000))
    param.linearRampToValueAtTime(0, end)
  }
}

/** Pitch, pan and filter envelopes as automation on the matching parameter. */
function automate(param: AudioParam, v: Voice, map: (value: number) => number): void {
  const env = v.envelope!
  env.times.forEach((t, i) => {
    const value = map(env.values[i])
    if (i === 0) param.setValueAtTime(value, v.time + t)
    else param.linearRampToValueAtTime(value, v.time + t)
  })
}

export async function renderPreview(voices: Voice[], resolve: WaveResolver, re: RenderEnvironment): Promise<AudioBuffer | null> {
  const env = re.environment
  const room = env === 'interior' ? re.presets?.interiorWeapon : null
  const items = voices.map((v) => ({ v, w: resolve(v) })).filter((x): x is { v: Voice; w: ResolvedWave } => !!x.w && x.w.samples.length > 0)
  if (!items.length) return null

  const rateOf = (v: Voice): number => Math.pow(2, v.cents / 1200)
  let end = 0
  for (const { v, w } of items) {
    const dur = Math.max(0, w.samples.length / w.sampleRate - v.startOffsetMs / 1000) / rateOf(v)
    end = Math.max(end, v.time + dur)
  }
  const seconds = Math.min(MAX_SECONDS, end + TAIL[env])
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(seconds * RATE)), RATE)

  // the game's master bus limits peaks; keep the same chain for "original" and "yours"
  const master = ctx.createGain()
  master.gain.value = dB(-6)
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -3
  limiter.knee.value = 3
  limiter.ratio.value = 20
  limiter.attack.value = 0.001
  limiter.release.value = 0.12
  master.connect(limiter).connect(ctx.destination)

  // the reverb bus; indoors with the game's typical interior wetness, predelay and filter
  const conv = ctx.createConvolver()
  conv.buffer = impulse(ctx, env)
  const reverbIn = ctx.createGain()
  let bus: AudioNode = reverbIn
  if (room) {
    const pre = ctx.createDelay(1)
    pre.delayTime.value = Math.min(1, Math.max(0, room.preDelay / 1000))
    bus = bus.connect(pre)
    if (room.lpf > 0 && room.lpf < 20000) {
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = room.lpf
      bus = bus.connect(lp)
    }
  }
  bus.connect(conv).connect(master)
  const send = room ? Math.max(0.05, Math.min(1, room.wetness)) : SEND[env]

  for (const { v, w } of items) {
    const buffer = ctx.createBuffer(1, w.samples.length, Math.max(3000, Math.min(768000, w.sampleRate)))
    buffer.copyToChannel(w.samples as Float32Array<ArrayBuffer>, 0)
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.playbackRate.value = rateOf(v)
    const target = v.envelope?.target
    if (target === 'pitch') automate(src.playbackRate, v, (c) => Math.pow(2, (v.cents + c) / 1200))
    let node: AudioNode = src
    if ((v.hpfHz && v.hpfHz > 20) || target === 'hpf') {
      const hp = ctx.createBiquadFilter()
      hp.type = 'highpass'
      hp.frequency.value = Math.min(20000, v.hpfHz ?? 20)
      if (target === 'hpf') automate(hp.frequency, v, (hz) => Math.max(20, Math.min(20000, hz)))
      node = node.connect(hp)
    }
    if ((v.lpfHz && v.lpfHz < 20000) || target === 'lpf') {
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = Math.max(20, v.lpfHz ?? 20000)
      if (target === 'lpf') automate(lp.frequency, v, (hz) => Math.max(20, Math.min(20000, hz)))
      node = node.connect(lp)
    }
    const pan = ctx.createStereoPanner()
    pan.pan.value = v.pan
    if (target === 'pan') automate(pan.pan, v, (p) => p)
    const amp = ctx.createGain()
    const voiceEnd = v.time + Math.max(0, w.samples.length / w.sampleRate - v.startOffsetMs / 1000) / rateOf(v)
    applyVolume(amp.gain, v, v.gainDb + w.gainDb, voiceEnd)
    node.connect(pan).connect(amp).connect(master)
    const sendGain = ctx.createGain()
    sendGain.gain.value = send * (0.6 + v.reverb)
    amp.connect(sendGain).connect(reverbIn)
    src.start(v.time, Math.max(0, v.startOffsetMs / 1000))
  }
  return ctx.startRendering()
}

export function toFloat(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 32768
  return out
}

/** Mono mixdown for drawing. */
export function mixdown(buffer: AudioBuffer): Float32Array {
  const out = new Float32Array(buffer.length)
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c)
    for (let i = 0; i < d.length; i++) out[i] += d[i] / buffer.numberOfChannels
  }
  return out
}
