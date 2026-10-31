import { describe, expect, it } from 'vitest'
import { audienceVariants, fireRate, leaves, prettyWeaponName, variantAudience, weaponLabel, weaponParts } from './weapons'
import { fixtureIndex } from './weapons.fixture'
import { joaat } from './hash'

describe('weapons', () => {
  const index = fixtureIndex()
  const [pistol, smg] = index.weapons

  it('names weapons', () => {
    expect(weaponLabel(pistol)).toBe('Pistol')
    expect(weaponLabel(smg)).toBe('SMG')
    expect(prettyWeaponName('WEAPON_HEAVY_SNIPER_MK2')).toBe('Heavy Sniper MK2')
    expect(fireRate(pistol)).toBe(400)
  })

  it('collects every wave under a sound once', () => {
    expect(leaves(index, joaat('pistol_player_fire')).map((l) => l.file)).toEqual([0x16ef0ea5, 0x02032920, 0x0aa87351])
  })

  it('resolves parts to banks and streams per role', () => {
    const parts = weaponParts(index, pistol.variants[0])
    expect(parts).toEqual([
      { role: 'fire', pack: 'weapons_player', bank: 'ptl_pistol.awc', streamId: 0x16ef0ea5 },
      { role: 'fire', pack: 'weapons_player', bank: 'ptl_pistol.awc', streamId: 0x02032920 },
      { role: 'fire', pack: 'weapons_player', bank: 'ptl_pistol.awc', streamId: 0x0aa87351 },
      { role: 'report', pack: 'weapons_player', bank: 'ptl_pistol.awc', streamId: 0x16ef0ea5 }
    ])
    expect(weaponParts(index, pistol.variants[1])).toEqual([{ role: 'fire', pack: 'resident', bank: 'weapons.awc', streamId: 0x16ef0ea5 }])
    // the SMG's bank isn't in the game files
    expect(weaponParts(index, smg.variants[0])).toEqual([])
  })

  it('tells your gun from what others hear', () => {
    expect(variantAudience(index, pistol.variants[0])).toBe('player')
    expect(variantAudience(index, pistol.variants[1])).toBe('others')
    const a = audienceVariants(index, pistol)
    expect(a.player).toBe(pistol.variants[0])
    expect(a.others).toBe(pistol.variants[1])
    expect(audienceVariants(index, smg).others).toBeUndefined()
  })
})
