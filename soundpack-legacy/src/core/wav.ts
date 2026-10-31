import { ByteReader, ByteWriter } from './binary'

/** Decoded audio: one Float32Array per channel, samples in [-1, 1]. */
export interface AudioData {
  sampleRate: number
  channels: Float32Array[]
}

export interface ParsedWav extends AudioData {
  bitsPerSample: number
  /** Exact samples when the file is 16-bit mono PCM (CodeWalker exports always are). */
  int16?: Int16Array
}

const WAVE_FORMAT_PCM = 1
const WAVE_FORMAT_FLOAT = 3
const WAVE_FORMAT_EXTENSIBLE = 0xfffe

export function parseWav(bytes: Uint8Array): ParsedWav {
  const r = new ByteReader(bytes)
  const riff = r.u32()
  r.u32()
  const wave = r.u32()
  if (riff !== 0x46464952 || wave !== 0x45564157) throw new Error('Not a WAV file.')

  let format = 0
  let channels = 0
  let sampleRate = 0
  let bits = 0
  let dataOffset = -1
  let dataSize = 0
  while (r.pos + 8 <= r.length) {
    const id = r.u32()
    const size = r.u32()
    const start = r.pos
    if (id === 0x20746d66) {
      // "fmt "
      format = r.u16()
      channels = r.u16()
      sampleRate = r.u32()
      r.u32()
      r.u16()
      bits = r.u16()
      if (format === WAVE_FORMAT_EXTENSIBLE && size >= 40) {
        r.pos = start + 24
        format = r.u16()
      }
    } else if (id === 0x61746164) {
      // "data"
      dataOffset = start
      dataSize = Math.min(size, r.length - start)
    }
    r.pos = start + size + (size & 1)
  }
  if (!format || dataOffset < 0) throw new Error('WAV file is missing its fmt or data chunk.')
  if (channels < 1) throw new Error('WAV file has no channels.')
  const bytesPerSample = bits / 8
  if (![1, 2, 3, 4, 8].includes(bytesPerSample)) throw new Error(`Unsupported WAV bit depth ${bits}.`)
  if (format !== WAVE_FORMAT_PCM && format !== WAVE_FORMAT_FLOAT) throw new Error(`Unsupported WAV encoding ${format}.`)
  if (format === WAVE_FORMAT_FLOAT && bits !== 32 && bits !== 64) throw new Error('Unsupported float WAV.')

  const frames = Math.floor(dataSize / (bytesPerSample * channels))
  const view = new DataView(bytes.buffer, bytes.byteOffset + dataOffset, frames * bytesPerSample * channels)
  const out = Array.from({ length: channels }, () => new Float32Array(frames))
  const int16 = format === WAVE_FORMAT_PCM && bits === 16 && channels === 1 ? new Int16Array(frames) : undefined
  let p = 0
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      let v: number
      if (format === WAVE_FORMAT_FLOAT) {
        v = bits === 32 ? view.getFloat32(p, true) : view.getFloat64(p, true)
      } else if (bits === 8) {
        v = (view.getUint8(p) - 128) / 128
      } else if (bits === 16) {
        const s = view.getInt16(p, true)
        if (int16) int16[i] = s
        v = s / 32768
      } else if (bits === 24) {
        const s = view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getInt8(p + 2) << 16)
        v = s / 8388608
      } else {
        v = view.getInt32(p, true) / 2147483648
      }
      out[c][i] = v
      p += bytesPerSample
    }
  }
  return { sampleRate, channels: out, bitsPerSample: bits, int16 }
}

/** 16-bit mono PCM WAV. */
export function encodeWav16(pcm: Int16Array, sampleRate: number): Uint8Array {
  const w = new ByteWriter(44 + pcm.length * 2)
  w.ascii('RIFF')
  w.u32(36 + pcm.length * 2)
  w.ascii('WAVE')
  w.ascii('fmt ')
  w.u32(16)
  w.u16(WAVE_FORMAT_PCM)
  w.u16(1)
  w.u32(sampleRate)
  w.u32(sampleRate * 2)
  w.u16(2)
  w.u16(16)
  w.ascii('data')
  w.u32(pcm.length * 2)
  for (const s of pcm) w.i16(s)
  return w.toBytes()
}
