'use strict'
// Auto report payload validation (§2.12): the shared payload fixtures, refusals, removals and flags

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { performance } = require('perf_hooks')

const { validate, ignoreReason, trailGrammar, SECTION_CAPS } = require('../sources/autoSchema')

const FIXTURES = path.join(__dirname, 'fixtures', 'auto-report')
const PAYLOADS = path.join(FIXTURES, 'payloads')
const DAY = 24 * 60 * 60 * 1000

const load = name => JSON.parse(fs.readFileSync(path.join(PAYLOADS, `${name}.json`), 'utf8'))
const check = (body, opts = {}) => validate(body, { receivedAt: body.sentAt + 500, ...opts })
function accepted(body, opts) {
  const res = check(body, opts)
  assert.equal(res.ok, true, JSON.stringify(res.json))
  return res
}
function refused(body, error = 'schema') {
  const res = check(body)
  assert.equal(res.ok, false)
  assert.equal(res.status, 422)
  assert.equal(res.json.error, error)
  return res.json
}

for (const file of fs.readdirSync(PAYLOADS).filter(f => f.endsWith('.json'))) {
  test(`payload fixture is accepted with no flags: ${file}`, () => {
    const body = load(path.basename(file, '.json'))
    const res = accepted(body)
    assert.deepEqual(res.flags, [])
    assert.equal(res.report.reportId, body.reportId)
    assert.equal(ignoreReason(res.report), file === 'ui-error-opaque.json' ? 'opaque' : null)
  })
}

test('the stored record keeps only known keys at every level', () => {
  const body = load('crash-ours')
  const junk = { signature: 'Sdeadbeef00', group: 'G1', extra: 'x'.repeat(10) }
  for (const o of [body, body.consent, body.versions, body.build, body.session, body.exit, body.crash, body.crash.frames[0],
                   body.crash.sections, body.trail, body.trail.entries[0], body.logs]) Object.assign(o, junk)
  const text = JSON.stringify(accepted(body).report)
  for (const key of Object.keys(junk)) assert.ok(!text.includes(`"${key}"`), key)
  const client = load('script-error-on-update')
  Object.assign(client.error, junk)
  Object.assign(client.error.frames[0], junk)
  Object.assign(client.build.probe, junk)
  const clientText = JSON.stringify(accepted(client).report)
  for (const key of Object.keys(junk)) assert.ok(!clientText.includes(`"${key}"`), key)
})

test('blocks that do not belong to the kind are not stored', () => {
  const body = load('script-error-on-update')
  body.exit = load('crash-ours').exit
  body.crash = load('crash-ours').crash
  body.versions.os = 'win32 10.0.22631'
  body.consent.crash = 'always'
  const { report } = accepted(body)
  assert.equal(report.exit, undefined)
  assert.equal(report.crash, undefined)
  assert.equal(report.versions.os, undefined)
  assert.deepEqual(report.consent, { noticeVersion: 1, errors: true })
  const quit = load('crash-on-quit')
  quit.logs = { gameLog: 'x' }
  quit.crash.sections = { header: 'x' }
  const stored = accepted(quit).report
  assert.equal(stored.logs, undefined)
  assert.equal(stored.crash.sections, undefined)
})

test('__proto__ keys and deep nesting are ignored without a crash', () => {
  const nested = '['.repeat(1000) + ']'.repeat(1000)
  const text = JSON.stringify(load('script-error-on-update'))
    .replace('{"contractVersion"', `{"__proto__":{"polluted":true},"deep":${nested},"contractVersion"`)
    .replace('"session":{', '"session":{"__proto__":{"polluted":true},')
    .replace('"actorId":"ff00012a"', `"actorId":"ff00012a","uptimeSec":${nested}`)
  const body = JSON.parse(text)
  const res = accepted(body)
  assert.equal({}.polluted, undefined)
  assert.equal(Object.prototype.hasOwnProperty.call(res.report, '__proto__'), false)
  assert.equal(res.report.session.uptimeSec, undefined)
  assert.ok(res.flags.includes('invalidField'))
})

test('a body that is not an object is refused', () => {
  for (const body of [null, [], 'text', 5]) {
    const res = validate(body, { receivedAt: Date.now() })
    assert.equal(res.status, 422)
    assert.equal(res.json.error, 'schema')
  }
})

test('schema refusals', () => {
  const cases = [
    ['no reportId', b => delete b.reportId, 'reportId: missing'],
    ['upper-case reportId', b => { b.reportId = b.reportId.toUpperCase() }, 'reportId: invalid'],
    ['a pre-release client version', b => { b.versions.client = '0.3.44-beta' }, 'versions.client: invalid'],
    ['an unknown kind', b => { b.kind = 'hang' }, 'kind: invalid'],
    ['a sender that does not match the kind', b => { b.sender = 'launcher' }, 'sender: does not match the kind'],
    ['attempt 6', b => { b.attempt = 6 }, 'attempt: invalid'],
    ['a fractional time', b => { b.clientAt = 1.5 }, 'clientAt: invalid'],
    ['a negative time', b => { b.sentAt = -1 }, 'sentAt: invalid'],
    ['queued as a string', b => { b.queued = 'false' }, 'queued: invalid'],
    ['no consent', b => delete b.consent, 'consent: missing'],
    ['consent.errors not a boolean', b => { b.consent.errors = 'yes' }, 'consent.errors: invalid'],
    ['no versions', b => delete b.versions, 'versions: missing'],
    ['a malformed build id', b => { b.build.client = 'f8cd7897' }, 'build.client: invalid'],
    ['no build', b => delete b.build, 'build: missing'],
    ['a malformed error type', b => { b.error.type = 'Type Error' }, 'error.type: invalid'],
    ['an unknown where', b => { b.error.where = 'controller' }, 'error.where: invalid'],
    ['a front source on a script-error', b => { b.error.source = 'front' }, 'error.source: invalid'],
    ['a message that is not a string', b => { b.error.message = { text: 'x' } }, 'error.message: invalid'],
    ['13 frames', b => { b.error.frames = Array(13).fill(b.error.frames[0]) }, 'error.frames: more than 12'],
    ['a count above 10,000,000', b => { b.error.count = 10000001 }, 'error.count: invalid'],
    ['no site key', b => delete b.error.site, 'error.site: missing'],
    ['an unknown trail source', b => { b.trail.source = 'disk' }, 'trail.source: invalid'],
    ['trail entries that are not an array', b => { b.trail.entries = {} }, 'trail.entries: must be an array'],
  ]
  for (const [name, mutate, problem] of cases) {
    const body = load('script-error-on-update')
    mutate(body)
    assert.ok(refused(body).problems.includes(problem), `${name}: ${JSON.stringify(check(body).json)}`)
  }
})

test('schema refusals for launcher kinds', () => {
  const cases = [
    ['crash-ours', 'an exception that does not match', b => { b.crash.exception = 'ACCESS_VIOLATION' }, 'crash.exception: invalid'],
    ['crash-ours', '25 crash frames', b => { b.crash.frames = Array(25).fill(b.crash.frames[0]) }, 'crash.frames: more than 24'],
    ['crash-ours', 'no crash block', b => delete b.crash, 'crash: missing'],
    ['crash-ours', 'hasOurDll missing', b => delete b.crash.hasOurDll, 'crash.hasOurDll: missing'],
    ['crash-ours', 'an unknown detectedBy', b => { b.exit.detectedBy = 'guess' }, 'exit.detectedBy: invalid'],
    ['crash-ours', 'no exit block', b => delete b.exit, 'exit: missing'],
    ['crash-ours', 'a client sender', b => { b.sender = 'client' }, 'sender: does not match the kind'],
    ['freeze-taskkill', 'a freeze with no heartbeat and no event 1002',
      b => { b.exit.lastHeartbeatAt = null }, 'exit.lastHeartbeatAt: required for freeze without event 1002'],
    ['crash-nolog-fastfail', 'a crash-nolog with neither code nor event',
      b => { b.exit.code = null; b.exit.event = null }, 'exit.event: required for crash-nolog without an exit code'],
  ]
  for (const [fixture, name, mutate, problem] of cases) {
    const body = load(fixture)
    mutate(body)
    assert.ok(refused(body).problems.includes(problem), `${name}: ${JSON.stringify(check(body).json)}`)
  }
})

test('at most 10 problems are listed', () => {
  const body = load('script-error-on-update')
  for (const key of ['reportId', 'clientAt', 'sentAt', 'attempt', 'queued', 'versions']) delete body[key]
  body.error = { where: 'nowhere' }
  const { problems } = refused(body)
  assert.equal(problems.length, 10)
  for (const p of problems) assert.match(p, /^[\w.[\]]+: /)
})

test('contractVersion other than 1 is refused with the supported list', () => {
  const body = load('script-error-on-update')
  body.contractVersion = 2
  assert.deepEqual(check(body).json, { error: 'contractVersion', supported: [1] })
  body.contractVersion = '1'
  assert.ok(refused(body).problems.includes('contractVersion: invalid'))
})

test('consent refusals', () => {
  const cases = [
    ['script-error-on-update', 'noticeVersion 0', b => { b.consent.noticeVersion = 0 }],
    ['script-error-on-update', 'no noticeVersion', b => delete b.consent.noticeVersion],
    ['script-error-on-update', 'errors off', b => { b.consent.errors = false }],
    ['ui-error-window', 'errors off', b => { b.consent.errors = false }],
    ['js-fatal', 'errors off', b => { b.consent.errors = false }],
    ['freeze-taskkill', 'errors off', b => { b.consent.errors = false }],
    ['crash-ours', 'no crash consent', b => delete b.consent.crash],
    ['crash-ours', 'crash consent ask', b => { b.consent.crash = 'ask' }],
    ['crash-nolog-fastfail', 'crash consent off', b => { b.consent.crash = 'off' }],
    ['crash-on-quit', 'crash consent once', b => { b.consent.crash = 'once' }],
  ]
  for (const [fixture, name, mutate] of cases) {
    const body = load(fixture)
    mutate(body)
    assert.deepEqual(check(body).json, { error: 'consent' }, `${fixture}: ${name}`)
  }
  const crash = load('crash-ours')
  crash.consent = { noticeVersion: 1, errors: false, crash: 'once' }
  assert.deepEqual(accepted(crash).report.consent, { noticeVersion: 1, errors: false, crash: 'once' })
})

test('invalid optional fields are removed and flagged, not refused', () => {
  const body = load('script-error-logged')
  body.error.frames[0].fn = 'Remote`Server'
  body.error.frames[1].file = 'C:\\Users\\jake\\bundle.js'
  body.versions.files = '../../etc'
  body.versions.launcher = 'v2'
  body.build.front = 'nope'
  body.build.probe = { line: 0, col: 1 }
  body.session.actorId = 'FF00012A'
  body.error.service = 'Auth Service'
  const res = accepted(body)
  const { report } = res
  assert.equal(report.error.frames[0].fn, null)
  assert.equal(report.error.frames[1].file, null)
  assert.equal(report.versions.files, undefined)
  assert.equal(report.versions.launcher, undefined)
  assert.equal(report.build.front, undefined)
  assert.equal(report.build.probe, undefined)
  assert.equal(report.session.actorId, undefined)
  assert.equal(report.error.service, null)
  assert.deepEqual(res.flags, ['invalidField'])
  assert.deepEqual(res.invalid, ['versions.files', 'versions.launcher', 'build.front', 'build.probe', 'session.actorId',
                                 'error.service', 'error.frames[0].fn', 'error.frames[1].file'])
})

test('fields that contradict where are cleared and flagged', () => {
  const body = load('script-error-http-callback')
  body.error.site = { line: 5, col: 5 }
  body.error.service = 'AuthService'
  body.error.handled = true
  body.error.componentStack = 'at App'
  body.error.event = '/api/users/me'
  const res = accepted(body)
  assert.equal(res.report.error.site, null)
  assert.equal(res.report.error.service, null)
  assert.equal(res.report.error.handled, false)
  assert.equal(res.report.error.event, null)
  assert.equal('componentStack' in res.report.error, false)
  assert.deepEqual(res.invalid, ['error.event', 'error.service', 'error.handled', 'error.site', 'error.componentStack'])
})

test('frames with bad positions are dropped; crash frame fields are nulled one by one', () => {
  const body = load('script-error-on-update')
  body.error.frames.push({ fn: 'x', line: 0, col: 1, file: null }, 'not a frame')
  const res = accepted(body)
  assert.equal(res.report.error.frames.length, 2)
  assert.deepEqual(res.invalid, ['error.frames[2]', 'error.frames[3]'])

  const crash = load('crash-ours')
  crash.crash.frames[0] = { module: 'C:\\Mods\\evil.dll', offset: '0x1a2b', symbol: 'bad\u0001symbol', alid: -3 }
  crash.crash.faultSymbol = 'x'.repeat(201)
  crash.crash.crashLoggerVersion = 'v 1'
  const stored = accepted(crash).report.crash
  assert.deepEqual(stored.frames[0], { module: null, offset: null, symbol: null, alid: null })
  assert.equal(stored.faultSymbol, null)
  assert.equal(stored.crashLoggerVersion, undefined)
})

test('symbols and the OS name that a scrub rule would change are removed and flagged', () => {
  const crash = load('crash-ours')
  crash.versions.os = 'Windows 10 (192.168.1.20)'
  crash.crash.faultSymbol = 'C:\\Users\\JohnSmith\\x john.smith@gmail.com 192.168.1.20'
  crash.crash.frames[0].symbol = 'Fn at /home/john/src/a.cpp'
  crash.crash.frames[1].symbol = 'RE::Actor::Update std::vector<int>::push_back'
  const res = accepted(crash)
  assert.equal(res.report.versions.os, undefined)
  assert.equal(res.report.crash.faultSymbol, null)
  assert.equal(res.report.crash.frames[0].symbol, null)
  assert.equal(res.report.crash.frames[1].symbol, 'RE::Actor::Update std::vector<int>::push_back')
  assert.deepEqual(res.invalid, ['versions.os', 'crash.faultSymbol', 'crash.frames[0].symbol'])
  assert.ok(!JSON.stringify(res.report).includes('John'))
})

test('a fault offset without a fault module is cleared', () => {
  const body = load('crash-no-module')
  body.crash.faultOffset = '0x1234'
  const res = accepted(body)
  assert.equal(res.report.crash.faultOffset, null)
  assert.deepEqual(res.invalid, ['crash.faultOffset'])
})

test('an invalid Windows event becomes null and a bad event field is nulled', () => {
  const body = load('crash-nolog-fastfail')
  body.exit.event.exceptionCode = 'c0000409'
  let res = accepted(body)
  assert.equal(res.report.exit.event.exceptionCode, null)
  body.exit.event = { id: 4000 }
  res = accepted(body)
  assert.equal(res.report.exit.event, null)
  assert.deepEqual(res.invalid, ['exit.event'])
})

test('free text is scrubbed, with the session username as <discord>', () => {
  const body = load('script-error-on-update')
  body.error.message = 'Dovah_Kiin99 at 192.168.1.20 \u202esaw a.b@example.org'
  body.logs = { gameLog: "[10:00:00:000] on('update'): Unexpected token 'm', \"{\"a\": my letter \"... is not valid JSON\n[10:00:00:001] DOVAH_KIIN99 left" }
  const { report } = accepted(body, { scrubContext: { names: { discord: ['dovah_kiin99'] } } })
  assert.equal(report.error.message, '<discord> at <ip> saw <email>')
  assert.equal(report.logs.gameLog, "[10:00:00:000] on('update'): Unexpected token in JSON\n[10:00:00:001] <discord> left")
})

test('the JSON.parse rule rewrites SyntaxError messages and err trail entries', () => {
  const { report } = accepted(load('script-error-json-parse'))
  assert.equal(report.error.message, 'Unexpected token in JSON')
  const body = load('script-error-on-update')
  body.trail.entries.push({ t: body.clientAt, s: 1000, k: 'err', d: "logged AuthService: SyntaxError: Unexpected token 'x', \"x{\"session\"... is not valid JSON" })
  const entries = accepted(body).report.trail.entries
  assert.equal(entries.at(-1).d, 'logged AuthService: SyntaxError: Unexpected token in JSON')
})

test('crash sections are scrubbed, capped by key, unknown keys dropped', () => {
  const body = load('crash-ours')
  body.crash.sections.stack = 'raw stack memory'
  body.crash.sections.header = `C:\\Users\\Jake\\x ${'h'.repeat(SECTION_CAPS.header)}`
  body.crash.sections.plugins = 42
  const res = accepted(body)
  const sections = res.report.crash.sections
  assert.equal(sections.stack, undefined)
  assert.equal(sections.plugins, undefined)
  assert.ok(sections.header.startsWith('C:\\Users\\<user>\\x '))
  assert.equal(sections.header.length, SECTION_CAPS.header)
  assert.deepEqual(res.flags.sort(), ['invalidField', 'truncated'])
})

test('crash sections: registers keep only register and type, relevant objects lose names and quoted strings', () => {
  const body = load('crash-ours')
  const fixture = { ...body.crash.sections }
  body.crash.sections.registers = 'RAX 0x0                (size_t) [0]\r\nRCX 0x1D3A5B0C2D0      (TESNPC*)\r\n' +
    '\t\tName: "Lydia Johnson"\r\nRDX 0x7FF6A1B2C3D4     (char*) "Brelyna says hi"\r\nR8 0x14\r\nRSP (void*)'
  body.crash.sections.relevantObjects = '[RSP+50] 0x1D3A5B0C2D0 (TESNPC*)\n\t\tName: "Lydia Johnson"\n\t\tFull Name: Bob Otherplayer\n' +
    '\t\tFormID: 0xFF000D2E\n\t\tFile: "Skyrim.esm"\n[RSP+68] (char*) "meet me at the inn\n(BSFixedString) "unclosed text\n' +
    '\t\tNa\u200bme: Hidden Name'
  const { sections } = accepted(body).report.crash
  assert.equal(sections.registers, 'RAX (size_t)\nRCX (TESNPC*)\nRDX (char*)\nRSP (void*)')
  assert.equal(sections.relevantObjects, '[RSP+50] 0x1D3A5B0C2D0 (TESNPC*)\n\t\tName: <name>\n\t\tFull Name: <name>\n' +
    '\t\tFormID: 0xFF000D2E\n\t\tFile: "Skyrim.esm"\n[RSP+68] (char*) ""\n(BSFixedString) ""\n\t\tName: <name>')
  // The sender's filtered form passes unchanged
  assert.equal(sections.header, fixture.header)
  const again = load('crash-ours')
  assert.deepEqual(accepted(again).report.crash.sections, fixture)
})

test('crash section filters run in linear time', () => {
  const body = load('crash-ours')
  for (const unit of ['"', 'File: "', 'Name:', 'Full ', 'RAX 0x0 (', ' ']) {
    const text = unit.repeat(Math.ceil(64 * 1024 / unit.length))
    body.crash.sections.registers = text
    body.crash.sections.relevantObjects = text
    const start = process.hrtime.bigint()
    accepted(body)
    const ms = Number(process.hrtime.bigint() - start) / 1e6
    assert.ok(ms < 100, `${ms.toFixed(1)} ms on runs of ${JSON.stringify(unit)}`)
  }
})

test('component stacks keep component names with their build.js positions', () => {
  const body = load('ui-error-boundary')
  assert.equal(accepted(body).report.error.componentStack, body.error.componentStack)
  body.error.componentStack = 'at PartyPanel (file:///C:/Games/Skyrim/Data/Platform/UI/build.js:2:1)\nat Kt (build.js:2:183100)\n' +
    'at Ye (vendor.js:1:5)\nat Widgets\n  at App  \nat Zn (build.js:0:1)\nsomething else'
  const res = accepted(body)
  assert.equal(res.report.error.componentStack, 'at Kt (build.js:2:183100)\nat Widgets\nat App')
  assert.deepEqual(res.invalid, ['error.componentStack'])
})

test('long strings are cut and flagged truncated, not refused', () => {
  const body = load('script-error-on-update')
  body.error.message = 'm '.repeat(5000)
  body.logs = { gameLog: '[10:00:00:000] start\n' + '[10:00:00:001] log line\n'.repeat(2000) + '[10:00:00:002] the end' }
  const res = accepted(body)
  assert.equal(res.report.error.message.length, 1000)
  const { gameLog } = res.report.logs
  assert.ok(gameLog.length <= 16 * 1024 && gameLog.length > 16 * 1024 - 24, String(gameLog.length))
  assert.ok(gameLog.startsWith('[10:00:00:001] log line\n'))
  assert.ok(gameLog.endsWith('the end'))
  assert.deepEqual(res.flags, ['truncated'])
  const launcher = load('js-fatal')
  launcher.logs.gameLog = '[10:00:00:000] log line\n'.repeat(3000)
  assert.equal(accepted(launcher).report.logs.gameLog, '[10:00:00:000] log line\n'.repeat(Math.floor(32 * 1024 / 24)))
})

test('trail: grammar failures and hb entries are removed and counted, the newest 56 kept, sorted by time', () => {
  const body = load('script-error-on-update')
  const t = body.clientAt
  body.trail.dropped = 2
  body.trail.entries = [
    ...Array.from({ length: 60 }, (_, i) => ({ t: t - 100000 + i, s: i, k: 'menu', d: 'open InventoryMenu' })),
    { t: t - 5, k: 'menu', d: 'open Hey, want to trade? meet at the inn' },
    { t: t - 4, k: 'hb', d: 'c' },
    { t: t - 3, k: 'chat', d: 'hello' },
    { t: t - 2, k: 'net', d: 'connected', n: 1 },
    { t: t - 1, k: 'net', d: 'connected', n: 3 },
  ]
  body.trail.entries.reverse()
  const res = accepted(body)
  const { trail } = res.report
  assert.equal(trail.entries.length, 56 - 4)
  assert.equal(trail.dropped, 2 + 9 + 4)
  assert.deepEqual(trail.entries.at(-1), { t: t - 1, k: 'net', d: 'connected', n: 3 })
  assert.ok(trail.entries.every((e, i) => i === 0 || trail.entries[i - 1].t <= e.t))
  assert.ok(res.flags.includes('truncated'))
})

test('crash-on-quit keeps the last 10 trail entries', () => {
  const body = load('crash-on-quit')
  const at = body.exit.at
  body.trail.entries = Array.from({ length: 30 }, (_, i) => ({ t: at - 30000 + i * 1000, s: i, k: 'recv', d: 'CustomPacket dboHud' }))
  const { trail } = accepted(body).report
  assert.equal(trail.entries.length, 10)
  assert.equal(trail.entries[0].t, at - 30000 + 20000)
  assert.equal(trail.dropped, 20)
})

test('a time outside [2025-01-01, receipt + 1 day] is accepted and flagged clockSuspect', () => {
  const old = load('script-error-on-update')
  old.clientAt = Date.UTC(2019, 5, 1)
  assert.deepEqual(accepted(old).flags, ['clockSuspect'])
  const future = load('crash-ours')
  assert.deepEqual(check(future, { receivedAt: future.crash.crashAt - 2 * DAY }).flags, ['clockSuspect'])
})

test('ignored: a crash older than 7 days, and a launcher report with no DragonBreak trail entry', () => {
  const old = load('crash-ours')
  old.sentAt = old.crash.crashAt + 8 * DAY
  const oldRes = check(old, { receivedAt: Date.UTC(2026, 9, 1) })
  assert.equal(ignoreReason(oldRes.report), 'too-old')
  const skewed = load('crash-ours')
  skewed.sentAt = skewed.crash.crashAt + 6 * DAY
  assert.equal(ignoreReason(check(skewed, { receivedAt: skewed.sentAt + 30 * DAY }).report), null)

  const lonely = load('crash-ours')
  lonely.trail.entries = lonely.trail.entries.filter(e => !['net', 'send', 'recv'].includes(e.k))
  assert.equal(ignoreReason(accepted(lonely).report), 'no-dbo-trail')
  const stale = load('freeze-taskkill')
  for (const e of stale.trail.entries) e.t -= 120000
  assert.equal(ignoreReason(accepted(stale).report), 'no-dbo-trail')
  const scriptError = load('script-error-on-update')
  scriptError.trail.entries = []
  assert.equal(ignoreReason(accepted(scriptError).report), null)
})

test('trail grammar: every shared grammar case, client and server', () => {
  const cases = require('./fixtures/auto-report/trail/grammar-cases.json')
  for (const side of ['client', 'server']) {
    assert.deepEqual(Object.keys(trailGrammar[side]).sort(), [...new Set(cases[side].map(c => c.k))].sort(), side)
    for (const c of cases[side]) assert.equal(trailGrammar[side][c.k].test(c.d), c.ok, `${side} ${c.k} ${JSON.stringify(c.d)}`)
  }
})

test('timing: a maximal 400 KB adversarial report validates in under 250 ms', () => {
  const body = load('crash-ours')
  const units = ['"', 'a@', '1.', 'a:', "class '", 'a']
  const fill = (n, i) => units[i % units.length].repeat(n).slice(0, n)
  body.logs.gameLog = `[00:00:00:000] ${fill(2000, 0)}\n`.repeat(30)
  body.crash.sections = Object.fromEntries(Object.entries(SECTION_CAPS).map(([k, cap], i) => [k, fill(Math.floor(cap * 1.4), i)]))
  body.trail.entries = Array.from({ length: 56 }, (_, i) => ({ t: body.crash.crashAt - i, k: 'err', d: `on TypeError: ${fill(150, i)}` }))
  const size = Buffer.byteLength(JSON.stringify(body))
  assert.ok(size > 300 * 1024 && size <= 400 * 1024, `${size} bytes`)
  let best = Infinity
  for (let i = 0; i < 3; i++) {
    const start = performance.now()
    assert.equal(check(body).ok, true)
    best = Math.min(best, performance.now() - start)
  }
  assert.ok(best < 250, `${best.toFixed(1)} ms`)
})
