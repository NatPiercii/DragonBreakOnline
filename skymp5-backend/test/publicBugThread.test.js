'use strict'
// A launcher report opens a short thread in the PUBLIC bug forum as well as the staff one. The property that matters
// is what the public thread does NOT carry: no logs, no screenshot, no versions, no install path - only what the
// player typed. Discord is stubbed at https.request, as in errorReport.test.js.
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('events')
const https = require('https')

const STAFF = '1551740319974821949'
const PUBLIC = '1551936720713416755'

const config = require.resolve('../config')
require.cache[config] = {
  id: config, filename: config, loaded: true,
  exports: { discordErrorForumChannelId: STAFF, discordBugForumChannelId: PUBLIC, discordBotToken: 'test-token',
             discordGuildId: '1494109013300744312' },
}

let sent = []
https.request = (opts, onResponse) => {
  const req = new EventEmitter()
  const chunks = []
  req.write = c => chunks.push(Buffer.from(c))
  req.destroy = err => req.emit('error', err)
  req.end = () => {
    const body = Buffer.concat(chunks).toString()
    const json = body.match(/name="payload_json"[^\n]*\n[^\n]*\r\n\r\n(.*?)\r\n--/s)
    // A thread is posted as multipart; an edit is a plain JSON body
    let payload = json ? JSON.parse(json[1]) : null
    if (!payload && body) { try { payload = JSON.parse(body) } catch { payload = null } }
    sent.push({ method: opts.method, path: opts.path, body, payload })
    setImmediate(() => {
      const res = new EventEmitter()
      res.statusCode = 200
      onResponse(res)
      res.emit('data', JSON.stringify({ id: 'T1' }))
      res.emit('end')
      req.emit('close')
    })
  }
  return req
}
const { postReport, postPublicReport } = require('../sources/discord/errorReport')

test.beforeEach(() => { sent = [] })

test('the public thread goes to the public forum, and carries no attachments', async () => {
  const id = await postPublicReport({ title: 'Tester', summary: 'the door ate me' })
  assert.strictEqual(id, 'T1')
  assert.strictEqual(sent.length, 1)
  assert.ok(sent[0].path.includes(PUBLIC), `posted to ${sent[0].path}`)
  assert.ok(!sent[0].path.includes(STAFF), 'it must not go to the staff forum')
  assert.strictEqual(sent[0].payload.message.attachments, undefined)
  assert.ok(!/filename=/.test(sent[0].body), 'no file part may be sent')
})

test('nobody is pinged by it', async () => {
  await postPublicReport({ title: 'Tester', summary: 'Discord <@123456789012345>' })
  assert.deepStrictEqual(sent[0].payload.message.allowed_mentions, { parse: [] })
})

test('the logs still go to the staff forum, with their files', async () => {
  await postReport({ title: 'Tester', summary: 'hi', files: [{ name: 'launcher.log', text: 'C:\\Users\\someone' }] })
  assert.ok(sent[0].path.includes(STAFF), `posted to ${sent[0].path}`)
  assert.deepStrictEqual(sent[0].payload.message.attachments, [{ id: 0, filename: 'launcher.log' }])
})

test('with no public forum configured, nothing is posted publicly at all', async () => {
  const saved = require('../config').discordBugForumChannelId
  require('../config').discordBugForumChannelId = ''
  try {
    assert.strictEqual(await postPublicReport({ title: 'Tester', summary: 'hi' }), null)
    assert.strictEqual(sent.length, 0)
  } finally {
    require('../config').discordBugForumChannelId = saved
  }
})

test('a long description is cut to fit one message', async () => {
  await postPublicReport({ title: 'Tester', summary: 'x'.repeat(5000) })
  assert.ok(sent[0].payload.message.content.length <= 1900, `${sent[0].payload.message.content.length} chars`)
})

test('the thread title is cut to what Discord accepts', async () => {
  await postPublicReport({ title: 'N'.repeat(300), summary: 'hi' })
  assert.ok(sent[0].payload.name.length <= 100, `${sent[0].payload.name.length} chars`)
})

// The whole path, not just the posters. The first version of this change referenced publicLines and
// postPublicReport without defining or importing either: node --check passes on that, the poster tests passed on
// that, and only a real submit() would have caught it. So these drive submit().
const { submit } = require('../sources/problemReport')

const reporter = { name: 'Tester', discordId: '123456789012345', profileId: 30 }
const bodyOf = extra => ({ source: 'launcher', launcherVersion: '2.1.34', note: 'the door ate me', ...extra })
const staffPost = () => sent.find(s => s.method === 'POST' && s.path.includes(STAFF))
const publicPost = () => sent.find(s => s.method === 'POST' && s.path.includes(PUBLIC))
const starterEdit = () => sent.find(s => s.method === 'PATCH')

test('a report files the staff thread and a public one, and does not throw', async () => {
  const res = await submit(reporter, bodyOf({ reportId: 'r-1' }))
  assert.strictEqual(res.status, 200, JSON.stringify(res.json))
  assert.ok(staffPost(), 'the staff thread must be filed')
  assert.ok(publicPost(), 'the public thread must be opened')
})

test('the public post carries the note but never the machine or the logs', async () => {
  await submit(reporter, bodyOf({ reportId: 'r-2', note: 'crash at D:\\SteamLibrary\\Skyrim after emailing me@x.com', installDir: 'D:\\SteamLibrary\\Skyrim' }))
  const content = publicPost().payload.message.content
  assert.ok(content.includes('crash at'), content)
  assert.ok(!content.includes('SteamLibrary'), `the path leaked: ${content}`)
  assert.ok(!content.includes('me@x.com'), `the address leaked: ${content}`)
  assert.ok(!/installDir/.test(content), `the install path leaked: ${content}`)
})

test('"keep it private" opens no public thread at all', async () => {
  const res = await submit(reporter, bodyOf({ reportId: 'r-3', private: true }))
  assert.strictEqual(res.status, 200)
  assert.ok(staffPost(), 'the staff thread is still filed')
  assert.strictEqual(publicPost(), undefined, 'nothing may be posted publicly')
})

test('the staff starter post is given the public thread link', async () => {
  await submit(reporter, bodyOf({ reportId: 'r-4' }))
  const edit = starterEdit()
  assert.ok(edit, 'the starter post should be edited')
  assert.ok(/Public thread: https:\/\/discord\.com\/channels\//.test(edit.payload.content), edit.payload.content)
})

// Consent gate: a public thread may only be opened for a report that came from something which warned the player
// first. The launcher does that from 2.1.34; everything older, and every other way in, stays staff-only.
test('a 2.1.33 launcher gets no public thread: it never showed the notice', async () => {
  await submit(reporter, bodyOf({ reportId: 'v-1', launcherVersion: '2.1.33' }))
  assert.ok(staffPost(), 'the staff thread is still filed')
  assert.strictEqual(publicPost(), undefined)
})

test('2.1.34 with private false does open one', async () => {
  await submit(reporter, bodyOf({ reportId: 'v-2', launcherVersion: '2.1.34', private: false }))
  assert.ok(publicPost(), 'it should be public')
})

test('2.1.34 with private true does not', async () => {
  await submit(reporter, bodyOf({ reportId: 'v-3', launcherVersion: '2.1.34', private: true }))
  assert.ok(staffPost())
  assert.strictEqual(publicPost(), undefined)
})

test('no version at all gets no public thread', async () => {
  await submit(reporter, bodyOf({ reportId: 'v-4', launcherVersion: undefined }))
  assert.strictEqual(publicPost(), undefined)
})

test('2.1.9 is older than 2.1.34, not newer', async () => {
  await submit(reporter, bodyOf({ reportId: 'v-5', launcherVersion: '2.1.9' }))
  assert.strictEqual(publicPost(), undefined, 'string comparison would have called this newer')
})

test('a later launcher still opens one', async () => {
  await submit(reporter, bodyOf({ reportId: 'v-6', launcherVersion: '2.2.0' }))
  assert.ok(publicPost())
})

test('an in-game /bug stays staff-only, however new the launcher is', async () => {
  await submit(reporter, bodyOf({ reportId: 'v-7', source: 'game', launcherVersion: '2.2.0' }))
  assert.ok(staffPost())
  assert.strictEqual(publicPost(), undefined, 'the in-game reporter shows no notice')
})

test('a website report stays staff-only too', async () => {
  await submit(reporter, bodyOf({ reportId: 'v-8', source: 'site', launcherVersion: '2.2.0' }))
  assert.strictEqual(publicPost(), undefined)
})
