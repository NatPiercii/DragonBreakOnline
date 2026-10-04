'use strict'
// Mouse buttons as hotkeys (#suggestions 'Keybinds', Jake 2026-10-04: push-to-talk on a side mouse button), for the page
// and the tests. Skyrim numbers mouse buttons as DxScanCode 256 + the DirectInput button index (SkyrimPlatform
// ConstEnumApi: 256 left, 257 right, 258 middle, 259 MouseButton3 = Mouse 4, 260 MouseButton4 = Mouse 5).
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.dboHotkeyMouse = api
})(typeof self !== 'undefined' ? self : this, function () {
  // MouseEvent.button -> [DirectInput code, label]: 1 middle, 3 back (Mouse 4), 4 forward (Mouse 5). Left (0) and
  // right (2) are attack and block in game, so they are never offered.
  const MOUSE_TABLE = { 1: [258, 'Middle Mouse'], 3: [259, 'Mouse 4'], 4: [260, 'Mouse 5'] }
  // The hotkeys whose game-side handler accepts a mouse button (skymp5-client voiceService)
  const MOUSE_HOTKEY_IDS = ['hk-voice-ptt']

  function mouseEntry(button) { return MOUSE_TABLE[button] || null }
  function mouseLabel(code) {
    for (const [dik, label] of Object.values(MOUSE_TABLE)) if (dik === code) return label
    return null
  }
  function acceptsMouse(id) { return MOUSE_HOTKEY_IDS.includes(id) }
  // What a mouse press during a capture does: 'cancel' (left: the click goes on to what it was meant for),
  // 'refuse' (right, or an unknown button) or 'bind' with the code
  function onCaptureMouse(button) {
    if (button === 0) return { action: 'cancel' }
    const entry = mouseEntry(button)
    if (!entry) return { action: 'refuse', message: button === 2 ? 'Left and right click are attack and block' : 'Unsupported button' }
    return { action: 'bind', code: entry[0], label: entry[1] }
  }

  return { MOUSE_TABLE, MOUSE_HOTKEY_IDS, mouseEntry, mouseLabel, acceptsMouse, onCaptureMouse }
})
