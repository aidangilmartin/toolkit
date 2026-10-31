/**
 * Every file a gun uses, under the part of the shot it belongs to, with a short description of what
 * it is: "Variation 2 of 3 (40% of shots)", "Far away", "Left channel"… taken from the sound graph
 * between the weapon setting and the file.
 */

import { hex8 } from './hash'
import { WEAPON_FIELDS } from './fields'
import {
  orderedRoles,
  roleGroup,
  roleLabel,
  usesAutoSound,
  variantAudience,
  weaponLabel,
  weaponParts,
  type Role,
  type SoundNode,
  type Weapon,
  type WeaponIndex
} from './weapons'

export type HeardBy = 'you' | 'others' | 'everyone'

export interface GunFile {
  pack: string
  bank: string
  streamId: number
  /** What it is, e.g. "Variation 1 of 2 (25% of shots), left channel". */
  text: string
  heardBy: HeardBy
  /** Other parts of this gun that play the same file. */
  alsoRoles: Role[]
  /** Other guns that use the same file, and in which of their parts (changing it changes them too). Guns with exactly the same sounds are left out. */
  sharedWith: SharedUse[]
}

export interface SharedUse {
  gun: string
  parts: Role[]
}

export interface GunSection {
  role: Role
  label: string
  /** What the part does, in one sentence. */
  meaning: string
  inferred: boolean
  files: GunFile[]
}

const OPS = ['<', '≤', '>', '≥', '=', '≠']

/** A short phrase for the step from `n` to its child in `slot`, or null when the step doesn't change what plays. */
export function shortStep(n: SoundNode, slot: number, nameOf: (hash: number) => string | null): string | null {
  const count = n.children?.filter((c) => c !== 0).length ?? 0
  const c = n.cond ?? {}
  switch (n.type) {
    case 'RandomizedSound': {
      const w = n.weights ?? []
      const sum = w.reduce((a, b) => a + b, 0)
      const share = sum > 0 && w[slot] !== undefined ? ` (${Math.round((w[slot] / sum) * 100)}% of shots)` : ''
      return count > 1 ? `Variation ${slot + 1} of ${count}${share}` : null
    }
    case 'MultitrackSound':
      return count > 1 ? `Layer ${slot + 1} of ${count}, plays together with the others` : null
    case 'CrossfadeSound': {
      const range = c.maxDistance ? ` (${Math.round(c.minDistance ?? 0)}–${Math.round(c.maxDistance)} m)` : ''
      return slot === 0 ? `Close range${range}` : slot === 1 ? `Far away${range}` : null
    }
    case 'CollapsingStereoSound':
      return slot === 0 ? 'Left channel' : slot === 1 ? 'Right channel' : null
    case 'SoundSet': {
      const name = nameOf(c.entries?.[slot] ?? 0)
      return name ? `"${name}" sound` : `Sound ${slot + 1} of ${count} in the set`
    }
    case 'IfSound': {
      const name = nameOf(c.variable ?? 0)
      const cond = name ? `${name} ${OPS[c.conditionType ?? 4] ?? '='} ${c.value ?? 0}` : 'a game condition is met'
      return slot === 0 ? `When ${cond}` : name ? `Otherwise (not ${cond})` : 'When a game condition is not met'
    }
    case 'SwitchSound':
      return `Option ${slot + 1}, picked by the game`
    case 'SequentialSound':
      return count > 1 ? `Part ${slot + 1} of ${count}, in order` : null
    case 'SequentialOverlapSound':
      return count > 1 ? `Part ${slot + 1} of ${count}` : null
    case 'RetriggeredOverlappedSound':
      return ['First shot', 'Each further shot (trigger held)', 'Tail when you let go'][slot] ?? null
    case 'OnStopSound':
      return slot === 1 ? 'When the sound stops' : slot === 2 ? 'When it finishes' : null
    case 'WrapperSound':
      return slot === 1 ? 'Fallback' : null
    default:
      return null
  }
}

interface Leaf {
  container: number
  file: number
  steps: string[]
}

/** Every file under a sound with the phrases along its path (each path once, cycles and depth capped). */
function leafPaths(index: WeaponIndex, root: number, nameOf: (h: number) => string | null): Leaf[] {
  const out: Leaf[] = []
  const walk = (h: number, steps: string[], seen: Set<number>): void => {
    if (!h || seen.has(h) || seen.size > 32 || out.length > 256) return
    const n = index.nodes[String(h >>> 0)]
    if (!n) return
    if (n.simple) {
      out.push({ container: n.simple.container >>> 0, file: n.simple.file & 0x1fffffff, steps })
      return
    }
    const next = new Set(seen).add(h)
    ;(n.children ?? []).forEach((c, slot) => {
      const phrase = shortStep(n, slot, nameOf)
      walk(c, phrase ? [...steps, phrase] : steps, next)
    })
  }
  walk(root >>> 0, [], new Set())
  return out
}

const fileKey = (pack: string, bank: string, streamId: number): string => `${pack}/${bank}:${streamId}`

const gunsByFile = new WeakMap<WeaponIndex, Map<string, Map<string, Set<Role>>>>()

/** Which guns use each file and in which parts, across all variants (worked out once per index). */
function gunsUsing(index: WeaponIndex): Map<string, Map<string, Set<Role>>> {
  let map = gunsByFile.get(index)
  if (map) return map
  map = new Map()
  for (const w of index.weapons) {
    for (const v of w.variants) {
      for (const p of weaponParts(index, v)) {
        const k = fileKey(p.pack, p.bank, p.streamId)
        const guns = map.get(k) ?? new Map<string, Set<Role>>()
        map.set(k, guns)
        guns.set(w.name, (guns.get(w.name) ?? new Set()).add(p.role))
      }
    }
  }
  gunsByFile.set(index, map)
  return map
}

/** The gunshot and everything fired with it: rapid fire, report, echo, indoor and suppressed shots. */
export const isShotPart = (role: Role): boolean => roleGroup(role) === 'shooting'

/** Other guns that use a file in one of their shot parts (not just slow motion, handling…). */
export const shotSharing = (f: Pick<GunFile, 'sharedWith'>): SharedUse[] => f.sharedWith.filter((s) => s.parts.some(isShotPart))

/**
 * Other guns whose sounds are exactly this gun's (the same weapon audio settings, e.g. a Mk II that
 * reuses the original's): changing one always changes the others.
 */
export function sameSoundsAs(index: WeaponIndex, weapon: Weapon): Weapon[] {
  const sig = (w: Weapon): string => [...new Set(w.variants.map((v) => v.settings >>> 0))].sort().join(',')
  const mine = sig(weapon)
  return mine ? index.weapons.filter((w) => w.name !== weapon.name && sig(w) === mine) : []
}

/** A short note on which other guns a file belongs to, with every gun and part in `title`. */
export function sharingNote(f: Pick<GunFile, 'sharedWith'>): { text: string; title: string } | null {
  if (!f.sharedWith.length) return null
  const title = f.sharedWith.map((s) => `${s.gun}: ${s.parts.map((r) => roleLabel(r).toLowerCase()).join(', ')}`).join('\n')
  const shot = shotSharing(f)
  if (shot.length) return { text: shot.length === 1 ? `shared with ${shot[0].gun}` : `shared with ${shot.length} other guns`, title }
  const parts = [...new Set(f.sharedWith.flatMap((s) => s.parts.map((r) => roleLabel(r).toLowerCase())))].join(', ')
  return {
    text: f.sharedWith.length === 1 ? `also ${f.sharedWith[0].gun}'s ${parts}` : `also the ${parts} of ${f.sharedWith.length} other guns`,
    title
  }
}

const AUTO_GUNSHOT = "This gun's own shot: the first shot, a repeat for each further shot while the trigger is held, then a tail."

/** How a part reads for this gun: automatic guns keep their shot in AutoSound, and their FireSound is often shared. */
function sectionText(role: Role, automatic: boolean, files: GunFile[]): { label: string; meaning: string; inferred: boolean } {
  const info = WEAPON_FIELDS[role] ?? { meaning: '', inferred: true }
  if (automatic && role === 'auto') return { label: 'Gunshot', meaning: AUTO_GUNSHOT, inferred: false }
  if (automatic && role === 'fire') {
    const others = new Set(files.flatMap((f) => shotSharing(f).map((s) => s.gun)))
    const shared = files.length > 0 && files.every((f) => shotSharing(f).length > 0)
    return {
      label: shared ? 'Shared shot layer' : 'Shot layer',
      meaning:
        (shared
          ? `The same sound for this gun and ${others.size} other gun${others.size === 1 ? '' : 's'}; changing it changes all of them. `
          : '') + 'The full preview uses the gunshot above. Play this layer separately with its file play buttons.',
      inferred: true
    }
  }
  return { label: roleLabel(role), meaning: info.meaning, inferred: !!info.inferred }
}

/** Stands for "the whole <part>" until the part's name for this gun is known. */
const WHOLE = '\u0000whole'

const sentence = (parts: string[]): string =>
  parts.map((p, i) => (i === 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p.charAt(0).toLowerCase() + p.slice(1))).join(', ')

/**
 * The gun's files grouped by part (gunshot, distant report, echo, reload…), in display order, each
 * with what it is and who hears it. `names` resolves hashes (variable and sound set entry names).
 */
export function gunFiles(index: WeaponIndex, weapon: Weapon, names: Record<string, string> = {}): GunSection[] {
  const nameOf = (h: number): string | null => (h ? (names[String(h >>> 0)] ?? null) : null)
  const automatic = weapon.variants.some((v) => usesAutoSound(index, weapon, v))
  const users = gunsUsing(index)
  const labelOf = new Map(index.weapons.map((w) => [w.name, weaponLabel(w)]))
  const same = new Set(sameSoundsAs(index, weapon).map((w) => w.name))
  const sections = new Map<Role, Map<string, GunFile & { texts: Set<string>; audiences: Set<'you' | 'others'> }>>()
  const rolesOfFile = new Map<string, Set<Role>>()
  for (const v of weapon.variants) {
    const audience = variantAudience(index, v) === 'player' ? 'you' : 'others'
    for (const role of orderedRoles(Object.keys(v.roles))) {
      for (const leaf of leafPaths(index, v.roles[role], nameOf)) {
        const c = index.containers[String(leaf.container)]
        if (!c) continue
        const key = fileKey(c.pack, c.bank, leaf.file)
        rolesOfFile.set(key, (rolesOfFile.get(key) ?? new Set()).add(role))
        const files = sections.get(role) ?? new Map()
        sections.set(role, files)
        const f = files.get(key) ?? {
          pack: c.pack,
          bank: c.bank,
          streamId: leaf.file,
          text: '',
          heardBy: audience,
          alsoRoles: [],
          sharedWith: [],
          texts: new Set<string>(),
          audiences: new Set<'you' | 'others'>()
        }
        f.texts.add(leaf.steps.length ? sentence(leaf.steps) : WHOLE)
        f.audiences.add(audience)
        files.set(key, f)
      }
    }
  }
  const roles = orderedRoles(sections.keys())
  // an automatic gun's own shot is its rapid-fire sound: show it first
  if (automatic && roles.includes('auto')) roles.unshift(...roles.splice(roles.indexOf('auto'), 1))
  return roles.map((role) => {
    const files: GunFile[] = [...sections.get(role)!.entries()].map(([key, f]) => ({
      pack: f.pack,
      bank: f.bank,
      streamId: f.streamId,
      text: [...f.texts].join(' / '),
      heardBy: f.audiences.size > 1 ? 'everyone' : [...f.audiences][0],
      alsoRoles: [...(rolesOfFile.get(key) ?? [])].filter((r) => r !== role),
      sharedWith: [...(users.get(key) ?? new Map<string, Set<Role>>())]
        .filter(([n]) => n !== weapon.name && !same.has(n))
        .map(([n, parts]) => ({ gun: labelOf.get(n) ?? n, parts: orderedRoles(parts) }))
        .sort((a, b) => a.gun.localeCompare(b.gun))
    }))
    // this gun's own files first, then the ones other guns fire too
    files.sort((a, b) => Number(shotSharing(a).length > 0) - Number(shotSharing(b).length > 0))
    const text = sectionText(role, automatic, files)
    const whole = `The whole ${text.label.toLowerCase()}`
    return { role, ...text, files: files.map((f) => ({ ...f, text: f.text.replaceAll(WHOLE, whole) })) }
  })
}

/** "ptl_pistol · 0x16EF0EA5" */
export function fileLabel(f: Pick<GunFile, 'bank' | 'streamId'>): string {
  return `${f.bank.replace(/\.awc$/, '')} · 0x${hex8(f.streamId)}`
}
