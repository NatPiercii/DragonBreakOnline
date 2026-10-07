'use strict'
// The control maps the game loads must hold all 18 input contexts, in order (GroundedPasta, 2026-09-29: SKSE's
// GetMappedKey read a null Item Menus context on every container, and the menu cursor never moved without the Cursor
// context). A short or pre-1.6.1130 map is moved aside before launch; a complete one stays, whoever wrote it.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const cm = require('../src/controlmapCheck')

const seed = fs.readFileSync(path.join(__dirname, '..', 'assets', 'controlmap.txt'), 'utf8')
// The seed's context blocks as raw text, and a map built from some of them the way the game writes one
const rawBlocks = seed.split(/\r?\n[ \t]*\r?\n/)
const build = blocks => blocks.join('\r\n\r\n') + '\r\n'
const full = build(rawBlocks)
// Before 1.6.1130: no Creations Menu context (the block with PurchaseCredits)
const pre1130 = build(rawBlocks.filter(b => !/^PurchaseCredits\t/m.test(b)))
// Ends after Console, part-way into Item Menus, as a write cut short leaves it
const truncated = build(rawBlocks.slice(0, 3)) + rawBlocks[3].split(/\r?\n/).slice(0, 2).join('\r\n')
const now = new Date('2026-09-29T16:00:00.123Z')
const DATA_REL = path.join('Interface', 'Controls', 'PC', 'controlmap.txt')

function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

test('the seed has the 18 contexts of SKSE 2.2.6 in order: Item Menus 4th, Cursor 10th, Creations Menu 17th', () => {
  const blocks = cm.parseBlocks(seed)
  assert.strictEqual(blocks.length, 18)
  assert.ok(blocks[3].includes('LeftEquip'))
  assert.deepStrictEqual(blocks[9], ['Cursor', 'Click'])
  assert.ok(blocks[16].includes('PurchaseCredits'))
  assert.deepStrictEqual(cm.analyzeControlmap(seed), { ok: true, found: 18, expected: 18, blocks: 18, missing: [], lf: 0 })
})

test('a full CRLF map passes, with a BOM, changed keys, or no comments at all', () => {
  assert.ok(cm.analyzeControlmap(full).ok)
  assert.ok(cm.analyzeControlmap('\uFEFF' + full).ok)
  // A remap changes the key columns, never the event names
  assert.ok(cm.analyzeControlmap(full.replace(/^(Forward\t)0x11/m, '$10xc8')).ok)
  assert.ok(cm.analyzeControlmap(full.split(/\r?\n/).filter(l => !l.startsWith('//')).join('\r\n')).ok)
})

test('a truncated map has 3 of 18 contexts, and everything from Item Menus on is named missing', () => {
  const r = cm.analyzeControlmap(truncated)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.found, 3)
  assert.deepStrictEqual(r.missing.slice(0, 2), ['Item Menus', 'Inventory'])
  assert.ok(r.missing.includes('Cursor'))
  assert.strictEqual(cm.analyzeControlmap('').found, 0)
})

test('a map from before 1.6.1130 has 16 of 18: Favor sits where Creations Menu belongs', () => {
  const r = cm.analyzeControlmap(pre1130)
  assert.deepStrictEqual([r.ok, r.found, r.missing], [false, 16, ['Creations Menu', 'Favor']])
})

test('a context dropped in the middle shifts the rest and is caught', () => {
  const r = cm.analyzeControlmap(build(rawBlocks.filter((_, i) => i !== 8)))
  assert.strictEqual(r.ok, false)
  assert.ok(r.missing.includes('Stats') && r.missing.includes('Cursor'))
})

test('the files the game reads: the root custom map, then overwrite, the enabled mods from the top, then Data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'controlmap-test-'))
  const game = path.join(root, 'skyrim')
  const mo2 = { overwriteDir: path.join(root, 'overwrite'), modsDir: path.join(root, 'mods'), mods: cm.enabledMods('# MO2\r\n+High\r\n-Off\r\n+Low\r\n') }
  assert.deepStrictEqual(mo2.mods, ['High', 'Low'])
  put(path.join(game, 'Data', DATA_REL), full)
  put(path.join(root, 'mods', 'Low', DATA_REL), full)
  put(path.join(root, 'mods', 'Off', DATA_REL), full)
  put(path.join(game, 'ControlMap_Custom.txt'), full)
  assert.deepStrictEqual(cm.controlmapFiles(game, mo2), {
    custom: path.join(game, 'ControlMap_Custom.txt'),
    data: [path.join(root, 'mods', 'Low', DATA_REL), path.join(game, 'Data', DATA_REL)],
  })
  // Without MO2 only the game's own Data counts
  assert.deepStrictEqual(cm.controlmapFiles(game, null).data, [path.join(game, 'Data', DATA_REL)])
  fs.rmSync(root, { recursive: true, force: true })
})

test('before launch: the game\'s short custom map (the player\'s remaps) is kept, a short winning mod map is moved aside', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'controlmap-test-'))
  const game = path.join(root, 'skyrim')
  const mo2 = { overwriteDir: path.join(root, 'overwrite'), modsDir: path.join(root, 'mods'), mods: ['Keys'] }
  const custom = path.join(game, 'ControlMap_Custom.txt')
  const modMap = path.join(root, 'mods', 'Keys', DATA_REL)
  const ours = path.join(game, 'Data', DATA_REL)
  put(custom, truncated)
  put(modMap, pre1130)
  put(ours, full)
  const lines = cm.checkControlmaps({ gameDir: game, mo2, now })
  assert.deepStrictEqual(lines, [
    `controlmap: ${custom} holds the player's remaps (3 context(s)), kept`,
    `controlmap: ${modMap} has 16 of 18 contexts (missing Creations Menu, Favor), moved aside to controlmap.txt.incomplete-20260929T160000Z`,
    `controlmap: ${ours} has 18 of 18 contexts`,
  ])
  assert.ok(fs.existsSync(custom) && !fs.existsSync(modMap))
  assert.strictEqual(fs.readFileSync(custom, 'utf8'), truncated)
  assert.strictEqual(fs.readFileSync(ours, 'utf8'), full)
  fs.rmSync(root, { recursive: true, force: true })
})

test('before launch: a custom map that is an old full map (pre-1.6.1130, 16 of 18 contexts) is still moved aside', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'controlmap-test-'))
  const game = path.join(root, 'skyrim')
  const custom = path.join(game, 'ControlMap_Custom.txt')
  put(custom, pre1130)
  put(path.join(game, 'Data', DATA_REL), full)
  const lines = cm.checkControlmaps({ gameDir: game, now })
  assert.match(lines[0], /has 16 of 18 contexts \(missing Creations Menu, Favor\), moved aside to ControlMap_Custom\.txt\.incomplete-20260929T160000Z$/)
  assert.ok(!fs.existsSync(custom))
  fs.rmSync(root, { recursive: true, force: true })
})

test('complete maps stay; with no loose map left, the log says the game\'s own applies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'controlmap-test-'))
  const game = path.join(root, 'skyrim')
  put(path.join(game, 'ControlMap_Custom.txt'), full)
  put(path.join(game, 'Data', DATA_REL), full)
  assert.deepStrictEqual(cm.checkControlmaps({ gameDir: game, now }), [
    `controlmap: ${path.join(game, 'ControlMap_Custom.txt')} has 18 of 18 contexts`,
    `controlmap: ${path.join(game, 'Data', DATA_REL)} has 18 of 18 contexts`,
  ])
  fs.writeFileSync(path.join(game, 'Data', DATA_REL), pre1130)
  const lines = cm.checkControlmaps({ gameDir: game, now })
  assert.match(lines[1], /has 16 of 18 contexts .*moved aside/)
  assert.match(lines[2], /no loose controlmap\.txt is left in Data/)
  assert.deepStrictEqual(cm.checkControlmaps({ gameDir: '' }), [])
  fs.rmSync(root, { recursive: true, force: true })
})

test('the same full map with LF-only lines is caught: all 18 contexts, but not the endings the game\'s own map has', () => {
  const lfOnly = full.replace(/\r\n/g, '\n')
  const r = cm.analyzeControlmap(lfOnly)
  assert.deepStrictEqual([r.ok, r.found, r.missing.length, r.lf], [false, 18, 0, lfOnly.split('\n').length - 1])
  assert.strictEqual(cm.bareLfCount(cm.toCrlf(lfOnly)), 0)
  assert.strictEqual(cm.toCrlf(lfOnly), full)
  // One stray LF in an otherwise CRLF file counts too
  assert.strictEqual(cm.analyzeControlmap(full.replace('\r\n', '\n')).lf, 1)
})

test('before launch: an LF-only map is moved aside with its own tag and the reason', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'controlmap-test-'))
  const game = path.join(root, 'skyrim')
  const custom = path.join(game, 'ControlMap_Custom.txt')
  put(custom, full.replace(/\r\n/g, '\n'))
  put(path.join(game, 'Data', DATA_REL), full)
  const lines = cm.checkControlmaps({ gameDir: game, now })
  assert.match(lines[0], /has 18 of 18 contexts \(\d+ line\(s\) end in LF only, the game's own map uses CRLF\), moved aside to ControlMap_Custom\.txt\.lf-20260929T160000Z$/)
  assert.match(lines[1], /controlmap\.txt has 18 of 18 contexts$/)
  assert.ok(!fs.existsSync(custom))
  fs.rmSync(root, { recursive: true, force: true })
})
