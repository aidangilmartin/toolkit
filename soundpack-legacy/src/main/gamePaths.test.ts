import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectGtaFolder, gtaCandidates, isGtaFolder, parseCitizenFxIni } from './gamePaths'

describe('game paths', () => {
  it('reads the GTA V path FiveM uses', () => {
    expect(parseCitizenFxIni('[Game]\r\nIVPath=D:\\Games\\GTAV\r\nUpdateChannel=production\r\n')).toBe('D:\\Games\\GTAV')
    expect(parseCitizenFxIni('[Game]\n')).toBeUndefined()
  })

  it('checks folders case-insensitively', () => {
    const gta = mkdtempSync(join(tmpdir(), 'gsm-gta-'))
    expect(isGtaFolder(gta)).toBe(false)
    writeFileSync(join(gta, 'GTA5.exe'), '')
    expect(isGtaFolder(gta)).toBe(true)
  })

  it('prefers the FiveM path, then common install folders', () => {
    const local = mkdtempSync(join(tmpdir(), 'gsm-local-'))
    const gta = mkdtempSync(join(tmpdir(), 'gsm-gta-'))
    writeFileSync(join(gta, 'gta5.exe'), '')
    mkdirSync(join(local, 'FiveM', 'FiveM.app'), { recursive: true })
    writeFileSync(join(local, 'FiveM', 'FiveM.app', 'CitizenFX.ini'), `[Game]\nIVPath=${gta}\n`)
    const env = { LOCALAPPDATA: local, ProgramFiles: '/nope', 'ProgramFiles(x86)': '/nope86' }
    expect(gtaCandidates(env)[0]).toBe(gta)
    expect(gtaCandidates(env)).toContain(join('/nope', 'Rockstar Games', 'Grand Theft Auto V'))
    expect(detectGtaFolder(env)).toBe(gta)
    expect(detectGtaFolder({ ProgramFiles: '/nope' })).toBeUndefined()
  })
})
