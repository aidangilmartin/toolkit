import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Case-insensitive check for a file directly inside `dir`. */
export function hasFile(dir: string, name: string): boolean {
  try {
    const lower = name.toLowerCase()
    return readdirSync(dir).some((f) => f.toLowerCase() === lower)
  } catch {
    return false
  }
}

export function isGtaFolder(dir: string): boolean {
  return hasFile(dir, 'gta5.exe') || hasFile(dir, 'gta5_enhanced.exe')
}

/** FiveM stores the GTA V folder it uses as IVPath in CitizenFX.ini. */
export function parseCitizenFxIni(text: string): string | undefined {
  const m = /^\s*IVPath\s*=\s*(.+?)\s*$/im.exec(text)
  return m?.[1]
}

/** Likely GTA V install folders, most specific first. */
export function gtaCandidates(env: Record<string, string | undefined>): string[] {
  const out: string[] = []
  const localAppData = env.LOCALAPPDATA
  if (localAppData) {
    const ini = join(localAppData, 'FiveM', 'FiveM.app', 'CitizenFX.ini')
    try {
      const p = parseCitizenFxIni(readFileSync(ini, 'utf8'))
      if (p) out.push(p)
    } catch {
      // FiveM not installed
    }
  }
  const pf = env.ProgramFiles ?? 'C:\\Program Files'
  const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  for (const base of [pf, pf86]) {
    out.push(
      join(base, 'Rockstar Games', 'Grand Theft Auto V'),
      join(base, 'Steam', 'steamapps', 'common', 'Grand Theft Auto V'),
      join(base, 'Epic Games', 'GTAV'),
      join(base, 'Rockstar Games', 'Grand Theft Auto V Enhanced'),
      join(base, 'Steam', 'steamapps', 'common', 'Grand Theft Auto V Enhanced')
    )
  }
  return [...new Set(out)]
}

export function detectGtaFolder(env: Record<string, string | undefined> = process.env): string | undefined {
  return gtaCandidates(env).find((p) => existsSync(p) && isGtaFolder(p))
}
