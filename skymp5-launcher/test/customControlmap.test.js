'use strict'
// A ControlMap_Custom.txt from before 1.6.1130 (no PurchaseCredits) is moved aside before launch; a current one stays
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { moveStaleCustomControlmap, isStaleCustomControlmap } = require('../src/customControlmap')

const game = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-controlmap-test-'))
const file = path.join(game, 'ControlMap_Custom.txt')
const now = new Date('2026-09-29T05:00:00.456Z')
const seed = fs.readFileSync(path.join(__dirname, '..', 'assets', 'controlmap.txt'), 'utf8')
// The same map without the Creations Menu context, as a pre-1.6.1130 game wrote it
const old = seed.split(/\r?\n/).filter(l => !/^PurchaseCredits\s/.test(l)).join('\r\n')

test('the seed passes as current, and a map without PurchaseCredits is stale', () => {
  assert.ok(!isStaleCustomControlmap(seed))
  assert.ok(isStaleCustomControlmap(old))
  assert.ok(isStaleCustomControlmap(''))
  // Only a line of its own counts, not a mention in a comment
  assert.ok(isStaleCustomControlmap('// PurchaseCredits was added in 1.6.1130\r\nForward\t0x11\t0xff\t0xff\t0\t0\t0\t0x801'))
})

test('no file: nothing to do', () => {
  assert.deepStrictEqual(moveStaleCustomControlmap(game, now), [])
  assert.deepStrictEqual(moveStaleCustomControlmap('', now), [])
})

test('a current map is the player\'s and stays', () => {
  fs.writeFileSync(file, seed)
  assert.deepStrictEqual(moveStaleCustomControlmap(game, now), [])
  assert.strictEqual(fs.readFileSync(file, 'utf8'), seed)
  fs.rmSync(file)
})

test('a stale map is moved aside, kept whole, and a second one gets its own name', () => {
  fs.writeFileSync(file, old)
  assert.deepStrictEqual(moveStaleCustomControlmap(game, now), [
    'moved a ControlMap_Custom.txt from before the 1.6.1130 controls (no PurchaseCredits) aside to ' +
      'ControlMap_Custom.txt.stale-20260929T050000Z',
  ])
  assert.ok(!fs.existsSync(file))
  assert.strictEqual(fs.readFileSync(`${file}.stale-20260929T050000Z`, 'utf8'), old)
  fs.writeFileSync(file, old)
  assert.match(moveStaleCustomControlmap(game, now)[0], /aside to ControlMap_Custom\.txt\.stale-20260929T050000Z-2$/)
  assert.deepStrictEqual(moveStaleCustomControlmap(game, now), [])
  fs.rmSync(game, { recursive: true, force: true })
})
