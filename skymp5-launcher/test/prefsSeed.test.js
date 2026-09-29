'use strict'
// A missing profile SkyrimPrefs.ini is seeded from a full prefs file, and a skeleton one (the launcher's own writes
// only, GroundedPasta 2026-09-29) is rebuilt from one with the skeleton's keys kept on top
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const ini = require('../src/ini')
const { ensureProfilePrefs, keyCount, MIN_KEYS } = require('../src/prefsSeed')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-seed-test-'))
const game = path.join(root, 'game')
const copy = path.join(root, 'copy')
const docs = path.join(root, 'docs', 'SkyrimPrefs.ini')
const dest = path.join(root, 'profile', 'skyrimprefs.ini')
const now = new Date('2026-09-29T04:30:00.123Z')
const FORCED = { Display: { 'bFull Screen': '0', bBorderless: '1' }, MAIN: { bGamepadEnable: '0' } }

// A full prefs file: [Interface] plus enough filler to pass for one the game wrote
function preset(label, extra = '') {
  const lines = ['[Display]', 'iSize W=1280', 'iSize H=720', 'bFull Screen=1', `sPreset=${label}`]
  for (let i = 0; i < MIN_KEYS; i++) lines.push(`fFiller${i}=${i}`)
  lines.push('[Interface]', 'fMouseCursorSpeed=1.0000', 'fSafeZoneX=15.0000', 'fSafeZoneY=15.0000')
  lines.push('[General]', 'fDefaultFOV=65', extra)
  return lines.join('\r\n') + '\r\n'
}

function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

function reset() {
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
}

// GroundedPasta's profile ini as pasted: the launcher's writes and nothing else
const SKELETON = [
  '[Display]', 'bFull Screen=1', 'bBorderless=0', 'iSize W=1920', 'iSize H=1080', 'iTexMipMapSkip=0',
  'bUseTAA=1', 'bFXAAEnabled=0', 'iShadowMapResolution=4096', 'bVolumetricLightingEnable=1', 'bSAOEnable=1',
  '[Controls]', 'bInvertYValues=0',
  '[General]', 'fDefaultFOV=80',
  '[MAIN]', 'bGamepadEnable=0',
].join('\r\n') + '\r\n'

test('nothing anywhere: nothing is written, and the log says so', () => {
  reset()
  assert.deepStrictEqual(ensureProfilePrefs(dest, { gameDirs: [game], now }), ['no source SkyrimPrefs.ini found to seed'])
  assert.ok(!fs.existsSync(dest))
})

test("a missing profile ini comes from the player's own prefs first, with the forced keys on top", () => {
  reset()
  put(docs, preset('docs'))
  put(path.join(game, 'High.ini'), preset('high'))
  const lines = ensureProfilePrefs(dest, { documentsPrefs: docs, gameDirs: [game], forced: FORCED, now })
  assert.deepStrictEqual(lines, [`seeded profile SkyrimPrefs.ini from ${docs}`])
  const out = ini.read(dest)
  assert.strictEqual(out.Display.sPreset, 'docs')
  assert.strictEqual(out.Display.bBorderless, '1')
  assert.strictEqual(out.Display['bFull Screen'], '0')
  assert.strictEqual(out.MAIN.bGamepadEnable, '0')
})

test('no Documents prefs: the game template, then High.ini, from the original install or the game copy', () => {
  reset()
  put(path.join(copy, 'High.ini'), preset('copy-high'))
  assert.match(ensureProfilePrefs(dest, { gameDirs: [game, copy], now })[0], /from .*copy.*High\.ini$/)
  fs.rmSync(dest)
  put(path.join(game, 'Skyrim', 'SkyrimPrefs.ini'), preset('template'))
  ensureProfilePrefs(dest, { gameDirs: [game, copy], now })
  assert.strictEqual(ini.read(dest).Display.sPreset, 'template')
})

test('a source with too few keys is passed over and named in the log', () => {
  reset()
  put(docs, '[Display]\r\niSize W=800\r\n')
  put(path.join(game, 'Medium.ini'), preset('medium'))
  const lines = ensureProfilePrefs(dest, { documentsPrefs: docs, gameDirs: [game], now })
  assert.strictEqual(lines[0], `seeded profile SkyrimPrefs.ini from ${path.join(game, 'Medium.ini')}`)
  assert.strictEqual(lines[1], `too few keys to use: ${docs} (1 keys)`)
})

test("GroundedPasta's skeleton is rebuilt from High.ini and keeps every key he had", () => {
  reset()
  put(dest, SKELETON)
  put(path.join(game, 'High.ini'), preset('high'))
  const lines = ensureProfilePrefs(dest, { gameDirs: [game], now })
  assert.deepStrictEqual(lines, [
    `rebuilt profile SkyrimPrefs.ini (13 keys, no [Interface]) from ${path.join(game, 'High.ini')}, keeping its own ` +
      '13 keys; the old file is kept as skyrimprefs.ini.incomplete-20260929T043000Z',
  ])
  const out = ini.read(dest)
  assert.strictEqual(out.Interface.fMouseCursorSpeed, '1.0000')
  assert.strictEqual(out.Display['iSize W'], '1920')
  assert.strictEqual(out.Display['iSize H'], '1080')
  assert.strictEqual(out.Display['bFull Screen'], '1')
  assert.strictEqual(out.Display.bBorderless, '0')
  assert.strictEqual(out.Display.iShadowMapResolution, '4096')
  assert.strictEqual(out.General.fDefaultFOV, '80')
  assert.strictEqual(out.Controls.bInvertYValues, '0')
  assert.strictEqual(out.Display.sPreset, 'high')
  assert.ok(keyCount(out) >= MIN_KEYS)
  assert.strictEqual(fs.readFileSync(`${dest}.incomplete-20260929T043000Z`, 'utf8'), SKELETON)
  // CRLF like the game's own files, one section each
  const text = fs.readFileSync(dest, 'utf8')
  assert.ok(!/[^\r]\n/.test(text))
  assert.strictEqual(text.match(/^\[Display\]/gm).length, 1)
})

test('a rebuilt file is left alone from then on', () => {
  const before = fs.readFileSync(dest, 'utf8')
  assert.deepStrictEqual(ensureProfilePrefs(dest, { gameDirs: [game], now: new Date('2026-09-30T00:00:00Z') }), [])
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), before)
  assert.strictEqual(fs.readdirSync(path.dirname(dest)).filter(f => f.includes('.incomplete-')).length, 1)
})

test('a skeleton with no full source anywhere stays as it is, and the log says why', () => {
  reset()
  put(dest, SKELETON)
  put(path.join(game, 'Low.ini'), '[Display]\r\niSize W=640\r\n')
  const lines = ensureProfilePrefs(dest, { gameDirs: [game], now })
  assert.deepStrictEqual(lines, [
    'profile SkyrimPrefs.ini is incomplete (13 keys, no [Interface]) and no full prefs file was found to rebuild it',
    `too few keys to use: ${path.join(game, 'Low.ini')} (1 keys)`,
  ])
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), SKELETON)
})

test('a full file without [Interface] gains it only when the source has one', () => {
  reset()
  const full = preset('mine').replace(/\[Interface\]\r\n(?:f\w+=[\d.]+\r\n)+/, '')
  put(dest, full)
  const noInterface = preset('high').replace(/\[Interface\]\r\n(?:f\w+=[\d.]+\r\n)+/, '')
  put(path.join(game, 'High.ini'), noInterface)
  assert.deepStrictEqual(ensureProfilePrefs(dest, { gameDirs: [game], now }), [])
  put(path.join(game, 'High.ini'), preset('high'))
  assert.match(ensureProfilePrefs(dest, { gameDirs: [game], now })[0], /^rebuilt .*no \[Interface\]/)
  const out = ini.read(dest)
  assert.strictEqual(out.Interface.fSafeZoneX, '15.0000')
  assert.strictEqual(out.Display.sPreset, 'mine')
  fs.rmSync(root, { recursive: true, force: true })
})
