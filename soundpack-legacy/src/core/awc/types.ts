/**
 * In-memory model of a RAGE Audio Wave Container (.awc), the format GTA V uses for
 * sound banks such as audio/sfx/weapons_player/ptl_pistol.awc.
 *
 * Format reference: CodeWalker's AwcFile.cs (dexyfex/CodeWalker), cross-checked against
 * real FiveM gun sound packs.
 */

export const AWC_MAGIC = 0x54414441 // "ADAT" read little-endian
export const AWC_MAGIC_BE = 0x41444154

export const AwcFlags = {
  chunkIndices: 0x1,
  singleChannelEncrypt: 0x2,
  multiChannel: 0x4,
  multiChannelEncrypt: 0x8
} as const

/** Chunk tags are the low byte of the joaat hash of the chunk name. */
export const ChunkTag = {
  data: 0x55,
  format: 0xfa,
  animation: 0x5c,
  peak: 0x36,
  mid: 0x68,
  gesture: 0x2b,
  granulargrains: 0x5a,
  granularloops: 0xd9,
  markers: 0xbd,
  streamformat: 0x48,
  seektable: 0xa3
} as const

export type ChunkName = keyof typeof ChunkTag

const tagNames = new Map<number, ChunkName>((Object.entries(ChunkTag) as [ChunkName, number][]).map(([name, tag]) => [tag, name]))

export function chunkName(tag: number): ChunkName | undefined {
  return tagNames.get(tag)
}

export const Codec = { PCM: 0, ADPCM: 4 } as const

export interface AwcFormat {
  samples: number
  /** -1 for one-shots. */
  loopPoint: number
  sampleRate: number
  /** Stored per wave by the game's build tools (millibels); kept from the template by default. */
  headroom: number
  loopBegin: number
  loopEnd: number
  playEnd: number
  playBegin: number
  codec: number
  /** Only present in 24-byte format chunks: low 16 bits = peak of the first 4096 samples, high 16 bits unknown. */
  peak?: number
}

export interface AwcMarker {
  name: number
  /** Usually float bits, sometimes a hash. Kept as raw u32. */
  value: number
  sampleOffset: number
  unused: number
}

interface ChunkCommon {
  tag: number
}

export type FormatChunk = ChunkCommon & { kind: 'format'; format: AwcFormat }
export type DataChunk = ChunkCommon & { kind: 'data'; bytes: Uint8Array }
export type PeakChunk = ChunkCommon & { kind: 'peak'; values: Uint16Array }
export type MarkersChunk = ChunkCommon & { kind: 'markers'; markers: AwcMarker[] }
/** Any chunk we don't need to understand (gesture, granular, animation, ...): bytes are kept verbatim. */
export type RawChunk = ChunkCommon & { kind: 'raw'; bytes: Uint8Array }

export type AwcChunk = FormatChunk | DataChunk | PeakChunk | MarkersChunk | RawChunk

export interface AwcStream {
  /** Low 29 bits of joaat(stream name). */
  id: number
  chunks: AwcChunk[]
}

export interface AwcFile {
  version: number
  flags: number
  streams: AwcStream[]
}

export type AwcErrorCode = 'not-awc' | 'encrypted' | 'big-endian' | 'multichannel' | 'corrupt' | 'unsupported'

export class AwcError extends Error {
  constructor(
    readonly code: AwcErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'AwcError'
  }
}

export function getFormat(stream: AwcStream): AwcFormat | undefined {
  for (const c of stream.chunks) if (c.kind === 'format') return c.format
  return undefined
}

export function getDataChunk(stream: AwcStream): DataChunk | undefined {
  for (const c of stream.chunks) if (c.kind === 'data') return c
  return undefined
}

export function getPeakChunk(stream: AwcStream): PeakChunk | undefined {
  for (const c of stream.chunks) if (c.kind === 'peak') return c
  return undefined
}

export function getMarkers(stream: AwcStream): AwcMarker[] {
  for (const c of stream.chunks) if (c.kind === 'markers') return c.markers
  return []
}

export function findStream(file: AwcFile, id: number): AwcStream | undefined {
  return file.streams.find((s) => s.id === id)
}

export interface StreamSummary {
  id: number
  samples: number
  sampleRate: number
  duration: number
  codec: number
  headroom: number
  looping: boolean
  hasMarkers: boolean
  chunkKinds: string[]
  /** False for streams without a plain format+data pair (e.g. MIDI); these can't be replaced. */
  editable: boolean
}

export function summarizeStream(stream: AwcStream): StreamSummary {
  const fmt = getFormat(stream)
  const data = getDataChunk(stream)
  const kinds = stream.chunks.map((c) => (c.kind === 'raw' ? (chunkName(c.tag) ?? `0x${c.tag.toString(16)}`) : c.kind))
  return {
    id: stream.id,
    samples: fmt?.samples ?? 0,
    sampleRate: fmt?.sampleRate ?? 0,
    duration: fmt && fmt.sampleRate > 0 ? fmt.samples / fmt.sampleRate : 0,
    codec: fmt?.codec ?? -1,
    headroom: fmt?.headroom ?? 0,
    looping: (fmt?.loopPoint ?? -1) >= 0,
    hasMarkers: stream.chunks.some((c) => c.kind === 'markers'),
    chunkKinds: kinds,
    editable: !!fmt && !!data && (fmt.codec === Codec.PCM || fmt.codec === Codec.ADPCM)
  }
}
