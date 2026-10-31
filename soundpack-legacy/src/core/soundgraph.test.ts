import { describe, expect, it } from 'vitest'
import { joaat } from './hash'
import { envelopeAutomation, newPlanState, planFiring, planShot, repeatsItself, seededRng, shotRoles, type Voice } from './soundgraph'
import type { SoundNode, WeaponIndex } from './weapons'
import { fixtureIndex } from './weapons.fixture'

describe('planShot', () => {
  const index = fixtureIndex()
  const player = index.weapons[0].variants[0]

  it('layers the gunshot and report with the game data levels', () => {
    const voices = planShot(index, player, newPlanState(seededRng(1)))
    const fire = voices.filter((v) => v.role === 'fire')
    expect(fire).toHaveLength(2) // one random body + mechanics
    for (const v of fire) {
      expect(v.gainDb).toBeCloseTo(-1) // -100 mB on the multitrack
      expect(v.cents).toBe(50)
    }
    expect(fire.find((v) => v.file === 0x0aa87351)!.time).toBeCloseTo(0.01) // 10 ms predelay
    const report = voices.find((v) => v.role === 'report')!
    expect(report.gainDb).toBeCloseTo(-3) // ReportVolumeDelta
    expect(report.time).toBeCloseTo(0.02) // ReportPredelayDelta
    expect(report.lpfHz).toBe(8000)
    // the envelope maps its ADSHR level onto −100..0 dB: silent → full in 5 ms, down to 80% (−20 dB),
    // held, then released to silence
    const env = report.envelope!
    expect(env.target).toBe('volume')
    expect(env.values[0]).toBe(-100)
    expect(env.values[env.times.findIndex((t) => t >= 0.005)]).toBeCloseTo(0)
    expect(env.values[env.values.length - 1]).toBeCloseTo(-100)
    expect(env.times[env.times.length - 1]).toBeCloseTo(0.455)
  })

  it('picks random variations by weight and never repeats the last one', () => {
    const state = newPlanState(seededRng(42))
    const picks: number[] = []
    for (let i = 0; i < 400; i++) {
      const v = planShot(index, player, state, { roles: ['fire'] }).find((x) => x.file !== 0x0aa87351)!
      picks.push(v.file)
    }
    for (let i = 1; i < picks.length; i++) expect(picks[i]).not.toBe(picks[i - 1])
    const b = picks.filter((f) => f === 0x02032920).length
    expect(b).toBe(200) // alternation forced by the no-repeat rule
  })

  it('is reproducible with the same seed', () => {
    const a = planShot(index, player, newPlanState(seededRng(7)))
    const b = planShot(index, player, newPlanState(seededRng(7)))
    expect(a).toEqual(b)
  })

  it('spaces bursts at the fire rate', () => {
    const voices = planFiring(index, index.weapons[0], player, newPlanState(seededRng(3)), { shots: 3, roles: ['fire'] })
    const starts = voices.filter((v) => v.file === 0x0aa87351).map((v) => v.time)
    expect(starts.map((t) => Math.round(t * 1000))).toEqual([10, 160, 310])
  })

  it('resolves switches from variables, assuming 0 for game variables', () => {
    const idx = fixtureIndex()
    idx.nodes[String(joaat('switch'))] = {
      type: 'SwitchSound',
      header: {},
      children: [joaat('pistol_body_a'), joaat('pistol_body_b')],
      cond: { variable: joaat('game.var') }
    }
    const state = newPlanState(seededRng(1))
    const v = planShot(idx, { ...player, roles: { fire: joaat('switch') } }, state, { roles: ['fire'] })
    expect(v.map((x) => x.file)).toEqual([0x16ef0ea5])
    expect([...state.approximations]).toEqual(['a game variable the engine sets at runtime was assumed to be 0'])
    // a VariableBlockSound above sets it: no approximation
    idx.nodes[String(joaat('block'))] = {
      type: 'VariableBlockSound',
      header: {},
      children: [joaat('switch')],
      cond: { variables: [{ name: joaat('game.var'), value: 1, variance: 0, type: 2 }] }
    }
    const s2 = newPlanState(seededRng(1))
    expect(planShot(idx, { ...player, roles: { fire: joaat('block') } }, s2, { roles: ['fire'] }).map((x) => x.file)).toEqual([0x02032920])
    expect(s2.approximations.size).toBe(0)
  })

  it('applies variance and stereo collapse', () => {
    const idx = fixtureIndex()
    idx.nodes[String(joaat('stereo'))] = {
      type: 'CollapsingStereoSound',
      header: { volumeVariance: 300 },
      children: [joaat('pistol_body_a'), joaat('pistol_body_b')]
    }
    const v = planShot(idx, { ...player, roles: { fire: joaat('stereo') } }, newPlanState(seededRng(9)), { roles: ['fire'] })
    expect(v.map((x) => x.pan)).toEqual([-1, 1])
    expect(Math.abs(v[0].gainDb)).toBeLessThanOrEqual(3)
    expect(v[0].gainDb).toBe(v[1].gainDb)
  })
})

/** A fixture index plus extra nodes, with a player variant whose gunshot is `root`. */
function withNodes(nodes: Record<string, SoundNode>, extra: Partial<WeaponIndex> = {}): WeaponIndex {
  const idx = { ...fixtureIndex(), ...extra }
  for (const [k, n] of Object.entries(nodes)) idx.nodes[String(joaat(k))] = n
  return idx
}

const A = 0x16ef0ea5
const B = 0x02032920

function shot(idx: WeaponIndex, root: string, distance = 0, opts: { shots?: number } = {}): { voices: Voice[]; notes: string[] } {
  const state = newPlanState(seededRng(5))
  const player = idx.weapons[0].variants[0]
  const voices = planShot(idx, { ...player, roles: { fire: joaat(root) } }, state, {
    roles: ['fire'],
    listener: { distance, environment: 'outdoor' },
    shots: opts.shots,
    shotGapMs: 100
  })
  return { voices, notes: [...state.approximations] }
}

describe('planShot with distance and game data', () => {
  const xf = (mode: number): SoundNode => ({
    type: 'CrossfadeSound',
    header: {},
    children: [joaat('pistol_body_a'), joaat('pistol_body_b')],
    cond: { mode, minDistance: 20, maxDistance: 100 }
  })

  it('crossfades near and far by distance (linear and equal power)', () => {
    const idx = withNodes({ xlin: xf(1), xeq: xf(2), xnone: xf(0) })
    const gain = (v: Voice[], file: number): number | undefined => v.find((x) => x.file === file)?.gainDb
    expect(shot(idx, 'xlin', 10).voices.map((v) => v.file)).toEqual([A])
    // at 60 m both sides are at half, on top of the default roll-off (these test sounds have no distance curve)
    const rollOff = 20 * Math.log10(1 / 60)
    const mid = shot(idx, 'xlin', 60).voices
    expect(gain(mid, A)).toBeCloseTo(rollOff + 20 * Math.log10(0.5))
    expect(gain(mid, B)).toBeCloseTo(rollOff + 20 * Math.log10(0.5))
    expect(shot(idx, 'xlin', 150).voices.map((v) => v.file)).toEqual([B])
    const eq = shot(idx, 'xeq', 60).voices
    expect(gain(eq, A)).toBeCloseTo(rollOff + 20 * Math.log10(Math.SQRT1_2))
    expect(shot(idx, 'xnone', 99).voices.map((v) => v.file)).toEqual([A])
    expect(shot(idx, 'xnone', 101).voices.map((v) => v.file)).toEqual([B])
  })

  it('collapses stereo to mono beyond its max distance', () => {
    const st: SoundNode = {
      type: 'CollapsingStereoSound',
      header: {},
      children: [joaat('pistol_body_a'), joaat('pistol_body_b')],
      cond: { minDistance: 5, maxDistance: 25 }
    }
    const idx = withNodes({ st })
    expect(shot(idx, 'st', 2).voices.map((v) => v.pan)).toEqual([-1, 1])
    expect(shot(idx, 'st', 15).voices.map((v) => v.pan)).toEqual([-0.5, 0.5])
    expect(shot(idx, 'st', 40).voices.map((v) => Math.abs(v.pan))).toEqual([0, 0])
  })

  it('applies the mix category chain and the distance curve', () => {
    const idx = withNodes(
      {
        cat: {
          type: 'MultitrackSound',
          header: { category: joaat('child_cat'), volumeCurve: joaat('dist'), volumeCurveScale: 200 },
          children: [joaat('pistol_body_a')]
        }
      },
      {
        categories: {
          [joaat('parent_cat')]: {
            parent: null,
            volume: -300,
            pitch: 100,
            lpf: 23900,
            hpf: 0,
            lpfDistanceCurve: null,
            hpfDistanceCurve: null,
            distanceRollOffScale: 100,
            plateauRollOffScale: 100,
            parentOverrides: 0
          },
          [joaat('child_cat')]: {
            parent: joaat('parent_cat'),
            volume: 100,
            pitch: 0,
            lpf: 12000,
            hpf: 0,
            lpfDistanceCurve: null,
            hpfDistanceCurve: null,
            distanceRollOffScale: 100,
            plateauRollOffScale: 100,
            parentOverrides: 0
          }
        },
        curves: {
          [joaat('dist')]: {
            type: 'LinearCurve',
            minInput: 0,
            maxInput: 100,
            leftHandPairX: 0,
            leftHandPairY: 1,
            rightHandPairX: 100,
            rightHandPairY: 0
          }
        }
      }
    )
    const close = shot(idx, 'cat', 0)
    expect(close.voices[0].gainDb).toBeCloseTo(-2) // -300 + 100 mB
    expect(close.voices[0].cents).toBe(100)
    expect(close.voices[0].lpfHz).toBe(12000)
    expect(close.notes).toEqual([])
    // 100 m with a 2× curve scale reads the curve at 50 m: half volume
    expect(shot(idx, 'cat', 100).voices[0].gainDb).toBeCloseTo(-2 + 20 * Math.log10(0.5))
  })

  it('falls back to the default roll-off when a sound has no distance curve, and says so', () => {
    const r = shot(withNodes({}), 'pistol_player_fire', 10)
    expect(r.voices[0].gainDb).toBeCloseTo(-1 - 20)
    expect(r.notes).toContain("the engine's default distance roll-off")
  })

  it('repeats a retriggered sound for each shot of a burst, then plays its stop sound', () => {
    const idx = withNodes({
      auto: {
        type: 'RetriggeredOverlappedSound',
        header: {},
        children: [joaat('pistol_body_a'), joaat('pistol_body_b'), joaat('pistol_mech')],
        cond: { loopCount: -1, delay: 80 }
      }
    })
    const v = shot(idx, 'auto', 0, { shots: 3 }).voices
    expect(v.map((x) => [x.file, Math.round(x.time * 1000)])).toEqual([
      [A, 0],
      [B, 80],
      [B, 160],
      [0x0aa87351, 250]
    ])
  })

  it('shapes pitch with a pitch envelope', () => {
    const idx = fixtureIndex()
    const auto = envelopeAutomation(
      idx,
      { attack: 10, decay: 0, sustain: 100, hold: 50, release: 20, mode: 1, outputMin: -1200, outputMax: 0 },
      newPlanState()
    )
    expect(auto!.target).toBe('pitch')
    expect(auto!.values[0]).toBe(-1200)
    expect(auto!.values[8]).toBe(0)
  })
})

describe('shot parts by environment', () => {
  const idx = fixtureIndex()
  const player = { ...idx.weapons[0].variants[0], roles: { ...idx.weapons[0].variants[0].roles, interior: 1 } }
  it('uses the indoor shot indoors and no outdoor echo', () => {
    expect(shotRoles(player, 'outdoor')).toEqual(['fire', 'report', 'echo', 'shellCasing'])
    expect(shotRoles(player, 'interior')).toEqual(['interior', 'report', 'shellCasing'])
  })
})

describe('automatic guns', () => {
  /**
   * Shaped like the game's data: every player automatic gun has the same FireSound (generic layers in
   * RESIDENT), and its own shot in AutoSound, a retriggered sound with a start, a repeat and a tail.
   */
  const simple = (file: number, container = 'weapons_player/smg_smg'): SoundNode => ({
    type: 'SimpleSound',
    header: {},
    children: [],
    simple: { container: joaat(container), file }
  })
  const retriggered = (prefix: string, delay: number): SoundNode => ({
    type: 'RetriggeredOverlappedSound',
    header: {},
    children: [joaat(`${prefix}_start`), joaat(`${prefix}_shot`), joaat(`${prefix}_tail`)],
    cond: { loopCount: -1, delay }
  })
  const idx = withNodes({
    shared_fire: { type: 'WrapperSound', header: {}, children: [joaat('shared_layer')] },
    shared_layer: simple(0x1e0651de, 'resident/weapons'),
    silence: { type: 'WrapperSound', header: {}, children: [] },
    smg_auto: retriggered('smg', 75),
    smg_start: simple(0x0c64bf88),
    smg_shot: simple(0x06ef0ea5),
    smg_tail: simple(0x141616e8, 'resident/weapons'),
    rifle_auto: retriggered('rifle', 77),
    rifle_start: simple(0x11111111, 'weapons_player/ar_assaultrifle'),
    rifle_shot: simple(0x22222222, 'weapons_player/ar_assaultrifle'),
    rifle_tail: simple(0x33333333, 'weapons_player/ar_assaultrifle'),
    npc_auto: { type: 'RandomizedSound', header: {}, children: [joaat('npc_a'), joaat('npc_b')] },
    npc_a: simple(0x0aaaaaaa, 'resident/weapons'),
    npc_b: simple(0x0bbbbbbb, 'resident/weapons')
  })
  const base = idx.weapons[0].variants[0]
  const smg = { automatic: true, timeBetweenShots: 0.08 }
  const variant = (fire: string, auto: string) => ({ ...base, roles: { fire: joaat(fire), auto: joaat(auto) } })
  const fire = (weapon: typeof smg, v: ReturnType<typeof variant>, shots = 1) => {
    const state = newPlanState(seededRng(4))
    return { voices: planFiring(idx, weapon, v, state, { shots, roles: ['fire'] }), notes: [...state.approximations] }
  }

  it("plays the gun's own AutoSound for a single shot without adding the shared FireSound", () => {
    const { voices, notes } = fire(smg, variant('shared_fire', 'smg_auto'))
    expect(voices.map((v) => [v.role, v.file, Math.round(v.time * 1000)])).toEqual([
      ['auto', 0x0c64bf88, 0],
      ['auto', 0x141616e8, 75]
    ])
    expect(notes.some((n) => n.includes('FireSound'))).toBe(false)
  })

  it('sounds different for two guns that share their FireSound', () => {
    const files = (auto: string) => fire(smg, variant('shared_fire', auto)).voices.map((v) => v.file)
    expect(files('smg_auto')).not.toEqual(files('rifle_auto'))
  })

  it('keeps a retriggered AutoSound going for a burst at its own delay, the rest with every shot', () => {
    const v = {
      ...variant('shared_fire', 'smg_auto'),
      roles: { fire: joaat('shared_fire'), auto: joaat('smg_auto'), report: joaat('npc_auto') }
    }
    const voices = planFiring(idx, smg, v, newPlanState(seededRng(4)), { shots: 3, roles: ['fire', 'report'] })
    const auto = voices.filter((v) => v.role === 'auto').map((v) => [v.file, Math.round(v.time * 1000)])
    expect(auto).toEqual([
      [0x0c64bf88, 0],
      [0x06ef0ea5, 75],
      [0x06ef0ea5, 150],
      [0x141616e8, 225]
    ])
    // The variant's 20 ms report predelay is preserved for every shot.
    expect(voices.filter((v) => v.role === 'report').map((v) => Math.round(v.time * 1000))).toEqual([20, 100, 180])
    expect(voices.some((v) => v.role === 'fire')).toBe(false)
  })

  it('does not change an automatic shot when its unused FireSound changes', () => {
    for (const auto of ['smg_auto', 'rifle_auto', 'npc_auto']) {
      for (const shots of [1, 5]) {
        expect(fire(smg, variant('shared_fire', auto), shots).voices).toEqual(fire(smg, variant('silence', auto), shots).voices)
      }
    }
  })

  it('preserves the indoor shot alongside AutoSound and does not duplicate an explicitly selected AutoSound', () => {
    const v = {
      ...variant('shared_fire', 'smg_auto'),
      roles: { fire: joaat('shared_fire'), auto: joaat('smg_auto'), interior: joaat('npc_auto') }
    }
    const indoor = planFiring(idx, smg, v, newPlanState(seededRng(4)), { roles: ['interior'] })
    expect(indoor.filter((v) => v.role === 'auto')).toHaveLength(2)
    expect(indoor.filter((v) => v.role === 'interior')).toHaveLength(1)
    expect(indoor.some((v) => v.role === 'fire')).toBe(false)
    const explicit = planFiring(idx, smg, v, newPlanState(seededRng(4)), { roles: ['auto'] })
    expect(explicit).toHaveLength(2)
  })

  it('keeps FireSound as a fallback when there is no playable AutoSound', () => {
    for (const auto of ['silence', 'missing']) {
      const { voices } = fire(smg, variant('shared_fire', auto))
      expect(voices.map((v) => [v.role, v.file])).toEqual([['fire', 0x1e0651de]])
    }
  })

  it('triggers a one-shot AutoSound (NPC style) with every shot, and plays nothing for silence', () => {
    const { voices, notes } = fire(smg, variant('silence', 'npc_auto'), 3)
    expect(voices.map((v) => [v.role, Math.round(v.time * 1000)])).toEqual([
      ['auto', 0],
      ['auto', 80],
      ['auto', 160]
    ])
    expect(notes.some((n) => n.includes('FireSound'))).toBe(false)
  })

  it('ignores AutoSound on guns that are not automatic, and with a suppressor', () => {
    const single = { automatic: false, timeBetweenShots: 0.3 }
    expect(fire(single, variant('shared_fire', 'smg_auto')).voices.every((v) => v.role === 'fire')).toBe(true)
    const state = newPlanState(seededRng(4))
    const suppressed = { ...base, roles: { suppressed: joaat('shared_fire'), auto: joaat('smg_auto') } }
    expect(planFiring(idx, smg, suppressed, state, { roles: ['suppressed'] }).every((v) => v.role === 'suppressed')).toBe(true)
  })

  it('finds sounds that repeat themselves', () => {
    expect(repeatsItself(idx, joaat('smg_auto'))).toBe(true)
    expect(repeatsItself(idx, joaat('npc_auto'))).toBe(false)
    expect(repeatsItself(idx, undefined)).toBe(false)
  })
})
