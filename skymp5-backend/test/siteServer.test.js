'use strict'
// GET /api/site/staff/server, /queue and /releases: sign-in, staff and Owner roles, a stalled Discord lookup, rate limits, ETag and no paths

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const path = require('path')
const { createPanelFixture, showOutput, PATH_RE } = require('./helpers/panelFixture')

const OWNER_ROLE = 'role-owner'
const DEV_ROLE = 'role-dev'
const ROLES = { 'id-owner': [OWNER_ROLE], 'id-dev': [DEV_ROLE], 'id-dev2': [DEV_ROLE], 'id-dev3': [DEV_ROLE], 'id-none': [], 'id-slow': 'hang' }
const USERS = Object.fromEntries(Object.keys(ROLES).map(id => [id, { discordId: id, username: id.slice(3) }]))

const stub = (rel, exports) => {
  const file = require.resolve(path.join('..', rel))
  require.cache[file] = { id: file, filename: file, loaded: true, exports }
}

// Never read a real .env, session store or Discord; the fixture stands in for the live repo and server folders
require.cache[require.resolve('dotenv')] = { exports: { config: () => ({}) } }
stub('routes/site-auth.js', {
  internals: { currentSession: req => USERS[req.headers['x-test-user']] || null, readStore: () => [], toSiteCharacter: () => ({}), profileIdOf: () => 0, dynamicFields: () => ({}) },
})
stub('sources/discordBot.js', {
  memberHasRole: (id, role) => (ROLES[id] === 'hang' ? new Promise(() => {}) : Promise.resolve((ROLES[id] || []).includes(role))),
})
stub('sources/players.js', { load: () => ({}) })
stub('sources/nameTable.js', { load: () => ({}) })
stub('routes/servers.js', { getHeartbeat: () => ({ name: 'Test', maxPlayers: 50, online: 2, lastSeen: new Date().toISOString() }) })

const express = require('express')
const config = require('../config')
const serverStatus = require('../sources/serverStatus')
const { queueEtag } = require('../sources/releaseQueue')

let F, server, base, created, skew = 0
const systemctl = []

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

function get(url, user, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${url}`, { agent: false, headers: { ...(user ? { 'x-test-user': `id-${user}` } : {}), ...headers } }, res => {
      let text = ''
      res.on('data', c => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject)
    req.end()
  })
}

before(async () => {
  F = createPanelFixture('dbo-site-server-')
  Object.assign(config, F.config, { siteStaffRoleIds: [OWNER_ROLE, DEV_ROLE], siteOwnerRoleIds: [OWNER_ROLE] })
  const real = serverStatus.createServerStatus
  serverStatus.createServerStatus = deps => (created = real({
    ...deps, markers: F.markers, now: () => Date.now() + skew,
    run: async (file, args) => { systemctl.push([file, ...args]); return { stdout: showOutput({ ActiveEnterTimestamp: '@1790380115' }) } },
    queueDeps: { fetch: async () => { throw new Error('offline') } },
  }))

  const app = express()
  app.use('/api/site/staff/server', require('../routes/site-server'))
  app.use('/api/site/staff', require('../routes/site-staff'))
  server = http.createServer(app)
  base = `http://127.0.0.1:${await listenInRange(server)}`
})

after(() => {
  created?.queue.stop()
  server?.close()
  F.cleanup()
})

test('signed out gets 401 on every endpoint, with no-store caching', async () => {
  for (const url of ['/api/site/staff/server', '/api/site/staff/server/queue', '/api/site/staff/server/releases']) {
    const res = await get(url)
    assert.equal(res.status, 401, url)
    assert.deepEqual(res.json, { error: 'signedOut' })
    assert.equal(res.headers['cache-control'], 'no-store, private')
  }
})

test('a member without a staff role gets 403', async () => {
  for (const url of ['/api/site/staff/server', '/api/site/staff/server/queue', '/api/site/staff/server/releases']) {
    const res = await get(url, 'none')
    assert.equal(res.status, 403, url)
    assert.deepEqual(res.json, { error: 'notStaff' })
  }
})

test('Dev staff get owner:false and an Owner gets owner:true, in the status and in /me', async () => {
  const dev = await get('/api/site/staff/server', 'dev')
  assert.equal(dev.status, 200)
  assert.equal(dev.json.owner, false)
  const owner = await get('/api/site/staff/server', 'owner')
  assert.equal(owner.json.owner, true)
  assert.deepEqual(Object.keys(owner.json).slice(0, 3), ['v', 'generatedAt', 'owner'])
  assert.equal(owner.json.v, 1)
  assert.deepEqual(owner.json.controls, { mode: 'off', update: 'notYet' })
  assert.deepEqual(owner.json.release, { open: null })
  assert.deepEqual(owner.json.schedules, [])
  assert.equal(owner.json.service.state, 'reachable')
  assert.deepEqual(owner.json.players, { online: 2, max: 50, heartbeatAt: owner.json.players.heartbeatAt })
  assert.deepEqual((await get('/api/site/staff/me', 'dev')).json, { signedIn: true, staff: true, owner: false, name: 'dev' })
  assert.deepEqual((await get('/api/site/staff/me', 'owner')).json, { signedIn: true, staff: true, owner: true, name: 'owner' })
  assert.deepEqual((await get('/api/site/staff/me', 'none')).json, { signedIn: true, staff: false, owner: false, name: 'none' })
  for (const call of systemctl) assert.deepEqual(call, ['systemctl', ...serverStatus.SYSTEMCTL_ARGS])
})

test('a Discord role lookup that never answers gives 403 after the deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let res = null
  const pending = get('/api/site/staff/server', 'slow').then(r => { res = r })
  for (let i = 0; i < 2000 && !res; i++) {
    await new Promise(resolve => setImmediate(resolve))
    t.mock.timers.tick(8000)
  }
  await pending
  assert.equal(res.status, 403)
  assert.deepEqual(res.json, { error: 'notStaff' })
})

test('the 61st status call in a minute gives 429', async () => {
  for (let i = 1; i <= 60; i++) assert.equal((await get('/api/site/staff/server', 'dev2')).status, 200, `call ${i}`)
  const res = await get('/api/site/staff/server', 'dev2')
  assert.equal(res.status, 429)
  assert.deepEqual(res.json, { error: 'tooMany' })
  assert.equal((await get('/api/site/staff/server', 'dev3')).status, 200)
})

test('the queue carries an ETag of what it lists and answers 304 when it matches', async () => {
  const first = await get('/api/site/staff/server/queue', 'dev')
  assert.equal(first.status, 200)
  assert.match(first.headers.etag, /^"q-[0-9a-f]{32}"$/)
  assert.equal(first.headers.etag, queueEtag(first.json))
  assert.equal(first.headers['cache-control'], 'no-store, private')
  assert.equal(first.json.v, 1)
  assert.deepEqual(first.json.live, { fork: F.S.B, server: F.S.S0 })
  for (const tag of [first.headers.etag, `W/${first.headers.etag}`, `"q-other", ${first.headers.etag}`, '*']) {
    const res = await get('/api/site/staff/server/queue', 'dev', { 'if-none-match': tag })
    assert.equal(res.status, 304, tag)
    assert.equal(res.text, '')
  }
  const changed = await get('/api/site/staff/server/queue', 'dev', { 'if-none-match': '"q-0000"' })
  assert.equal(changed.status, 200)
  assert.equal(changed.json.hash, first.json.hash)
})

test('releases pages by before and refuses a bad before', async () => {
  const all = await get('/api/site/staff/server/releases', 'dev')
  assert.equal(all.status, 200)
  assert.equal(all.json.v, 1)
  assert.equal(all.json.more, false)
  const n = all.json.rows[0].n
  assert.deepEqual((await get(`/api/site/staff/server/releases?before=${n}`, 'dev')).json.rows.map(r => r.n), all.json.rows.slice(1).map(r => r.n))
  for (const bad of ['abc', '1234567', '-1', '1.5', '']) {
    const res = await get(`/api/site/staff/server/releases?before=${encodeURIComponent(bad)}`, 'dev')
    assert.equal(res.status, 400, bad)
    assert.deepEqual(res.json, { error: 'badRequest' })
  }
  assert.equal((await get('/api/site/staff/server/releases?before=1&before=2', 'dev')).status, 400)
})

test('a failed source gives 503 with no detail', async t => {
  const q = created.queue
  t.mock.method(q, 'queue', async () => { throw Object.assign(new Error(`git log failed in ${F.repo}`), { code: 'unavailable' }) })
  t.mock.method(q, 'releases', async () => { throw new Error('boom /opt/x') })
  t.mock.method(console, 'error', () => {})
  for (const url of ['/api/site/staff/server/queue', '/api/site/staff/server/releases']) {
    const res = await get(url, 'owner')
    assert.equal(res.status, 503, url)
    assert.equal(res.text, '{"error":"unavailable"}')
  }
})

test('no response contains a file-system path', async () => {
  await created.queue.queue()
  skew += 6000
  const texts = []
  for (const url of ['/api/site/staff/server', '/api/site/staff/server/queue', '/api/site/staff/server/releases', '/api/site/staff/server/releases?before=3']) {
    const res = await get(url, 'owner')
    assert.equal(res.status, 200, url)
    texts.push(res.text)
  }
  const status = JSON.parse(texts[0])
  assert.ok(status.live && status.queue, 'the status carries the cached live versions and queue counts')
  const text = texts.join('\n')
  assert.doesNotMatch(text, PATH_RE)
  assert.equal(text.includes(F.root), false)
  assert.doesNotMatch(text, /\/tmp\//)
  assert.equal(text.includes('SECRET'), false)
})
