'use strict'
// POST /api/site/staff/server/actions/<start|stop|restart> and the status controls, over HTTP: every guard in order,
// the exact ledger and systemd argv, the stopped marker, repeats, and the rate limits. systemd and the ledger are fakes.

const { test, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const http = require('http')
const path = require('path')
const { createPanelFixture, showOutput } = require('./helpers/panelFixture')

const ORIGIN = 'https://site.example'
const OWNER_ROLE = 'role-owner'
const DEV_ROLE = 'role-dev'
const rolesOf = id => (id.startsWith('id-owner') ? [OWNER_ROLE] : id.startsWith('id-dev') ? [DEV_ROLE] : [])

const stub = (rel, exports) => {
  const file = require.resolve(path.join('..', rel))
  require.cache[file] = { id: file, filename: file, loaded: true, exports }
}

// Never read a real .env, session store or Discord, and never post an audit line
require.cache[require.resolve('dotenv')] = { exports: { config: () => ({}) } }
stub('routes/site-auth.js', {
  internals: {
    currentSession: req => { const id = req.headers['x-test-user']; return id ? { discordId: id, username: id.slice(3) } : null },
    sameOrigin: req => req.get('origin') === ORIGIN,
    readStore: () => [], toSiteCharacter: () => ({}), profileIdOf: () => 0, dynamicFields: () => ({}),
  },
})
let roleLookups = 0
stub('sources/discordBot.js', {
  memberHasRole: async (id, role) => {
    roleLookups++
    if (id === 'id-owner-throw') throw new Error('Discord answered 500')
    if (id === 'id-owner-hang') return new Promise(() => {})
    return rolesOf(id).includes(role)
  },
})
const audits = []
stub('sources/discord/audit.js', { log: line => audits.push(line) })
stub('sources/players.js', { load: () => ({}) })
stub('sources/nameTable.js', { load: () => ({}) })
let beat = null
stub('routes/servers.js', { getHeartbeat: () => beat })

const express = require('express')
const config = require('../config')
const serverStatus = require('../sources/serverStatus')
const serverControl = require('../sources/serverControl')
const { parserExcept } = require('../sources/problemReport')

let F, server, base, created, skew = 0
const clock = () => Date.now() + skew
const sim = { active: 'active', since: 0, nRestarts: 0 }
let heldBy = null
const calls = []
const shows = []

const beatNow = online => { beat = { name: 'Test', maxPlayers: 50, online, lastSeen: new Date(clock() - 2000).toISOString() } }
const opsCalls = () => calls.filter(c => c.file === serverControl.OPS).map(c => c.args)
const systemctlCalls = () => calls.filter(c => c.file === 'systemctl').map(c => c.args)

// systemd as it answers after each command
function fakeRun(file, args, opts) {
  calls.push({ file, args: [...args], opts })
  if (file === serverControl.OPS) {
    if (args[0] === 'claim' && heldBy) {
      return Promise.reject(Object.assign(new Error('Command failed'), { code: 2, stdout: `HELD: game-server is claimed by ${heldBy} until 2026-09-28T12:00Z for: a private purpose\n` }))
    }
    return Promise.resolve({ stdout: `${args[0]} ok\n`, stderr: '' })
  }
  if (args[1] === 'stop') sim.active = 'inactive'
  else {
    Object.assign(sim, { active: 'active', since: clock(), nRestarts: 0 })
    beat = { ...beat, online: 0, lastSeen: new Date(clock() + 1000).toISOString() }
  }
  return Promise.resolve({ stdout: '', stderr: '' })
}

function listenInRange(srv) {
  return new Promise((resolve, reject) => {
    let port = 14800
    const attempt = () => {
      srv.once('error', err => (err.code === 'EADDRINUSE' && port < 14899 ? (port++, attempt()) : reject(err)))
      srv.listen(port, '127.0.0.1', () => resolve(port))
    }
    attempt()
  })
}

function request(method, url, headers, payload = '') {
  return new Promise((resolve, reject) => {
    const clean = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined))
    const req = http.request(`${base}${url}`, { method, agent: false, headers: { ...clean, ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) } }, res => {
      let text = ''
      res.on('data', c => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: text && /json/.test(res.headers['content-type'] || '') ? JSON.parse(text) : null }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

const get = (url, user) => request('GET', url, user ? { 'x-test-user': `id-${user}` } : {})

let seq = 0
const uuid = () => `5d0c2f9e-8a1b-4c3d-9e7f-${String(++seq).padStart(12, '0')}`
const WORD = { start: 'START', stop: 'STOP', restart: 'RESTART' }
let accepted = 0

// A control POST as the dashboard sends it; headers set to undefined are left out
async function post(action, { user, body, headers = {}, raw } = {}) {
  const payload = raw ?? JSON.stringify(body ?? { requestId: uuid(), reason: 'Nightly maintenance', confirm: WORD[action] })
  const res = await request('POST', `/api/site/staff/server/actions/${action}`, {
    'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-dbo-control': '1',
    ...(user ? { 'x-test-user': `id-${user}` } : {}), ...headers,
  }, payload)
  if (res.status === 202) accepted++
  return res
}

async function settled(id) {
  for (let i = 0; i < 500; i++) {
    const res = await get(`/api/site/staff/server/jobs/${id}`, 'dev')
    if (res.json.job.state !== 'running') return res.json.job
    await new Promise(r => setImmediate(r))
  }
  throw new Error('job never settled')
}

const setSwitch = word => fs.writeFileSync(F.markers.control, `${word}\n`)

before(async () => {
  F = createPanelFixture('dbo-site-actions-')
  Object.assign(config, F.config, { siteStaffRoleIds: [OWNER_ROLE, DEV_ROLE], siteOwnerRoleIds: [OWNER_ROLE] })
  fs.mkdirSync(path.dirname(F.markers.control), { recursive: true })
  fs.mkdirSync(path.dirname(F.markers.stopped), { recursive: true })
  const realStatus = serverStatus.createServerStatus
  serverStatus.createServerStatus = deps => (created = realStatus({
    ...deps, markers: F.markers, now: clock,
    run: async (file, args) => {
      shows.push([file, ...args])
      return { stdout: showOutput({ ActiveState: sim.active, SubState: sim.active === 'active' ? 'running' : 'dead', ActiveEnterTimestamp: `@${Math.floor(sim.since / 1000)}`, NRestarts: sim.nRestarts }) }
    },
    queueDeps: { fetch: async () => { throw new Error('offline') } },
  }))
  const realControl = serverControl.createServerControl
  serverControl.createServerControl = deps => realControl({ ...deps, run: fakeRun, now: clock, wait: () => new Promise(r => setImmediate(r)), jobsFile: path.join(F.root, 'server-jobs.json') })

  const app = express()
  // A parser that ignores the skip below, standing in for one a later change might add
  app.use((req, res, next) => (req.get('x-test-preparse') ? express.json()(req, res, next) : next()))
  // The global parser as server.js mounts it
  app.use(parserExcept(serverControl.ACTIONS.map(a => `/api/site/staff/server/actions/${a}`), express.json({ limit: '100kb' })))
  app.use('/api/site/staff/server', require('../routes/site-server'))
  server = http.createServer(app)
  base = `http://127.0.0.1:${await listenInRange(server)}`
})

after(() => {
  created?.queue.stop()
  server?.close()
  F.cleanup()
})

beforeEach(() => {
  setSwitch('on')
  fs.rmSync(F.markers.stopped, { force: true })
  Object.assign(sim, { active: 'active', since: clock() - 3600e3, nRestarts: 0 })
  heldBy = null
  beatNow(0)
  skew += 6000
  calls.length = 0
  audits.length = 0
})

test('the status carries each viewer\'s controls: Owners at 0 players may stop or restart, Dev sees none', async () => {
  const held = await get('/api/site/staff/server', 'owner')
  assert.deepEqual([held.json.controls.canStop, held.json.controls.why], [false, 'claimed'], 'the fixture\'s claude-jake claim on game-server')
  fs.rmSync(path.join(F.config.opsClaimsDir, 'game-server'))
  skew += 6000
  const owner = await get('/api/site/staff/server', 'owner')
  assert.equal(owner.status, 200)
  assert.deepEqual(owner.json.controls, {
    mode: 'zeroPlayers', update: 'notYet', setting: 'on', owner: true, canStart: false, canStop: true, canRestart: true, why: null, job: null,
  })
  const dev = await get('/api/site/staff/server', 'dev')
  assert.deepEqual([dev.json.owner, dev.json.controls.canStart, dev.json.controls.canStop, dev.json.controls.canRestart, dev.json.controls.why], [false, false, false, false, 'notOwner'])
  beatNow(3)
  skew += 6000
  const busy = await get('/api/site/staff/server', 'owner')
  assert.deepEqual([busy.json.players.online, busy.json.controls.canStop, busy.json.controls.canRestart, busy.json.controls.why], [3, false, false, 'playersOnline'])
  setSwitch('dry-run')
  assert.equal((await get('/api/site/staff/server', 'owner')).json.controls.setting, 'dry-run')
  assert.deepEqual(calls, [], 'the status never runs a control command')
})

test('guards before the Owner lookup: path, Origin, fetch metadata, JSON type, control header, then the session', async () => {
  const lookups = roleLookups
  const cases = [
    ['reboot', { user: 'owner1' }, 404, 'notFound'],
    ['stop', {}, 401, 'signedOut'],
    ['stop', { user: 'owner1', headers: { 'x-dbo-control': undefined } }, 403, 'badHeader'],
    ['stop', { user: 'owner1', headers: { 'x-dbo-control': 'yes' } }, 403, 'badHeader'],
    ['stop', { user: 'owner1', headers: { 'sec-fetch-site': 'cross-site' } }, 403, 'badOrigin'],
    ['stop', { user: 'owner1', headers: { 'sec-fetch-site': 'same-site' } }, 403, 'badOrigin'],
    ['stop', { user: 'owner1', headers: { origin: 'https://evil.example' } }, 403, 'badOrigin'],
    ['stop', { user: 'owner1', headers: { origin: 'http://localhost:4002' } }, 403, 'badOrigin'],
    ['stop', { user: 'owner1', headers: { origin: undefined } }, 403, 'badOrigin'],
    ['stop', { user: 'owner1', headers: { 'content-type': 'text/plain' } }, 415, 'badContentType'],
  ]
  for (const [action, opts, status, error] of cases) {
    const res = await post(action, opts)
    assert.equal(res.status, status, `${action} ${JSON.stringify(opts)}`)
    assert.deepEqual(res.json, { error })
    assert.equal(res.headers['cache-control'], 'no-store, private')
  }
  const requestId = uuid()
  const sent = await post('stop', { user: 'owner1', headers: { 'sec-fetch-site': undefined }, body: { requestId, reason: 'Nightly maintenance', confirm: 'STOP' } })
  assert.equal(sent.status, 202, 'fetch metadata is checked only when sent')
  assert.equal(roleLookups, lookups + 1, 'only the request that passed every guard asked Discord')
  assert.equal((await settled(requestId)).state, 'done')
})

test('a Dev (staff, not an Owner) gets 403 and no action; the refusal is audited once a minute', async () => {
  for (let i = 0; i < 3; i++) {
    const res = await post('restart', { user: 'dev1' })
    assert.equal(res.status, 403)
    assert.deepEqual(res.json, { error: 'notOwner' })
  }
  assert.deepEqual(calls, [])
  assert.deepEqual(audits, ['WEB control refused for dev1 (id-dev1): not an Owner'])
})

test('a Discord error or a lookup that never answers fails closed: 403 notOwner, nothing runs', async t => {
  t.mock.method(console, 'error', () => {})
  const thrown = await post('stop', { user: 'owner-throw' })
  assert.deepEqual([thrown.status, thrown.json], [403, { error: 'notOwner' }])
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const lookups = roleLookups
  const pending = post('stop', { user: 'owner-hang' })
  while (roleLookups === lookups) await new Promise(r => setImmediate(r))
  t.mock.timers.tick(8000)
  const hung = await pending
  assert.deepEqual([hung.status, hung.json], [403, { error: 'notOwner' }])
  assert.deepEqual(calls, [])
  assert.equal(fs.existsSync(F.markers.stopped), false)
  assert.deepEqual(audits, ['WEB control refused for owner-throw (id-owner-throw): not an Owner', 'WEB control refused for owner-hang (id-owner-hang): not an Owner'])
})

test('bad bodies: reason, typed word, requestId, unknown keys, invalid JSON and a body over 2 kB', async () => {
  const good = { requestId: uuid(), reason: 'Nightly maintenance', confirm: 'STOP' }
  const cases = [
    [{ ...good, reason: 'hi' }, 400, 'badReason'], [{ ...good, reason: 'x'.repeat(201) }, 400, 'badReason'],
    [{ ...good, reason: '\r\n\u202e\u0000\u0085  ' }, 400, 'badReason'],
    [{ ...good, confirm: undefined }, 400, 'badConfirm'], [{ ...good, confirm: 'RESTART' }, 400, 'badConfirm'], [{ ...good, confirm: 'stop' }, 400, 'badConfirm'],
    [{ ...good, requestId: 'abc' }, 400, 'badRequest'], [{ ...good, action: 'stop' }, 400, 'badRequest'], [[good], 400, 'badRequest'],
  ]
  for (const [body, status, error] of cases) {
    const res = await post('stop', { user: 'owner2', body })
    assert.deepEqual([res.status, res.json], [status, { error }], JSON.stringify(body))
  }
  assert.equal((await post('stop', { user: 'owner3', raw: '{"requestId":' })).status, 400)
  assert.equal((await post('stop', { user: 'owner3', raw: JSON.stringify({ ...good, reason: 'x'.repeat(3000) }) })).status, 413)
  assert.deepEqual(calls, [])
})

test('an encoded action name is read by the route alone, after the Owner check; a body read earlier is refused', async () => {
  const lookups = roleLookups
  // The global parser answers broken JSON with 400, so 401 shows it never read these bodies
  for (const action of ['%73tart', 'st%61rt', 'stop/']) {
    const res = await post(action, { raw: '{"requestId":' })
    assert.deepEqual([res.status, res.json], [401, { error: 'signedOut' }], action)
  }
  assert.equal(roleLookups, lookups)
  const res = await post('%73tart', { user: 'owner12', raw: JSON.stringify({ requestId: uuid(), reason: 'x'.repeat(3000), confirm: 'START' }) })
  assert.deepEqual([res.status, res.json], [413, { error: 'The request is too large.' }])
  assert.equal(roleLookups, lookups + 1, 'the Owner check ran before the 2 kB parser')
  const early = await post('restart', { user: 'owner12', headers: { 'x-test-preparse': '1' } })
  assert.deepEqual([early.status, early.json], [400, { error: 'badRequest' }])
  assert.equal(roleLookups, lookups + 1, 'refused before the Owner lookup')
  assert.deepEqual(calls, [])
})

test('the switch: missing or off answers 503 controlsOff and runs nothing', async () => {
  fs.rmSync(F.markers.control)
  assert.deepEqual((await post('stop', { user: 'owner4' })).json, { error: 'controlsOff' })
  setSwitch('off')
  const res = await post('stop', { user: 'owner4' })
  assert.deepEqual([res.status, res.json], [503, { error: 'controlsOff' }])
  assert.deepEqual(calls, [])
})

test('state refusals: players online (409), heartbeat stale (409), Start while running (409), Restart when down (409)', async () => {
  beatNow(2)
  for (const action of ['stop', 'restart']) assert.deepEqual(await post(action, { user: 'owner5' }).then(r => [r.status, r.json]), [409, { error: 'playersOnline' }])
  beat = { ...beat, online: 0, lastSeen: new Date(clock() - 25000).toISOString() }
  assert.deepEqual(await post('stop', { user: 'owner5' }).then(r => [r.status, r.json]), [409, { error: 'playersUnknown' }])
  assert.deepEqual(await post('start', { user: 'owner5' }).then(r => [r.status, r.json]), [409, { error: 'alreadyRunning' }])
  sim.active = 'failed'
  assert.deepEqual(await post('restart', { user: 'owner5' }).then(r => [r.status, r.json]), [409, { error: 'useStart' }])
  assert.deepEqual(calls, [], 'no ledger or systemd command')
})

test('a game-server claim held by another operator gives 409 with the holder, and no systemd command', async () => {
  heldBy = 'claude-nate'
  const res = await post('restart', { user: 'owner6' })
  assert.deepEqual([res.status, res.json], [409, { error: 'claimed', holder: 'claude-nate' }])
  assert.equal(res.text.includes('private purpose'), false)
  assert.deepEqual(opsCalls().map(a => a[0]), ['claim'])
  assert.deepEqual(systemctlCalls(), [])
})

test('Stop: 202 with a job, the exact ledger and systemd argv, the marker, the claim released; a repeat is 200 with no second action', async () => {
  const requestId = uuid()
  const body = { requestId, reason: 'Nightly\r\nexpires=1 maintenance', confirm: 'STOP' }
  const res = await post('stop', { user: 'owner7', body })
  assert.equal(res.status, 202)
  assert.deepEqual(Object.keys(res.json), ['job'])
  assert.deepEqual([res.json.job.id, res.json.job.action, res.json.job.state, res.json.job.by, res.json.job.reason], [requestId, 'stop', 'running', 'owner7', 'Nightly expires=1 maintenance'])
  const job = await settled(requestId)
  assert.equal(job.state, 'done')
  const purpose = 'Stop (stays stopped) from the website dashboard by owner7: Nightly expires=1 maintenance'
  assert.deepEqual(opsCalls(), [
    ['claim', 'game-server', 'site-owner', purpose, '15'],
    ['log', 'site-owner', purpose, `Start on the website dashboard, or rm ${F.markers.stopped} && systemctl start skymp`],
    ['release', 'game-server', 'site-owner'],
  ])
  assert.deepEqual(systemctlCalls(), [['--no-block', 'stop', 'skymp.service']])
  for (const c of calls) {
    assert.equal(c.opts.shell, undefined)
    assert.deepEqual(Object.keys(c.opts.env).sort(), ['LANG', 'PATH'])
  }
  const marker = JSON.parse(fs.readFileSync(F.markers.stopped, 'utf8'))
  assert.deepEqual(Object.keys(marker), ['by', 'reason', 'at'])
  assert.deepEqual([marker.by, marker.reason], ['owner7 (website)', 'Nightly expires=1 maintenance'])
  assert.equal(fs.statSync(F.markers.stopped).mode & 0o777, 0o644)

  const again = await post('stop', { user: 'owner7', body })
  assert.equal(again.status, 200)
  assert.deepEqual(again.json.job, job)
  assert.deepEqual(systemctlCalls(), [['--no-block', 'stop', 'skymp.service']], 'no second action')
  assert.equal(opsCalls().length, 3)
  assert.ok(audits.includes(`WEB stop requested by owner7 (id-owner7): Nightly expires=1 maintenance`))
  assert.ok(audits.includes('WEB stop by owner7 (id-owner7) done'))
})

test('Start when stopped: removes the marker, then systemctl --no-block start; the status then offers Stop and Restart', async () => {
  sim.active = 'inactive'
  fs.writeFileSync(F.markers.stopped, JSON.stringify({ by: 'owner7 (website)', reason: 'Nightly maintenance', at: '2026-09-28T01:00:00.000Z' }))
  const requestId = uuid()
  const res = await post('start', { user: 'owner8', body: { requestId, reason: 'Back after maintenance', confirm: 'START' } })
  assert.equal(res.status, 202)
  assert.equal(fs.existsSync(F.markers.stopped), false)
  assert.equal((await settled(requestId)).state, 'done')
  assert.deepEqual(systemctlCalls(), [['--no-block', 'start', 'skymp.service']])
  assert.deepEqual(opsCalls().map(a => a[0]), ['claim', 'log', 'release'])
  assert.match(opsCalls()[1][2], /; cleared the stopped marker \(owner7 \(website\), 2026-09-28T01:00:00\.000Z: Nightly maintenance\)$/)
  skew += 6000
  const status = await get('/api/site/staff/server', 'owner')
  assert.equal(status.json.service.state, 'reachable')
  assert.deepEqual([status.json.controls.canStart, status.json.controls.canStop, status.json.controls.canRestart], [false, true, true])
  assert.deepEqual([status.json.controls.job.id, status.json.controls.job.state], [requestId, 'done'])
})

test('Restart at 0 players: systemctl --no-block restart, no marker', async () => {
  const requestId = uuid()
  assert.equal((await post('restart', { user: 'owner9', body: { requestId, reason: 'Clear a stuck quest', confirm: 'RESTART' } })).status, 202)
  assert.equal((await settled(requestId)).state, 'done')
  assert.deepEqual(systemctlCalls(), [['--no-block', 'restart', 'skymp.service']])
  assert.equal(fs.existsSync(F.markers.stopped), false)
  assert.equal((await get('/api/site/staff/server/jobs/not-a-uuid', 'dev')).status, 404)
  assert.equal((await get(`/api/site/staff/server/jobs/${uuid()}`, 'dev')).status, 404)
  assert.equal((await get(`/api/site/staff/server/jobs/${requestId}`)).status, 401)
})

test('rate limits: the 11th try from one account in 10 minutes, and the 7th action site-wide in an hour, give 429', async () => {
  for (let i = 1; i <= 10; i++) assert.equal((await post('stop', { user: 'owner10', body: { requestId: uuid(), reason: 'hi', confirm: 'STOP' } })).status, 400, `try ${i}`)
  const lookups = roleLookups
  const limited = await post('stop', { user: 'owner10' })
  assert.deepEqual([limited.status, limited.json], [429, { error: 'tooMany' }])
  assert.equal(roleLookups, lookups, 'no Discord lookup once limited')

  // Refusals do not count toward the site-wide limit, only actions that went ahead
  beatNow(1)
  for (let i = 0; i < 3; i++) assert.equal((await post('restart', { user: 'owner11' })).status, 409)
  beatNow(0)
  const ids = []
  let n = 20
  while (accepted < 6) {
    const requestId = uuid()
    ids.push(requestId)
    assert.equal((await post('restart', { user: `owner${++n}`, body: { requestId, reason: 'Restart for the test', confirm: 'RESTART' } })).status, 202)
    await settled(requestId)
  }
  const seventh = await post('restart', { user: `owner${++n}` })
  assert.deepEqual([seventh.status, seventh.json], [429, { error: 'tooMany' }])
  const repeat = await post('restart', { user: `owner${++n}`, body: { requestId: ids.at(-1), reason: 'Restart for the test', confirm: 'RESTART' } })
  assert.equal(repeat.status, 200, 'a repeated requestId is answered, not limited')
  assert.equal(repeat.json.job.id, ids.at(-1))
})
