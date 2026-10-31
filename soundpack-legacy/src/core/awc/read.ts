import { ByteReader } from '../binary'
import { AWC_MAGIC, AWC_MAGIC_BE, AwcChunk, AwcError, AwcFile, AwcFlags, AwcFormat, AwcMarker, AwcStream, ChunkTag } from './types'

interface ChunkInfo {
  tag: number
  size: number
  offset: number
}

/** Parses an unencrypted, little-endian (PC) .awc file. */
export function parseAwc(bytes: Uint8Array): AwcFile {
  if (bytes.byteLength < 16) throw new AwcError('not-awc', 'File is too small to be an .awc sound bank.')
  const r = new ByteReader(bytes)
  const magic = r.u32()
  if (magic === AWC_MAGIC_BE) {
    throw new AwcError('big-endian', 'This .awc is from a console build of GTA V (big-endian). Use the PC version.')
  }
  if (magic !== AWC_MAGIC) {
    if (bytes.byteLength % 4 === 0) {
      throw new AwcError(
        'encrypted',
        'This .awc is encrypted. Open it in CodeWalker (RPF Explorer → right-click → Export XML) and import the exported folder instead.'
      )
    }
    throw new AwcError('not-awc', 'Not an .awc sound bank (missing ADAT header).')
  }
  const version = r.u16()
  const flags = r.u16()
  const streamCount = r.i32()
  r.i32() // data offset; recomputed on write

  if (flags & (AwcFlags.singleChannelEncrypt | AwcFlags.multiChannelEncrypt)) {
    throw new AwcError(
      'encrypted',
      'This .awc has encrypted audio data. Open it in CodeWalker (RPF Explorer → right-click → Export XML) and import the exported folder instead.'
    )
  }
  if (flags & AwcFlags.multiChannel) {
    throw new AwcError('multichannel', 'This .awc is a multi-channel stream (music/speech), not a sound-effect bank.')
  }
  if (streamCount < 0 || streamCount > 0xffff) throw new AwcError('corrupt', `Invalid stream count ${streamCount}.`)

  try {
    if (flags & AwcFlags.chunkIndices) r.pos += streamCount * 2

    const infos: { id: number; chunkCount: number }[] = []
    for (let i = 0; i < streamCount; i++) {
      const raw = r.u32()
      infos.push({ id: raw & 0x1fffffff, chunkCount: raw >>> 29 })
    }
    const chunkInfos: ChunkInfo[][] = infos.map((info) => {
      const list: ChunkInfo[] = []
      for (let j = 0; j < info.chunkCount; j++) {
        const raw = r.u64()
        list.push({
          tag: Number(raw >> 56n),
          size: Number((raw >> 28n) & 0x0fffffffn),
          offset: Number(raw & 0x0fffffffn)
        })
      }
      return list
    })

    const streams: AwcStream[] = infos.map((info, i) => ({
      id: info.id,
      chunks: chunkInfos[i].map((ci) => readChunk(r, ci))
    }))
    return { version, flags, streams }
  } catch (e) {
    if (e instanceof AwcError) throw e
    throw new AwcError('corrupt', `Corrupt .awc: ${(e as Error).message}`)
  }
}

function readChunk(r: ByteReader, ci: ChunkInfo): AwcChunk {
  if (ci.offset + ci.size > r.length) {
    throw new AwcError('corrupt', `Chunk at ${ci.offset} (+${ci.size}) runs past the end of the file.`)
  }
  const base = { tag: ci.tag }
  switch (ci.tag) {
    case ChunkTag.format: {
      if (ci.size !== 20 && ci.size !== 24) break
      r.pos = ci.offset
      const format: AwcFormat = {
        samples: r.u32(),
        loopPoint: r.i32(),
        sampleRate: r.u16(),
        headroom: r.i16(),
        loopBegin: r.u16(),
        loopEnd: r.u16(),
        playEnd: r.u16(),
        playBegin: r.u8(),
        codec: r.u8()
      }
      if (ci.size === 24) format.peak = r.u32()
      return { ...base, kind: 'format', format }
    }
    case ChunkTag.data:
      return { ...base, kind: 'data', bytes: r.bytesAt(ci.offset, ci.size) }
    case ChunkTag.peak: {
      if (ci.size % 2 !== 0) break
      r.pos = ci.offset
      const values = new Uint16Array(ci.size / 2)
      for (let i = 0; i < values.length; i++) values[i] = r.u16()
      return { ...base, kind: 'peak', values }
    }
    case ChunkTag.markers: {
      if (ci.size % 16 !== 0) break
      r.pos = ci.offset
      const markers: AwcMarker[] = []
      for (let i = 0; i < ci.size / 16; i++) {
        markers.push({ name: r.u32(), value: r.u32(), sampleOffset: r.u32(), unused: r.u32() })
      }
      return { ...base, kind: 'markers', markers }
    }
  }
  return { ...base, kind: 'raw', bytes: r.bytesAt(ci.offset, ci.size) }
}
