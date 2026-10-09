'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

// The logs of an in-game /bug: pending per profile, sent once, filed into the /bug's own thread
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug-logs-'))
process.env.DBO_BUG_DIR = path.join(dir, 'bugs')
process.env.DBO_BUG_LOGS_STATE = path.join(dir, 'state.json')
fs.mkdirSync(process.env.DBO_BUG_DIR)
const snap = (id, profileId, ageMs = 0) => {
  const file = path.join(process.env.DBO_BUG_DIR, `${id}.json`)
  fs.writeFileSync(file, JSON.stringify({ at: '2026-10-08T21:12:20.954Z', by: 'Purr #7DJT', profileId, text: 'x' }))
  const t = (Date.now() - ageMs) / 1000
  fs.utimesSync(file, t, t)
}
snap('2026-10-08T21-12-20-7DJT', 5)
snap('2026-10-08T21-15-00-7DJT', 5)
snap('2026-10-08T21-13-00-AAAA', 9)
snap('2026-10-08T18-00-00-7DJT', 5, 3 * 60 * 60 * 1000)
fs.writeFileSync(path.join(process.env.DBO_BUG_DIR, 'not-a-snapshot.json'), '{}')

const stub = (rel, exports) => {
  const file = require.resolve(rel)
  require.cache[file] = { id: file, filename: file, loaded: true, exports }
}
stub('../config', { discordErrorForumChannelId: '1' })
const posted = []
stub('../sources/discord/errorReport', {
  postReport: async (r) => { posted.push({ kind: 'report', ...r }); return 'NEW' },
  postBugLogs: async (r) => { posted.push({ kind: 'bug', ...r }); return 'BUGTHREAD' },
})
stub('../sources/discord/audit', { log: () => {} })
const bugLogs = require('../sources/bugLogs')
const { submit } = require('../sources/problemReport')
const me = { name: 'Purr', verified: true, profileId: 5 }

test('a profile sees its own recent /bug reports, newest first, and nobody else\'s', () => {
  assert.deepStrictEqual(bugLogs.pendingFor(5).map(p => p.id), ['2026-10-08T21-15-00-7DJT', '2026-10-08T21-12-20-7DJT'])
  assert.deepStrictEqual(bugLogs.pendingFor(9).map(p => p.id), ['2026-10-08T21-13-00-AAAA'])
  assert.deepStrictEqual(bugLogs.pendingFor(7), [])
  assert.deepStrictEqual(bugLogs.pendingFor(-1), [])
})

test('the launcher\'s logs for a pending /bug go to that /bug\'s thread, once', async () => {
  const id = '2026-10-08T21-12-20-7DJT'
  const r = await submit(me, { reportId: 'bug-2026-10-08T21-12-20-7DJT', bugId: id, launcherLog: 'starting', gameLog: 'boot' })
  assert.strictEqual(r.status, 200)
  assert.strictEqual(posted.length, 1)
  assert.strictEqual(posted[0].kind, 'bug')
  assert.strictEqual(posted[0].snapshotFile, `${id}.json`)
  assert.ok(posted[0].files.some(f => f.name === 'launcher.log') && posted[0].files.some(f => f.name === 'skyrim-platform.log'))
  assert.match(posted[0].summary, /in-game \/bug/)
  assert.ok(!bugLogs.pendingFor(5).some(p => p.id === id), 'no longer pending')
  const again = await submit(me, { reportId: 'bug-2026-10-08T21-12-20-7DJT-b', bugId: id, launcherLog: 'starting' })
  assert.strictEqual(again.status, 404)
})

test('another profile\'s /bug, an unknown id or an unsigned sender is refused, and nothing is posted', async () => {
  posted.length = 0
  for (const [who, bugId] of [[me, '2026-10-08T21-13-00-AAAA'], [me, '2026-10-08T00-00-00-ZZZZ'], [me, '../etc/passwd'],
    [{ ...me, verified: false }, '2026-10-08T21-15-00-7DJT']]) {
    const r = await submit(who, { reportId: `bug-refused-${posted.length}-x`, bugId, launcherLog: 'x' })
    assert.strictEqual(r.status, 404)
  }
  assert.strictEqual(posted.length, 0)
})

test('a report without bugId is filed as before', async () => {
  posted.length = 0
  const r = await submit(me, { reportId: 'plain-report-0001', launcherLog: 'x' })
  assert.strictEqual(r.status, 200)
  assert.strictEqual(posted[0].kind, 'report')
})
