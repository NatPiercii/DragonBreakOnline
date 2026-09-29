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
  exports: { discordErrorForumChannelId: STAFF, discordBugForumChannelId: PUBLIC, discordBotToken: 'test-token' },
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
    sent.push({ method: opts.method, path: opts.path, body, payload: json ? JSON.parse(json[1]) : null })
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
