'use strict'
// X3 (docs/auto-report-v1.md §9): master-api keeps sessions.json at mode 0600, also when an older one was 0644.
// Since 7 Oct 2026 each save replaces the file whole, and the game server's checks answer at once when a store is unreadable.

const { test, after } = require('node:test')
const assert  = require('node:assert/strict')
const express = require('express')
const fs      = require('fs')
const http    = require('http')
const os      = require('os')
const path    = require('path')
const { DATA, loadWithDataIn } = require('./helpers/dataDir')

// Never read a real .env, and keep the player, profile, faction, access and ban stores out of this test
require.cache[require.resolve('dotenv')] = { exports: { config: () => ({}) } }
function stub(rel, exports) {
  const file = require.resolve(rel)
  require.cache[file] = { id: file, filename: file, loaded: true, exports }
}
let storeDown = false
const unreadable = () => { throw new Error('players.json is not valid JSON') }
stub('../sources/players', { upsertFromDiscordUser: () => ({ profileId: 7 }), load: () => (storeDown ? unreadable() : {}) })
stub('../sources/profiles', { getDiscordIdByProfileId: () => (storeDown ? unreadable() : '123456789012345678') })
stub('../sources/serverAccess', { getDiscordAccess: async () => ({ allowed: true, roles: [] }) })
for (const rel of ['../sources/factionWhitelist', '../sources/bans']) stub(rel, {})

// master-api keeps sessions.json next to the code; only that path is sent to a temp dir, while the module loads
const tmp  = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-file-'))
const file = path.join(tmp, 'sessions.json')
const existed = fs.existsSync(path.join(DATA, 'sessions.json'))
const masterApi = loadWithDataIn(tmp, ['sessions.json'], () => require('../routes/master-api'))
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('X3: a new sessions.json is created 0600', () => {
  const { session } = masterApi.createSession({ id: '123456789012345678', username: 'tester' })
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map(([token]) => token), [session])
  assert.equal(fs.existsSync(path.join(DATA, 'sessions.json')), existed)
  assert.deepEqual(fs.readdirSync(tmp), ['sessions.json'])
})

test('X3: a sessions.json made 0644 before is replaced by a 0600 one, so no token is ever written to a 0644 file', t => {
  fs.writeFileSync(file, '[]\n')
  fs.chmodSync(file, 0o644)
  assert.equal(fs.statSync(file).mode & 0o777, 0o644)
  const before = fs.statSync(file).ino
  // The mode of the file each write goes to, as the write is made: the tokens must only ever land in a 0600 file
  const modesAtWrite = []
  const write = fs.writeFileSync
  t.mock.method(fs, 'writeFileSync', (target, ...rest) => {
    if (typeof target === 'number') modesAtWrite.push(fs.fstatSync(target).mode & 0o777)
    else modesAtWrite.push(fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : `a new file by path: ${target}`)
    return write(target, ...rest)
  })
  const { session } = masterApi.createSession({ id: '223456789012345678', username: 'tester2' })
  t.mock.restoreAll()
  assert.deepEqual(modesAtWrite, [0o600], 'the tokens are written into a 0600 file')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.notEqual(fs.statSync(file).ino, before, 'the 0644 file was replaced, not written to')
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).some(([token]) => token === session))
  assert.deepEqual(fs.readdirSync(tmp), ['sessions.json'])
})

test('the game server\'s session and offline profile checks answer 503 storeUnavailable at once when a player store is unreadable', async () => {
  Object.assign(require('../config'), { serverMasterKey: 'test-key' })
  const app = express()
  app.use('/api/servers', masterApi)
  const server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api/servers/test-key`
  const get = async url => { const r = await fetch(url, { signal: AbortSignal.timeout(5000) }); return [r.status, await r.json()] }
  try {
    const { session } = masterApi.createSession({ id: '323456789012345678', username: 'tester3' })
    storeDown = true
    assert.deepEqual(await get(`${base}/sessions/${session}`), [503, { error: 'storeUnavailable' }])
    assert.deepEqual(await get(`${base}/profiles/21/check`), [503, { error: 'storeUnavailable' }])
  } finally {
    storeDown = false
    await new Promise(resolve => server.close(resolve))
  }
})
