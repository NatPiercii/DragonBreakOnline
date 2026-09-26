'use strict'
// Symbol archive (docs/auto-report-v1.md §5.4): archive-symbols.js, resolving against what it archived, and keeping maps and PDBs out of packages

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')
const { spawnSync } = require('child_process')

// Never read a real .env, and keep the ban and player stores out of these tests
require.cache[require.resolve('dotenv')] = { exports: { config: () => ({}) } }
for (const key of Object.keys(process.env)) if (key.startsWith('AUTO_REPORT')) delete process.env[key]
function stub(rel, exports) {
  const file = require.resolve(rel)
  require.cache[file] = { id: file, filename: file, loaded: true, exports }
}
stub('../sources/bans', { isBanned: () => null })
stub('../sources/players', { load: () => ({}) })

const config      = require('../config')
const archive     = require('../scripts/archive-symbols')
const sourceMaps  = require('../sources/sourceMaps')
const autoReport  = require('../sources/autoReport')
const errorGroups = require('../sources/errorGroups')
const { validate, checkBuild } = require('../sources/autoSchema')
const { signature } = require('../sources/autoSignature')
const { sourceMap } = require('./fixtures/auto-report/sourcemaps/fixture')

const SCRIPTS = path.join(__dirname, '..', 'scripts')
const PAYLOAD = path.join(__dirname, 'fixtures', 'auto-report', 'payloads', 'script-error-on-update.json')
const BUILD = 'a1b2c3d4e5f6.20261001T120000Z'
const FRONT_BUILD = 'a1b2c3d4e5f6-dirty.20261001T120030Z'
const UNKNOWN_BUILD = 'ffffffffffff.20261001T120000Z'
const PROBE = 12
const BUNDLE_LINES = 400
// Client bundle line -> [source, original line]
const CLIENT_LINES = {
  1: ['webpack/bootstrap', 1],
  [PROBE]: ['./src/errorSink.ts', 40],
  200: ['./src/services/remoteServer.ts', 640],
  210: ['./src/services/remoteServer.ts', 120],
}
const MSF_MAGIC = 'Microsoft C/C++ MSF 7.00\r\n\x1aDS\0\0\0'
let tmp, dirs = 0

before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-symbols-')) })
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

const fresh = name => {
  const dir = path.join(tmp, `${name}-${++dirs}`)
  fs.mkdirSync(dir)
  return dir
}
const mode = file => fs.statSync(file).mode & 0o777
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const listing = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [])

function clientBundle(lines = BUNDLE_LINES) {
  const text = Array.from({ length: lines }, (_, i) => `/* ${i + 1} */ var x${i} = ${i};`)
  text[PROBE - 1] = "function __dboStackProbe() { return new Error('__DBO_STACK_PROBE__') }"
  return `${text.join('\n')}\n`
}

// A client build output: the bundle, its map and its sidecar
function clientOutput({ bundle = clientBundle(), stamp = { build: BUILD, clientVersion: '0.3.44' } } = {}) {
  const dir = fresh('client-out')
  const file = path.join(dir, 'skymp5-client.js')
  fs.writeFileSync(file, bundle)
  const points = Object.entries(CLIENT_LINES).map(([line, [source, orig]]) => [Number(line), 1, source, orig])
  fs.writeFileSync(`${file}.map`, JSON.stringify(sourceMap('skymp5-client', points)))
  fs.writeFileSync(path.join(dir, 'skymp5-client.build.json'), JSON.stringify(stamp))
  return { dir, bundle: file, map: `${file}.map`, sidecar: path.join(dir, 'skymp5-client.build.json') }
}

// A minified front output: a banner line, then the whole bundle on line 2
function frontOutput() {
  const dir = fresh('front-out')
  const file = path.join(dir, 'build.js')
  fs.writeFileSync(file, `/*! banner */\n${'x'.repeat(5000)}\n`)
  const points = [[2, 100, './src/features/hud/hud.tsx', 12], [2, 2000, './src/features/party/PartyPanel.tsx', 48]]
  fs.writeFileSync(`${file}.map`, JSON.stringify(sourceMap('skymp5-front', points)))
  fs.writeFileSync(path.join(dir, 'build.build.json'), JSON.stringify({ build: FRONT_BUILD, clientVersion: '0.3.44' }))
  return { dir, bundle: file, map: `${file}.map` }
}

const archiveClient = (out, store, args = {}) =>
  archive.archiveBundle('client', { build: BUILD, bundle: out.bundle, map: out.map, clientVersion: '0.3.44', store, ...args })

// The on-update payload moved onto the generated bundle; shift lines as a loader that prepends lines would
function report({ build = BUILD, shift = 0 } = {}) {
  const body = JSON.parse(fs.readFileSync(PAYLOAD, 'utf8'))
  body.reportId = crypto.randomUUID()
  body.build = { client: build, front: FRONT_BUILD, probe: { line: PROBE + shift, col: 29 } }
  body.error.site = { line: 150 + shift, col: 9 }
  body.error.frames = [
    { fn: 'RemoteServer.onUpdate', line: 200 + shift, col: 31, file: null },
    { fn: null, line: 210 + shift, col: 12, file: null },
  ]
  return body
}

// Validates, runs the receipt checks and signs, as accept and the grouping queue do
async function sign(body) {
  const result = validate(body, { receivedAt: body.sentAt + 500 })
  assert.equal(result.ok, true, JSON.stringify(result.json))
  checkBuild(result, sourceMaps.meta('client', result.report.build.client))
  return signature(result.report, await sourceMaps.forReport(result.report))
}

// The GUID bytes as Windows lays them out: the first three groups little-endian
function guidBytes(text) {
  const [d1, d2, d3, d4, d5] = text.split('-')
  const b = Buffer.alloc(16)
  b.writeUInt32LE(parseInt(d1, 16), 0)
  b.writeUInt16LE(parseInt(d2, 16), 4)
  b.writeUInt16LE(parseInt(d3, 16), 6)
  Buffer.from(d4 + d5, 'hex').copy(b, 8)
  return b
}

// A minimal PE image with one section holding a CodeView (RSDS) debug record
function peImage({ guid, age = 1, timestamp = 0x66a0b0c0, pe32 = false }) {
  const b = Buffer.alloc(0x600)
  const pe = 0x40
  const opt = pe + 24
  const dirsAt = pe32 ? 96 : 112
  const optSize = dirsAt + 16 * 8
  const section = opt + optSize
  const debug = 0x400
  b.write('MZ', 0, 'latin1')
  b.writeUInt32LE(pe, 0x3c)
  b.writeUInt32LE(0x4550, pe)
  b.writeUInt16LE(pe32 ? 0x14c : 0x8664, pe + 4)
  b.writeUInt16LE(1, pe + 6)
  b.writeUInt32LE(timestamp, pe + 8)
  b.writeUInt16LE(optSize, pe + 20)
  b.writeUInt16LE(pe32 ? 0x10b : 0x20b, opt)
  b.writeUInt32LE(16, opt + dirsAt - 4)
  b.writeUInt32LE(0x1000, opt + dirsAt + 48)
  b.writeUInt32LE(28, opt + dirsAt + 52)
  b.write('.rdata', section, 'latin1')
  b.writeUInt32LE(0x200, section + 8)
  b.writeUInt32LE(0x1000, section + 12)
  b.writeUInt32LE(0x200, section + 16)
  b.writeUInt32LE(debug, section + 20)
  b.writeUInt32LE(2, debug + 12)
  b.writeUInt32LE(24 + 8, debug + 16)
  b.writeUInt32LE(0x1000 + 28, debug + 20)
  b.writeUInt32LE(debug + 28, debug + 24)
  b.write('RSDS', debug + 28, 'latin1')
  guid.copy(b, debug + 32)
  b.writeUInt32LE(age, debug + 48)
  b.write('x.pdb', debug + 52, 'latin1')
  return b
}

// A minimal MSF 7.0 PDB: superblock, two free-page-map blocks, the block map, the directory, then stream 1 (the info stream)
function pdbFile({ guid, age = 1 }) {
  const size = 512
  const b = Buffer.alloc(size * 6)
  b.write(MSF_MAGIC, 0, 'latin1')
  b.writeUInt32LE(size, 32)
  b.writeUInt32LE(1, 36)
  b.writeUInt32LE(6, 40)
  b.writeUInt32LE(16, 44)
  b.writeUInt32LE(3, 52)
  b.writeUInt32LE(4, 3 * size)
  for (const [at, value] of [[0, 2], [4, 0], [8, 28], [12, 5]]) b.writeUInt32LE(value, 4 * size + at)
  b.writeUInt32LE(20000404, 5 * size)
  b.writeUInt32LE(age, 5 * size + 8)
  guid.copy(b, 5 * size + 12)
  return b
}

const GUIDS = {
  platform: guidBytes('00112233-4455-6677-8899-AABBCCDDEEFF'),
  cef: guidBytes('0A0B0C0D-1E1F-2A2B-3C3D-4E4F5A5B6C6D'),
  other: guidBytes('99999999-8888-7777-6666-555555555555'),
}

// A DLL drop: two PDBs, their images in the package layout, a stale copy with another GUID and an unrelated DLL
function dllDrop({ platformImage = GUIDS.platform } = {}) {
  const root = fresh('drop')
  const pdbDir = path.join(root, 'pdb')
  const dllDir = path.join(root, 'client')
  const plugins = path.join(dllDir, 'Data', 'SKSE', 'Plugins')
  const runtime = path.join(dllDir, 'Data', 'Platform', 'Distribution', 'RuntimeDependencies')
  for (const dir of [pdbDir, plugins, runtime, path.join(dllDir, 'old')]) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(pdbDir, 'SkyrimPlatform.pdb'), pdbFile({ guid: GUIDS.platform, age: 3 }))
  fs.writeFileSync(path.join(pdbDir, 'SkyrimPlatformCEF.pdb'), pdbFile({ guid: GUIDS.cef }))
  fs.writeFileSync(path.join(plugins, 'SkyrimPlatform.dll'), peImage({ guid: platformImage, age: 2, timestamp: 0x66a0b0c0 }))
  fs.writeFileSync(path.join(runtime, 'SkyrimPlatformCEF.exe.hidden'), peImage({ guid: GUIDS.cef, pe32: true, timestamp: 0x11223344 }))
  fs.writeFileSync(path.join(dllDir, 'old', 'SkyrimPlatform.dll'), peImage({ guid: GUIDS.other }))
  fs.writeFileSync(path.join(runtime, 'libcef.dll'), 'not a PE image')
  return { pdbDir, dllDir, plugins, runtime }
}

test('client: the map and its meta are archived 0600 in 0700 folders, then removed from the build output', () => {
  const store = fresh('store')
  const out = clientOutput()
  const bundle = fs.readFileSync(out.bundle)
  const map = fs.readFileSync(out.map)
  const meta = archiveClient(out, store)
  assert.deepEqual(meta, {
    v: 1, kind: 'client', build: BUILD, gitSha: 'a1b2c3d4e5f6', dirty: false, builtAt: Date.UTC(2026, 9, 1, 12),
    clientVersion: '0.3.44', bundleBytes: bundle.length, bundleSha256: sha256(bundle), probeLine: PROBE,
  })
  const dir = path.join(store, 'sourcemaps', 'client')
  assert.deepEqual(listing(dir), [`${BUILD}.json`, `${BUILD}.map`])
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, `${BUILD}.json`), 'utf8')), meta)
  assert.deepEqual(fs.readFileSync(path.join(dir, `${BUILD}.map`)), map)
  assert.deepEqual([mode(path.join(store, 'sourcemaps')), mode(dir)], [0o700, 0o700])
  assert.deepEqual([mode(path.join(dir, `${BUILD}.map`)), mode(path.join(dir, `${BUILD}.json`))], [0o600, 0o600])
  assert.deepEqual(listing(out.dir), ['skymp5-client.js'])
})

test('resolver: frames of the archived build resolve to their .ts source, also when 3 lines are prepended at load', async () => {
  const store = fresh('store')
  archiveClient(clientOutput(), store)
  config.autoSourceMapDir = path.join(store, 'sourcemaps')
  const lookup = await sourceMaps.resolver('client', BUILD)
  assert.deepEqual(lookup(200, 31), { source: 'src/services/remoteServer.ts', line: 640 })
  assert.deepEqual(lookup(210, 1), { source: 'src/services/remoteServer.ts', line: 120 })
  assert.equal(lookup(201, 1), null)
  assert.equal(sourceMaps.meta('client', BUILD).probeLine, PROBE)

  const plain = await sign(report())
  assert.deepEqual(plain.frames, ['src/services/remoteServer.ts:RemoteServer.onUpdate', 'src/services/remoteServer.ts:?'])
  assert.deepEqual(plain.held, [])
  assert.equal(plain.title, '(Auto Report) TypeError in RemoteServer.onUpdate')
  const shifted = await sign(report({ shift: 3 }))
  assert.equal(shifted.canonical, plain.canonical)
  assert.equal(shifted.id, plain.id)
})

test('an unknown build is held: its frames stay unresolved and its group waits, while the archived build opens', async () => {
  const store = fresh('store')
  archiveClient(clientOutput(), store)
  config.autoSourceMapDir = path.join(store, 'sourcemaps')
  config.autoReportDir = path.join(fresh('auto'), 'data')
  const unknown = await sign(report({ build: UNKNOWN_BUILD }))
  assert.deepEqual(unknown.held, ['unknown-build'])
  assert.deepEqual(unknown.frames, ['?:RemoteServer.onUpdate', '?:?'])
  const known = await sign(report())

  for (const body of [report({ build: UNKNOWN_BUILD }), report()]) {
    const receivedAt = body.sentAt + 500
    autoReport.store(validate(body, { receivedAt }), { receivedAt, profileId: 1, launchCheck: { filesOk: true }, hwid: 'HW-1' })
  }
  await errorGroups.kick()
  assert.deepEqual([errorGroups.get(unknown.id).status, errorGroups.get(unknown.id).held], ['held', ['unknown-build']])
  assert.deepEqual([errorGroups.get(known.id).status, errorGroups.get(known.id).held], ['open', []])
})

test('front: the minified bundle is archived without a probe or client version, and columns resolve', async () => {
  const store = fresh('store')
  const out = frontOutput()
  const meta = archive.archiveBundle('front', { build: FRONT_BUILD, bundle: out.bundle, map: out.map, store })
  assert.equal(meta.dirty, true)
  assert.equal(meta.gitSha, 'a1b2c3d4e5f6')
  assert.equal('probeLine' in meta, false)
  assert.equal('clientVersion' in meta, false)
  assert.deepEqual(listing(out.dir), ['build.js'])
  config.autoSourceMapDir = path.join(store, 'sourcemaps')
  const lookup = await sourceMaps.resolver('front', FRONT_BUILD)
  assert.deepEqual(lookup(2, 2100), { source: 'src/features/party/PartyPanel.tsx', line: 48 })
  assert.deepEqual(lookup(2, 150), { source: 'src/features/hud/hud.tsx', line: 12 })
  assert.equal(lookup(1, 5), null)
})

test('client refusals leave the build output and the store as they were', () => {
  const plainMap = () => JSON.stringify(sourceMap('skymp5-client', [[1, 1, './src/a.ts', 1]]))
  const cases = [
    ['a sourceMappingURL comment', { bundle: `${clientBundle()}//# sourceMappingURL=skymp5-client.js.map\n` }, {}, /sourceMappingURL comment or an inline map/],
    ['an inline map', { bundle: `${clientBundle()}/*# sourceMappingURL=data:application/json;base64,e30= */\n` }, {}, /inline map/],
    ['a sidecar for another build', { stamp: { build: UNKNOWN_BUILD, clientVersion: '0.3.44' } }, {}, /names another build/],
    ['a sidecar for another client version', { stamp: { build: BUILD, clientVersion: '0.3.43' } }, {}, /names another client version/],
    ['a sidecar that is not JSON', {}, { sidecar: 'not json {' }, /skymp5-client\.build\.json: not valid JSON$/],
    ['no probe marker', { bundle: clientBundle().replace('__DBO_STACK_PROBE__', 'probe') }, {}, /exactly once/],
    ['the probe marker twice', { bundle: `${clientBundle()}'__DBO_STACK_PROBE__'\n` }, {}, /exactly once/],
    ['a map that is not a source map', {}, { map: '{"version":2,"mappings":""}' }, /not a source map/],
    ['a map with more lines than the bundle', { bundle: clientBundle(20) }, {}, /maps more lines than the bundle has/],
    ['a map that is not JSON', {}, { map: '{"version":3,' }, /skymp5-client\.js\.map: not valid JSON$/],
  ]
  for (const [name, output, overwrite, error] of cases) {
    const store = fresh('store')
    const out = clientOutput(output)
    if (overwrite.sidecar) fs.writeFileSync(out.sidecar, overwrite.sidecar)
    if (overwrite.map) fs.writeFileSync(out.map, overwrite.map)
    assert.throws(() => archiveClient(out, store), error, name)
    assert.deepEqual(listing(out.dir), ['skymp5-client.build.json', 'skymp5-client.js', 'skymp5-client.js.map'], name)
    assert.deepEqual(listing(store), [], name)
  }

  const store = fresh('store')
  const out = clientOutput()
  assert.throws(() => archiveClient(out, store, { build: 'not-a-build' }), /is not a build id/)
  assert.throws(() => archiveClient(out, store, { clientVersion: '0.3.44-beta' }), /is not a version/)
  assert.throws(() => archiveClient(out, store, { bundle: path.join(out.dir, 'other.js') }), /--bundle must be a skymp5-client\.js/)
  const elsewhere = path.join(fresh('elsewhere'), 'skymp5-client.js.map')
  fs.writeFileSync(elsewhere, plainMap())
  assert.throws(() => archiveClient(out, store, { map: elsewhere }), /--map must be skymp5-client\.js\.map next to the bundle/)
  const real = path.join(fresh('real'), 'real.map')
  fs.renameSync(out.map, real)
  fs.symlinkSync(real, out.map)
  assert.throws(() => archiveClient(out, store), /skymp5-client\.js\.map: is a symlink/)
  fs.rmSync(out.sidecar)
  if (spawnSync('mkfifo', [out.sidecar]).status === 0) assert.throws(() => archiveClient(out, store), /skymp5-client\.build\.json: not a regular file/)
  assert.deepEqual(listing(store), [])
  assert.ok(fs.existsSync(real))

  archiveClient(clientOutput(), store)
  const again = clientOutput()
  assert.throws(() => archiveClient(again, store), /already archived/)
  assert.deepEqual(listing(again.dir), ['skymp5-client.build.json', 'skymp5-client.js', 'skymp5-client.js.map'])
})

test('CLI: --store may only name the backend data folder; bad arguments exit 1 before anything is read', (t) => {
  const errors = t.mock.method(console, 'error', () => {})
  const store = fresh('store')
  const out = clientOutput()
  const args = ['client', '--build', BUILD, '--bundle', out.bundle, '--map', out.map, '--client-version', '0.3.44']
  assert.equal(archive.main([...args, '--store', store]), 1)
  assert.match(errors.mock.calls.at(-1).arguments[0], /--store must be \/opt\/alduinak\/skymp5-backend\/data$/)
  assert.equal(archive.main([...args, '--store', path.join(archive.STORE, '..', '..', 'skymp5-backend-other', 'data')]), 1)
  assert.equal(archive.main(['client', '--build', BUILD]), 1)
  assert.match(errors.mock.calls.at(-1).arguments[0], /missing --bundle, --map, --client-version/)
  assert.equal(archive.main([...args, '--files-version', '0.3.44', '--store', store]), 1)
  assert.match(errors.mock.calls.at(-1).arguments[0], /unexpected argument --files-version/)
  assert.equal(archive.main([...args, '--build', BUILD, '--store', store]), 1)
  assert.equal(archive.main(['everything']), 1)
  assert.match(errors.mock.calls.at(-1).arguments[0], /usage: archive-symbols\.js client\|front\|pdb/)
  assert.deepEqual(listing(store), [])
  assert.deepEqual(listing(out.dir), ['skymp5-client.build.json', 'skymp5-client.js', 'skymp5-client.js.map'])

  const run = spawnSync(process.execPath, [path.join(SCRIPTS, 'archive-symbols.js'), ...args, '--store', store], {
    cwd: tmp, encoding: 'utf8', env: { PATH: process.env.PATH },
  })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /--store must be/)
  assert.deepEqual(listing(store), [])
})

test('pdb: each PDB is archived 0600 with its image hash, PE timestamp and GUID-age; a rerun with the same images changes nothing', () => {
  const store = fresh('store')
  const drop = dllDrop()
  const platform = fs.readFileSync(path.join(drop.plugins, 'SkyrimPlatform.dll'))
  const cef = fs.readFileSync(path.join(drop.runtime, 'SkyrimPlatformCEF.exe.hidden'))
  const index = archive.archivePdbs({ filesVersion: '0.3.44', pdbDir: drop.pdbDir, dllDir: drop.dllDir, store })
  assert.deepEqual(index.files, [
    { pdb: 'SkyrimPlatform.pdb', image: 'SkyrimPlatform.dll', imageSha256: sha256(platform), imageBytes: platform.length, peTimestamp: 0x66a0b0c0, pdbGuidAge: '00112233445566778899AABBCCDDEEFF2' },
    { pdb: 'SkyrimPlatformCEF.pdb', image: 'SkyrimPlatformCEF.exe', imageSha256: sha256(cef), imageBytes: cef.length, peTimestamp: 0x11223344, pdbGuidAge: '0A0B0C0D1E1F2A2B3C3D4E4F5A5B6C6D1' },
  ])
  const dir = path.join(store, 'symbols', '0.3.44')
  assert.deepEqual(listing(path.join(store, 'symbols')), ['0.3.44'])
  assert.deepEqual(listing(dir), ['SkyrimPlatform.pdb', 'SkyrimPlatformCEF.pdb', 'index.json'])
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')), { v: 1, filesVersion: '0.3.44', archivedAt: index.archivedAt, files: index.files })
  assert.deepEqual(fs.readFileSync(path.join(dir, 'SkyrimPlatform.pdb')), fs.readFileSync(path.join(drop.pdbDir, 'SkyrimPlatform.pdb')))
  assert.deepEqual([mode(path.join(store, 'symbols')), mode(dir)], [0o700, 0o700])
  for (const name of listing(dir)) assert.equal(mode(path.join(dir, name)), 0o600, name)
  assert.equal(archive.pdbInfo(fs.readFileSync(path.join(drop.pdbDir, 'SkyrimPlatform.pdb'))).age, 3)

  const again = archive.archivePdbs({ filesVersion: '0.3.44', pdbDir: drop.pdbDir, dllDir: drop.dllDir, store })
  assert.equal(again.already, true)
  assert.equal(again.archivedAt, index.archivedAt)
  assert.deepEqual(listing(path.join(store, 'symbols')), ['0.3.44'])
  // A files version can be the git hash merge-files.js falls back to (§2.1)
  archive.archivePdbs({ filesVersion: 'f8cd789', pdbDir: drop.pdbDir, dllDir: drop.dllDir, store })
  assert.deepEqual(listing(path.join(store, 'symbols')), ['0.3.44', 'f8cd789'])
})

test('pdb: refused for a GUID no image carries, a missing image, a non-MSF file, a bad version or a version taken by other images', () => {
  const store = fresh('store')
  const cases = [
    [dllDrop({ platformImage: GUIDS.other }), {}, /SkyrimPlatform\.pdb: no image in --dll-dir carries its GUID/],
    [dllDrop(), { rm: 'runtime/SkyrimPlatformCEF.exe.hidden' }, /SkyrimPlatformCEF\.pdb: no \.dll or \.exe of that name in --dll-dir/],
    [dllDrop(), { write: ['pdbDir/SkyrimPlatform.pdb', 'Microsoft C/C++ program database 2.00\r\n'] }, /SkyrimPlatform\.pdb: not an MSF 7\.0 PDB/],
    [dllDrop(), { filesVersion: '../0.3.44' }, /--files-version \.\.\/0\.3\.44 is not a files version/],
    [dllDrop(), { filesVersion: '.hidden' }, /--files-version \.hidden is not a files version/],
    [dllDrop(), { rm: ['pdbDir/SkyrimPlatform.pdb', 'pdbDir/SkyrimPlatformCEF.pdb'] }, /no \.pdb file/],
  ]
  for (const [drop, change, error] of cases) {
    for (const rel of [].concat(change.rm || [])) {
      const [key, name] = rel.split('/')
      fs.rmSync(path.join(drop[key], name))
    }
    if (change.write) fs.writeFileSync(path.join(drop[change.write[0].split('/')[0]], change.write[0].split('/')[1]), change.write[1])
    assert.throws(() => archive.archivePdbs({ filesVersion: change.filesVersion || '0.3.44', pdbDir: drop.pdbDir, dllDir: drop.dllDir, store }), error)
    assert.deepEqual(listing(path.join(store, 'symbols')), [], String(error))
  }

  const first = dllDrop()
  archive.archivePdbs({ filesVersion: '0.3.44', pdbDir: first.pdbDir, dllDir: first.dllDir, store })
  const rebuilt = dllDrop()
  fs.writeFileSync(path.join(rebuilt.plugins, 'SkyrimPlatform.dll'), peImage({ guid: GUIDS.platform, age: 2, timestamp: 0x77000000 }))
  assert.throws(() => archive.archivePdbs({ filesVersion: '0.3.44', pdbDir: rebuilt.pdbDir, dllDir: rebuilt.dllDir, store }), /already archived from other images/)
  assert.deepEqual(listing(path.join(store, 'symbols')), ['0.3.44'])
})

test('peInfo and pdbInfo return null on truncated or foreign files', () => {
  const image = peImage({ guid: GUIDS.platform })
  assert.equal(archive.peInfo(image.subarray(0, 0x420)), null)
  assert.equal(archive.peInfo(Buffer.from('MZ')), null)
  assert.equal(archive.peInfo(Buffer.alloc(0)), null)
  const pdb = pdbFile({ guid: GUIDS.platform })
  assert.equal(archive.pdbInfo(pdb.subarray(0, 5 * 512 + 20)), null)
  assert.equal(archive.pdbInfo(pdb.subarray(0, 40)), null)
  const huge = Buffer.from(pdb)
  huge.writeUInt32LE(0xffffffff, 44)
  assert.equal(archive.pdbInfo(huge), null)
})

test('packages: populate-files and merge-files refuse any source map or PDB', async (t) => {
  const src = path.join(fresh('populate'), 'Data')
  const files = fresh('files')
  fs.mkdirSync(path.join(src, 'Platform', 'UI'), { recursive: true })
  fs.writeFileSync(path.join(src, 'Platform', 'UI', 'build.js'), 'x')
  fs.writeFileSync(path.join(src, 'Platform', 'UI', 'build.js.map'), '{}')
  const populate = () => spawnSync(process.execPath, [path.join(SCRIPTS, 'populate-files.js')], {
    cwd: tmp, encoding: 'utf8', env: { PATH: process.env.PATH, SKYMP_CLIENT_DATA: src, CLIENT_FILES_DIR: files },
  })
  const refused = populate()
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /Refusing to copy source maps or PDBs[\s\S]*Platform\/UI\/build\.js\.map/)
  assert.deepEqual(listing(files), [])
  fs.rmSync(path.join(src, 'Platform', 'UI', 'build.js.map'))
  // An inline map in a packaged bundle is refused like a map file
  fs.writeFileSync(path.join(src, 'Platform', 'UI', 'build.js'), 'x\n//# sourceMappingURL=data:application/json;base64,e30=')
  const inline = populate()
  assert.equal(inline.status, 1)
  assert.match(inline.stderr, /Refusing to copy source maps or PDBs[\s\S]*Platform\/UI\/build\.js\n/)
  fs.writeFileSync(path.join(src, 'Platform', 'UI', 'build.js'), 'x')
  assert.equal(populate().status, 0)
  assert.ok(fs.existsSync(path.join(files, 'root', 'Data', 'Platform', 'UI', 'build.js')))

  const nested = path.join(files, 'root', 'Data', 'SKSE', 'Plugins')
  fs.mkdirSync(nested, { recursive: true })
  fs.writeFileSync(path.join(nested, 'SkyrimPlatform.PDB'), 'x')
  const linked = fresh('linked')
  fs.writeFileSync(path.join(linked, 'hidden.map'), '{}')
  fs.symlinkSync(linked, path.join(files, 'root', 'linked'))
  assert.deepEqual(archive.findSymbolFiles(path.join(files, 'root')), ['Data/SKSE/Plugins/SkyrimPlatform.PDB'])
  const plugins = path.join(files, 'root', 'Data', 'Platform', 'Plugins')
  fs.mkdirSync(plugins, { recursive: true })
  fs.writeFileSync(path.join(plugins, 'skymp5-client.js'), 'x\n//@ sourceMappingURL=skymp5-client.js.map')
  fs.writeFileSync(path.join(plugins, 'build.js'), '//# sourceMappingURL=build.js.map')
  assert.deepEqual(archive.findSymbolFiles(path.join(files, 'root')).sort(),
    ['Data/Platform/Plugins/skymp5-client.js', 'Data/SKSE/Plugins/SkyrimPlatform.PDB'])

  const clientSource = path.join(__dirname, '..', 'sources', 'client')
  if (fs.existsSync(clientSource)) return t.skip('sources/client exists here, and the merge would copy all of it')
  for (const method of ['log', 'warn']) t.mock.method(console, method, () => {})
  config.clientFilesDir = files
  const { mergeSourcesIntoRoot } = require('../scripts/merge-files')
  await assert.rejects(mergeSourcesIntoRoot(),
    /refusing to package source maps or PDBs: (?=.*Data\/SKSE\/Plugins\/SkyrimPlatform\.PDB)(?=.*Data\/Platform\/Plugins\/skymp5-client\.js)/)
  assert.equal(fs.existsSync(path.join(files, config.clientZipName)), false)
})
