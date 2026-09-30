'use strict'
// legal.js: loading the texts (server, then the bundled copy), the status states, and accepting; the network is faked
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createLegal, readBundled, BASE } = require('../src/legal')

const API = 'https://api.test'
const DOC = { version: 'v2', effective: '2026-10-01', changes: ['Voice is recorded now.', 42, ''], terms: '# Terms\n\nBe kind.\n', privacy: '# Privacy\n\n* Discord ID\n' }
const httpError = (statusCode) => Object.assign(new Error(`HTTP ${statusCode}`), { statusCode })

function setup({ get = {}, post = null, session = 'tok' } = {}) {
  const calls = []
  const legal = createLegal({
    apiUrl: API,
    getSession: () => session,
    launcherVersion: '2.1.36',
    fetchJSON: async (url, headers = {}) => {
      calls.push({ method: 'GET', url, headers })
      const r = get[url.slice(API.length)]
      if (r instanceof Error) throw r
      if (r === undefined) throw httpError(404)
      return r
    },
    postJSON: async (url, body, headers) => {
      calls.push({ method: 'POST', url, body, headers })
      if (post instanceof Error) throw post
      return typeof post === 'function' ? post(body) : post
    },
  })
  return { legal, calls }
}

test('the texts come from the server path the public proxy forwards, parsed to blocks', async () => {
  assert.strictEqual(BASE, '/api/files/legal')
  const { legal, calls } = setup({ get: { [BASE]: DOC } })
  const doc = await legal.load()
  assert.strictEqual(doc.source, 'server')
  assert.strictEqual(doc.version, 'v2')
  assert.deepStrictEqual(doc.changes, ['Voice is recorded now.'])
  assert.strictEqual(doc.terms[0].type, 'heading')
  assert.strictEqual(doc.privacy[1].type, 'list')
  assert.deepStrictEqual(calls.map(c => c.url), [`${API}${BASE}`])
})

test('when the server cannot be reached the bundled copy is shown, and it names its own version', async () => {
  const { legal } = setup({ get: { [BASE]: new Error('getaddrinfo ENOTFOUND') } })
  const doc = await legal.load()
  assert.strictEqual(doc.source, 'bundled')
  assert.match(doc.error, /ENOTFOUND/)
  assert.strictEqual(doc.version, readBundled().version)
  assert.ok(doc.terms.length > 10 && doc.privacy.length > 10)
})

test('with no server and no bundled copy the window is told there is nothing to show', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-none-'))
  try {
    const legal = createLegal({ apiUrl: API, getSession: () => 'tok', fetchJSON: async () => { throw httpError(503) }, postJSON: async () => ({}), fallbackDir: dir })
    const none = await legal.load()
    assert.strictEqual(none.source, 'none')
    assert.match(none.error, /503/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a malformed reply is not shown as the current text', async () => {
  const { legal } = setup({ get: { [BASE]: { version: 'v2', terms: 5 } } })
  assert.strictEqual((await legal.load()).source, 'bundled')
})

test('the status sends the play session and reads accepted, required and the last accepted version', async () => {
  const { legal, calls } = setup({ get: { [`${BASE}/status`]: { accepted: false, version: 'v2', lastAcceptedVersion: 'v1', required: true } } })
  assert.deepStrictEqual(await legal.status(), { state: 'required', version: 'v2', lastAcceptedVersion: 'v1', required: true })
  assert.deepStrictEqual(calls[0].headers, { 'x-session': 'tok' })
  assert.strictEqual(legal.blocksLaunch(), true)

  const ok = setup({ get: { [`${BASE}/status`]: { accepted: true, version: 'v2', lastAcceptedVersion: 'v2', required: false } } })
  assert.strictEqual((await ok.legal.status()).state, 'accepted')
  assert.strictEqual(ok.legal.blocksLaunch(), false)
})

test('signed out, an expired login, a backend without the routes, or an error never hold a launch back', async () => {
  const signedOut = setup({ session: null })
  assert.deepStrictEqual(await signedOut.legal.status(), { state: 'signedOut' })
  assert.strictEqual(signedOut.calls.length, 0)

  const expired = setup({ get: { [`${BASE}/status`]: httpError(401) } })
  assert.deepStrictEqual(await expired.legal.status(), { state: 'signedOut', sessionExpired: true })

  const old = setup({ get: {} })
  assert.deepStrictEqual(await old.legal.status(), { state: 'notDeployed' })

  for (const failure of [httpError(502), new Error('Request timed out'), null]) {
    const broken = setup({ get: { [`${BASE}/status`]: failure === null ? { weird: true } : failure } })
    const s = await broken.legal.status()
    assert.strictEqual(s.state, 'error')
    assert.strictEqual(broken.legal.blocksLaunch(), false)
  }
})

test('accepting posts the version and the launcher version, and lifts the launch block only when confirmed', async () => {
  const { legal, calls } = setup({
    get: { [`${BASE}/status`]: { accepted: false, version: 'v2' } },
    post: body => ({ accepted: true, version: body.version, at: '2026-10-01T05:00:00.000Z', alreadyAccepted: false }),
  })
  await legal.status()
  assert.strictEqual(legal.blocksLaunch(), true)
  assert.deepStrictEqual(await legal.accept('v2'), { ok: true, at: '2026-10-01T05:00:00.000Z' })
  const p = calls.find(c => c.method === 'POST')
  assert.strictEqual(p.url, `${API}${BASE}/accept`)
  assert.deepStrictEqual(p.body, { version: 'v2', launcherVersion: '2.1.36' })
  assert.deepStrictEqual(p.headers, { 'x-session': 'tok' })
  assert.strictEqual(legal.blocksLaunch(), false)
})

test('a failed accept keeps the block and says why: version changed, login expired or network', async () => {
  const cases = [[httpError(409), { ok: false, versionChanged: true }], [httpError(401), { ok: false, sessionExpired: true }]]
  for (const [err, want] of cases) {
    const { legal } = setup({ get: { [`${BASE}/status`]: { accepted: false, version: 'v2' } }, post: err })
    await legal.status()
    assert.deepStrictEqual(await legal.accept('v2'), want)
  }
  const net = setup({ get: { [`${BASE}/status`]: { accepted: false, version: 'v2' } }, post: new Error('socket hang up') })
  await net.legal.status()
  assert.deepStrictEqual(await net.legal.accept('v2'), { ok: false, error: 'socket hang up' })
  assert.strictEqual(net.legal.blocksLaunch(), true)
  const unconfirmed = setup({ get: { [`${BASE}/status`]: { accepted: false, version: 'v2' } }, post: { accepted: true, version: 'v1' } })
  await unconfirmed.legal.status()
  assert.strictEqual((await unconfirmed.legal.accept('v2')).ok, false)
  assert.strictEqual(unconfirmed.legal.blocksLaunch(), true)
})

test('signing out forgets the answer', async () => {
  const { legal } = setup({ get: { [`${BASE}/status`]: { accepted: false, version: 'v2' } } })
  await legal.status()
  legal.reset()
  assert.strictEqual(legal.blocksLaunch(), false)
})
