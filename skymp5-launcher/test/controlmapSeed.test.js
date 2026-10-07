'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

// The launcher seeds this file into the game's Data/Interface/Controls/PC/controlmap.txt. The game's parser needs
// CRLF: with LF-only endings it stops at the first context break, so every context after Gameplay is lost and
// keybinds, the menu cursor and the voice keys stop working. A Linux launcher build has shipped an LF-only seed
// twice (2.1.31 and again on main after the launcher line diverged), which is why this is a test and not a comment.
const SEED = path.join(__dirname, '..', 'assets', 'controlmap.txt')

test('the controlmap seed is CRLF throughout', () => {
  const buf = fs.readFileSync(SEED)
  const lf = buf.filter(b => b === 0x0a).length
  const crlf = buf.filter((b, i) => b === 0x0a && buf[i - 1] === 0x0d).length
  assert.ok(lf > 0, 'the seed has no lines at all')
  assert.strictEqual(crlf, lf, `${lf - crlf} of ${lf} lines are LF-only; the game would lose every context after Gameplay`)
})

test('the seed still declares every input context the game expects', () => {
  const text = fs.readFileSync(SEED, 'utf8')
  // A truncated or re-saved seed is the other way this file has broken, so check the contexts are all present.
  for (const ctx of ['Gameplay', 'Menu Mode', 'Console', 'Cursor', 'Favorites']) {
    assert.ok(text.includes(ctx), `the "${ctx}" context is missing from the seed`)
  }
})
