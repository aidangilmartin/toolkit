import { XMLParser } from 'fast-xml-parser'
import { parseHashRef } from '../hash'
import { pickChannel, toInt16 } from '../dsp'
import { parseWav } from '../wav'
import { replaceStreamAudio } from './replace'
import { AwcChunk, AwcError, AwcFile, AwcFlags, AwcFormat, AwcMarker, AwcStream, ChunkTag, Codec } from './types'

export interface CodeWalkerImport {
  awc: AwcFile
  /** Stream id → readable name, for streams CodeWalker could name. */
  names: Record<number, string>
  warnings: string[]
}

type XmlNode = Record<string, unknown>

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (tag) => tag === 'Item'
})

const text = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String((v as XmlNode)['#text'] ?? ''))
const attr = (node: XmlNode, key: string, name = 'value'): string | undefined => {
  const v = node[key]
  if (v && typeof v === 'object') return (v as XmlNode)[`@_${name}`] as string | undefined
  return undefined
}
const num = (node: XmlNode, key: string, fallback = 0): number => {
  const v = attr(node, key)
  const n = v === undefined ? NaN : Number(v)
  return Number.isFinite(n) ? n : fallback
}
const bool = (node: XmlNode, key: string): boolean => (attr(node, key) ?? '').toLowerCase() === 'true'
const items = (node: unknown): XmlNode[] => ((node as XmlNode | undefined)?.Item as XmlNode[] | undefined) ?? []

function floatBits(f: number): number {
  const dv = new DataView(new ArrayBuffer(4))
  dv.setFloat32(0, f, true)
  return dv.getUint32(0, true)
}

const HASH_VALUE_MARKERS = new Set([0xf31b4f6a, 0x08dba0f8, 0x14d857be]) // rockout, dj, g_s

/**
 * Imports a CodeWalker "Export XML" of an .awc: the .awc.xml text plus the .wav files it
 * references. `getFile` looks a file up by the name written in <FileName>.
 */
export function importCodeWalkerXml(xml: string, getFile: (name: string) => Uint8Array | undefined): CodeWalkerImport {
  let doc: XmlNode
  try {
    doc = parser.parse(xml) as XmlNode
  } catch (e) {
    throw new AwcError('not-awc', `Could not read XML: ${(e as Error).message}`)
  }
  const root = doc.AudioWaveContainer as XmlNode | undefined
  if (!root) throw new AwcError('not-awc', 'Not a CodeWalker .awc.xml file (no <AudioWaveContainer>).')
  if (bool(root, 'MultiChannel')) {
    throw new AwcError('multichannel', 'This .awc is a multi-channel stream (music/speech), not a sound-effect bank.')
  }

  const warnings: string[] = []
  const names: Record<number, string> = {}
  const streams: AwcStream[] = []

  for (const item of items(root.Streams)) {
    const nameText = text(item.Name)
    const id = parseHashRef(nameText) & 0x1fffffff
    if (nameText && !/^hash_/i.test(nameText)) names[id] = nameText
    const label = nameText || `stream ${streams.length}`

    let format: AwcFormat | undefined
    const chunks: AwcChunk[] = []
    for (const c of items(item.Chunks)) {
      const type = text(c.Type)
      switch (type) {
        case 'format': {
          const codec = text(c.Codec).toUpperCase()
          format = {
            samples: num(c, 'Samples'),
            loopPoint: num(c, 'LoopPoint', -1),
            sampleRate: num(c, 'SampleRate', 32000),
            headroom: num(c, 'Headroom'),
            loopBegin: num(c, 'LoopBegin'),
            loopEnd: num(c, 'LoopEnd'),
            playEnd: num(c, 'PlayEnd'),
            playBegin: num(c, 'PlayBegin'),
            codec: codec === 'ADPCM' ? Codec.ADPCM : Codec.PCM
          }
          const peakUnk = attr(c, 'Peak', 'unk')
          if (peakUnk !== undefined) format.peak = ((Number(peakUnk) & 0xffff) << 16) >>> 0
          chunks.push({ tag: ChunkTag.format, kind: 'format', format })
          break
        }
        case 'data':
          chunks.push({ tag: ChunkTag.data, kind: 'data', bytes: new Uint8Array(0) })
          break
        case 'peak':
          chunks.push({ tag: ChunkTag.peak, kind: 'peak', values: new Uint16Array(0) })
          break
        case 'markers': {
          const markers: AwcMarker[] = items(c.Markers).map((m) => {
            const name = parseHashRef(text(m.Name))
            const value = HASH_VALUE_MARKERS.has(name) ? parseHashRef(text(m.Value)) : floatBits(num(m, 'Value'))
            return { name, value, sampleOffset: num(m, 'SampleOffset'), unused: 0 }
          })
          chunks.push({ tag: ChunkTag.markers, kind: 'markers', markers })
          break
        }
        default:
          throw new AwcError(
            'unsupported',
            `Stream "${label}" has a "${type}" chunk, which can't be rebuilt from XML. Import the binary .awc instead.`
          )
      }
    }
    if (!format) throw new AwcError('unsupported', `Stream "${label}" has no format chunk.`)

    const fileName = text(item.FileName).replace(/[\\/]/g, '')
    const wavBytes = fileName ? getFile(fileName) : undefined
    if (!wavBytes) throw new AwcError('corrupt', `Missing audio file "${fileName || label + '.wav'}" for stream "${label}".`)
    const wav = parseWav(wavBytes)
    let pcm = wav.int16
    if (!pcm) {
      pcm = toInt16(pickChannel(wav, 'mix'), false).pcm
      warnings.push(`${fileName} was not 16-bit mono; it was converted.`)
    }
    if (format.samples !== pcm.length) format.samples = pcm.length
    if (format.codec === Codec.ADPCM) format.codec = Codec.PCM
    streams.push(replaceStreamAudio({ id, chunks }, pcm, wav.sampleRate))
  }

  const flags = 0xff00 | (bool(root, 'ChunkIndices') ? AwcFlags.chunkIndices : 0)
  streams.sort((a, b) => a.id - b.id)
  return { awc: { version: num(root, 'Version', 1) || 1, flags, streams }, names, warnings }
}
