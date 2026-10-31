import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bridgeExe as exe, fixtureBank, makeFakeGame, testAwcKey as key } from '../../tests/fakeGame'
import { parseAwc } from '../core/awc/read'
import { BRIDGE_NAME, bridgePath, runBridge, type ExtractResult, type ListResult } from './bridge'
import { TemplateLibrary } from './library'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'gsm-bridge-'))

function fakeBridge(script: string): string {
  const path = join(tmp(), 'fake-bridge')
  writeFileSync(path, `#!/usr/bin/env node\n${script}\n`)
  chmodSync(path, 0o755)
  return path
}

describe.skipIf(process.platform === 'win32')('runBridge', () => {
  it('returns the result and forwards progress', async () => {
    const exe = fakeBridge(`
      process.stderr.write(JSON.stringify({ progress: 'step 1' }) + '\\n')
      process.stderr.write('not json\\n')
      process.stdout.write(JSON.stringify({ ok: true, result: { args: process.argv.slice(2) } }) + '\\n')
    `)
    const seen: string[] = []
    const r = await runBridge<{ args: string[] }>(exe, ['list', '--gta', 'x'], (m) => seen.push(m))
    expect(r.args).toEqual(['list', '--gta', 'x'])
    expect(seen).toEqual(['step 1'])
  })

  it('turns bridge failures into errors with codes', async () => {
    const exe = fakeBridge(`process.stdout.write(JSON.stringify({ ok: false, code: 'keys', error: 'bad keys' })); process.exit(1)`)
    await expect(runBridge(exe, [])).rejects.toMatchObject({ code: 'keys', message: 'bad keys' })
    const crash = fakeBridge(`process.stderr.write('Unhandled exception\\n'); process.exit(3)`)
    await expect(runBridge(crash, [])).rejects.toMatchObject({ code: 'crash', message: expect.stringContaining('Unhandled exception') })
    await expect(runBridge('/does/not/exist', [])).rejects.toMatchObject({ code: 'no-bridge' })
  })

  it('locates the executable', () => {
    expect(bridgePath({ isPackaged: true, resourcesPath: '/r', appPath: '/a' })).toBe(join('/r', 'bridge', BRIDGE_NAME))
    expect(bridgePath({ isPackaged: false, resourcesPath: '/r', appPath: '/a' })).toBe(join('/a', 'resources', 'bridge', BRIDGE_NAME))
  })
})

// Runs against the real bridge (CodeWalker bundled) once `npm run build:bridge` has been run.
describe.skipIf(!existsSync(exe))('CodeWalker bridge (integration)', () => {
  for (const mode of ['single-channel', 'whole-file'] as const) {
    it(`lists and extracts ${mode} encrypted banks`, async () => {
      const game = await makeFakeGame(tmp(), { key, wholeFile: mode === 'whole-file', metadata: false })
      const args = ['--gta', game, '--no-keys', '--test-awc-key', key]

      const list = await runBridge<ListResult>(exe, ['list', ...args])
      expect(list.banks.map((b) => `${b.pack}/${b.file}`).sort()).toEqual([
        'resident/explosions.awc',
        'resident/weapons.awc',
        'weapons_player/ptl_pistol.awc'
      ])
      expect(list.game.exe).toBe('gta5.exe')

      const out = tmp()
      const progress: string[] = []
      const result = await runBridge<ExtractResult>(
        exe,
        ['extract', ...args, '--out', out, '--bank', 'weapons_player/ptl_pistol.awc'],
        (m) => progress.push(m)
      )
      expect(result.errors).toEqual([])
      expect(result.extracted).toHaveLength(1)
      expect(result.extracted[0]).toMatchObject({ pack: 'weapons_player', file: 'ptl_pistol.awc', streams: 3, wasEncrypted: true })
      expect(progress).toContain('Extracting weapons_player/ptl_pistol.awc')

      // decrypted bank has exactly the original streams
      const got = parseAwc(new Uint8Array(readFileSync(result.extracted[0].path)))
      expect(got.streams).toEqual(parseAwc(fixtureBank()).streams)

      const lib = new TemplateLibrary(join(tmp(), 'templates'))
      const report = await lib.importExtracted(result.extracted)
      expect(report.imported[0]).toMatchObject({ pack: 'weapons_player', file: 'ptl_pistol.awc', origin: 'gta', streamCount: 3 })
    })
  }

  it('reports missing banks and bad folders', async () => {
    const game = await makeFakeGame(tmp(), { metadata: false })
    const r = await runBridge<ExtractResult>(exe, ['extract', '--gta', game, '--no-keys', '--out', tmp(), '--bank', 'resident/nope.awc'])
    expect(r.extracted).toEqual([])
    expect(r.errors).toEqual([{ pack: 'resident', file: 'nope.awc', error: 'Not found in the game files.' }])
    await expect(runBridge(exe, ['list', '--gta', tmp()])).rejects.toMatchObject({ code: 'no-gta' })
  })
})
