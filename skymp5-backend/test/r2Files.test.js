'use strict'
// R2 redirects (sources/r2Files.js): only versions listed in data/r2.json, only listed extra files, the zip only for
// launchers that ask, and the switch reacts to r2.json without a restart

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const express = require('express')
const { createR2Files } = require('../sources/r2Files')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2files-'))
const put = (name, value) => {
  const file = path.join(dir, name)
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
  const t = new Date(Date.now() + Math.floor(Math.random() * 1e6)) // a fresh mtime each write, so the cache sees it
  fs.utimesSync(file, t, t)
}
const drop = name => { try { fs.unlinkSync(path.join(dir, name)) } catch {} }
const R2 = { enabled: true, baseUrl: 'https://files.example.com/', client: { '0.3.80': 1000 }, extra: ['v1'] }

let server, base
before(async () => {
  put('extra-files.json', { version: 'v1', files: [{ path: 'Data/a b [x].bsa' }, { path: 'Data/Sub/c.esp' }] })
  put('files-version.json', { version: '0.3.80', zipSize: 1000 })
  const r2 = createR2Files({ dataDir: dir })
  const app = express()
  app.use('/api/files/extra', r2.extraRedirect)
  app.use('/api/files/extra', (_req, res) => res.send('disk'))
  app.get('/api/files/zip', (req, res) => {
    const u = r2.clientZipUrl(req)
    if (u) return res.redirect(302, u)
    res.send('disk-zip')
  })
  server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const get = (p, headers = {}) => new Promise((resolve, reject) => {
  http.get(base + p, { headers }, res => {
    let body = ''
    res.on('data', c => { body += c })
    res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, cc: res.headers['cache-control'], body }))
  }).on('error', reject)
})
const EXTRA = '/api/files/extra/Data/a%20b%20%5Bx%5D.bsa'

test('no r2.json: everything is served from disk', async () => {
  drop('r2.json')
  assert.equal((await get(EXTRA)).body, 'disk')
  assert.equal((await get('/api/files/zip', { 'x-dbo-accept-redirect': '1' })).body, 'disk-zip')
})

test('a listed extra of a listed version goes to R2, encoded per segment, never cached', async () => {
  put('r2.json', R2)
  const r = await get(EXTRA)
  assert.equal(r.status, 302)
  assert.equal(r.location, 'https://files.example.com/extra/v1/Data/a%20b%20%5Bx%5D.bsa')
  assert.equal(r.cc, 'no-store')
  assert.equal((await get('/api/files/extra/Data/Sub/c.esp')).location, 'https://files.example.com/extra/v1/Data/Sub/c.esp')
})

test('files not in the manifest, traversal and the manifest route itself stay on disk', async () => {
  put('r2.json', R2)
  assert.equal((await get('/api/files/extra/Data/other.esp')).body, 'disk')
  assert.equal((await get('/api/files/extra/Data/..%2F..%2Fsecret')).body, 'disk')
  assert.equal((await get('/api/files/extra/Data/Sub/../c.esp')).status, 200)
  assert.equal((await get('/api/files/extra')).body, 'disk')
})

test('a list version not in the bucket, enabled false or a non-https base: disk', async () => {
  put('r2.json', { ...R2, extra: ['v0'] })
  assert.equal((await get(EXTRA)).body, 'disk')
  put('r2.json', { ...R2, enabled: false })
  assert.equal((await get(EXTRA)).body, 'disk')
  put('r2.json', { ...R2, baseUrl: 'http://files.example.com' })
  assert.equal((await get(EXTRA)).body, 'disk')
  put('r2.json', '{ half written')
  assert.equal((await get(EXTRA)).body, 'disk')
})

test('the zip goes to R2 only for a launcher that asks and only for a version in the bucket', async () => {
  put('r2.json', R2)
  assert.equal((await get('/api/files/zip')).body, 'disk-zip')
  const r = await get('/api/files/zip', { 'x-dbo-accept-redirect': '1' })
  assert.equal(r.status, 302)
  assert.equal(r.location, 'https://files.example.com/client/0.3.80/SkyMP-client.zip')
  put('files-version.json', { version: '0.3.82', zipSize: 1000 })
  assert.equal((await get('/api/files/zip', { 'x-dbo-accept-redirect': '1' })).body, 'disk-zip')
  // the same version number rebuilt (another size): disk, not the stale zip in the bucket
  put('files-version.json', { version: '0.3.80', zipSize: 2000 })
  assert.equal((await get('/api/files/zip', { 'x-dbo-accept-redirect': '1' })).body, 'disk-zip')
  put('files-version.json', { version: '0.3.80', zipSize: 1000 })
})

test('a new extra list version follows the manifest without a restart', async () => {
  put('r2.json', { ...R2, extra: ['v1', 'v2'] })
  put('extra-files.json', { version: 'v2', files: [{ path: 'Data/new.bsa' }] })
  assert.equal((await get('/api/files/extra/Data/new.bsa')).location, 'https://files.example.com/extra/v2/Data/new.bsa')
  assert.equal((await get(EXTRA)).body, 'disk')
})
