import { describe, expect, it } from 'vitest'
import { installReadme, sanitizePackName } from './pack'

describe('pack', () => {
  it('sanitizes pack names', () => {
    expect(sanitizePackName(' My Gun Pack! ')).toBe('my_gun_pack')
    expect(sanitizePackName('***')).toBe('gunpack')
  })

  it('explains where the archives go', () => {
    const text = installReadme('my_pack', ['WEAPONS_PLAYER.rpf', 'RESIDENT.rpf'])
    expect(text).toContain('WEAPONS_PLAYER.rpf')
    expect(text).toContain('RESIDENT.rpf')
    expect(text).toContain('%localappdata%\\FiveM\\FiveM.app\\mods')
    expect(text).toContain('mods\\x64\\audio\\sfx')
  })
})
