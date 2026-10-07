'use strict'
// download: resume after a cut, wait in the 503 queue, follow redirects, refuse a 404, against a local http server.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { download, HttpError } = require('../src/download')

const BODY = Buffer.from('x'.repeat(50_000) + 'END')
function serve(handler) {
  return new Promise(resolve => {
    const srv = http.createServer(handler)
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }))
  })
}
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbo-dl-')), 'file.bin')
const noWait = { wait: async () => {} }

test('a cut download resumes with Range and the file comes out whole', async () => {
  let calls = 0
  const ranges = []
  const { srv, base } = await serve((req, res) => {
    calls++
    const m = /bytes=(\d+)-/.exec(req.headers.range || '')
    ranges.push(m ? Number(m[1]) : 0)
    if (!m) {
      res.writeHead(200, { 'Content-Length': BODY.length })
      res.write(BODY.subarray(0, 20_000))
      setTimeout(() => res.destroy(), 20)
      return
    }
    const from = Number(m[1])
    res.writeHead(206, { 'Content-Length': BODY.length - from, 'Content-Range': `bytes ${from}-${BODY.length - 1}/${BODY.length}` })
    res.end(BODY.subarray(from))
  })
  const dest = tmp()
  await download(`${base}/zip`, dest, noWait)
  srv.close()
  assert.ok(fs.readFileSync(dest).equals(BODY))
  assert.ok(calls >= 2 && ranges[ranges.length - 1] > 0, JSON.stringify(ranges))
  assert.ok(!fs.existsSync(`${dest}.part`))
})

test('a 503 with Retry-After waits in line, then downloads', async () => {
  let calls = 0
  const waits = []
  const { srv, base } = await serve((req, res) => {
    if (++calls < 3) { res.writeHead(503, { 'Retry-After': '30' }); return res.end() }
    res.writeHead(200, { 'Content-Length': BODY.length }); res.end(BODY)
  })
  const dest = tmp()
  await download(`${base}/zip`, dest, { wait: async () => {}, onQueued: (s, total) => waits.push([s, total]) })
  srv.close()
  assert.deepStrictEqual(waits, [[30, 30], [30, 60]])
  assert.ok(fs.readFileSync(dest).equals(BODY))
})

test('a redirect is followed with the same headers, and a 404 fails without leaving a part file', async () => {
  const seen = []
  const { srv, base } = await serve((req, res) => {
    seen.push([req.url, req.headers['x-dbo-accept-redirect'] || ''])
    if (req.url === '/zip') { res.writeHead(302, { Location: '/r2/client.zip' }); return res.end() }
    if (req.url === '/r2/client.zip') { res.writeHead(200, { 'Content-Length': BODY.length }); return res.end(BODY) }
    res.writeHead(404); res.end()
  })
  const dest = tmp()
  await download(`${base}/zip`, dest, { ...noWait, headers: { 'X-DBO-Accept-Redirect': '1' } })
  assert.deepStrictEqual(seen, [['/zip', '1'], ['/r2/client.zip', '1']])
  assert.ok(fs.readFileSync(dest).equals(BODY))
  const missing = tmp()
  await assert.rejects(download(`${base}/nope`, missing, noWait), (err) => err instanceof HttpError && err.statusCode === 404)
  srv.close()
  assert.ok(!fs.existsSync(`${missing}.part`) && !fs.existsSync(missing))
})

test('a busy server past the queue limit gives up with a clear message', async () => {
  const { srv, base } = await serve((req, res) => { res.writeHead(503, { 'Retry-After': '60' }); res.end() })
  await assert.rejects(download(`${base}/zip`, tmp(), { ...noWait, maxQueueSeconds: 100 }), /stayed busy/)
  srv.close()
})
