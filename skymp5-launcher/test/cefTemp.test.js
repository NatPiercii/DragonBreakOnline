'use strict'
// cefTemp: the browser cache folders SkyrimPlatform leaves in %TEMP%\Skyrim Platform. Real folders in a scratch
// directory, with their times set by hand.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { STALE_MS, cefTempRoot, staleCefTempFolders, cleanCefTemp } = require('../src/cefTemp')

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-02T12:00:00Z')

function scratch() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ceftemp-test-'))
  const root = cefTempRoot(tmp)
  fs.mkdirSync(root)
  return { tmp, root }
}
// A CEFTemp folder with a log and a cache folder, everything written `age` ago
function folder(root, name, age, log = 'x') {
  const dir = path.join(root, name)
  fs.mkdirSync(path.join(dir, 'Cache'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'cef_debug.log'), log)
  const t = new Date(NOW - age)
  for (const p of [path.join(dir, 'Cache'), path.join(dir, 'cef_debug.log'), dir]) fs.utimesSync(p, t, t)
  return dir
}

test('the folders live in %TEMP%\\Skyrim Platform', () => {
  assert.strictEqual(cefTempRoot('C:\\T'), path.join('C:\\T', 'Skyrim Platform'))
})

test('only the debug logs of old CEFTemp folders go: every folder and cache stays (other servers share this root)', () => {
  const { tmp, root } = scratch()
  folder(root, 'CEFTemp111', 9 * DAY, 'x'.repeat(4096))
  folder(root, 'CEFTemp222', 4 * DAY)
  folder(root, 'CEFTemp333', 1 * DAY)
  folder(root, 'NotCef', 30 * DAY)
  fs.writeFileSync(path.join(root, 'CEFTemp444'), 'a file, not a folder')
  fs.writeFileSync(path.join(root, 'CEFTemp111', 'cef_debug.log.1'), 'rotated')
  fs.writeFileSync(path.join(root, 'CEFTemp111', 'Cookies'), 'another server\'s session')
  const old = new Date(NOW - 9 * DAY)
  for (const f of ['cef_debug.log.1', 'Cookies', '']) fs.utimesSync(path.join(root, 'CEFTemp111', f), old, old)
  const said = []
  const r = cleanCefTemp({ root, now: NOW, log: l => said.push(l) })
  assert.deepStrictEqual(r.removed.sort(), ['CEFTemp111', 'CEFTemp222'])
  assert.deepStrictEqual(fs.readdirSync(root).sort(), ['CEFTemp111', 'CEFTemp222', 'CEFTemp333', 'CEFTemp444', 'NotCef'])
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'CEFTemp111')).sort(), ['Cache', 'Cookies'])
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'CEFTemp222')), ['Cache'])
  assert.ok(fs.existsSync(path.join(root, 'CEFTemp333', 'cef_debug.log')), 'a recent folder keeps its log')
  assert.ok(fs.existsSync(path.join(root, 'NotCef', 'cef_debug.log')), 'a folder not named CEFTemp is never touched')
  assert.ok(r.bytes >= 4096)
  assert.ok(said.some(l => /removed the stale browser debug log in 2 folder/.test(l)))
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('a folder whose log was written recently counts as in use, however old the folder', () => {
  const { tmp, root } = scratch()
  const dir = folder(root, 'CEFTemp555', 10 * DAY)
  const recent = new Date(NOW - 60 * 1000)
  fs.utimesSync(path.join(dir, 'cef_debug.log'), recent, recent)
  assert.deepStrictEqual(staleCefTempFolders(root, NOW), [])
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('the threshold is three days', () => {
  assert.strictEqual(STALE_MS, 3 * DAY)
  const { tmp, root } = scratch()
  folder(root, 'CEFTemp1', 3 * DAY - 60 * 1000)
  assert.deepStrictEqual(staleCefTempFolders(root, NOW), [])
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('no Skyrim Platform folder at all is fine', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ceftemp-test-'))
  assert.deepStrictEqual(cleanCefTemp({ root: cefTempRoot(tmp), now: NOW }), { removed: [], failed: [], bytes: 0 })
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('the launcher cleans them before a launch, only once it knows the game is not running', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8')
  const guard = src.slice(src.indexOf('async function guardLaunch('), src.indexOf('ipcMain.handle(\'game:isRunning\''))
  const running = guard.indexOf('await gameProcessRunning()')
  const clean = guard.indexOf('cefTemp.cleanCefTemp(')
  assert.ok(running > 0 && clean > running && clean < guard.indexOf('await launch()'))
})
