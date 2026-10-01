'use strict'
// The game server's session check (master-api) refuses a player who has not accepted the current legal version, only while LEGAL_REQUIRED is on

const { test, before, after, mock } = require('node:test')
const assert = require('node:assert/strict')
const fs     = require('fs')
const http   = require('http')
const os     = require('os')
const path   = require('path')

// Never read a real .env, and keep the player, profile, faction, access and ban stores out of this test
require.cache[require.resolve('dotenv')] = { exports: { config: () => ({}) } }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-gate-'))
const DIR = path.join(tmp, 'legal')
process.env.LEGAL_DIR = DIR
process.env.LEGAL_ACCEPTANCES_FILE = path.join(tmp, 'legal-acceptances.jsonl')
function stub(rel, exports) {
  const file = require.resolve(rel)
  require.cache[file] = { id: file, filename: file, loaded: true, exports }
}
const PROFILES = { 21: '200000000000000001', 22: '200000000000000002' }
const banned = new Set()
stub('../sources/players', {
  upsertFromDiscordUser: u => ({ profileId: Number(Object.keys(PROFILES).find(k => PROFILES[k] === u.id)) }),
  load: () => ({}),
  markGameJoin: () => {},
})
stub('../sources/serverAccess', { getDiscordAccess: async () => ({ allowed: true, roles: [] }) })
stub('../sources/bans', { isBanned: ({ discordId }) => (banned.has(discordId) ? { reason: 'test' } : null), logBan: () => {} })
stub('../sources/profiles', { getDiscordIdByProfileId: id => PROFILES[id] || null })
stub('../sources/factionWhitelist', { getPlayerFactionPermissions: () => [], getPlayerGameFactions: () => [], getPlayerAssignments: () => [] })
const config = require('../config')
Object.assign(config, { serverMasterKey: 'test-key', launchCheckEnforce: false, legalRequired: false })

// master-api keeps sessions.json next to the code; that path is sent to the temp dir before the module loads it
const SESSIONS = path.join(__dirname, '..', 'data', 'sessions.json')
const redirect = original => (target, ...rest) => original.call(fs, target === SESSIONS ? path.join(tmp, 'sessions.json') : target, ...rest)
mock.method(fs, 'readFileSync', redirect(fs.readFileSync))
mock.method(fs, 'chmodSync', redirect(fs.chmodSync))
mock.method(fs, 'writeFileSync', redirect(fs.writeFileSync))

const express = require('express')
const legal = require('../sources/legal')
const masterApi = require('../routes/master-api')

const manifest = version => JSON.stringify({ version, effective: '2026-10-01', changes: ['x'], files: { terms: 'terms.md', privacy: 'privacy.md' } })
let server, base, tokenA, tokenB

before(async () => {
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(path.join(DIR, 'legal.json'), manifest('v1'))
  fs.writeFileSync(path.join(DIR, 'terms.md'), '# Terms\n')
  fs.writeFileSync(path.join(DIR, 'privacy.md'), '# Privacy\n')
  tokenA = masterApi.createSession({ id: PROFILES[21], username: 'alpha' }).session
  tokenB = masterApi.createSession({ id: PROFILES[22], username: 'beta' }).session
  const app = express()
  app.use('/api/servers', masterApi)
  server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}/api/servers/test-key`
})

after(async () => {
  await new Promise(resolve => server.close(resolve))
  mock.restoreAll()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const session = async token => { const r = await fetch(`${base}/sessions/${token}`); return { status: r.status, body: await r.json() } }
const offline = async profileId => { const r = await fetch(`${base}/profiles/${profileId}/check`); return { status: r.status, body: await r.json() } }
const REFUSED = { error: 'legalNotAccepted', message: "Please accept the Terms of Service in the launcher. Update the launcher if you don't see them." }

test('with LEGAL_REQUIRED off nobody is refused for the legal texts', async () => {
  config.legalRequired = false
  assert.equal((await session(tokenA)).status, 200)
  assert.equal((await offline(21)).status, 200)
})

test('with LEGAL_REQUIRED on a player who has not accepted is refused with the reason the game shows', async () => {
  config.legalRequired = true
  assert.deepEqual(await session(tokenA), { status: 403, body: REFUSED })
  assert.deepEqual(await offline(21), { status: 403, body: REFUSED })
})

test('accepting the current version lets the player in, and only that player', async () => {
  config.legalRequired = true
  legal.accept({ discordId: PROFILES[21], profileId: 21, version: 'v1' })
  assert.equal((await session(tokenA)).status, 200)
  assert.equal((await offline(21)).status, 200)
  assert.equal((await session(tokenB)).status, 403)
})

test('a new version refuses everyone until they accept it again', async () => {
  config.legalRequired = true
  fs.writeFileSync(path.join(DIR, 'legal.json'), manifest('v2'))
  legal.resetCache()
  assert.deepEqual(await session(tokenA), { status: 403, body: REFUSED })
  legal.accept({ discordId: PROFILES[21], profileId: 21, version: 'v2' })
  assert.equal((await session(tokenA)).status, 200)
})

test('the ban check still comes first', async () => {
  config.legalRequired = true
  banned.add(PROFILES[22])
  try { assert.deepEqual(await session(tokenB), { status: 403, body: { error: 'banned' } }) }
  finally { banned.delete(PROFILES[22]) }
})

test('unreadable legal files leave the gate open rather than locking everyone out', async () => {
  config.legalRequired = true
  fs.writeFileSync(path.join(DIR, 'legal.json'), 'not json')
  legal.resetCache()
  const errors = mock.method(console, 'error', () => {})
  try {
    assert.equal((await session(tokenB)).status, 200)
    assert.ok(errors.mock.calls.some(c => /gate left open/.test(c.arguments[0])))
  } finally { errors.mock.restore() }
  fs.writeFileSync(path.join(DIR, 'legal.json'), manifest('v2'))
  legal.resetCache()
  assert.equal((await session(tokenB)).status, 403)
})
