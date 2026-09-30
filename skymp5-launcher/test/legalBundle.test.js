'use strict'
// The bundled Terms and Privacy copy, and the window's safety: no HTML sinks, and Electron's isolation settings unchanged
const test = require('node:test')
const assert = require('node:assert')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { readBundled } = require('../src/legal')
const { plainText } = require('../src/legalMarkdown')

const ROOT = path.join(__dirname, '..')
const BUNDLE = path.join(ROOT, 'assets', 'legal')
const norm = s => s.replace(/^﻿/, '').replace(/\r\n?/g, '\n')

test('the bundled copy names its version and both texts read as titled documents', () => {
  const doc = readBundled()
  assert.match(doc.version, /^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/)
  assert.match(doc.effective, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(doc.changes.length >= 1)
  assert.match(plainText(doc.terms[0].inline), /Terms of Service/)
  assert.match(plainText(doc.privacy[0].inline), /Privacy Policy/)
})

test('the bundled copy is the backend\'s current one', (t) => {
  const backend = path.join(ROOT, '..', 'skymp5-backend', 'data', 'legal')
  if (!fs.existsSync(path.join(backend, 'legal.json'))) return t.skip('skymp5-backend/data/legal is not on this branch')
  const hash = f => crypto.createHash('sha256').update(norm(fs.readFileSync(f, 'utf8'))).digest('hex')
  for (const f of ['legal.json', 'terms.md', 'privacy.md']) {
    assert.strictEqual(hash(path.join(BUNDLE, f)), hash(path.join(backend, f)), `assets/legal/${f} differs from skymp5-backend/data/legal/${f}: copy it over`)
  }
})

test('the window builds the texts without any HTML sink', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'legal.js'), 'utf8')
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment/)
})

test('the window keeps context isolation on, node integration off, and the page CSP', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')
  assert.match(main, /contextIsolation:\s*true/)
  assert.match(main, /nodeIntegration:\s*false/)
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8')
  assert.match(html, /Content-Security-Policy" content="default-src 'self';[^"]*script-src 'self';/)
  assert.ok(html.indexOf('src="legal.js"') < html.indexOf('src="renderer.js"'), 'legal.js loads before renderer.js')
})
