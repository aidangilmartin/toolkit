/** The archives a gun sound pack rebuilds, one per wave pack. */
export const PACK_ARCHIVES: Record<string, string> = {
  weapons_player: 'WEAPONS_PLAYER.rpf',
  resident: 'RESIDENT.rpf'
}

/** Folder-safe pack name: lowercase letters, digits, '_' and '-'. */
export function sanitizePackName(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
  return s || 'gunpack'
}

/** README.txt placed next to the rebuilt archives. */
export function installReadme(name: string, archives: string[]): string {
  const files = archives.map((a) =>
    a === 'WEAPONS_PLAYER.rpf' ? `  ${a}   weapon sound banks` : a === 'RESIDENT.rpf' ? `  ${a}         shared sound banks` : `  ${a}`
  )
  return [
    `${name} — GTA V gun sound pack`,
    '',
    'Files:',
    ...files,
    '',
    'FiveM:',
    '  Drag the .rpf files into your FiveM mods folder:',
    '  %localappdata%\\FiveM\\FiveM.app\\mods',
    '  (FiveM > right-click > Open file location > FiveM.app > mods; create the folder if it is missing.)',
    '',
    'Single player (OpenIV):',
    '  Put the .rpf files in  <GTA V folder>\\mods\\x64\\audio\\sfx  (needs OpenIV.asi).',
    '',
    'Do not overwrite the original files in <GTA V folder>\\x64\\audio\\sfx: these are unencrypted',
    'mod archives, and FiveM refuses to start with modified archives in the game folder.',
    '',
    'To go back to the original sounds, delete the files from the mods folder.',
    '',
    'Made with Gun Soundpack Maker.',
    ''
  ].join('\n')
}

/** README.txt for the in-game ID pack: a test pack, not something to keep installed. */
export function idPackReadme(archives: string[]): string {
  return [
    'Sound ID pack — find out which game sound plays when',
    '',
    'Files:',
    ...archives.map((a) => `  ${a}`),
    '  ID-LEGEND.txt   what every code means',
    '',
    'Every sound in the chosen banks is replaced by a short spoken code such as "pistol 4"',
    '(or beeps when no Windows voice was available). Play the game, note the codes you hear,',
    'and look them up in ID-LEGEND.txt or in the app ("What did I hear?").',
    '',
    'Install it like a normal pack:',
    '  FiveM:  %localappdata%\\FiveM\\FiveM.app\\mods',
    '  Single player (OpenIV):  <GTA V folder>\\mods\\x64\\audio\\sfx',
    '',
    'This is a test pack: delete the files again when you are done, and never put them over the',
    'original files in <GTA V folder>\\x64\\audio\\sfx.',
    '',
    'Made with Gun Soundpack Maker.',
    ''
  ].join('\n')
}
