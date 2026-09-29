'use strict'
// Data\Platform files left in MO2's overwrite outrank the game folder's: the session file goes, whole UI, Plugins and
// Distribution folders are moved aside, and the client's saved settings stay
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const mo2 = require('../src/mo2')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overwrite-platform-test-'))
mo2.setRootProvider(() => root)
mo2.setLogger(() => {})
const platform = path.join(root, 'overwrite', 'Platform')
const now = new Date('2026-09-29T03:04:05.678Z')
const SETTINGS = ['chat-settings-no-load.js', 'voice-settings-no-load.js', 'menu-media-settings-no-load.js']

function write(rel, content) {
  const file = path.join(platform, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

test('nothing in overwrite: nothing to do', () => {
  assert.deepStrictEqual(mo2.cleanOverwritePlatform(now), [])
  fs.mkdirSync(path.join(root, 'overwrite'), { recursive: true })
  assert.deepStrictEqual(mo2.cleanOverwritePlatform(now), [])
})

test('the session file goes, the saved settings stay', () => {
  write('PluginsNoLoad/auth-data-no-load.js', '//{"session":"old"}')
  for (const name of SETTINGS) write(`PluginsNoLoad/${name}`, '//{}')
  const done = mo2.cleanOverwritePlatform(now)
  assert.strictEqual(done.length, 1)
  assert.match(done[0], /removed overwrite Platform\/PluginsNoLoad\/auth-data-no-load\.js/)
  assert.ok(!fs.existsSync(path.join(platform, 'PluginsNoLoad', 'auth-data-no-load.js')))
  for (const name of SETTINGS) assert.ok(fs.existsSync(path.join(platform, 'PluginsNoLoad', name)), name)
})

test('a stale UI folder is moved aside with its size, not deleted', () => {
  write('UI/index.html', 'x'.repeat(212))
  write('UI/build.js', 'y'.repeat(1000))
  write('UI/fonts/a.ttf', 'z'.repeat(10))
  const done = mo2.cleanOverwritePlatform(now)
  assert.deepStrictEqual(done, ['moved overwrite Platform/UI (1222 bytes) aside to UI.stale-20260929T030405Z'])
  assert.ok(!fs.existsSync(path.join(platform, 'UI')))
  const aside = path.join(platform, 'UI.stale-20260929T030405Z')
  assert.strictEqual(fs.readFileSync(path.join(aside, 'index.html'), 'utf8').length, 212)
  assert.ok(fs.existsSync(path.join(aside, 'fonts', 'a.ttf')))
})

test('Plugins and Distribution go aside too; a name already taken gets a suffix', () => {
  write('Plugins/skymp5-client.js', 'old client')
  write('Distribution/RuntimeDependencies/SkyrimPlatformImpl.dll', 'old dll')
  write('UI/index.html', 'again')
  const done = mo2.cleanOverwritePlatform(now)
  assert.strictEqual(done.length, 3)
  assert.ok(fs.existsSync(path.join(platform, 'UI.stale-20260929T030405Z-2', 'index.html')))
  assert.ok(fs.existsSync(path.join(platform, 'Plugins.stale-20260929T030405Z', 'skymp5-client.js')))
  assert.ok(fs.existsSync(path.join(platform, 'Distribution.stale-20260929T030405Z', 'RuntimeDependencies', 'SkyrimPlatformImpl.dll')))
})

test('a second launch changes nothing', () => {
  const before = fs.readdirSync(platform).sort()
  assert.deepStrictEqual(mo2.cleanOverwritePlatform(new Date('2026-09-29T04:00:00Z')), [])
  assert.deepStrictEqual(fs.readdirSync(platform).sort(), before)
  for (const name of SETTINGS) assert.ok(fs.existsSync(path.join(platform, 'PluginsNoLoad', name)), name)
  fs.rmSync(root, { recursive: true, force: true })
})
