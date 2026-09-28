'use strict'
// Server controls: request checks, the state matrix, the exact ledger and systemd argv, the stopped marker, the job's
// follow-up and claim release, single flight, repeats, dry run, and that no command ever runs through a shell

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const childProcess = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

require.cache[require.resolve('dotenv')] = { exports: { config: () => ({}) } }
const {
  createServerControl, parseRequest, cleanReason, refusal, SYSTEMCTL, OPS, OPERATOR,
} = require('../sources/serverControl')

const ID = '0b7c9a52-3f0e-4c1d-9a6b-2d4e8f1a0c3e'
const uuid = n => `0b7c9a52-3f0e-4c1d-9a6b-${String(n).padStart(12, '0')}`
const T0 = Date.parse('2026-09-28T10:00:00Z')
const PURPOSE_SECRET = 'rebuilding the world, do not share'

let root, seq = 0
before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbo-server-control-')) })
after(() => fs.rmSync(root, { recursive: true, force: true }))

// A control over its own marker folder, a fake systemd and ledger, a fixed clock and polls that do not wait
function harness({ unit = {}, updater = null, online = 0, beatAge = 5000, setting = 'on', held = null, opsFail = {}, systemctlFail = false, afterCommand } = {}) {
  const dir = path.join(root, `m-${++seq}`)
  fs.mkdirSync(dir, { recursive: true })
  const markers = { stopped: path.join(dir, 'skymp-stopped'), control: path.join(dir, 'server-control'), updaterDirs: [path.join(dir, 'run'), path.join(dir, 'lib')] }
  if (setting != null) fs.writeFileSync(markers.control, `${setting}\n`)
  let t = T0
  const h = {
    dir, markers, jobsFile: path.join(dir, 'server-jobs.json'), calls: [], audits: [], units: 0,
    unit: { active: 'active', sub: 'running', since: T0 - 3600e3, nRestarts: 0, ...unit },
    updater, beat: { name: 'Test', maxPlayers: 50, online, lastSeen: new Date(T0 - beatAge).toISOString() },
    clock: () => t, advance: ms => { t += ms },
  }
  const status = { markers, units: async () => { h.units++; h.onUnits?.(h.units); return { skymp: h.unit ? { ...h.unit } : null, updater: h.updater } } }
  h.run = async (file, args, opts) => {
    h.calls.push({ file, args: [...args], opts })
    if (file === OPS) {
      const sub = args[0]
      h.onOps?.(args)
      if (sub === 'check' && h.checkOut) throw Object.assign(new Error('Command failed'), { code: 2, stdout: h.checkOut })
      if (opsFail[sub]) throw Object.assign(new Error('ops failed'), { code: 1, stdout: '', stderr: 'ops: ledger busy, retry\n' })
      if (sub === 'claim' && held) {
        throw Object.assign(new Error('Command failed'), { code: 2, stdout: `HELD: game-server is claimed by ${held} until 2026-09-28T12:00Z for: ${PURPOSE_SECRET}\n` })
      }
      return { stdout: `${sub} ok\n`, stderr: '' }
    }
    if (systemctlFail) throw Object.assign(new Error('Failed to start'), { code: 1 })
    afterCommand?.(h, args[1])
    return { stdout: '', stderr: '' }
  }
  // make() again is a restarted backend over the same jobs file
  h.make = () => createServerControl({
    // Once beating, the server sends a beat every few seconds, the last one a second ago
    status, getHeartbeat: () => (h.beating ? { ...h.beat, lastSeen: new Date(h.clock() - 1000).toISOString() } : h.beat), run: h.run, now: h.clock, wait: async ms => h.advance(ms),
    audit: { log: line => h.audits.push(line) }, jobsFile: h.jobsFile,
  })
  h.control = h.make()
  h.opsCalls = () => h.calls.filter(c => c.file === OPS).map(c => c.args)
  h.systemctlCalls = () => h.calls.filter(c => c.file === 'systemctl').map(c => c.args)
  h.idle = async () => { for (let i = 0; i < 500 && h.control.controlsFor(h.status(), { owner: true, setting: 'on' }).why === 'busy'; i++) await new Promise(r => setImmediate(r)) }
  h.status = () => ({ service: { state: 'reachable' }, players: { online: 0 }, claims: [] })
  return h
}

// systemd as it answers once the command has run
const systemd = {
  stop: h => { h.unit = { ...h.unit, active: 'inactive', sub: 'dead' } },
  up: h => {
    h.advance(1000)
    h.unit = { ...h.unit, active: 'active', sub: 'running', since: Math.floor(h.clock() / 1000) * 1000, nRestarts: 0 }
    h.beat = { ...h.beat, online: 0 }
    h.beating = true
  },
}
const act = (h, action, extra = {}) => h.control.perform(action, { requestId: ID, reason: 'Nightly maintenance', by: 'jake', discordId: '111', ...extra })

test('reasons are NFC-normalised, lose controls, CR, LF and bidi marks, and must be 5-200 characters', () => {
  assert.equal(cleanReason('  Fix \u202Ethe\u2066 crash\r\nexpires=9999999999  '), 'Fix the crash expires=9999999999')
  assert.equal(cleanReason('Cafe\u0301 reboot'), 'Caf\u00e9 reboot')
  assert.equal(cleanReason('a\u0085b\u009bc\u061cd\u200be'), 'a b c d e')
  assert.equal(cleanReason('abcd'), null)
  assert.equal(cleanReason('abcde'), 'abcde')
  assert.equal(cleanReason('\u0000\u0001\u0002\u0003\u0004\u0005'), null)
  assert.equal(cleanReason('x'.repeat(200)), 'x'.repeat(200))
  assert.equal(cleanReason('x'.repeat(201)), null)
  assert.equal(cleanReason('\u{1F409}'.repeat(200)).length, 400, 'counted in characters, not UTF-16 units')
  for (const bad of [null, 12345, ['reason'], { r: 1 }]) assert.equal(cleanReason(bad), null)
})

test('a request needs exactly requestId (UUIDv4), a valid reason and the typed word', () => {
  const ok = { requestId: ID.toUpperCase(), reason: 'Nightly maintenance', confirm: 'STOP' }
  assert.deepEqual(parseRequest('stop', ok), { requestId: ID, reason: 'Nightly maintenance' })
  assert.deepEqual(parseRequest('start', { ...ok, confirm: ' START ' }), { requestId: ID, reason: 'Nightly maintenance' })
  assert.deepEqual(parseRequest('restart', { ...ok, confirm: 'RESTART' }), { requestId: ID, reason: 'Nightly maintenance' })
  const cases = [
    [null, 'badRequest'], [[], 'badRequest'], ['text', 'badRequest'],
    [{ ...ok, extra: 1 }, 'badRequest'], [JSON.parse(`{"__proto__":{"x":1},"requestId":"${ID}","reason":"Nightly","confirm":"STOP"}`), 'badRequest'],
    [{ ...ok, requestId: 'not-a-uuid' }, 'badRequest'], [{ ...ok, requestId: '0b7c9a52-3f0e-1c1d-9a6b-2d4e8f1a0c3e' }, 'badRequest'],
    [{ ...ok, reason: 'hi' }, 'badReason'], [{ ...ok, reason: undefined }, 'badReason'],
    [{ ...ok, confirm: undefined }, 'badConfirm'], [{ ...ok, confirm: 'stop' }, 'badConfirm'], [{ ...ok, confirm: 'RESTART' }, 'badConfirm'],
  ]
  for (const [body, error] of cases) assert.deepEqual(parseRequest('stop', body), { error }, JSON.stringify(body))
})

test('the state matrix: Start only when down, Stop and Restart only when up at 0 players, nothing while updating', () => {
  const up = { active: 'active' }, down = { active: 'inactive' }, failed = { active: 'failed' }, starting = { active: 'activating' }
  const rows = [
    [{ unit: down, online: null }, 'start', null], [{ unit: failed, online: null }, 'start', null], [{ unit: up, online: 0 }, 'start', 'alreadyRunning'],
    [{ unit: starting, online: null }, 'start', 'changing'], [{ unit: { active: 'deactivating' } }, 'stop', 'changing'],
    [{ unit: up, online: 0 }, 'stop', null], [{ unit: up, online: 0 }, 'restart', null],
    [{ unit: up, online: 3 }, 'stop', 'playersOnline'], [{ unit: up, online: 1 }, 'restart', 'playersOnline'],
    [{ unit: up, online: null }, 'stop', 'playersUnknown'], [{ unit: up, online: null }, 'restart', 'playersUnknown'],
    [{ unit: down, online: 0 }, 'stop', 'notRunning'], [{ unit: failed, online: 0 }, 'restart', 'useStart'],
    [{ unit: down, online: 0, updating: true }, 'start', 'updating'], [{ unit: up, online: 0, updating: true }, 'restart', 'updating'],
    [{ unit: null, online: 0 }, 'start', 'unavailable'],
    [{ unit: { active: 'activating', sub: 'auto-restart' }, online: null }, 'stop', null],
    [{ unit: { active: 'activating', sub: 'auto-restart-queued' }, online: null }, 'stop', null],
    [{ unit: { active: 'activating', sub: 'auto-restart' }, online: null }, 'start', 'changing'],
    [{ unit: { active: 'activating', sub: 'auto-restart' }, online: null }, 'restart', 'changing'],
    [{ unit: { active: 'activating', sub: 'auto-restart' }, online: 0, updating: true }, 'stop', 'updating'],
    [{ unit: { active: 'activating', sub: 'start' }, online: null }, 'stop', 'changing'],
  ]
  for (const [state, action, why] of rows) assert.equal(refusal(action, state), why, `${action} ${JSON.stringify(state)}`)
})

test('Stop at 0 players: claim, log, marker, then systemctl --no-block stop, all with fixed argv; the claim is released once stopped', async () => {
  const h = harness({ afterCommand: systemd.stop })
  const res = await act(h, 'stop', { reason: 'Nightly\r\nexpires=1 \u202Emaintenance' })
  assert.equal(res.status, 202)
  assert.deepEqual(res.body.job, {
    id: ID, action: 'stop', state: 'running', dryRun: false, by: 'jake', reason: 'Nightly expires=1 maintenance', requestedAt: new Date(T0).toISOString(), finishedAt: null,
  })
  await h.idle()
  const purpose = 'Stop (stays stopped) from the website dashboard by jake: Nightly expires=1 maintenance'
  assert.deepEqual(h.opsCalls(), [
    ['claim', 'game-server', 'site-owner', purpose, '15'],
    ['log', 'site-owner', purpose, `Start on the website dashboard, or rm ${h.markers.stopped} && systemctl start skymp`],
    ['release', 'game-server', 'site-owner'],
  ])
  assert.deepEqual(h.systemctlCalls(), [['--no-block', 'stop', 'skymp.service']])
  assert.equal(h.control.job(ID).state, 'done')
  const marker = JSON.parse(fs.readFileSync(h.markers.stopped, 'utf8'))
  assert.deepEqual(marker, { by: 'jake (website)', reason: 'Nightly expires=1 maintenance', at: new Date(T0).toISOString() })
  assert.equal(fs.statSync(h.markers.stopped).mode & 0o777, 0o644)
  assert.deepEqual(fs.readdirSync(h.dir).sort(), ['server-control', 'server-jobs.json', 'skymp-stopped'], 'no temporary file is left')
})

test('every argument is one clean argv element, and children get only PATH and LANG with a timeout', async () => {
  process.env.DBO_TEST_SECRET = 'leak'
  try {
    const h = harness({ afterCommand: systemd.stop })
    const { requestId, reason } = parseRequest('stop', { requestId: ID, reason: 'Stop now\nexpires=1\r\n"; rm -rf / #', confirm: 'STOP' })
    await act(h, 'stop', { requestId, reason, by: 'ja\u202Eke\n' })
    await h.idle()
    for (const call of h.calls) {
      assert.ok(call.args.every(a => typeof a === 'string' && !/[\r\n\u202E]/.test(a)), JSON.stringify(call.args))
      assert.deepEqual(Object.keys(call.opts.env).sort(), ['LANG', 'PATH'])
      assert.equal(call.opts.shell, undefined)
      assert.equal(call.opts.timeout, 20000)
    }
    assert.equal(h.opsCalls()[0][3], 'Stop (stays stopped) from the website dashboard by ja ke: Stop now expires=1 "; rm -rf / #')
    assert.equal(h.opsCalls()[0].length, 5)
  } finally { delete process.env.DBO_TEST_SECRET }
})

test('Start when down clears the stopped marker (noted in the ledger) and starts; done once a heartbeat of the new run arrives', async () => {
  const h = harness({ unit: { active: 'inactive', sub: 'dead' }, afterCommand: systemd.up })
  fs.writeFileSync(h.markers.stopped, JSON.stringify({ by: 'nate (website)', reason: 'Keep\nit down', at: '2026-09-27T01:00:00.000Z' }))
  const res = await act(h, 'start', { reason: 'Back up after maintenance' })
  assert.equal(res.status, 202)
  assert.equal(fs.existsSync(h.markers.stopped), false)
  await h.idle()
  const purpose = 'Start from the website dashboard by jake: Back up after maintenance'
  assert.deepEqual(h.opsCalls(), [
    ['claim', 'game-server', 'site-owner', purpose, '15'],
    ['log', 'site-owner', `${purpose}; cleared the stopped marker (nate (website), 2026-09-27T01:00:00.000Z: Keep it down)`, 'Stop on the website dashboard, or systemctl stop skymp'],
    ['release', 'game-server', 'site-owner'],
  ])
  assert.deepEqual(h.systemctlCalls(), [['--no-block', 'start', 'skymp.service']])
  assert.equal(h.control.job(ID).state, 'done')
  assert.ok(h.audits.includes('WEB start requested by jake (111): Back up after maintenance'))
  assert.ok(h.audits.includes('WEB start by jake (111) done'))
})

test('Restart at 0 players waits for the new run; a failed unit or a rising restart count is a failure, silence is unconfirmed', async () => {
  const ok = harness({ afterCommand: systemd.up })
  assert.equal((await act(ok, 'restart')).status, 202)
  await ok.idle()
  assert.deepEqual(ok.systemctlCalls(), [['--no-block', 'restart', 'skymp.service']])
  assert.equal(ok.control.job(ID).state, 'done')
  assert.equal(fs.existsSync(ok.markers.stopped), false, 'a restart writes no marker')

  const crash = harness({ afterCommand: h => { systemd.up(h); h.unit.active = 'failed' } })
  await act(crash, 'restart')
  await crash.idle()
  assert.equal(crash.control.job(ID).state, 'failed')
  assert.deepEqual(crash.opsCalls().slice(-2), [
    ['log', 'site-owner', 'Result: Restart from the website dashboard by jake: FAILED; skymp is failed', 'Nothing to undo; if it stays down, Start on the website dashboard or systemctl start skymp'],
    ['release', 'game-server', 'site-owner'],
  ])

  // Up again, then systemd restarts it on its own before any heartbeat of the new run
  const loop = harness({ afterCommand: h => { systemd.up(h); h.beating = false; h.beat.lastSeen = new Date(T0 - 3600e3).toISOString(); h.onUnits = n => { if (n === 4) h.unit.nRestarts = 1 } } })
  await act(loop, 'restart')
  await loop.idle()
  assert.equal(loop.control.job(ID).state, 'failed')
  assert.equal(loop.units, 4 + 1, 'the fourth read saw the restart count rise, one more for the result line')

  // The old run's last beat lands in the new run's first second, then the new run stays silent
  const old = harness({
    afterCommand: h => {
      h.advance(1000)
      const since = Math.floor(h.clock() / 1000) * 1000
      h.unit = { ...h.unit, active: 'active', since }
      h.beat = { ...h.beat, online: 0, lastSeen: new Date(since + 200).toISOString() }
    },
  })
  await act(old, 'restart')
  await old.idle()
  assert.equal(old.control.job(ID).state, 'unconfirmed', 'a beat from before the new run showed is not proof')

  const silent = harness({ afterCommand: h => { h.advance(1000); h.unit = { ...h.unit, active: 'active', since: Math.floor(h.clock() / 1000) * 1000 } } })
  await act(silent, 'restart')
  await silent.idle()
  assert.equal(silent.control.job(ID).state, 'unconfirmed')
  assert.equal(silent.units, 2 + 40 + 1, 'a check, a second one under the claim, 40 polls three seconds apart, then the result line')
  assert.deepEqual(silent.opsCalls().slice(-2).map(a => a.slice(0, 3)), [
    ['log', 'site-owner', 'Result: Restart from the website dashboard by jake: not confirmed within 2 minutes; skymp is active'],
    ['release', 'game-server', 'site-owner'],
  ])
  assert.deepEqual(ok.opsCalls().map(a => a[0]), ['claim', 'log', 'release'], 'done needs no result line')
})

test('Stop is offered while systemd waits to restart a crashed server, and ends the retries', async () => {
  const h = harness({ unit: { active: 'activating', sub: 'auto-restart' }, beatAge: 90e3, afterCommand: systemd.stop })
  const s = (sub, online = null) => ({ service: { state: 'starting', sub }, players: { online }, claims: [] })
  const pick = x => [x.canStart, x.canStop, x.canRestart, x.why]
  assert.deepEqual(pick(h.control.controlsFor(s('auto-restart'), { owner: true, setting: 'on' })), [false, true, false, null])
  assert.deepEqual(pick(h.control.controlsFor(s('start'), { owner: true, setting: 'on' })), [false, false, false, 'changing'])
  assert.equal((await act(h, 'stop')).status, 202)
  await h.idle()
  assert.equal(h.control.job(ID).state, 'done')
  assert.deepEqual(h.systemctlCalls(), [['--no-block', 'stop', 'skymp.service']])
  assert.equal(JSON.parse(fs.readFileSync(h.markers.stopped, 'utf8')).by, 'jake (website)')
})

test('a stopped marker left behind by a reboot or a manual start: Restart clears it (noted), and restores it if systemctl refuses', async t => {
  const LEFT = JSON.stringify({ by: 'nate (website)', reason: 'Keep it down', at: '2026-09-27T01:00:00.000Z' })
  const h = harness({ afterCommand: systemd.up })
  fs.writeFileSync(h.markers.stopped, LEFT)
  assert.equal((await act(h, 'restart')).status, 202)
  assert.equal(fs.existsSync(h.markers.stopped), false)
  await h.idle()
  assert.equal(h.control.job(ID).state, 'done')
  assert.equal(h.opsCalls()[1][2], 'Restart from the website dashboard by jake: Nightly maintenance; cleared a leftover stopped marker (nate (website), 2026-09-27T01:00:00.000Z: Keep it down)')

  t.mock.method(console, 'error', () => {})
  const refused = harness({ systemctlFail: true })
  fs.writeFileSync(refused.markers.stopped, LEFT)
  assert.equal((await act(refused, 'restart')).status, 502)
  assert.equal(fs.readFileSync(refused.markers.stopped, 'utf8'), LEFT)
})

test('a Stop that never took (unconfirmed, unit still active) removes the marker it wrote; one still stopping keeps it', async () => {
  const stuck = harness({ afterCommand: () => {} })
  assert.equal((await act(stuck, 'stop')).status, 202)
  await stuck.idle()
  assert.equal(stuck.control.job(ID).state, 'unconfirmed')
  assert.equal(fs.existsSync(stuck.markers.stopped), false)
  assert.deepEqual(stuck.opsCalls().slice(-2), [
    ['log', 'site-owner', 'Result: Stop (stays stopped) from the website dashboard by jake: not confirmed within 2 minutes; skymp is active, its stopped marker removed', 'Nothing to roll back; the server kept running'],
    ['release', 'game-server', 'site-owner'],
  ])

  const slow = harness({ afterCommand: h => { h.unit = { ...h.unit, active: 'deactivating', sub: 'stop-sigterm' } } })
  await act(slow, 'stop')
  await slow.idle()
  assert.equal(slow.control.job(ID).state, 'unconfirmed')
  assert.equal(JSON.parse(fs.readFileSync(slow.markers.stopped, 'utf8')).by, 'jake (website)', 'still stopping: the marker stays')
  assert.match(slow.opsCalls().at(-2)[2], /; skymp is deactivating$/)
})

test('refusals run no ledger or systemd command: players online, players unknown, already running, not running, updating', async () => {
  const cases = [
    [{ online: 2 }, 'stop', 409, 'playersOnline'], [{ online: 1 }, 'restart', 409, 'playersOnline'],
    [{ beatAge: 25000 }, 'stop', 409, 'playersUnknown'], [{ online: 0 }, 'start', 409, 'alreadyRunning'],
    [{ unit: { active: 'inactive' } }, 'stop', 409, 'notRunning'], [{ unit: { active: 'failed' } }, 'restart', 409, 'useStart'],
    [{ updater: { active: 'activating' } }, 'restart', 409, 'updating'], [{ unit: null }, 'start', 503, 'unavailable'],
    [{ setting: null }, 'stop', 503, 'controlsOff'], [{ setting: 'off' }, 'stop', 503, 'controlsOff'], [{ setting: 'yes' }, 'stop', 503, 'controlsOff'],
  ]
  for (const [opts, action, code, error] of cases) {
    const h = harness(opts)
    if (opts.unit === null) h.unit = null
    const res = await act(h, action)
    assert.deepEqual(res, { status: code, body: { error } }, `${action} ${JSON.stringify(opts)}`)
    assert.deepEqual(h.calls, [], `${action} ${error}`)
    assert.equal(fs.existsSync(h.markers.stopped), false)
    assert.equal(h.control.job(ID), null, 'a refusal is not remembered')
  }
  const building = harness()
  fs.mkdirSync(building.markers.updaterDirs[1], { recursive: true })
  fs.writeFileSync(path.join(building.markers.updaterDirs[1], 'building'), '')
  assert.deepEqual((await act(building, 'restart')).body, { error: 'updating' })
})

test('a claim held by another operator refuses with the holder only, and nothing else runs', async () => {
  const h = harness({ held: 'claude-nate' })
  const res = await act(h, 'restart')
  assert.deepEqual(res, { status: 409, body: { error: 'claimed', holder: 'claude-nate' } })
  assert.equal(JSON.stringify(res).includes(PURPOSE_SECRET), false)
  assert.deepEqual(h.opsCalls(), [['claim', 'game-server', 'site-owner', 'Restart from the website dashboard by jake: Nightly maintenance', '15']])
  assert.deepEqual(h.systemctlCalls(), [])
})

test('a ledger failure refuses with 503, logs the ledger\'s reason and releases a claim it took', async t => {
  const errors = t.mock.method(console, 'error', () => {})
  const claimFails = harness({ opsFail: { claim: true } })
  assert.deepEqual(await act(claimFails, 'stop'), { status: 503, body: { error: 'ledgerUnavailable' } })
  assert.deepEqual(errors.mock.calls.map(c => c.arguments), [['[server-control] ops claim failed (1):', 'ops: ledger busy, retry']])
  assert.deepEqual(claimFails.opsCalls().map(a => a[0]), ['claim'])
  const logFails = harness({ opsFail: { log: true } })
  assert.deepEqual(await act(logFails, 'stop'), { status: 503, body: { error: 'ledgerUnavailable' } })
  assert.deepEqual(logFails.opsCalls().map(a => a[0]), ['claim', 'log', 'release'])
  assert.deepEqual(logFails.systemctlCalls(), [])
  assert.equal(fs.existsSync(logFails.markers.stopped), false)
})

test('a player who joins between the check and systemctl calls it off, logged, released, nothing stopped', async () => {
  const h = harness()
  const run = h.run
  h.control = createServerControl({
    status: { markers: h.markers, units: async () => ({ skymp: { ...h.unit }, updater: null }) }, getHeartbeat: () => h.beat, now: h.clock, wait: async () => {},
    audit: { log: () => {} }, jobsFile: h.jobsFile,
    run: async (file, args, opts) => { if (args[0] === 'claim') h.beat = { ...h.beat, online: 1 }; return run(file, args, opts) },
  })
  assert.deepEqual(await act(h, 'stop'), { status: 409, body: { error: 'playersOnline' } })
  assert.deepEqual(h.opsCalls().map(a => a[0]), ['claim', 'log', 'log', 'release'])
  assert.match(h.opsCalls()[2][2], /^Called off: Stop \(stays stopped\) from the website dashboard, a player joined before it ran$/)
  assert.deepEqual(h.systemctlCalls(), [])
  assert.equal(fs.existsSync(h.markers.stopped), false)
})

test('the state is read again under the claim: an update that began or a unit that moved calls it off', async () => {
  const building = h => {
    fs.mkdirSync(h.markers.updaterDirs[0], { recursive: true })
    fs.writeFileSync(path.join(h.markers.updaterDirs[0], 'building'), '')
  }
  const cases = [
    ['restart', 'Restart', {}, h => { h.updater = { active: 'activating', sub: 'start' } }, 'updating', 'an update began'],
    ['stop', 'Stop (stays stopped)', {}, building, 'updating', 'an update began'],
    ['start', 'Start', { active: 'inactive', sub: 'dead' }, h => { h.unit = { ...h.unit, active: 'active', sub: 'running' } }, 'alreadyRunning', 'the server changed (alreadyRunning)'],
  ]
  for (const [action, verb, unit, change, error, why] of cases) {
    const h = harness({ unit })
    h.onOps = args => { if (args[0] === 'claim') change(h) }
    assert.deepEqual(await act(h, action), { status: 409, body: { error } }, action)
    assert.deepEqual(h.opsCalls().map(a => a[0]), ['claim', 'log', 'log', 'release'], action)
    assert.equal(h.opsCalls()[2][2], `Called off: ${verb} from the website dashboard, ${why} before it ran`)
    assert.deepEqual(h.systemctlCalls(), [], action)
    assert.equal(fs.existsSync(h.markers.stopped), false, action)
  }
})

test('a systemctl failure restores the marker as it was, fails the job and releases the claim', async t => {
  t.mock.method(console, 'error', () => {})
  const stop = harness({ systemctlFail: true })
  const res = await act(stop, 'stop')
  assert.equal(res.status, 502)
  assert.equal(res.body.error, 'actionFailed')
  assert.equal(res.body.job.state, 'failed')
  assert.equal(fs.existsSync(stop.markers.stopped), false)
  assert.deepEqual(stop.opsCalls().slice(-2), [
    ['log', 'site-owner', 'Result: Stop (stays stopped) from the website dashboard by jake: systemctl refused it, nothing changed; skymp is active', 'Nothing to roll back'],
    ['release', 'game-server', 'site-owner'],
  ])

  const start = harness({ unit: { active: 'inactive' }, systemctlFail: true })
  fs.writeFileSync(start.markers.stopped, '{"by":"nate","reason":"down for a while","at":"x"}\n')
  assert.equal((await act(start, 'start')).status, 502)
  assert.equal(fs.readFileSync(start.markers.stopped, 'utf8'), '{"by":"nate","reason":"down for a while","at":"x"}\n')
})

test('a repeated requestId gets the same job and never a second action, even while the first is in flight', async () => {
  const h = harness({ afterCommand: systemd.stop })
  const [a, b] = await Promise.all([act(h, 'stop'), act(h, 'stop')])
  assert.equal(a.status, 202)
  assert.equal(b.status, 200)
  assert.equal(b.body.job.id, a.body.job.id)
  await h.idle()
  const again = await act(h, 'stop')
  assert.equal(again.status, 200)
  assert.equal(again.body.job.state, 'done')
  assert.deepEqual(h.systemctlCalls(), [['--no-block', 'stop', 'skymp.service']])
  assert.equal(h.opsCalls().filter(a => a[0] === 'claim').length, 1)
  assert.equal(h.control.known(ID.toUpperCase()), true)
})

test('single flight: a second action while one is followed gets 409 busy, and the controls say so', async () => {
  const h = harness({ afterCommand: () => {} })
  const pending = []
  h.control = createServerControl({
    status: { markers: h.markers, units: async () => ({ skymp: { ...h.unit }, updater: null }) }, getHeartbeat: () => h.beat, now: h.clock,
    wait: () => new Promise(resolve => pending.push(resolve)), audit: { log: () => {} }, run: h.run, jobsFile: h.jobsFile,
  })
  assert.equal((await act(h, 'stop')).status, 202)
  assert.deepEqual(await act(h, 'restart', { requestId: uuid(2) }), { status: 409, body: { error: 'busy' } })
  const shown = h.control.controlsFor({ service: { state: 'reachable' }, players: { online: 0 }, claims: [] }, { owner: true, setting: 'on' })
  assert.equal(shown.why, 'busy')
  assert.equal(shown.job.state, 'running')
  h.unit.active = 'inactive'
  while (pending.length) { pending.shift()(); await new Promise(r => setImmediate(r)) }
  await new Promise(r => setImmediate(r))
  assert.equal(h.control.job(ID).state, 'done')
  assert.equal(h.control.controlsFor({ service: { state: 'stopped' }, players: { online: 0 }, claims: [] }, { owner: true, setting: 'on' }).canStart, true)
})

test('jobs outlive a backend restart: a resent requestId gets the saved job and never runs again', async () => {
  const h = harness({ afterCommand: systemd.stop })
  assert.equal((await act(h, 'stop')).status, 202)
  await h.idle()
  assert.equal(fs.statSync(h.jobsFile).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(fs.readFileSync(h.jobsFile, 'utf8')).jobs, [h.control.job(ID)])
  assert.deepEqual(fs.readdirSync(h.dir).filter(f => f.includes('.tmp')), [])
  const ran = h.calls.length
  h.control = h.make()
  assert.equal(h.control.known(ID.toUpperCase()), true)
  const again = await act(h, 'stop')
  assert.deepEqual([again.status, again.body.job.state], [200, 'done'])
  assert.equal(h.calls.length, ran, 'nothing ran again')

  for (const junk of ['not json', '{"jobs":{}}', JSON.stringify({ jobs: [{ id: 'x', action: 'stop', state: 'done' }, { id: ID, action: 'reboot', state: 'done' }] })]) {
    fs.writeFileSync(h.jobsFile, junk)
    h.control = h.make()
    assert.equal(h.control.job(ID), null, junk)
  }
})

test('a backend restart mid-action: the job reads interrupted, and recover() records it and gives back the claim', async () => {
  const h = harness()
  const running = { id: ID, action: 'restart', state: 'running', dryRun: false, by: 'jake', reason: 'Nightly maintenance', requestedAt: new Date(T0 - 60e3).toISOString(), finishedAt: null }
  fs.writeFileSync(h.jobsFile, JSON.stringify({ v: 1, jobs: [running] }))
  h.checkOut = 'HELD by site-owner: Restart from the website dashboard by jake: Nightly maintenance\n'
  h.control = h.make()
  assert.equal(h.control.job(ID).state, 'interrupted')
  assert.equal(h.control.controlsFor(h.status(), { owner: true, setting: 'on' }).job.state, 'interrupted')
  await h.control.recover()
  assert.deepEqual(h.opsCalls(), [
    ['log', 'site-owner', 'Result: Restart from the website dashboard by jake: not followed to its end, the backend restarted; skymp is active', 'Nothing to undo; if it stays down, Start on the website dashboard or systemctl start skymp'],
    ['check', 'game-server'],
    ['release', 'game-server', 'site-owner'],
  ])
  assert.deepEqual(h.audits, ['WEB restart by jake not followed to its end: the backend restarted', 'WEB the backend restarted during a dashboard action; its game-server claim is released'])
  assert.equal(JSON.parse(fs.readFileSync(h.jobsFile, 'utf8')).jobs[0].state, 'interrupted')
  const resent = await act(h, 'restart')
  assert.deepEqual([resent.status, resent.body.job.state], [200, 'interrupted'])
  assert.deepEqual(h.systemctlCalls(), [])

  // A claim with no job (cut short before systemctl) is logged and released; a free one or someone else's is left alone
  const early = harness()
  early.checkOut = 'HELD by site-owner: Stop (stays stopped) from the website dashboard by jake: x\n'
  await early.control.recover()
  assert.deepEqual(early.opsCalls().map(a => a.slice(0, 2)), [['check', 'game-server'], ['log', 'site-owner'], ['release', 'game-server']])
  const free = harness()
  await free.control.recover()
  const other = harness()
  other.checkOut = 'HELD by claude-nate: world edit\n'
  await other.control.recover()
  assert.deepEqual([free.opsCalls(), other.opsCalls(), free.audits, other.audits], [[['check', 'game-server']], [['check', 'game-server']], [], []])
})

test('dry run: checked and audited, but no ledger, marker or systemd command', async () => {
  const h = harness({ setting: 'dry-run' })
  const res = await act(h, 'stop')
  assert.equal(res.status, 202)
  assert.equal(res.body.job.dryRun, true)
  assert.equal(res.body.job.state, 'done')
  assert.deepEqual(h.calls, [])
  assert.equal(fs.existsSync(h.markers.stopped), false)
  assert.deepEqual(h.audits, ['WEB stop (dry run, nothing ran) by jake (111): Nightly maintenance'])
  assert.deepEqual((await act(harness({ setting: 'dry-run', online: 2 }), 'stop')).body, { error: 'playersOnline' })
})

test('controls for the page: Owners only, switch, players, state and a claim by someone else', () => {
  const c = harness().control
  const s = (state, online, claims = []) => ({ service: { state }, players: { online }, claims })
  const pick = x => [x.canStart, x.canStop, x.canRestart, x.why]
  assert.deepEqual(pick(c.controlsFor(s('reachable', 0), { owner: false, setting: 'on' })), [false, false, false, 'notOwner'])
  assert.deepEqual(pick(c.controlsFor(s('reachable', 0), { owner: true, setting: 'off' })), [false, false, false, 'controlsOff'])
  assert.deepEqual(pick(c.controlsFor(s('reachable', 0), { owner: true, setting: 'on' })), [false, true, true, null])
  assert.deepEqual(pick(c.controlsFor(s('reachable', 4), { owner: true, setting: 'on' })), [false, false, false, 'playersOnline'])
  assert.deepEqual(pick(c.controlsFor(s('unresponsive', null), { owner: true, setting: 'on' })), [false, false, false, 'playersUnknown'])
  assert.deepEqual(pick(c.controlsFor(s('stopped', 0), { owner: true, setting: 'dry-run' })), [true, false, false, null])
  assert.deepEqual(pick(c.controlsFor(s('down', 0), { owner: true, setting: 'on' })), [true, false, false, null])
  assert.deepEqual(pick(c.controlsFor(s('starting', null), { owner: true, setting: 'on' })), [false, false, false, 'changing'])
  assert.deepEqual(pick(c.controlsFor(s('updating', null), { owner: true, setting: 'on' })), [false, false, false, 'updating'])
  const held = [{ resource: 'game-server', operator: 'claude-nate', until: 'x' }]
  assert.deepEqual(pick(c.controlsFor(s('reachable', 0, held), { owner: true, setting: 'on' })), [false, false, false, 'claimed'])
  const ours = [{ resource: 'game-server', operator: OPERATOR, until: 'x' }]
  assert.deepEqual(pick(c.controlsFor(s('reachable', 0, ours), { owner: true, setting: 'on' })), [false, true, true, null])
  assert.equal(c.controlsFor(s('reachable', 0), { owner: true, setting: 'on' }).mode, 'zeroPlayers')
})

test('a non-Owner refusal is audited at most once a minute per account', () => {
  const h = harness()
  h.control.notOwner('dev\n', '222')
  h.control.notOwner('dev', '222')
  h.control.notOwner('dev2', '333')
  h.advance(61e3)
  h.control.notOwner('dev', '222')
  assert.deepEqual(h.audits, [
    'WEB control refused for dev (222): not an Owner', 'WEB control refused for dev2 (333): not an Owner', 'WEB control refused for dev (222): not an Owner',
  ])
})

test('no shell: the default runner is execFile with the fixed file and argv, and no other child_process call is made', async t => {
  const seen = []
  t.mock.method(childProcess, 'execFile', (file, args, opts, cb) => {
    seen.push({ file, args, opts })
    const child = new (require('events').EventEmitter)()
    child.stdin = { on() {}, end() {} }
    setImmediate(() => cb(null, '', ''))
    return child
  })
  for (const name of ['exec', 'execSync', 'spawn', 'spawnSync', 'execFileSync', 'fork']) {
    t.mock.method(childProcess, name, () => { throw new Error(`child_process.${name} must not be used`) })
  }
  const dir = path.join(root, 'noshell')
  fs.mkdirSync(dir, { recursive: true })
  const markers = { stopped: path.join(dir, 'skymp-stopped'), control: path.join(dir, 'server-control'), updaterDirs: [] }
  fs.writeFileSync(markers.control, 'on')
  let unit = { active: 'active', since: T0 - 3600e3, nRestarts: 0 }
  const control = createServerControl({
    status: { markers, units: async () => ({ skymp: unit, updater: null }) }, now: () => T0, wait: async () => { unit = { ...unit, active: 'inactive' } },
    getHeartbeat: () => ({ online: 0, lastSeen: new Date(T0 - 1000).toISOString() }), audit: { log: () => {} }, jobsFile: path.join(dir, 'server-jobs.json'),
  })
  assert.equal((await control.perform('stop', { requestId: ID, reason: 'Stop it `id` $(id); id', by: 'jake', discordId: '1' })).status, 202)
  for (let i = 0; i < 50 && seen.length < 4; i++) await new Promise(r => setImmediate(r))
  assert.deepEqual(seen.map(c => [c.file, ...c.args]), [
    [OPS, 'claim', 'game-server', 'site-owner', 'Stop (stays stopped) from the website dashboard by jake: Stop it `id` $(id); id', '15'],
    [OPS, 'log', 'site-owner', 'Stop (stays stopped) from the website dashboard by jake: Stop it `id` $(id); id', `Start on the website dashboard, or rm ${markers.stopped} && systemctl start skymp`],
    ['systemctl', ...SYSTEMCTL.stop],
    [OPS, 'release', 'game-server', 'site-owner'],
  ])
  for (const c of seen) {
    assert.equal(c.opts.shell, undefined)
    assert.deepEqual(Object.keys(c.opts.env).sort(), ['LANG', 'PATH'])
  }
  assert.equal(OPS, '/opt/dragonbreak-ops/ops')
  assert.match(OPERATOR, /^[a-z][a-z0-9-]{1,30}$/)
  const source = fs.readFileSync(require.resolve('../sources/serverControl'), 'utf8')
  assert.doesNotMatch(source, /child_process|(?<!\.)\bexec(Sync)?\(|spawn|shell\s*:/)
})
