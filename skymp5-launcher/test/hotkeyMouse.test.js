'use strict'
// Mouse buttons as hotkeys (#suggestions 'Keybinds'): which buttons bind, their DirectInput codes and labels
const test = require('node:test')
const assert = require('node:assert')
const m = require('../src/renderer/hotkeyMouse')

test('middle and side buttons map to Skyrim DxScanCode (256 + DirectInput index)', () => {
  assert.deepStrictEqual(m.mouseEntry(1), [258, 'Middle Mouse'])
  assert.deepStrictEqual(m.mouseEntry(3), [259, 'Mouse 4'])
  assert.deepStrictEqual(m.mouseEntry(4), [260, 'Mouse 5'])
})

test('left and right click are never offered: they are attack and block', () => {
  assert.strictEqual(m.mouseEntry(0), null)
  assert.strictEqual(m.mouseEntry(2), null)
  assert.deepStrictEqual(m.onCaptureMouse(2), { action: 'refuse', message: 'Left and right click are attack and block' })
  assert.strictEqual(m.onCaptureMouse(7).action, 'refuse')
})

test('a left click during a capture cancels it and goes through (Save, Close and the other buttons still work)', () => {
  assert.deepStrictEqual(m.onCaptureMouse(0), { action: 'cancel' })
})

test('a side button during a capture binds its code', () => {
  assert.deepStrictEqual(m.onCaptureMouse(4), { action: 'bind', code: 260, label: 'Mouse 5' })
})

test('labels for a saved mouse code, nothing for a key code', () => {
  assert.strictEqual(m.mouseLabel(259), 'Mouse 4')
  assert.strictEqual(m.mouseLabel(47), null)
})

test('only push-to-talk takes a mouse button (the client handles it there)', () => {
  assert.strictEqual(m.acceptsMouse('hk-voice-ptt'), true)
  assert.strictEqual(m.acceptsMouse('hk-chat'), false)
  assert.strictEqual(m.acceptsMouse('ghk-jump'), false)
})

test('the page loads hotkeyMouse.js before renderer.js, and the picker uses it', () => {
  const fs = require('fs'); const path = require('path')
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8')
  const mouseTag = html.indexOf('<script src="hotkeyMouse.js">'), rendererTag = html.indexOf('<script src="renderer.js">')
  assert.ok(mouseTag > 0 && mouseTag < rendererTag, `script order ${mouseTag} ${rendererTag}`)
  const r = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8')
  assert.ok(/window\.dboHotkeyMouse/.test(r) && /HOTKEY_MOUSE\.onCaptureMouse\(/.test(r) && /addEventListener\('mousedown', onMouse/.test(r))
})
