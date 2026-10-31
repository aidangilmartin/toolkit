import { describe, expect, it } from 'vitest'
import { awcStreamId } from '../hash'
import { encodeWav16 } from '../wav'
import { importCodeWalkerXml } from './codewalkerXml'
import { sineWave } from './fixtures'
import { parseAwc } from './read'
import { getFormat, getMarkers, getPeakChunk } from './types'
import { writeAwc } from './write'

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AudioWaveContainer>
 <Version value="1" />
 <ChunkIndices value="True" />
 <Streams>
  <Item>
   <Name>ptl_pistol_shot_l</Name>
   <FileName>ptl_pistol_shot_l.wav</FileName>
   <Chunks>
    <Item>
     <Type>peak</Type>
    </Item>
    <Item>
     <Type>data</Type>
    </Item>
    <Item>
     <Type>format</Type>
     <Codec>ADPCM</Codec>
     <Samples value="1" />
     <SampleRate value="32000" />
     <Headroom value="384" />
     <PlayBegin value="0" />
     <PlayEnd value="0" />
     <LoopBegin value="0" />
     <LoopEnd value="0" />
     <LoopPoint value="-1" />
     <Peak unk="7" />
    </Item>
    <Item>
     <Type>markers</Type>
     <Markers>
      <Item>
       <Name>hash_DEADBEEF</Name>
       <Value value="1.5" />
       <SampleOffset value="100" />
      </Item>
     </Markers>
    </Item>
   </Chunks>
  </Item>
  <Item>
   <Name>hash_0AA87351</Name>
   <FileName>hash_0AA87351.wav</FileName>
   <Chunks>
    <Item>
     <Type>data</Type>
    </Item>
    <Item>
     <Type>format</Type>
     <Codec>PCM</Codec>
     <Samples value="128" />
     <SampleRate value="48000" />
     <Headroom value="-201" />
     <PlayBegin value="0" />
     <PlayEnd value="0" />
     <LoopBegin value="0" />
     <LoopEnd value="0" />
     <LoopPoint value="-1" />
    </Item>
   </Chunks>
  </Item>
 </Streams>
</AudioWaveContainer>`

const files: Record<string, Uint8Array> = {
  'ptl_pistol_shot_l.wav': encodeWav16(sineWave(10000, 44100, 300), 44100),
  'hash_0AA87351.wav': encodeWav16(new Int16Array(128), 48000)
}

describe('importCodeWalkerXml', () => {
  it('rebuilds the bank with names, real sample counts and peaks', () => {
    const { awc, names } = importCodeWalkerXml(xml, (n) => files[n])
    const id = awcStreamId('ptl_pistol_shot_l')
    expect(names[id]).toBe('ptl_pistol_shot_l')
    expect(names[0x0aa87351]).toBeUndefined()
    expect(awc.flags).toBe(0xff01)
    expect(awc.streams.map((s) => s.id)).toEqual([0x0aa87351, id].sort((a, b) => a - b))

    const shot = awc.streams.find((s) => s.id === id)!
    const fmt = getFormat(shot)!
    expect(fmt.samples).toBe(10000) // from the wav, not the stale XML value
    expect(fmt.sampleRate).toBe(44100)
    expect(fmt.codec).toBe(0)
    expect(fmt.headroom).toBe(384)
    expect(fmt.peak! >>> 16).toBe(7)
    expect(getPeakChunk(shot)!.values.length).toBe(1)
    expect(getMarkers(shot)[0]).toMatchObject({ name: 0xdeadbeef, sampleOffset: 100 })
    expect(new DataView(new Uint32Array([getMarkers(shot)[0].value]).buffer).getFloat32(0, true)).toBe(1.5)

    // and it survives the binary writer
    const re = parseAwc(writeAwc(awc))
    expect(getFormat(re.streams.find((s) => s.id === id)!)!.samples).toBe(10000)
  })

  it('reports missing wavs and unsupported content', () => {
    expect(() => importCodeWalkerXml(xml, () => undefined)).toThrowError(/Missing audio file/)
    expect(() => importCodeWalkerXml('<Nope/>', () => undefined)).toThrowError(/AudioWaveContainer/)
    expect(() => importCodeWalkerXml(xml.replace('<Type>peak</Type>', '<Type>gesture</Type>'), (n) => files[n])).toThrowError(/gesture/)
    expect(() =>
      importCodeWalkerXml(xml.replace('<ChunkIndices value="True" />', '<MultiChannel value="True" />'), (n) => files[n])
    ).toThrowError(/multi-channel/)
  })
})
