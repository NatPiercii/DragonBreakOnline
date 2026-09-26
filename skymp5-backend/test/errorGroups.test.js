'use strict'
// Groups (design §4.3, §4.4, contract §6.2, §6.3): counts, daily slots, held and promotion, regression, samples, restarts, retention

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')

// Never read a real .env, and keep the ban and player stores out of these tests
require.cache[require.resolve('dotenv')] = { exports: { config: () => ({}) } }
for (const key of Object.keys(process.env)) if (key.startsWith('AUTO_REPORT')) delete process.env[key]
function stub(rel, exports) {
  const file = require.resolve(rel)
  require.cache[file] = { id: file, filename: file, loaded: true, exports }
}
stub('../sources/bans', { isBanned: () => null })
stub('../sources/players', { load: () => ({}) })

const config      = require('../config')
const autoStore   = require('../sources/autoStore')
const errorGroups = require('../sources/errorGroups')
const autoReport  = require('../sources/autoReport')
const { validate } = require('../sources/autoSchema')
const { writeFixtureMaps } = require('./fixtures/auto-report/sourcemaps/fixture')

const PAYLOADS = path.join(__dirname, 'fixtures', 'auto-report', 'payloads')
const MIN = 60 * 1000
const DAY = 24 * 60 * MIN
const T0 = Date.UTC(2026, 8, 26, 12)
const ON_UPDATE = 'S35f713adad'
const CRASH_OURS = 'Sb8c2d4d95a'
let tmp, maps, dirs = 0

before(() => {
  config.autoReportCrashWatch = true
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-groups-'))
  maps = path.join(tmp, 'sourcemaps')
  writeFixtureMaps(maps)
})
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

// Every test gets its own data folder; groups and the store reload when it changes
function freshDir(mapDir = maps) {
  config.autoReportDir = path.join(tmp, `auto-${++dirs}`)
  config.autoSourceMapDir = mapDir
  return config.autoReportDir
}

function merge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object') merge(target[key], value)
    else target[key] = value
  }
  return target
}

// Validates a payload fixture and stores it as accept does, received at `at`
function store(name, { profileId = 1, at = T0, verified = true, hwid = null, patch = {} } = {}) {
  const body = merge(JSON.parse(fs.readFileSync(path.join(PAYLOADS, `${name}.json`), 'utf8')), { reportId: crypto.randomUUID(), ...patch })
  const result = validate(body, { receivedAt: at })
  assert.equal(result.ok, true, JSON.stringify(result.json))
  return autoReport.store(result, { receivedAt: at, profileId, launchCheck: { filesOk: verified }, hwid })
}
const group = id => errorGroups.get(id)
const mode = file => fs.statSync(file).mode & 0o777
const groupsFile = () => path.join(config.autoReportDir, 'error-groups.json')

test('one group per signature with reports, occurrences, players, versions and kinds; saved 0600', async () => {
  freshDir()
  store('script-error-rethrown', { profileId: 1, at: T0 })
  store('script-error-logged', { profileId: 2, at: T0 + MIN })
  store('script-error-on-update', { profileId: 1, at: T0 + 2 * MIN })
  store('crash-ours', { profileId: 1, at: T0 + 3 * MIN })
  await errorGroups.kick()

  const g = group(ON_UPDATE)
  assert.equal(g.status, 'open')
  assert.deepEqual(g.held, [])
  assert.equal(g.trust, 'verified')
  assert.equal(g.title, '(Auto Report) TypeError in RemoteServer.onUpdate')
  assert.equal(g.normMsg, 'Cannot read properties of undefined (reading <s>)')
  assert.deepEqual(g.kinds, { 'script-error': 3 })
  assert.equal(g.reports, 3)
  // Profile 1's second report came within 10 minutes of its first, so it does not count again
  assert.equal(g.occurrences, 2)
  assert.equal(g.playerCount, 2)
  assert.deepEqual(Object.keys(g.players).sort(), ['1', '2'])
  assert.equal(g.versions['0.3.44'].occurrences, 2)
  assert.deepEqual(g.daily, [{ day: '2026-09-26', occurrences: 2, players: ['1', '2'] }])
  assert.equal(g.firstSeen, T0)
  assert.equal(g.lastSeen, T0 + 2 * MIN)
  assert.ok(group(CRASH_OURS))
  assert.equal(errorGroups.list().length, 2)

  store('script-error-on-update', { profileId: 1, at: T0 + 12 * MIN })
  await errorGroups.kick()
  assert.equal(group(ON_UPDATE).occurrences, 3)
  assert.equal(group(ON_UPDATE).reports, 4)

  errorGroups.flush()
  assert.equal(mode(groupsFile()), 0o600)
  assert.equal(mode(config.autoReportDir), 0o700)
  const saved = JSON.parse(fs.readFileSync(groupsFile(), 'utf8'))
  assert.equal(saved.seq, 5)
  assert.deepEqual(saved.groups[ON_UPDATE], JSON.parse(JSON.stringify(group(ON_UPDATE))))
  assert.ok(!fs.readdirSync(config.autoReportDir).some(f => f.endsWith('.tmp')))
})

test('14 daily slots: the oldest day drops off, players are listed per day', async () => {
  freshDir()
  for (let day = 0; day < 16; day++) store('freeze-taskkill', { profileId: 10 + (day % 3), at: T0 + day * DAY })
  store('freeze-event1002', { profileId: 99, at: T0 + 15 * DAY + MIN })
  await errorGroups.kick()
  const g = group('S5590c78b9f')
  assert.equal(g.reports, 17)
  assert.deepEqual(g.kinds, { freeze: 17 })
  assert.equal(g.daily.length, 14)
  assert.equal(g.daily[0].day, '2026-09-28')
  assert.equal(g.daily.at(-1).day, '2026-10-11')
  assert.deepEqual(g.daily.at(-1).players, ['10', '99'])
  assert.equal(g.daily.at(-1).occurrences, 2)
})

test('ignored reports, "Script error." included, are stored but never grouped', async () => {
  freshDir()
  store('ui-error-opaque')
  store('crash-ours', { patch: { crash: { crashAt: T0 - 10 * DAY } } })
  await errorGroups.kick()
  assert.equal(errorGroups.list().length, 0)
})

test('held: an unknown build waits for a second profile on another machine', async () => {
  freshDir()
  const patch = { build: { client: 'aaaaaaaaaaaa.20260101T000000Z' } }
  store('script-error-on-update', { profileId: 1, hwid: 'HW-1', patch })
  await errorGroups.kick()
  const id = errorGroups.list()[0].id
  assert.equal(group(id).status, 'held')
  assert.deepEqual(group(id).held, ['unknown-build'])
  assert.equal(group(id).promotion.length, 1)
  assert.match(group(id).promotion[0][1], /^[0-9a-f]{16}$/)

  store('script-error-on-update', { profileId: 1, hwid: 'HW-1', at: T0 + MIN, patch })
  store('script-error-on-update', { profileId: 2, hwid: 'HW-1', at: T0 + 2 * MIN, patch })
  await errorGroups.kick()
  assert.equal(group(id).status, 'held', 'a second profile on the same machine is not enough')

  store('script-error-on-update', { profileId: 3, hwid: 'HW-3', at: T0 + 3 * MIN, patch })
  await errorGroups.kick()
  const g = group(id)
  assert.equal(g.status, 'open')
  assert.deepEqual(g.held, [])
  assert.deepEqual(g.promotion, [])
  assert.equal(g.promotedAt, T0 + 3 * MIN)
  assert.equal(g.playerCount, 3)
})

test('held: frames that do not resolve; sessions without a hardware id count as separate machines', async () => {
  freshDir()
  const patch = { error: { frames: [{ fn: 'Gone.away', line: 90000, col: 1, file: null }] } }
  store('script-error-on-update', { profileId: 1, patch })
  await errorGroups.kick()
  const [g] = errorGroups.list()
  assert.deepEqual([g.status, g.held], ['held', ['unresolved']])
  store('script-error-on-update', { profileId: 2, at: T0 + MIN, patch })
  await errorGroups.kick()
  assert.equal(group(g.id).status, 'open')
})

test('held: an unverified launch waits for a second player, or opens on a verified report', async () => {
  freshDir()
  store('crash-ours', { profileId: 1, verified: false })
  await errorGroups.kick()
  assert.deepEqual([group(CRASH_OURS).status, group(CRASH_OURS).held, group(CRASH_OURS).trust], ['held', ['unverified-launch'], 'unverified-launch'])
  store('crash-ours', { profileId: 1, verified: true, at: T0 + MIN })
  await errorGroups.kick()
  assert.equal(group(CRASH_OURS).status, 'open')
  assert.equal(group(CRASH_OURS).trust, 'verified')
})

test('held: suspect reports never promote a group; a clean one opens it', async () => {
  freshDir()
  const patch = { versions: { client: '0.3.45' }, error: { message: 'suspect only' } }
  store('script-error-on-update', { profileId: 1, hwid: 'A', patch })
  store('script-error-on-update', { profileId: 2, hwid: 'B', at: T0 + MIN, patch })
  await errorGroups.kick()
  const [g] = errorGroups.list()
  assert.deepEqual([g.status, g.held, g.playerCount], ['held', ['suspect'], 2])
  assert.deepEqual(g.promotion, [])
  store('script-error-on-update', { profileId: 3, at: T0 + 2 * MIN, patch: { error: { message: 'suspect only' } } })
  await errorGroups.kick()
  assert.equal(group(g.id).status, 'open')
})

test('regression: needs 2 profiles at or above fixedInVersion, compared as numbers', async () => {
  // No archived build here, so the changed client versions are not suspect
  freshDir(path.join(tmp, 'no-maps'))
  const hit = (profileId, version, at) => store('crash-ours', { profileId, at, patch: { versions: { client: version } } })
  hit(1, '0.3.9', T0)
  await errorGroups.kick()
  assert.equal(errorGroups.markFixed(CRASH_OURS, '0.3.10', T0 + MIN).status, 'fixed')
  assert.equal(errorGroups.markFixed('Snothere000', '0.3.10'), null)

  hit(1, '0.3.9', T0 + 2 * MIN)
  hit(2, '0.3.9', T0 + 3 * MIN)
  await errorGroups.kick()
  assert.equal(group(CRASH_OURS).status, 'fixed', '0.3.9 is below 0.3.10, so it only counts')
  assert.equal(group(CRASH_OURS).regression, null)

  hit(1, '0.3.10', T0 + 4 * MIN)
  hit(1, '0.3.40', T0 + 5 * MIN)
  await errorGroups.kick()
  assert.equal(group(CRASH_OURS).status, 'fixed', 'one profile is not a regression')
  assert.deepEqual(group(CRASH_OURS).regression.profiles, ['1'])

  hit(3, '0.3.40', T0 + 6 * MIN)
  await errorGroups.kick()
  const g = group(CRASH_OURS)
  assert.equal(g.status, 'regression')
  assert.deepEqual(g.regression, { profiles: ['1', '3'], at: T0 + 6 * MIN, version: '0.3.40' })
  assert.equal(g.reports, 6)

  errorGroups.markFixed(CRASH_OURS, null, T0 + 7 * MIN)
  hit(4, '0.3.99', T0 + 8 * MIN)
  hit(5, '0.3.99', T0 + 9 * MIN)
  await errorGroups.kick()
  assert.equal(group(CRASH_OURS).status, 'fixed', 'no version given yet, so nothing can regress')
})

test('full logs and crash sections stay with the first 5 samples per group and version', async () => {
  freshDir(path.join(tmp, 'no-maps'))
  const records = []
  for (let i = 0; i < 7; i++) records.push(store('crash-ours', { profileId: i + 1, at: T0 + i * MIN }))
  records.push(store('crash-ours', { profileId: 1, at: T0 + 8 * MIN, patch: { versions: { client: '0.3.45' } } }))
  await errorGroups.kick()
  const files = records.map(r => autoStore.reportFile(r.profileId, r.report.reportId))
  const saved = files.map(f => JSON.parse(fs.readFileSync(f, 'utf8')))
  for (const i of [0, 1, 2, 3, 4, 7]) {
    assert.ok(saved[i].report.logs.gameLog, `sample ${i}`)
    assert.ok(saved[i].report.crash.sections.callStack, `sample ${i}`)
    assert.ok(!saved[i].flags.includes('overSamples'))
  }
  for (const i of [5, 6]) {
    assert.equal(saved[i].report.logs, undefined)
    assert.equal(saved[i].report.crash.sections, undefined)
    assert.equal(saved[i].report.crash.exception, 'EXCEPTION_ACCESS_VIOLATION')
    assert.ok(saved[i].flags.includes('overSamples'))
    assert.equal(mode(files[i]), 0o600)
    assert.equal(Math.round(fs.statSync(files[i]).mtimeMs), records[i].receivedAt, 'the file keeps its receipt date')
  }
  const g = group(CRASH_OURS)
  assert.equal(g.versions['0.3.44'].samples.length, 5)
  assert.deepEqual(g.versions['0.3.45'].samples, [`1-${records[7].report.reportId}`])
})

test('restart: groups reload, reports not yet saved are applied again, and none counts twice', async (t) => {
  const dir = freshDir()
  store('script-error-on-update', { profileId: 1, at: T0 })
  store('script-error-on-update', { profileId: 2, at: T0 + MIN })
  await errorGroups.kick()
  errorGroups.flush()

  // Applied in memory, then the process dies before the debounced save
  store('script-error-on-update', { profileId: 3, at: T0 + 2 * MIN })
  await errorGroups.kick()
  assert.equal(group(ON_UPDATE).reports, 3)
  autoStore.load()
  errorGroups.load()
  assert.equal(group(ON_UPDATE).reports, 2)
  assert.deepEqual(autoStore.pending().map(e => e[0]), [3])
  await errorGroups.kick()
  assert.equal(group(ON_UPDATE).reports, 3)
  assert.equal(group(ON_UPDATE).playerCount, 3)

  // Saved, but auto-state.json still lists the entries: they are not applied again
  errorGroups.flush()
  autoStore.load()
  errorGroups.load()
  await errorGroups.kick()
  assert.equal(group(ON_UPDATE).reports, 3)
  autoStore.save(T0 + 3 * MIN)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'auto-state.json'), 'utf8')).pending, [])

  // A lost auto-state.json never restarts the numbering below what the groups hold
  fs.rmSync(path.join(dir, 'auto-state.json'))
  autoStore.load()
  errorGroups.load()
  store('script-error-on-update', { profileId: 4, at: T0 + 4 * MIN })
  assert.deepEqual(autoStore.pending().map(e => e[0]), [4])
  await errorGroups.kick()
  assert.equal(group(ON_UPDATE).reports, 4)

  // An unreadable groups file is moved aside rather than overwritten
  const errors = t.mock.method(console, 'error', () => {})
  fs.writeFileSync(groupsFile(), '{"v":1,')
  errorGroups.load()
  assert.equal(errorGroups.list().length, 0)
  assert.equal(errors.mock.calls.length, 1)
  assert.ok(fs.readdirSync(dir).some(f => f.startsWith('error-groups.json.bad-')))
})

test('retention janitor: reports past 30 days and stale temp files go; recent and unknown files stay', async () => {
  const dir = freshDir()
  const now = T0 + 40 * DAY
  const old = store('crash-ours', { profileId: 1, at: now - 31 * DAY })
  const recent = store('crash-ours', { profileId: 2, at: now - 29 * DAY })
  const reports = path.dirname(autoStore.reportFile(1, old.report.reportId))
  const touch = (file, age) => {
    fs.writeFileSync(file, '')
    fs.utimesSync(file, new Date(), new Date(now - age))
  }
  touch(path.join(reports, '5-3f1c2b9e-8a41-4d2e-9b7a-000000000099.json.0123456789ab.tmp'), 2 * 60 * MIN)
  touch(path.join(reports, '6-3f1c2b9e-8a41-4d2e-9b7a-000000000098.json.0123456789ac.tmp'), MIN)
  touch(path.join(dir, 'error-groups.json.0123456789ad.tmp'), 2 * 60 * MIN)
  touch(path.join(reports, 'notes.txt'), 90 * DAY)

  assert.equal(await autoStore.janitor(now), 3)
  assert.ok(!fs.existsSync(autoStore.reportFile(1, old.report.reportId)))
  assert.ok(fs.existsSync(autoStore.reportFile(2, recent.report.reportId)))
  assert.deepEqual(fs.readdirSync(reports).sort(),
    [`2-${recent.report.reportId}.json`, '6-3f1c2b9e-8a41-4d2e-9b7a-000000000098.json.0123456789ac.tmp', 'notes.txt'])

  // A pending report the janitor already removed is skipped
  await errorGroups.kick()
  assert.equal(group(CRASH_OURS).reports, 1)
  assert.equal(await autoStore.janitor(now), 0)
})

test('start: runs the janitor and groups reports stored before a restart', async (t) => {
  freshDir()
  const intervals = t.mock.method(global, 'setInterval', () => ({ unref() {} }))
  const old = store('freeze-taskkill', { profileId: 1, at: Date.now() - 31 * DAY })
  store('crash-ours', { profileId: 1, at: Date.now() })
  autoStore.load()
  errorGroups.load()
  assert.equal(errorGroups.list().length, 0)
  await autoReport.start()
  assert.equal(intervals.mock.calls.length, 1)
  assert.equal(intervals.mock.calls[0].arguments[1], 6 * 60 * 60 * 1000)
  assert.ok(group(CRASH_OURS))
  assert.ok(!fs.existsSync(autoStore.reportFile(1, old.report.reportId)))
})
