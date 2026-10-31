/**
 * The sound usage map the bridge builds from the game's audio data: every stream in every bank of
 * WEAPONS_PLAYER.rpf and RESIDENT.rpf, the sound graph above it, and what triggers each part of
 * that graph. This module walks the graph from a stream up to its triggers and puts each path into
 * words ("Your Pistol · Gunshot · 1 of 2 random variations (75%)").
 */

import { fieldInfo, FieldGroup, prettyType, ROLE_KEYS, roleKey } from './fields'
import { hex8 } from './hash'
import { prettyWeaponName, type NodeCond, type SoundNode } from './weapons'

export type { NodeCond }

export interface MapStream {
  id: number
  name?: string
  samples: number
  rate: number
  /** Streams that aren't plain waves: MIDI data or granular engine grains. */
  kind?: 'midi' | 'granular'
  /** Sounds that play this stream directly: [sound hash, slot] (slot -1 = whole wave). */
  leaves: [number, number][]
}

export interface MapBank {
  archive: string
  /** Multichannel (streamed) bank: listed, not editable. */
  mc?: boolean
  size?: number
  error?: string
  streams: MapStream[]
}

export interface MapNode extends SoundNode {
  /** [parent sound, slot of this sound in the parent] */
  parents?: [number, number][]
}

export type MapRoot =
  | { kind: 'game'; owner: number; field: string }
  | { kind: 'anim'; dict: string; clip: string; phase: number; tag: number; set?: number; entry?: number }

export interface MapOwner {
  type: string
  weapons?: { weapon: string; displayName?: string; category: string }[]
  usedBy?: [number, string][]
}

export interface SoundMap {
  version: number
  banks: Record<string, MapBank>
  nodes: Record<string, MapNode>
  consumers: Record<string, MapRoot[]>
  owners: Record<string, MapOwner>
  names: Record<string, string>
  animationTags?: number
  warnings: string[]
}

/** What starts a path: a game object field, an animation tag, a sound set entry or code/scripts. */
export type UseRoot = MapRoot | { kind: 'soundset'; set: number; entry: number } | { kind: 'code'; sound: number }

/** One step of a path, root first: the sound and which of its children the path continues to. */
export interface Step {
  node: number
  slot: number
}

export interface Use {
  root: UseRoot
  via: Step[]
}

export const MAX_USES = 64
const MAX_DEPTH = 32
const MAX_STEPS = 20000

export function mapNode(map: SoundMap, hash: number): MapNode | undefined {
  return map.nodes[String(hash >>> 0)]
}

export function mapStream(map: SoundMap, bankKey: string, id: number): MapStream | undefined {
  return map.banks[bankKey]?.streams.find((s) => s.id === id)
}

/**
 * Every way the game data can play a stream: each path from a sound that plays it up to whatever
 * triggers that path. Shared sound graphs can have very many paths; `more` says some were left out.
 */
export function streamUses(map: SoundMap, bankKey: string, id: number, limit = MAX_USES): { uses: Use[]; more: boolean } {
  const stream = mapStream(map, bankKey, id)
  const uses: Use[] = []
  let more = false
  if (!stream) return { uses, more }
  for (const [leaf, slot] of stream.leaves) {
    let steps = 0
    const path: Step[] = [{ node: leaf, slot }] // leaf first while walking up
    const onPath = new Set([leaf])
    const emit = (root: UseRoot): void => {
      if (uses.length >= limit) {
        more = true
        return
      }
      uses.push({ root, via: [...path].reverse() })
    }
    const visit = (node: number): void => {
      if (++steps > MAX_STEPS || uses.length >= limit) {
        more = true
        return
      }
      let rooted = false
      for (const c of map.consumers[String(node)] ?? []) {
        emit(c)
        rooted = true
      }
      for (const [parent, s] of mapNode(map, node)?.parents ?? []) {
        if (onPath.has(parent)) continue
        rooted = true
        if (path.length >= MAX_DEPTH) {
          more = true
          continue
        }
        path.push({ node: parent, slot: s })
        onPath.add(parent)
        visit(parent)
        onPath.delete(parent)
        path.pop()
      }
      if (rooted) return
      const n = mapNode(map, node)
      if (n?.type === 'SoundSet' && path.length > 1) {
        emit({ kind: 'soundset', set: node, entry: n.cond?.entries?.[path[path.length - 1].slot] ?? 0 })
      } else {
        emit({ kind: 'code', sound: node })
      }
    }
    visit(leaf)
  }
  return { uses, more }
}

export function nameOf(map: SoundMap, hash: number | undefined): string {
  if (!hash) return '—'
  return map.names[String(hash >>> 0)] ?? `0x${hex8(hash)}`
}

export type Audience = 'you' | 'others' | 'code' | 'anim' | 'other'

export interface PathStep {
  type: string
  hash: number
  name: string
  /** What this step means for the stream, e.g. "1 of 2 random variations (75%)". */
  note: string | null
  /** The raw settings behind the note. */
  detail: string | null
}

export interface UseDescription {
  audience: Audience
  /** Who/what triggers it: "Pistol", "Explosion explosion_grenade", "Game code or a script". */
  who: string
  /** The kind of trigger, for grouping: "Explosion", "Animation", "Code or script" (weapons: their names). */
  source: string
  /** What part it is: "Gunshot", "Reload sounds · entry reload". */
  what: string
  meaning: string
  inferred: boolean
  group: FieldGroup | null
  weapons: { weapon: string; label: string; category: string }[]
  /** Conditions along the path, most specific last. */
  when: string[]
  path: PathStep[]
  summary: string
}

const pct = (x: number): string => `${Math.round(x * 100)}%`
const m = (x: number | undefined): string => `${Math.round((x ?? 0) * 10) / 10} m`

/** What a step through `node` towards its child in `slot` means. */
function stepNote(map: SoundMap, node: MapNode, slot: number, last: boolean): { note: string | null; detail: string | null } {
  const c = node.cond ?? {}
  const n = node.children?.length ?? 0
  const v = (h?: number): string => nameOf(map, h)
  switch (node.type) {
    case 'MultitrackSound':
      return { note: n > 1 ? `layer ${slot + 1} of ${n}, played together` : null, detail: null }
    case 'RandomizedSound': {
      const w = node.weights ?? []
      const sum = w.reduce((a, b) => a + b, 0)
      const share = sum > 0 && w[slot] !== undefined ? ` (${pct(w[slot] / sum)} of the time)` : ''
      return { note: `random pick ${slot + 1} of ${n}${share}`, detail: w.length ? `weights ${w.join(', ')}` : null }
    }
    case 'CrossfadeSound': {
      const vars = c.distanceVariable ? `, distance from ${v(c.distanceVariable)}` : ''
      const detail = `crossfade ${m(c.minDistance)}–${m(c.maxDistance)} (mode ${c.mode ?? 0}${vars})`
      const ranged = (c.maxDistance ?? 0) > 0
      if (slot === 0)
        return {
          note: ranged ? `close range (fades out between ${m(c.minDistance)} and ${m(c.maxDistance)})` : 'near side of a crossfade',
          detail
        }
      if (slot === 1)
        return {
          note: ranged ? `at a distance (fades in between ${m(c.minDistance)} and ${m(c.maxDistance)})` : 'far side of a crossfade',
          detail
        }
      return { note: null, detail }
    }
    case 'CollapsingStereoSound': {
      const detail = `stereo collapses to mono ${m(c.minDistance)}–${m(c.maxDistance)}`
      return { note: slot === 0 ? 'left channel' : slot === 1 ? 'right channel' : null, detail }
    }
    case 'IfSound': {
      const detail = `if ${v(c.variable)} (test ${c.conditionType ?? 0}) ${c.value ?? 0}`
      return {
        note: slot === 0 ? `when ${v(c.variable)} passes its check against ${c.value ?? 0}` : `when ${v(c.variable)} fails its check`,
        detail
      }
    }
    case 'SwitchSound':
      return { note: `when ${v(c.variable)} is ${slot}`, detail: `switch on ${v(c.variable)}` }
    case 'SequentialSound':
      return { note: n > 1 ? `part ${slot + 1} of ${n}, played in order` : null, detail: null }
    case 'SequentialOverlapSound':
      return { note: n > 1 ? `part ${slot + 1} of ${n}, overlapping` : null, detail: c.delay ? `${c.delay} ms apart` : null }
    case 'RetriggeredOverlappedSound': {
      const detail = `repeats ${c.loopCount ?? 0}× every ${c.delay ?? 0} ms`
      return {
        note:
          slot === 0 ? 'start of a repeating sound' : slot === 1 ? 'the repeating part' : slot === 2 ? 'end of a repeating sound' : null,
        detail
      }
    }
    case 'OnStopSound':
      return { note: slot === 1 ? 'plays when the sound is stopped' : slot === 2 ? 'plays when the sound finishes' : null, detail: null }
    case 'WrapperSound':
      return { note: slot === 1 ? 'fallback when the main sound is missing' : null, detail: null }
    case 'LoopingSound':
      return { note: 'looped', detail: c.loopCount ? `${c.loopCount}× (±${c.loopCountVariance ?? 0})` : null }
    case 'TwinLoopSound':
      return { note: `alternating loop ${slot + 1}`, detail: null }
    case 'EnvelopeSound':
      return {
        note: null,
        detail: node.envelope
          ? `envelope A${node.envelope.attack} D${node.envelope.decay} S${node.envelope.sustain} R${node.envelope.release}`
          : null
      }
    case 'DirectionalSound':
      return { note: 'louder in front of the source', detail: `cone ${c.innerAngle ?? 0}°/${c.outerAngle ?? 0}°` }
    case 'VariableBlockSound':
      return {
        note: null,
        detail: (c.variables ?? []).map((x) => `${v(x.name)}=${x.value}`).join(', ') || null
      }
    case 'SoundSet':
      return { note: `sound set entry "${v(c.entries?.[slot])}"`, detail: null }
    case 'GranularSound':
      return last ? { note: `granular channel ${slot + 1}`, detail: null } : { note: null, detail: null }
    case 'AutomationSound':
      return last ? { note: 'MIDI data driving a note map', detail: null } : { note: null, detail: null }
    case 'StreamingSound':
      return { note: 'streamed', detail: null }
    default:
      return { note: null, detail: null }
  }
}

/** Puts a use into words. `pack` is the wave pack of the stream (weapons_player or resident). */
export function describeUse(map: SoundMap, use: Use, pack: string): UseDescription {
  const path: PathStep[] = use.via.map((s, i) => {
    const node = mapNode(map, s.node)
    const { note, detail } = node ? stepNote(map, node, s.slot, i === use.via.length - 1) : { note: null, detail: null }
    return { type: node?.type ?? 'Missing', hash: s.node, name: nameOf(map, s.node), note, detail }
  })
  const r = use.root
  // a sound set root already names its entry in `what`
  const when = path
    .filter((_, i) => !(i === 0 && r.kind === 'soundset'))
    .map((p) => p.note)
    .filter((x): x is string => !!x)
  let audience: Audience = 'other'
  let who = ''
  let source = ''
  let what = ''
  let meaning = ''
  let inferred = false
  let group: FieldGroup | null = null
  let weapons: UseDescription['weapons'] = []
  switch (r.kind) {
    case 'game': {
      const owner = map.owners[String(r.owner)]
      const type = owner?.type ?? 'Missing'
      const info = fieldInfo(type, r.field)
      what = info.label
      meaning = info.meaning
      inferred = !!info.inferred
      group = info.group
      if (type === 'WeaponSettings' && owner?.weapons?.length) {
        weapons = owner.weapons.map((w) => ({
          weapon: w.weapon,
          label: w.displayName && !/^(NULL|)$/i.test(w.displayName) ? w.displayName : prettyWeaponName(w.weapon),
          category: w.category
        }))
        const labels = [...new Set(weapons.map((w) => w.label))]
        who = labels.length > 3 ? `${labels.slice(0, 3).join(', ')} +${labels.length - 3}` : labels.join(', ')
        source = who
        const cats = new Set(weapons.map((w) => w.category))
        audience = cats.has('player') ? 'you' : cats.has('npc') ? 'others' : pack === 'weapons_player' ? 'you' : 'others'
      } else if (type === 'WeaponSettings') {
        who = `Weapon setting ${nameOf(map, r.owner)}`
        source = 'Weapon setting'
        audience = pack === 'weapons_player' ? 'you' : 'others'
      } else {
        who = `${prettyType(type)} ${nameOf(map, r.owner)}`
        source = prettyType(type)
      }
      break
    }
    case 'anim':
      audience = 'anim'
      who = `Animation ${r.dict} / ${r.clip}`
      source = 'Animation'
      what = `${nameOf(map, r.tag)} tag at ${pct(r.phase)} of the clip${r.entry ? ` · entry "${nameOf(map, r.entry)}"` : ''}`
      meaning = 'The animation plays this sound when it reaches the tag.'
      break
    case 'soundset':
      audience = 'code'
      who = `Sound set ${nameOf(map, r.set)}`
      source = 'Code or script'
      what = `entry "${nameOf(map, r.entry)}"`
      meaning = 'Game code or a script plays this entry by its set and entry name.'
      break
    case 'code':
      audience = 'code'
      who = 'Game code or a script'
      source = 'Code or script'
      what = `plays ${nameOf(map, r.sound)}`
      meaning = 'Nothing in the game data refers to this sound, so the game code or a script plays it by name.'
      break
  }
  const audienceWord = audience === 'you' ? 'Your ' : audience === 'others' && weapons.length ? 'Others hear ' : ''
  const summary = [`${audienceWord}${who}`.trim(), what, ...when].filter(Boolean).join(' · ')
  return { audience, who, source, what, meaning, inferred, group, weapons, when, path, summary }
}

export interface StreamUsage {
  stream: MapStream | undefined
  uses: Use[]
  descriptions: UseDescription[]
  more: boolean
  status: 'used' | 'code' | 'unused' | 'unknown'
}

/** Everything known about one stream. */
export function streamUsage(map: SoundMap, pack: string, bank: string, id: number, limit = MAX_USES): StreamUsage {
  const key = `${pack}/${bank}`.toLowerCase()
  const stream = mapStream(map, key, id)
  const found = streamUses(map, key, id, limit)
  // most telling first: your gun, others, animations, other objects, code; then shot parts before handling…
  const sorted = found.uses
    .map((u, i) => {
      const d = describeUse(map, u, pack.toLowerCase())
      return { u, d, i, rank: AUDIENCE_RANK[d.audience] * 1000 + fieldRank(u.root) }
    })
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
  const uses = sorted.map((x) => x.u)
  const descriptions = sorted.map((x) => x.d)
  const more = found.more
  const status = !stream ? 'unknown' : uses.length === 0 ? 'unused' : descriptions.every((d) => d.audience === 'code') ? 'code' : 'used'
  return { stream, uses, descriptions, more, status }
}

const AUDIENCE_RANK: Record<Audience, number> = { you: 0, others: 1, anim: 2, other: 3, code: 4 }

function fieldRank(root: UseRoot): number {
  if (root.kind !== 'game') return 999
  const i = ROLE_KEYS.indexOf(roleKey(root.field))
  return i < 0 ? 998 : i
}

/** One line for lists: the most telling use (uses are sorted that way), plus how many more there are. */
export function streamSummary(usage: StreamUsage): string {
  if (usage.status === 'unknown') return ''
  if (usage.status === 'unused') return 'Unused: no sound in the game data plays it'
  const best = usage.descriptions[0]
  const extra = usage.descriptions.length - 1 + (usage.more ? 1 : 0)
  return `${best.summary}${extra > 0 ? ` (+${extra}${usage.more ? '+' : ''})` : ''}`
}

/** Text to search a stream by: everything the uses say about it. */
export function usageText(usage: StreamUsage): string {
  return [usage.status, ...usage.descriptions.map((d) => `${d.summary} ${d.meaning} ${d.weapons.map((w) => w.weapon).join(' ')}`)]
    .join(' ')
    .toLowerCase()
}

export interface BankSummary {
  archive: string
  label: string
  detail: string
  weapons: string[]
  streams: number
  unused: number
}

/** What a bank holds, from its streams' uses (replaces guessed bank labels). */
export function bankSummary(map: SoundMap, key: string): BankSummary {
  const bank = map.banks[key]
  const [pack, file] = key.split('/')
  if (!bank) return { archive: '', label: file ?? key, detail: '', weapons: [], streams: 0, unused: 0 }
  const weapons = new Map<string, number>()
  const others = new Map<string, number>()
  let unused = 0
  for (const s of bank.streams) {
    const u = streamUsage(map, pack, file, s.id, 8)
    if (u.status === 'unused') unused++
    for (const d of u.descriptions) {
      if (d.weapons.length) for (const w of d.weapons) weapons.set(w.label, (weapons.get(w.label) ?? 0) + 1)
      else others.set(d.source, (others.get(d.source) ?? 0) + 1)
    }
  }
  const top = (mp: Map<string, number>): string[] => [...mp.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
  const w = top(weapons)
  const o = top(others)
  const label = w.length
    ? w.length > 2
      ? `${w.slice(0, 2).join(', ')} +${w.length - 2}`
      : w.join(', ')
    : o.length
      ? o.slice(0, 2).join(', ')
      : unused === bank.streams.length
        ? 'Unused'
        : file
  const detail = [
    `${bank.streams.length} sound${bank.streams.length === 1 ? '' : 's'}`,
    unused ? `${unused} unused` : '',
    bank.mc ? 'streamed (multichannel, not editable)' : '',
    bank.error ? `could not be read: ${bank.error}` : ''
  ]
    .filter(Boolean)
    .join(' · ')
  return { archive: bank.archive, label, detail, weapons: w, streams: bank.streams.length, unused }
}

/** Left/right stream pairs of a bank, from the game's stereo sounds (CollapsingStereoSound). */
export function stereoPairs(map: SoundMap, bankKey: string): { left: number; right: number }[] {
  const bank = map.banks[bankKey]
  if (!bank) return []
  const ids = new Set(bank.streams.map((s) => s.id))
  const out: { left: number; right: number }[] = []
  const seen = new Set<number>()
  for (const s of bank.streams) {
    for (const [leaf] of s.leaves) {
      const container = mapNode(map, leaf)?.simple?.container
      for (const [parent, slot] of mapNode(map, leaf)?.parents ?? []) {
        const p = mapNode(map, parent)
        if (p?.type !== 'CollapsingStereoSound' || slot !== 0) continue
        const right = mapNode(map, p.children?.[1] ?? 0)?.simple
        if (!right || right.container !== container || !ids.has(right.file) || right.file === s.id) continue
        if (seen.has(s.id) || seen.has(right.file)) continue
        seen.add(s.id)
        seen.add(right.file)
        out.push({ left: s.id, right: right.file })
      }
    }
  }
  return out
}
