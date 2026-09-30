'use strict'
// X3 (docs/auto-report-v1.md §9): master-api creates sessions.json with mode 0600

const { test, before, after, mock } = require('node:test')
const assert = require('node:assert/strict')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')

// Never read a real .env, and keep the player, profile, faction, access and ban stores out of this test
require.cache[require.resolve('dotenv')] = { exports: { config: () => ({}) } }
function stub(rel, exports) {
  const file = require.resolve(rel)
  require.cache[file] = { id: file, filename: file, loaded: true, exports }
}
stub('../sources/players', { upsertFromDiscordUser: () => ({ profileId: 7 }) })
for (const rel of ['../sources/factionWhitelist', '../sources/serverAccess', '../sources/profiles', '../sources/bans']) stub(rel, {})

// master-api keeps sessions.json next to the code; only that path is sent to a temp dir, before the module loads it
const SESSIONS = path.join(__dirname, '..', 'data', 'sessions.json')
let tmp, file

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-file-'))
  file = path.join(tmp, 'sessions.json')
  const redirect = original => (target, ...rest) => original.call(fs, target === SESSIONS ? file : target, ...rest)
  mock.method(fs, 'readFileSync', redirect(fs.readFileSync))
  mock.method(fs, 'writeFileSync', redirect(fs.writeFileSync))
})
after(() => {
  mock.restoreAll()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('X3: a new sessions.json is created 0600', () => {
  const existed = fs.existsSync(SESSIONS)
  const masterApi = require('../routes/master-api')
  const { session } = masterApi.createSession({ id: '123456789012345678', username: 'tester' })
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map(([token]) => token), [session])
  assert.equal(fs.existsSync(SESSIONS), existed)
})
