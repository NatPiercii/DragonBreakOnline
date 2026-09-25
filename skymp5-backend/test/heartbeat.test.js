'use strict'
// Heartbeat authorization for POST /api/servers/:key, plus the key-only GET routes the launcher and client use

const { test, before, beforeEach, after, mock } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const http   = require('http')
const os     = require('os')
const path   = require('path')

const KEY   = 'test-master-key'
const TOKEN = 'test-auth-token'

// Never read a real .env, and keep master-api (and the data stores it opens) out of these tests
require.cache[require.resolve('dotenv')] = { exports: { config: () => ({}) } }
const masterApiPath = path.join(__dirname, '..', 'routes', 'master-api.js')
require.cache[masterApiPath] = {
  id: masterApiPath, filename: masterApiPath, loaded: true,
  exports: { lookupSession: () => null, isDiscordWhitelisted: async () => true },
}

process.env.SERVER_MASTER_KEY = KEY
process.env.MASTER_API_AUTH_TOKEN = TOKEN
delete process.env.HEARTBEAT_REQUIRE_TOKEN

const express = require('express')
const config  = require('../config')
const servers = require('../routes/servers')
const { safeEqual, isLoopbackAddress, isDirectLocal, resetTokenLatch } = require('../middleware/heartbeatAuth')

let app, server, base, gameUi
const PUBLIC_PEER = '10.10.10.1'

function listen(srv, host) {
  return new Promise(resolve => srv.listen(0, host, () => resolve(srv.address().port)))
}

function request(method, url, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body)
    const req = http.request(url, {
      method,
      agent: false,
      headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers },
    }, res => {
      let text = ''
      res.on('data', c => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

const beat = (opts = {}) => request('POST', `${base}/api/servers/${opts.key ?? KEY}`, {
  body: opts.body ?? { name: 'Test Server', maxPlayers: 50, online: 3 },
  headers: {
    ...(opts.peer ? { 'x-test-peer': opts.peer } : {}),
    ...(opts.token !== undefined ? { 'x-auth-token': opts.token } : {}),
    ...(opts.headers || {}),
  },
})
const listing = async () => (await request('GET', `${base}/api/servers`)).json[0]

before(async () => {
  gameUi = http.createServer((req, res) => {
    if (req.url !== '/manifest.json') { res.statusCode = 404; return res.end() }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ mods: [{ filename: 'Skyrim.esm' }, { filename: 'Light.esl' }, { filename: 'Textures.bsa' }] }))
  })
  config.skyrimServerHost = '127.0.0.1'
  config.skympUiPort = await listen(gameUi, '127.0.0.1')

  app = express()
  app.use(express.json())
  // Stands in for a connection from another machine; the real socket is still loopback
  app.use((req, _res, next) => {
    const peer = req.headers['x-test-peer']
    if (peer) req.socket = { remoteAddress: peer }
    next()
  })
  app.use('/api/servers', servers)
  server = http.createServer(app)
  base = `http://127.0.0.1:${await listen(server, '127.0.0.1')}`
})

beforeEach(() => resetTokenLatch())

after(() => {
  server.close()
  gameUi.close()
})

test('local heartbeat from the game server is accepted without a token', async () => {
  const res = await beat()
  assert.equal(res.status, 200)
  const entry = await listing()
  assert.equal(entry.name, 'Test Server')
  assert.equal(entry.online, 3)
  assert.equal(entry.maxPlayers, 50)
  assert.ok(entry.lastSeen)
})

test('local heartbeat with the right token is accepted', async () => {
  assert.equal((await beat({ token: TOKEN, body: { name: 'Tokened', maxPlayers: 60, online: 4 } })).status, 200)
  assert.equal((await listing()).name, 'Tokened')
})

test('public heartbeat without a token is refused and changes nothing', async () => {
  const beforeEntry = await listing()
  const res = await beat({ peer: PUBLIC_PEER, body: { name: 'FAKE', maxPlayers: 9999, online: 9999 } })
  assert.equal(res.status, 403)
  assert.deepEqual(await listing(), beforeEntry)
})

test('public heartbeat with a wrong token is refused', async () => {
  for (const token of ['wrong', TOKEN + 'x', TOKEN.slice(0, -1), 'x'.repeat(500)]) {
    const res = await beat({ peer: PUBLIC_PEER, token, body: { name: 'FAKE', maxPlayers: 1, online: 1 } })
    assert.equal(res.status, 403, token)
  }
  assert.notEqual((await listing()).name, 'FAKE')
})

test('public heartbeat with the right token is accepted', async () => {
  assert.equal((await beat({ peer: PUBLIC_PEER, token: TOKEN, body: { name: 'Remote', maxPlayers: 70, online: 5 } })).status, 200)
  assert.equal((await listing()).name, 'Remote')
})

test('loopback request relayed by a proxy is not treated as local', async () => {
  for (const h of ['x-forwarded-for', 'x-real-ip', 'forwarded', 'cf-connecting-ip']) {
    const res = await beat({ headers: { [h]: h === 'forwarded' ? 'for=203.0.113.9' : '203.0.113.9' } })
    assert.equal(res.status, 403, h)
  }
})

test('after one valid token, a tokenless loopback heartbeat is refused (Tailscale userspace and ssh -L look like loopback)', async () => {
  assert.equal((await beat()).status, 200)
  assert.equal((await beat({ token: TOKEN })).status, 200)
  assert.equal((await beat()).status, 403)
  assert.equal((await beat({ token: 'stale' })).status, 403)
  assert.equal((await beat({ token: TOKEN })).status, 200)
})

test('any x-forwarded-* or via header marks a loopback peer as relayed', async () => {
  for (const h of ['x-forwarded-host', 'x-forwarded-proto', 'via']) assert.equal((await beat({ headers: { [h]: 'x' } })).status, 403, h)
})

test('wrong master key is refused even with the right token', async () => {
  assert.equal((await beat({ key: 'nope', token: TOKEN })).status, 403)
})

test('local heartbeat with a wrong token is still accepted while the loopback fallback is on', async () => {
  assert.equal((await beat({ token: 'stale' })).status, 200)
})

test('HEARTBEAT_REQUIRE_TOKEN refuses a local heartbeat without the right token', async (t) => {
  config.heartbeatRequireToken = true
  t.after(() => { config.heartbeatRequireToken = false })
  assert.equal((await beat()).status, 403)
  assert.equal((await beat({ token: 'stale' })).status, 403)
  assert.equal((await beat({ token: TOKEN })).status, 200)
})

test('an unset MASTER_API_AUTH_TOKEN never matches', async (t) => {
  config.masterApiAuthToken = ''
  t.after(() => { config.masterApiAuthToken = TOKEN })
  assert.equal((await beat({ peer: PUBLIC_PEER, token: 'anything' })).status, 403)
  assert.equal((await beat({ peer: PUBLIC_PEER, token: '' })).status, 403)
})

test('heartbeat name is capped and bad counts fall back', async () => {
  const res = await beat({ body: { name: '  ' + 'N'.repeat(500), maxPlayers: -5, online: 1.5 } })
  assert.equal(res.status, 200)
  const entry = await listing()
  assert.equal(entry.name, 'N'.repeat(64))
  assert.equal(entry.maxPlayers, config.serverMaxPlayers)
  assert.equal(entry.online, null)
})

test('token compare goes through crypto.timingSafeEqual for every length', async (t) => {
  const spy = mock.method(crypto, 'timingSafeEqual')
  t.after(() => spy.mock.restore())
  assert.equal(safeEqual(TOKEN, TOKEN), true)
  assert.equal(safeEqual(TOKEN, TOKEN.replace(/.$/, 'X')), false)
  assert.equal(safeEqual(TOKEN, 'short'), false)
  assert.equal(safeEqual(TOKEN, TOKEN.repeat(10)), false)
  assert.equal(spy.mock.callCount(), 4)
  for (const call of spy.mock.calls) assert.equal(call.arguments[0].length, call.arguments[1].length)

  const before = spy.mock.callCount()
  await beat({ peer: PUBLIC_PEER, token: 'wrong' })
  assert.equal(spy.mock.callCount(), before + 1)
})

test('loopback detection', () => {
  for (const a of ['127.0.0.1', '::ffff:127.0.0.1', '::1', '127.1.2.3']) assert.equal(isLoopbackAddress(a), true, a)
  for (const a of ['10.10.10.1', '::ffff:10.10.10.1', '192.168.12.100', '1270.0.0.1', '', undefined, null]) assert.equal(isLoopbackAddress(a), false, String(a))
  assert.equal(isDirectLocal({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }), true)
  assert.equal(isDirectLocal({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '1.2.3.4' } }), false)
  assert.equal(isDirectLocal({ socket: {}, headers: {} }), false)
})

test('a real non-loopback connection without a token is refused', async (t) => {
  const addr = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address
  if (!addr) return t.skip('no non-loopback IPv4 interface')
  const srv = http.createServer(app)
  const port = await listen(srv, addr)
  t.after(() => srv.close())
  const url = `http://${addr}:${port}/api/servers/${KEY}`
  assert.equal((await request('POST', url, { body: { name: 'FAKE', maxPlayers: 1, online: 1 } })).status, 403)
  assert.equal((await request('POST', url, { body: { name: 'Net', maxPlayers: 1, online: 1 }, headers: { 'x-auth-token': TOKEN } })).status, 200)
})

test('GET serverinfo still works with the public key from anywhere', async () => {
  const res = await request('GET', `${base}/api/servers/${KEY}/serverinfo`, { headers: { 'x-test-peer': PUBLIC_PEER } })
  assert.equal(res.status, 200)
  assert.equal(res.json.masterKey, KEY)
  assert.equal(res.json.name, (await listing()).name)
  assert.equal((await request('GET', `${base}/api/servers/wrong/serverinfo`)).status, 403)
})

test('GET manifest.json still works with the public key from anywhere', async () => {
  const res = await request('GET', `${base}/api/servers/${KEY}/manifest.json`, { headers: { 'x-test-peer': PUBLIC_PEER } })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json, { versionMajor: 1, mods: [{ filename: 'Skyrim.esm' }] })
  assert.equal((await request('GET', `${base}/api/servers/wrong/manifest.json`)).status, 403)
})
