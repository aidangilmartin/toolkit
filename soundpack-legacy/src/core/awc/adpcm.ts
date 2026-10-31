/**
 * RAGE IMA ADPCM: 2048-byte blocks, each a 4-byte header (u8 step index, pad, i16 predictor)
 * followed by 2044 bytes of 4-bit samples, low nibble first (4088 samples per block).
 */

const INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8]
const STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173,
  190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
  2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818,
  18500, 20350, 22385, 24623, 27086, 29794, 32767
]

export const ADPCM_BLOCK_BYTES = 2048
export const ADPCM_SAMPLES_PER_BLOCK = (ADPCM_BLOCK_BYTES - 4) * 2

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

export function decodeAdpcm(data: Uint8Array, sampleCount: number): Int16Array {
  const out = new Int16Array(sampleCount)
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let predictor = 0
  let stepIndex = 0
  let w = 0
  const nibble = (n: number): void => {
    const step = STEP_TABLE[stepIndex]
    let diff = ((((n & 7) << 1) + 1) * step) >> 3
    if (n & 8) diff = -diff
    predictor = clamp(predictor + diff, -32768, 32767)
    stepIndex = clamp(stepIndex + INDEX_TABLE[n], 0, 88)
    if (w < sampleCount) out[w++] = predictor
  }
  for (let block = 0; block < data.byteLength && w < sampleCount; block += ADPCM_BLOCK_BYTES) {
    if (block + 4 > data.byteLength) break
    stepIndex = clamp(data[block], 0, 88)
    predictor = view.getInt16(block + 2, true)
    const end = Math.min(block + ADPCM_BLOCK_BYTES, data.byteLength)
    for (let i = block + 4; i < end && w < sampleCount; i++) {
      nibble(data[i] & 0x0f)
      nibble((data[i] >> 4) & 0x0f)
    }
  }
  return out
}

export function encodeAdpcm(pcm: Int16Array): Uint8Array {
  const blocks = Math.ceil(pcm.length / ADPCM_SAMPLES_PER_BLOCK)
  const lastSamples = pcm.length - (blocks - 1) * ADPCM_SAMPLES_PER_BLOCK
  const size = blocks === 0 ? 0 : (blocks - 1) * ADPCM_BLOCK_BYTES + 4 + Math.ceil(lastSamples / 2)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  let predictor = 0
  let stepIndex = 0
  const encode = (sample: number): number => {
    let delta = sample - predictor
    let value = 0
    if (delta < 0) {
      value = 8
      delta = -delta
    }
    let step = STEP_TABLE[stepIndex]
    let diff = step >> 3
    if (delta > step) {
      value |= 4
      delta -= step
      diff += step
    }
    step >>= 1
    if (delta > step) {
      value |= 2
      delta -= step
      diff += step
    }
    step >>= 1
    if (delta > step) {
      value |= 1
      diff += step
    }
    predictor = clamp(predictor + (value & 8 ? -diff : diff), -32768, 32767)
    stepIndex = clamp(stepIndex + INDEX_TABLE[value & 7], 0, 88)
    return value
  }
  let s = 0
  for (let b = 0; b < blocks; b++) {
    const base = b * ADPCM_BLOCK_BYTES
    view.setUint8(base, stepIndex)
    view.setInt16(base + 2, predictor, true)
    const n = Math.min(ADPCM_SAMPLES_PER_BLOCK, pcm.length - s)
    for (let i = 0; i < n; i += 2) {
      const lo = encode(pcm[s + i])
      const hi = i + 1 < n ? encode(pcm[s + i + 1]) : 0
      out[base + 4 + (i >> 1)] = lo | (hi << 4)
    }
    s += n
  }
  return out
}
