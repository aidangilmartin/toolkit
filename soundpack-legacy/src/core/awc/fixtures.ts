import { pcmToBytes } from './replace'
import { AwcFile, AwcStream, ChunkTag, Codec } from './types'

/** Builds a synthetic sound bank for tests (never real game audio). */
export function sineWave(samples: number, rate: number, freq: number, amp = 0.5): Int16Array {
  const out = new Int16Array(samples)
  for (let i = 0; i < samples; i++) out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * amp * 32767)
  return out
}

export function makeStream(id: number, pcm: Int16Array, rate: number, opts: { peak?: boolean; markers?: boolean } = {}): AwcStream {
  const chunks: AwcStream['chunks'] = [
    {
      tag: ChunkTag.format,
      kind: 'format',
      format: {
        samples: pcm.length,
        loopPoint: -1,
        sampleRate: rate,
        headroom: 350,
        loopBegin: 0,
        loopEnd: 0,
        playEnd: 0,
        playBegin: 0,
        codec: Codec.PCM,
        ...(opts.peak ? { peak: 0x12340000 } : {})
      }
    },
    { tag: ChunkTag.data, kind: 'data', bytes: pcmToBytes(pcm) }
  ]
  if (opts.markers) {
    chunks.push({
      tag: ChunkTag.markers,
      kind: 'markers',
      markers: [{ name: 0xdeadbeef, value: 0x3f800000, sampleOffset: 10, unused: 0 }]
    })
  }
  return { id, chunks }
}

export function makeBank(): AwcFile {
  return {
    version: 1,
    flags: 0xff01,
    streams: [
      makeStream(0x0aa87351, sineWave(128, 48000, 1000), 48000),
      makeStream(0x02032920, sineWave(8074, 32000, 440), 32000, { peak: true }),
      makeStream(0x16ef0ea5, sineWave(20000, 44100, 220), 44100, { peak: true, markers: true }),
      {
        id: 0x01020304,
        chunks: [{ tag: ChunkTag.gesture, kind: 'raw', bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]) }]
      }
    ]
  }
}
