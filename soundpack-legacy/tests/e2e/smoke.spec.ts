import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseAwc } from '../../src/core/awc/read'
import { getFormat } from '../../src/core/awc/types'
import { encodeWav16 } from '../../src/core/wav'
import { runBridge, type ExtractResult } from '../../src/main/bridge'
import { bridgeExe, makeFakeGame, makeFakeVanillaPack, repoRoot, testAwcKey } from '../fakeGame'

const shots = process.env.SCREENSHOT_DIR

async function stubOpen(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: p })) as typeof dialog.showOpenDialog
  }, paths)
}

async function stubSave(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as typeof dialog.showSaveDialog
  }, path)
}

test.skip(!existsSync(bridgeExe), 'run npm run build:bridge first')

test('first launch: make a vanilla pack from GTA V, edit a gun, preview it and export', async () => {
  const work = mkdtempSync(join(tmpdir(), 'gsm-e2e-'))
  const game = await makeFakeGame(work, { key: testAwcKey, smgBank: true })
  const shot = Int16Array.from({ length: 24000 }, (_, i) => Math.round(Math.sin(i / 3) * 20000 * Math.exp(-i / 4000)))
  const wavPath = join(work, 'my_shot.wav')
  writeFileSync(wavPath, encodeWav16(shot, 48000))
  const outDir = join(work, 'out')

  const app = await electron.launch({
    args: ['--no-sandbox', repoRoot],
    env: {
      ...process.env,
      GSM_USER_DATA: join(work, 'profile'),
      // the fake game has no real gta5.exe; its banks are AWC-encrypted with a test key
      GSM_BRIDGE_EXTRA_ARGS: JSON.stringify(['--no-keys', '--test-awc-key', testAwcKey])
    }
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1360, height: 860 })

  // first launch asks for the game folder
  await expect(page.getByRole('heading', { name: 'Welcome to Gun Soundpack Maker' })).toBeVisible()
  await stubOpen(app, [game])
  await page.getByRole('button', { name: 'Browse…' }).click()
  await expect(page.getByText('gta5.exe found')).toBeVisible()
  if (shots) await page.screenshot({ path: join(shots, '1-setup.png') })
  await page.getByRole('button', { name: 'Make vanilla pack' }).click()

  // every gun is listed; pick the pistol
  const guns = page.getByRole('navigation', { name: 'Guns' })
  await expect(guns.getByRole('button', { name: 'Pistol', exact: true })).toBeVisible()
  await expect(guns.getByRole('button', { name: 'SMG' })).toBeVisible()
  await guns.getByRole('button', { name: 'Pistol', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Pistol', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Gunshot', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Distant report' })).toBeVisible()
  await expect(page.getByText('400 rounds/min')).toBeVisible()
  // every file of the gun, under its part, all open, with what it is and who hears it
  for (const part of ['Echo / tail', 'Heft', 'Indoor shot', 'Reload sounds', 'Slow-mo gunshot']) {
    await expect(page.getByRole('heading', { name: part, exact: true })).toBeVisible()
  }
  const gunshot = page.locator('.role-group', { has: page.getByRole('heading', { name: 'Gunshot', exact: true }) })
  const rows = gunshot.locator('tbody tr')
  await expect(rows).toHaveCount(4)
  await expect(rows.first()).toContainText('variation 1 of 2 (25% of shots)')
  await expect(rows.first()).toContainText('You')
  await expect(rows.last()).toContainText('The whole gunshot')
  await expect(rows.last()).toContainText('Others')
  await rows.first().click()
  await expect(page.locator('.inspector h3')).toContainText('Gunshot: Layer 1 of 2')
  if (shots) await page.screenshot({ path: join(shots, '5-gun.png') })

  // the preview follows the game data at a distance, says what it approximated, and compares with a recording
  await page.getByRole('combobox', { name: 'Distance' }).selectOption('100')
  await page.getByRole('button', { name: '▶ Original' }).click()
  await expect(page.locator('.preview-bar .waveform-label', { hasText: 'Original' })).toBeVisible()
  await expect(page.locator('.preview-note')).toContainText("the engine's default distance roll-off")
  await stubOpen(app, [wavPath])
  await page.getByRole('button', { name: 'Compare with in-game recording…' }).click()
  await expect(page.getByRole('button', { name: /Recording/ })).toBeVisible()
  await expect(page.locator('.preview-bar .waveform-label', { hasText: 'In-game recording' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Distance' }).selectOption('0')

  // a replacement changes exactly the sounds you pick
  await rows.first().click()
  await page.getByRole('button', { name: 'Add sound…' }).click()
  await page.getByRole('button', { name: /^Assign/ }).click()
  await expect(rows.first()).toContainText('my_shot.wav')
  await expect(rows.nth(1)).not.toContainText('my_shot.wav')
  await expect(page.locator('.bank-item[title="WEAPON_PISTOL"]')).toContainText('1 changed')

  // a file the SMG fires too says so, and changing it asks first
  const echo = page.locator('.role-group', { has: page.getByRole('heading', { name: 'Echo / tail', exact: true }) })
  const far = echo.locator('tbody tr', { hasText: 'Far away' })
  await expect(far).toContainText('shared with SMG')
  await far.click()
  await expect(page.locator('.inspector')).toContainText('also part of the shot of SMG')
  await page.getByRole('button', { name: /^Assign/ }).click()
  const confirm = page.getByRole('dialog', { name: 'Also used by other guns' })
  await expect(confirm).toContainText('SMG')
  await expect(confirm.getByRole('button', { name: /Only this gun's files/ })).toBeDisabled()
  if (shots) await page.screenshot({ path: join(shots, '9-shared.png') })
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(far).not.toContainText('my_shot.wav')
  await expect(page.locator('.bank-item[title="WEAPON_SMG"]')).not.toContainText('changed')

  // replace the whole gunshot: your files and what others hear
  await gunshot.getByRole('button', { name: 'Select all' }).click()
  await page.getByRole('button', { name: 'Add sound…' }).click()
  await page.getByRole('button', { name: /^Assign/ }).click()
  await expect(rows.first()).toContainText('my_shot.wav')
  await expect(rows.last()).toContainText('my_shot.wav')

  await page.getByRole('button', { name: 'Burst ×5' }).click()
  await page.getByRole('button', { name: '▶ Yours' }).click()
  await expect(page.locator('.preview-bar .waveform-label', { hasText: 'Yours' })).toBeVisible()
  await expect(page.locator('.bank-item[title="WEAPON_PISTOL"]')).toContainText('4 changed')
  if (shots) await page.screenshot({ path: join(shots, '2-weapon.png') })

  // an automatic gun's own shot is its rapid-fire sound: listed first and played by the preview
  await guns.getByRole('button', { name: 'SMG' }).click()
  await expect(page.getByRole('heading', { name: 'SMG', exact: true })).toBeVisible()
  await expect(page.locator('.role-group h3').first()).toHaveText('Gunshot')
  const smgShot = page.locator('.role-group').first()
  await expect(smgShot).toContainText('First shot')
  await expect(smgShot).toContainText('Tail when you let go')
  await expect(page.getByRole('heading', { name: 'Shot layer', exact: true })).toBeVisible()
  await expect(page.locator('.role-group').nth(1)).toContainText('The whole shot layer')
  await page.getByRole('button', { name: 'Single' }).click()
  await page.getByRole('button', { name: '▶ Original' }).click()
  await expect(page.locator('.preview-bar .waveform-label', { hasText: 'Original' })).toBeVisible()
  await expect(page.locator('.preview-note')).not.toContainText('automatic guns also play their FireSound')
  await expect(page.getByRole('button', { name: 'Full auto ×5' })).toBeVisible()
  if (shots) await page.screenshot({ path: join(shots, '6-smg.png') })

  // export rebuilt WEAPONS_PLAYER.rpf and RESIDENT.rpf
  await page.getByRole('button', { name: /^Export \(/ }).click()
  const exportDialog = page.getByRole('dialog', { name: 'Export sound pack' })
  await exportDialog.getByRole('textbox', { name: 'Pack name' }).fill('E2E Pack')
  await expect(exportDialog.getByText('ptl_pistol.awc (3 replaced)')).toBeVisible()
  await expect(exportDialog.getByText('weapons.awc (1 replaced)')).toBeVisible()
  if (shots) await page.screenshot({ path: join(shots, '3-export.png') })
  await stubOpen(app, [outDir])
  await exportDialog.getByRole('button', { name: 'Export…' }).click()
  await expect(exportDialog.getByText(/Saved to/)).toBeVisible({ timeout: 30_000 })
  if (shots) await page.screenshot({ path: join(shots, '4-exported.png') })

  const pack = join(outDir, 'e2e_pack')
  expect(readFileSync(join(pack, 'README.txt'), 'utf8')).toContain('FiveM.app\\mods')
  for (const f of ['WEAPONS_PLAYER.rpf', 'RESIDENT.rpf']) {
    const b = readFileSync(join(pack, f))
    expect(b.readUInt32LE(0)).toBe(0x52504637) // RPF7
    expect(b.readUInt32LE(12)).toBe(0x4e45504f) // OPEN
  }
  // read the archives back like the game would
  const game2 = join(work, 'game2')
  mkdirSync(join(game2, 'x64', 'audio', 'sfx'), { recursive: true })
  writeFileSync(join(game2, 'gta5.exe'), 'MZ')
  for (const f of ['WEAPONS_PLAYER.rpf', 'RESIDENT.rpf']) copyFileSync(join(pack, f), join(game2, 'x64', 'audio', 'sfx', f))
  const ex = await runBridge<ExtractResult>(bridgeExe, [
    'extract',
    '--gta',
    game2,
    '--no-keys',
    '--test-awc-key',
    testAwcKey,
    '--out',
    join(work, 'check')
  ])
  expect(ex.errors).toEqual([])
  const bank = parseAwc(new Uint8Array(readFileSync(ex.extracted.find((e) => e.file === 'ptl_pistol.awc')!.path)))
  const body = getFormat(bank.streams.find((s) => s.id === 0x16ef0ea5)!)!
  expect(body.sampleRate).toBe(44100)
  expect(body.samples).toBeGreaterThan(20000)
  await app.close()
})

test('a zipped vanilla pack on a PC without GTA V: every bank, what each sound is for, and the in-game ID pack', async () => {
  const work = mkdtempSync(join(tmpdir(), 'gsm-e2e-banks-'))
  const { zip } = await makeFakeVanillaPack(work)
  // no GTA V and no keys: the pack has everything, unencrypted
  const env = Object.fromEntries(
    Object.entries({ ...process.env, GSM_USER_DATA: join(work, 'profile') }).filter(
      ([k, v]) => k !== 'GSM_BRIDGE_EXTRA_ARGS' && v !== undefined
    )
  ) as Record<string, string>
  const app = await electron.launch({ args: ['--no-sandbox', repoRoot], env })
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'Welcome to Gun Soundpack Maker' })).toBeVisible()
  await stubOpen(app, [zip])
  await page.getByRole('button', { name: 'Choose .zip…' }).click()
  await expect(page.getByRole('navigation', { name: 'Guns' })).toBeVisible()

  // the pack can be saved as a .zip again, to move it to another PC
  await page.getByRole('button', { name: 'Change vanilla pack…' }).click()
  const setup = page.getByRole('dialog', { name: 'Set up' })
  await expect(setup.getByLabel('Current vanilla pack')).toContainText('Vanilla pack: 2 guns')
  if (shots) await page.screenshot({ path: join(shots, '8-vanilla.png') })
  const copy = join(work, 'copy.zip')
  await stubSave(app, copy)
  await setup.getByRole('button', { name: 'Save as .zip…' }).click()
  await expect(setup.getByText(/Saved to/)).toBeVisible()
  expect(existsSync(copy)).toBe(true)
  await setup.getByRole('button', { name: 'Cancel' }).click()

  await page.getByRole('tab', { name: 'Sound banks' }).click()
  await page.locator('.bank-item[title^="resident/weapons.awc"]').click()
  await expect(page.getByText('from the vanilla pack')).toBeVisible()
  await expect(page.locator('table.streams tbody tr')).toHaveCount(3)
  await page.locator('table.streams tbody tr', { hasText: '02032920' }).click()
  await expect(page.locator('table.streams tbody tr', { hasText: '02032920' })).toContainText('Your Pistol')
  await page.getByRole('button', { name: 'Silence' }).click()
  await expect(page.locator('table.streams tbody tr', { hasText: '02032920' })).toContainText('Silenced')

  // a bank no gun uses is listed from the sound map and loads from the pack on demand
  const explosions = page.locator('.bank-item[title^="resident/explosions.awc"]')
  await expect(explosions).toHaveClass(/missing/) // not in the library yet
  await explosions.click()
  await page.getByRole('button', { name: 'Load from pack' }).click()
  await expect(page.locator('table.streams tbody tr')).toHaveCount(3)
  await expect(page.locator('table.streams tbody tr', { hasText: '0AA87351' })).toContainText('Unused')
  await expect(page.locator('table.streams tbody tr', { hasText: '16EF0EA5' })).toContainText('Explosion')
  if (shots) await page.screenshot({ path: join(shots, '6-banks.png') })

  // the ID pack: every sound says its code
  await page.getByRole('button', { name: 'Identify in game…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Identify sounds in game' })
  await dialog.getByRole('radio', { name: /Everything/ }).check()
  await expect(dialog.getByText('3 banks, 9 sounds')).toBeVisible()
  const outDir = join(work, 'ids')
  await stubOpen(app, [outDir])
  await dialog.getByRole('button', { name: 'Build ID pack…' }).click()
  await expect(dialog.getByText(/Saved to/)).toBeVisible({ timeout: 30_000 })
  await expect(dialog.getByText(/9 sounds labelled with beeps/)).toBeVisible()
  if (shots) await page.screenshot({ path: join(shots, '7-idpack.png') })
  const folder = join(outDir, 'sound-id-pack')
  const legend = readFileSync(join(folder, 'ID-LEGEND.txt'), 'utf8')
  expect(legend).toContain('explosions 3')
  for (const f of ['WEAPONS_PLAYER.rpf', 'RESIDENT.rpf']) expect(existsSync(join(folder, f))).toBe(true)

  // "What did I hear?" jumps to the sound
  await dialog.getByRole('textbox', { name: 'ID pack code' }).fill('explosions three')
  await dialog.getByRole('button', { name: 'Find' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('table.streams tbody tr.selected')).toContainText('16EF0EA5')
  await expect(page.locator('.inspector h3')).toContainText('Explosion')
  await app.close()
})
