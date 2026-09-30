'use strict'
// data/legal: the texts players accept may change only with a new version, so no one is held to wording they never saw

const test   = require('node:test')
const assert = require('node:assert/strict')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')

require.cache[require.resolve('dotenv')] = { exports: { config: () => ({}) } }
delete process.env.LEGAL_DIR
const legal = require('../sources/legal')
const { record } = require('../scripts/legal-record')

const DIR = path.join(__dirname, '..', 'data', 'legal')

test('legal.json names a version, an effective date, what changed and the two texts', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'legal.json'), 'utf8'))
  const m = legal.validateManifest(manifest)
  assert.match(m.version, legal.VERSION_RE)
  assert.ok(m.changes.length >= 1)
  for (const f of [m.files.terms, m.files.privacy]) assert.match(fs.readFileSync(path.join(DIR, f), 'utf8'), /^# \S/, `${f} starts with its title`)
})

test('the texts are the ones recorded for this version (bump the version to change them)', () => {
  const { version, hashes } = legal.documentHashes(DIR)
  const recorded = legal.recordedHashes(DIR)[version]
  assert.ok(recorded, `version ${version} has no recorded hashes: run "npm run legal-record" in skymp5-backend`)
  for (const [file, hash] of Object.entries(hashes)) {
    assert.equal(hash, recorded[file],
      `${file} changed while legal.json still says version ${version}. Give legal.json a new version and "changes" lines ` +
      '(what changed, for the players asked to accept again), then run "npm run legal-record".')
  }
})

test('every recorded version keeps a hash for both texts', () => {
  const all = legal.recordedHashes(DIR)
  assert.ok(Object.keys(all).length >= 1)
  for (const [version, hashes] of Object.entries(all)) {
    assert.match(version, legal.VERSION_RE)
    assert.equal(Object.keys(hashes).length, 2, version)
    for (const h of Object.values(hashes)) assert.match(h, /^[0-9a-f]{64}$/, version)
  }
})

test('line endings and a BOM do not count as a change', () => {
  const text = fs.readFileSync(path.join(DIR, 'terms.md'), 'utf8')
  assert.equal(legal.sha256(`﻿${text.replace(/\n/g, '\r\n')}`), legal.sha256(text))
  assert.notEqual(legal.sha256(`${text} `), legal.sha256(text))
})

test('npm run legal-record records a version once and refuses new text under an old version', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-record-'))
  try {
    for (const f of ['legal.json', 'terms.md', 'privacy.md']) fs.copyFileSync(path.join(DIR, f), path.join(tmp, f))
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'legal.json'), 'utf8'))
    assert.equal(record(tmp).ok, true)
    assert.match(record(tmp).message, /already recorded/)
    fs.appendFileSync(path.join(tmp, 'privacy.md'), '\nA new paragraph.\n')
    const refused = record(tmp)
    assert.equal(refused.ok, false)
    assert.match(refused.message, /privacy\.md changed/)
    fs.writeFileSync(path.join(tmp, 'legal.json'), JSON.stringify({ ...manifest, version: 'next-version', changes: ['A new paragraph.'] }))
    assert.equal(record(tmp).ok, true)
    assert.deepEqual(Object.keys(legal.recordedHashes(tmp)).sort(), [manifest.version, 'next-version'].sort())
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})
