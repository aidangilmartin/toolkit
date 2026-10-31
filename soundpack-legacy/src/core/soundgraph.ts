import { curveIsExact, defaultDistanceAttenuation, evalCurve } from './curves'
import type { Curve, EnvelopeSettings, MixCategory, Role, SoundHeader, Weapon, WeaponIndex, WeaponVariant } from './weapons'
import { node, usesAutoSound } from './weapons'

/**
 * Turns the game's sound graph for one gunshot into concrete "voices" (which wave, when, how loud,
 * pitch, pan, filters, envelope), applying everything the game data defines: header values, mix
 * categories, distance curves, crossfades, stereo collapse, envelopes, repeats, constant variables.
 * What only the engine decides (reverb, echo placement, occlusion…) is recorded in
 * `PlanState.approximations` so the UI can say what isn't exact.
 */

/** Where you hear the shot from. */
export type Environment = 'outdoor' | 'interior' | 'tunnel'

export interface Listener {
  /** Metres between the gun and you (0 = your own gun). */
  distance: number
  environment: Environment
}

export const DEFAULT_LISTENER: Listener = { distance: 0, environment: 'outdoor' }

/** Envelope automation in the unit of its target: dB, cents, pan (-1..1) or Hz; times in seconds from the voice start. */
export interface EnvelopeAutomation {
  target: 'volume' | 'pitch' | 'pan' | 'lpf' | 'hpf'
  times: number[]
  values: number[]
}

export interface Voice {
  role: Role
  container: number
  file: number
  /** Seconds from the start of the shot. */
  time: number
  gainDb: number
  cents: number
  /** -1 (left) .. 1 (right) */
  pan: number
  lpfHz: number | null
  hpfHz: number | null
  startOffsetMs: number
  attackMs: number
  releaseMs: number
  envelope: EnvelopeAutomation | null
  /** 0..1 send into the environment reverb. */
  reverb: number
}

export type Rng = () => number

/** Small deterministic PRNG (mulberry32) so previews can be reproduced. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const NO_LPF = 23900
/** Below this a layer is inaudible and not rendered. */
const SILENT_DB = -80

interface Acc {
  timeMs: number
  gainDb: number
  cents: number
  pan: number | null
  /** 1 = full stereo, 0 = collapsed to mono (CollapsingStereoSound at a distance). */
  width: number
  lpf: number
  hpf: number
  startOffsetMs: number
  attackMs: number
  releaseMs: number
  envelope: EnvelopeSettings | null
  reverb: number
  /** The innermost header settings for distance and mixing. */
  category: number | null
  volumeCurve: number | null
  volumeCurveScale: number
  plateau: number
  /** Variables set by VariableBlockSounds above this point. */
  vars: Map<number, number>
}

export interface PlanState {
  rng: Rng
  /** Last pick per RandomizedSound, so the same variation doesn't play twice in a row. */
  lastPick: Map<number, number>
  /** What couldn't be reproduced exactly from the game data, in words. */
  approximations: Set<string>
}

export function newPlanState(rng: Rng = Math.random): PlanState {
  return { rng, lastPick: new Map(), approximations: new Set() }
}

const spread = (rng: Rng, v: number | undefined): number => (v ? (rng() * 2 - 1) * v : 0)
const toDb = (g: number): number => 20 * Math.log10(Math.max(1e-6, g))

function applyHeader(acc: Acc, h: SoundHeader | undefined, rng: Rng): Acc {
  if (!h) return acc
  const next = { ...acc }
  next.gainDb += ((h.volume ?? 0) + spread(rng, h.volumeVariance)) / 100
  next.cents += (h.pitch ?? 0) + spread(rng, h.pitchVariance)
  next.timeMs += (h.preDelay ?? 0) + (h.preDelayVariance ? rng() * h.preDelayVariance : 0)
  next.startOffsetMs += (h.startOffset ?? 0) + (h.startOffsetVariance ? rng() * h.startOffsetVariance : 0)
  // pan in degrees: 0 front, 90 right, 270 left (307 is the game's usual left, 53 its right)
  if (h.pan !== undefined && h.pan <= 360) {
    const deg = h.pan + spread(rng, h.panVariance)
    next.pan = Math.max(-1, Math.min(1, Math.sin((deg * Math.PI) / 180)))
  }
  if (h.lpf !== undefined && h.lpf > 0) next.lpf = Math.min(next.lpf, h.lpf + spread(rng, h.lpfVariance))
  if (h.hpf !== undefined) next.hpf = Math.max(next.hpf, h.hpf + spread(rng, h.hpfVariance))
  if (h.attack) next.attackMs = Math.max(next.attackMs, h.attack)
  if (h.release) next.releaseMs = Math.max(next.releaseMs, h.release)
  const sends = [h.smallReverb ?? 0, h.mediumReverb ?? 0, h.largeReverb ?? 0]
  if (sends.some((s) => s > 0)) next.reverb = Math.max(next.reverb, Math.min(1, Math.max(...sends) / 100))
  if (h.category) next.category = h.category
  if (h.volumeCurve) next.volumeCurve = h.volumeCurve
  if (h.volumeCurveScale !== undefined) next.volumeCurveScale = h.volumeCurveScale
  if (h.volumeCurvePlateau !== undefined) next.plateau = h.volumeCurvePlateau
  return next
}

function pickWeighted(state: PlanState, nodeHash: number, children: number[], weights: number[] | null | undefined): number {
  const w = children.map((_, i) => Math.max(0, weights?.[i] ?? 1))
  const last = state.lastPick.get(nodeHash)
  if (children.length > 1 && last !== undefined) w[last] = 0
  const total = w.reduce((a, b) => a + b, 0)
  let i = 0
  if (total > 0) {
    let r = state.rng() * total
    for (i = 0; i < w.length - 1; i++) {
      r -= w[i]
      if (r < 0) break
    }
  }
  state.lastPick.set(nodeHash, i)
  return i
}

/** IfSound condition types: <, <=, >, >=, ==, != */
function compare(type: number, a: number, b: number): boolean {
  switch (type) {
    case 0:
      return a < b
    case 1:
      return a <= b
    case 2:
      return a > b
    case 3:
      return a >= b
    case 4:
      return a === b
    case 5:
      return a !== b
    default:
      return a === b
  }
}

interface Ctx {
  index: WeaponIndex
  role: Role
  state: PlanState
  out: Voice[]
  listener: Listener
  /** Shots in a burst, for RetriggeredOverlappedSound (1 for a single shot). */
  shots: number
  shotGapMs: number
}

const curveOf = (index: WeaponIndex, hash: number | null | undefined): Curve | undefined =>
  hash ? index.curves?.[String(hash >>> 0)] : undefined

/** A variable's value: set by a VariableBlockSound above, otherwise the game's (assumed 0). */
function variable(ctx: Ctx, acc: Acc, hash: number | undefined): number {
  if (!hash) return 0
  const v = acc.vars.get(hash >>> 0)
  if (v !== undefined) return v
  ctx.state.approximations.add('a game variable the engine sets at runtime was assumed to be 0')
  return 0
}

/** Gains of a crossfade's near and far sides at the listener's distance (mode 0 none, 1 linear, 2 equal power). */
function crossfadeGains(
  ctx: Ctx,
  n: { mode?: number; minDistance?: number; maxDistance?: number; crossfadeCurve?: number | null }
): [number, number] {
  const min = n.minDistance ?? 20
  const max = Math.max(min, n.maxDistance ?? 100)
  const d = ctx.listener.distance
  const t = max > min ? Math.max(0, Math.min(1, (d - min) / (max - min))) : d >= max ? 1 : 0
  const curve = curveOf(ctx.index, n.crossfadeCurve)
  if (curve) {
    if (!curveIsExact(curve)) ctx.state.approximations.add(`the ${curve.type} crossfade shape`)
    return [Math.max(0, evalCurve(curve, 1 - t)), Math.max(0, evalCurve(curve, t))]
  }
  switch (n.mode ?? 0) {
    case 1:
      return [1 - t, t]
    case 2:
      return [Math.cos((t * Math.PI) / 2), Math.sin((t * Math.PI) / 2)]
    default:
      // no crossfade: the near sound until max distance, then the far one
      return d < max ? [1, 0] : [0, 1]
  }
}

function walk(ctx: Ctx, hash: number, acc: Acc, depth: number): void {
  if (depth > 48 || !hash) return
  const n = node(ctx.index, hash)
  if (!n) return
  const a = applyHeader(acc, n.header, ctx.state.rng)
  const children = n.children ?? []
  const c = n.cond ?? {}
  const child = (i: number, next: Acc = a): void => {
    if (children[i]) walk(ctx, children[i], next, depth + 1)
  }
  switch (n.type) {
    case 'SimpleSound':
      if (n.simple) emit(ctx, a, n.simple.container, n.simple.file)
      return
    case 'MultitrackSound':
      children.forEach((_, i) => child(i))
      return
    case 'RandomizedSound':
      if (children.length) child(pickWeighted(ctx.state, hash, children, n.weights))
      return
    case 'EnvelopeSound':
      child(0, { ...a, envelope: n.envelope ?? a.envelope })
      return
    case 'CollapsingStereoSound': {
      // stereo up close, narrowing to mono between min and max distance
      const min = c.minDistance ?? 0
      const max = Math.max(min, c.maxDistance ?? 0)
      const d = ctx.listener.distance
      const width = max > min ? Math.max(0, Math.min(1, 1 - (d - min) / (max - min))) : d > max ? 0 : 1
      children.slice(0, 2).forEach((_, i) => child(i, { ...a, pan: (i === 0 ? -1 : 1) * width * a.width }))
      return
    }
    case 'CrossfadeSound': {
      if (c.distanceVariable || c.crossfadeVariable)
        ctx.state.approximations.add('a crossfade driven by a game variable (distance assumed)')
      const [near, far] = crossfadeGains(ctx, c)
      if (near > 0) child(0, { ...a, gainDb: a.gainDb + toDb(near) })
      if (far > 0) child(1, { ...a, gainDb: a.gainDb + toDb(far) })
      return
    }
    case 'IfSound': {
      const pass = compare(c.conditionType ?? 4, variable(ctx, a, c.variable), c.value ?? 0)
      child(pass ? 0 : 1)
      return
    }
    case 'SwitchSound': {
      const v = Math.round(variable(ctx, a, c.variable))
      child(Math.max(0, Math.min(children.length - 1, v)))
      return
    }
    case 'VariableBlockSound': {
      const vars = new Map(a.vars)
      for (const v of c.variables ?? []) vars.set(v.name >>> 0, v.value + spread(ctx.state.rng, v.variance))
      child(0, { ...a, vars })
      return
    }
    case 'RetriggeredOverlappedSound': {
      // start sound, the retrigger every DelayTime ms, then the stop sound (LoopCount includes start and stop)
      const delay = (c.delay ?? 0) > 0 ? c.delay! : ctx.shotGapMs
      const total = c.loopCount !== undefined && c.loopCount >= 0 ? Math.min(c.loopCount, ctx.shots) : ctx.shots
      child(0)
      for (let k = 1; k < total; k++) child(1, { ...a, timeMs: a.timeMs + k * delay + spread(ctx.state.rng, c.delayVariance) })
      child(2, { ...a, timeMs: a.timeMs + Math.max(1, total) * delay })
      return
    }
    case 'SequentialOverlapSound':
      children.forEach((_, i) => child(i, { ...a, timeMs: a.timeMs + i * (c.delay ?? 0) }))
      return
    case 'WrapperSound':
    case 'DirectionalSound':
    case 'KineticSound':
      // the main child; a directional sound faces the listener
      child(0)
      return
    case 'OnStopSound':
      if (children[1] || children[2]) ctx.state.approximations.add('a sound played when another stops')
      child(0)
      return
    default:
      ctx.state.approximations.add(`${n.type} (played its first part)`)
      child(0)
  }
}

/** The category and its parents, innermost first. */
function categoryChain(index: WeaponIndex, hash: number | null): MixCategory[] {
  const chain: MixCategory[] = []
  let h = hash
  while (h && chain.length < 32) {
    const cat = index.categories?.[String(h >>> 0)]
    if (!cat) break
    chain.push(cat)
    h = cat.parent
  }
  return chain
}

function emit(ctx: Ctx, a: Acc, container: number, file: number): void {
  const { index, listener, state } = ctx
  let gainDb = a.gainDb
  let cents = a.cents
  let lpf = a.lpf
  let hpf = a.hpf
  // mix categories: volume and pitch add up the chain, filters take the strictest
  const chain = categoryChain(index, a.category)
  let rollOff = 1
  for (const cat of chain) {
    gainDb += cat.volume / 100
    cents += cat.pitch
    if (cat.lpf > 0) lpf = Math.min(lpf, cat.lpf)
    if (cat.hpf > 0) hpf = Math.max(hpf, cat.hpf)
    rollOff *= (cat.distanceRollOffScale || 100) / 100
  }
  if (a.category && chain.length === 0) state.approximations.add('a mix category missing from the scan')
  // distance: the header's volume curve over distance ÷ (curve scale × category roll-off)
  const d = listener.distance
  if (d > 0) {
    const scaled = Math.max(0, d - a.plateau) / Math.max(0.01, ((a.volumeCurveScale || 100) / 100) * rollOff)
    const curve = curveOf(index, a.volumeCurve)
    if (curve) {
      if (!curveIsExact(curve)) state.approximations.add(`the ${curve.type} distance curve`)
      gainDb += toDb(Math.max(0, evalCurve(curve, scaled)))
    } else {
      state.approximations.add("the engine's default distance roll-off")
      gainDb += toDb(defaultDistanceAttenuation(scaled))
    }
    const lpfCurve = curveOf(index, chain.find((c) => c.lpfDistanceCurve)?.lpfDistanceCurve)
    if (lpfCurve) {
      state.approximations.add('the category distance filter scale')
      const y = evalCurve(lpfCurve, scaled)
      lpf = Math.min(lpf, y > 1 ? y : y * NO_LPF)
    }
  }
  if (gainDb < SILENT_DB) return
  ctx.out.push({
    role: ctx.role,
    container: container >>> 0,
    file: file & 0x1fffffff,
    time: Math.max(0, a.timeMs) / 1000,
    gainDb,
    cents,
    pan: a.pan ?? 0,
    lpfHz: lpf < NO_LPF ? lpf : null,
    hpfHz: hpf > 0 ? hpf : null,
    startOffsetMs: Math.max(0, a.startOffsetMs),
    attackMs: a.attackMs,
    releaseMs: a.releaseMs,
    envelope: a.envelope ? envelopeAutomation(index, a.envelope, state) : null,
    reverb: a.reverb
  })
}

const ENVELOPE_TARGETS: EnvelopeAutomation['target'][] = ['volume', 'pitch', 'pan', 'lpf', 'hpf']

/**
 * An envelope as automation points: ADSHR stages shaped by their curves (straight lines without
 * curves), mapped onto the output range (for volume, −100..0 dB by default).
 */
export function envelopeAutomation(index: WeaponIndex, e: EnvelopeSettings, state: PlanState): EnvelopeAutomation | null {
  const rng = state.rng
  const mode = e.mode ?? 0
  const target = mode === 6 ? 'lpf' : mode === 7 ? 'hpf' : ENVELOPE_TARGETS[mode]
  if (!target) {
    state.approximations.add('an envelope that drives a game variable')
    return null
  }
  const attack = Math.max(0, e.attack + spread(rng, e.attackVariance))
  const decay = Math.max(0, e.decay + spread(rng, e.decayVariance))
  const sustain = Math.max(0, Math.min(100, e.sustain + spread(rng, e.sustainVariance))) / 100
  const hold = e.hold < 0 ? -1 : Math.max(0, e.hold + spread(rng, e.holdVariance))
  const release = Math.max(0, e.release + spread(rng, e.releaseVariance))
  const hasRange = e.outputMin !== undefined && e.outputMax !== undefined && e.outputMin !== e.outputMax
  const outMin = hasRange ? e.outputMin! : target === 'volume' ? -100 : 0
  const outMax = hasRange ? e.outputMax! : 0
  const shape = (curve: number | null | undefined, t: number, rising: boolean): number => {
    const c = curveOf(index, curve)
    if (!c) return rising ? t : 1 - t
    if (!curveIsExact(c)) state.approximations.add(`the ${c.type} envelope shape`)
    return evalCurve(c, t)
  }
  const times: number[] = []
  const levels: number[] = []
  const push = (ms: number, level: number): void => {
    times.push(ms / 1000)
    levels.push(level)
  }
  const STEPS = 8
  for (let i = 0; i <= STEPS; i++) push((attack * i) / STEPS, attack > 0 ? shape(e.attackCurve, i / STEPS, true) : 1)
  for (let i = 1; i <= STEPS; i++) push(attack + (decay * i) / STEPS, sustain + (1 - sustain) * shape(e.decayCurve, i / STEPS, false))
  if (hold >= 0) {
    const start = attack + decay + hold
    push(start, sustain)
    for (let i = 1; i <= STEPS; i++) push(start + (release * i) / STEPS, sustain * shape(e.releaseCurve, i / STEPS, false))
  }
  const values = levels.map((l) => {
    const v = outMin + Math.max(0, Math.min(1, l)) * (outMax - outMin)
    return target === 'pan' ? Math.max(-1, Math.min(1, Math.sin((v * Math.PI) / 180))) : v
  })
  return { target, times, values }
}

export interface ShotOptions {
  /** Parts to include; default follows the environment (see `shotRoles`). */
  roles?: Role[]
  /** Fire time offset in seconds (for bursts). */
  at?: number
  listener?: Listener
  /** Shots in a burst for repeating sounds (AutoSound); 1 for a single shot. */
  shots?: number
  shotGapMs?: number
}

export const DEFAULT_SHOT_ROLES: Role[] = ['fire', 'report', 'echo', 'shellCasing']
export const SUPPRESSED_SHOT_ROLES: Role[] = ['suppressed', 'suppressedEcho', 'shellCasing']

/**
 * The parts of a shot for an environment: indoors the gun's InteriorShotSound replaces the shot and
 * there's no outdoor echo; EchoSound is the gun's echo for reflective places such as tunnels.
 */
export function shotRoles(variant: WeaponVariant, environment: Environment, suppressed = false): Role[] {
  const base = suppressed ? SUPPRESSED_SHOT_ROLES : DEFAULT_SHOT_ROLES
  if (environment !== 'interior') return base
  return base.filter((r) => r !== 'echo' && r !== 'suppressedEcho').map((r) => (r === 'fire' && variant.roles.interior ? 'interior' : r))
}

/** Casings land a moment after the shot; the game triggers them on physics impact. */
const SHELL_CASING_DELAY_MS = 450

function baseAcc(at: number): Acc {
  return {
    timeMs: at,
    gainDb: 0,
    cents: 0,
    pan: null,
    width: 1,
    lpf: NO_LPF,
    hpf: 0,
    startOffsetMs: 0,
    attackMs: 0,
    releaseMs: 0,
    envelope: null,
    reverb: 0,
    category: null,
    volumeCurve: null,
    volumeCurveScale: 100,
    plateau: 0,
    vars: new Map()
  }
}

export function planShot(index: WeaponIndex, variant: WeaponVariant, state: PlanState, opts: ShotOptions = {}): Voice[] {
  const out: Voice[] = []
  const listener = opts.listener ?? DEFAULT_LISTENER
  const at = (opts.at ?? 0) * 1000
  const roles = opts.roles ?? shotRoles(variant, listener.environment)
  for (const role of roles) {
    const root = variant.roles[role]
    if (!root) continue
    const acc = baseAcc(at)
    if (role === 'report') {
      // the weapon setting's report deltas: dB and ms against the shot
      acc.gainDb += variant.reportVolumeDelta || 0
      acc.timeMs += variant.reportPredelayDelta || 0
    }
    if (role === 'shellCasing') {
      acc.timeMs += SHELL_CASING_DELAY_MS * (0.8 + state.rng() * 0.4)
      state.approximations.add('when casings land (physics)')
    }
    const ctx: Ctx = { index, role, state, out, listener, shots: opts.shots ?? 1, shotGapMs: opts.shotGapMs ?? 100 }
    if ((role === 'echo' || role === 'suppressedEcho') && listener.environment === 'outdoor') {
      echoes(ctx, root, acc)
      continue
    }
    walk(ctx, root, acc, 0)
  }
  return out
}

/** Outdoors the echo repeats as the game's typical environment rule says (count, delay, attenuation). */
function echoes(ctx: Ctx, root: number, acc: Acc): void {
  const rule = ctx.index.environment?.outdoorEcho
  ctx.state.approximations.add('where echoes come from (the game places them off nearby surfaces)')
  if (!rule || rule.number <= 0) {
    walk(ctx, root, acc, 0)
    return
  }
  for (let k = 0; k < rule.number; k++) {
    const delay = rule.delay * (k + 1) + spread(ctx.state.rng, rule.delayVariance)
    walk(
      ctx,
      root,
      { ...acc, timeMs: acc.timeMs + delay, gainDb: acc.gainDb + rule.volume + k * rule.attenuation, pan: k % 2 ? 0.6 : -0.6 },
      0
    )
  }
}

/** Whether a sound keeps itself going for a whole burst (a RetriggeredOverlappedSound under it). */
export function repeatsItself(index: WeaponIndex, hash: number | undefined): boolean {
  const seen = new Set<number>()
  const find = (h: number, depth: number): boolean => {
    if (!h || seen.has(h) || depth > 48) return false
    seen.add(h)
    const n = node(index, h)
    if (!n) return false
    return n.type === 'RetriggeredOverlappedSound' || (n.children ?? []).some((c) => find(c >>> 0, depth + 1))
  }
  return find((hash ?? 0) >>> 0, 0)
}

export interface FiringOptions {
  /** Shots fired: 1 for a single shot. */
  shots?: number
  /** Shot parts; default follows the environment (see `shotRoles`). */
  roles?: Role[]
  listener?: Listener
}

/**
 * One shot or several at the weapon's fire rate. Every shot plays the shot parts (gunshot or indoor
 * shot, report, echo, casings). Automatic guns use their AutoSound in place of FireSound, even for
 * one shot. FireSound is often a shared layer; adding it on top assumes an undocumented engine
 * trigger and makes different guns sound alike. A part that repeats
 * itself (start, a retrigger at its own delay, a tail when firing stops) is started once for the
 * burst; anything else is triggered with each shot.
 */
export function planFiring(
  index: WeaponIndex,
  weapon: Pick<Weapon, 'automatic' | 'timeBetweenShots'>,
  variant: WeaponVariant,
  state: PlanState,
  opts: FiringOptions = {}
): Voice[] {
  const shots = Math.max(1, Math.round(opts.shots ?? 1))
  const listener = opts.listener ?? DEFAULT_LISTENER
  const gap = weapon.timeBetweenShots > 0 ? weapon.timeBetweenShots : 0.15
  let roles = [...(opts.roles ?? shotRoles(variant, listener.environment))]
  // a suppressor replaces both the single and the rapid-fire shot
  if (usesAutoSound(index, weapon, variant) && !roles.includes('suppressed')) {
    roles = ['auto', ...roles.filter((r) => r !== 'fire' && r !== 'auto')]
  }
  const once = roles.filter((r) => repeatsItself(index, variant.roles[r]))
  const each = roles.filter((r) => !once.includes(r))
  const voices: Voice[] = []
  if (once.length) voices.push(...planShot(index, variant, state, { roles: once, listener, shots, shotGapMs: gap * 1000 }))
  for (let i = 0; i < shots; i++) voices.push(...planShot(index, variant, state, { roles: each, at: i * gap, listener }))
  return voices
}
