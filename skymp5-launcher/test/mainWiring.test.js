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
// The lists main.js sees: an empty one for the legacy cases (as before the real list shipped), a small fake with the
// real list's shape for the verified ones (useVerifiedList)
const gamecopy = require('../src/gamecopy')
const EMPTY_LIST = { build: '1.6.1170.0', platform: 'steam', files: [] }
const useLegacy = () => gamecopy.useBundledLists({ steam: EMPTY_LIST })
useLegacy()

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
  useLegacy()
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
  useLegacy()
  const steam = steamFolder('lib2', { data: '1.7.99' })
  const base = path.join(root, 'DB2', 'DragonBreak')
  await call('settings:save', { skyrimPath: steam, baseDirPath: base, isolatedGame: true })
  const made = await call('game:createIsolated', base)
  assert.strictEqual(made.success, false)
  assert.match(made.error, /newer game data .*Downgrade it in the Skyrim Version panel first/)
  assert.ok(!fs.existsSync(path.join(base, 'skyrim', 'SkyrimSE.exe')) && !fs.existsSync(path.join(base, 'skyrim', 'Data')), 'nothing copied')
})

test('a copy whose Data is a link into Steam is refused by setup and by launch, and nothing lands in Steam', async () => {
  useLegacy()
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
  assert.match(repaired.error, /^Data in the DragonBreak game copy .* is a link into .*part of your Skyrim or Steam folders/)
  const launched = await call('launch:viaMO2')
  assert.strictEqual(launched.success, false)
  assert.match(launched.error, /is a link into .*part of your Skyrim or Steam folders/)
  assert.deepStrictEqual(tree(path.join(steam, 'Data')), steamData, 'nothing written into Steam\'s Data')
})

test('a copy whose Data was moved to another drive with a junction (2.1.36 played so) keeps working', async () => {
  useLegacy()
  const steam = steamFolder('lib5')
  const base = path.join(root, 'DB5', 'DragonBreak')
  await call('settings:save', { skyrimPath: steam, baseDirPath: base, isolatedGame: true })
  assert.strictEqual((await call('game:createIsolated', base)).success, true)
  const copy = path.join(base, 'skyrim')
  const otherDrive = path.join(root, 'D', 'SkyrimCopyData')
  fs.mkdirSync(path.dirname(otherDrive), { recursive: true })
  fs.renameSync(path.join(copy, 'Data'), otherDrive)
  fs.symlinkSync(otherDrive, path.join(copy, 'Data'), 'dir')
  const repaired = await call('game:createIsolated', base, { force: true })
  assert.strictEqual(repaired.success, true, repaired.error)
  assert.ok(fs.existsSync(path.join(otherDrive, 'Skyrim.esm')), 'repaired through the allowed link')
  const launched = await call('launch:viaMO2')
  assert.doesNotMatch(String(launched.error), /is a link/, 'PLAY is not refused for the link')
})

test('with no ready copy nothing falls back to the Steam folder', async () => {
  useLegacy()
  const steam = steamFolder('lib4')
  await call('settings:save', { skyrimPath: steam, baseDirPath: path.join(root, 'DB4', 'DragonBreak'), isolatedGame: true })
  const saved = await call('hotkeys:save', { freeCursor: 5 })
  assert.strictEqual(saved.ok, false)
  assert.match(saved.error, /game copy is not set up yet/)
  assert.ok(!fs.existsSync(path.join(steam, 'Data', 'Platform')))
  const launched = await call('launch:viaMO2')
  assert.match(launched.error, /game copy is not set up yet/)
})

// ------------------------------------------------------------------------------------- verified mode (a real-shaped list)

// A list over a clean fake Steam folder, shaped like src/vanilla-1.6.1170.json: build, platform, files with depots,
// Skyrim.ccc in it (the launcher leaves it out and keeps the copy's empty)
function useVerifiedList(steam) {
  put(path.join(steam, 'Skyrim.ccc'), 'ccc list')
  const files = []
  const walk = sub => {
    for (const e of fs.readdirSync(path.join(steam, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${e.name}` : e.name
      if (e.isDirectory()) walk(rel)
      else files.push({ path: rel, size: fs.statSync(path.join(steam, rel)).size, sha256: sha(path.join(steam, rel)), depot: rel === 'SkyrimSE.exe' ? '489833' : '489831' })
    }
  }
  walk('')
  gamecopy.useBundledLists({ steam: { build: '1.6.1170.0', platform: 'steam', generatedAt: '2026-10-02T22:39:00Z', files } })
  return files
}

test('verified: a Steam folder whose files match the list makes the copy from Steam alone, no depot needed', async () => {
  const steam = steamFolder('lib6')
  const listed = useVerifiedList(steam)
  const base = path.join(root, 'DB6', 'DragonBreak')
  await call('settings:save', { skyrimPath: steam, baseDirPath: base, isolatedGame: true })
  const pv = await call('game:copyPreview', base)
  assert.strictEqual(pv.mode, 'verified')
  const made = await call('game:createIsolated', base)
  assert.strictEqual(made.success, true, made.error)
  assert.deepStrictEqual([made.copied, made.kept], [listed.length - 1, 0], 'every listed file but Skyrim.ccc, from Steam')
  const copy = path.join(base, 'skyrim')
  const record = JSON.parse(fs.readFileSync(path.join(copy, 'dragonbreak-game.json'), 'utf8'))
  assert.deepStrictEqual([record.platform, record.files.length, record.source.dir], ['steam', listed.length - 1, steam])
  assert.strictEqual(fs.readFileSync(path.join(copy, 'Skyrim.ccc'), 'utf8'), '', 'the launcher\'s empty Skyrim.ccc')
  assert.ok(!fs.existsSync(path.join(copy, 'vanilla-copy-complete.json')), 'the record replaces the legacy marker')
  assert.ok(!fs.existsSync(path.join(root, 'lib6', 'steamapps', 'content')), 'no depot was downloaded or needed')
  assert.strictEqual((await call('game:isolatedStatus')).ready, true)
})

test('verified: a Steam exe of another build is not copied; the copy waits for the depot and Steam is untouched', async () => {
  const steam = steamFolder('lib7')
  useVerifiedList(steam)
  put(path.join(steam, 'SkyrimSE.exe'), 'exe 1.7.104.0 updated by Steam, other size')
  const base = path.join(root, 'DB7', 'DragonBreak')
  await call('settings:save', { skyrimPath: steam, baseDirPath: base, isolatedGame: true })
  const made = await call('game:createIsolated', base)
  assert.deepStrictEqual([made.success, made.needDepots, made.files], [false, true, ['SkyrimSE.exe']])
  assert.match(made.error, /Download them with Steam's own download in the Skyrim Version panel.*your Steam Skyrim is not changed/)
  assert.ok(!fs.existsSync(path.join(base, 'skyrim', 'SkyrimSE.exe')), 'nothing copied before the download')
  assert.strictEqual(fs.readFileSync(path.join(steam, 'SkyrimSE.exe'), 'utf8'), 'exe 1.7.104.0 updated by Steam, other size')
  const panel = await call('downgrade:status')
  assert.deepStrictEqual([panel.action, panel.copyBuild.files, panel.acf], ['downgrade', ['SkyrimSE.exe'], null])
})

test('verified: an intro-skip BGS_Logo.bik and a renamed SkyrimSELauncher.exe in Steam ask for no depot', async () => {
  const steam = steamFolder('lib9')
  put(path.join(steam, 'Data', 'Video', 'BGS_Logo.bik'), 'the vanilla intro video')
  put(path.join(steam, 'SkyrimSELauncher.exe'), 'MZ SkyrimSELauncher 1.6.1170')
  useVerifiedList(steam)
  // Vortex deploys over both
  put(path.join(steam, 'Data', 'Video', 'BGS_Logo.bik'), 'skip')
  put(path.join(steam, 'SkyrimSELauncher.exe'), 'skse64_loader.exe, renamed')
  const base = path.join(root, 'DB9', 'DragonBreak')
  await call('settings:save', { skyrimPath: steam, baseDirPath: base, isolatedGame: true })
  const made = await call('game:createIsolated', base)
  assert.strictEqual(made.success, true, made.error)
  assert.ok(!made.needDepots)
  const copy = path.join(base, 'skyrim')
  assert.ok(!fs.existsSync(path.join(copy, 'SkyrimSELauncher.exe')) && !fs.existsSync(path.join(copy, 'Data', 'Video', 'BGS_Logo.bik')))
  assert.ok(fs.existsSync(path.join(copy, 'dragonbreak-game.json')))
})

test('verified list for English only: a German Steam install stays on the legacy copy', async () => {
  const steam = steamFolder('lib8')
  useVerifiedList(steam)
  put(path.join(root, 'lib8', 'steamapps', 'appmanifest_489830.acf'),
    '"AppState"\n{\n\t"MountedConfig"\n\t{\n\t\t"language"\t\t"german"\n\t}\n}\n')
  const base = path.join(root, 'DB8', 'DragonBreak')
  await call('settings:save', { skyrimPath: steam, baseDirPath: base, isolatedGame: true })
  assert.strictEqual((await call('game:copyPreview', base)).mode, 'legacy')
  const made = await call('game:createIsolated', base)
  assert.strictEqual(made.success, true, made.error)
  const copy = path.join(base, 'skyrim')
  assert.ok(fs.existsSync(path.join(copy, 'vanilla-copy-complete.json')) && !fs.existsSync(path.join(copy, 'dragonbreak-game.json')),
    'made the legacy way, never with English files from the list')
})

test.after(() => { gamecopy.useBundledLists(null); fs.rmSync(root, { recursive: true, force: true }) })
