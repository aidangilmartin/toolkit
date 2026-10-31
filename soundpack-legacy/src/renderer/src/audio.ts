import type { AudioData } from '@core/wav'
import { parseWav } from '@core/wav'

/** Decodes any audio Chromium understands; WAVs are parsed directly to keep their exact rate. */
export async function decodeAudio(name: string, bytes: Uint8Array): Promise<AudioData> {
  if (name.toLowerCase().endsWith('.wav')) {
    try {
      const wav = parseWav(bytes)
      return { sampleRate: wav.sampleRate, channels: wav.channels }
    } catch {
      // fall through to the browser decoder (e.g. compressed WAV variants)
    }
  }
  const ctx = new OfflineAudioContext(2, 1, 48000)
  const copy = bytes.slice().buffer
  let buf: AudioBuffer
  try {
    buf = await ctx.decodeAudioData(copy)
  } catch {
    throw new Error(`Couldn't decode ${name}. Try WAV, MP3, OGG or FLAC.`)
  }
  const channels = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i).slice())
  return { sampleRate: buf.sampleRate, channels }
}

/** Plays one sound at a time. */
export class Player {
  private ctx: AudioContext | null = null
  private node: AudioBufferSourceNode | null = null
  private listeners = new Set<(playing: string | null) => void>()
  playing: string | null = null

  subscribe(fn: (playing: string | null) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private set(tag: string | null): void {
    this.playing = tag
    for (const fn of this.listeners) fn(tag)
  }

  stop(): void {
    if (this.node) {
      this.node.onended = null
      try {
        this.node.stop()
      } catch {
        // already stopped
      }
      this.node = null
    }
    this.set(null)
  }

  play(tag: string, samples: Float32Array | Int16Array, sampleRate: number): void {
    this.stop()
    if (samples.length === 0) return
    this.ctx ??= new AudioContext()
    const rate = Math.max(3000, Math.min(768000, sampleRate))
    const buffer = this.ctx.createBuffer(1, samples.length, rate)
    const data = buffer.getChannelData(0)
    if (samples instanceof Int16Array) for (let i = 0; i < samples.length; i++) data[i] = samples[i] / 32768
    else data.set(samples)
    const node = this.ctx.createBufferSource()
    node.buffer = buffer
    node.connect(this.ctx.destination)
    node.onended = () => {
      if (this.node === node) {
        this.node = null
        this.set(null)
      }
    }
    this.node = node
    node.start()
    this.set(tag)
  }

  /** Plays an already rendered (stereo) buffer, e.g. a gunshot preview. */
  playBuffer(tag: string, rendered: AudioBuffer): void {
    this.stop()
    this.ctx ??= new AudioContext()
    const buffer = this.ctx.createBuffer(rendered.numberOfChannels, rendered.length, rendered.sampleRate)
    for (let c = 0; c < rendered.numberOfChannels; c++) buffer.copyToChannel(rendered.getChannelData(c), c)
    const node = this.ctx.createBufferSource()
    node.buffer = buffer
    node.connect(this.ctx.destination)
    node.onended = () => {
      if (this.node === node) {
        this.node = null
        this.set(null)
      }
    }
    this.node = node
    node.start()
    this.set(tag)
  }

  toggle(tag: string, samples: Float32Array | Int16Array, sampleRate: number): void {
    if (this.playing === tag) this.stop()
    else this.play(tag, samples, sampleRate)
  }
}

export const player = new Player()
