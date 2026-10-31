/**
 * What each sound field of the game's audio objects is for. Weapon settings (dat151 WeaponSettings)
 * have ~50 sound fields; the app uses short keys for the 8 shot parts it has always shown and the
 * field name in lowerCamel for the rest ("HeftSound" → "heftSound").
 *
 * `inferred` marks meanings taken from the field name: the data proves that the sound is wired to
 * that field, not exactly when the game plays it. The in-game ID pack settles those.
 */

export type FieldGroup = 'shooting' | 'casings' | 'handling' | 'melee' | 'slowmo' | 'other'

export const GROUP_ORDER_FIELDS: FieldGroup[] = ['shooting', 'casings', 'handling', 'melee', 'slowmo', 'other']

export const FIELD_GROUP_LABELS: Record<FieldGroup, string> = {
  shooting: 'Shooting',
  casings: 'Casings',
  handling: 'Handling',
  melee: 'Melee & impacts',
  slowmo: 'Slow motion',
  other: 'Other'
}

export interface FieldInfo {
  label: string
  group: FieldGroup
  meaning: string
  inferred?: boolean
}

/** WeaponSettings field names that keep the app's short role keys. */
export const SHORT_ROLES: Record<string, string> = {
  FireSound: 'fire',
  AutoSound: 'auto',
  SuppressedFireSound: 'suppressed',
  ReportSound: 'report',
  EchoSound: 'echo',
  SuppressedEchoSound: 'suppressedEcho',
  ShellCasingSound: 'shellCasing',
  InteriorShotSound: 'interior'
}

/** "FireSound" → "fire", "HeftSound" → "heftSound" (the keys the weapon index uses). */
export function roleKey(field: string): string {
  return SHORT_ROLES[field] ?? field.charAt(0).toLowerCase() + field.slice(1)
}

const base: Record<string, FieldInfo> = {
  fire: { label: 'Gunshot', group: 'shooting', meaning: 'Single shots: plays every time the gun fires.' },
  auto: {
    label: 'Rapid fire',
    group: 'shooting',
    meaning:
      'The shot of automatic guns (rifles, SMGs, MGs): plays from the first shot, repeats while the trigger is held and ends with a tail. Their gunshot (FireSound) is usually one sound shared by all of them.'
  },
  report: {
    label: 'Distant report',
    group: 'shooting',
    meaning: 'A loud layer fired with each shot that carries it into the distance; the gun sets its volume and delay against the shot.'
  },
  echo: { label: 'Echo / tail', group: 'shooting', meaning: 'The echo of the shot in reflective places such as tunnels.' },
  interior: { label: 'Indoor shot', group: 'shooting', meaning: 'The shot when firing indoors, softer than outside.' },
  suppressed: { label: 'Suppressed shot', group: 'shooting', meaning: 'The shot when a suppressor is fitted.' },
  suppressedEcho: { label: 'Suppressed echo', group: 'shooting', meaning: 'The echo of a suppressed shot.', inferred: true },
  shellCasing: { label: 'Shell casings', group: 'casings', meaning: 'Spent casings hitting the ground after a shot.' },

  heftSound: { label: 'Heft', group: 'handling', meaning: 'Handling noise when the weapon is raised or moved.', inferred: true },
  putDownSound: { label: 'Put down', group: 'handling', meaning: 'Putting the weapon down or away.', inferred: true },
  pickupSound: { label: 'Pick up', group: 'handling', meaning: 'Picking the weapon up.', inferred: true },
  rattleSound: { label: 'Rattle', group: 'handling', meaning: 'The weapon rattling while you move.', inferred: true },
  rattleLandSound: {
    label: 'Rattle on landing',
    group: 'handling',
    meaning: 'The weapon rattling when you land from a jump or fall.',
    inferred: true
  },
  rattleAimSound: {
    label: 'Rattle when aiming',
    group: 'handling',
    meaning: 'The weapon rattling as you raise it to aim.',
    inferred: true
  },
  intoCoverSound: { label: 'Into cover', group: 'handling', meaning: 'Weapon noise when you move into cover.', inferred: true },
  outOfCoverSound: { label: 'Out of cover', group: 'handling', meaning: 'Weapon noise when you leave cover.', inferred: true },
  safetyOn: { label: 'Safety on', group: 'handling', meaning: 'Switching the safety on.', inferred: true },
  safetyOff: { label: 'Safety off', group: 'handling', meaning: 'Switching the safety off.', inferred: true },
  reloadSounds: {
    label: 'Reload sounds',
    group: 'handling',
    meaning: 'A sound set of reload noises (magazine out/in, slide…); reload animations pick its entries by name.'
  },
  specialWeaponSoundSet: {
    label: 'Special sounds',
    group: 'handling',
    meaning: 'A sound set of extras specific to this weapon (spin-up, charge-up…).',
    inferred: true
  },
  bankSound: {
    label: 'Bank sound',
    group: 'other',
    meaning: 'Use unknown; community notes suggest the first-person shot.',
    inferred: true
  },

  swipeSound: { label: 'Melee swing', group: 'melee', meaning: 'Swinging the weapon in melee.', inferred: true },
  generalStrikeSound: { label: 'Melee hit (objects)', group: 'melee', meaning: 'Hitting something with the weapon.', inferred: true },
  pedStrikeSound: { label: 'Melee hit (people)', group: 'melee', meaning: 'Hitting a person with the weapon.', inferred: true },
  hitPedSound: { label: 'Hitting a person', group: 'melee', meaning: 'The impact when the weapon hits a person.', inferred: true },
  smallAnimalStrikeSound: { label: 'Melee hit (small animal)', group: 'melee', meaning: 'Hitting a small animal.', inferred: true },
  bigAnimalStrikeSound: { label: 'Melee hit (large animal)', group: 'melee', meaning: 'Hitting a large animal.', inferred: true }
}

// slow-motion versions: SlowMo<X>Sound / SlowMo<X>SoundPresuck and the SuperSlowMo equivalents
const slowBases: [string, string][] = [
  ['Fire', 'gunshot'],
  ['SuppressedFire', 'suppressed shot'],
  ['Report', 'distant report'],
  ['InteriorShot', 'indoor shot'],
  ['PedStrike', 'melee hit (people)'],
  ['BigAnimalStrike', 'melee hit (large animal)'],
  ['SmallAnimalStrike', 'melee hit (small animal)']
]
for (const [prefix, speed] of [
  ['slowMo', 'Slow-mo'],
  ['superSlowMo', 'Super slow-mo']
] as const) {
  for (const [field, what] of slowBases) {
    base[`${prefix}${field}Sound`] = {
      label: `${speed} ${what}`,
      group: 'slowmo',
      meaning: `The ${what} in ${speed.toLowerCase()} (special abilities, the Rockstar Editor).`,
      inferred: true
    }
    base[`${prefix}${field}SoundPresuck`] = {
      label: `${speed} ${what} lead-in`,
      group: 'slowmo',
      meaning: `The reverse "suck" heard just before a ${speed.toLowerCase()} ${what}.`,
      inferred: true
    }
  }
}

export const WEAPON_FIELDS: Record<string, FieldInfo> = base

/** The order weapon roles are listed in: by group, then as declared above. */
export const ROLE_KEYS: string[] = GROUP_ORDER_FIELDS.flatMap((g) => Object.keys(base).filter((k) => base[k].group === g))

/** "SlowMoExplosionPreSuckSound" → "Slow mo explosion pre suck". */
export function prettyName(name: string): string {
  const words = name
    .replace(/Sound(s)?$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\[(\d+)\]/g, ' $1')
    .replace(/\./g, ' ')
    .trim()
    .toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** "ExplosionAudioSettings" → "Explosion". */
export function prettyType(type: string): string {
  return prettyName(type.replace(/(Audio)?Settings$/, '').replace(/AudioSettings/, '')) || type
}

const other: Record<string, Record<string, FieldInfo>> = {
  ExplosionAudioSettings: {
    ExplosionSound: { label: 'Explosion', group: 'other', meaning: 'The blast of this explosion type.' },
    DebrisSound: { label: 'Explosion debris', group: 'other', meaning: 'Debris falling after the blast.', inferred: true },
    SlowMoExplosionSound: { label: 'Slow-mo explosion', group: 'slowmo', meaning: 'The blast in slow motion.', inferred: true },
    SlowMoExplosionPreSuckSound: {
      label: 'Slow-mo explosion lead-in',
      group: 'slowmo',
      meaning: 'The reverse "suck" before a slow-motion blast.',
      inferred: true
    }
  }
}

/** What a field of a game object is for. Unknown fields get a readable name and no meaning. */
export function fieldInfo(type: string, field: string): FieldInfo {
  if (type === 'WeaponSettings') {
    const f = WEAPON_FIELDS[roleKey(field)]
    if (f) return f
  }
  const known = other[type]?.[field]
  if (known) return known
  return { label: prettyName(field), group: 'other', meaning: '', inferred: true }
}
