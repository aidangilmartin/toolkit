import { ByteWriter, padTo } from '../binary'
import { AWC_MAGIC, AwcChunk, AwcError, AwcFile, AwcFlags, ChunkTag } from './types'

/**
 * Layout order of chunk bodies, matching vanilla and community-built banks: every format
 * chunk, then peaks, then seek tables, then markers/other metadata, then audio data.
 */
function layoutRank(tag: number): number {
  switch (tag) {
    case ChunkTag.format:
    case ChunkTag.streamformat:
      return 0
    case ChunkTag.peak:
      return 1
    case ChunkTag.seektable:
      return 2
    case ChunkTag.data:
    case ChunkTag.mid:
      return 4
    default:
      return 3
  }
}

function alignment(tag: number): number {
  switch (tag) {
    case ChunkTag.data:
    case ChunkTag.mid:
      return 16
    case ChunkTag.markers:
    case ChunkTag.granulargrains:
    case ChunkTag.granularloops:
      return 4
    default:
      return 0
  }
}

export function chunkSize(chunk: AwcChunk): number {
  switch (chunk.kind) {
    case 'format':
      return chunk.format.peak === undefined ? 20 : 24
    case 'data':
    case 'raw':
      return chunk.bytes.byteLength
    case 'peak':
      return chunk.values.length * 2
    case 'markers':
      return chunk.markers.length * 16
  }
}

function writeChunkBody(w: ByteWriter, chunk: AwcChunk): void {
  switch (chunk.kind) {
    case 'format': {
      const f = chunk.format
      w.u32(f.samples)
      w.i32(f.loopPoint)
      w.u16(f.sampleRate)
      w.i16(f.headroom)
      w.u16(f.loopBegin)
      w.u16(f.loopEnd)
      w.u16(f.playEnd)
      w.u8(f.playBegin)
      w.u8(f.codec)
      if (f.peak !== undefined) w.u32(f.peak)
      return
    }
    case 'data':
    case 'raw':
      w.bytes(chunk.bytes)
      return
    case 'peak':
      for (const v of chunk.values) w.u16(v)
      return
    case 'markers':
      for (const m of chunk.markers) {
        w.u32(m.name)
        w.u32(m.value)
        w.u32(m.sampleOffset)
        w.u32(m.unused)
      }
      return
  }
}

const MAX_28 = 0x0fffffff

/** Serializes an AwcFile. Output is always unencrypted; streams are sorted by id like vanilla banks. */
export function writeAwc(file: AwcFile): Uint8Array {
  const flags = (file.flags | 0xff00) & ~(AwcFlags.singleChannelEncrypt | AwcFlags.multiChannelEncrypt) & 0xffff
  if (flags & AwcFlags.multiChannel) {
    throw new AwcError('unsupported', 'Writing multi-channel stream banks is not supported.')
  }
  const streams = [...file.streams].sort((a, b) => a.id - b.id)
  const ids = new Set<number>()
  for (const s of streams) {
    if (ids.has(s.id)) throw new AwcError('corrupt', `Duplicate stream id ${s.id.toString(16)}.`)
    ids.add(s.id)
    if (s.chunks.length > 7) throw new AwcError('unsupported', `Stream ${s.id.toString(16)} has more than 7 chunks.`)
  }

  const hasIndices = (flags & AwcFlags.chunkIndices) !== 0
  const totalChunks = streams.reduce((n, s) => n + s.chunks.length, 0)
  const headerSize = 16 + (hasIndices ? streams.length * 2 : 0) + streams.length * 4 + totalChunks * 8

  type Entry = { chunk: AwcChunk; si: number; ci: number; rank: number; offset: number; size: number }
  const entries: Entry[] = []
  streams.forEach((s, si) =>
    s.chunks.forEach((chunk, ci) => entries.push({ chunk, si, ci, rank: layoutRank(chunk.tag), offset: 0, size: chunkSize(chunk) }))
  )
  const layout = [...entries].sort((a, b) => a.rank - b.rank || a.si - b.si || a.ci - b.ci)
  let pos = headerSize
  for (const e of layout) {
    pos += padTo(pos, alignment(e.chunk.tag))
    e.offset = pos
    pos += e.size
    if (e.offset > MAX_28 || e.size > MAX_28) throw new AwcError('unsupported', 'Sound bank is too large (over 256 MB).')
  }

  const w = new ByteWriter(pos)
  w.u32(AWC_MAGIC)
  w.u16(file.version || 1)
  w.u16(flags)
  w.i32(streams.length)
  w.i32(headerSize)
  if (hasIndices) {
    let acc = 0
    for (const s of streams) {
      if (acc > 0xffff) throw new AwcError('unsupported', 'Too many chunks for chunk indices.')
      w.u16(acc)
      acc += s.chunks.length
    }
  }
  for (const s of streams) w.u32(((s.id & 0x1fffffff) | (s.chunks.length << 29)) >>> 0)
  for (const e of entries) {
    w.u64((BigInt(e.chunk.tag & 0xff) << 56n) | (BigInt(e.size) << 28n) | BigInt(e.offset))
  }
  for (const e of layout) {
    w.zeros(e.offset - w.pos)
    writeChunkBody(w, e.chunk)
  }
  return w.toBytes()
}
