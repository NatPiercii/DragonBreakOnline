'use strict'
// The shipped seed must end every line in CRLF like the vanilla map. A Linux checkout without the .gitattributes rule
// made it LF, and every launcher built on CT 115 from 27 Sep shipped that (the stuck menu cursor and the container
// crash all hit players who installed after). build-linux/afterPack.js checks the packed copy the same way.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { bareLfCount, analyzeControlmap } = require('../src/controlmapCheck')

test('assets/controlmap.txt is CRLF throughout and holds all 18 contexts', () => {
  const bytes = fs.readFileSync(path.join(__dirname, '..', 'assets', 'controlmap.txt'))
  const text = bytes.toString('utf8')
  assert.strictEqual(bareLfCount(text), 0, 'lines ending in LF only')
  assert.strictEqual((text.match(/\r\n/g) || []).length, 223)
  assert.ok(text.endsWith('\r\n'))
  assert.ok(analyzeControlmap(text).ok)
})

test('.gitattributes keeps the seed byte-exact on every checkout', () => {
  const rules = fs.readFileSync(path.join(__dirname, '..', '.gitattributes'), 'utf8')
  assert.match(rules, /^assets\/controlmap\.txt\s+-text\s*$/m)
})
