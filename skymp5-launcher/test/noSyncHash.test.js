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
const mo2src = fs.readFileSync(path.join(__dirname, '..', 'src', 'mo2.js'), 'utf8')
const mo2 = require('../src/mo2')

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

// Guarding the call site is not enough: while a synchronous hash still EXISTS and is exported, one careless call brings
// the frozen window back. The capability itself is gone as of client-launcher-no-sync-hash, and this keeps it gone.
test('mo2.js has no synchronous file hashing at all', () => {
  const lines = mo2src.split('\n').map((l, i) => [i + 1, l])
  const readSync = lines.filter(([, l]) => /\bfs\.readSync\s*\(/.test(l))
  assert.deepStrictEqual(readSync.map(([n, l]) => `mo2.js:${n}: ${l.trim()}`), [], 'a readSync loop is how the blocking hash was built')
  const hashing = lines.filter(([, l]) => /createHash\s*\(/.test(l))
  for (const [n, l] of hashing) {
    // Every hash in mo2.js must be fed by a stream, never by a synchronous read
    const after = mo2src.slice(mo2src.indexOf(l), mo2src.indexOf(l) + 600)
    assert.match(after, /createReadStream/, `the hash at mo2.js:${n} must stream, not read synchronously`)
  }
})

test('mo2.js exports no synchronous hashing or verification', () => {
  const exported = Object.keys(mo2)
  assert.ok(!exported.includes('sha256File'), 'sha256File (blocking) must not be exported')
  assert.ok(!exported.includes('verifyArchive'), 'verifyArchive (blocking) must not be exported')
  assert.ok(exported.includes('sha256FileAsync') && exported.includes('verifyArchiveAsync'), 'the async pair is what callers get')
  // Nothing that hashes or verifies may be exported without saying it is async
  const suspects = exported.filter((k) => /^(sha256|verifyArchive)/.test(k) && !/Async$/.test(k))
  assert.deepStrictEqual(suspects, [], 'a hashing export with no Async in its name reads as safe when it is not')
})
