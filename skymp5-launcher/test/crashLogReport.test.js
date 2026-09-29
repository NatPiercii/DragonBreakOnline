'use strict'
// Report a Problem sends the newest Crash Logger crash-*.log of the last day, from Documents or MO2's overwrite\SKSE,
// condensed to what names the crash and with the account name left out (GroundedPasta and Onny, 2026-09-29: their
// crash logs sat on disk all day while the reports only said one existed)
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { collect, condenseCrashLog } = require('../src/report')

const now = Date.parse('2026-09-29T16:00:00Z')

function crashLog({ stackLines = 120, modules = 300, plugins = 105, user = 'Arvel' } = {}) {
  const lines = [
    'Skyrim SSE v1.6.1170',
    'CrashLoggerSSE v1-17-0-0 Jul 10 2025 18:39:00',
    '',
    'Unhandled exception "EXCEPTION_ACCESS_VIOLATION" at 0x7FF6D2A1B2C3 SkyrimSE.exe+0x6B2C3\tmov rax, [rcx+0x10]',
    '',
    'SYSTEM SPECS:',
    '\tOS: Microsoft Windows 11 Pro v10.0.26200',
    '\tCPU: AuthenticAMD AMD Ryzen 7 5800X3D 8-Core Processor',
    '',
    'PROBABLE CALL STACK:',
  ]
  for (let i = 0; i < stackLines; i++) lines.push(`\t[${String(i).padStart(3)}] 0x7FF6D2A1B2C3 SkyrimSE.exe+0x${(0x6B2C3 + i).toString(16)}`)
  lines.push('', 'REGISTERS:')
  for (let i = 0; i < 16; i++) lines.push(`\tR${i}X 0x0 (size_t) [0]`)
  lines.push('', 'STACK:')
  for (let i = 0; i < 400; i++) lines.push(`\t[RSP+${i * 8}] 0x0 (size_t) [0]`)
  lines.push('', 'MODULES:')
  for (let i = 0; i < modules; i++) lines.push(`\tmodule${i}.dll 0x7FF800000000`)
  lines.push(`\tSkyrimPlatformImpl.dll 0x7FF900000000 C:\\Users\\${user}\\AppData\\Local\\DragonBreak\\skyrim\\Data\\Platform\\Distribution\\RuntimeDependencies`)
  lines.push('', 'SKSE PLUGINS:')
  lines.push('\tSkyrimPlatform.dll v2.9.0', '\tCommunityShaders.dll v1.8.3')
  lines.push('', 'PLUGINS:')
  for (let i = 0; i < plugins; i++) lines.push(`\t[${i.toString(16).toUpperCase().padStart(2, '0')}] Plugin${i}.esp`)
  return lines.join('\r\n')
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-report-test-'))
  const docs = path.join(root, 'Documents')
  const skse = path.join(docs, 'My Games', 'Skyrim Special Edition', 'SKSE')
  const mo2 = path.join(root, 'MO2')
  fs.mkdirSync(skse, { recursive: true })
  fs.mkdirSync(path.join(mo2, 'overwrite', 'SKSE'), { recursive: true })
  return { root, docs, skse, mo2 }
}

function put(file, text, minutesAgo) {
  fs.writeFileSync(file, text)
  const t = new Date(now - minutesAgo * 60000)
  fs.utimesSync(file, t, t)
}

test('the newest crash log of the last day is sent, condensed, without the account name', () => {
  const { root, docs, skse, mo2 } = setup()
  put(path.join(skse, 'crash-2026-09-29-15-47-26.log'), crashLog(), 12)
  const out = collect({ userDataDir: root, documentsDir: docs, mo2Root: mo2, now })
  assert.match(out.crashLog, /^\[crash-2026-09-29-15-47-26\.log, \d+ KB, written 12 min before this report, from Documents\]\n/)
  assert.match(out.crashLog, /Unhandled exception "EXCEPTION_ACCESS_VIOLATION" at 0x7FF6D2A1B2C3 SkyrimSE\.exe\+0x6B2C3/)
  assert.match(out.crashLog, /PROBABLE CALL STACK:\n(\t\[ *\d+\] .*\n){60}\t\[60 more line\(s\) cut\]/)
  assert.match(out.crashLog, /STACK:\n(\t\[RSP.*\n){30}\t\[370 more line\(s\) cut\]/)
  assert.match(out.crashLog, /SKSE PLUGINS:\n\tSkyrimPlatform\.dll v2\.9\.0\n\tCommunityShaders\.dll v1\.8\.3/)
  assert.match(out.crashLog, /PLUGINS:\n\t\[105 more line\(s\) cut\]$/)
  assert.doesNotMatch(out.crashLog, /Arvel/)
  fs.rmSync(root, { recursive: true, force: true })
})

test("MO2's overwrite\\SKSE is searched too, and the newer file wins", () => {
  const { root, docs, skse, mo2 } = setup()
  put(path.join(skse, 'crash-2026-09-29-14-00-00.log'), crashLog(), 120)
  put(path.join(mo2, 'overwrite', 'SKSE', 'crash-2026-09-29-15-30-00.log'), crashLog(), 30)
  const out = collect({ userDataDir: root, documentsDir: docs, mo2Root: mo2, now })
  assert.match(out.crashLog, /^\[crash-2026-09-29-15-30-00\.log, .* from MO2 overwrite\]/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('no crash log, or only one older than a day: nothing is sent for it', () => {
  const { root, docs, skse, mo2 } = setup()
  assert.strictEqual(collect({ userDataDir: root, documentsDir: docs, mo2Root: mo2, now }).crashLog, undefined)
  put(path.join(skse, 'crash-2026-09-27-10-00-00.log'), crashLog(), 26 * 60)
  put(path.join(skse, 'CrashLogger.log'), 'not a crash log', 1)
  assert.strictEqual(collect({ userDataDir: root, documentsDir: docs, mo2Root: mo2, now }).crashLog, undefined)
  assert.strictEqual(collect({ userDataDir: root, documentsDir: docs, now }).crashLog, undefined)
  fs.rmSync(root, { recursive: true, force: true })
})

test('a crash log is capped at 48 KB whatever its sections hold', () => {
  const huge = crashLog({ stackLines: 60 }).replace(/\r\n/g, '\n').split('\n').map(l => l + 'x'.repeat(900)).join('\n')
  const out = condenseCrashLog(huge)
  assert.ok(Buffer.byteLength(out) <= 48 * 1024 + 16, `${Buffer.byteLength(out)} bytes`)
  assert.match(out, /\[rest cut\]$/)
  assert.match(out, /^Skyrim SSE v1\.6\.1170/)
})

test('a short crash log is kept whole', () => {
  const short = 'Skyrim SSE v1.6.1170\nUnhandled exception at SkyrimSE.exe+0x1\n\nPROBABLE CALL STACK:\n\t[ 0] SkyrimSE.exe+0x1'
  assert.strictEqual(condenseCrashLog(short), short)
})
