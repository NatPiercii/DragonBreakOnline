'use strict'
// Steam's 1.7.99 changed the masters and archives but not SkyrimSE.exe, so a 1.6.1170 exe on newer data passes the
// version gate (new players, 2026-09-29). checkGameData names which it is for the log and reports; nothing blocks on it.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { checkGameData, DATA_SIZES_1170 } = require('../src/gameversion')

// Sparse files of a given size: instant, and no disk used
function sized(file, size) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.closeSync(fs.openSync(file, 'w'))
  fs.truncateSync(file, size)
}

function game(sizes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'game-data-test-'))
  for (const [name, size] of Object.entries(sizes)) sized(path.join(dir, 'Data', name), size)
  return dir
}

const all1170 = Object.fromEntries(DATA_SIZES_1170)

test('every file at its 1.6.1170 size is 1.6.1170 data', () => {
  const dir = game(all1170)
  const r = checkGameData(dir, 'Steam')
  assert.deepStrictEqual([r.verdict, r.differ, r.missing], ['1.6.1170 data', [], []])
  assert.strictEqual(r.text, '1.6.1170 data: Skyrim.esm 249753412, Update.esm 18874041, Skyrim - Interface.bsa 105799354, Skyrim - Misc.bsa 17713449')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the newer Interface archive under the 1.6.1170 exe is newer data, and names the file', () => {
  const dir = game({ ...all1170, 'Skyrim - Interface.bsa': 106921425 })
  const r = checkGameData(dir, 'Steam')
  assert.deepStrictEqual([r.verdict, r.differ], ['newer data (1.7.99+)', ['Skyrim - Interface.bsa']])
  assert.match(r.text, /Skyrim - Interface\.bsa 106921425/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a missing file, or a GOG install off the Steam sizes, is unknown', () => {
  const partial = { ...all1170 }
  delete partial['Update.esm']
  let dir = game(partial)
  let r = checkGameData(dir, 'Steam')
  assert.deepStrictEqual([r.verdict, r.missing], ['unknown', ['Update.esm']])
  assert.match(r.text, /Update\.esm missing/)
  fs.rmSync(dir, { recursive: true, force: true })
  dir = game({ ...all1170, 'Skyrim.esm': 249000000 })
  assert.strictEqual(checkGameData(dir, 'GOG').verdict, 'unknown')
  assert.strictEqual(checkGameData(dir, 'Steam').verdict, 'newer data (1.7.99+)')
  fs.rmSync(dir, { recursive: true, force: true })
})
