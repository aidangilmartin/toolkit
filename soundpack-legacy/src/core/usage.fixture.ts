import type { SoundMap } from './usage'

/**
 * A small sound map in the bridge's format (not game data):
 * - weapons_player/ptl_pistol: 0xA, 0xB under a random pick inside the pistol's gunshot (a 2-layer
 *   multitrack); 0xC is the gunshot's 2nd layer, the near side of the echo crossfade and the
 *   false branch of the slow-motion If.
 * - resident/weapons: 0xA far side of the echo; 0xB/0xC the left/right of the heft stereo pair;
 *   0xD an entry of a sound set nothing refers to.
 * - resident/explosions: 0xA played by code only; 0xB by a reload animation tag; 0xC unused.
 */
export const C_PISTOL = 1001
export const C_WEAPONS = 1002
export const C_EXPLOSIONS = 1003

const simple = (container: number, file: number, parents: [number, number][]) => ({
  type: 'SimpleSound',
  header: {},
  children: [],
  simple: { container, file },
  parents
})

export const testMap: SoundMap = {
  version: 1,
  banks: {
    'weapons_player/ptl_pistol.awc': {
      archive: 'WEAPONS_PLAYER.rpf',
      size: 50000,
      streams: [
        { id: 0xa, samples: 100, rate: 32000, leaves: [[4, -1]] },
        { id: 0xb, samples: 100, rate: 32000, leaves: [[5, -1]] },
        {
          id: 0xc,
          samples: 100,
          rate: 32000,
          leaves: [
            [3, -1],
            [21, -1]
          ]
        }
      ]
    },
    'resident/weapons.awc': {
      archive: 'RESIDENT.rpf',
      size: 50000,
      streams: [
        { id: 0xa, samples: 100, rate: 32000, leaves: [[22, -1]] },
        { id: 0xb, samples: 100, rate: 32000, leaves: [[31, -1]] },
        { id: 0xc, samples: 100, rate: 32000, leaves: [[32, -1]] },
        { id: 0xd, samples: 100, rate: 32000, leaves: [[41, -1]] }
      ]
    },
    'resident/explosions.awc': {
      archive: 'RESIDENT.rpf',
      size: 50000,
      streams: [
        { id: 0xa, samples: 100, rate: 32000, leaves: [[50, -1]] },
        { id: 0xb, samples: 100, rate: 32000, leaves: [[60, -1]] },
        { id: 0xc, samples: 100, rate: 32000, leaves: [] }
      ]
    }
  },
  nodes: {
    '1': { type: 'MultitrackSound', header: {}, children: [2, 3], parents: [[10, 0]] },
    '2': { type: 'RandomizedSound', header: {}, children: [4, 5], weights: [1, 3], parents: [[1, 0]] },
    '3': simple(C_PISTOL, 0xc, [
      [1, 1],
      [10, 1]
    ]),
    '4': simple(C_PISTOL, 0xa, [[2, 0]]),
    '5': simple(C_PISTOL, 0xb, [[2, 1]]),
    '10': { type: 'IfSound', header: {}, children: [1, 3], cond: { variable: 77, conditionType: 2, value: 0.5 }, parents: [] },
    '20': { type: 'CrossfadeSound', header: {}, children: [21, 22], cond: { mode: 0, minDistance: 20, maxDistance: 80 }, parents: [] },
    '21': simple(C_PISTOL, 0xc, [[20, 0]]),
    '22': simple(C_WEAPONS, 0xa, [[20, 1]]),
    '30': { type: 'CollapsingStereoSound', header: {}, children: [31, 32], cond: { minDistance: 5, maxDistance: 20 }, parents: [] },
    '31': simple(C_WEAPONS, 0xb, [[30, 0]]),
    '32': simple(C_WEAPONS, 0xc, [[30, 1]]),
    '40': { type: 'SoundSet', header: {}, children: [41], cond: { entries: [500] }, parents: [] },
    '41': simple(C_WEAPONS, 0xd, [[40, 0]]),
    '50': simple(C_EXPLOSIONS, 0xa, []),
    '60': simple(C_EXPLOSIONS, 0xb, [])
  },
  consumers: {
    '1': [{ kind: 'game', owner: 100, field: 'FireSound' }],
    '10': [{ kind: 'game', owner: 100, field: 'SlowMoFireSound' }],
    '20': [{ kind: 'game', owner: 100, field: 'EchoSound' }],
    '30': [{ kind: 'game', owner: 100, field: 'HeftSound' }],
    '60': [{ kind: 'anim', dict: 'weapons@pistol', clip: 'reload_pistol', phase: 0.4, tag: 600, set: 0, entry: 0 }]
  },
  owners: {
    '100': { type: 'WeaponSettings', weapons: [{ weapon: 'WEAPON_PISTOL', displayName: 'Pistol', category: 'player' }] }
  },
  names: { '77': 'game.slowmo', '500': 'beep', '600': 'audio' },
  warnings: []
}
