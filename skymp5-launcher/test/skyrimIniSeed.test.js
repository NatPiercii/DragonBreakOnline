'use strict'
// A missing profile Skyrim.ini is seeded from the player's own or the game's Skyrim_Default.ini, and one without [Archive]
// (only the launcher's writes: [Bethesda.net] and the FOV keys) is rebuilt with its keys kept on top
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const ini = require('../src/ini')
const { ensureProfileSkyrimIni } = require('../src/prefsSeed')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skyrim-ini-seed-test-'))
const copy = path.join(root, 'copy')
const game = path.join(root, 'game')
const docs = path.join(root, 'docs', 'Skyrim.ini')
const dest = path.join(root, 'profile', 'skyrim.ini')
const now = new Date('2026-09-29T04:40:00Z')

const DEFAULT = [
  '[General]', 'sLanguage=ENGLISH', 'uExterior Cell Buffer=36',
  '[Display]', 'fDefaultWorldFOV=75', 'fDefault1stPersonFOV=80',
  '[Archive]', 'sResourceArchiveList=Skyrim - Misc.bsa, Skyrim - Shaders.bsa',
  'sResourceArchiveList2=Skyrim - Voices_en0.bsa, Skyrim - Textures0.bsa',
].join('\r\n') + '\r\n'

// What the launcher itself writes into a profile Skyrim.ini, and nothing else
const SKELETON = [
  '[Bethesda.net]', 'bEnablePlatform=0',
  '[Display]', 'fDefaultWorldFOV=95', 'fDefault1stPersonFOV=95',
].join('\r\n') + '\r\n'

function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

function reset() {
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
}

test('nothing anywhere: nothing is written', () => {
  reset()
  assert.deepStrictEqual(ensureProfileSkyrimIni(dest, { gameDirs: [copy, game], now }), ['no source Skyrim.ini found to seed'])
  assert.ok(!fs.existsSync(dest))
})

test("a missing profile ini comes from the player's own Skyrim.ini first, else Skyrim_Default.ini", () => {
  reset()
  put(path.join(game, 'Skyrim_Default.ini'), DEFAULT)
  assert.deepStrictEqual(ensureProfileSkyrimIni(dest, { gameDirs: [copy, game], now }),
    [`seeded profile Skyrim.ini from ${path.join(game, 'Skyrim_Default.ini')}`])
  fs.rmSync(dest)
  put(docs, DEFAULT.replace('ENGLISH', 'GERMAN'))
  ensureProfileSkyrimIni(dest, { documentsIni: docs, gameDirs: [copy, game], now })
  assert.strictEqual(ini.read(dest).General.sLanguage, 'GERMAN')
})

test('a Documents ini without [Archive] is passed over and named', () => {
  reset()
  put(docs, '[Display]\r\nfDefaultWorldFOV=70\r\n')
  put(path.join(copy, 'Skyrim_Default.ini'), DEFAULT)
  assert.deepStrictEqual(ensureProfileSkyrimIni(dest, { documentsIni: docs, gameDirs: [copy, game], now }), [
    `seeded profile Skyrim.ini from ${path.join(copy, 'Skyrim_Default.ini')}`,
    `no [Archive] in ${docs}`,
  ])
})

test('a skeleton is rebuilt from Skyrim_Default.ini and keeps the FOV and the platform switch', () => {
  reset()
  put(dest, SKELETON)
  put(path.join(copy, 'Skyrim_Default.ini'), DEFAULT)
  assert.deepStrictEqual(ensureProfileSkyrimIni(dest, { gameDirs: [copy, game], now }), [
    `rebuilt profile Skyrim.ini (3 keys, no [Archive]) from ${path.join(copy, 'Skyrim_Default.ini')}, keeping its own ` +
      '3 keys; the old file is kept as skyrim.ini.incomplete-20260929T044000Z',
  ])
  const out = ini.read(dest)
  assert.strictEqual(out.Display.fDefaultWorldFOV, '95')
  assert.strictEqual(out.Display.fDefault1stPersonFOV, '95')
  assert.strictEqual(out['Bethesda.net'].bEnablePlatform, '0')
  assert.match(out.Archive.sResourceArchiveList, /Skyrim - Misc\.bsa/)
  assert.strictEqual(out.General.sLanguage, 'ENGLISH')
  assert.strictEqual(fs.readFileSync(`${dest}.incomplete-20260929T044000Z`, 'utf8'), SKELETON)
})

test('a file with [Archive] is never touched, however few keys it has', () => {
  const before = fs.readFileSync(dest, 'utf8')
  assert.deepStrictEqual(ensureProfileSkyrimIni(dest, { gameDirs: [copy, game], now: new Date('2026-09-30T00:00:00Z') }), [])
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), before)
  put(dest, '[Archive]\r\nsResourceArchiveList=a.bsa\r\n')
  assert.deepStrictEqual(ensureProfileSkyrimIni(dest, { gameDirs: [copy, game], now }), [])
})

test('a skeleton with no source stays as it is, and the log says so', () => {
  reset()
  put(dest, SKELETON)
  assert.deepStrictEqual(ensureProfileSkyrimIni(dest, { gameDirs: [copy, game], now }), [
    'profile Skyrim.ini has no [Archive] (3 keys) and no full Skyrim.ini was found to rebuild it',
  ])
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), SKELETON)
  fs.rmSync(root, { recursive: true, force: true })
})
