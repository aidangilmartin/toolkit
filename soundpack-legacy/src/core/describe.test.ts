import { describe, expect, it } from 'vitest'
import { fileLabel, gunFiles, sameSoundsAs, sharingNote, shortStep } from './describe'
import { joaat } from './hash'
import type { SoundNode, Weapon } from './weapons'
import { fixtureIndex } from './weapons.fixture'

const h = (s: string): number => joaat(s)
const simple = (container: string, file: number): SoundNode => ({
  type: 'SimpleSound',
  header: {},
  children: [],
  simple: { container: h(container), file }
})

describe('gunFiles', () => {
  it('lists every file under its part with what it is and who hears it', () => {
    const index = fixtureIndex()
    const sections = gunFiles(index, index.weapons[0])
    expect(sections.map((s) => s.label)).toEqual(['Gunshot', 'Distant report'])
    const fire = sections[0]
    expect(fire.meaning).toMatch(/every time the gun fires/)
    expect(fire.files.map((f) => [f.text, f.heardBy])).toEqual([
      ['Layer 1 of 2, plays together with the others, variation 1 of 2 (25% of shots)', 'you'],
      ['Layer 1 of 2, plays together with the others, variation 2 of 2 (75% of shots)', 'you'],
      ['Layer 2 of 2, plays together with the others', 'you'],
      ['The whole gunshot', 'others']
    ])
    // the first body wave is also the report
    expect(fire.files[0].alsoRoles).toEqual(['report'])
    expect(sections[1].files[0]).toMatchObject({ text: 'The whole distant report', alsoRoles: ['fire'] })
    expect(fileLabel(fire.files[3])).toBe('weapons · 0x16EF0EA5')
  })

  it('marks files both variants use as heard by everyone', () => {
    const index = fixtureIndex()
    const pistol = index.weapons[0]
    pistol.variants[1] = { ...pistol.variants[1], category: 'npc', roles: { fire: h('pistol_player_fire') } }
    const fire = gunFiles(index, pistol)[0]
    expect(fire.files.map((f) => f.heardBy)).toEqual(['everyone', 'everyone', 'everyone'])
  })

  it('describes crossfades, stereo pairs, sound sets and conditions', () => {
    const index = fixtureIndex()
    Object.assign(index.nodes, {
      [h('echo')]: { type: 'CrossfadeSound', header: {}, children: [h('near'), h('far')], cond: { minDistance: 20, maxDistance: 80 } },
      [h('near')]: { type: 'CollapsingStereoSound', header: {}, children: [h('l'), h('r')] },
      [h('l')]: simple('weapons_player/ptl_pistol', 0x0aa87351),
      [h('r')]: simple('weapons_player/ptl_pistol', 0x02032920),
      [h('far')]: simple('resident/weapons', 0x16ef0ea5),
      [h('reload')]: { type: 'SoundSet', header: {}, children: [h('l')], cond: { entries: [h('mag_in')] } }
    })
    const v = index.weapons[0].variants[0]
    v.roles = { echo: h('echo'), reloadSounds: h('reload') }
    const sections = gunFiles(index, { ...index.weapons[0], variants: [v] }, { [h('mag_in')]: 'mag_in' })
    expect(sections.map((s) => s.label)).toEqual(['Echo / tail', 'Reload sounds'])
    expect(sections[0].files.map((f) => f.text)).toEqual([
      'Close range (20–80 m), left channel',
      'Close range (20–80 m), right channel',
      'Far away (20–80 m)'
    ])
    expect(sections[1].files[0].text).toBe('"mag_in" sound')
    expect(sections[1].files[0].alsoRoles).toEqual(['echo'])
  })
})

describe('gunFiles for automatic guns', () => {
  /** Two automatic guns shaped like the game's: one shared FireSound, each gun's own shot in AutoSound. */
  function autoIndex() {
    const index = fixtureIndex()
    Object.assign(index.containers, {
      [h('weapons_player/smg_smg')]: { pack: 'weapons_player', bank: 'smg_smg.awc' },
      [h('weapons_player/ar_assaultrifle')]: { pack: 'weapons_player', bank: 'ar_assaultrifle.awc' }
    })
    Object.assign(index.nodes, {
      [h('shared_fire')]: simple('resident/weapons', 0x1e0651de),
      [h('smg_auto')]: { type: 'RetriggeredOverlappedSound', header: {}, children: [h('smg_start'), h('smg_shot'), h('smg_tail')] },
      [h('smg_start')]: simple('weapons_player/smg_smg', 0x0c64bf88),
      [h('smg_shot')]: simple('weapons_player/smg_smg', 0x06ef0ea5),
      [h('smg_tail')]: simple('weapons_player/smg_smg', 0x141616e8),
      [h('rifle_auto')]: simple('weapons_player/ar_assaultrifle', 0x01111111)
    })
    const smg = index.weapons[1]
    smg.automatic = true
    smg.variants[0].roles = { fire: h('shared_fire'), auto: h('smg_auto') }
    index.weapons.push({
      ...smg,
      name: 'WEAPON_ASSAULTRIFLE',
      displayName: 'Assault Rifle',
      variants: [{ ...smg.variants[0], settings: h('rifle_player'), roles: { fire: h('shared_fire'), auto: h('rifle_auto') } }]
    })
    return { index, smg }
  }

  it("puts the gun's own rapid-fire shot first and marks the shared gunshot", () => {
    const { index, smg } = autoIndex()
    const sections = gunFiles(index, smg)
    expect(sections.map((s) => s.label)).toEqual(['Gunshot', 'Shared shot layer'])
    expect(sections[0].files.map((f) => f.text)).toEqual(['First shot', 'Each further shot (trigger held)', 'Tail when you let go'])
    expect(sections[0].files.every((f) => f.sharedWith.length === 0)).toBe(true)
    expect(sections[1].meaning).toMatch(/this gun and 1 other gun; changing it changes all of them/)
    expect(sections[1].files[0]).toMatchObject({
      text: 'The whole shared shot layer',
      sharedWith: [{ gun: 'Assault Rifle', parts: ['fire'] }]
    })
  })

  it('keeps the usual order for guns that are not automatic', () => {
    const { index, smg } = autoIndex()
    const sections = gunFiles(index, { ...smg, automatic: false })
    expect(sections.map((s) => s.label)).toEqual(['Gunshot', 'Rapid fire'])
  })
})

describe('which files other guns share', () => {
  /**
   * Shaped like the game's Pistol: its own body (also reused as the Combat MG's slow-mo shot), a
   * generic layer every pistol fires, a generic NPC sound, and a Mk II with exactly the same sounds.
   */
  function sharedIndex() {
    const index = fixtureIndex()
    index.containers[String(h('weapons_player/ptl_pistol'))] = { pack: 'weapons_player', bank: 'ptl_pistol.awc' }
    Object.assign(index.nodes, {
      [h('p_fire')]: { type: 'MultitrackSound', header: {}, children: [h('p_body'), h('generic_layer')] },
      [h('p_body')]: simple('weapons_player/ptl_pistol', 0x108fbf4a),
      [h('generic_layer')]: simple('resident/weapons', 0x00cfc264),
      [h('npc_pistols')]: simple('resident/weapons', 0x1e5a3aed),
      [h('combat_fire')]: simple('resident/weapons', 0x00cfc264)
    })
    const variant = (settings: string, category: string, roles: Record<string, number>) => ({
      category,
      settings: h(settings),
      roles,
      reportVolumeDelta: 0,
      reportPredelayDelta: 0,
      tailEnergy: 0
    })
    const gun = (name: string, displayName: string, variants: Weapon['variants']): Weapon => ({
      name,
      displayName,
      group: 'GROUP_PISTOL',
      audio: `AUDIO_ITEM_${name}`,
      timeBetweenShots: 0.15,
      fireType: 'INSTANT_HIT',
      variants
    })
    const pistolVariants = [
      variant('w_ptl_pistol_player', 'player', { fire: h('p_fire') }),
      variant('w_ptl_pistol_npc', 'npc', { fire: h('npc_pistols') })
    ]
    index.weapons = [
      gun('WEAPON_PISTOL', 'Pistol', pistolVariants),
      gun('WEAPON_PISTOL_MK2', 'Pistol Mk II', pistolVariants),
      gun('WEAPON_COMBATPISTOL', 'Combat Pistol', [
        variant('w_ptl_combat_player', 'player', { fire: h('combat_fire') }),
        variant('w_ptl_combat_npc', 'npc', { fire: h('npc_pistols') })
      ]),
      gun('WEAPON_COMBATMG', 'Combat MG', [variant('w_lmg_combat_player', 'player', { slowMoFireSound: h('p_body') })])
    ]
    return index
  }

  it("names each other gun and the parts it uses a file in, and lists the gun's own files first", () => {
    const index = sharedIndex()
    const [gunshot] = gunFiles(index, index.weapons[0])
    expect(gunshot.files.map((f) => [f.streamId, f.heardBy, sharingNote(f)?.text ?? null])).toEqual([
      [0x108fbf4a, 'you', "also Combat MG's slow-mo gunshot"],
      [0x00cfc264, 'you', 'shared with Combat Pistol'],
      [0x1e5a3aed, 'others', 'shared with Combat Pistol']
    ])
    expect(sharingNote(gunshot.files[1])!.title).toBe('Combat Pistol: gunshot')
    // the Mk II has exactly the same sounds: named once in the header, not on every file
    expect(sameSoundsAs(index, index.weapons[0]).map((w) => w.name)).toEqual(['WEAPON_PISTOL_MK2'])
    expect(gunshot.files.every((f) => f.sharedWith.every((s) => s.gun !== 'Pistol Mk II'))).toBe(true)
    expect(
      sharingNote({
        sharedWith: [
          { gun: 'A', parts: ['fire'] },
          { gun: 'B', parts: ['echo'] }
        ]
      })!.text
    ).toBe('shared with 2 other guns')
    expect(sharingNote({ sharedWith: [] })).toBeNull()
  })
})

describe('shortStep', () => {
  const names = (n: Record<number, string>) => (x: number) => n[x] ?? null
  it('says what an If branch means, naming the variable when it is known', () => {
    const n: SoundNode = { type: 'IfSound', header: {}, children: [1, 2], cond: { variable: 7, conditionType: 2, value: 0.5 } }
    expect(shortStep(n, 0, names({ 7: 'game.slowmo' }))).toBe('When game.slowmo > 0.5')
    expect(shortStep(n, 1, names({ 7: 'game.slowmo' }))).toBe('Otherwise (not game.slowmo > 0.5)')
    expect(shortStep(n, 0, names({}))).toBe('When a game condition is met')
  })

  it('names repeating parts and leaves plain wrappers out', () => {
    const r: SoundNode = { type: 'RetriggeredOverlappedSound', header: {}, children: [1, 2, 3] }
    expect([0, 1, 2].map((i) => shortStep(r, i, () => null))).toEqual([
      'First shot',
      'Each further shot (trigger held)',
      'Tail when you let go'
    ])
    expect(shortStep({ type: 'EnvelopeSound', header: {}, children: [1] }, 0, () => null)).toBeNull()
  })
})
