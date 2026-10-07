'use strict'
// Fail closed (7 Oct 2026): a sessions.json that exists but cannot be read or parsed is never taken for an empty one.
// master-api then creates no launcher session and writes nothing over the file, so the sessions in it can be restored.

const { test, after, mock } = require('node:test')
const assert = require('node:assert/strict')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')
const { loadWithDataIn } = require('./helpers/dataDir')

// Never read a real .env, and keep the player, profile, faction, access and ban stores out of this test
require.cache[require.resolve('dotenv')] = { exports: { config: () => ({}) } }
function stub(rel, exports) {
  const file = require.resolve(rel)
  require.cache[file] = { id: file, filename: file, loaded: true, exports }
}
let upserts = 0
stub('../sources/players', { upsertFromDiscordUser: () => { upserts++; return { profileId: 7 } }, load: () => ({}), markGameJoin: () => {} })
for (const rel of ['../sources/factionWhitelist', '../sources/serverAccess', '../sources/profiles', '../sources/bans']) stub(rel, {})

const tmp   = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-failclosed-'))
const FILE  = path.join(tmp, 'sessions.json')
const TOKEN = 'a'.repeat(64)
// One saved session, cut off mid-write
const CUT = JSON.stringify([[TOKEN, { profileId: 1, discordId: '100000000000000001', username: 'owner', expiresAt: Date.now() + 3600e3 }]], null, 2).slice(0, 90)
fs.writeFileSync(FILE, CUT, { mode: 0o600 })

const errors = []
mock.method(console, 'error', (...args) => { errors.push(args.join(' ')) })
let masterApi, loadError = null
try { masterApi = loadWithDataIn(tmp, ['sessions.json'], () => require('../routes/master-api')) }
catch (err) { loadError = err }
mock.restoreAll()
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('master-api loads over an unreadable sessions.json without throwing (the startup check stops the backend), and says so loudly', () => {
  assert.equal(loadError, null)
  assert.ok(errors.some(line => line.includes('FAIL CLOSED') && line.includes(FILE)), errors.join('\n'))
})

test('no launcher session is created and nothing is written over the file', () => {
  assert.throws(() => masterApi.createSession({ id: '300000000000000009', username: 'newcomer' }), /sessions/)
  assert.equal(upserts, 0, 'no profile was looked up or made')
  assert.equal(fs.readFileSync(FILE, 'utf8'), CUT)
  assert.deepEqual(fs.readdirSync(tmp), ['sessions.json'])
})

test('a session saved in the unreadable file is not accepted', () => {
  assert.equal(masterApi.lookupSession(TOKEN), null)
  assert.equal(masterApi.recordLaunchCheck(TOKEN, { filesVersion: 'x', filesOk: true, pluginsOk: true }), false)
  assert.equal(fs.readFileSync(FILE, 'utf8'), CUT)
})

test('sessions.json reads: none when missing, the saved pairs when good, and an error for anything that is not a list', () => {
  const sessionsFile = require('../sources/sessionsFile')
  assert.equal(sessionsFile.FILE, FILE)
  mock.method(console, 'error', () => {})
  try {
    for (const bad of [CUT, '', 'null\n', '{}\n', '"x"\n']) {
      fs.writeFileSync(FILE, bad)
      assert.throws(() => sessionsFile.read(), /sessions\.json/, JSON.stringify(bad))
    }
  } finally { mock.restoreAll() }
  fs.writeFileSync(FILE, '[]\n')
  assert.deepEqual(sessionsFile.read(), [])
  fs.writeFileSync(FILE, JSON.stringify([[TOKEN, { expiresAt: 1 }]], null, 2) + '\n')
  assert.deepEqual(sessionsFile.read(), [[TOKEN, { expiresAt: 1 }]])
  fs.rmSync(FILE)
  assert.deepEqual(sessionsFile.read(), [])
})
