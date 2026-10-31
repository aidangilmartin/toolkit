import { describe, expect, it } from 'vitest'
import { fieldInfo, prettyName, roleKey } from './fields'
import { bankSummary, describeUse, stereoPairs, streamSummary, streamUsage, streamUses, usageText } from './usage'
import { testMap } from './usage.fixture'

const PISTOL = 'weapons_player/ptl_pistol.awc'

describe('streamUses', () => {
  it('follows every path from a stream up to what triggers it', () => {
    const { uses, more } = streamUses(testMap, PISTOL, 0xa)
    expect(more).toBe(false)
    // via the gunshot, and via the gunshot inside the slow-motion If
    expect(uses.map((u) => u.root)).toEqual([
      { kind: 'game', owner: 100, field: 'FireSound' },
      { kind: 'game', owner: 100, field: 'SlowMoFireSound' }
    ])
    expect(uses[0].via).toEqual([
      { node: 1, slot: 0 },
      { node: 2, slot: 0 },
      { node: 4, slot: -1 }
    ])
    expect(uses[1].via.map((s) => s.node)).toEqual([10, 1, 2, 4])
  })

  it('finds every sound that plays a shared stream', () => {
    const fields = streamUses(testMap, PISTOL, 0xc).uses.map((u) => (u.root.kind === 'game' ? u.root.field : u.root.kind))
    expect(fields.sort()).toEqual(['EchoSound', 'FireSound', 'SlowMoFireSound', 'SlowMoFireSound'])
  })

  it('marks sound set entries and code-only sounds', () => {
    expect(streamUses(testMap, 'resident/weapons.awc', 0xd).uses[0].root).toEqual({ kind: 'soundset', set: 40, entry: 500 })
    expect(streamUses(testMap, 'resident/explosions.awc', 0xa).uses[0].root).toEqual({ kind: 'code', sound: 50 })
    expect(streamUses(testMap, 'resident/explosions.awc', 0xc).uses).toEqual([])
  })

  it('caps the number of uses', () => {
    const r = streamUses(testMap, PISTOL, 0xc, 2)
    expect(r.uses).toHaveLength(2)
    expect(r.more).toBe(true)
  })
})

describe('describeUse', () => {
  const describeFirst = (bank: string, id: number, i = 0) => {
    const [pack] = bank.split('/')
    return describeUse(testMap, streamUses(testMap, bank, id).uses[i], pack)
  }

  it('names the weapon, the part and the random share', () => {
    const d = describeFirst(PISTOL, 0xb)
    expect(d.audience).toBe('you')
    expect(d.who).toBe('Pistol')
    expect(d.what).toBe('Gunshot')
    expect(d.group).toBe('shooting')
    expect(d.when).toEqual(['layer 1 of 2, played together', 'random pick 2 of 2 (75% of the time)'])
    expect(d.summary).toBe('Your Pistol · Gunshot · layer 1 of 2, played together · random pick 2 of 2 (75% of the time)')
    expect(d.path.map((p) => p.type)).toEqual(['MultitrackSound', 'RandomizedSound', 'SimpleSound'])
  })

  it('explains crossfades, stereo pairs and If branches', () => {
    expect(describeFirst('resident/weapons.awc', 0xa).when).toEqual(['at a distance (fades in between 20 m and 80 m)'])
    const near = streamUses(testMap, PISTOL, 0xc).uses.find((u) => u.root.kind === 'game' && u.root.field === 'EchoSound')!
    expect(describeUse(testMap, near, 'weapons_player').when).toEqual(['close range (fades out between 20 m and 80 m)'])
    expect(describeFirst('resident/weapons.awc', 0xc).when).toEqual(['right channel'])
    expect(describeFirst('resident/weapons.awc', 0xb).what).toBe('Heft')
    const slowmo = describeFirst(PISTOL, 0xa, 1)
    expect(slowmo.what).toBe('Slow-mo gunshot')
    expect(slowmo.inferred).toBe(true)
    expect(slowmo.when[0]).toBe('when game.slowmo passes its check against 0.5')
  })

  it('describes animation, sound set and code triggers', () => {
    const anim = describeFirst('resident/explosions.awc', 0xb)
    expect(anim.audience).toBe('anim')
    expect(anim.who).toBe('Animation weapons@pistol / reload_pistol')
    expect(anim.what).toBe('audio tag at 40% of the clip')
    expect(describeFirst('resident/weapons.awc', 0xd).what).toBe('entry "beep"')
    expect(describeFirst('resident/explosions.awc', 0xa).who).toBe('Game code or a script')
  })
})

describe('summaries', () => {
  it('summarises a stream and makes its uses searchable', () => {
    const u = streamUsage(testMap, 'weapons_player', 'ptl_pistol.awc', 0xc)
    expect(u.status).toBe('used')
    expect(streamSummary(u)).toMatch(/^Your Pistol · Gunshot · .* \(\+3\)$/)
    expect(usageText(u)).toContain('echo')
    expect(streamSummary(streamUsage(testMap, 'resident', 'explosions.awc', 0xc))).toMatch(/^Unused/)
    expect(streamUsage(testMap, 'resident', 'explosions.awc', 0xa).status).toBe('code')
  })

  it('summarises a bank by the weapons that use it', () => {
    expect(bankSummary(testMap, PISTOL)).toMatchObject({ label: 'Pistol', streams: 3, unused: 0 })
    const ex = bankSummary(testMap, 'resident/explosions.awc')
    expect(ex.unused).toBe(1)
    expect(ex.label).toBe('Code or script, Animation')
  })
})

describe('stereoPairs', () => {
  it("pairs the left and right streams of the game's stereo sounds", () => {
    expect(stereoPairs(testMap, 'resident/weapons.awc')).toEqual([{ left: 0xb, right: 0xc }])
    expect(stereoPairs(testMap, PISTOL)).toEqual([])
  })
})

describe('fields', () => {
  it('knows every weapon sound field and prettifies the rest', () => {
    expect(roleKey('FireSound')).toBe('fire')
    expect(roleKey('HeftSound')).toBe('heftSound')
    expect(fieldInfo('WeaponSettings', 'SuperSlowMoFireSoundPresuck').label).toBe('Super slow-mo gunshot lead-in')
    expect(fieldInfo('WeaponSettings', 'ReloadSounds').group).toBe('handling')
    expect(fieldInfo('ExplosionAudioSettings', 'ExplosionSound').label).toBe('Explosion')
    expect(fieldInfo('VehicleCollisionSettings', 'ScrapeSound').label).toBe('Scrape')
    expect(prettyName('Weapons[1].Weapon')).toBe('Weapons 1 weapon')
  })
})
