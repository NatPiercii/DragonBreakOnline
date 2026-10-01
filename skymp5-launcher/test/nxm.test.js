'use strict'
// nxm:// links: the launcher holds them only while an install waits for Nexus downloads, hands them back to Vortex (or
// whichever manager had them), and passes on the links it has no use for. A fake reg.exe keeps the registry in a Map.
const test = require('node:test')
const assert = require('node:assert')
const { createNxm, parseRegDefault, splitCommand, forwardCommand, isOwnCommand, classify, USER_KEY, USER_CMD, MACHINE_CMD } = require('../src/nxm')

const LAUNCHER = 'C:\\Users\\p\\AppData\\Local\\Programs\\DragonBreak Launcher\\DragonBreak Launcher.exe'
const MO2_HANDLER = 'C:\\DragonBreak\\nxmhandler.exe'
const VORTEX_EXE = 'C:\\Program Files\\Black Tree Gaming Ltd\\Vortex\\Vortex.exe'
const VORTEX = `"${VORTEX_EXE}" -d "%1"`
const FILE_LINK = 'nxm://skyrimspecialedition/mods/12604/files/421690?key=abc&expires=1790000000&user_id=1'
const COLLECTION = 'nxm://skyrimspecialedition/collections/abcdef/revisions/7'

const regOut = value => `\r\nHKEY_CURRENT_USER\\Software\\Classes\\nxm\\shell\\open\\command\r\n    (Default)    REG_SZ    ${value}\r\n\r\n`

// A registry of default values by key; reg add/delete/query as nxm.js calls them
function fakeWindows({ user = null, machine = null, files = [VORTEX_EXE] } = {}) {
  const keys = new Map()
  if (user) keys.set(USER_CMD, user)
  if (machine) keys.set(MACHINE_CMD, machine)
  const calls = [], spawned = []
  const run = (file, args) => {
    assert.equal(file, 'reg')
    calls.push(args)
    const [op, key] = args
    if (op === 'query') {
      if (!keys.has(key)) throw Object.assign(new Error('not found'), { status: 1 })
      return Buffer.from(regOut(keys.get(key)))
    }
    if (op === 'add') { if (args[2] === '/ve') keys.set(key, args[4]); return Buffer.alloc(0) }
    if (op === 'delete') { for (const k of [...keys.keys()]) if (k === key || k.startsWith(`${key}\\`)) keys.delete(k); return Buffer.alloc(0) }
    throw new Error(`unexpected reg ${op}`)
  }
  const spawnFn = (file, args, opts) => {
    spawned.push({ file, args, opts })
    return { on() { return this }, unref() {} }
  }
  const data = new Map()
  const store = { get: k => data.get(k), set: (k, v) => data.set(k, v), delete: k => data.delete(k) }
  const logs = []
  const nxm = createNxm({ store, log: m => logs.push(m), ownExes: () => [LAUNCHER, MO2_HANDLER], run, spawnFn, exists: f => files.includes(f), platform: 'win32', now: () => 0 })
  return { nxm, keys, calls, spawned, store, logs, user: () => keys.get(USER_CMD) || null }
}

test('reg query output: the default value, in any language, or null', () => {
  assert.equal(parseRegDefault(regOut(VORTEX)), VORTEX)
  assert.equal(parseRegDefault(regOut(VORTEX).replace('(Default)', '(Standard)')), VORTEX)
  assert.equal(parseRegDefault(regOut(VORTEX).replace('(Default)', '(Par défaut)')), VORTEX)
  assert.equal(parseRegDefault('\r\nHKEY_CURRENT_USER\\x\r\n    (Default)    REG_SZ    \r\n'), null)
  assert.equal(parseRegDefault(''), null)
})

test('a registered command becomes the program and its arguments, with the link for %1', () => {
  assert.deepEqual(splitCommand(VORTEX), [VORTEX_EXE, '-d', '%1'])
  assert.deepEqual(forwardCommand(VORTEX, FILE_LINK), { file: VORTEX_EXE, args: ['-d', FILE_LINK] })
  assert.deepEqual(forwardCommand('"C:\\Mod Organizer\\nxmhandler.exe" "%1"', COLLECTION), { file: 'C:\\Mod Organizer\\nxmhandler.exe', args: [COLLECTION] })
  assert.deepEqual(forwardCommand('C:\\tools\\handler.exe', COLLECTION), { file: 'C:\\tools\\handler.exe', args: [COLLECTION] }, 'no %1: the link goes last')
  assert.equal(forwardCommand('', COLLECTION), null)
})

test('our own commands: this launcher, another copy of it, the portable nxmhandler; never Vortex or another MO2', () => {
  assert.equal(isOwnCommand(`"${LAUNCHER}" "%1"`, [LAUNCHER, MO2_HANDLER]), true)
  assert.equal(isOwnCommand(`"${LAUNCHER.toUpperCase()}" "%1"`, [LAUNCHER, MO2_HANDLER]), true)
  assert.equal(isOwnCommand('"D:\\Old\\DragonBreak Launcher.exe" "%1"', [LAUNCHER, MO2_HANDLER]), true)
  assert.equal(isOwnCommand(`"${MO2_HANDLER}" "%1"`, [LAUNCHER, MO2_HANDLER]), true)
  assert.equal(isOwnCommand('"C:\\Modding\\MO2\\nxmhandler.exe" "%1"', [LAUNCHER, MO2_HANDLER]), false)
  assert.equal(isOwnCommand(VORTEX, [LAUNCHER, MO2_HANDLER]), false)
})

test('links: a Skyrim SE mod file, anything else, or refused', () => {
  assert.equal(classify(FILE_LINK), 'file')
  assert.equal(classify(COLLECTION), 'other')
  assert.equal(classify('nxm://fallout4/mods/1/files/2?key=a&expires=1'), 'other')
  assert.equal(classify('nxm://skyrimspecialedition/mods/1/files/2" & calc'), 'bad')
  assert.equal(classify('nxm://skyrimspecialedition/mods/1 /files/2'), 'bad')
  assert.equal(classify('https://www.nexusmods.com/'), 'bad')
})

test('an install that waits takes the links from Vortex and gives them back after', () => {
  const w = fakeWindows({ user: VORTEX })
  assert.equal(w.nxm.claim(LAUNCHER), true)
  assert.equal(w.user(), `"${LAUNCHER}" "%1"`)
  assert.deepEqual(w.store.get('nxmPrevious'), { scope: 'user', command: VORTEX })
  assert.equal(w.nxm.claimed(), true)
  assert.equal(w.nxm.release(), 'Vortex.exe')
  assert.equal(w.user(), VORTEX)
  assert.equal(w.nxm.claimed(), false)
  assert.equal(w.store.get('nxmPrevious'), undefined)
  // a second install run does the same again
  w.nxm.claim(LAUNCHER)
  w.nxm.claim(LAUNCHER)
  assert.deepEqual(w.store.get('nxmPrevious'), { scope: 'user', command: VORTEX }, 'a claim over our own key keeps the manager from before')
  w.nxm.release()
  assert.equal(w.user(), VORTEX)
})

test('with no other manager the links stay with the launcher', () => {
  const w = fakeWindows()
  w.nxm.claim(LAUNCHER)
  assert.equal(w.nxm.release(), null)
  assert.equal(w.user(), `"${LAUNCHER}" "%1"`)
  assert.equal(w.calls.some(a => a[0] === 'delete'), false)
})

test('a machine-wide manager hidden by our key gets the links back when the key goes', () => {
  const w = fakeWindows({ machine: VORTEX })
  w.nxm.claim(LAUNCHER)
  assert.deepEqual(w.store.get('nxmPrevious'), { scope: 'machine', command: VORTEX })
  assert.equal(w.nxm.release(), 'Vortex.exe')
  assert.equal(w.user(), null)
  assert.deepEqual(w.calls.at(-1), ['delete', USER_KEY, '/f'])
})

test('launchers up to 2.1.29: our key over a machine-wide Vortex is removed at start; over a per-user one it stays', () => {
  const machine = fakeWindows({ user: `"${LAUNCHER}" "%1"`, machine: VORTEX })
  assert.equal(machine.nxm.release(), 'Vortex.exe')
  assert.equal(machine.user(), null)
  const perUser = fakeWindows({ user: `"${LAUNCHER}" "%1"` })
  assert.equal(perUser.nxm.release(), null, 'what it replaced was never kept: the player turns Vortex\'s link handling back on')
  assert.equal(perUser.user(), `"${LAUNCHER}" "%1"`)
})

test('the links are left alone when the player gave them back to Vortex already, or Vortex is gone', () => {
  const w = fakeWindows({ user: VORTEX })
  w.nxm.claim(LAUNCHER)
  w.keys.set(USER_CMD, VORTEX)
  assert.equal(w.nxm.release(), null)
  assert.equal(w.user(), VORTEX)
  const gone = fakeWindows({ user: VORTEX, files: [] })
  gone.nxm.claim(LAUNCHER)
  assert.equal(gone.nxm.release(), null, 'no dead handler is put back')
  assert.equal(gone.user(), `"${LAUNCHER}" "%1"`)
})

test('links the launcher has no use for go on to Vortex, once, without a shell', () => {
  const w = fakeWindows({ user: VORTEX })
  w.nxm.claim(LAUNCHER)
  assert.equal(w.nxm.forward(COLLECTION), 'Vortex.exe')
  assert.deepEqual(w.spawned[0].file, VORTEX_EXE)
  assert.deepEqual(w.spawned[0].args, ['-d', COLLECTION])
  assert.equal(w.spawned[0].opts.shell, undefined)
  assert.equal(w.nxm.forward(COLLECTION), null, 'the same link straight back is not passed round again')
  assert.equal(w.nxm.forward('nxm://skyrimspecialedition/mods/1/files/2" & calc'), null)
  assert.equal(w.spawned.length, 1)
})

test('nothing is passed on to ourselves, to a missing program, or when no manager was there', () => {
  const none = fakeWindows()
  none.nxm.claim(LAUNCHER)
  assert.equal(none.nxm.forward(COLLECTION), null)
  const self = fakeWindows()
  self.store.set('nxmPrevious', { scope: 'user', command: '"D:\\Old\\DragonBreak Launcher.exe" "%1"' })
  assert.equal(self.nxm.forward(COLLECTION), null)
  const gone = fakeWindows({ user: VORTEX, files: [] })
  gone.nxm.claim(LAUNCHER)
  assert.equal(gone.nxm.forward(COLLECTION), null)
  assert.equal(none.spawned.length + self.spawned.length + gone.spawned.length, 0)
})

test('off Windows nothing touches a registry', () => {
  const calls = []
  const nxm = createNxm({ store: { get() {}, set() {}, delete() {} }, run: (...a) => calls.push(a), platform: 'linux' })
  assert.equal(nxm.claim(LAUNCHER), false)
  assert.equal(nxm.release(), null)
  assert.equal(nxm.forward(COLLECTION), null)
  assert.equal(calls.length, 0)
})
