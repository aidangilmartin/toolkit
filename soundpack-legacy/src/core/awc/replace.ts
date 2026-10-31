import { decodeAdpcm, encodeAdpcm } from './adpcm'
import { computePeaks } from './peak'
import { AwcChunk, AwcError, AwcFormat, AwcStream, ChunkTag, Codec, getDataChunk, getFormat } from './types'

export function pcmToBytes(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i], true)
  return out
}

export function bytesToPcm(bytes: Uint8Array, samples?: number): Int16Array {
  const n = Math.min(samples ?? Infinity, Math.floor(bytes.byteLength / 2))
  const out = new Int16Array(n)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true)
  return out
}

/** Decodes a stream's audio for preview. */
export function decodeStreamPcm(stream: AwcStream): { pcm: Int16Array; sampleRate: number } {
  const fmt = getFormat(stream)
  const data = getDataChunk(stream)
  if (!fmt || !data) throw new AwcError('unsupported', 'Stream has no playable audio.')
  if (fmt.codec === Codec.PCM) return { pcm: bytesToPcm(data.bytes, fmt.samples), sampleRate: fmt.sampleRate }
  if (fmt.codec === Codec.ADPCM) return { pcm: decodeAdpcm(data.bytes, fmt.samples), sampleRate: fmt.sampleRate }
  throw new AwcError('unsupported', `Unsupported codec ${fmt.codec}.`)
}

export interface ReplaceOptions {
  /** Millibels; undefined keeps the template's value. */
  headroom?: number
  /** Output codec. PCM (default) is what FiveM packs ship; ADPCM is 4× smaller. */
  codec?: 'pcm' | 'adpcm'
}

export const MAX_SAMPLE_RATE = 65535

/**
 * Returns a copy of `stream` whose audio is the given mono 16-bit PCM. The original's id,
 * loop/marker metadata and unknown chunks are kept; samples, rate, codec, data and peaks are
 * rebuilt. Output is PCM (the codec real FiveM packs ship) unless `options.codec` says ADPCM.
 */
export function replaceStreamAudio(stream: AwcStream, pcm: Int16Array, sampleRate: number, options: ReplaceOptions = {}): AwcStream {
  const oldFmt = getFormat(stream)
  if (!oldFmt) throw new AwcError('unsupported', 'Stream has no format chunk and cannot be replaced.')
  if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > MAX_SAMPLE_RATE) {
    throw new AwcError('unsupported', `Sample rate ${sampleRate} is outside 1–${MAX_SAMPLE_RATE} Hz.`)
  }
  if (pcm.length === 0) pcm = new Int16Array(1)

  const samples = pcm.length
  const adpcm = options.codec === 'adpcm'
  const encoded = adpcm ? encodeAdpcm(pcm) : pcmToBytes(pcm)
  const inRange = (v: number): number => (v < samples ? v : 0)
  const format: AwcFormat = {
    ...oldFmt,
    samples,
    sampleRate,
    codec: adpcm ? Codec.ADPCM : Codec.PCM,
    headroom: clampHeadroom(options.headroom ?? oldFmt.headroom),
    loopPoint: oldFmt.loopPoint >= samples ? -1 : oldFmt.loopPoint,
    loopBegin: inRange(oldFmt.loopBegin),
    loopEnd: inRange(oldFmt.loopEnd),
    playBegin: inRange(oldFmt.playBegin),
    playEnd: inRange(oldFmt.playEnd)
  }

  let peakValues: Uint16Array | undefined
  if (oldFmt.peak !== undefined) {
    const peaks = computePeaks(pcm)
    format.peak = ((oldFmt.peak & 0xffff0000) | peaks.first) >>> 0
    peakValues = peaks.blocks
  }

  const chunks: AwcChunk[] = []
  let sawData = false
  for (const c of stream.chunks) {
    switch (c.kind) {
      case 'format':
        chunks.push({ ...c, format })
        break
      case 'data':
        sawData = true
        chunks.push({ ...c, bytes: encoded })
        break
      case 'peak':
        if (peakValues && peakValues.length > 0) chunks.push({ ...c, values: peakValues })
        break
      case 'markers':
        chunks.push({ ...c, markers: c.markers.filter((m) => m.sampleOffset < samples) })
        break
      default:
        chunks.push(c)
    }
  }
  if (!sawData) chunks.push({ tag: ChunkTag.data, kind: 'data', bytes: encoded })
  if (peakValues && peakValues.length > 0 && !chunks.some((c) => c.kind === 'peak')) {
    chunks.push({ tag: ChunkTag.peak, kind: 'peak', values: peakValues })
  }
  return { id: stream.id, chunks }
}

export const SILENCE_SAMPLES = 128
export const SILENCE_RATE = 48000

/** Replaces a stream with a tiny silent wave, the usual way packs mute a sound. */
export function silenceStream(stream: AwcStream): AwcStream {
  return replaceStreamAudio(stream, new Int16Array(SILENCE_SAMPLES), SILENCE_RATE)
}

function clampHeadroom(v: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(v)))
}
