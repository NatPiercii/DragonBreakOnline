'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { dropUiLines, scrub } = require('../sources/scrubLog')

test('the game UI lines are left out of skyrim-platform.log', () => {
  const log = [
    '[10:00:00:000] SkyrimPlatform loaded',
    '[10:00:01:120] JS window.chat.push("Arvel: meet me at the inn") ...',
    '[10:00:01:130] JS window.chat.push("[PM] Brelyna: the key is under the mat") ...',
    '[10:00:02:000] LoadUrl file:///Data/Platform/UI/index.html?voice=wss://example/room',
    '[10:00:03:000] [Exception] TypeError: x is undefined',
    '[10:00:04:000] JS  ...',
  ].join('\r\n')
  const out = scrub(dropUiLines(log)).text
  assert.doesNotMatch(out, /Arvel|Brelyna|LoadUrl|voice=/)
  assert.match(out, /SkyrimPlatform loaded/)
  assert.match(out, /\[3 UI line\(s\) left out\]\n\[10:00:03:000\] \[Exception\] TypeError/)
  assert.match(out, /\[1 UI line\(s\) left out\]$/)
})

test('a line that only mentions JS is kept', () => {
  const log = '[10:00:00:000] Loaded JS plugin skymp5-client.js\n[10:00:00:001] JSON parse failed'
  assert.strictEqual(dropUiLines(log), log)
})
