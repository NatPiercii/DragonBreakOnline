'use strict'
// Signatures (§6, design §4.2): the golden cases, normMsg, numeric versions, the receipt checks and the source-map store

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { performance } = require('perf_hooks')

// Never read a real .env
require.cache[require.resolve('dotenv')] = { exports: { config: () => ({}) } }
for (const key of Object.keys(process.env)) if (key.startsWith('AUTO_REPORT')) delete process.env[key]

const config = require('../config')
const { validate, checkBuild } = require('../sources/autoSchema')
const sourceMaps = require('../sources/sourceMaps')
const { signature, normMsg, compareVersions } = require('../sources/autoSignature')
const { writeFixtureMaps, CLIENT_BUILD } = require('./fixtures/auto-report/sourcemaps/fixture')

const FIXTURES = path.join(__dirname, 'fixtures', 'auto-report')
const GOLDEN = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'signature-cases.json'), 'utf8'))
let tmp, maps

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-sig-'))
  maps = path.join(tmp, 'sourcemaps')
  writeFixtureMaps(maps)
})
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

const load = name => JSON.parse(fs.readFileSync(path.join(FIXTURES, 'payloads', `${name}.json`), 'utf8'))
// Objects merge, arrays and values replace
function merge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object') merge(target[key], value)
    else target[key] = value
  }
  return target
}

// Validates, runs the receipt checks and signs, as accept and the grouping queue do
async function sign(body, { mapDir = maps } = {}) {
  config.autoSourceMapDir = mapDir
  const result = validate(body, { receivedAt: body.sentAt + 500 })
  assert.equal(result.ok, true, JSON.stringify(result.json))
  checkBuild(result, sourceMaps.meta('client', result.report.build && result.report.build.client))
  return { result, sig: signature(result.report, await sourceMaps.forReport(result.report)) }
}
const noMaps = () => path.join(tmp, 'none')

test('normMsg golden cases, applied in the §6 order', () => {
  for (const [input, expected] of GOLDEN.normMsg) assert.equal(normMsg(input), expected, JSON.stringify(input))
})

test('normMsg stays linear on adversarial input: under 50 ms on 20,000 characters of each pattern', () => {
  const patterns = ["'", '"a', 'a/', 'a\\', '/a', 'C:\\', 'http://', 'a.', '1.', 'a1', '#', 'Jon #', '<', '(reading ']
  for (const p of patterns) {
    const input = p.repeat(Math.ceil(20000 / p.length))
    const started = performance.now()
    normMsg(input)
    assert.ok(performance.now() - started < 50, JSON.stringify(p))
  }
})

for (const c of GOLDEN.cases) {
  test(`golden signature: ${c.name}`, async () => {
    const { sig } = await sign(merge(load(c.payload), c.patch || {}), { mapDir: c.maps ? maps : noMaps() })
    assert.equal(sig.canonical, c.canonical)
    assert.equal(sig.id, c.id)
    assert.deepEqual(sig.held, c.held)
    assert.equal(sig.title, c.title)
  })
}

test('a logged-then-rethrown error is one group, with the map and without it', async () => {
  for (const mapDir of [maps, noMaps()]) {
    const logged = (await sign(load('script-error-logged'), { mapDir })).sig
    const rethrown = (await sign(load('script-error-rethrown'), { mapDir })).sig
    assert.equal(logged.id, rethrown.id)
    assert.match(logged.id, /^S[0-9a-f]{10}$/)
  }
})

test('a signature or group sent by the client is never used', async () => {
  const plain = (await sign(load('script-error-on-update'))).sig
  const body = load('script-error-on-update')
  Object.assign(body, { signature: 'S0000000000', group: 'S0000000000' })
  Object.assign(body.error, { signature: 'S0000000000' })
  assert.equal((await sign(body)).sig.id, plain.id)
})

test('crash: ntdll, KERNELBASE, KERNEL32, ucrtbase, VCRUNTIME* and MSVCP* frames are skipped', async () => {
  const plain = (await sign(load('crash-ours'))).sig
  const body = load('crash-ours')
  const system = ['ntdll.dll', 'KERNELBASE.dll', 'KERNEL32.DLL', 'ucrtbase.dll', 'VCRUNTIME140_1.dll', 'MSVCP140.dll']
    .map((module, i) => ({ module, offset: `0x${(i + 1) * 4096}`, symbol: null, alid: null }))
  body.crash.frames = [...system, body.crash.frames[0], ...system, ...body.crash.frames.slice(1)]
  assert.equal((await sign(body)).sig.canonical, plain.canonical)
  const top = load('crash-ours')
  Object.assign(top.crash, { faultModule: 'KERNELBASE.dll', faultOffset: '0x5F95C', faultSymbol: null })
  top.crash.frames.unshift({ module: 'KERNELBASE.dll', offset: '0x5F95C', symbol: null, alid: null })
  assert.equal((await sign(top)).sig.canonical, plain.canonical)
})

test('crash frames: a raw offset in our DLL carries versions.files, a third-party frame only its module', async () => {
  const body = load('crash-ours')
  body.crash.frames.push({ module: 'SkyrimPlatformImpl.dll', offset: '0x44A10', symbol: null, alid: null },
                         { module: 'd3d11.dll', offset: '0x1C2A0', symbol: null, alid: null })
  const { sig } = await sign(body)
  assert.equal(sig.canonical, 'v1|crash|EXCEPTION_ACCESS_VIOLATION|SkyrimPlatform.dll+EventsApi::SendEvent'
    + '|SkyrimSE.exe+alid:37014,SkyrimPlatformImpl.dll+0x44A10@0.3.44,d3d11.dll')
  delete body.versions.files
  assert.match((await sign(body)).sig.canonical, /SkyrimPlatformImpl\.dll\+0x44A10@\?/)
})

test('titles never carry the message and are capped at 100 characters', async () => {
  const body = load('script-error-on-update')
  body.error.message = 'Jon Snow wrote a letter '.repeat(10)
  body.error.frames[0].fn = `Very${'Long'.repeat(30)}`
  const { sig } = await sign(body)
  assert.ok(sig.title.startsWith('(Auto Report) TypeError in VeryLong'))
  assert.ok(sig.title.length <= 100)
  assert.ok(!sig.title.includes('letter'))
  const crash = (await sign(load('crash-gpu-driver'))).sig
  assert.equal(crash.title, '(Auto Report) Crash EXCEPTION_ACCESS_VIOLATION nvwgf2umx.dll')
})

test('compareVersions is numeric: 0.3.9 < 0.3.40, missing parts count as 0', () => {
  assert.equal(compareVersions('0.3.9', '0.3.40'), -1)
  assert.equal(compareVersions('0.3.40', '0.3.9'), 1)
  assert.equal(compareVersions('0.3.44', '0.3.44.0'), 0)
  assert.equal(compareVersions('1.0', '0.99.99'), 1)
  assert.equal(compareVersions('1.6.1170.0', '1.6.640.0'), 1)
})

test('receipt: a site the probe offset moves below line 1 is removed and flagged, not refused', async () => {
  const { result, sig } = await sign(load('script-error-site-below-1'))
  assert.equal(result.report.error.site, null)
  assert.deepEqual(result.flags, ['invalidField'])
  assert.deepEqual(result.invalid, ['error.site'])
  assert.equal(result.report.error.frames.length, 2)
  assert.deepEqual(sig.held, [])
  const frames = load('script-error-on-update')
  frames.build.probe.line = 48300
  const { result: moved } = await sign(frames)
  assert.deepEqual(moved.report.error.frames.map(f => f.line), [48213])
  assert.deepEqual(moved.invalid, ['error.frames[1]', 'error.site'])
})

test('receipt: without an archived build nothing is corrected or flagged', async () => {
  const { result, sig } = await sign(load('script-error-site-below-1'), { mapDir: noMaps() })
  assert.deepEqual(result.flags, [])
  assert.deepEqual(result.report.error.site, { line: 100, col: 9 })
  assert.deepEqual(sig.held, ['unknown-build'])
})

test('receipt: a build whose archived clientVersion differs from versions.client is suspect', async () => {
  const other = path.join(tmp, 'other-version')
  writeFixtureMaps(other, { clientVersion: '0.3.43' })
  const { result } = await sign(load('script-error-on-update'), { mapDir: other })
  assert.deepEqual(result.flags, ['suspect'])
  const crash = await sign(load('crash-ours'), { mapDir: other })
  assert.deepEqual(crash.result.flags, ['suspect'])
  assert.deepEqual((await sign(load('crash-ours'))).result.flags, [])
})

test('source maps: meta must name its build, a missing or broken map resolves nothing, a loaded map is reused', async (t) => {
  const errors = t.mock.method(console, 'error', () => {})
  config.autoSourceMapDir = maps
  assert.equal(sourceMaps.meta('client', '../../etc/passwd'), null)
  assert.equal(sourceMaps.meta('elsewhere', CLIENT_BUILD), null)
  const broken = path.join(tmp, 'broken')
  writeFixtureMaps(broken)
  fs.writeFileSync(path.join(broken, 'client', `${CLIENT_BUILD}.map`), '{"version":3,')
  config.autoSourceMapDir = broken
  assert.equal(await sourceMaps.resolver('client', CLIENT_BUILD), null)
  assert.equal(errors.mock.calls.length, 1)
  const { sig } = await sign(load('script-error-on-update'), { mapDir: broken })
  assert.deepEqual(sig.held, ['unresolved'])

  config.autoSourceMapDir = maps
  const first = await sourceMaps.resolver('client', CLIENT_BUILD)
  assert.deepEqual(first(48213, 31), { source: 'src/services/remoteServer.ts', line: 640 })
  assert.equal(first(48214, 1), null)
  const reads = t.mock.method(fs.promises, 'readFile')
  assert.equal(await sourceMaps.resolver('client', CLIENT_BUILD), first)
  assert.equal(reads.mock.calls.length, 0)
})
