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

// SkyrimPlatform writes its one-time input diagnostics at the start of a session and the failure at the end;
// a report that kept only the end lost "menu cursor at ..." for a player whose menu cursor was pinned
function platformLog(dir, middleLines, uiEvery) {
  const lines = [
    '[01:30:00:000] platform_se v2.9.0',
    '[01:30:05:000] InputDiag: the game reads the mouse\'s state (GetDeviceState, 20 bytes)',
    '[01:30:06:000] InputDiag: menu cursor at 960,540, safe zone 15,15, screen 1920x1080, sensitivity 1, default speed 1, shown 1 (INI fSafeZoneX 15, fSafeZoneY 15)',
  ]
  for (let i = 0; i < middleLines; i++) {
    lines.push(uiEvery && i % uiEvery === 0
      ? `[01:31:00:000] JS window.__alduinakAddChat("Arvel: line ${i}") ...`
      : `[01:31:00:000] onResult called ${i}`)
  }
  lines.push('[01:47:24:051] the last line before the crash')
  fs.writeFileSync(path.join(dir, 'skyrim-platform.log'), lines.join('\r\n'))
}

function reportDir() {
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'report-test-'))
  const dir = path.join(docs, 'My Games', 'Skyrim Special Edition', 'SKSE')
  fs.mkdirSync(dir, { recursive: true })
  return { docs, dir }
}

test('a long skyrim-platform.log keeps its start (the one-time diagnostics) and its end', () => {
  const { docs, dir } = reportDir()
  platformLog(dir, 40000, 7)
  assert.ok(fs.statSync(path.join(dir, 'skyrim-platform.log')).size > 6 * 80 * 1024)
  const out = collect({ userDataDir: docs, documentsDir: docs })
  assert.match(out.gameLog, /^\[01:30:00:000\] platform_se v2\.9\.0/)
  assert.match(out.gameLog, /InputDiag: menu cursor at 960,540, safe zone 15,15/)
  assert.match(out.gameLog, /\[middle lines cut\]\n/)
  assert.match(out.gameLog, /the last line before the crash$/)
  assert.doesNotMatch(out.gameLog, /Arvel|__alduinakAddChat/)
  assert.strictEqual(out.gameLog.split('[middle lines cut]').length, 2)
  assert.ok(Buffer.byteLength(out.gameLog) <= 80 * 1024 + 64, `${Buffer.byteLength(out.gameLog)} bytes`)
  fs.rmSync(docs, { recursive: true, force: true })
})

test('a mid-sized skyrim-platform.log is cut after its UI lines are left out, at line ends', () => {
  const { docs, dir } = reportDir()
  platformLog(dir, 6000, 3)
  const out = collect({ userDataDir: docs, documentsDir: docs })
  assert.match(out.gameLog, /InputDiag: menu cursor at 960,540/)
  assert.match(out.gameLog, /the last line before the crash$/)
  assert.doesNotMatch(out.gameLog, /Arvel/)
  const [head, rest] = out.gameLog.split('[middle lines cut]\n')
  assert.ok(rest !== undefined, 'both ends kept')
  assert.match(head, /\n$/)
  assert.match(rest, /^(\[\d\d:\d\d:\d\d:\d{3}\]|\[\d+ UI line)/)
  fs.rmSync(docs, { recursive: true, force: true })
})

test('a short skyrim-platform.log is sent whole, UI lines still left out', () => {
  const { docs, dir } = reportDir()
  platformLog(dir, 20, 5)
  const out = collect({ userDataDir: docs, documentsDir: docs })
  assert.doesNotMatch(out.gameLog, /middle lines cut|Arvel/)
  assert.match(out.gameLog, /^\[01:30:00:000\] platform_se v2\.9\.0[\s\S]*the last line before the crash$/)
  fs.rmSync(docs, { recursive: true, force: true })
})
