'use strict'
// main.js's game copy wiring, through its real IPC handlers: Electron, electron-store and adm-zip are stubbed, the
// network points at a closed port, MO2's download is stubbed and exe versions come from the fake exe's text
// ("exe 1.6.1170.0"). Covers the independent review of feature/isolated-gamecopy: Repair Game Copy on a Steam folder
// with 1.7.99 data (1.6.1170 exe) must leave a working copy alone, first setup there must refuse before copying, and
// a copy whose Data is a link must be refused by main's own install and launch paths.
const test = require('node:test')
const assert = require('node:assert')
const Module = require('module')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'main-wiring-test-'))
process.env.API_URL = 'http://127.0.0.1:9'
process.env.LOCALAPPDATA = path.join(root, 'LocalAppData')

const handlers = {}
const electron = {
  app: {
    isPackaged: true, disableHardwareAcceleration() {}, getPath: n => path.join(root, 'electron', n), setPath() {},
    requestSingleInstanceLock: () => true, on() {}, whenReady: () => new Promise(() => {}), getVersion: () => '0.0.0-test', quit() {},
  },
  ipcMain: { handle: (ch, fn) => { handlers[ch] = fn }, on: (ch, fn) => { handlers[`on:${ch}`] = fn } },
  dialog: { showMessageBox: async () => ({ response: 1 }), showMessageBoxSync: () => 0 },
  shell: { openExternal() {} }, clipboard: { writeText() {} },
  BrowserWindow: class { static getAllWindows() { return [] } },
}
class Store {
  constructor(o) { this.store = { ...(o && o.defaults) } }
  get(k) { return this.store[k] }
  set(k, v) { if (typeof k === 'object') Object.assign(this.store, k); else this.store[k] = v }
  delete(k) { delete this.store[k] }
}
const stubs = { electron, 'electron-store': Store, 'adm-zip': class {}, dotenv: { config() {} } }
const resolve = Module._resolveFilename
Module._resolveFilename = function (req, ...a) { return stubs[req] ? req : resolve.call(this, req, ...a) }
for (const k of Object.keys(stubs)) require.cache[k] = { id: k, filename: k, loaded: true, exports: stubs[k] }

const gameversion = require('../src/gameversion')
gameversion.readPeFileVersion = f => { try { const m = /^exe (\S+)/.exec(fs.readFileSync(f, 'utf8')); return m ? m[1] : null } catch { return null } }
// Small stand-ins for the 1.6.1170 sizes the "newer data" check compares
gameversion.DATA_SIZES_1170.splice(0, Infinity, ['Skyrim.esm', 40], ['Update.esm', 30], ['Skyrim - Interface.bsa', 20], ['Skyrim - Misc.bsa', 10])
const mo2 = require('../src/mo2')
mo2.ensureInstalled = async () => {}
mo2.isInstalled = () => true
require('../src/isolation').KNOWN_FILES.clear()   // the fake masters cannot have the real 1.6.1170 hashes

require('../src/main')
const call = async (ch, ...a) => handlers[ch]({}, ...a)

const put = (f, d) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, d) }
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const tree = dir => {
  const out = {}
  const walk = sub => {
    for (const e of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${e.name}` : e.name
      if (e.isDirectory()) walk(rel)
      else out[rel] = sha(path.join(dir, rel))
    }
  }
  walk('')
  return out
}

// A Steam library with Skyrim on 1.6.1170, exe and data; data: '1.7.99' gives the newer masters with the same exe
function steamFolder(name, { data = '1.6.1170' } = {}) {
  const dir = path.join(root, name, 'steamapps', 'common', 'Skyrim Special Edition')
  put(path.join(dir, 'SkyrimSE.exe'), 'exe 1.6.1170.0')
  put(path.join(dir, 'steam_api64.dll'), 'steam api')
  for (const [n, size] of gameversion.DATA_SIZES_1170) put(path.join(dir, 'Data', n), Buffer.alloc(data === '1.7.99' ? size + 7 : size, n.length))
  put(path.join(dir, 'Data', 'Dawnguard.esm'), 'dawnguard')
  put(path.join(root, 'electron', 'documents', 'My Games', 'Skyrim Special Edition', 'SkyrimPrefs.ini'), '[Display]\r\n')
  return dir
}

test('legacy Repair Game Copy with Steam on 1.7.99 data leaves the working copy exactly as it is', async () => {
  const steam = steamFolder('lib1')
  await call('settings:save', { skyrimPath: steam, baseDirPath: path.join(root, 'DB1', 'DragonBreak'), isolatedGame: true })
  assert.strictEqual((await call('game:isolatedStatus')).dir, path.join(root, 'DB1', 'DragonBreak', 'skyrim'))
  const made = await call('game:createIsolated', '')
  assert.strictEqual(made.success, true, made.error)
  const copy = (await call('game:isolatedStatus')).dir
  const before = tree(copy)
  assert.ok(before['Data/Skyrim.esm'] && before['vanilla-copy-complete.json'])

  // Steam updates to 1.7.99: new masters and archives, the exe still reads 1.6.1170.0
  for (const [n, size] of gameversion.DATA_SIZES_1170) put(path.join(steam, 'Data', n), Buffer.alloc(size + 7, 9))
  const repaired = await call('game:createIsolated', '', { force: true })
  assert.strictEqual(repaired.success, false)
  assert.match(repaired.error, /newer game data .*left as it is and keeps working/)
  assert.deepStrictEqual(tree(copy), before, 'not one file of the copy was deleted or replaced')
})

test('first setup on a Steam folder with 1.7.99 data refuses before copying anything', async () => {
  const steam = steamFolder('lib2', { data: '1.7.99' })
  const base = path.join(root, 'DB2', 'DragonBreak')
  await call('settings:save', { skyrimPath: steam, baseDirPath: base, isolatedGame: true })
  const made = await call('game:createIsolated', base)
  assert.strictEqual(made.success, false)
  assert.match(made.error, /newer game data .*Downgrade it in the Skyrim Version panel first/)
  assert.ok(!fs.existsSync(path.join(base, 'skyrim', 'SkyrimSE.exe')) && !fs.existsSync(path.join(base, 'skyrim', 'Data')), 'nothing copied')
})

test('a copy whose Data is a link into Steam is refused by setup and by launch, and nothing lands in Steam', async () => {
  const steam = steamFolder('lib3')
  const base = path.join(root, 'DB3', 'DragonBreak')
  await call('settings:save', { skyrimPath: steam, baseDirPath: base, isolatedGame: true })
  assert.strictEqual((await call('game:createIsolated', base)).success, true)
  const copy = path.join(base, 'skyrim')
  fs.rmSync(path.join(copy, 'Data'), { recursive: true })
  fs.symlinkSync(path.join(steam, 'Data'), path.join(copy, 'Data'), 'dir')
  const steamData = tree(path.join(steam, 'Data'))

  const repaired = await call('game:createIsolated', base, { force: true })
  assert.strictEqual(repaired.success, false)
  assert.match(repaired.error, /^Data in the DragonBreak game copy .* is a link to another folder/)
  const launched = await call('launch:viaMO2')
  assert.strictEqual(launched.success, false)
  assert.match(launched.error, /is a link to another folder/)
  assert.deepStrictEqual(tree(path.join(steam, 'Data')), steamData, 'nothing written into Steam\'s Data')
})

test('with no ready copy nothing falls back to the Steam folder', async () => {
  const steam = steamFolder('lib4')
  await call('settings:save', { skyrimPath: steam, baseDirPath: path.join(root, 'DB4', 'DragonBreak'), isolatedGame: true })
  const saved = await call('hotkeys:save', { freeCursor: 5 })
  assert.strictEqual(saved.ok, false)
  assert.match(saved.error, /game copy is not set up yet/)
  assert.ok(!fs.existsSync(path.join(steam, 'Data', 'Platform')))
  const launched = await call('launch:viaMO2')
  assert.match(launched.error, /game copy is not set up yet/)
})

test.after(() => fs.rmSync(root, { recursive: true, force: true }))
