import { joaat } from './hash'
import type { SoundNode, WeaponIndex } from './weapons'

/** A small weapon index shaped like the bridge's output (synthetic, for tests). */
export function fixtureIndex(): WeaponIndex {
  const h = (s: string): number => joaat(s)
  const nodes: Record<string, SoundNode> = {
    [h('pistol_player_fire')]: {
      type: 'MultitrackSound',
      header: { volume: -100, pitch: 50 },
      children: [h('pistol_body_rnd'), h('pistol_mech')]
    },
    [h('pistol_body_rnd')]: { type: 'RandomizedSound', header: {}, children: [h('pistol_body_a'), h('pistol_body_b')], weights: [1, 3] },
    [h('pistol_body_a')]: {
      type: 'SimpleSound',
      header: {},
      children: [],
      simple: { container: h('weapons_player/ptl_pistol'), file: 0x16ef0ea5 }
    },
    [h('pistol_body_b')]: {
      type: 'SimpleSound',
      header: {},
      children: [],
      simple: { container: h('weapons_player/ptl_pistol'), file: 0x02032920 }
    },
    [h('pistol_mech')]: {
      type: 'SimpleSound',
      header: { preDelay: 10 },
      children: [],
      simple: { container: h('weapons_player/ptl_pistol'), file: 0x0aa87351 }
    },
    [h('pistol_report')]: {
      type: 'EnvelopeSound',
      header: { lpf: 8000 },
      children: [h('pistol_report_wave')],
      envelope: { attack: 5, decay: 50, sustain: 80, hold: 100, release: 300 }
    },
    [h('pistol_report_wave')]: {
      type: 'SimpleSound',
      header: {},
      children: [],
      simple: { container: h('weapons_player/ptl_pistol'), file: 0x16ef0ea5 }
    },
    [h('pistol_npc_fire')]: {
      type: 'SimpleSound',
      header: {},
      children: [],
      simple: { container: h('resident/weapons'), file: 0x16ef0ea5 }
    },
    [h('smg_player_fire')]: {
      type: 'SimpleSound',
      header: {},
      children: [],
      simple: { container: h('weapons_player/smg_smg'), file: 0x16ef0ea5 }
    }
  }
  return {
    version: 1,
    game: { gtaPath: '/games/gtav', exe: 'gta5.exe' },
    weapons: [
      {
        name: 'WEAPON_PISTOL',
        displayName: 'Pistol',
        group: 'GROUP_PISTOL',
        audio: 'AUDIO_ITEM_PISTOL',
        timeBetweenShots: 0.15,
        fireType: 'INSTANT_HIT',
        variants: [
          {
            category: 'player',
            settings: h('pistol_player'),
            roles: { fire: h('pistol_player_fire'), report: h('pistol_report') },
            reportVolumeDelta: -3,
            reportPredelayDelta: 20,
            tailEnergy: 1
          },
          {
            category: 'fallback',
            settings: h('pistol_npc'),
            roles: { fire: h('pistol_npc_fire') },
            reportVolumeDelta: 0,
            reportPredelayDelta: 0,
            tailEnergy: 0
          }
        ]
      },
      {
        name: 'WEAPON_SMG',
        displayName: null,
        group: 'GROUP_SMG',
        audio: 'AUDIO_ITEM_SMG',
        timeBetweenShots: 0.066,
        fireType: 'INSTANT_HIT',
        variants: [
          {
            category: 'fallback',
            settings: h('smg_player'),
            roles: { fire: h('smg_player_fire') },
            reportVolumeDelta: 0,
            reportPredelayDelta: 0,
            tailEnergy: 0
          }
        ]
      }
    ],
    nodes,
    containers: {
      [h('weapons_player/ptl_pistol')]: { pack: 'weapons_player', bank: 'ptl_pistol.awc' },
      [h('resident/weapons')]: { pack: 'resident', bank: 'weapons.awc' }
    },
    warnings: []
  }
}
