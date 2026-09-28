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

test('collect() sends CommunityShaders.log with both ends kept and the account name left out', () => {
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'report-test-'))
  const dir = path.join(docs, 'My Games', 'Skyrim Special Edition', 'SKSE')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = i => `[2026-09-28 21:15:${String(i % 60).padStart(2, '0')}.000] [info] [4120]`
  const lines = [
    `${stamp(0)} [XSEPlugin.cpp:50] Loaded plugin CommunityShaders 1.9.1`,
    `${stamp(1)} [State.cpp:390] Loading settings from C:\\Users\\Arvel\\Documents\\My Games\\Skyrim Special Edition\\SKSE`,
    `${stamp(2)} [SettingsOverrideManager.cpp:191] Applied global override from DragonBreak`,
  ]
  for (let i = 0; i < 3000; i++) lines.push(`${stamp(i)} [ShaderCache.cpp:900] Compiling shader ${i} of 3000 for Lighting`)
  lines.push(`${stamp(59)} [ShaderCache.cpp:950] Finished compiling 3000 shaders`)
  fs.writeFileSync(path.join(dir, 'CommunityShaders.log'), lines.join('\r\n'))
  const out = collect({ userDataDir: docs, documentsDir: docs })
  assert.match(out.csLog, /^\[2026-09-28 21:15:00\.000\] .*Loaded plugin CommunityShaders 1\.9\.1/)
  assert.match(out.csLog, /Applied global override from DragonBreak/)
  assert.match(out.csLog, /\[middle lines cut\]/)
  assert.match(out.csLog, /Finished compiling 3000 shaders$/)
  assert.match(out.csLog, /C:\\Users\\<user>\\Documents/)
  assert.doesNotMatch(out.csLog, /Arvel/)
  assert.ok(Buffer.byteLength(out.csLog) <= 64 * 1024 + 64, `${Buffer.byteLength(out.csLog)} bytes`)
  fs.rmSync(docs, { recursive: true, force: true })
})

test('a short CommunityShaders.log is sent whole', () => {
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'report-test-'))
  const dir = path.join(docs, 'My Games', 'Skyrim Special Edition', 'SKSE')
  fs.mkdirSync(dir, { recursive: true })
  const log = '[2026-09-28 21:15:00.000] [info] [4120] [XSEPlugin.cpp:50] Loaded plugin CommunityShaders 1.9.1\r\n'
    + '[2026-09-28 21:15:01.000] [info] [4120] [State.cpp:404] Applied 1 global override(s)'
  fs.writeFileSync(path.join(dir, 'CommunityShaders.log'), log)
  const out = collect({ userDataDir: docs, documentsDir: docs })
  assert.strictEqual(out.csLog, log)
  fs.rmSync(docs, { recursive: true, force: true })
})
