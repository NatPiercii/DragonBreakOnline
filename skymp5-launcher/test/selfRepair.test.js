'use strict'
// selfRepair: the pre-launch client check, stray files in the platform's folders, and a failed start in the log.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { checkClient, strayFiles, moveAside, overwritePlatformDlls, bootFailure, watchBoot, ensureSkseLogDir } = require('../src/selfRepair')

const sha = s => crypto.createHash('sha256').update(s).digest('hex')
function game(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbo-selfrepair-'))
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, body)
  }
  return dir
}
const entry = (p, body) => ({ path: p, size: Buffer.byteLength(body), sha256: sha(body) })

test('checkClient flags a missing, resized or altered start file and ignores files that do not start the client', () => {
  const dir = game({
    'Data/SKSE/Plugins/SkyrimPlatform.dll': 'platform',
    'Data/SKSE/Plugins/MpClientPlugin.dll': 'tampered',
    'Data/Platform/Plugins/skymp5-client.js': 'client',
    'Data/Platform/UI/build.js': 'short',
    'Data/Platform/UI/other.css': 'x',
  })
  const files = [
    entry('Data/SKSE/Plugins/SkyrimPlatform.dll', 'platform'),
    entry('Data/SKSE/Plugins/MpClientPlugin.dll', 'mpclient'),
    entry('Data/Platform/Plugins/skymp5-client.js', 'client'),
    entry('Data/Platform/UI/build.js', 'longer page'),
    entry('Data/Platform/Distribution/RuntimeDependencies/SkyrimPlatformImpl.dll', 'impl'),
    entry('Data/Platform/UI/other.css', 'different'),
  ]
  const bad = checkClient(dir, files)
  assert.deepStrictEqual(bad.map(b => [b.path, b.why.split(',')[0]]), [
    ['Data/SKSE/Plugins/MpClientPlugin.dll', 'sha256'],
    ['Data/Platform/UI/build.js', 'size 5'],
    ['Data/Platform/Distribution/RuntimeDependencies/SkyrimPlatformImpl.dll', 'missing'],
  ])
  assert.deepStrictEqual(checkClient(dir, []), [])
})

test('checkClient checks a file over the hash limit by size only', () => {
  const dir = game({ 'Data/Platform/Distribution/RuntimeDependencies/libcef.dll': 'abc' })
  const files = [{ path: 'Data/Platform/Distribution/RuntimeDependencies/libcef.dll', size: 3, sha256: sha('zzz') }]
  assert.strictEqual(checkClient(dir, files, { hashLimit: 2 }).length, 0)
  assert.strictEqual(checkClient(dir, files).length, 1)
})

test('strayFiles lists unlisted files in the platform folders and the platform DLLs, never the client\'s own writes or other SKSE plugins', () => {
  const dir = game({
    'Data/Platform/Plugins/skymp5-client.js': 'client',
    'Data/Platform/Plugins/old-other-server.js': 'stray',
    'Data/Platform/Plugins/skymp5-client-settings.txt': 'settings',
    'Data/Platform/UI/build.js': 'page',
    'Data/Platform/UI/index-old.html': 'stray',
    'Data/Platform/Distribution/RuntimeDependencies/SkyrimPlatformImpl_old.dll': 'stray',
    'Data/Platform/PluginsNoLoad/auth-data-no-load.js': 'session',
    'Data/Platform/Logs/a.txt': 'log',
    'Data/SKSE/Plugins/SkyrimPlatform.dll': 'platform',
    'Data/SKSE/Plugins/SkyrimPlatform_v2.dll': 'stray',
    'Data/SKSE/Plugins/EngineFixes.dll': 'player',
    'Data/SKSE/Plugins/MpClientPlugin.log': 'log',
  })
  const files = ['Data/Platform/Plugins/skymp5-client.js', 'Data/Platform/UI/build.js', 'Data/SKSE/Plugins/SkyrimPlatform.dll'].map(p => ({ path: p }))
  assert.deepStrictEqual(strayFiles(dir, files).sort(), [
    'Data/Platform/Distribution/RuntimeDependencies/SkyrimPlatformImpl_old.dll',
    'Data/Platform/Plugins/old-other-server.js',
    'Data/Platform/UI/index-old.html',
    'Data/SKSE/Plugins/SkyrimPlatform_v2.dll',
  ])
  assert.deepStrictEqual(strayFiles(dir, []), [], 'no server list, nothing is stray')
})

test('moveAside keeps each file under a stamped quarantine folder and leaves nothing behind', () => {
  const dir = game({ 'Data/Platform/Plugins/old.js': 'stray', 'Data/SKSE/Plugins/SkyrimPlatform_v2.dll': 'x' })
  const q = path.join(dir, 'DragonBreak Quarantine')
  const moved = moveAside(dir, ['Data/Platform/Plugins/old.js', 'Data/SKSE/Plugins/SkyrimPlatform_v2.dll', 'Data/none.js'], q, { now: new Date('2026-10-06T23:00:00Z') })
  assert.deepStrictEqual(moved, ['Data/Platform/Plugins/old.js', 'Data/SKSE/Plugins/SkyrimPlatform_v2.dll'])
  assert.ok(!fs.existsSync(path.join(dir, 'Data/Platform/Plugins/old.js')))
  assert.strictEqual(fs.readFileSync(path.join(q, '20261006T230000Z', 'Data/Platform/Plugins/old.js'), 'utf8'), 'stray')
})

test('overwritePlatformDlls finds only the platform DLLs in MO2\'s overwrite', () => {
  const dir = game({ 'SKSE/Plugins/SkyrimPlatform.dll': 'x', 'SKSE/Plugins/MpClientPlugin.dll': 'x', 'SKSE/Plugins/Other.dll': 'x' })
  assert.deepStrictEqual(overwritePlatformDlls(dir).sort(), ['SKSE/Plugins/MpClientPlugin.dll', 'SKSE/Plugins/SkyrimPlatform.dll'])
})

// The lines from Jake's skyrim-platform.log, 6 Oct 15:28
const HANG = `[15:28:28:979] InitNativeAddon() - env 246ba055340
[15:28:28:979] JsEngine::JsEngine() - JavaScript error:
[15:28:29:008] registering browser api
[15:28:29:299] JsEngine::AcquireEnvAndCall() - Rethrowing JavaScript error: Error: Cannot find module 'skyrimPlatform'
Require stack:
- C:\\DragonBreak\\skyrim\\noop.js`

test('bootFailure reads the logo hang, and a healthy start is not one', () => {
  const f = bootFailure(HANG)
  assert.ok(f && /could not load the module 'skyrimPlatform'/.test(f.reason), JSON.stringify(f))
  assert.ok(bootFailure('[1] JsEngine::AcquireEnvAndCall() - Rethrowing JavaScript error: SyntaxError: Unexpected token'))
  assert.strictEqual(bootFailure('[15:28:28:979] JsEngine::JsEngine() - JavaScript error: \n[15:28:29:008] registering browser api'), null)
  assert.strictEqual(bootFailure('Rethrowing JavaScript error: TypeError: x is undefined'), null)
})

test('watchBoot reports a failed start from a log written since the launch, and gives up after its time', async () => {
  let t = 1000
  const clock = { now: () => t, wait: async ms => { t += ms } }
  const files = { '/skse/skyrim-platform.log': { mtimeMs: 5000, text: HANG }, '/old/skyrim-platform.log': { mtimeMs: 1, text: HANG } }
  const io = { stat: f => { const x = files[f.replace(/\\/g, '/')]; if (!x) throw new Error('none'); return x }, read: f => files[f.replace(/\\/g, '/')].text }
  const hit = await watchBoot({ logDirs: ['/old', '/skse'], launchedAt: 4000, forMs: 10_000, everyMs: 1000, ...clock, ...io })
  assert.ok(hit && /skyrimPlatform/.test(hit.reason) && /skse/.test(hit.file.replace(/\\/g, '/')))
  const none = await watchBoot({ logDirs: ['/old'], launchedAt: 4000, forMs: 5000, everyMs: 1000, ...clock, ...io })
  assert.strictEqual(none, null, 'a log older than the launch is not this start')
})

test('ensureSkseLogDir creates a missing registered Documents folder and the SKSE log folder under it', () => {
  const made = new Set(), have = new Set(['C:/Users/k'])
  const io = { exists: p => have.has(p.replace(/\\/g, '/')) || made.has(p.replace(/\\/g, '/')), mkdir: p => made.add(p.replace(/\\/g, '/')) }
  const r = ensureSkseLogDir({ docs: null, registered: '%USERPROFILE%/OneDrive/Documents', env: { UserProfile: 'C:/Users/k' }, ...io })
  assert.strictEqual(r.error, null)
  assert.ok(made.has('C:/Users/k/OneDrive/Documents'))
  assert.ok([...made].some(p => p.endsWith('OneDrive/Documents/My Games/Skyrim Special Edition/SKSE')), [...made].join(' '))
  const gog = ensureSkseLogDir({ docs: 'D:/Docs', registered: null, edition: 'GOG', ...io })
  assert.ok(gog.created.some(p => p.replace(/\\/g, '/').endsWith('My Games/Skyrim Special Edition GOG/SKSE')))
  assert.ok(/could not say/.test(ensureSkseLogDir({ docs: null, registered: null, ...io }).error))
  assert.ok(/could not be created/.test(ensureSkseLogDir({ docs: null, registered: 'Z:/gone/Documents', exists: () => false, mkdir: () => { throw new Error('no drive') } }).error))
})
