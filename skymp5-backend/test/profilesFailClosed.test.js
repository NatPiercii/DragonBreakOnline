'use strict'
// Fail closed (7 Oct 2026). profiles.json gives each Discord account its game profile id; players.json sits beside it.
// A store that exists but cannot be read or parsed (a crash mid-write on a nearly full disk) must stop sign-ins, never
// be read as empty: an empty profiles.json gives the next new player profile id 1, the owner's, and their characters.
// Saves replace a file whole, so a crash or a full disk leaves the old file or the new one, never half of one. Only
// profiles.json's saves are fsynced: the others are saved several times per game start, and an fsync blocks the backend.

const { test, beforeEach, afterEach, after, mock } = require('node:test')
const assert = require('node:assert/strict')
const childProcess = require('child_process')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')
const { loadWithDataIn } = require('./helpers/dataDir')

// players.js adds faction slots to the rows it lists; keep that store out
function stub(rel, exports) {
  const file = require.resolve(rel)
  require.cache[file] = { id: file, filename: file, loaded: true, exports }
}
stub('../sources/factionWhitelist', { getPlayerAssignments: () => [], getPlayerFactionPermissions: () => [], getPlayerGameFactions: () => [] })

const BACKEND  = path.join(__dirname, '..')
const tmp      = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-failclosed-'))
const STORES   = ['profiles.json', 'players.json']
const PROFILES = path.join(tmp, 'profiles.json')
const PLAYERS  = path.join(tmp, 'players.json')
const { profiles, players } = loadWithDataIn(tmp, STORES, () => ({
  profiles: require('../sources/profiles'),
  players:  require('../sources/players'),
}))

const OWNER    = '100000000000000001'
const NEWCOMER = '300000000000000009'
const STORE    = { nextId: 4, map: { [OWNER]: 1, '100000000000000002': 2, '100000000000000003': 3 } }
const ROWS     = { [OWNER]: { profileId: 1, discordId: OWNER, username: 'owner', createdAt: '2026-09-01T00:00:00.000Z' } }
// The format both files have always had
const json = value => JSON.stringify(value, null, 2) + '\n'
const leftovers = () => fs.readdirSync(tmp).filter(name => !STORES.includes(name))

let errors
beforeEach(() => {
  for (const name of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, name), { recursive: true, force: true })
  errors = []
  mock.method(console, 'error', (...args) => { errors.push(args.join(' ')) })
})
afterEach(() => mock.restoreAll())
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('a truncated profiles.json (a crash mid-write) stops a new sign-in instead of giving it profile id 1, and stays as it was', () => {
  const cut = json(STORE).slice(0, 40)
  fs.writeFileSync(PROFILES, cut)
  fs.writeFileSync(PLAYERS, json(ROWS))
  assert.throws(() => profiles.getOrCreateProfileId(NEWCOMER), /profiles\.json/)
  assert.throws(() => players.upsertFromDiscordUser({ id: NEWCOMER, username: 'newcomer' }), /profiles\.json/)
  assert.throws(() => profiles.getDiscordIdByProfileId(1), /profiles\.json/)
  assert.equal(fs.readFileSync(PROFILES, 'utf8'), cut)
  assert.equal(fs.readFileSync(PLAYERS, 'utf8'), json(ROWS))
  assert.ok(errors.some(line => line.includes('FAIL CLOSED') && line.includes(PROFILES)), 'a loud log line names the file')
  assert.ok(errors.some(line => line.includes('scripts/rebuild-profiles.js') && /older copy/.test(line)),
    'and says how to rebuild it, not to restore an older copy as it is')
})

const BAD_PROFILES = [
  ['empty (0 bytes)', ''],
  ['cut inside a value', json(STORE).slice(0, -8)],
  ['null', 'null\n'],
  ['a list', '[]\n'],
  ['an object without nextId or map', '{}\n'],
  ['with a nextId that is not a number', json({ nextId: '4', map: STORE.map })],
  ['with a map that is not an object', json({ nextId: 4, map: [] })],
  ['with a profile id that is not a whole number', json({ nextId: 4, map: { [OWNER]: '1' } })],
  ['with a nextId not above a profile id that is taken', json({ nextId: 3, map: STORE.map })],
]
for (const [why, content] of BAD_PROFILES) {
  test(`profiles.json ${why}: no profile id is handed out and the file stays as it was`, () => {
    fs.writeFileSync(PROFILES, content)
    assert.throws(() => profiles.getOrCreateProfileId(NEWCOMER), /profiles\.json/)
    assert.throws(() => profiles.list(), /profiles\.json/)
    assert.equal(fs.readFileSync(PROFILES, 'utf8'), content)
  })
}

test('a profiles.json that cannot be read (an error other than a missing file) stops sign-ins too', () => {
  fs.mkdirSync(PROFILES)   // reading it fails with EISDIR, as a failing disk fails with EIO
  assert.throws(() => profiles.list(), /profiles\.json/)
  assert.throws(() => profiles.getOrCreateProfileId(NEWCOMER), /profiles\.json/)
  assert.ok(fs.statSync(PROFILES).isDirectory())
})

test('a missing profiles.json next to a players.json is not a first run: no profile id is handed out', () => {
  fs.writeFileSync(PLAYERS, json(ROWS))
  assert.throws(() => profiles.getOrCreateProfileId(NEWCOMER), /profiles\.json is missing/)
  assert.throws(() => players.upsertFromDiscordUser({ id: NEWCOMER, username: 'newcomer' }), /profiles\.json is missing/)
  assert.equal(fs.existsSync(PROFILES), false)
  assert.equal(fs.readFileSync(PLAYERS, 'utf8'), json(ROWS))
})

test('a first run (neither file there yet) starts at profile id 1, in the format the files have always had', () => {
  const row = players.upsertFromDiscordUser({ id: OWNER, username: 'owner' })
  assert.equal(row.profileId, 1)
  assert.equal(profiles.getOrCreateProfileId(NEWCOMER), 2)
  assert.equal(fs.readFileSync(PROFILES, 'utf8'), json({ nextId: 3, map: { [OWNER]: 1, [NEWCOMER]: 2 } }))
  assert.equal(fs.readFileSync(PLAYERS, 'utf8'), json({ [OWNER]: row }))
  assert.deepEqual(leftovers(), [])
})

test('on a good profiles.json a new player gets the next id, a known one keeps theirs, and the file keeps its format and mode', () => {
  fs.writeFileSync(PROFILES, json(STORE))
  fs.chmodSync(PROFILES, 0o640)
  assert.equal(profiles.getOrCreateProfileId(OWNER), 1)
  assert.equal(profiles.getOrCreateProfileId(NEWCOMER), 4)
  assert.equal(fs.readFileSync(PROFILES, 'utf8'), json({ nextId: 5, map: { ...STORE.map, [NEWCOMER]: 4 } }))
  assert.equal(fs.statSync(PROFILES).mode & 0o777, 0o640)
  assert.deepEqual(leftovers(), [])
})

const BAD_PLAYERS = [
  ['truncated', json(ROWS).slice(0, 30)],
  ['empty (0 bytes)', ''],
  ['a list', '[]\n'],
  ['null', 'null\n'],
  ['with a row that is not an object', json({ [OWNER]: 1 })],
]
for (const [why, content] of BAD_PLAYERS) {
  test(`players.json ${why}: sign-ins stop, no profile id is used up, and the file stays as it was`, () => {
    fs.writeFileSync(PROFILES, json(STORE))
    fs.writeFileSync(PLAYERS, content)
    assert.throws(() => players.load(), /players\.json/)
    assert.throws(() => players.upsertFromDiscordUser({ id: NEWCOMER, username: 'newcomer' }), /players\.json/)
    assert.throws(() => players.updateIdentity(OWNER, { ip: '10.0.0.1' }), /players\.json/)
    assert.equal(fs.readFileSync(PLAYERS, 'utf8'), content)
    assert.equal(fs.readFileSync(PROFILES, 'utf8'), json(STORE))
  })
}

// A write that stops part way, as on a full disk: half of the bytes land, then ENOSPC
function cutWritesShort() {
  const enospc = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
  const half = data => (typeof data === 'string' ? data.slice(0, data.length >> 1) : data.subarray(0, data.length >> 1))
  const { writeFileSync, writeSync } = fs
  mock.method(fs, 'writeFileSync', (target, data, ...rest) => { writeFileSync(target, half(data), ...rest); throw enospc() })
  mock.method(fs, 'writeSync', (fd, data) => { writeSync(fd, half(data)); throw enospc() })
}

test('a save cut short (disk full) leaves the old profiles.json and players.json whole, and uses up no profile id', () => {
  fs.writeFileSync(PROFILES, json(STORE))
  fs.writeFileSync(PLAYERS, json(ROWS))
  cutWritesShort()
  assert.throws(() => profiles.getOrCreateProfileId(NEWCOMER), /ENOSPC/)
  assert.throws(() => players.markGameJoin(OWNER), /ENOSPC/)
  mock.restoreAll()
  assert.equal(fs.readFileSync(PROFILES, 'utf8'), json(STORE))
  assert.equal(fs.readFileSync(PLAYERS, 'utf8'), json(ROWS))
  assert.deepEqual(leftovers(), [])
  assert.equal(profiles.getOrCreateProfileId(NEWCOMER), 4)
})

// Every fs call a save makes, in order: open, write, fsync, rename (with the paths they were made on)
function recordSaves() {
  const events = []
  const fdPath = new Map()
  const real = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync, writeFileSync: fs.writeFileSync }
  mock.method(fs, 'openSync', (file, flags, ...rest) => {
    const fd = real.openSync(file, flags, ...rest)
    fdPath.set(fd, String(file))
    events.push(['open', String(file), String(flags)])
    return fd
  })
  mock.method(fs, 'fsyncSync', fd => { real.fsyncSync(fd); events.push(['fsync', fdPath.get(fd)]) })
  mock.method(fs, 'renameSync', (from, to) => { real.renameSync(from, to); events.push(['rename', String(from), String(to)]) })
  mock.method(fs, 'writeFileSync', (target, ...rest) => {
    real.writeFileSync(target, ...rest)
    events.push(['write', typeof target === 'number' ? fdPath.get(target) : String(target)])
  })
  return events
}
// The save of `file` in events: the temp file it was written to, and whether that and the folder were fsynced around the rename
function saveOf(events, file) {
  const name = path.basename(file)
  const renamed = events.findIndex(([kind, , to]) => kind === 'rename' && to === file)
  assert.ok(renamed >= 0, `${name} is replaced by a rename`)
  const temp = events[renamed][1]
  assert.equal(path.dirname(temp), tmp, `${name}: the temp file is in the same folder`)
  assert.ok(events.some(([kind, f], i) => i < renamed && kind === 'write' && f === temp), `${name}: the text is written to the temp file`)
  assert.ok(!events.some(([kind, f, flags]) => f === file && (kind === 'write' || (kind === 'open' && /[wa+]/.test(flags)))),
    `${name} itself is never opened for writing`)
  return {
    tempSynced: events.some(([kind, f], i) => i < renamed && kind === 'fsync' && f === temp),
    folderSynced: events.some(([kind, f], i) => i > renamed && kind === 'fsync' && f === tmp),
  }
}

test('every save is an atomic replace: a temp file in the same folder renamed over the file; profiles.json\'s is fsynced, before and after', () => {
  fs.writeFileSync(PROFILES, json(STORE))
  fs.writeFileSync(PLAYERS, json(ROWS))
  const events = recordSaves()
  assert.equal(profiles.getOrCreateProfileId(NEWCOMER), 4)
  players.markGameJoin(OWNER)
  mock.restoreAll()
  assert.deepEqual(saveOf(events, PROFILES), { tempSynced: true, folderSynced: true }, 'a profile id is on disk before it is handed out')
  assert.deepEqual(saveOf(events, PLAYERS), { tempSynced: false, folderSynced: false }, 'players.json is not fsynced: it would block the backend')
  assert.equal(events.filter(([kind]) => kind === 'fsync').length, 2, 'only the profiles.json save waits on the disk')
  assert.deepEqual(leftovers(), [])
})

test('a store file made new (nothing there to replace) is fsynced too, so a crash cannot leave it empty', () => {
  const events = recordSaves()
  players.upsertFromDiscordUser({ id: OWNER, username: 'owner' })
  mock.restoreAll()
  assert.deepEqual(saveOf(events, PROFILES), { tempSynced: true, folderSynced: true })
  assert.deepEqual(saveOf(events, PLAYERS), { tempSynced: true, folderSynced: true })
  const again = recordSaves()
  players.markGameJoin(OWNER)
  mock.restoreAll()
  assert.deepEqual(saveOf(again, PLAYERS), { tempSynced: false, folderSynced: false }, 'the next save replaces it, with no fsync')
  assert.deepEqual(leftovers(), [])
})

// The startup check in a separate node, with the three stores in a temp folder; 'started' means it let the backend go on
function startupCheck(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-check-'))
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content)
  const script = `
    const { loadWithDataIn } = require(${JSON.stringify(path.join(__dirname, 'helpers', 'dataDir'))})
    const check = loadWithDataIn(${JSON.stringify(dir)}, ['profiles.json', 'players.json', 'sessions.json'],
      () => require(${JSON.stringify(path.join(BACKEND, 'sources', 'storeCheck'))}))
    check.checkOrExit()
    console.log('started')`
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const run = childProcess.spawnSync(process.execPath, ['-e', script], { cwd: dir, env, encoding: 'utf8', timeout: 30000 })
  run.files = fs.readdirSync(dir).sort()
  fs.rmSync(dir, { recursive: true, force: true })
  return run
}
const GOOD = { 'profiles.json': json(STORE), 'players.json': json(ROWS), 'sessions.json': '[]\n' }

test('the backend does not start on a profiles.json or players.json it cannot read: the startup check exits non-zero and names the file', () => {
  for (const name of ['profiles.json', 'players.json']) {
    const run = startupCheck({ ...GOOD, [name]: '[{"trunc' })
    assert.equal(run.status, 1, `${name}: ${run.stderr}`)
    assert.match(run.stderr, new RegExp(`FAIL CLOSED, backend not started: .*${name.replace('.', '\\.')}`))
    assert.doesNotMatch(run.stdout, /started/)
    assert.deepEqual(run.files, Object.keys(GOOD).sort(), `${name}: nothing is moved or written`)
  }
  const lost = startupCheck({ 'players.json': json(ROWS), 'sessions.json': '[]\n' })
  assert.equal(lost.status, 1, lost.stderr)
  assert.match(lost.stderr, /profiles\.json is missing/)
})

test('an unreadable sessions.json does not keep the backend down: it is moved aside, still 0600, and the backend starts with no sessions', () => {
  const cut = '[["' + 'a'.repeat(64) + '", {"profileId": 1, "exp'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-check-'))
  try {
    for (const [name, content] of Object.entries({ ...GOOD, 'sessions.json': cut })) fs.writeFileSync(path.join(dir, name), content)
    fs.chmodSync(path.join(dir, 'sessions.json'), 0o600)
    const script = `
      const { loadWithDataIn } = require(${JSON.stringify(path.join(__dirname, 'helpers', 'dataDir'))})
      loadWithDataIn(${JSON.stringify(dir)}, ['profiles.json', 'players.json', 'sessions.json'],
        () => require(${JSON.stringify(path.join(BACKEND, 'sources', 'storeCheck'))})).checkOrExit()
      console.log('started')`
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const run = childProcess.spawnSync(process.execPath, ['-e', script], { cwd: dir, env, encoding: 'utf8', timeout: 30000 })
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /started/)
    const aside = fs.readdirSync(dir).filter(name => /^sessions\.json\.bad-\d+$/.test(name))
    assert.equal(aside.length, 1, fs.readdirSync(dir).join(', '))
    assert.equal(fs.existsSync(path.join(dir, 'sessions.json')), false, 'the backend starts with no sessions')
    assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), cut, 'the file is kept as it was')
    assert.equal(fs.statSync(path.join(dir, aside[0])).mode & 0o777, 0o600, 'and stays private')
    assert.match(run.stderr, new RegExp(`FAIL CLOSED: .*sessions\\.json moved aside to .*${aside[0]}; every launcher session in it is void`))
    assert.equal(fs.readFileSync(path.join(dir, 'profiles.json'), 'utf8'), json(STORE))
    assert.equal(fs.readFileSync(path.join(dir, 'players.json'), 'utf8'), json(ROWS))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('the startup check lets good stores and a first run (no files yet) through', () => {
  for (const files of [GOOD, {}]) {
    const run = startupCheck(files)
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /started/)
  }
})

// node server.js in a separate process, with the stores in a temp folder. What server.js starts after the check (the
// relay, the Discord bot, the dashboard, the routes) exits 99 the moment it is reached, so this test never starts any of it
function startServer(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-start-'))
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content)
  const script = `
    const path = require('path')
    const BACKEND = ${JSON.stringify(BACKEND)}
    for (const rel of ['sources/wsRelay', 'sources/discordBot', 'sources/dashboardServer', 'routes/master-api']) {
      const file = require.resolve(path.join(BACKEND, rel))
      const entry = { id: file, filename: file, loaded: true }
      Object.defineProperty(entry, 'exports', { get: () => { console.log('reached ' + rel); process.exit(99) } })
      require.cache[file] = entry
    }
    const { loadWithDataIn } = require(path.join(BACKEND, 'test', 'helpers', 'dataDir'))
    loadWithDataIn(${JSON.stringify(dir)}, ['profiles.json', 'players.json', 'sessions.json'], () => require(path.join(BACKEND, 'sources', 'storeCheck')))
    require(path.join(BACKEND, 'server.js'))`
  const env = { ...process.env, PORT: '0' }
  delete env.NODE_TEST_CONTEXT
  const run = childProcess.spawnSync(process.execPath, ['-e', script], { cwd: dir, env, encoding: 'utf8', timeout: 30000 })
  fs.rmSync(dir, { recursive: true, force: true })
  return run
}

test('node server.js on an unreadable store exits 1 before it starts anything, and on good stores goes on to start the relay', () => {
  const bad = startServer({ ...GOOD, 'profiles.json': '' })
  assert.equal(bad.status, 1, bad.stderr)
  assert.match(bad.stderr, /FAIL CLOSED, backend not started: .*profiles\.json is not valid JSON/)
  assert.doesNotMatch(bad.stdout, /reached/)
  const good = startServer(GOOD)
  assert.equal(good.status, 99, good.stderr)
  assert.match(good.stdout, /reached sources\/wsRelay/)
})
