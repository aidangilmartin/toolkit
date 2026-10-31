/**
 * Sound banks a gun pack usually replaces. File names come from published FiveM gun packs;
 * labels marked `certainty: 'guess'` are inferred and should be confirmed by listening.
 */

export type BankCategory = 'pistol' | 'smg' | 'rifle' | 'shotgun' | 'sniper' | 'mg' | 'heavy' | 'shared' | 'other'

export interface BankInfo {
  pack: string
  file: string
  label: string
  category: BankCategory
  certainty: 'name' | 'guess'
  note?: string
}

export const PACK_WEAPONS_PLAYER = 'weapons_player'
export const PACK_RESIDENT = 'resident'

/** Wave packs gun sound packs replace (WEAPONS_PLAYER.rpf and RESIDENT.rpf). */
export const KNOWN_PACKS = [PACK_WEAPONS_PLAYER, PACK_RESIDENT]

const wp = (file: string, label: string, category: BankCategory, certainty: 'name' | 'guess' = 'name'): BankInfo => ({
  pack: PACK_WEAPONS_PLAYER,
  file,
  label,
  category,
  certainty
})

export const CATALOG: BankInfo[] = [
  wp('ptl_pistol.awc', 'Pistol', 'pistol'),
  wp('ptl_combat.awc', 'Combat Pistol', 'pistol'),
  wp('ptl_50cal.awc', 'Pistol .50', 'pistol'),
  wp('ptl_px4.awc', 'AP Pistol', 'pistol', 'guess'),
  wp('ptl_rubber.awc', 'Less-lethal / rubber rounds', 'pistol', 'guess'),
  wp('smg_micro.awc', 'Micro SMG', 'smg'),
  wp('smg_smg.awc', 'SMG', 'smg'),
  wp('mgn_sml_am83_vera.awc', 'Assault rifle family (A)', 'rifle', 'guess'),
  wp('mgn_sml_am83_verb.awc', 'Assault rifle family (B)', 'rifle', 'guess'),
  wp('mgn_sml_sc__l.awc', 'Carbine family', 'rifle', 'guess'),
  wp('spl_prog_ar_player.awc', 'Advanced rifle', 'rifle', 'guess'),
  wp('sht_pump.awc', 'Pump Shotgun', 'shotgun'),
  wp('sht_bullpup.awc', 'Bullpup Shotgun', 'shotgun'),
  wp('snp_rifle.awc', 'Sniper Rifle', 'sniper'),
  wp('snp_heavy.awc', 'Heavy Sniper', 'sniper'),
  wp('lmg_combat.awc', 'Combat MG', 'mg'),
  wp('lmg_mg_player.awc', 'MG', 'mg'),
  wp('spl_minigun_player.awc', 'Minigun', 'heavy'),
  wp('spl_grenade_player.awc', 'Grenade Launcher', 'heavy'),
  wp('spl_rpg_player.awc', 'RPG', 'heavy'),
  wp('spl_railgun.awc', 'Railgun', 'heavy'),
  wp('spl_tank_player.awc', 'Tank cannon', 'heavy'),
  {
    pack: PACK_RESIDENT,
    file: 'weapons.awc',
    label: 'Shared weapon sounds',
    category: 'shared',
    certainty: 'name',
    note: 'Used for NPC and other players’ gunfire. Replace it too, or other players may still hear vanilla shots.'
  },
  { pack: PACK_RESIDENT, file: 'explosions.awc', label: 'Explosions', category: 'shared', certainty: 'name' }
]

export const CATEGORY_LABELS: Record<BankCategory, string> = {
  pistol: 'Pistols',
  smg: 'SMGs',
  rifle: 'Rifles',
  shotgun: 'Shotguns',
  sniper: 'Snipers',
  mg: 'Machine guns',
  heavy: 'Heavy',
  shared: 'Shared banks',
  other: 'Other'
}

export function normalizeFileName(file: string): string {
  const base = file.replace(/^.*[\\/]/, '').toLowerCase()
  return base.endsWith('.awc') ? base : `${base}.awc`
}

export function lookupBank(file: string, pack?: string): BankInfo | undefined {
  const f = normalizeFileName(file)
  return CATALOG.find((b) => b.file === f && (!pack || b.pack === pack))
}

/** Best guess of the wave pack folder a bank belongs to. */
export function guessPack(file: string): string {
  return lookupBank(file)?.pack ?? PACK_WEAPONS_PLAYER
}

export function isValidPackName(pack: string): boolean {
  return /^[a-z0-9_]+$/.test(pack)
}
