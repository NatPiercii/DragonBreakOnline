'use strict'
// The Terms and Privacy window (src/renderer/legal.js) in a small fake DOM: read both, tick, accept; decline; retry; re-prompt
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { parseMarkdown } = require('../src/legalMarkdown')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'legal.js'), 'utf8')
const IDS = ['modal-legal', 'legal-body', 'legal-doc-terms', 'legal-doc-privacy', 'legal-read-terms', 'legal-read-privacy', 'legal-agree',
  'legal-accept', 'legal-retry', 'legal-hint', 'legal-source', 'legal-footer', 'legal-changes', 'legal-changes-list', 'legal-decline',
  'legal-close', 'btn-legal']

class El {
  constructor(tag) {
    Object.assign(this, { tagName: tag, children: [], listeners: {}, hidden: false, disabled: false, checked: false, dataset: {}, className: '', own: '' })
    Object.assign(this, { scrollTop: 0, clientHeight: 100, scrollHeight: 100 })
    const set = new Set()
    this.classList = { toggle: (c, on) => (on ? set.add(c) : set.delete(c)), contains: c => set.has(c) }
  }
  appendChild(c) { this.children.push(c); return c }
  get textContent() { return this.own + this.children.map(c => c.textContent).join('') }
  set textContent(v) { this.own = String(v); this.children = [] }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) }
  fire(type, extra = {}) { for (const fn of this.listeners[type] || []) fn({ target: this, key: extra.key, preventDefault() {} }) }
  focus() {}
  createTHead() { return this.appendChild(new El('thead')) }
  createTBody() { return this.appendChild(new El('tbody')) }
  find(pred) { return pred(this) ? this : this.children.map(c => (c.find ? c.find(pred) : null)).find(Boolean) || null }
}

const DOC = (version, extra = {}) => ({
  source: 'server', version, effective: '2026-10-01', changes: ['Voice chat is now recorded for moderation.'],
  terms: parseMarkdown('# Terms of Service\n\nSee [the rules](https://dragonbreakonline.com/guides/rules.html) or [mail us](mailto:a@b.co).\n\n<img src=x onerror=alert(1)>'),
  privacy: parseMarkdown('# Privacy Policy\n\n| A | B |\n|---|--:|\n| 1 | 2 |'),
  ...extra,
})

function load({ status, doc = DOC('v2'), accept = [{ ok: true }] }) {
  const els = Object.fromEntries(IDS.map(id => [id, new El('div')]))
  els['modal-legal'].hidden = true
  els['legal-footer'].hidden = true
  const tabs = ['terms', 'privacy'].map(k => Object.assign(new El('button'), { dataset: { legalTab: k } }))
  const docListeners = {}
  const calls = { accept: [], external: [], status: 0, load: 0 }
  const answers = { status: [].concat(status), accept: [].concat(accept), doc: [].concat(doc) }
  const next = (list) => (list.length > 1 ? list.shift() : list[0])
  const window = {
    electronAPI: {
      legalStatus: async () => { calls.status++; return next(answers.status) },
      legalLoad: async () => { calls.load++; return next(answers.doc) },
      legalAccept: async (v) => { calls.accept.push(v); return next(answers.accept) },
      openExternal: url => calls.external.push(url),
    },
    addEventListener: () => {},
  }
  const document = {
    getElementById: id => els[id],
    querySelectorAll: sel => (sel === '[data-legal-tab]' ? tabs : []),
    createElement: tag => new El(tag),
    createTextNode: v => ({ textContent: String(v) }),
    addEventListener: (type, fn) => { docListeners[type] = fn },
  }
  vm.runInNewContext(SRC, { window, document })
  const changes = []
  window.dboLegal.init({ onChange: e => changes.push(e || null) })
  const body = els['legal-body']
  // A long document: the bottom is reached only by scrolling
  const scrollToEnd = () => { body.scrollHeight = 1000; body.scrollTop = 900; body.fire('scroll') }
  const settle = () => new Promise(r => setImmediate(r))
  return { legal: window.dboLegal, els, tabs, calls, changes, body, scrollToEnd, settle, escape: () => docListeners.keydown({ key: 'Escape' }) }
}

const REQUIRED = { state: 'required', version: 'v2', lastAcceptedVersion: null, required: false }

test('a first prompt opens by itself; Accept waits for both documents read to the end and the box ticked', async () => {
  const w = load({ status: REQUIRED })
  w.body.scrollHeight = 1000
  await w.legal.check()
  await w.settle()
  assert.strictEqual(w.els['modal-legal'].hidden, false)
  assert.strictEqual(w.els['legal-footer'].hidden, false)
  assert.strictEqual(w.els['legal-changes'].hidden, true, 'no "what changed" on a first prompt')
  assert.strictEqual(w.legal.blocking(), true)
  assert.strictEqual(w.els['legal-accept'].disabled, true)
  assert.match(w.els['legal-hint'].textContent, /Read the Terms of Service and the Privacy Policy to the end/)

  w.scrollToEnd()
  w.els['legal-agree'].checked = true
  w.els['legal-agree'].fire('change')
  assert.strictEqual(w.els['legal-accept'].disabled, true, 'the Privacy Policy is still unread')
  assert.match(w.els['legal-hint'].textContent, /Read the Privacy Policy/)
  assert.strictEqual(w.els['legal-read-terms'].textContent, ' ✓')

  w.tabs[1].fire('click')
  assert.strictEqual(w.els['legal-doc-privacy'].hidden, false)
  assert.strictEqual(w.els['legal-doc-terms'].hidden, true)
  assert.strictEqual(w.body.scrollTop, 0)
  w.scrollToEnd()
  assert.strictEqual(w.els['legal-accept'].disabled, false)

  w.els['legal-accept'].fire('click')
  await w.settle()
  assert.deepStrictEqual(w.calls.accept, ['v2'])
  assert.strictEqual(w.els['modal-legal'].hidden, true)
  assert.strictEqual(w.legal.blocking(), false)
})

test('ticking the box first is not enough, and unticking takes Accept away again', async () => {
  const w = load({ status: REQUIRED })
  w.body.scrollHeight = 1000
  await w.legal.check()
  await w.settle()
  w.els['legal-agree'].checked = true
  w.els['legal-agree'].fire('change')
  assert.strictEqual(w.els['legal-accept'].disabled, true)
  w.scrollToEnd(); w.tabs[1].fire('click'); w.scrollToEnd()
  assert.strictEqual(w.els['legal-accept'].disabled, false)
  w.els['legal-agree'].checked = false
  w.els['legal-agree'].fire('change')
  assert.strictEqual(w.els['legal-accept'].disabled, true)
  assert.match(w.els['legal-hint'].textContent, /Tick the box/)
})

test('Decline, the close button and Escape leave Play off with a line saying why; the footer link reopens it', async () => {
  for (const how of ['legal-decline', 'legal-close', 'escape']) {
    const w = load({ status: REQUIRED })
    await w.legal.check()
    await w.settle()
    if (how === 'escape') w.escape()
    else w.els[how].fire('click')
    assert.strictEqual(w.els['modal-legal'].hidden, true, how)
    assert.strictEqual(w.legal.blocking(), true)
    assert.match(w.legal.message(), /You declined .* Press Terms & Privacy below/)
    assert.ok(w.legal.messages().includes(w.legal.message()))
    // A later check does not push the window back up; the link does
    await w.legal.check()
    await w.settle()
    assert.strictEqual(w.els['modal-legal'].hidden, true)
    w.els['btn-legal'].fire('click')
    await w.settle()
    assert.strictEqual(w.els['modal-legal'].hidden, false)
    assert.strictEqual(w.els['legal-footer'].hidden, false)
  }
})

test('a failed accept keeps the window, says so and offers Retry, which then succeeds', async () => {
  const w = load({ status: REQUIRED, accept: [{ ok: false, error: 'Request timed out' }, { ok: true }] })
  await w.legal.check()
  await w.settle()
  w.els['legal-agree'].checked = true
  w.els['legal-agree'].fire('change')
  w.scrollToEnd(); w.tabs[1].fire('click'); w.scrollToEnd()
  w.els['legal-accept'].fire('click')
  await w.settle()
  assert.strictEqual(w.els['modal-legal'].hidden, false)
  assert.strictEqual(w.legal.blocking(), true)
  assert.match(w.els['legal-hint'].textContent, /could not be sent \(Request timed out\).*Retry/)
  assert.strictEqual(w.els['legal-accept'].textContent, 'Retry')
  assert.strictEqual(w.els['legal-accept'].disabled, false)
  w.els['legal-accept'].fire('click')
  await w.settle()
  assert.deepStrictEqual(w.calls.accept, ['v2', 'v2'])
  assert.strictEqual(w.els['modal-legal'].hidden, true)
})

test('a re-prompt shows what changed at the top', async () => {
  const w = load({ status: { ...REQUIRED, lastAcceptedVersion: 'v1' } })
  await w.legal.check()
  await w.settle()
  assert.strictEqual(w.els['legal-changes'].hidden, false)
  assert.strictEqual(w.els['legal-changes-list'].textContent, 'Voice chat is now recorded for moderation.')
})

test('the bundled copy of an older version can be read but not accepted; Retry loads the current one', async () => {
  const w = load({ status: REQUIRED, doc: [DOC('v1', { source: 'bundled', error: 'offline' }), DOC('v2')] })
  await w.legal.check()
  await w.settle()
  assert.strictEqual(w.els['legal-source'].hidden, false)
  assert.match(w.els['legal-source'].textContent, /copy that came with the launcher/)
  assert.strictEqual(w.els['legal-retry'].hidden, false)
  w.els['legal-agree'].checked = true
  w.els['legal-agree'].fire('change')
  w.scrollToEnd(); w.tabs[1].fire('click'); w.scrollToEnd()
  assert.strictEqual(w.els['legal-accept'].disabled, true)
  assert.match(w.els['legal-hint'].textContent, /current version could not be loaded/)
  w.els['legal-retry'].fire('click')
  await w.settle()
  assert.strictEqual(w.els['legal-retry'].hidden, true)
  assert.strictEqual(w.els['legal-source'].hidden, true)
})

test('accepted, signed out or unchecked: the link opens the texts to read, with no Accept, and a click outside closes them', async () => {
  for (const state of ['accepted', 'signedOut', 'notDeployed', 'error']) {
    const w = load({ status: { state, version: 'v2' } })
    await w.legal.check()
    await w.settle()
    assert.strictEqual(w.els['modal-legal'].hidden, true, state)
    assert.strictEqual(w.legal.blocking(), false, state)
    w.els['btn-legal'].fire('click')
    await w.settle()
    assert.strictEqual(w.els['modal-legal'].hidden, false)
    assert.strictEqual(w.els['legal-footer'].hidden, true)
    w.els['modal-legal'].fire('click')
    assert.strictEqual(w.els['modal-legal'].hidden, true)
  }
})

test('document text is built as text nodes, web links open in the browser and mail links stay text', async () => {
  const w = load({ status: { state: 'accepted', version: 'v2' } })
  w.els['btn-legal'].fire('click')
  await w.settle()
  const terms = w.els['legal-doc-terms']
  assert.match(terms.textContent, /<img src=x onerror=alert\(1\)>/)
  assert.strictEqual(terms.find(e => e.tagName === 'img'), null)
  const a = terms.find(e => e.tagName === 'a')
  assert.strictEqual(a.textContent, 'the rules')
  a.fire('click')
  assert.deepStrictEqual(w.calls.external, ['https://dragonbreakonline.com/guides/rules.html'])
  assert.strictEqual(terms.find(e => e.className === 'legal-plain-link').textContent, 'mail us')
  const cell = w.els['legal-doc-privacy'].find(e => e.tagName === 'th' && e.className === 'al-r')
  assert.strictEqual(cell.textContent, 'B')
})

test('an expired login during the check or the accept is passed on, and signing out closes a pending window', async () => {
  const w = load({ status: [REQUIRED, { state: 'signedOut', sessionExpired: true }], accept: { ok: false, sessionExpired: true } })
  await w.legal.check()
  await w.settle()
  w.legal.reset()
  assert.strictEqual(w.els['modal-legal'].hidden, true)
  assert.strictEqual(w.legal.blocking(), false)
  await w.legal.check()
  // The object comes from the window's own realm, so its field is compared, not its prototype
  assert.strictEqual(w.changes[w.changes.length - 1].sessionExpired, true)
})
