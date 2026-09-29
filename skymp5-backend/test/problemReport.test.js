'use strict'
const test = require('node:test')
const assert = require('node:assert')

// problemReport files through Discord; the poster and config are stubbed so submit() runs alone
const stub = (rel, exports) => {
  const file = require.resolve(rel)
  require.cache[file] = { id: file, filename: file, loaded: true, exports }
}
stub('../config', { discordErrorForumChannelId: '1' })
let posted = null
stub('../sources/discord/errorReport', { postReport: async (report) => { posted = report; return 'T1' } })
stub('../sources/discord/audit', { log: () => {} })
const { submit } = require('../sources/problemReport')

test('the game UI lines are left out of every log a report carries', async () => {
  const ui = '[10:00:01:000] JS window.__alduinakAddChat("[PM] Brelyna: the key is under the mat") ...'
  const body = {
    reportId: 'test-every-field-0001',
    launcherLog: 'launcher starting',
    // A pre-release launcher (8a9c6c94) sent the platform log as clientLog
    clientLog: `[10:00:00:000] boot\n${ui}\n[10:00:02:000] crash here`,
    gameLog: `[10:00:00:000] boot\n${ui}`,
    skseLog: 'plugin SkyrimPlatform.dll loaded correctly',
  }
  const result = await submit({ name: 'Tester', verified: true, profileId: 5 }, body)
  assert.strictEqual(result.status, 200)
  const texts = Object.fromEntries(posted.files.map(f => [f.name, f.text]))
  for (const [name, text] of Object.entries(texts)) assert.doesNotMatch(text, /Brelyna|__alduinakAddChat/, name)
  assert.match(texts['client.log'], /\[1 UI line\(s\) left out\]\n\[10:00:02:000\] crash here/)
  assert.strictEqual(texts['skse64.log'], body.skseLog)
})

test('a report asks for Manual, plus Launcher when it comes from the launcher', async () => {
  const sources = { launcher: ['Manual', 'Launcher'], site: ['Manual'], game: ['Manual'], other: ['Manual', 'Launcher'] }
  for (const [source, tags] of Object.entries(sources)) {
    const result = await submit({ name: 'Tester', verified: true, profileId: 5 }, { reportId: `test-tags-${source}-01`, note: 'it broke', source })
    assert.strictEqual(result.status, 200)
    assert.deepStrictEqual(posted.tags, tags, source)
  }
})

test('CommunityShaders.log is scrubbed and keeps both ends', async () => {
  const stamp = i => `[2026-09-28 21:15:${String(i % 60).padStart(2, '0')}.000] [info] [4120]`
  const lines = [
    `${stamp(0)} [XSEPlugin.cpp:50] Loaded plugin CommunityShaders 1.9.1`,
    `${stamp(1)} [State.cpp:390] Loading settings from C:\\Users\\Arvel\\Documents\\My Games\\Skyrim Special Edition\\SKSE`,
    `${stamp(2)} [SettingsOverrideManager.cpp:191] Applied global override from DragonBreak`,
  ]
  for (let i = 0; i < 3000; i++) lines.push(`${stamp(i)} [ShaderCache.cpp:900] Compiling shader ${i} of 3000 for Lighting`)
  lines.push(`${stamp(59)} [Util.cpp:77] Update check to 203.0.113.9 failed`)
  const body = { reportId: 'test-community-shaders-01', launcherLog: 'launcher starting', csLog: lines.join('\r\n') }
  const result = await submit({ name: 'Tester', verified: true, profileId: 5 }, body)
  assert.strictEqual(result.status, 200)
  const cs = posted.files.find(f => f.name === 'CommunityShaders.log')
  assert.ok(cs, 'attached as CommunityShaders.log')
  assert.match(cs.text, /^\[2026-09-28 21:15:00\.000\] .*Loaded plugin CommunityShaders 1\.9\.1/)
  assert.match(cs.text, /Applied global override from DragonBreak/)
  assert.match(cs.text, /\[middle lines cut to fit the upload limit\]/)
  assert.match(cs.text, /Update check to <ip> failed$/)
  assert.match(cs.text, /C:\\Users\\<user>\\Documents/)
  assert.doesNotMatch(cs.text, /Arvel|203\.0\.113\.9|\r/)
  assert.ok(Buffer.byteLength(cs.text) <= 64 * 1024 + 64, `${Buffer.byteLength(cs.text)} bytes`)
  assert.match(posted.summary, /_2 log file\(s\), \d+ redaction\(s\)/)
})

test('a short CommunityShaders.log is posted whole', async () => {
  const csLog = '[2026-09-28 21:15:00.000] [info] [4120] [State.cpp:404] Applied 1 global override(s)'
  const result = await submit({ name: 'Tester', verified: true, profileId: 5 }, { reportId: 'test-community-shaders-02', csLog })
  assert.strictEqual(result.status, 200)
  assert.deepStrictEqual(posted.files, [{ name: 'CommunityShaders.log', text: csLog }])
})

// Launcher 2.1.34 sends the newest Crash Logger log of the last day with Report a Problem (GroundedPasta and Onny,
// 2026-09-29: their crash logs never left their PCs)
test('a crash log is scrubbed and posted as crash.log', async () => {
  const crashLog = [
    '[crash-2026-09-29-15-47-26.log, 29 KB, written 12 min before this report, from Documents]',
    'Skyrim SSE v1.6.1170',
    'Unhandled exception "EXCEPTION_ACCESS_VIOLATION" at 0x7FF6D2A1B2C3 SkyrimSE.exe+0x6B2C3',
    'PROBABLE CALL STACK:',
    '\t[  0] 0x7FF6D2A1B2C3 SkyrimSE.exe+0x6B2C3',
    'MODULES:',
    '\tSkyrimPlatformImpl.dll 0x7FF900000000 C:\\Users\\Arvel\\AppData\\Local\\DragonBreak\\skyrim\\Data',
    '\tnet: 203.0.113.9',
  ].join('\r\n')
  const result = await submit({ name: 'Tester', verified: true, profileId: 30 }, { reportId: 'test-crash-log-01', launcherLog: 'launcher starting', crashLog })
  assert.strictEqual(result.status, 200)
  const crash = posted.files.find(f => f.name === 'crash.log')
  assert.ok(crash, 'attached as crash.log')
  assert.match(crash.text, /^\[crash-2026-09-29-15-47-26\.log, 29 KB/)
  assert.match(crash.text, /Unhandled exception "EXCEPTION_ACCESS_VIOLATION" at 0x7FF6D2A1B2C3 SkyrimSE\.exe\+0x6B2C3/)
  assert.match(crash.text, /C:\\Users\\<user>\\AppData/)
  assert.doesNotMatch(crash.text, /Arvel|203\.0\.113\.9|\r/)
  assert.match(posted.summary, /_2 log file\(s\), \d+ redaction\(s\)/)
})

test('a crash log longer than the launcher sends keeps its head, where the exception is', async () => {
  const lines = ['Unhandled exception "EXCEPTION_ACCESS_VIOLATION" at 0x7FF6D2A1B2C3 SkyrimSE.exe+0x6B2C3', 'PROBABLE CALL STACK:']
  for (let i = 0; i < 20000; i++) lines.push(`\t[${i}] 0x7FF6D2A1B2C3 SkyrimSE.exe+0x${i.toString(16)}`)
  const result = await submit({ name: 'Tester', verified: true, profileId: 30 }, { reportId: 'test-crash-log-02', crashLog: lines.join('\n') })
  assert.strictEqual(result.status, 200)
  const crash = posted.files.find(f => f.name === 'crash.log')
  assert.match(crash.text, /^Unhandled exception "EXCEPTION_ACCESS_VIOLATION"/)
  assert.match(crash.text, /\[middle lines cut to fit the upload limit\]/)
  assert.ok(Buffer.byteLength(crash.text) <= 64 * 1024 + 64, `${Buffer.byteLength(crash.text)} bytes`)
})
