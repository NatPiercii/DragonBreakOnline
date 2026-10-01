'use strict'
// /api/legal (and its /api/files/legal alias): the texts, a player's status, accepting, the record file and the rate limits

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs     = require('fs')
const http   = require('http')
const os     = require('os')
const path   = require('path')

// Never read a real .env, session store or data folder
require.cache[require.resolve('dotenv')] = { exports: { config: () => ({}) } }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-route-'))
const DIR = path.join(tmp, 'legal')
process.env.LEGAL_DIR = DIR
process.env.LEGAL_ACCEPTANCES_FILE = path.join(tmp, 'data', 'legal-acceptances.jsonl')
const FILE = process.env.LEGAL_ACCEPTANCES_FILE

function stub(rel, exports) {
  const file = require.resolve(rel)
  require.cache[file] = { id: file, filename: file, loaded: true, exports }
}
const sessions = new Map()
stub('../routes/master-api', { lookupSession: token => sessions.get(token) || null })
const config = require('../config')
config.legalRequired = false

const express = require('express')
const legal = require('../sources/legal')

const manifest = (version, changes = ['First version.']) => JSON.stringify({ version, effective: '2026-10-01', changes, files: { terms: 'terms.md', privacy: 'privacy.md' } })
const TERMS = '# Terms of Service\n\n**Effective date: October 1, 2026**\n\n* Be 18 or older.\n'
const PRIVACY = '# Privacy Policy\r\n\r\nWe collect your Discord user ID.\r\n'
let server, base

before(async () => {
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(path.join(DIR, 'legal.json'), manifest('v1'))
  fs.writeFileSync(path.join(DIR, 'terms.md'), TERMS)
  fs.writeFileSync(path.join(DIR, 'privacy.md'), PRIVACY)
  sessions.set('tok-a', { discordId: '100000000000000001', profileId: 11, username: 'alpha' })
  sessions.set('tok-b', { discordId: '100000000000000002', profileId: 12, username: 'beta' })
  sessions.set('tok-c', { discordId: '100000000000000003', profileId: 13, username: 'gamma' })
  sessions.set('tok-d', { discordId: '100000000000000004', profileId: 14, username: 'delta' })
  sessions.set('tok-e', { discordId: '100000000000000005', profileId: 15, username: 'epsilon' })
  const app = express()
  app.set('trust proxy', 'loopback')
  app.use(express.json())
  app.use(['/api/legal', '/api/files/legal'], require('../routes/legal'))
  app.use(require('../sources/problemReport').bodyErrors)
  server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise(resolve => server.close(resolve))
  fs.rmSync(tmp, { recursive: true, force: true })
})

const get = (p, headers = {}) => fetch(base + p, { headers })
const post = (p, body, headers = {}) => fetch(base + p, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
})
const lines = () => (fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean) : [])
const setVersion = v => { fs.writeFileSync(path.join(DIR, 'legal.json'), manifest(v, [`Changed in ${v}.`])); legal.resetCache() }

test('GET /api/legal answers the version, what changed and both texts, cacheable, at both paths', async () => {
  for (const p of ['/api/legal', '/api/files/legal']) {
    const res = await get(p)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300')
    const body = await res.json()
    assert.deepEqual(body, { version: 'v1', effective: '2026-10-01', changes: ['First version.'], terms: TERMS, privacy: PRIVACY.replace(/\r\n/g, '\n') })
    const etag = res.headers.get('etag')
    assert.ok(etag)
    // fetch sends no-cache, which Express rightly answers in full, so the revalidation goes through http.get
    const status = await new Promise((resolve, reject) => http.get(base + p, { headers: { 'if-none-match': etag } }, r => { r.resume(); resolve(r.statusCode) }).on('error', reject))
    assert.equal(status, 304)
  }
})

test('the status and accept routes need a live play session', async () => {
  for (const headers of [{}, { 'x-session': 'nope' }]) {
    const s = await get('/api/legal/status', headers)
    assert.equal(s.status, 401)
    assert.equal(s.headers.get('cache-control'), 'no-store')
    assert.equal((await post('/api/legal/accept', { version: 'v1' }, headers)).status, 401)
  }
  assert.deepEqual(lines(), [])
})

test('a player who never accepted is asked, and accepting records one line, 0600', async () => {
  const before = await (await get('/api/legal/status', { 'x-session': 'tok-a' })).json()
  assert.deepEqual(before, { accepted: false, version: 'v1', acceptedAt: null, lastAcceptedVersion: null, required: false })

  const res = await post('/api/legal/accept', { version: 'v1', launcherVersion: '2.1.36' }, { 'x-session': 'tok-a' })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  const body = await res.json()
  assert.equal(body.accepted, true)
  assert.equal(body.alreadyAccepted, false)
  assert.equal(body.version, 'v1')
  const recorded = lines().map(l => JSON.parse(l))
  assert.deepEqual(recorded, [{ discordId: '100000000000000001', profileId: 11, version: 'v1', at: body.at, launcherVersion: '2.1.36' }])
  assert.equal(fs.statSync(FILE).mode & 0o777, 0o600)

  const after = await (await get('/api/files/legal/status', { 'x-session': 'tok-a' })).json()
  assert.deepEqual(after, { accepted: true, version: 'v1', acceptedAt: body.at, lastAcceptedVersion: 'v1', required: false })
})

test('accepting again is a no-op that answers the first record', async () => {
  const first = JSON.parse(lines()[0])
  const res = await post('/api/files/legal/accept', { version: 'v1' }, { 'x-session': 'tok-a' })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { accepted: true, version: 'v1', at: first.at, alreadyAccepted: true })
  assert.equal(lines().length, 1)
})

test('only the current version can be accepted, and a bad body is refused', async () => {
  const stale = await post('/api/legal/accept', { version: 'v0' }, { 'x-session': 'tok-b' })
  assert.equal(stale.status, 409)
  assert.deepEqual(await stale.json(), { error: 'versionMismatch', version: 'v1' })
  for (const body of [{}, { version: 1 }, { version: '../../etc' }, { version: 'x'.repeat(40) }]) {
    assert.equal((await post('/api/legal/accept', body, { 'x-session': 'tok-b' })).status, 400, JSON.stringify(body))
  }
  assert.equal((await post('/api/legal/accept', '{not json', { 'x-session': 'tok-b' })).status, 400)
  assert.equal(lines().length, 1)
})

test('a launcher version that is not a version is not recorded', async () => {
  await post('/api/legal/accept', { version: 'v1', launcherVersion: 'C:\\Users\\someone' }, { 'x-session': 'tok-b' })
  const rec = JSON.parse(lines()[1])
  assert.equal(rec.discordId, '100000000000000002')
  assert.equal(rec.launcherVersion, null)
})

test('a new version asks everyone again, and the status says which version they accepted last', async () => {
  setVersion('v2')
  const text = await (await get('/api/legal')).json()
  assert.equal(text.version, 'v2')
  assert.deepEqual(text.changes, ['Changed in v2.'])
  const status = await (await get('/api/legal/status', { 'x-session': 'tok-a' })).json()
  assert.equal(status.accepted, false)
  assert.equal(status.version, 'v2')
  assert.equal(status.lastAcceptedVersion, 'v1')
  assert.equal((await post('/api/legal/accept', { version: 'v1' }, { 'x-session': 'tok-a' })).status, 409)
  assert.equal((await post('/api/legal/accept', { version: 'v2' }, { 'x-session': 'tok-a' })).status, 200)
  assert.equal(lines().length, 3)
  const again = await (await get('/api/legal/status', { 'x-session': 'tok-a' })).json()
  assert.equal(again.accepted, true)
  assert.equal(again.lastAcceptedVersion, 'v2')
})

test('the record survives a restart, and a line torn by a crash neither counts nor swallows the next one', async () => {
  fs.appendFileSync(FILE, '{"discordId":"100000000000000003","vers')
  legal.resetCache()
  assert.equal(legal.acceptanceOf('100000000000000001', 'v2').version, 'v2')
  assert.equal(legal.acceptanceOf('100000000000000003', 'v2'), null)
  assert.equal((await post('/api/legal/accept', { version: 'v2' }, { 'x-session': 'tok-c' })).status, 200)
  legal.resetCache()
  assert.equal(legal.acceptanceOf('100000000000000003', 'v2').profileId, 13)
  assert.equal(lines().filter(l => { try { JSON.parse(l); return true } catch { return false } }).length, 4)
})

test('unreadable documents answer 503 and are never cached as good', async () => {
  fs.writeFileSync(path.join(DIR, 'legal.json'), '{"version": ')
  legal.resetCache()
  const res = await get('/api/legal')
  assert.equal(res.status, 503)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.equal((await get('/api/legal/status', { 'x-session': 'tok-a' })).status, 503)
  assert.equal((await post('/api/legal/accept', { version: 'v2' }, { 'x-session': 'tok-d' })).status, 503)
  fs.writeFileSync(path.join(DIR, 'legal.json'), manifest('v2', ['Changed in v2.']))
  legal.resetCache()
  assert.equal((await get('/api/legal')).status, 200)
})

test('accepting is limited per player, the status per player, and a signed-out caller per address', async () => {
  let codes = []
  for (let i = 0; i < 21; i++) codes.push((await post('/api/legal/accept', { version: 'v2' }, { 'x-session': 'tok-e' })).status)
  assert.deepEqual(codes.slice(0, 20), Array(20).fill(200))
  assert.equal(codes[20], 429)
  // Another player is not held back by the first one's limit
  assert.equal((await post('/api/legal/accept', { version: 'v2' }, { 'x-session': 'tok-b' })).status, 200)

  codes = []
  for (let i = 0; i < 61; i++) codes.push((await get('/api/legal/status', { 'cf-connecting-ip': '203.0.113.9' })).status)
  assert.equal(codes.filter(c => c === 401).length, 60)
  assert.equal(codes[60], 429)
  assert.equal((await get('/api/legal/status', { 'cf-connecting-ip': '203.0.113.10' })).status, 401)
})

test('the public text is limited per visitor address', async () => {
  let res
  for (let i = 0; i < 121; i++) res = await get('/api/legal', { 'cf-connecting-ip': '198.51.100.7' })
  assert.equal(res.status, 429)
  assert.equal((await get('/api/legal', { 'cf-connecting-ip': '198.51.100.8' })).status, 200)
})
