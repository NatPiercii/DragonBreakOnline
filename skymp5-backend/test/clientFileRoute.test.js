'use strict'
// GET /api/files/client/* (sources/clientFiles.js): only the current version, only exactly listed paths, R2 only when
// asked and listed with the same zip size, disk only with a matching .verified marker, its own per-visitor limit; the
// /version "omitExtras" switch (default off); and scripts/unpack-client.js on a tiny zip, including every failure path

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const express = require('express')
const { createR2Files } = require('../sources/r2Files')
const { createClientFiles, visitorKey, requestedPath, listSha256, FILE_ROUTE } = require('../sources/clientFiles')
const { FILES, RANGE_BODY, sha256, versionJson, makeZip, zipOf, writeVerifiedCopy } = require('./helpers/clientPackage')

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

// Cloudflare caches .js/.png/.svg/... answers that say nothing about caching, so every answer of the route says no-store
const noStore = (r, what) => assert.equal(r.headers['cache-control'], 'no-store', `${what}: ${r.status} without no-store`)

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

test('every answer says Cache-Control: no-store, so no edge cache keeps a 404 or an old copy', async () => {
  reset()
  const js = '/api/files/client/Data/Platform/Plugins/skymp5-client.js?v=0.3.82'
  noStore(await get(js), '200')
  noStore(await get(js, {}, 'HEAD'), 'HEAD')
  const part = await get(js, { range: 'bytes=0-9' })
  assert.equal(part.status, 206)
  noStore(part, '206')
  // A conditional request still gets no-store on its 304
  const etag = (await get(js)).headers.etag
  const cond = await get(js, { 'if-none-match': etag })
  assert.equal(cond.status, 304)
  noStore(cond, '304')

  // The 404s: another version, an unlisted path, a bad escape, the release window before unpack-client.js has run,
  // a listed file missing from the verified copy, and the kill switch
  for (const p of ['/api/files/client/Data/Platform/Plugins/skymp5-client.js?v=0.3.81', '/api/files/client/x.js?v=0.3.82',
    '/api/files/client/%E0%A4%A.js?v=0.3.82']) {
    const r = await get(p)
    assert.equal(r.status, 404, p)
    noStore(r, p)
  }
  fs.rmSync(path.join(cfDir, 'unpacked', '0.3.82', '.verified'))
  const window = await get(js)
  assert.equal(window.status, 404)
  noStore(window, 'not unpacked yet')
  reset()
  fs.rmSync(path.join(cfDir, 'unpacked', '0.3.82', 'Data', 'Platform', 'Plugins', 'skymp5-client.js'))
  const gone = await get(js)
  assert.equal(gone.status, 404)
  noStore(gone, 'file missing on disk')
  reset()
  put('client-files.json', { perFile: false })
  const off = await get(js)
  assert.equal(off.status, 404)
  noStore(off, 'perFile: false')
  drop('files-version.json')
  noStore(await get(js), 'no files-version.json')

  // The redirect to R2
  reset()
  put('r2.json', R2)
  const moved = await get(js, REDIRECT)
  assert.equal(moved.status, 302)
  noStore(moved, '302')
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
  noStore(over, '429')
  assert.match(over.body.toString(), /Too many file requests/)
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

test('/version is files-version.json as it is unless "omitExtras" is on', async () => {
  reset()
  put('extra-files.json', { version: 'x1', files: [
    { path: 'data/dragonbreak.esp', size: 1, sha256: 'a'.repeat(64) },
    { path: 'Data/Platform/Plugins/skymp5-client.js', size: 1, sha256: 'b'.repeat(64) },
    { path: 'Data/Only Extra.esp', size: 1, sha256: 'c'.repeat(64) },
  ] })
  const plain = JSON.parse((await get('/api/files/version')).body)
  assert.deepEqual(plain, V)

  for (const off of [{ omitExtras: false }, { omitExtras: 'true' }, { omitExtras: 1 }, '{ half']) {
    put('client-files.json', off)
    assert.deepEqual(JSON.parse((await get('/api/files/version')).body), V, JSON.stringify(off))
  }

  put('client-files.json', { omitExtras: true })
  const omitted = JSON.parse((await get('/api/files/version')).body)
  // Case-insensitive like the launcher's own check; never anything under Data/Platform or Data/SKSE
  assert.deepEqual(omitted.files.map(f => f.path), ['Data/a b [x].esp', 'Data/Platform/Plugins/skymp5-client.js', 'd3dx9_42.dll'])
  assert.equal(omitted.omittedExtras, 1)
  assert.equal(omitted.version, V.version)
  assert.equal(omitted.zipSize, V.zipSize)
  // The omitted file is still part of the package, so the per-file route still serves it
  assert.equal((await get(ESP)).status, 200)
  // Without an extra list nothing is left out
  drop('extra-files.json')
  assert.deepEqual(JSON.parse((await get('/api/files/version')).body), V)
  drop('files-version.json')
  assert.equal((await get('/api/files/version')).status, 404)
})

// scripts/unpack-client.js

const SCRIPT = path.join(__dirname, '..', 'scripts', 'unpack-client.js')
function unpack(dir, args) {
  const r = spawnSync(process.execPath, [SCRIPT, '--out', path.join(dir, 'unpacked'), '--live-version-file', path.join(dir, 'no-live.json'), '--min-free-mb', '0', ...args], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}
// A zip and its files-version.json in a fresh folder
function stage(name, version, files = FILES, entries = null) {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  const zip = path.join(dir, `${version}.zip`)
  if (entries) makeZip(zip, entries); else zipOf(zip, files)
  const vf = path.join(dir, `${version}.json`)
  fs.writeFileSync(vf, JSON.stringify(versionJson(version, files, zip)))
  return { dir, zip, vf, args: ['--zip', zip, '--version-file', vf] }
}
const listing = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [])

test('unpack-client.js unpacks, verifies every file, writes the marker last and serves it at once', async () => {
  const s = stage('unpack-ok', '0.3.90')
  const r = unpack(s.dir, s.args)
  assert.equal(r.code, 0, r.err)
  const out = path.join(s.dir, 'unpacked')
  assert.deepEqual(listing(out), ['0.3.90'])
  const dir = path.join(out, '0.3.90')
  for (const [p, b] of Object.entries(FILES)) assert.deepEqual(fs.readFileSync(path.join(dir, p)), b, p)
  const m = JSON.parse(fs.readFileSync(path.join(dir, '.verified'), 'utf8'))
  const v = JSON.parse(fs.readFileSync(s.vf, 'utf8'))
  assert.equal(m.version, '0.3.90')
  assert.equal(m.fileCount, 4)
  assert.equal(m.zipSize, v.zipSize)
  assert.equal(m.zipSha256, sha256(fs.readFileSync(s.zip)))
  assert.equal(m.listSha256, listSha256(v.files))
  assert.equal(JSON.parse(r.out.trim().split('\n').pop()).version, '0.3.90')
  assert.equal((fs.statSync(path.join(dir, 'Data', 'DragonBreak.esp')).mode & 0o777), 0o644)

  // The route serves this copy as soon as files-version.json names it
  const cf = createClientFiles({ dataDir: s.dir, clientFilesDir: s.dir })
  fs.copyFileSync(s.vf, path.join(s.dir, 'files-version.json'))
  assert.equal(cf.verifiedDir(cf.currentPackage()), dir)

  // A second run finds it done; --check and --files read it
  const again = unpack(s.dir, s.args)
  assert.equal(again.code, 0, again.err)
  assert.match(again.out, /already unpacked/)
  const check = unpack(s.dir, ['--check', '--version-file', s.vf])
  assert.equal(check.code, 0, check.err)
  assert.equal(JSON.parse(check.out).fileCount, 4)
  const list = unpack(s.dir, ['--files', '--version-file', s.vf])
  assert.equal(list.code, 0, list.err)
  assert.ok(list.out.includes(`${FILES['Data/a b [x].esp'].length}\tclient/0.3.90/files/Data/a%20b%20%5Bx%5D.esp\tData/a b [x].esp\n`))
  assert.equal(list.out.trim().split('\n').length, 4)
})

test('unpack-client.js: a file that does not match the list fails and leaves nothing half done', () => {
  const s = stage('unpack-bad', '0.3.91')
  assert.equal(unpack(s.dir, s.args).code, 0)
  const out = path.join(s.dir, 'unpacked')
  const before = fs.readFileSync(path.join(out, '0.3.91', '.verified'), 'utf8')

  // 0.3.92 whose list says one file has other bytes than the zip holds
  const bad = stage('unpack-bad', '0.3.92')
  const v = JSON.parse(fs.readFileSync(bad.vf, 'utf8'))
  v.files[1].sha256 = sha256(Buffer.from('something else'))
  fs.writeFileSync(bad.vf, JSON.stringify(v))
  const r = unpack(s.dir, bad.args)
  assert.equal(r.code, 1)
  assert.match(r.err, /Data\/a b \[x\]\.esp \(sha256/)
  assert.deepEqual(listing(out), ['0.3.91'])
  assert.equal(fs.readFileSync(path.join(out, '0.3.91', '.verified'), 'utf8'), before)
  assert.equal(unpack(s.dir, ['--check', '--version-file', bad.vf]).code, 1)

  // A size that differs fails the same way
  v.files[1].sha256 = sha256(FILES['Data/a b [x].esp'])
  v.files[0].size += 1
  fs.writeFileSync(bad.vf, JSON.stringify(v))
  const r2 = unpack(s.dir, bad.args)
  assert.equal(r2.code, 1)
  assert.match(r2.err, /DragonBreak\.esp \(size/)
  assert.deepEqual(listing(out), ['0.3.91'])
})

test('unpack-client.js refuses a zip of another release, a missing file, unsafe names and links', () => {
  const out = s => path.join(s.dir, 'unpacked')
  // The zip size files-version.json records is not this zip's
  const other = stage('unpack-size', '0.3.93')
  const v = JSON.parse(fs.readFileSync(other.vf, 'utf8'))
  fs.writeFileSync(other.vf, JSON.stringify({ ...v, zipSize: v.zipSize + 7 }))
  const r = unpack(other.dir, other.args)
  assert.equal(r.code, 1)
  assert.match(r.err, /not the same release/)
  assert.deepEqual(listing(out(other)), [])

  // A listed file the zip lacks
  const files = { ...FILES }
  const missing = stage('unpack-missing', '0.3.94', files, Object.entries(FILES).slice(1).map(([name, data]) => ({ name, data })))
  const rm = unpack(missing.dir, missing.args)
  assert.equal(rm.code, 1)
  assert.match(rm.err, /lacks 1 listed file/)
  assert.deepEqual(listing(out(missing)), [])

  // A '..' entry: refused before anything is written, and nothing lands outside
  const entries = Object.entries(FILES).map(([name, data]) => ({ name, data }))
  const dots = stage('unpack-dots', '0.3.95', FILES, [...entries, { name: '../escaped.txt', data: Buffer.from('x') }])
  const rd = unpack(dots.dir, dots.args)
  assert.equal(rd.code, 1)
  assert.match(rd.err, /not a safe path/)
  assert.equal(fs.existsSync(path.join(dots.dir, 'escaped.txt')), false)
  assert.deepEqual(listing(out(dots)), [])

  // An absolute name and a backslash name
  for (const [i, name] of ['/abs.txt', 'Data\\win.txt'].entries()) {
    const s = stage(`unpack-name-${i}`, '0.3.96', FILES, [...entries, { name, data: Buffer.from('x') }])
    const rn = unpack(s.dir, s.args)
    assert.equal(rn.code, 1, name)
    assert.deepEqual(listing(out(s)), [], name)
  }

  // A symlink, even an unlisted one
  const link = stage('unpack-link', '0.3.97', FILES, [...entries, { name: 'Data/link.esp', symlinkTo: '/etc/passwd' }])
  const rl = unpack(link.dir, link.args)
  assert.equal(rl.code, 1)
  assert.match(rl.err, /not a plain file/)
  assert.deepEqual(listing(out(link)), [])

  // --out must be the unpacked folder (old versions are deleted from it)
  const wrong = spawnSync(process.execPath, [SCRIPT, '--out', path.join(root, 'elsewhere'), ...other.args], { encoding: 'utf8' })
  assert.equal(wrong.status, 2)
})

test('unpack-client.js keeps the current version and one previous (and the live one while staging)', () => {
  const s = stage('unpack-prune', '1.0.1')
  const out = path.join(s.dir, 'unpacked')
  for (const ver of ['1.0.1', '1.0.2', '1.0.3']) {
    const st = stage('unpack-prune', ver)
    assert.equal(unpack(s.dir, st.args).code, 0, ver)
  }
  assert.deepEqual(listing(out), ['1.0.2', '1.0.3'])

  // Leftovers of an interrupted run and a stale lock of a dead process are cleared
  fs.mkdirSync(path.join(out, '.tmp-1.0.9'))
  fs.writeFileSync(path.join(out, '.lock'), '999999999')
  const st4 = stage('unpack-prune', '1.0.4')
  // Staging 1.0.4 while 1.0.2 is the live version: 1.0.2 stays, 1.0.3 goes
  const live = path.join(s.dir, 'live.json')
  fs.writeFileSync(live, JSON.stringify({ version: '1.0.2' }))
  const r = spawnSync(process.execPath, [SCRIPT, '--out', out, '--live-version-file', live, '--min-free-mb', '0', ...st4.args], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(listing(out), ['1.0.2', '1.0.4'])

  // Clearing old versions runs after the new one is in place: a failure there is a warning, not a failed run
  const logs = []
  assert.doesNotThrow(() => require(SCRIPT).prune(path.join(s.dir, 'gone', 'unpacked'), ['1.0.4'], 2, m => logs.push(m)))
  assert.match(logs.join('\n'), /WARNING: old versions not cleared/)

  // A lock held by a live process stops the run
  fs.writeFileSync(path.join(out, '.lock'), String(process.pid))
  const st5 = stage('unpack-prune', '1.0.5')
  const held = unpack(s.dir, st5.args)
  assert.equal(held.code, 1)
  assert.match(held.err, /holds/)
  fs.rmSync(path.join(out, '.lock'))
})
