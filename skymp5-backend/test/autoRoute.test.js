'use strict'
// POST /api/files/report with x-report-kind: auto (docs/auto-report-v1.md §1): every answer, dedupe, limits and the byte budget

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const fs     = require('fs')
const http   = require('http')
const os     = require('os')
const path   = require('path')

// Never read a real .env, and keep master-api and the ban and player stores out of these tests
require.cache[require.resolve('dotenv')] = { exports: { config: () => ({}) } }
for (const key of Object.keys(process.env)) if (key.startsWith('AUTO_REPORT')) delete process.env[key]
function stub(rel, exports) {
  const file = require.resolve(rel)
  require.cache[file] = { id: file, filename: file, loaded: true, exports }
}
const sessions = new Map()
const banned = new Set()
const playerRecords = {}
let lookups = 0
stub('../routes/master-api', { lookupSession: token => { lookups++; return sessions.get(token) || null } })
stub('../sources/bans', { isBanned: ({ discordId, hwid }) => (banned.has(discordId) || banned.has(hwid) ? { reason: 'test' } : null) })
stub('../sources/players', { load: () => playerRecords })

const express     = require('express')
const config      = require('../config')
const autoStore   = require('../sources/autoStore')
const errorGroups = require('../sources/errorGroups')
const files       = require('../routes/files')
const { writeFixtureMaps } = require('./fixtures/auto-report/sourcemaps/fixture')

const FIXTURES = path.join(__dirname, 'fixtures', 'auto-report', 'payloads')
const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_LIMITS = { ...config.autoReportLimits }
let server, base, tmp

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-route-'))
  config.autoReportDir = path.join(tmp, 'auto')
  config.autoSourceMapDir = path.join(tmp, 'sourcemaps')
  writeFixtureMaps(config.autoSourceMapDir)
  config.autoReports = 'collect'
  config.autoReportCrashWatch = true
  config.discordErrorForumChannelId = ''
  const app = express()
  app.use('/api/files', files)
  server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => {
  server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

let nextProfile = 100
function login(extra = {}) {
  const token = crypto.randomBytes(16).toString('hex')
  const profileId = nextProfile++
  sessions.set(token, { profileId, discordId: `d${profileId}`, username: `Tester${profileId}`, expiresAt: Date.now() + DAY_MS,
                        launchCheck: { filesVersion: '0.3.44', filesOk: true, pluginsOk: true }, ...extra })
  return { token, profileId }
}

const payload = (name = 'script-error-logged', extra = {}) => ({
  ...JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')), reportId: crypto.randomUUID(), ...extra,
})

// Each request comes from its own visitor address unless one is given
let nextIp = 0
function post(body, { token, kind = 'auto', ip, headers = {} } = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body)
  nextIp++
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/files/report`, {
      method: 'POST',
      agent: false,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
        'cf-connecting-ip': ip || `10.1.${nextIp >> 8 & 255}.${nextIp & 255}`,
        ...(kind ? { 'x-report-kind': kind } : {}),
        ...(token ? { 'x-session': token } : {}),
        ...headers,
      },
    }, res => {
      let text = ''
      res.on('data', c => { text += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(text) } catch { /* asserted by the caller */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text })
      })
    })
    req.on('error', reject)
    req.end(data)
  })
}

const stored = (profileId, reportId) => {
  const file = autoStore.reportFile(profileId, reportId)
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
}
const mode = file => fs.statSync(file).mode & 0o777
const stateFile = () => path.join(config.autoReportDir, 'auto-state.json')
const withLimits = (t, limits) => {
  Object.assign(config.autoReportLimits, limits)
  t.after(() => Object.assign(config.autoReportLimits, DEFAULT_LIMITS))
}

test('202: stored once, 0600 in a 0700 folder, keyed by profile and reportId, never with the token', async () => {
  const { token, profileId } = login()
  const body = payload()
  const res = await post(body, { token })
  assert.equal(res.status, 202)
  assert.deepEqual(res.json, { ok: true, id: body.reportId, duplicate: false })

  const file = autoStore.reportFile(profileId, body.reportId)
  assert.equal(path.basename(file), `${profileId}-${body.reportId}.json`)
  assert.equal(mode(file), 0o600)
  assert.equal(mode(path.dirname(file)), 0o700)
  assert.equal(mode(config.autoReportDir), 0o700)
  assert.equal(mode(stateFile()), 0o600)
  const text = fs.readFileSync(file, 'utf8')
  assert.ok(!text.includes(token))
  assert.ok(!fs.readdirSync(path.dirname(file)).some(f => f.endsWith('.tmp')))

  const record = JSON.parse(text)
  assert.equal(record.v, 1)
  assert.equal(record.profileId, profileId)
  assert.equal(record.trust, 'verified')
  assert.equal(record.ignored, null)
  assert.deepEqual(record.flags, [])
  assert.ok(Math.abs(record.receivedAt - Date.now()) < 60 * 1000)
  assert.equal(record.report.reportId, body.reportId)
  assert.equal(record.report.error.message, body.error.message)
  assert.equal(record.report.trail.entries.length, body.trail.entries.length)
})

test('202: the Discord username from the session is scrubbed, and the trust label follows the launch check', async () => {
  const { token, profileId } = login({ launchCheck: { filesVersion: '0.3.40', filesOk: false, pluginsOk: true } })
  const body = payload()
  body.error.message = `Cannot read properties of undefined (reading 'x') near Tester${profileId}`
  assert.equal((await post(body, { token })).status, 202)
  const record = stored(profileId, body.reportId)
  assert.equal(record.report.error.message, "Cannot read properties of undefined (reading 'x') near <discord>")
  assert.equal(record.trust, 'unverified-launch')

  const bare = login({ launchCheck: undefined })
  const other = payload()
  assert.equal((await post(other, { token: bare.token })).status, 202)
  assert.equal(stored(bare.profileId, other.reportId).trust, 'unverified-launch')
})

test('202, then grouping: the group, the hardware id only as a hash, and the receipt checks against the archived build', async () => {
  const { token, profileId } = login({ hwid: 'HWID-SECRET-1' })
  const body = payload('script-error-site-below-1')
  assert.equal((await post(body, { token })).status, 202)
  await errorGroups.idle()
  const record = stored(profileId, body.reportId)
  assert.match(record.hwidHash, /^[0-9a-f]{16}$/)
  assert.ok(!JSON.stringify(record).includes('HWID-SECRET-1'))
  assert.deepEqual([record.flags, record.invalid, record.report.error.site], [['invalidField'], ['error.site'], null])
  const group = errorGroups.get('S35f713adad')
  assert.equal(group.status, 'open')
  assert.ok(group.players[profileId])
})

test('202 duplicate: the same reportId is stored once per profile; another profile has its own', async () => {
  const first = login()
  const body = payload()
  assert.deepEqual((await post(body, { token: first.token })).json, { ok: true, id: body.reportId, duplicate: false })
  const file = autoStore.reportFile(first.profileId, body.reportId)
  const before = fs.readFileSync(file, 'utf8')
  const retry = { ...body, attempt: 2, sentAt: body.sentAt + 30000, queued: true }
  const res = await post(retry, { token: first.token })
  assert.equal(res.status, 202)
  assert.deepEqual(res.json, { ok: true, id: body.reportId, duplicate: true })
  assert.equal(fs.readFileSync(file, 'utf8'), before)

  const second = login()
  assert.deepEqual((await post(body, { token: second.token })).json, { ok: true, id: body.reportId, duplicate: false })
  assert.ok(stored(second.profileId, body.reportId))
})

test('seen reportIds survive a restart, last 8 days and are capped at 500 per profile', async () => {
  const { token, profileId } = login()
  const body = payload()
  assert.equal((await post(body, { token })).status, 202)
  autoStore.load()
  assert.deepEqual((await post(body, { token })).json, { ok: true, id: body.reportId, duplicate: true })

  const now = Date.now()
  assert.equal(autoStore.isSeen(profileId, body.reportId, now + autoStore.SEEN_MS - 1000), true)
  assert.equal(autoStore.isSeen(profileId, body.reportId, now + autoStore.SEEN_MS + 1000), false)
  assert.equal(autoStore.isSeen(profileId + 1, body.reportId, now), false)

  const capped = 9000
  const ids = Array.from({ length: autoStore.SEEN_MAX + 1 }, () => crypto.randomUUID())
  ids.forEach((reportId, i) => autoStore.add({ profileId: capped, receivedAt: now + i, report: { reportId } }, '{}'))
  assert.equal(autoStore.isSeen(capped, ids[0], now + 1000), false)
  assert.equal(autoStore.isSeen(capped, ids[1], now + 1000), true)
  assert.equal(autoStore.isSeen(capped, ids.at(-1), now + 1000), true)
  const saved = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
  assert.equal(saved.profiles[capped].seen.length, autoStore.SEEN_MAX)

  // Ids older than 8 days are dropped from the file on the next save
  autoStore.save(now + autoStore.SEEN_MS + DAY_MS)
  assert.equal(JSON.parse(fs.readFileSync(stateFile(), 'utf8')).profiles[capped], undefined)
  autoStore.load()
})

test('401: no session header, or a session that is not live', async () => {
  const body = payload()
  assert.deepEqual(await post(body).then(r => [r.status, r.json]), [401, { error: 'session', reason: 'missing' }])
  assert.deepEqual(await post(body, { token: 'not-a-session' }).then(r => [r.status, r.json]),
                   [401, { error: 'session', reason: 'invalid' }])
})

test('403: a profile banned by Discord id, by the session hardware id or by the player record', async () => {
  const byDiscord = login()
  banned.add(`d${byDiscord.profileId}`)
  const bySession = login({ hwid: 'hw-session' })
  banned.add('hw-session')
  const byRecord = login()
  playerRecords[`d${byRecord.profileId}`] = { hwid: 'hw-record' }
  banned.add('hw-record')
  for (const { token, profileId } of [byDiscord, bySession, byRecord]) {
    const body = payload()
    const res = await post(body, { token })
    assert.deepEqual([res.status, res.json], [403, { error: 'refused' }], String(profileId))
    assert.equal(stored(profileId, body.reportId), null)
  }
})

test('413 over 400 KB; a body just under it is parsed and its long log cut', async () => {
  const { token, profileId } = login()
  const big = payload('crash-ours', { pad: 'x'.repeat(410 * 1024) })
  const res = await post(big, { token })
  assert.equal(res.status, 413)
  assert.equal(typeof res.json.error, 'string')

  const body = payload('crash-ours')
  body.logs = { gameLog: '[10:00:00:000] game log\n'.repeat(16200) }
  const bytes = Buffer.byteLength(JSON.stringify(body))
  assert.ok(bytes > 395 * 1024 && bytes <= 400 * 1024, String(bytes))
  assert.equal((await post(body, { token })).status, 202)
  const record = stored(profileId, body.reportId)
  assert.ok(record.flags.includes('truncated'))
  assert.ok(record.report.logs.gameLog.length <= 32 * 1024)
})

test('415: another content type, or any content-encoding', async () => {
  const { token } = login()
  for (const headers of [{ 'content-type': 'text/plain' }, { 'content-type': 'application/x-www-form-urlencoded' },
                         { 'content-encoding': 'gzip' }, { 'content-type': 'application/jsonx' }]) {
    const res = await post(payload(), { token, headers })
    assert.equal(res.status, 415, JSON.stringify(headers))
    assert.equal(typeof res.json.error, 'string')
  }
  assert.equal((await post(payload(), { token, headers: { 'content-type': 'application/json; charset=utf-8' } })).status, 202)
})

test('400: a body that is not JSON answers in JSON', async () => {
  const { token } = login()
  const res = await post('{"contractVersion":1,', { token })
  assert.equal(res.status, 400)
  assert.equal(typeof res.json.error, 'string')
})

test('422: schema, contractVersion and consent, and nothing is stored', async () => {
  const { token, profileId } = login()
  const cases = [
    [payload('script-error-logged', { kind: 'nope' }), 'schema'],
    [payload('script-error-logged', { contractVersion: 2 }), 'contractVersion'],
    [payload('script-error-logged', { consent: { noticeVersion: 1, errors: false } }), 'consent'],
    [payload('crash-on-quit', { consent: { noticeVersion: 1, errors: true, crash: 'once' } }), 'consent'],
  ]
  for (const [body, error] of cases) {
    const res = await post(body, { token })
    assert.equal(res.status, 422, error)
    assert.equal(res.json.error, error)
    assert.equal(stored(profileId, body.reportId), null)
  }
  assert.deepEqual((await post(cases[1][0], { token })).json, { error: 'contractVersion', supported: [1] })
  const schema = await post([payload()], { token })
  assert.deepEqual([schema.status, schema.json], [422, { error: 'schema', problems: ['body: must be a JSON object'] }])
  const empty = await post('', { token })
  assert.equal(empty.status, 422)
})

function assertRate(res) {
  assert.equal(res.status, 429)
  assert.equal(res.json.error, 'rate')
  assert.ok(Number.isSafeInteger(res.json.retryAfterSec) && res.json.retryAfterSec >= 1)
  assert.equal(res.headers['retry-after'], String(res.json.retryAfterSec))
}

test('429 per visitor address, counted before the session lookup so 401 floods are limited too', async (t) => {
  withLimits(t, { ipPer10Min: 2 })
  const ip = '203.0.113.7'
  assert.equal((await post(payload(), { ip })).status, 401)
  assert.equal((await post(payload(), { ip })).status, 401)
  const seen = lookups
  const res = await post(payload(), { ip, token: login().token })
  assertRate(res)
  assert.ok(res.json.retryAfterSec <= 600)
  assert.equal(lookups, seen)
  assert.equal((await post(payload(), { ip: '203.0.113.8' })).status, 401)
})

test('429 from the ceiling on unverified requests; verified ones pass it', async (t) => {
  withLimits(t, { unverifiedPer10Min: 3 })
  let res
  for (let i = 0; i < 4 && (!res || res.status === 401); i++) res = await post(payload())
  assertRate(res)
  assert.equal((await post(payload(), { token: login().token })).status, 202)
})

test('429 per profile in 10 minutes', async (t) => {
  withLimits(t, { profilePer10Min: 2 })
  const { token } = login()
  assert.equal((await post(payload(), { token })).status, 202)
  assert.equal((await post(payload(), { token })).status, 202)
  const res = await post(payload(), { token })
  assertRate(res)
  assert.ok(res.json.retryAfterSec <= 600)
  assert.equal((await post(payload(), { token: login().token })).status, 202)
})

test('429 per profile per UTC day, until midnight, kept across a restart', async (t) => {
  withLimits(t, { profilePerDay: 2 })
  const { token, profileId } = login()
  assert.equal((await post(payload(), { token })).status, 202)
  assert.equal((await post(payload(), { token })).status, 202)
  const res = await post(payload(), { token })
  assertRate(res)
  const toMidnight = Math.ceil((autoStore.nextUtcDay(Date.now()) - Date.now()) / 1000)
  assert.ok(Math.abs(res.json.retryAfterSec - toMidnight) <= 2)
  assert.equal(JSON.parse(fs.readFileSync(stateFile(), 'utf8')).profiles[profileId].reports, 2)
  autoStore.load()
  assertRate(await post(payload(), { token }))
  assert.equal(autoStore.today(profileId, autoStore.nextUtcDay(Date.now())).reports, 0)
})

test('invalid-payload mute: schema refusals and invalidField reports count; past the limit a plain 202 stores nothing', async (t) => {
  withLimits(t, { muteInvalidPerHour: 3 })
  const logs = t.mock.method(console, 'log', () => {})
  const { token, profileId } = login()
  const flagged = payload('script-error-on-update')
  flagged.error.frames[0].fn = 'bad`fn'
  assert.equal((await post(flagged, { token })).status, 202)
  assert.deepEqual(stored(profileId, flagged.reportId).flags, ['invalidField'])
  for (let i = 0; i < 2; i++) assert.equal((await post({ ...payload(), reportId: 'nope' }, { token })).status, 422)
  // A consent refusal is not a forgery and does not count
  const optedOut = payload()
  optedOut.consent.errors = false
  assert.equal((await post(optedOut, { token })).json.error, 'consent')
  assert.equal(autoStore.isMuted(profileId, Date.now()), false)
  assert.equal((await post({ ...payload(), reportId: 'nope' }, { token })).status, 422)
  assert.equal(autoStore.isMuted(profileId, Date.now()), true)
  assert.match(logs.mock.calls[0].arguments[0], new RegExp(`profile ${profileId} muted for 24 h: invalid reports`))

  const muted = payload()
  assert.deepEqual((await post(muted, { token })).json, { ok: true, id: muted.reportId, duplicate: false })
  assert.equal(stored(profileId, muted.reportId), null)
  assert.deepEqual((await post({ junk: true }, { token })).json, { ok: true, id: null, duplicate: false })
  const pending = autoStore.pending().length
  await errorGroups.kick()
  assert.equal(autoStore.pending().length, pending)

  // Kept across a restart; other profiles are not affected
  autoStore.load()
  assert.equal(JSON.parse(fs.readFileSync(stateFile(), 'utf8')).profiles[profileId].mutedUntil > Date.now(), true)
  assert.equal((await post(payload(), { token })).status, 202)
  assert.equal(autoStore.isMuted(profileId, Date.now()), true)
  const other = login()
  const fine = payload()
  await post(fine, { token: other.token })
  assert.ok(stored(other.profileId, fine.reportId))
})

test('byte budget: past 2 MB a day, logs and crash sections are dropped and the rest is kept', async (t) => {
  withLimits(t, { profileBytesPerDay: 40 * 1024 })
  const { token, profileId } = login()
  const log = '[10:00:00:000] a line of the game log\n'.repeat(600)
  const first = payload('crash-ours', { logs: { gameLog: log } })
  assert.equal((await post(first, { token })).status, 202)
  const kept = stored(profileId, first.reportId)
  assert.equal(kept.report.logs.gameLog.length, log.length)
  assert.ok(kept.report.crash.sections.callStack)
  assert.ok(!kept.flags.includes('overBudget'))

  const second = payload('crash-ours', { logs: { gameLog: log } })
  assert.equal((await post(second, { token })).status, 202)
  const trimmed = stored(profileId, second.reportId)
  assert.ok(trimmed.flags.includes('overBudget'))
  assert.equal(trimmed.report.logs, undefined)
  assert.equal(trimmed.report.crash.sections, undefined)
  assert.equal(trimmed.report.crash.exception, kept.report.crash.exception)
  assert.equal(trimmed.report.trail.entries.length, kept.report.trail.entries.length)

  const size = id => fs.statSync(autoStore.reportFile(profileId, id)).size
  assert.equal(JSON.parse(fs.readFileSync(stateFile(), 'utf8')).profiles[profileId].bytes, size(first.reportId) + size(second.reportId))
})

test('ignored reports are stored as metadata only and still answer 202', async () => {
  const { token, profileId } = login()
  const body = payload('ui-error-opaque')
  assert.deepEqual((await post(body, { token })).json, { ok: true, id: body.reportId, duplicate: false })
  const record = stored(profileId, body.reportId)
  assert.equal(record.ignored, 'opaque')
  assert.deepEqual(record.report.trail.entries, [])
  assert.equal(record.report.logs, undefined)
})

test('launcher kinds are ignored while crash watch is off', async (t) => {
  config.autoReportCrashWatch = false
  t.after(() => { config.autoReportCrashWatch = true })
  const { token, profileId } = login()
  const body = payload('crash-ours')
  assert.deepEqual((await post(body, { token })).json, { ok: true, id: body.reportId, duplicate: false })
  const record = stored(profileId, body.reportId)
  assert.equal(record.ignored, 'crash-watch-off')
  assert.equal(record.report.crash.sections, undefined)
  assert.equal(record.report.logs, undefined)
  assert.deepEqual(record.report.trail.entries, [])
  const client = payload()
  await post(client, { token })
  assert.equal(stored(profileId, client.reportId).ignored, null)
})

test('503 while off, before the limiter or the session lookup', async (t) => {
  t.after(() => { config.autoReports = 'collect' })
  config.autoReports = 'off'
  const seen = lookups
  const { token, profileId } = login()
  const body = payload()
  const res = await post(body, { token })
  assert.deepEqual([res.status, res.json], [503, { error: 'paused', pauseSec: 3600 }])
  assert.equal(lookups, seen)
  assert.equal(stored(profileId, body.reportId), null)
})

test('on is collected like collect for now, and says so once', async (t) => {
  t.after(() => { config.autoReports = 'collect' })
  config.autoReports = 'on'
  const log = t.mock.method(console, 'log', () => {})
  const { token, profileId } = login()
  for (let i = 0; i < 2; i++) {
    const body = payload()
    assert.equal((await post(body, { token })).status, 202)
    assert.ok(stored(profileId, body.reportId))
  }
  assert.equal(log.mock.calls.filter(c => String(c.arguments[0]).includes('AUTO_REPORTS=on')).length, 1)
})

test('500: a storage failure answers internal in JSON, with no stack and no token in the log', async (t) => {
  const dir = config.autoReportDir
  t.after(() => { config.autoReportDir = dir })
  const blocker = path.join(tmp, 'not-a-folder')
  fs.writeFileSync(blocker, '')
  config.autoReportDir = path.join(blocker, 'auto')
  const errors = t.mock.method(console, 'error', () => {})
  const { token } = login()
  const res = await post(payload(), { token })
  assert.deepEqual([res.status, res.json], [500, { error: 'internal' }])
  assert.ok(errors.mock.calls.length > 0)
  assert.ok(!JSON.stringify(errors.mock.calls.map(c => c.arguments)).includes(token))
})

test('the manual route refuses an auto payload sent without x-report-kind: auto', async () => {
  const { token } = login()
  for (const kind of [null, 'manual', 'Auto']) {
    const res = await post(payload(), { token, kind })
    assert.deepEqual([res.status, res.json], [400, { error: 'x-report-kind' }], String(kind))
  }
  // A manual report without contractVersion still reaches problemReport (not configured in these tests)
  const manual = await post({ note: 'it broke', source: 'launcher' }, { token, kind: null })
  assert.equal(manual.status, 503)
  assert.notEqual(manual.json.error, 'x-report-kind')
})
