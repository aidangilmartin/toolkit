import { describe, expect, it } from 'vitest'
import { awcStreamId, hex8, joaat, parseHashRef } from './hash'

describe('joaat', () => {
  it('matches known GTA V hashes', () => {
    expect(joaat('weapon_pistol')).toBe(0x1b06d571)
    expect(joaat('WEAPON_PISTOL')).toBe(0x1b06d571)
    expect(joaat('adder')).toBe(0xb779a091)
  })

  it('keeps 29 bits for AWC stream ids', () => {
    expect(awcStreamId('weapon_pistol')).toBe(0x1b06d571 & 0x1fffffff)
  })

  it('parses CodeWalker hash references', () => {
    expect(parseHashRef('hash_1B06D571')).toBe(0x1b06d571)
    expect(parseHashRef('0x00ab')).toBe(0xab)
    expect(parseHashRef('weapon_pistol')).toBe(0x1b06d571)
    expect(hex8(0xab)).toBe('000000AB')
  })
})
