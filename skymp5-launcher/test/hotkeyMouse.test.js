'use strict'
// Settings, server hotkeys: each takes a mouse button (middle, back, forward) as well as a key, stored as 256 + the
// DirectInput button like the Skyrim Platform client's DxScanCode; the game hotkeys (controlmap) stay keyboard only.
// Runs the renderer's hotkey table and press-to-bind capture on a stub window and document.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8')
const from = src.indexOf('const KEY_TABLE = {')
const to = src.indexOf(';[...SERVER_HOTKEY_IDS, ...GAME_HOTKEY_IDS].forEach')
assert.ok(from > 0 && to > from, 'the hotkey section is where the test expects it')

function load() {
  const listeners = []
  const els = {}
  const el = (id) => els[id] || (els[id] = {
    id, dataset: {}, textContent: '', blur() {},
    classList: { set: new Set(), add(c) { this.set.add(c) }, remove(c) { this.set.delete(c) } },
  })
  const win = {
    addEventListener: (type, fn, opts) => listeners.push({ type, fn, capture: !!(opts && opts.capture) }),
    removeEventListener: (type, fn) => { const i = listeners.findIndex((l) => l.type === type && l.fn === fn); if (i >= 0) listeners.splice(i, 1) },
  }
  const ctx = { window: win, document: { getElementById: el }, setTimeout: () => 0, clearTimeout: () => {} }
  vm.createContext(ctx)
  vm.runInContext(src.slice(from, to) + '\n;globalThis.__t = { startCapture, endCapture, getKey, setKey, labelForCode, MOUSE_TABLE }', ctx)
  const fire = (type, props) => {
    const e = Object.assign({ prevented: false, stopped: false, preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true } }, props)
    for (const l of listeners.filter((x) => x.type === type)) l.fn(e)
    return e
  }
  return { t: ctx.__t, el, fire, listeners }
}

const SERVER_IDS = ['hk-chat', 'hk-cursor', 'hk-housing', 'hk-personal', 'hk-faction', 'hk-voice-ptt', 'hk-admin', 'hk-hide-ui', 'hk-skills', 'hk-emote', 'hk-nametag', 'hk-voice-mode', 'hk-mask']

test('every server hotkey binds the middle, back and forward buttons as 258, 259 and 260', () => {
  for (const id of SERVER_IDS) {
    for (const [button, code, label] of [[1, 258, 'Middle Mouse'], [3, 259, 'Mouse 4'], [4, 260, 'Mouse 5']]) {
      const { t, el, fire } = load()
      const btn = el(id)
      t.setKey(id, 47)
      t.startCapture(btn, true)
      assert.match(btn.textContent, /key or mouse button/, id)
      const e = fire('mousedown', { button })
      assert.ok(e.prevented && e.stopped, id)
      assert.strictEqual(t.getKey(id), code, id)
      assert.strictEqual(btn.textContent, label, id)
      // The press's mouseup and auxclick are kept from the page (back and forward navigate nothing)
      assert.ok(fire('mouseup', { button }).prevented, id)
      assert.ok(fire('auxclick', { button }).prevented, id)
    }
  }
})

test('left and right click do not bind and leave the capture running', () => {
  const { t, el, fire } = load()
  const btn = el('hk-voice-ptt')
  t.setKey('hk-voice-ptt', 47)
  t.startCapture(btn, true)
  for (const button of [0, 2]) assert.ok(!fire('mousedown', { button }).prevented)
  assert.strictEqual(btn.dataset.code, '47')
  assert.ok(btn.classList.set.has('hotkey-btn--capturing'))
  // A key still binds after that
  fire('keydown', { code: 'KeyG' })
  assert.strictEqual(t.getKey('hk-voice-ptt'), 34)
})

test('the game hotkeys (controlmap keyboard column) never listen for the mouse', () => {
  for (const id of ['ghk-activate', 'ghk-jump', 'ghk-sprint', 'ghk-sneak', 'ghk-shout', 'ghk-pov']) {
    const { t, el, fire, listeners } = load()
    const btn = el(id)
    t.setKey(id, 57)
    t.startCapture(btn, false)
    assert.ok(!listeners.some((l) => l.type === 'mousedown'), id)
    assert.doesNotMatch(btn.textContent, /mouse/)
    fire('mousedown', { button: 3 })
    assert.strictEqual(t.getKey(id), 57, id)
  }
})

test('Escape and a finished capture remove the mouse listener', () => {
  const { t, el, fire, listeners } = load()
  const btn = el('hk-voice-ptt')
  t.setKey('hk-voice-ptt', 47)
  t.startCapture(btn, true)
  assert.ok(listeners.some((l) => l.type === 'mousedown' && l.capture))
  fire('keydown', { code: 'Escape' })
  assert.ok(!listeners.some((l) => l.type === 'mousedown'))
  assert.strictEqual(t.getKey('hk-voice-ptt'), 47)
  fire('mousedown', { button: 3 })
  assert.strictEqual(t.getKey('hk-voice-ptt'), 47)
})

test('a saved mouse button shows its name; every code the client reads as a mouse button has one', () => {
  const { t } = load()
  assert.deepStrictEqual([258, 259, 260, 261, 262, 263].map(t.labelForCode),
    ['Middle Mouse', 'Mouse 4', 'Mouse 5', 'Mouse 6', 'Mouse 7', 'Mouse 8'])
  assert.strictEqual(t.labelForCode(47), 'V')
})

test('the save keeps any number, so a mouse code reaches the client settings file', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8')
  for (const [field, setting] of [['freeCursor', 'freeCursorKeyCode'], ['housing', 'housingMenuKeyCode'], ['faction', 'factionMenuKeyCode'],
    ['personal', 'personalMenuKeyCode'], ['voicePtt', 'voicePushToTalkKeyCode'], ['adminMenu', 'adminMenuKeyCode'], ['hideUi', 'hideUiKeyCode'],
    ['skills', 'masteryMenuKeyCode'], ['emote', 'emoteWheelKeyCode'], ['nametag', 'nametagKeyCode'], ['voiceMode', 'voiceModeKeyCode'], ['mask', 'maskToggleKeyCode']]) {
    assert.match(main, new RegExp(`if \\(typeof h\\.${field} === 'number'\\)\\s+\\{?\\s*c\\.${setting}\\s*=\\s*h\\.${field}`), field)
  }
  // The chat key goes out as [Enter, the key], which the client reads with Input.isKeyPressed (256+ is the mouse there)
  assert.match(main, /c\.chatFocusKeyCodes\s+= h\.chatFocus\.filter\(n => typeof n === 'number'\)/)
})
