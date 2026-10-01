'use strict'
// Server panel status: the boot commit, systemctl show only, service and updater states, claims, and no secret file or path

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const childProcess = require('child_process')
const fs = require('fs')
const path = require('path')
const { createServerStatus, parseShow, SYSTEMCTL_ARGS } = require('../sources/serverStatus')
const { parseUpdaterLog } = require('../sources/releaseQueue')
const { createPanelFixture, showOutput, realRun, write, gitLine, SECRET_RE, PURPOSE, PATH_RE } = require('./helpers/panelFixture')

const T = Date.parse('2026-09-26T08:00:00Z')
const at = ms => `@${Math.floor(ms / 1000)}`
const offline = async () => { throw new Error('offline') }
const SHA = 'a'.repeat(40)

let F, seq = 0
before(() => { F = createPanelFixture('dbo-server-status-') })
after(() => F.cleanup())

const beatAgo = (ms, online = 3) => ({ name: 'Test', maxPlayers: 50, online, lastSeen: new Date(T - ms).toISOString() })
const stubQueue = (log = '') => ({ peek: () => null, peekLive: () => null, updaterLog: async () => parseUpdaterLog(log), history: async () => [], stop() {} })

// A status over its own marker folder, with a fixed clock and fake systemctl output
function stubStatus({ skymp = {}, updater = {}, beat = null, markers = {}, log = '', clock = () => T, run } = {}) {
  const dir = path.join(F.root, `markers-${++seq}`)
  const m = {
    hold: path.join(dir, 'skymp-dev-hold'), stopped: path.join(dir, 'skymp-stopped'), blocked: path.join(dir, 'skymp-update-blocked'),
    buildFailed: path.join(dir, 'skymp-build-failed'), updaterMode: path.join(dir, 'updater-mode'), updaterDirs: [path.join(dir, 'run'), path.join(dir, 'lib')],
  }
  const files = {}
  for (const [key, content] of Object.entries(markers)) files[path.relative(dir, key.includes('/') ? path.join(dir, key) : m[key])] = content
  write(dir, files)
  return createServerStatus({
    config: F.config, markers: m, now: clock, runSync: () => `${SHA}\n`, queue: stubQueue(log), getHeartbeat: () => beat,
    run: run || (async () => ({ stdout: showOutput({ ActiveEnterTimestamp: at(T - 2 * 3600e3), ...skymp }, updater) })),
  })
}

test('systemctl show output is read per unit, in the order the units were named', () => {
  const [skymp, updater] = parseShow(showOutput({ ActiveEnterTimestamp: '@1790380115', NRestarts: 2 }, { ActiveState: 'activating', SubState: 'start' }))
  assert.deepEqual(skymp, { active: 'active', sub: 'running', since: 1790380115000, nRestarts: 2 })
  assert.deepEqual(updater, { active: 'activating', sub: 'start', since: null, nRestarts: 0 })
  assert.deepEqual(parseShow(''), [null])
})

test('boot: HEAD is read once, synchronously, through the guarded git wrapper', () => {
  const calls = []
  const runSync = (file, args, opts) => { calls.push({ file, args, opts }); return childProcess.execFileSync(file, args, opts) }
  const status = createServerStatus({ config: F.config, markers: F.markers, runSync, queue: stubQueue() })
  assert.equal(status.boot.sha, F.S.C)
  assert.equal(calls.length, 1)
  const [{ file, args, opts }] = calls
  assert.deepEqual([file, ...args], gitLine(F.repo, 'rev-parse', '--verify', '--end-of-options', 'HEAD'))
  assert.equal(opts.timeout, 5000)
  assert.equal(opts.env.GIT_OPTIONAL_LOCKS, '0')
  assert.equal(createServerStatus({ config: { ...F.config, releaseRepo: path.join(F.root, 'none') }, queue: stubQueue() }).boot.sha, null)
})

test('status runs only the fixed systemctl show; the queue and live versions arrive from the background refresh', async () => {
  let clock = T
  const calls = [], gitCalls = []
  const status = createServerStatus({
    config: F.config, markers: F.markers, now: () => clock, getHeartbeat: () => beatAgo(5e3),
    run: async (file, args, opts) => { calls.push({ file, args, opts }); return { stdout: showOutput({ ActiveEnterTimestamp: at(T - 3600e3) }) } },
    queueDeps: { run: (file, args, opts) => { gitCalls.push(args); return realRun(file, args, opts) }, fetch: offline },
  })
  try {
    const first = await status.get()
    assert.equal(first.queue, null)
    assert.equal(first.live, null)
    assert.equal(first.backend.restartPending, null)
    const qv = await status.queue.queue()
    clock += 5e3
    const s = await status.get()
    assert.equal(s.queue.hash, qv.hash)
    assert.deepEqual(s.queue.counts.byArea, { Backend: 1, Gameplay: 1 })
    assert.ok(s.queue.drift.includes('headNotLive'))
    assert.deepEqual(s.live.fork, { sha: F.S.B, subject: 'docs: notes, data and the launcher prompt', at: s.live.fork.at, since: '2026-09-25T23:48:55.000Z', confirmed: true, headMatches: false, head: F.S.C })
    assert.deepEqual(s.live.server, { sha: F.S.S0, how: 'matched', deployedAt: '2026-09-26T02:29:19.000Z' })
    assert.deepEqual(s.backend, { since: s.backend.since, bootSha: F.S.C, restartPending: true })
    assert.equal(s.controls, undefined)
    assert.deepEqual(s.release, { open: null })
    assert.deepEqual(s.schedules, [])
    assert.ok(calls.length >= 1)
    for (const c of calls) {
      assert.equal(c.file, 'systemctl')
      assert.deepEqual(c.args, [...SYSTEMCTL_ARGS])
      assert.equal(c.opts.timeout, 3000)
      assert.deepEqual(Object.keys(c.opts.env).sort(), ['LANG', 'PATH'], 'no backend secret reaches systemctl')
    }
    assert.deepEqual(SYSTEMCTL_ARGS, ['show', 'skymp', 'skymp-update.service', '--timestamp=unix', '-p', 'ActiveState,SubState,ActiveEnterTimestamp,NRestarts'])
    assert.ok(gitCalls.length > 0)
  } finally { status.queue.stop() }
})

test('status never waits for git: a stalled queue refresh still answers', async () => {
  let open
  const gate = new Promise(resolve => { open = resolve })
  const status = createServerStatus({
    config: F.config, markers: F.markers, getHeartbeat: () => null, run: async () => ({ stdout: showOutput() }),
    queueDeps: { run: async (...a) => { await gate; return realRun(...a) }, fetch: offline },
  })
  try {
    let timer
    const late = new Promise(resolve => { timer = setTimeout(() => resolve('late'), 2000) })
    const got = await Promise.race([status.get(), late])
    clearTimeout(timer)
    assert.notEqual(got, 'late')
    assert.equal(got.queue, null)
  } finally {
    open()
    await status.queue.queue().catch(() => {})
    status.queue.stop()
  }
})

test('a failing queue refresh shows as unavailable in the status until one succeeds', async () => {
  let clock = T, broken = true
  const killed = () => Object.assign(new Error('killed'), { killed: true, code: null })
  const status = createServerStatus({
    config: F.config, markers: F.markers, now: () => clock, getHeartbeat: () => null, run: async () => ({ stdout: showOutput() }),
    queueDeps: { run: (...a) => (broken ? Promise.reject(killed()) : realRun(...a)), fetch: offline },
  })
  try {
    assert.equal((await status.get()).queue, null)
    await status.queue.queue().catch(() => {})
    clock += 5e3
    const failed = await status.get()
    assert.equal(failed.live, null)
    assert.deepEqual(Object.keys(failed.queue), ['unavailable'])
    assert.equal(failed.queue.unavailable.code, 'timeout')
    assert.equal(failed.queue.unavailable.retryAt, new Date(T + 60e3).toISOString())
    broken = false
    clock += 60e3
    await status.queue.queue()
    clock += 5e3
    const ok = await status.get()
    assert.equal(ok.queue.unavailable, null)
    assert.ok(ok.queue.hash && ok.live)
  } finally { status.queue.stop() }
})

test('restart pending: only backend runtime paths between the boot commit and live count', async () => {
  const cases = [[F.S.A, F.S.B, false], [F.S.A, F.S.C, true], [F.S.C, F.S.C, false], [F.S.B, F.S.C, true], [null, F.S.C, null]]
  for (const [boot, live, expected] of cases) {
    const controlDir = path.join(F.root, `control-rp-${++seq}`)
    write(controlDir, { 'live.json': JSON.stringify({ v: 1, fork: { sha: live } }) })
    const status = createServerStatus({
      config: { ...F.config, controlDir }, markers: F.markers, runSync: () => (boot ? `${boot}\n` : 'fatal\n'),
      run: async () => ({ stdout: showOutput() }), queueDeps: { fetch: offline },
    })
    try {
      const lv = await status.queue.live()
      assert.deepEqual(lv.backend, { bootSha: boot, restartPending: expected }, `${boot?.slice(0, 8)} -> ${live.slice(0, 8)}`)
    } finally { status.queue.stop() }
  }
})

test('service state: reachable, starting, unresponsive, down, stopped and updating', async () => {
  const cases = [
    ['fresh beat', { beat: beatAgo(5e3) }, 'reachable', 3],
    ['a missed beat or two', { beat: beatAgo(30e3) }, 'reachable', null],
    ['silent for over 60 s', { beat: beatAgo(90e3) }, 'unresponsive', null],
    ['no beat 30 s after start', { skymp: { ActiveEnterTimestamp: at(T - 30e3) } }, 'starting', null],
    ['no beat 2 min after start', { skymp: { ActiveEnterTimestamp: at(T - 120e3) } }, 'unresponsive', null],
    ['a beat from the previous run', { skymp: { ActiveEnterTimestamp: at(T - 10e3) }, beat: beatAgo(15e3) }, 'starting', null],
    ['activating', { skymp: { ActiveState: 'activating', SubState: 'start' } }, 'starting', null],
    ['inactive', { skymp: { ActiveState: 'inactive', SubState: 'dead' }, beat: beatAgo(5e3) }, 'down', 0],
    ['failed', { skymp: { ActiveState: 'failed', SubState: 'failed' } }, 'down', 0],
    ['stopped by an owner', { skymp: { ActiveState: 'inactive', SubState: 'dead' }, markers: { stopped: '{}' } }, 'stopped', 0],
    ['building', { beat: beatAgo(5e3), markers: { 'lib/building': '' } }, 'updating', 3],
    ['updater restarting the game', { skymp: { ActiveState: 'deactivating' }, updater: { ActiveState: 'activating', SubState: 'start' } }, 'updating', null],
    ['systemctl unavailable, fresh beat', { beat: beatAgo(5e3), run: async () => { throw new Error('no systemd') } }, 'reachable', 3],
    ['systemctl unavailable, no beat', { run: async () => { throw new Error('no systemd') } }, 'down', 0],
  ]
  for (const [name, opts, state, online] of cases) {
    const s = await stubStatus(opts).get()
    assert.equal(s.service.state, state, name)
    assert.equal(s.players.online, online, name)
  }
  const s = await stubStatus({ beat: beatAgo(5e3) }).get()
  assert.deepEqual(s.service, { state: 'reachable', sub: 'running', since: new Date(Math.floor((T - 2 * 3600e3) / 1000) * 1000).toISOString(), nRestarts: 0 })
  assert.deepEqual(s.players, { online: 3, max: 50, heartbeatAt: new Date(T - 5e3).toISOString() })
  assert.deepEqual((await stubStatus({ run: async () => { throw new Error('x') } }).get()).service, { state: 'down', sub: null, since: null, nRestarts: null })
  const crashed = await stubStatus({ skymp: { ActiveState: 'activating', SubState: 'auto-restart' } }).get()
  assert.deepEqual([crashed.service.state, crashed.service.sub], ['starting', 'auto-restart'])
})

test('the stop marker: who and why; one older than the unit\'s last start is left over and never reads as Stopped', async () => {
  const MARK = JSON.stringify({ by: 'jake (website)', reason: 'Nightly maintenance', at: '2026-09-26T07:00:00.000Z' })
  const since = T - 2 * 3600e3
  const aged = (status, ms) => { fs.utimesSync(status.markers.stopped, ms / 1000, ms / 1000); return status }
  const stopped = await aged(stubStatus({ skymp: { ActiveState: 'inactive', SubState: 'dead' }, markers: { stopped: MARK } }), since + 60e3).get()
  assert.equal(stopped.service.state, 'stopped')
  assert.deepEqual(stopped.stopped, { by: 'jake (website)', reason: 'Nightly maintenance', at: new Date(since + 60e3).toISOString(), leftover: false })
  const running = await aged(stubStatus({ beat: beatAgo(5e3), markers: { stopped: MARK } }), since - 60e3).get()
  assert.equal(running.service.state, 'reachable')
  assert.equal(running.stopped.leftover, true)
  const crashed = await aged(stubStatus({ skymp: { ActiveState: 'failed', SubState: 'failed' }, markers: { stopped: MARK } }), since - 60e3).get()
  assert.deepEqual([crashed.service.state, crashed.stopped.leftover], ['down', true], 'a crash after a reboot is Down, not Stopped')
  const byHand = await stubStatus({ skymp: { ActiveState: 'inactive', SubState: 'dead' }, markers: { stopped: 'maintenance\n' } }).get()
  assert.deepEqual([byHand.service.state, byHand.stopped.by, byHand.stopped.reason], ['stopped', null, null])
  assert.equal((await stubStatus({ beat: beatAgo(5e3) }).get()).stopped, null)
})

test('service state: a rising restart count is unresponsive, and the shared status is cached for 5 s', async () => {
  let clock = T, n = 1, runs = 0
  const status = stubStatus({
    clock: () => clock,
    run: async () => { runs++; return { stdout: showOutput({ NRestarts: n, ActiveEnterTimestamp: at(clock - 10e3) }) } },
  })
  assert.equal((await status.get()).service.state, 'starting')
  n = 2
  clock += 4e3
  assert.equal((await status.get()).service.state, 'starting')
  assert.equal(runs, 1)
  clock += 1e3
  assert.equal((await status.get()).service.state, 'unresponsive')
  assert.equal(runs, 2)
  const [a, b] = await Promise.all([status.get(), status.get()])
  assert.equal(a, b)
})

test('updater: mode, freeze, block, parked build, markers, last run and last update', async () => {
  const mode = async (markers, log = '') => (await stubStatus({ markers, log }).get()).updater
  assert.equal((await mode({})).mode, 'none')
  assert.deepEqual([(await mode({ hold: '' })).mode, (await mode({ hold: '' })).frozen, (await mode({ hold: '' })).hold], ['hold-s0', false, true])
  assert.deepEqual([(await mode({ updaterMode: 'release\n', hold: '' })).mode, (await mode({ updaterMode: 'release\n', hold: '' })).frozen], ['release', true])
  assert.equal((await mode({ updaterMode: 'release\n' })).frozen, false)
  assert.equal((await mode({ updaterMode: 'follow-main\n' })).mode, 'follow-main')
  assert.equal((await mode({ updaterMode: 'follow-main\n', hold: '' })).mode, 'hold-s0')
  assert.equal((await mode({ updaterMode: 'something else' })).mode, 'none')
  assert.equal((await mode({ blocked: '' })).blocked, true)
  assert.equal((await mode({ buildFailed: `${SHA}\n` })).buildFailedFor, SHA)
  assert.equal((await mode({ buildFailed: 'x' })).buildFailedFor, 'unknown')
  assert.equal((await mode({})).buildFailedFor, null)
  assert.deepEqual([(await mode({ 'run/waiting': '' })).waiting, (await mode({ 'run/waiting': '' })).building], [true, false])

  const ok = await mode({}, fs.readFileSync(F.config.updaterLog, 'utf8'))
  assert.deepEqual(ok.lastRun, { at: '2026-09-26T07:00:00Z', result: 'upToDate' })
  assert.deepEqual(ok.lastUpdate, { from: F.S.A.slice(0, 8), to: F.S.B.slice(0, 8), state: 'ok', at: '2026-09-25T23:45:02Z', failed: null })
  const unfinished = await mode({}, '2026-09-26T01:00:00Z UPDATE aaaaaaaa -> bbbbbbbb\n2026-09-26T01:00:05Z BUILD FAILED - service left running on the previous build\n')
  assert.deepEqual([unfinished.lastUpdate.state, unfinished.lastUpdate.failed, unfinished.lastRun.result], ['unfinished', 'build', 'buildFailed'])
  assert.deepEqual((await mode({})).lastUpdate, { from: null, to: null, state: 'unknown', at: null, failed: null })
  assert.equal((await stubStatus({ updater: { ActiveState: 'activating' } }).get()).updater.active, true)
  assert.equal((await stubStatus({}).get()).updater.active, false)
})

test('claims: resource, operator and until only; expired claims and odd names are left out', async () => {
  const s = await stubStatus({}).get()
  const expires = Number(/expires=(\d+)/.exec(fs.readFileSync(path.join(F.config.opsClaimsDir, 'game-server'), 'utf8'))[1])
  assert.deepEqual(s.claims, [{ resource: 'game-server', operator: 'claude-jake', until: new Date(expires * 1000).toISOString() }])
  assert.equal(JSON.stringify(s).includes(PURPOSE), false)
  assert.deepEqual((await createServerStatus({ config: { ...F.config, opsClaimsDir: path.join(F.root, 'none') }, markers: F.markers, runSync: () => '', queue: stubQueue(), run: async () => ({ stdout: '' }) }).get()).claims, [])
})

test('claims: an unreadable claims folder (a non-root backend) is logged, and a missing one is not', { skip: process.getuid?.() === 0 && 'root reads any file' }, async t => {
  const warn = t.mock.method(console, 'warn', () => {})
  const dir = path.join(F.root, 'claims-locked')
  write(dir, { 'game-server': 'operator=claude-jake\nexpires=9999999999\n' })
  const status = dirPath => createServerStatus({ config: { ...F.config, opsClaimsDir: dirPath }, markers: F.markers, runSync: () => '', queue: stubQueue(), run: async () => ({ stdout: '' }) })
  fs.chmodSync(dir, 0o000)
  try {
    assert.deepEqual((await status(dir).get()).claims, [])
    assert.deepEqual((await status(path.join(F.root, 'none')).get()).claims, [])
    assert.deepEqual(warn.mock.calls.map(c => c.arguments.join(' ')), [`[server-status] cannot read ${dir}: EACCES`])
  } finally { fs.chmodSync(dir, 0o755) }
})

test('security: no secret file is ever opened, the config files get a stat only, and nothing carries a path or a claim purpose', async t => {
  const opened = [], statted = []
  const note = (list, name) => (...a) => { if (typeof a[0] === 'string') list.push(`${name} ${a[0]}`) }
  for (const k of ['open', 'openSync', 'readFile', 'readFileSync', 'createReadStream', 'readdir', 'readdirSync', 'opendir', 'opendirSync']) {
    const orig = fs[k]
    t.mock.method(fs, k, function (...a) { note(opened, k)(...a); return orig.apply(this, a) })
  }
  for (const k of ['open', 'readFile', 'readdir', 'opendir']) {
    const orig = fs.promises[k]
    t.mock.method(fs.promises, k, function (...a) { note(opened, `promises.${k}`)(...a); return orig.apply(this, a) })
  }
  for (const k of ['stat', 'lstat']) {
    const orig = fs.promises[k]
    t.mock.method(fs.promises, k, function (...a) { note(statted, k)(...a); return orig.apply(this, a) })
  }
  let clock = T
  const status = createServerStatus({
    config: F.config, markers: F.markers, now: () => clock, getHeartbeat: () => beatAgo(5e3),
    run: async () => ({ stdout: showOutput({ ActiveEnterTimestamp: at(Date.parse('2026-01-01T00:00:00Z')) }) }), queueDeps: { fetch: offline },
  })
  try {
    await status.get()
    await status.queue.queue()
    clock += 5e3
    const out = [await status.get(), await status.queue.queue(), await status.queue.releases()]
    const fileOf = entry => entry.slice(entry.indexOf(' ') + 1)
    assert.ok(opened.length > 5)
    assert.deepEqual(opened.filter(e => SECRET_RE.test(path.basename(fileOf(e)))), [])
    assert.ok(statted.some(e => fileOf(e) === F.config.backendEnvFile))
    assert.ok(statted.some(e => fileOf(e) === path.join(F.config.gameServerDir, 'server-settings.json')))
    assert.ok(out[1].drift.includes('configChangedSinceStart'))
    assert.ok(out[0].history.length > 0 && out[0].history.length <= 5)
    const text = JSON.stringify(out)
    assert.equal(text.includes(F.root), false)
    assert.doesNotMatch(text, PATH_RE)
    assert.equal(text.includes(PURPOSE), false)
    assert.equal(text.includes('SECRET'), false)
  } finally { status.queue.stop() }
})
