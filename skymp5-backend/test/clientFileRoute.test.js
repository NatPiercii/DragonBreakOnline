'use strict'
// GET /api/files/client/* (sources/clientFiles.js): only the current version, only exactly listed paths, R2 only when
// asked and listed with the same zip size, disk only with a matching .verified marker, its own per-visitor limit

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const express = require('express')
const { createR2Files } = require('../sources/r2Files')
const { createClientFiles, visitorKey, requestedPath, FILE_ROUTE } = require('../sources/clientFiles')
const { FILES, RANGE_BODY, versionJson, writeVerifiedCopy } = require('./helpers/clientPackage')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clientfiles-'))
const dataDir = path.join(root, 'data')
const cfDir = path.join(root, 'client-files')
fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(cfDir, { recursive: true })

const put = (name, value) => {
  const file = path.join(dataDir, name)
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
  const t = new Date(Date.now() + Math.floor(Math.random() * 1e6)) // a fresh mtime each write, so the caches see it
  fs.utimesSync(file, t, t)
}
const drop = name => { try { fs.unlinkSync(path.join(dataDir, name)) } catch {} }

const V = versionJson('0.3.82')
const R2 = { enabled: true, baseUrl: 'https://files.example.com/', client: { '0.3.82': V.zipSize }, clientFiles: { '0.3.82': V.zipSize }, extra: [] }
const ESP = '/api/files/client/Data/DragonBreak.esp?v=0.3.82'
const SPACED = '/api/files/client/Data/a%20b%20%5Bx%5D.esp?v=0.3.82'
const REDIRECT = { 'x-dbo-accept-redirect': '1' }

let server, base
before(async () => {
  put('files-version.json', V)
  const r2 = createR2Files({ dataDir })
  const cf = createClientFiles({ dataDir, clientFilesDir: cfDir, r2 })
  const limited = createClientFiles({ dataDir, clientFilesDir: cfDir, r2, limit: 3 })
  const app = express()
  const files = express.Router()
  files.get('/version', cf.versionHandler)
  files.get(FILE_ROUTE, cf.fileLimiter, cf.fileHandler)
  app.use('/api/files', files)
  const small = express.Router()
  small.get(FILE_ROUTE, limited.fileLimiter, limited.fileHandler)
  app.use('/limited', small)
  server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }) })

// The path goes out exactly as written (Node does not normalise '..' or '%2e')
const get = (p, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request(base + '/', { method, path: p, headers }, res => {
    const chunks = []
    res.on('data', c => chunks.push(c))
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, location: res.headers.location, body: Buffer.concat(chunks) }))
  })
  req.on('error', reject)
  req.end()
})

// Every test starts from: no r2.json, no switches, and a verified copy of V on disk
function reset() {
  drop('r2.json'); drop('client-files.json'); drop('extra-files.json')
  put('files-version.json', V)
  fs.rmSync(path.join(cfDir, 'unpacked'), { recursive: true, force: true })
  writeVerifiedCopy(cfDir, V)
}

test('the request path decodes one segment at a time and refuses anything but plain names', () => {
  assert.equal(requestedPath('/client/Data/a%20b%20%5Bx%5D.esp'), 'Data/a b [x].esp')
  assert.equal(requestedPath('/client/d3dx9_42.dll'), 'd3dx9_42.dll')
  for (const bad of ['/client/', '/client//x', '/client/Data/../x', '/client/Data/%2e%2e/x', '/client/Data/./x', '/client/Data%2Fx',
    '/client/Data%5Cx', '/client/Data\\x', '/client/x%00', '/client/x%0a', '/client/%E0%A4%A', '/client/x/', '/other/x', '/CLIENT/x']) {
    assert.equal(requestedPath(bad), null, bad)
  }
  // Double encoding decodes once, to a name that is simply not listed
  assert.equal(requestedPath('/client/%252e%252e/x'), '%2e%2e/x')
})

test('a listed file of the current version is served from the verified copy as octet-stream', async () => {
  reset()
  const r = await get(ESP)
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-type'], 'application/octet-stream')
  assert.equal(r.headers['accept-ranges'], 'bytes')
  assert.deepEqual(r.body, FILES['Data/DragonBreak.esp'])
  assert.deepEqual((await get(SPACED)).body, FILES['Data/a b [x].esp'])
  assert.deepEqual((await get('/api/files/client/d3dx9_42.dll?v=0.3.82')).body, FILES['d3dx9_42.dll'])
  const head = await get(ESP, {}, 'HEAD')
  assert.equal(head.status, 200)
  assert.equal(Number(head.headers['content-length']), FILES['Data/DragonBreak.esp'].length)
})

test('a version other than files-version.json, a missing v or a repeated v: 404', async () => {
  reset()
  for (const q of ['?v=0.3.81', '?v=0.3.82x', '', '?v=', '?v=0.3.82&v=0.3.82', '?v[]=0.3.82', '?V=0.3.82']) {
    const r = await get(`/api/files/client/Data/DragonBreak.esp${q}`, REDIRECT)
    assert.equal(r.status, 404, q)
    assert.equal(r.location, undefined, q)
  }
  drop('files-version.json')
  assert.equal((await get(ESP)).status, 404)
  put('files-version.json', '{ half written')
  assert.equal((await get(ESP)).status, 404)
})

test('unlisted paths, another case, traversal and encoding tricks: 404, never a redirect', async () => {
  reset()
  put('r2.json', R2)
  const attacks = [
    'Data/Nope.esp', 'data/DragonBreak.esp', 'Data/dragonbreak.esp', 'DATA/DRAGONBREAK.ESP',
    'Data/../Data/DragonBreak.esp', '../data/files-version.json', '../../client-files/unpacked/0.3.82/.verified', '.verified',
    'Data/%2e%2e/Data/DragonBreak.esp', '%2e%2e/%2e%2e/etc/passwd', 'Data%2FDragonBreak.esp', 'Data%5CDragonBreak.esp',
    'Data\\DragonBreak.esp', 'Data/DragonBreak.esp%00', 'Data/DragonBreak.esp%00.txt', 'Data/%252e%252e/DragonBreak.esp',
    'Data//DragonBreak.esp', 'Data/DragonBreak.esp/', 'Data/./DragonBreak.esp', '/Data/DragonBreak.esp', '%E0%A4%A',
    'Data/a b [x].esp'.replace(/ /g, '+'), '',
  ]
  for (const a of attacks) {
    for (const headers of [{}, REDIRECT]) {
      const r = await get(`/api/files/client/${a}?v=0.3.82`, headers)
      assert.equal(r.status, 404, a)
      assert.equal(r.location, undefined, a)
    }
  }
})

test('R2 only with X-DBO-Accept-Redirect: 1 and only for a version listed in clientFiles with the same zip size', async () => {
  reset()
  put('r2.json', R2)
  const r = await get(SPACED, REDIRECT)
  assert.equal(r.status, 302)
  assert.equal(r.location, 'https://files.example.com/client/0.3.82/files/Data/a%20b%20%5Bx%5D.esp')
  assert.equal(r.headers['cache-control'], 'no-store')
  assert.equal((await get('/api/files/client/d3dx9_42.dll?v=0.3.82', REDIRECT)).location, 'https://files.example.com/client/0.3.82/files/d3dx9_42.dll')
  // No header (or another value): the disk copy
  assert.equal((await get(SPACED)).status, 200)
  assert.equal((await get(SPACED, { 'x-dbo-accept-redirect': 'yes' })).status, 200)
  // The zip in the bucket is not the files in the bucket
  put('r2.json', { ...R2, clientFiles: {} })
  assert.equal((await get(SPACED, REDIRECT)).status, 200)
  put('r2.json', { ...R2, clientFiles: { '0.3.81': V.zipSize } })
  assert.equal((await get(SPACED, REDIRECT)).status, 200)
  // The same version number rebuilt (another zip size): disk, not the stale files in the bucket
  put('r2.json', { ...R2, clientFiles: { '0.3.82': V.zipSize + 1 } })
  assert.equal((await get(SPACED, REDIRECT)).status, 200)
  put('r2.json', { ...R2, clientFiles: ['0.3.82'] })
  assert.equal((await get(SPACED, REDIRECT)).status, 200)
  put('r2.json', { ...R2, enabled: false })
  assert.equal((await get(SPACED, REDIRECT)).status, 200)
  put('r2.json', { ...R2, baseUrl: 'http://files.example.com' })
  assert.equal((await get(SPACED, REDIRECT)).status, 200)
  // Listed in the bucket but nothing on disk: still redirected; neither: 404 so the launcher uses the zip
  put('r2.json', R2)
  fs.rmSync(path.join(cfDir, 'unpacked'), { recursive: true, force: true })
  assert.equal((await get(SPACED, REDIRECT)).status, 302)
  assert.equal((await get(SPACED)).status, 404)
})

test('disk only with a .verified marker for exactly this version and file list; Range gives 206', async () => {
  reset()
  const marker = path.join(cfDir, 'unpacked', '0.3.82', '.verified')
  const good = fs.readFileSync(marker, 'utf8')
  const rewrite = obj => {
    fs.writeFileSync(marker, typeof obj === 'string' ? obj : JSON.stringify(obj))
    const t = new Date(Date.now() + Math.floor(Math.random() * 1e6))
    fs.utimesSync(marker, t, t)
  }
  for (const bad of [{ ...JSON.parse(good), version: '0.3.81' }, { ...JSON.parse(good), listSha256: '0'.repeat(64) },
    { ...JSON.parse(good), fileCount: 3 }, { ...JSON.parse(good), listSha256: undefined }, '{ half', '']) {
    rewrite(bad)
    assert.equal((await get(ESP)).status, 404, JSON.stringify(bad))
  }
  fs.rmSync(marker)
  assert.equal((await get(ESP)).status, 404)
  rewrite(good)
  assert.equal((await get(ESP)).status, 200)

  const js = '/api/files/client/Data/Platform/Plugins/skymp5-client.js?v=0.3.82'
  const r = await get(js, { range: 'bytes=100-199' })
  assert.equal(r.status, 206)
  assert.equal(r.headers['content-range'], `bytes 100-199/${RANGE_BODY.length}`)
  assert.deepEqual(r.body, RANGE_BODY.subarray(100, 200))
  // The launcher resumes a part with an open range
  const tail = await get(js, { range: 'bytes=990-' })
  assert.equal(tail.status, 206)
  assert.deepEqual(tail.body, RANGE_BODY.subarray(990))

  // The same version number with another file list (a rebuild): the old copy no longer counts
  const rebuilt = versionJson('0.3.82', { ...FILES, 'Data/DragonBreak.esp': Buffer.from('rebuilt') })
  put('files-version.json', rebuilt)
  assert.equal((await get(ESP)).status, 404)
  put('files-version.json', V)
  assert.equal((await get(ESP)).status, 200)
})

test('data/client-files.json "perFile": false turns the route off; anything else leaves it on', async () => {
  reset()
  put('r2.json', R2)
  put('client-files.json', { perFile: false })
  assert.equal((await get(ESP)).status, 404)
  assert.equal((await get(ESP, REDIRECT)).status, 404)
  put('client-files.json', { perFile: 'no' })
  assert.equal((await get(ESP)).status, 200)
  put('client-files.json', '{ half')
  assert.equal((await get(ESP)).status, 200)
})

test('the limiter counts per Cloudflare visitor, like the zip limiter', async () => {
  reset()
  const p = '/limited/client/Data/DragonBreak.esp?v=0.3.82'
  const a = { 'cf-connecting-ip': '203.0.113.5' }
  for (let i = 0; i < 3; i++) assert.equal((await get(p, a)).status, 200)
  const over = await get(p, a)
  assert.equal(over.status, 429)
  // Probes of unlisted paths count too
  assert.equal((await get('/limited/client/x?v=0.3.82', a)).status, 429)
  assert.equal((await get(p, { 'cf-connecting-ip': '203.0.113.6' })).status, 200)
  // The main instance has its own (much larger) count
  assert.equal((await get(ESP, a)).status, 200)

  const req = (cf, ip = '10.0.0.1') => ({ ip, get: h => (h.toLowerCase() === 'cf-connecting-ip' ? cf : undefined) })
  assert.equal(visitorKey(req('203.0.113.5')), '203.0.113.5')
  assert.equal(visitorKey(req(undefined, '10.0.0.9')), '10.0.0.9')
  assert.equal(visitorKey(req('not an ip', '10.0.0.9')), '10.0.0.9')
  // One IPv6 visitor is one /56, as express-rate-limit's ipKeyGenerator groups it
  assert.equal(visitorKey(req('2001:db8:0:1::1')), visitorKey(req('2001:db8:0:2::9')))
  assert.notEqual(visitorKey(req('2001:db8:0:100::1')), visitorKey(req('2001:db8:0:1::1')))
})
