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
const { postReport, tagIds } = require('../sources/discord/errorReport')

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
