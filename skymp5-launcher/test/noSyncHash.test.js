'use strict'
// Up to 2.1.34 a Nexus "Mod Manager Download" was hashed synchronously in the main process once it landed (and so was
// every archive the install found already downloaded), so a multi-GB archive froze the window until Windows offered to
// close it: "I can only download 2 mods at a time before the launcher crashes" (thedirthawk, 2026-09-30). 2.1.36 hashes
// them in the background (1150da33). This keeps a synchronous hash from coming back into the main process.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8')

test('main.js never hashes an archive synchronously', () => {
  const sync = main.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\bmo2\.(verifyArchive|sha256File)\s*\(/.test(l))
  assert.deepStrictEqual(sync.map(([n, l]) => `main.js:${n}: ${l.trim()}`), [])
})

test('a Nexus link download is verified in the background', () => {
  const from = main.indexOf('async function handleNxmLinkNow(')
  assert.ok(from >= 0, 'handleNxmLinkNow is in main.js')
  const body = main.slice(from, main.indexOf('\n}\n', from))
  assert.match(body, /await mo2\.verifyArchiveAsync\(/)
  assert.match(body, /await nexus\.downloadWithKey\(/)
})

test('Nexus links are handled one at a time, and a failed one is logged, not thrown', () => {
  assert.match(main, /nxmQueue = nxmQueue\.then\(\(\) => handleNxmLinkNow\(link\)\)\.catch\(/)
})
