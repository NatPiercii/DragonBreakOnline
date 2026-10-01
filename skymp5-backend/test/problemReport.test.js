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

// The hardware a crash happened on (launcher 2.1.36 sends it; fee884b3). Every one goes through the same
// text() + scrub(300) path as the older context fields, so these tests pin that a scalar arrives, a non-scalar is
// dropped, a long value is cut, a path is redacted, and nothing outside CONTEXT_FIELDS is ever repeated.
const HW = { reportId: 'test-hardware-0001', launcherLog: 'launcher starting' }

test('the hardware fields reach the report', async () => {
  const body = { ...HW, ramGb: 32, ramFreeGb: 11, cpu: 'AMD Ryzen 7 5800X x 16 cores', gpu: 'NVIDIA RTX 4070 8 GB+' }
  const result = await submit({ name: 'Tester', verified: true, profileId: 5 }, body)
  assert.strictEqual(result.status, 200)
  assert.match(posted.summary, /ramGb: 32/)
  assert.match(posted.summary, /ramFreeGb: 11/)
  assert.match(posted.summary, /cpu: AMD Ryzen 7 5800X x 16 cores/)
  assert.match(posted.summary, /gpu: NVIDIA RTX 4070 8 GB\+/)
})

test('a non-scalar hardware value is dropped, not stringified', async () => {
  const body = { ...HW, reportId: 'test-hardware-0002', ramGb: { evil: 1 }, cpu: ['a', 'b'], gpu: null }
  const result = await submit({ name: 'Tester', verified: true, profileId: 5 }, body)
  assert.strictEqual(result.status, 200)
  assert.doesNotMatch(posted.summary, /ramGb:/)
  assert.doesNotMatch(posted.summary, /cpu:/)
  assert.doesNotMatch(posted.summary, /gpu:/)
  assert.doesNotMatch(posted.summary, /\[object Object\]|evil/)
})

test('a long hardware value is cut, so one field cannot fill the message', async () => {
  const body = { ...HW, reportId: 'test-hardware-0003', gpu: 'G'.repeat(4000) }
  const result = await submit({ name: 'Tester', verified: true, profileId: 5 }, body)
  assert.strictEqual(result.status, 200)
  const line = posted.summary.split('\n').find(l => l.startsWith('gpu: '))
  assert.ok(line, 'no gpu line')
  assert.ok(line.length < 400, `gpu line is ${line.length} chars, the 300 cap did not apply`)
})

test('a path in a hardware value is redacted like any other field', async () => {
  const body = { ...HW, reportId: 'test-hardware-0004', cpu: 'CPU at C:\\Users\\Arvel\\Documents x 8 cores' }
  const result = await submit({ name: 'Tester', verified: true, profileId: 5 }, body)
  assert.strictEqual(result.status, 200)
  assert.doesNotMatch(posted.summary, /Arvel/)
})

test('a field outside CONTEXT_FIELDS is never repeated, however it is named', async () => {
  const body = { ...HW, reportId: 'test-hardware-0005', ram: 32, gpuDriver: 'secret', sessionToken: 'abc123',
                 discordUsername: 'should-not-be-echoed-as-a-context-field' }
  const result = await submit({ name: 'Tester', verified: true, profileId: 5 }, body)
  assert.strictEqual(result.status, 200)
  assert.doesNotMatch(posted.summary, /sessionToken|abc123/)
  assert.doesNotMatch(posted.summary, /gpuDriver/)
  assert.doesNotMatch(posted.summary, /^ram: /m)
})

// Launcher 2.1.34 condenses a crash log to 48 KB, but the server takes whatever is sent. A 64 KB one is over the
// 56 + 8 KB the server keeps, so it loses its middle, and both kept ends are scrubbed by the same rules as every
// other log (scrub-rules.json S3-S10 and scrubLog's own IP rules) before the cut.
test('a 64 KB crash log keeps its head and tail, and both ends are scrubbed', async () => {
  const { MAX_BYTES } = require('../sources/scrubLog')
  const CUT = '[middle lines cut to fit the upload limit]'
  // The known fake bot token of the S9 fixture in fixtures/auto-report/scrub-cases.json
  const botToken = 'ZmFrZS1ub3QtYS1yZWFsLXRva2Vu.GAbCdE.abcdefghijklmnopqrstuvwxyz012345'
  // [as sent, as it must be posted]
  const head = [
    ['[crash-2026-09-30-19-02-11.log, 64 KB, written 3 min before this report, from Documents]'],
    ['Skyrim SSE v1.6.1170'],
    ['Unhandled exception "EXCEPTION_ACCESS_VIOLATION" at 0x7FF6D2A1B2C3 SkyrimSE.exe+0x6B2C3'],
    ['\tSkyrimPlatformImpl.dll v2.9.0 C:\\Users\\Arvel\\AppData\\Local\\DragonBreak\\skyrim\\Data',
     '\tSkyrimPlatformImpl.dll v2.9.0 C:\\Users\\<user>\\AppData\\Local\\DragonBreak\\skyrim\\Data'],
    ['\tmaster 198.51.100.23:7777, auth Bearer fakeBearerValue0123456789', '\tmaster <ip>:7777, auth Bearer <redacted>'],
    [`\tbot ${botToken}`, '\tbot <token-redacted>'],
    ['PROBABLE CALL STACK:'],
  ]
  const tail = [
    ['MODULES:'],
    ['\tcrash log in C:\\Users\\Arvel\\Documents\\My Games\\Skyrim Special Edition\\SKSE',
     '\tcrash log in C:\\Users\\<user>\\Documents\\My Games\\Skyrim Special Edition\\SKSE'],
    ['\tpeer 2001:db8:85a3::8a2e:370:7334, sessionToken=fake0session0value0abc', '\tpeer <ip>, sessionToken=<redacted>'],
    ['\thwid 0123456789abcdef0123456789abcdef01234567', '\thwid 01234567<redacted>'],
    [`\tstill ${botToken}`, '\tstill <token-redacted>'],
    ['\tKERNELBASE.dll 0x7FFA10000000 (the last line)'],
  ]
  const frame = i => `\t[${String(i).padStart(4, ' ')}] 0x7FF6D2A1B2C3 SkyrimSE.exe+0x${i.toString(16).padStart(5, '0')}`
  const frames = []
  const size = () => Buffer.byteLength([...head, ...frames, ...tail].map(([sent]) => sent).join('\n'))
  // 64 KB and a little over, so the log is still over 56 + 8 KB once the scrub has shortened it
  while (size() < 64 * 1024 + 512) frames.push([frame(frames.length)])
  const crashLog = [...head, ...frames, ...tail].map(([sent]) => sent).join('\n')
  assert.ok(Buffer.byteLength(crashLog) >= 64 * 1024 && Buffer.byteLength(crashLog) < 65 * 1024, `${Buffer.byteLength(crashLog)} bytes`)

  const result = await submit({ name: 'Tester', verified: true, profileId: 30 }, { reportId: 'test-crash-log-64k', launcherLog: 'launcher starting', crashLog })
  assert.strictEqual(result.status, 200)
  const crash = posted.files.filter(f => f.name === 'crash.log')
  assert.strictEqual(crash.length, 1, 'one crash.log')
  const out = crash[0].text
  const lines = out.split('\n')

  // Trimmed: one cut, the middle frames gone, and no more than 56 + 8 KB plus the marker, well inside MAX_BYTES
  assert.strictEqual(lines.filter(l => l === CUT).length, 1, 'one cut marker')
  // The frames either side of the marker are the last whole one of the first 56 KB and the first of the last 8 KB
  const at = lines.indexOf(CUT)
  const before = frames.findIndex(([sent]) => sent === lines[at - 1])
  const after = frames.findIndex(([sent]) => sent === lines[at + 1])
  assert.ok(before > 0 && after > before + 1, `frames ${before} and ${after} either side of the cut`)
  assert.strictEqual(lines.length, head.length + before + 1 + 1 + (frames.length - after) + tail.length)
  assert.ok(Buffer.byteLength(out) <= 64 * 1024 + CUT.length + 1, `${Buffer.byteLength(out)} bytes`)
  assert.ok(Buffer.byteLength(out) <= MAX_BYTES)
  // The head, where the exception and the call stack are, and the tail are both there, scrubbed, as whole lines
  const posts = ([sent, scrubbed = sent]) => scrubbed
  assert.deepStrictEqual(lines.slice(0, head.length + 1), [...head.map(posts), frame(0)])
  assert.deepStrictEqual(lines.slice(-tail.length), tail.map(posts))
  const whole = new Set([...head, ...frames, ...tail].map(posts).concat(CUT))
  for (const line of lines) assert.ok(whole.has(line), `a cut or unscrubbed line: ${JSON.stringify(line)}`)
  // Scrubbed: the account name in a path, the IPv4 and IPv6 addresses and every token-shaped string
  const leaks = /Arvel|198\.51\.100\.23|2001:db8|fakeBearerValue|fake0session0value0abc|0123456789abcdef0123|ZmFrZS1ub3Qt|\r/
  assert.doesNotMatch(out, leaks)
  assert.doesNotMatch(posted.summary, leaks)
  const counted = Number(posted.summary.match(/_2 log file\(s\), (\d+) redaction\(s\)/)[1])
  assert.ok(counted >= 9, `${counted} redactions`)
})

// Launcher 2.1.36 condenses a crash log by line counts only, so REGISTERS and STACK arrive with the names and strings
// Crash Logger read from memory (privacy review, 30 Sep). The server keeps what staff need and none of that
// (crashLogFilter.js, docs/auto-report-v1.md §2.4 and §2.10).
test('a crash log reaches staff without the names and strings Crash Logger read from memory', async () => {
  const { crashLog, SECRETS, jwt } = require('./helpers/crashLogFixture')
  const body = {
    reportId: 'test-crash-log-memory', launcherLog: 'launcher starting', crashLog: crashLog(),
    error: `voice failed with ${jwt}`, note: `crashed in Whiterun, my voice token was ${jwt}`,
  }
  const result = await submit({ name: 'Tester', verified: true, profileId: 30 }, body)
  assert.strictEqual(result.status, 200)
  const crash = posted.files.find(f => f.name === 'crash.log')
  assert.ok(crash, 'attached as crash.log')
  for (const [label, value] of Object.entries(SECRETS)) {
    assert.ok(!crash.text.includes(value), `${label} left in crash.log`)
    assert.ok(!posted.summary.includes(value), `${label} left in the summary`)
  }
  assert.doesNotMatch(crash.text, /\(char\*\) "[^"]|\[RSP\+|\r/)
  // What staff need is all there
  assert.match(crash.text, /^\[crash-2026-10-01-14-22-07\.log, 214 KB, written 2 min before this report, from Documents\]\n/)
  assert.match(crash.text, /\nUnhandled exception "EXCEPTION_ACCESS_VIOLATION" at 0x7FF6D2A1B2C3 SkyrimSE\.exe\+06B2C3\t/)
  assert.match(crash.text, /\nPROBABLE CALL STACK:\n\t\[ 0\] 0x7FF6D2A1B2C3 +SkyrimSE\.exe\+06B2C3 -> 19354\+0x23\t/)
  assert.match(crash.text, /\t\[ 2\] 0x7FFA1B2C3D4E SkyrimPlatformImpl\.dll\+0123D4E\n/)
  assert.match(crash.text, /\nMODULES:\n\tSkyrimSE\.exe +0x7FF6D2A00000\n/)
  assert.match(crash.text, /\tMpClientPlugin\.dll +0x7FFA1C000000 C:\\Users\\<user>\\AppData\\/)
  assert.match(crash.text, /\nSKSE PLUGINS:\n\tCommunityShaders\.dll v1\.9\.1\n\tCrashLoggerSSE\.dll v1\.20\.0\n\tSkyrimPlatform\.dll v2\.9\.0\n/)
  assert.match(crash.text, /\nPLUGINS:\n\tLight: 1\tRegular: 3\tTotal: 4\n\t\[00\]     Skyrim\.esm\n[\s\S]*\t\[FE:000\] ccBGSSSE001-Fish\.esm$/)
  assert.match(crash.text, /\nSYSTEM SPECS:\n\tOS: Microsoft Windows 11 Pro v10\.0\.26200\n/)
  // Registers as register and type, STACK as one line, objects without names or strings
  assert.match(crash.text, /\nREGISTERS:\n\tRAX \(size_t\)\n\tRCX \(PlayerCharacter\*\)\n\tRDX \(char\*\)\n/)
  assert.match(crash.text, /\n\nSTACK: \[11 line\(s\) left out by the server, values read from memory\]\n\nMODULES:\n/)
  assert.match(crash.text, /\tRBX: \(PlayerCharacter\*\) "" \[0x00000014\] \(Skyrim\.esm\)\n/)
  assert.match(crash.text, /\t\tName: <name>\n\t\tFull Name: <name>\n\t\tFormID: 0xFF000D2F\n\t\tFile: "DragonBreak\.esp"\n/)
  // The JWT rule covers the context fields and the description as well
  assert.match(posted.summary, /\nerror: voice failed with <jwt-redacted>\n/)
  assert.match(posted.summary, /my voice token was <jwt-redacted>/)
  const counted = Number(posted.summary.match(/_2 log file\(s\), (\d+) redaction\(s\)/)[1])
  assert.ok(counted >= 25, `${counted} redactions`)
})

test('a filtered crash log over 64 KB keeps its head and tail, inside the cap, with nothing read from memory', async () => {
  const { crashLog, SECRETS } = require('./helpers/crashLogFixture')
  const { MAX_BYTES } = require('../sources/scrubLog')
  const CUT = '[middle lines cut to fit the upload limit]'
  const sent = crashLog({ moduleLines: 2400 })
  assert.ok(Buffer.byteLength(sent) > 100 * 1024, `${Buffer.byteLength(sent)} bytes`)
  const result = await submit({ name: 'Tester', verified: true, profileId: 30 }, { reportId: 'test-crash-log-memory-cap', crashLog: sent })
  assert.strictEqual(result.status, 200)
  const out = posted.files.find(f => f.name === 'crash.log').text
  assert.ok(Buffer.byteLength(out) <= 64 * 1024 + CUT.length + 1, `${Buffer.byteLength(out)} bytes`)
  assert.ok(Buffer.byteLength(out) <= MAX_BYTES)
  assert.strictEqual(out.split('\n').filter(l => l === CUT).length, 1, 'one cut marker')
  for (const [label, value] of Object.entries(SECRETS)) assert.ok(!out.includes(value), `${label} left in crash.log`)
  // The head (exception, call stack, registers) and the tail (plugins) both made it
  assert.match(out, /^\[crash-2026-10-01-14-22-07\.log, /)
  assert.match(out, /\nUnhandled exception "EXCEPTION_ACCESS_VIOLATION" at /)
  assert.match(out, /\nREGISTERS:\n\tRAX \(size_t\)\n/)
  assert.match(out, /\nSTACK: \[11 line\(s\) left out by the server, values read from memory\]\n/)
  assert.match(out, /\nSKSE PLUGINS:\n\tCommunityShaders\.dll v1\.9\.1\n[\s\S]*\t\[FE:000\] ccBGSSSE001-Fish\.esm$/)
})

test('CommunityShaders.log loses Name values and keeps its quoted paths', async () => {
  const stamp = '[2026-09-28 21:15:00.000] [debug] [4120]'
  const csLog = [
    `${stamp} [InverseSquareLighting.cpp:45] [InverseSquareLighting] FormID: 0x00012345 | Name: Brelyna Otherplayer - light uninitialised`,
    `${stamp} [State.cpp:390] Loading "Data\\SKSE\\Plugins\\CommunityShaders\\Features\\GrassLighting.ini"`,
  ].join('\n')
  const result = await submit({ name: 'Tester', verified: true, profileId: 5 }, { reportId: 'test-community-shaders-names', csLog })
  assert.strictEqual(result.status, 200)
  const cs = posted.files.find(f => f.name === 'CommunityShaders.log').text
  assert.doesNotMatch(cs, /Brelyna|Otherplayer/)
  assert.match(cs, /\| Name: <name>\n/)
  assert.match(cs, /Loading "Data\\SKSE\\Plugins\\CommunityShaders\\Features\\GrassLighting\.ini"$/)
})
