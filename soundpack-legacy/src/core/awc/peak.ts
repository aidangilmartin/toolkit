/** Peak data the game keeps per wave, computed the same way CodeWalker rebuilds it. */
export const PEAK_BLOCK = 4096

function peakOf(pcm: Int16Array, start: number): number {
  let p = 0
  // CodeWalker skips the final sample of the wave; mirrored so rebuilt values match.
  const end = Math.min(start + PEAK_BLOCK, pcm.length - 1)
  for (let i = start; i < end; i++) {
    const v = Math.min(Math.abs(pcm[i]) * 2, 65535)
    if (v > p) p = v
  }
  return p
}

/** first = peak of samples [0, 4096); blocks = one value per following full 4096-sample block. */
export function computePeaks(pcm: Int16Array): { first: number; blocks: Uint16Array } {
  const count = Math.max(0, Math.trunc((pcm.length - PEAK_BLOCK) / PEAK_BLOCK))
  const blocks = new Uint16Array(count)
  for (let n = 0; n < count; n++) blocks[n] = peakOf(pcm, (n + 1) * PEAK_BLOCK)
  return { first: peakOf(pcm, 0), blocks }
}
