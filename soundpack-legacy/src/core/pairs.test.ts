import { describe, expect, it } from 'vitest'
import { awcStreamId } from './hash'
import { detectPairs, pairOf } from './pairs'

describe('detectPairs', () => {
  it('pairs streams by name suffix', () => {
    const l = awcStreamId('shot_l')
    const r = awcStreamId('shot_r')
    const x = awcStreamId('tail_left')
    const y = awcStreamId('tail_right')
    const names = { [l]: 'shot_l', [r]: 'shot_r', [x]: 'tail_left', [y]: 'tail_right' }
    const pairs = detectPairs([l, r, x, y, 5], names)
    expect(pairs).toContainEqual({ left: l, right: r })
    expect(pairs).toContainEqual({ left: x, right: y })
    expect(pairOf(pairs, r)).toEqual({ pair: { left: l, right: r }, side: 'right' })
    expect(pairOf(pairs, 5)).toBeUndefined()
  })

  it('finds the right side by hash when only the left is named', () => {
    const l = awcStreamId('shot_l')
    const r = awcStreamId('shot_r')
    expect(detectPairs([l, r], { [l]: 'shot_l' })).toEqual([{ left: l, right: r }])
  })

  it("matches CodeWalker's <bank>_left/_right convention without names", () => {
    const l = awcStreamId('ptl_pistol_left')
    const r = awcStreamId('ptl_pistol_right')
    expect(detectPairs([r, 1, l], {}, 'PTL_PISTOL.awc')).toEqual([{ left: l, right: r }])
  })
})
