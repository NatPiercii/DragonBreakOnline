'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

// The note is kept in a temporary file and the Discord poster is replaced, so nothing real is touched
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-ends-'))
process.env.SESSION_ENDS_FILE = path.join(dir, 'session-ends.jsonl')
const file = require.resolve('../config')
require.cache[file] = { id: file, filename: file, loaded: true, exports: { discordBotToken: '' } }
const { parse, describe, submit, FILE, POST_BUDGET, POST_WINDOW } = require('../sources/sessionEnds')

const now = Date.now()
const good = { outcome: 'crash', exitCode: 0xC0000005, crashLog: true, startedAt: now - 3 * 3600e3 - 7 * 60e3, endedAt: now - 60e3, launcherVersion: '2.1.33', filesVersion: '0.3.56' }
const reporter = { name: 'dunthril', verified: true, profileId: 7, discordId: '457340616230174740' }

test('the record goes to the test file, not data/', () => {
  assert.strictEqual(FILE, process.env.SESSION_ENDS_FILE)
})

test('a well-formed note is accepted as it is', () => {
  assert.deepStrictEqual(parse(good, now).note, good)
})

test('anything malformed is refused', () => {
  const bad = [
    null, [], 'crash',
    { ...good, outcome: 'crashed' },
    { ...good, exitCode: -1073741819 },
    { ...good, exitCode: 2 ** 32 },
    { ...good, exitCode: '0xC0000005' },
    { ...good, crashLog: 'yes' },
    { ...good, startedAt: now - 8 * 24 * 3600e3 },
    { ...good, endedAt: now + 3600e3 },
    { ...good, endedAt: good.startedAt - 1 },
    { ...good, launcherVersion: 'C:\\Users\\someone' },
  ]
  for (const b of bad) assert.ok(parse(b, now).error, JSON.stringify(b))
  assert.ok(parse({ ...good, exitCode: null }, now).note, 'no exit code is allowed')
})

test('fields the launcher did not mean to send are dropped', () => {
  const note = parse({ ...good, crashLogText: 'C:\\Users\\someone\\...', path: 'x' }, now).note
  assert.deepStrictEqual(Object.keys(note).sort(), Object.keys(good).sort())
})

test('the lines staff read', () => {
  assert.strictEqual(describe(good, reporter),
    `**Game crashed** (launcher): <@457340616230174740> (dunthril) at ${new Date(good.endedAt).toISOString().slice(11, 16)} UTC, after 3 h 6 min in game. Exit code 0xC0000005, Crash Logger wrote a log.`)
  assert.match(describe({ ...good, outcome: 'ended', exitCode: 1, crashLog: false }, reporter), /^\*\*Game ended abnormally\*\* .* Exit code 0x00000001, no crash log: killed, froze and closed, or closed by Windows\.$/)
  assert.match(describe({ ...good, outcome: 'closed', exitCode: 0, crashLog: false }, { ...reporter, discordId: null }), /^Game closed normally \(launcher\): dunthril at /)
  assert.match(describe({ ...good, exitCode: null, crashLog: false }, reporter), /Exit code none, no crash log\./)
})

test('a crash and an abnormal end are posted, a normal close is only kept; every note is kept', async () => {
  const posted = []
  const post = async (line) => { posted.push(line); return true }
  assert.strictEqual((await submit(reporter, good, post)).status, 200)
  assert.strictEqual((await submit(reporter, { ...good, outcome: 'closed', exitCode: 0, crashLog: false }, post)).status, 200)
  assert.strictEqual((await submit(reporter, { ...good, outcome: 'ended', exitCode: 1, crashLog: false }, post)).status, 200)
  assert.strictEqual((await submit(reporter, { ...good, outcome: 'nope' }, post)).status, 400)
  assert.strictEqual(posted.length, 2)
  const kept = fs.readFileSync(FILE, 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepStrictEqual(kept.map(k => k.outcome), ['crash', 'closed', 'ended'])
  assert.strictEqual(kept[0].discordId, reporter.discordId)
  assert.strictEqual(fs.statSync(FILE).mode & 0o777, 0o600)
})

test('a Discord name cannot render markdown or a masked link in the monitor line', () => {
  const line = describe(good, { ...reporter, name: '[Staff notice](https://evil.example) @everyone **x**' })
  assert.ok(!line.includes('[Staff notice](https://'), line)
  assert.ok(line.includes('\\[Staff notice\\]\\(https\\://evil.example\\) @everyone \\*\\*x\\*\\*'), line)
  assert.match(describe(good, { ...reporter, name: '\u202eevil\n' }), /\(evil\)/)
})

test('past the overall budget a note is kept but not posted, and the budget comes back after the window', async () => {
  const posted = []
  const post = async (line) => { posted.push(line); return true }
  // well after the earlier test's posts, so they have left the window
  const t0 = now + 2 * POST_WINDOW
  const at = (t) => ({ ...good, startedAt: t - 3600e3, endedAt: t - 60e3 })
  const before = fs.readFileSync(FILE, 'utf8').trim().split('\n').length
  for (let i = 0; i < POST_BUDGET + 5; i++) assert.strictEqual((await submit({ ...reporter, profileId: 100 + i }, at(t0), post, t0 + i)).status, 200)
  assert.strictEqual(posted.length, POST_BUDGET)
  assert.strictEqual(fs.readFileSync(FILE, 'utf8').trim().split('\n').length - before, POST_BUDGET + 5, 'every note is still kept')
  const later = t0 + POST_WINDOW + 60e3
  await submit(reporter, at(later), post, later)
  assert.strictEqual(posted.length, POST_BUDGET + 1)
})

test.after(() => fs.rmSync(dir, { recursive: true, force: true }))
