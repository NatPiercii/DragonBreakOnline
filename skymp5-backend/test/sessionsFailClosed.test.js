'use strict'
// An unreadable sessions.json (7 Oct 2026) is never read as an empty one and never written over. It holds only launcher
// sign-ins and hands out no profile id, so since 8 Oct it does not keep the backend down either: it is moved aside as it
// was (sessions.json.bad-<ms>, still 0600), every session in it is void, and master-api starts with none, so players
// sign in again. Only when it cannot even be moved does master-api refuse to create a session.

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

const TOKEN = 'a'.repeat(64)
// One saved session, cut off mid-write
const CUT = JSON.stringify([[TOKEN, { profileId: 1, discordId: '100000000000000001', username: 'owner', expiresAt: Date.now() + 3600e3 }]], null, 2).slice(0, 90)
const dirs = []
after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }) })

// A fresh master-api (and sessionsFile) over a temp folder holding `content` as sessions.json; console.error is recorded
function loadOver(content, { renameFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-failclosed-'))
  dirs.push(dir)
  const file = path.join(dir, 'sessions.json')
  fs.writeFileSync(file, content, { mode: 0o600 })
  for (const rel of ['../routes/master-api', '../sources/sessionsFile']) {
    try { delete require.cache[require.resolve(rel)] } catch { /* a tree without sessionsFile (the code before 7 Oct) */ }
  }
  const errors = []
  mock.method(console, 'error', (...args) => { errors.push(args.join(' ')) })
  if (renameFails) {
    const rename = fs.renameSync
    mock.method(fs, 'renameSync', (from, to) => {
      if (String(from) === file) throw Object.assign(new Error(`EACCES: permission denied, rename '${from}'`), { code: 'EACCES' })
      return rename(from, to)
    })
  }
  let masterApi = null, loadError = null
  try { masterApi = loadWithDataIn(dir, ['sessions.json'], () => require('../routes/master-api')) }
  catch (err) { loadError = err }
  finally { mock.restoreAll() }
  const aside = () => fs.readdirSync(dir).filter(name => /^sessions\.json\.bad-\d+$/.test(name)).map(name => path.join(dir, name))
  return { dir, file, errors, masterApi, loadError, aside }
}

const run = loadOver(CUT)

test('master-api loads over an unreadable sessions.json: the file is moved aside as it was, still 0600, and that is logged loudly', () => {
  assert.equal(run.loadError, null)
  const aside = run.aside()
  assert.equal(aside.length, 1, fs.readdirSync(run.dir).join(', '))
  assert.equal(fs.readFileSync(aside[0], 'utf8'), CUT)
  assert.equal(fs.statSync(aside[0]).mode & 0o777, 0o600)
  assert.equal(fs.existsSync(run.file), false)
  assert.ok(run.errors.some(line => line.includes('FAIL CLOSED') && line.includes(`${run.file} moved aside to ${aside[0]}`)), run.errors.join('\n'))
})

test('a session saved in the unreadable file is not accepted', () => {
  assert.equal(run.masterApi.lookupSession(TOKEN), null)
  assert.equal(run.masterApi.recordLaunchCheck(TOKEN, { filesVersion: 'x', filesOk: true, pluginsOk: true }), false)
})

test('players sign in again: a new session is made and saved in a new 0600 sessions.json, and the moved file is left alone', () => {
  const before = upserts
  const { session } = run.masterApi.createSession({ id: '300000000000000009', username: 'newcomer' })
  assert.equal(upserts, before + 1)
  assert.ok(run.masterApi.lookupSession(session))
  assert.deepEqual(JSON.parse(fs.readFileSync(run.file, 'utf8')).map(([token]) => token), [session])
  assert.equal(fs.statSync(run.file).mode & 0o777, 0o600)
  assert.equal(fs.readFileSync(run.aside()[0], 'utf8'), CUT)
})

test('when the file cannot even be moved aside, no session is created or accepted and nothing is written over it', () => {
  const stuck = loadOver(CUT, { renameFails: true })
  assert.equal(stuck.loadError, null)
  assert.ok(stuck.errors.some(line => line.includes('FAIL CLOSED') && line.includes('could not be moved aside')), stuck.errors.join('\n'))
  const before = upserts
  assert.throws(() => stuck.masterApi.createSession({ id: '300000000000000010', username: 'newcomer2' }), /sessions/)
  assert.equal(upserts, before, 'no profile was looked up or made')
  assert.equal(stuck.masterApi.lookupSession(TOKEN), null)
  assert.equal(fs.readFileSync(stuck.file, 'utf8'), CUT)
  assert.deepEqual(fs.readdirSync(stuck.dir), ['sessions.json'])
})

test('sessions.json reads: none when missing, the saved pairs when good, and an error for anything that is not a list', () => {
  const sessionsFile = require('../sources/sessionsFile')
  const FILE = sessionsFile.FILE
  assert.equal(path.basename(FILE), 'sessions.json')
  assert.ok(dirs.includes(path.dirname(FILE)), 'the temp folder, not the real data folder')
  mock.method(console, 'error', () => {})
  try {
    for (const bad of [CUT, '', 'null\n', '{}\n', '"x"\n']) {
      fs.writeFileSync(FILE, bad)
      assert.throws(() => sessionsFile.read(), /sessions\.json/, JSON.stringify(bad))
    }
  } finally { mock.restoreAll() }
  fs.writeFileSync(FILE, '[]\n')
  assert.deepEqual(sessionsFile.read(), [])
  assert.deepEqual(sessionsFile.load(), [])
  fs.writeFileSync(FILE, JSON.stringify([[TOKEN, { expiresAt: 1 }]], null, 2) + '\n')
  assert.deepEqual(sessionsFile.read(), [[TOKEN, { expiresAt: 1 }]])
  assert.deepEqual(sessionsFile.load(), [[TOKEN, { expiresAt: 1 }]])
  fs.rmSync(FILE)
  assert.deepEqual(sessionsFile.read(), [])
  assert.deepEqual(sessionsFile.load(), [])
})
