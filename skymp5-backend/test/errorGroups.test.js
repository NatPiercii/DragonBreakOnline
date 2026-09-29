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
const unknownVersions = new Set()
stub('../sources/clientVersions', { isKnown: async version => !unknownVersions.has(version) })

const config      = require('../config')
const autoStore   = require('../sources/autoStore')
const errorGroups = require('../sources/errorGroups')
const autoReport  = require('../sources/autoReport')
const sourceMaps  = require('../sources/sourceMaps')
const { validate } = require('../sources/autoSchema')
const { writeFixtureMaps } = require('./fixtures/auto-report/sourcemaps/fixture')
const purgeScript = require('../scripts/purge-auto-reports')

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

test('unknown-version: a client version outside the known list is counted with no group and no map load', async (t) => {
  freshDir()
  unknownVersions.add('0.2.1')
  t.after(() => unknownVersions.clear())
  const loads = t.mock.method(sourceMaps, 'forReport')
  store('script-error-on-update', { profileId: 1, at: T0, patch: { versions: { client: '0.2.1' } } })
  store('script-error-on-update', { profileId: 2, at: T0 + MIN, patch: { versions: { client: '0.2.1' } } })
  store('js-fatal', { profileId: 3, at: T0 + 2 * MIN, patch: { versions: { client: undefined } } })
  await errorGroups.kick()
  assert.equal(loads.mock.calls.length, 1)
  assert.equal(group(ON_UPDATE), null)
  assert.equal(errorGroups.list().length, 1)
  assert.deepEqual(errorGroups.unknownVersion(), { reports: 2, lastSeen: T0 + MIN, versions: { '0.2.1': 2 } })
  errorGroups.flush()
  errorGroups.load()
  assert.deepEqual(errorGroups.unknownVersion(), { reports: 2, lastSeen: T0 + MIN, versions: { '0.2.1': 2 } })

  // Forged versions cannot grow the file: past 50 of them only the total counts
  for (let i = 0; i < 55; i++) unknownVersions.add(`9.9.${i}`)
  for (let i = 0; i < 55; i++) store('script-error-on-update', { profileId: 4, at: T0 + (3 + i) * MIN, patch: { versions: { client: `9.9.${i}` } } })
  await errorGroups.kick()
  assert.equal(errorGroups.unknownVersion().reports, 57)
  assert.equal(Object.keys(errorGroups.unknownVersion().versions).length, 50)
})

test('new signatures: 5 an hour and 15 a day per profile open groups; past that only known groups count', async (t) => {
  freshDir()
  const HOUR = 60 * MIN
  const logs = t.mock.method(console, 'log', () => {})
  const sig = (profileId, word, at) => store('script-error-on-update', { profileId, at, patch: { error: { message: `boom ${word}` } } })
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf']
  words.forEach((w, i) => sig(1, w, T0 + i * MIN))
  sig(1, 'alpha', T0 + 20 * MIN)
  await errorGroups.kick()
  const titles = () => errorGroups.list().map(g => g.normMsg).sort()
  assert.deepEqual(titles(), words.slice(0, 5).map(w => `boom ${w}`))
  assert.equal(errorGroups.list().find(g => g.normMsg === 'boom alpha').reports, 2)

  // Another profile opens the group the first could not; the capped profile then counts toward it
  sig(2, 'foxtrot', T0 + 21 * MIN)
  sig(1, 'foxtrot', T0 + 32 * MIN)
  await errorGroups.kick()
  assert.equal(errorGroups.list().find(g => g.normMsg === 'boom foxtrot').playerCount, 2)

  // The next hour has room again, and the counters survive a restart with the groups
  errorGroups.flush()
  autoStore.load()
  errorGroups.load()
  sig(1, 'golf', T0 + HOUR + MIN)
  await errorGroups.kick()
  assert.ok(errorGroups.list().some(g => g.normMsg === 'boom golf'))
  errorGroups.flush()
  const saved = JSON.parse(fs.readFileSync(groupsFile(), 'utf8'))
  assert.deepEqual(saved.profiles['1'], { hour: autoStore.hourOf(T0 + HOUR), tried: [errorGroups.list().find(g => g.normMsg === 'boom golf').id], day: '2026-09-26', created: 6 })

  // 15 a day: hours 2 and 3 add 5 and 4 more, the rest of the day adds none
  const more = Array.from({ length: 12 }, (_, i) => `more${String.fromCharCode(97 + i)}`)
  more.slice(0, 5).forEach((w, i) => sig(1, w, T0 + 2 * HOUR + i * MIN))
  more.slice(5, 12).forEach((w, i) => sig(1, w, T0 + 3 * HOUR + i * MIN))
  await errorGroups.kick()
  assert.equal(errorGroups.list().filter(g => g.players['1'] && g.firstSeen >= T0 + 2 * HOUR).length, 4 + 5)
  assert.equal(errorGroups.list().length, 7 + 9)
  assert.equal(autoStore.isMuted(1, T0 + 4 * HOUR), false)
  assert.equal(logs.mock.calls.length, 0)
})

test('mute: more than 15 new signatures in an hour mutes the profile for 24 hours, kept across a restart', async (t) => {
  freshDir()
  const logs = t.mock.method(console, 'log', () => {})
  for (let i = 0; i < 17; i++) store('script-error-on-update', { profileId: 7, at: T0 + i * MIN, patch: { error: { message: `burst ${'x'.repeat(i + 1)}` } } })
  await errorGroups.kick()
  assert.equal(errorGroups.list().length, 5)
  assert.equal(autoStore.isMuted(7, T0 + 16 * MIN), true)
  assert.equal(autoStore.isMuted(8, T0 + 16 * MIN), false)
  assert.equal(logs.mock.calls.length, 1)
  assert.match(logs.mock.calls[0].arguments[0], /profile 7 muted for 24 h: new signatures/)
  errorGroups.flush()
  assert.equal(JSON.parse(fs.readFileSync(groupsFile(), 'utf8')).profiles['7'].tried.length, 16)
  autoStore.load()
  assert.equal(autoStore.isMuted(7, T0 + 15 * MIN + autoStore.MUTE_MS - 1), true)
  assert.equal(autoStore.isMuted(7, T0 + 15 * MIN + autoStore.MUTE_MS), false)
})

test('purge: a profile\'s reports, seen ids, counters and ids in groups go; the groups keep their counts', async (t) => {
  const dir = freshDir()
  const kept = store('script-error-on-update', { profileId: 2, at: T0 })
  store('script-error-on-update', { profileId: 1, at: T0 + MIN })
  store('crash-ours', { profileId: 1, at: T0 + 2 * MIN, verified: false, hwid: 'machine-1' })
  await errorGroups.kick()
  errorGroups.markFixed(ON_UPDATE, '0.3.44', T0 + 4 * MIN)
  store('script-error-on-update', { profileId: 1, at: T0 + 5 * MIN })
  await errorGroups.kick()
  errorGroups.flush()
  const counts = id => ['reports', 'occurrences', 'playerCount'].map(k => group(id)[k])
  const before = [counts(ON_UPDATE), counts(CRASH_OURS)]
  assert.deepEqual(group(ON_UPDATE).regression.profiles, ['1'])
  const [[promoted, hwidHash]] = group(CRASH_OURS).promotion
  assert.equal(promoted, '1')
  assert.match(hwidHash, /^[0-9a-f]{16}$/)
  fs.writeFileSync(path.join(dir, 'error-groups.json.bad-1'), '{')

  const logs = t.mock.method(console, 'log', () => {})
  assert.equal(purgeScript.main(['--profile', '1']), 0)
  assert.match(logs.mock.calls[0].arguments[0], /profile 1: 3 report file\(s\) deleted, removed from 2 group\(s\)/)
  assert.match(logs.mock.calls[1].arguments[0], /not edited, check or delete by hand: error-groups\.json\.bad-1/)
  assert.deepEqual(fs.readdirSync(path.join(dir, 'reports')), [`2-${kept.report.reportId}.json`])
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'auto-state.json'), 'utf8'))
  assert.deepEqual(Object.keys(state.profiles), ['2'])
  assert.ok(state.pending.every(e => e[1] !== 1))

  autoStore.load()
  errorGroups.load()
  assert.deepEqual([counts(ON_UPDATE), counts(CRASH_OURS)], before)
  for (const id of [ON_UPDATE, CRASH_OURS]) {
    const g = group(id)
    assert.ok(!('1' in g.players))
    assert.ok(g.daily.every(slot => !slot.players.includes('1')))
    assert.ok(Object.values(g.versions).every(v => v.samples.every(key => !key.startsWith('1-'))))
  }
  assert.deepEqual(group(ON_UPDATE).regression.profiles.map(p => p.startsWith('purged-')), [true])
  assert.deepEqual(group(CRASH_OURS).promotion.map(([p, hwid]) => [p.startsWith('purged-'), hwid]), [[true, null]])
  assert.ok(!fs.readFileSync(groupsFile(), 'utf8').includes(hwidHash))
  assert.equal(JSON.parse(fs.readFileSync(groupsFile(), 'utf8')).profiles['1'], undefined)

  assert.equal(purgeScript.main(['--profile', '../1']), 1)
  assert.equal(purgeScript.main([]), 1)
})

test('state files: a read error keeps what is loaded and retries; a corrupt or misshapen file is moved aside', async (t) => {
  const dir = freshDir()
  store('script-error-on-update', { profileId: 1, at: T0 })
  await errorGroups.kick()
  errorGroups.flush()
  const errors = t.mock.method(console, 'error', () => {})
  const stateFile = path.join(dir, 'auto-state.json')
  const aside = name => fs.readdirSync(dir).filter(f => f.startsWith(`${name}.bad-`))

  // EISDIR stands in for EMFILE or EIO: nothing is replaced, moved or saved empty
  const groupsText = fs.readFileSync(groupsFile(), 'utf8')
  fs.rmSync(groupsFile())
  fs.mkdirSync(groupsFile())
  assert.throws(() => errorGroups.load(), { code: 'EISDIR' })
  assert.equal(group(ON_UPDATE).reports, 1)
  fs.rmdirSync(groupsFile())
  fs.writeFileSync(groupsFile(), groupsText)

  const stateText = fs.readFileSync(stateFile, 'utf8')
  fs.rmSync(stateFile)
  fs.mkdirSync(stateFile)
  config.autoReportDir = path.join(dir, 'elsewhere')
  autoStore.pending()
  config.autoReportDir = dir
  assert.throws(() => autoStore.pending(), { code: 'EISDIR' })
  assert.throws(() => autoStore.pending(), { code: 'EISDIR' })
  fs.rmdirSync(stateFile)
  fs.writeFileSync(stateFile, stateText)
  assert.ok(autoStore.isSeen(1, JSON.parse(stateText).profiles['1'].seen[0][0], T0))
  assert.deepEqual(aside('auto-state.json'), [])

  // Not JSON, or JSON of the wrong shape: kept aside for recovery by hand, and the next save starts a new file
  for (const text of ['{"v":1,', '[]']) {
    fs.writeFileSync(stateFile, text)
    autoStore.load()
    autoStore.save(T0)
    assert.ok(JSON.parse(fs.readFileSync(stateFile, 'utf8')).profiles)
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.equal(aside('auto-state.json').length, 2)
  for (const text of ['{"v":1,', '{"v":1,"seq":4}']) {
    fs.writeFileSync(groupsFile(), text)
    errorGroups.load()
    assert.equal(errorGroups.list().length, 0)
    errorGroups.flush()
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.equal(aside('error-groups.json').length, 2)
  assert.equal(errors.mock.calls.length, 4)
})

test('state file: a pending entry with a reportId like ../x is dropped at load, and no report path is built from one', async (t) => {
  const dir = freshDir()
  const errors = t.mock.method(console, 'error', () => {})
  const record = store('crash-ours', { profileId: 1 })
  const { reportId } = record.report
  // Where a crafted id would lead without the check: <dir>/reports/1-/../../x.json is <dir>/x.json
  fs.writeFileSync(path.join(dir, 'x.json'), JSON.stringify(record))
  const stateFile = path.join(dir, 'auto-state.json')
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  saved.pending = [[1, 1, '../x'], [2, 1, '/../../x'], [3, '1', reportId], [4, -1, reportId], [5, 1, reportId]]
  fs.writeFileSync(stateFile, JSON.stringify(saved))
  autoStore.load()
  assert.deepEqual(autoStore.pending(), [[5, 1, reportId]])
  errorGroups.load()
  await errorGroups.kick()
  assert.equal(group(CRASH_OURS).reports, 1)

  for (const [profileId, id] of [[1, '../x'], [1, '/../../x'], [1, `${reportId}/../x`], [1, reportId.toUpperCase()], ['1', reportId], [1.5, reportId], [-1, reportId], [1, undefined]]) {
    assert.throws(() => autoStore.reportFile(profileId, id), /not a stored report/, `${profileId} ${id}`)
  }
  assert.equal(await autoStore.readReport(1, '/../../x'), null)
  assert.throws(() => autoStore.rewrite({ ...record, report: { ...record.report, reportId: '/../../x' } }), /not a stored report/)
  assert.equal(fs.readFileSync(path.join(dir, 'x.json'), 'utf8'), JSON.stringify(record))
  assert.equal(errors.mock.calls.length, 1)
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

test('start: an auto folder and reports/ made 0755 before are set to 0700; a missing folder is left alone', async (t) => {
  const dir = freshDir()
  t.mock.method(global, 'setInterval', () => ({ unref() {} }))
  const errors = t.mock.method(console, 'error', () => {})
  await autoReport.start()
  const reports = path.join(dir, 'reports')
  fs.mkdirSync(reports, { recursive: true })
  fs.chmodSync(dir, 0o755)
  fs.chmodSync(reports, 0o755)
  // Writing into a folder that exists does not change its mode
  const record = store('crash-ours', { profileId: 1, at: Date.now() })
  assert.equal(mode(dir), 0o755)
  assert.equal(mode(reports), 0o755)
  await autoReport.start()
  assert.equal(mode(dir), 0o700)
  assert.equal(mode(reports), 0o700)
  assert.equal(mode(autoStore.reportFile(1, record.report.reportId)), 0o600)
  assert.equal(errors.mock.calls.length, 0)
})
