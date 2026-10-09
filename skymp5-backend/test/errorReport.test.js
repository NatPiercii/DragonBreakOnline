'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('events')
const fs = require('fs')
const https = require('https')
const os = require('os')
const path = require('path')

// Discord is stubbed at https.request: each call takes the next queued answer and records what was sent
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbo-error-report-'))
const tagsFile = path.join(dir, 'bug-tags.json')
const id = n => `1554${String(n).padStart(15, '0')}`
const config = require.resolve('../config')
require.cache[config] = { id: config, filename: config, loaded: true,
  exports: { discordErrorForumChannelId: id(555), discordBotToken: 'test-token', bugTagsFile: tagsFile } }

let answers = []
let sent = []
https.request = (opts, onResponse) => {
  const req = new EventEmitter()
  const chunks = []
  req.write = c => chunks.push(Buffer.from(c))
  req.destroy = err => req.emit('error', err)
  req.end = () => {
    const body = Buffer.concat(chunks).toString()
    const json = body.match(/name="payload_json"[^\n]*\n[^\n]*\r\n\r\n(.*?)\r\n--/s)
    sent.push({ method: opts.method, path: opts.path, payload: json ? JSON.parse(json[1]) : null })
    const [status, reply] = answers.shift() || [200, { id: 'T1' }]
    setImmediate(() => {
      const res = new EventEmitter()
      res.statusCode = status
      onResponse(res)
      res.emit('data', typeof reply === 'string' ? reply : JSON.stringify(reply))
      res.emit('end')
      req.emit('close')
    })
  }
  return req
}
const { postReport, postBugLogs, tagIds } = require('../sources/discord/errorReport')

const report = tags => postReport({ title: 'Tester', summary: 'hi', files: [{ name: 'launcher.log', text: 'x' }], tags })
test.beforeEach(() => { answers = []; sent = []; fs.rmSync(tagsFile, { force: true }) })
test.after(() => fs.rmSync(dir, { recursive: true, force: true }))

test('a launcher report carries the Manual and Launcher tags from the tag map', async () => {
  fs.writeFileSync(tagsFile, JSON.stringify({ Manual: id(101), Launcher: id(102), 'In-game /bug': id(103) }))
  assert.strictEqual(await report(['Manual', 'Launcher']), 'T1')
  assert.strictEqual(sent.length, 1)
  assert.deepStrictEqual(sent[0].payload.applied_tags, [id(101), id(102)])
})

test('a website report carries Manual only', async () => {
  fs.writeFileSync(tagsFile, JSON.stringify({ Manual: id(101), Launcher: id(102) }))
  await report(['Manual'])
  assert.deepStrictEqual(sent[0].payload.applied_tags, [id(101)])
})

test('without the tag map, or with a broken one, the report goes untagged as before', async () => {
  await report(['Manual', 'Launcher'])
  assert.strictEqual('applied_tags' in sent[0].payload, false)
  fs.writeFileSync(tagsFile, '{not json')
  assert.deepStrictEqual(tagIds(['Manual']), [])
  fs.writeFileSync(tagsFile, JSON.stringify({ Manual: 101, Launcher: 'abc' }))
  assert.deepStrictEqual(tagIds(['Manual', 'Launcher']), [])
})

test('stale tag ids are replaced by the forum tags of the same names', async () => {
  fs.writeFileSync(tagsFile, JSON.stringify({ Manual: id(901), Launcher: id(902) }))
  answers = [[400, { message: 'Invalid Form Body', errors: { applied_tags: { _errors: [{ message: 'Unknown tag' }] } } }],
             [200, { flags: 0, available_tags: [{ id: id(7), name: 'Launcher' }, { id: id(8), name: 'Manual' }] }],
             [200, { id: 'T2' }]]
  assert.strictEqual(await report(['Manual', 'Launcher']), 'T2')
  assert.deepStrictEqual(sent.map(s => s.method), ['POST', 'GET', 'POST'])
  assert.deepStrictEqual(sent[2].payload.applied_tags, [id(8), id(7)])
})

test('stale tag ids on a forum without those tags retry untagged unless tags are required', async () => {
  fs.writeFileSync(tagsFile, JSON.stringify({ Manual: id(901) }))
  answers = [[400, 'applied_tags: Unknown tag'], [200, { flags: 0, available_tags: [{ id: id(5), name: 'Bug' }] }], [200, { id: 'T3' }]]
  assert.strictEqual(await report(['Manual']), 'T3')
  assert.strictEqual('applied_tags' in sent[2].payload, false)

  sent = []
  answers = [[400, 'applied_tags: Unknown tag'], [200, { flags: 16, available_tags: [{ id: id(4), name: 'Crash' }, { id: id(5), name: 'Bug' }] }], [200, { id: 'T4' }]]
  assert.strictEqual(await report(['Manual']), 'T4')
  assert.deepStrictEqual(sent[2].payload.applied_tags, [id(5)])
})

test('an untagged post refused for a missing tag picks Manual by exact name first', async () => {
  answers = [[400, 'A tag is required'],
             [200, { flags: 16, available_tags: [{ id: id(3), name: 'Bug report' }, { id: id(8), name: 'Manual' }] }],
             [200, { id: 'T5' }]]
  assert.strictEqual(await report(['Manual']), 'T5')
  assert.deepStrictEqual(sent[2].payload.applied_tags, [id(8)])
})

test('a 403 of a tagged post (a moderator-only tag) retries untagged, not with the same tags', async () => {
  fs.writeFileSync(tagsFile, JSON.stringify({ Manual: id(101), Launcher: id(102) }))
  answers = [[403, { message: 'Missing Permissions', code: 50013 }],
             [200, { flags: 0, available_tags: [{ id: id(101), name: 'Manual' }, { id: id(102), name: 'Launcher' }] }],
             [200, { id: 'T6' }]]
  assert.strictEqual(await report(['Manual', 'Launcher']), 'T6')
  assert.deepStrictEqual(sent.map(s => s.method), ['POST', 'GET', 'POST'])
  assert.strictEqual('applied_tags' in sent[2].payload, false)
})

test('a 400 that refuses ids the forum still has retries untagged', async () => {
  fs.writeFileSync(tagsFile, JSON.stringify({ Manual: id(101) }))
  answers = [[400, 'Invalid Form Body'], [200, { flags: 0, available_tags: [{ id: id(101), name: 'Manual' }] }], [200, { id: 'T7' }]]
  assert.strictEqual(await report(['Manual']), 'T7')
  assert.strictEqual('applied_tags' in sent[2].payload, false)
})

test('a tag refusal after a rate-limit wait still gets the tag fallback', async () => {
  fs.writeFileSync(tagsFile, JSON.stringify({ Manual: id(901) }))
  answers = [[429, { retry_after: 0.01 }], [400, 'applied_tags: Unknown tag'],
             [200, { flags: 0, available_tags: [{ id: id(8), name: 'Manual' }] }], [200, { id: 'T8' }]]
  assert.strictEqual(await report(['Manual']), 'T8')
  assert.deepStrictEqual(sent.map(s => s.method), ['POST', 'POST', 'GET', 'POST'])
  assert.deepStrictEqual(sent[1].payload.applied_tags, [id(901)])
  assert.deepStrictEqual(sent[3].payload.applied_tags, [id(8)])
})

test('a tagged refusal on a forum that cannot be read still retries untagged', async () => {
  fs.writeFileSync(tagsFile, JSON.stringify({ Manual: id(101) }))
  answers = [[403, 'Missing Permissions'], [403, 'Missing Access'], [200, { id: 'T9' }]]
  assert.strictEqual(await report(['Manual']), 'T9')
  assert.deepStrictEqual(sent.map(s => s.method), ['POST', 'GET', 'POST'])
  assert.strictEqual('applied_tags' in sent[2].payload, false)
})

test('an untagged post refused with 403, or with a 400 about something else, is not retried', async () => {
  for (const answer of [[403, 'Missing Access'], [400, 'Invalid Form Body: content too long'], [404, 'Unknown Channel']]) {
    sent = []
    answers = [answer]
    await assert.rejects(report(['Manual']), new RegExp(`\\(${answer[0]}\\)`))
    assert.deepStrictEqual(sent.map(s => s.method), ['POST'], String(answer[0]))
  }
})

test('a tagged post refused with 404 or 401 is not retried', async () => {
  fs.writeFileSync(tagsFile, JSON.stringify({ Manual: id(101) }))
  for (const code of [404, 401]) {
    sent = []
    answers = [[code, 'Unknown Channel']]
    await assert.rejects(report(['Manual']), new RegExp(`\\(${code}\\)`))
    assert.deepStrictEqual(sent.map(s => s.method), ['POST'], String(code))
  }
})

test('a /bug\'s logs go into the thread whose first post names its snapshot', async () => {
  require.cache[config].exports.discordGuildId = id(1)
  answers = [
    [200, { threads: [{ id: id(8), parent_id: id(555) }, { id: id(9), parent_id: id(555) }, { id: id(10), parent_id: id(999) }] }],
    [200, { content: '**Bug report** from Purr #7DJT\n\nSnapshot: `2026-10-08T21-12-20-7DJT.json` (dbo_inspect.py reads it)' }],
    [200, { id: 'M1' }],
  ]
  const thread = await postBugLogs({ snapshotFile: '2026-10-08T21-12-20-7DJT.json', title: 'Purr: logs for /bug', summary: 'logs',
    files: [{ name: 'launcher.log', text: 'x' }] })
  assert.strictEqual(thread, id(9))
  assert.strictEqual(sent[0].path, `/api/v10/guilds/${id(1)}/threads/active`)
  assert.strictEqual(sent[1].path, `/api/v10/channels/${id(9)}/messages/${id(9)}`, 'the newest thread of the forum is read first; another forum\'s is skipped')
  assert.strictEqual(sent[2].method, 'POST')
  assert.strictEqual(sent[2].path, `/api/v10/channels/${id(9)}/messages`)
  assert.deepStrictEqual(sent[2].payload.attachments, [{ id: 0, filename: 'launcher.log' }])
  assert.deepStrictEqual(sent[2].payload.allowed_mentions, { parse: [] })
})

test('a /bug whose thread is not found gets a report thread of its own', async () => {
  require.cache[config].exports.discordGuildId = id(1)
  answers = [
    [200, { threads: [{ id: id(9), parent_id: id(555) }] }],
    [200, { content: 'someone else\'s report' }],
    [200, { id: 'T7' }],
  ]
  const thread = await postBugLogs({ snapshotFile: '2026-10-08T21-12-20-7DJT.json', title: 'Purr: logs for /bug', summary: 'logs',
    files: [{ name: 'launcher.log', text: 'x' }] })
  assert.strictEqual(thread, 'T7')
  assert.strictEqual(sent[2].path, `/api/v10/channels/${id(555)}/threads`)
  assert.strictEqual(sent[2].payload.name, 'Purr: logs for /bug')
})

