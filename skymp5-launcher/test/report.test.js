'use strict'
// Report a Problem's game log: the UI's JS and LoadUrl lines (chat, names, the voice link) never leave the machine
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { collect, dropUiLines } = require('../src/report')

test('JS and LoadUrl lines are replaced by a count', () => {
  const log = [
    '[10:00:00:000] SkyrimPlatform loaded',
    '[10:00:01:120] JS window.__alduinakAddChat("Arvel: meet me at the inn") ...',
    '[10:00:01:130] JS window.__alduinakAddChat("[PM] Brelyna: the key is under the mat") ...',
    '[10:00:03:000] [Exception] TypeError: x is undefined',
  ].join('\r\n')
  const out = dropUiLines(log)
  assert.doesNotMatch(out, /Arvel|Brelyna/)
  assert.match(out, /\[2 UI line\(s\) left out\]\n\[10:00:03:000\] \[Exception\]/)
})

test('a LoadUrl whose URL holds newlines is left out whole, up to the next record', () => {
  const log = [
    '[10:00:01:000] LoadUrl file:///index.html?voice=wss://example/room',
    'name=Arvel&pm=meet me at the inn',
    'token-part-two',
    '[10:00:02:000] [Exception] TypeError: x is undefined',
    '    at render (build.js:1:2)',
  ].join('\n')
  const out = dropUiLines(log)
  assert.doesNotMatch(out, /Arvel|token-part-two|voice=/)
  assert.match(out, /^\[3 UI line\(s\) left out\]\n\[10:00:02:000\]/)
  assert.match(out, /at render \(build\.js:1:2\)$/)
})

test('collect() reads far enough back that UI lines cannot crowd out the rest', () => {
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'report-test-'))
  const dir = path.join(docs, 'My Games', 'Skyrim Special Edition', 'SKSE')
  fs.mkdirSync(dir, { recursive: true })
  const lines = ['[09:00:00:000] [Exception] the error staff need']
  for (let i = 0; i < 2500; i++) lines.push(`[09:00:01:${String(i % 1000).padStart(3, '0')}] JS window.__alduinakAddChat("Arvel: line ${i} of our conversation") ...`)
  lines.push('[09:10:00:000] last line')
  fs.writeFileSync(path.join(dir, 'skyrim-platform.log'), lines.join('\r\n'))
  const out = collect({ userDataDir: docs, documentsDir: docs })
  assert.doesNotMatch(out.gameLog, /Arvel|__alduinakAddChat/)
  assert.match(out.gameLog, /the error staff need/)
  assert.match(out.gameLog, /\[2500 UI line\(s\) left out\]/)
  fs.rmSync(docs, { recursive: true, force: true })
})
