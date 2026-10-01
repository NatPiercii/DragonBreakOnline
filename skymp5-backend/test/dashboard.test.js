'use strict'
// website/dashboard.html's script against a small fake DOM, fed a real status and queue from the panel fixture

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { webcrypto } = require('crypto')
const { createServerStatus } = require('../sources/serverStatus')
const { createServerControl } = require('../sources/serverControl')
const { createPanelFixture, showOutput, PATH_RE } = require('./helpers/panelFixture')

const DASHBOARD = path.join(__dirname, '..', '..', 'website', 'dashboard.html')
const SCRIPT = (() => {
  const scripts = [...fs.readFileSync(DASHBOARD, 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])
  assert.equal(scripts.length, 1)
  return scripts[0]
})()
const short = sha => sha.slice(0, 8)
const AUTO = 'a push still restarts the game while auto-update is on'

// Just enough DOM for el(), $() and textContent; innerHTML throws, as the page must never use it
class FakeEl {
  constructor(tag) { Object.assign(this, { tag, kids: [], own: '', className: '', hidden: false }) }
  set textContent(v) { this.kids = []; this.own = String(v) }
  get textContent() { return this.own + this.kids.map(k => k.textContent).join('') }
  set innerHTML(_v) { throw new Error('innerHTML is not allowed') }
  append(...nodes) { for (const n of nodes) this.kids.push(typeof n === 'string' ? Object.assign(new FakeEl('#text'), { own: n }) : n) }
  addEventListener() {}
  setAttribute() {}
  showModal() { this.open = true }
  close() { this.open = false }
  focus() {}
}

// The page with main() parked on a sign-in fetch that never answers (unless fetch says otherwise), then one renderServer() with the given data
function load(status, queue, { fetch = () => new Promise(() => {}), setTimeout = () => 0 } = {}) {
  const byId = new Map()
  const $ = id => { if (!byId.has(id)) byId.set(id, new FakeEl('div')); return byId.get(id) }
  const document = { getElementById: $, createElement: tag => new FakeEl(tag), createElementNS: (_ns, tag) => new FakeEl(tag) }
  const ctx = vm.createContext({ document, fetch, crypto: webcrypto, setInterval: () => 0, clearInterval: () => {}, setTimeout, console, input: { status, queue } })
  vm.runInContext(SCRIPT, ctx)
  vm.runInContext('srv.status = input.status; srv.queue = input.queue; renderServer()', ctx)
  return { $, run: code => vm.runInContext(code, ctx), lines: id => $(id).kids.map(k => k.textContent) }
}
const render = (status, queue) => load(status, queue).lines

let F, status, S0, Q0
const wire = v => JSON.parse(JSON.stringify(v))

before(async () => {
  F = createPanelFixture('dbo-dashboard-')
  status = createServerStatus({
    config: F.config, markers: F.markers, getHeartbeat: () => ({ name: 'Test', maxPlayers: 50, online: 2, lastSeen: new Date().toISOString() }),
    run: async () => ({ stdout: showOutput({ ActiveEnterTimestamp: `@${Math.floor(Date.now() / 1000) - 3600}` }) }),
    queueDeps: { fetch: async () => { throw new Error('offline') } },
  })
  Q0 = wire(await status.queue.queue())
  S0 = wire(await status.get())
})

after(() => {
  status?.queue.stop()
  F?.cleanup()
})

// The fixture's queue with no listed row, the given commit counts and docs
function idle(commits, docs = 0, docsFork = docs) {
  return { ...Q0, groups: [], flags: [], counts: { ...Q0.counts, total: 0, reviewed: 0, unreviewed: 0, byArea: {}, commits }, docs: { count: docs, fork: docsFork, server: docs - docsFork } }
}
const withMode = mode => ({ ...S0, updater: { ...S0.updater, mode } })

test('the panel renders a real status and queue, with no path and no innerHTML', () => {
  assert.doesNotMatch(SCRIPT, /innerHTML|outerHTML|insertAdjacentHTML/)
  const lines = render(S0, Q0)
  assert.ok(lines('srvHead')[0].startsWith('Online'), lines('srvHead')[0])
  assert.ok(lines('srvLive')[0].startsWith(`Game server ${short(F.S.B)}`), lines('srvLive')[0])
  const queue = lines('srvQueue')
  assert.ok(queue.some(l => l.startsWith('Backend (1) · not in the default update')), queue.join(' | '))
  assert.ok(queue.some(l => l.startsWith('Gameplay (1) · not in the default update')), queue.join(' | '))
  assert.equal(queue.some(l => /Nothing waits|Only docs|unknown/.test(l)), false)
  assert.ok(render(S0, { ...Q0, docs: { count: 1, fork: 1, server: 0 } })('srvQueue').includes('Docs (1, hidden)'))
  for (const id of ['srvHead', 'srvLive', 'srvQueue', 'srvRecent']) assert.doesNotMatch(lines(id).join('\n'), PATH_RE)
})

test('an empty list says nothing waits only when git counts nothing either', () => {
  const lines = render(S0, idle({ fork: 0, server: 0 }))('srvQueue')
  assert.ok(lines.includes('Nothing waits on GitHub.'))
  assert.equal(lines.some(l => l.startsWith('Docs (')), false)
})

test('an unknown gameplay queue is shown as unknown, never as nothing waiting', () => {
  for (const commits of [{ fork: 0, server: null }, { fork: 2, server: null }]) {
    const lines = render(S0, idle(commits, commits.fork))('srvQueue')
    assert.ok(lines.includes('Waiting on GitHub: unknown (the gameplay queue cannot be worked out).'), lines.join(' | '))
    assert.equal(lines.some(l => /Nothing waits|Only /.test(l)), false)
  }
})

test('only docs or merges waiting are counted, with the restart warning for main while auto-update is on', () => {
  assert.ok(render(S0, idle({ fork: 1, server: 0 }, 1))('srvQueue').includes(`Only docs wait (1); ${AUTO}.`))
  assert.ok(render({ ...S0, updater: { ...S0.updater, blocked: true } }, idle({ fork: 1, server: 0 }, 1))('srvQueue').includes('Only docs wait (1).'), 'blocked updates restart nothing')
  assert.ok(render(withMode('hold-s0'), idle({ fork: 1, server: 0 }, 1))('srvQueue').includes('Only docs wait (1).'))
  assert.ok(render(withMode('release'), idle({ fork: 1, server: 0 }, 1))('srvQueue').includes('Only docs wait (1).'))
  assert.ok(render(S0, idle({ fork: 0, server: 2 }, 2, 0))('srvQueue').includes('Only docs wait (2).'))
  assert.ok(render(S0, idle({ fork: 3, server: 0 }, 1))('srvQueue').includes(`Only docs and merges wait (3); ${AUTO}.`))
  assert.ok(render(S0, idle({ fork: 1, server: 0 }, 0))('srvQueue').includes(`Only merges wait (1); ${AUTO}.`))
})

// The status as GET / sends it, with the viewer's controls from the real serverControl
const control = createServerControl({ status: {}, jobsFile: path.join(__dirname, 'no-such-dir', 'server-jobs.json') })
function withControls(s, { owner = true, setting = 'on', online = s.players.online, job, claims = [] } = {}) {
  const st = { ...s, players: { ...s.players, online }, claims }
  const controls = wire(control.controlsFor(st, { owner, setting }))
  return { ...st, owner, controls: job === undefined ? controls : { ...controls, job } }
}
const walk = (node, out = []) => { out.push(node); node.kids.forEach(k => walk(k, out)); return out }
const buttons = page => walk(page.$('srvHead')).filter(n => n.tag === 'button')
const PLAYERS_ONLINE = 'Players are online: restarts with a countdown arrive with the next update.'
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

test('an Owner at 0 players gets Stop and Restart, and Start only when the server is down', () => {
  const page = load(withControls(S0, { online: 0 }), Q0)
  assert.deepEqual(buttons(page).map(b => [b.textContent, b.disabled, b.className]),
    [['Start', true, ''], ['Stop', false, 'danger'], ['Restart', false, 'danger']])
  assert.equal(page.lines('srvHead').some(l => /Only Owners|arrive with the next update|switched off/.test(l)), false)
  const down = { ...S0, service: { ...S0.service, state: 'stopped' } }
  assert.deepEqual(buttons(load(withControls(down, { online: 0 }), Q0)).map(b => b.disabled), [false, true, true])
})

test('a crashed server waiting for systemd to start it again shows so, and only Stop is offered', () => {
  const crashed = { ...S0, service: { ...S0.service, state: 'starting', sub: 'auto-restart' } }
  const page = load(withControls(crashed, { online: null }), Q0)
  assert.ok(page.lines('srvHead')[0].startsWith('Crashed, restarting'), page.lines('srvHead')[0])
  assert.deepEqual(buttons(page).map(b => b.disabled), [true, false, true])
  const starting = load(withControls({ ...S0, service: { ...S0.service, state: 'starting', sub: 'start' } }, { online: null }), Q0)
  assert.ok(starting.lines('srvHead')[0].startsWith('Starting'))
  assert.deepEqual(buttons(starting).map(b => b.disabled), [true, true, true])
})

test('the stop marker: who stopped it and why, and a warning when one is left over from before the last start', () => {
  const at = new Date(Date.now() - 3600e3).toISOString()
  const stopped = { ...S0, service: { ...S0.service, state: 'stopped' }, stopped: { by: 'Jake (website)', reason: 'Nightly <b>maintenance</b>', at, leftover: false } }
  const lines = load(withControls(stopped, { online: 0 }), Q0).lines('srvHead')
  assert.ok(lines.some(l => /^Stopped by Jake \(website\) \d\d:\d\d UTC: Nightly <b>maintenance<\/b>$/.test(l)), lines.join(' | '))
  assert.equal(lines.some(l => l.startsWith('! A stop marker')), false)
  const LEFT = '! A stop marker from before the server last started (a reboot or a manual start) is still there. Restart or Start removes it.'
  const left = load(withControls({ ...S0, stopped: { ...stopped.stopped, leftover: true } }, { online: 0 }), Q0)
  assert.ok(left.lines('srvHead').includes(LEFT))
  assert.equal(left.lines('srvHead').some(l => l.startsWith('Stopped by')), false)
  left.run('openControl("restart")')
  assert.equal(left.$('ctlInfo').textContent, 'This also removes the stop marker left from before the last start.')
  left.run('openControl("stop")')
  assert.equal(left.$('ctlInfo').textContent, '')
})

test('with players online every button is disabled with the countdown line', () => {
  const page = load(withControls(S0), Q0)
  assert.equal(S0.players.online, 2)
  assert.deepEqual(buttons(page).map(b => b.disabled), [true, true, true])
  assert.ok(page.lines('srvHead').includes(PLAYERS_ONLINE), page.lines('srvHead').join(' | '))
})

test('a Dev sees no buttons and the Owners-only line; an older backend shows no buttons either', () => {
  const dev = load(withControls(S0, { owner: false, online: 0 }), Q0)
  assert.equal(buttons(dev).length, 0)
  assert.ok(dev.lines('srvHead').includes('Only Owners can control the server.'))
  const old = load({ ...S0, owner: true, controls: { mode: 'off', update: 'notYet' } }, Q0)
  assert.equal(buttons(old).length, 0)
  assert.ok(old.lines('srvHead').includes('Controls arrive with the next update.'))
})

test('the switch, the dry run and the last action are shown', () => {
  const off = load(withControls(S0, { online: 0, setting: 'off' }), Q0)
  assert.deepEqual(buttons(off).map(b => b.disabled), [true, true, true])
  assert.ok(off.lines('srvHead').includes('The controls are switched off on the server.'))
  assert.ok(load(withControls(S0, { online: 0, setting: 'dry-run' }), Q0).lines('srvHead').includes('Dry run: the checks run and are logged, but nothing changes.'))
  const held = load(withControls(S0, { online: 0, claims: S0.claims }), Q0)
  assert.ok(S0.claims.some(c => c.resource === 'game-server'))
  assert.deepEqual(buttons(held).map(b => b.disabled), [true, true, true])
  assert.ok(held.lines('srvHead').includes('The game server is in use in the ops ledger (see In use).'))
  const job = { id: '0f8e6a52-0f7c-4d1e-9a51-3f0f2c1d9b10', action: 'restart', state: 'unconfirmed', dryRun: false, by: 'Jake', reason: 'combat fix <b>live</b>', requestedAt: new Date().toISOString(), finishedAt: null }
  const lines = load(withControls(S0, { online: 0, job }), Q0).lines('srvHead')
  assert.ok(lines.some(l => /^Last action: Restart by Jake, \d\d:\d\d UTC: not confirmed within 2 minutes · combat fix <b>live<\/b>$/.test(l)), lines.join(' | '))
})

// The page with a recording fetch: each action POST answers with the next reply, anything else never answers
function withFetch(status, replies) {
  const posts = []
  const fetch = (url, opts = {}) => {
    if (opts.method !== 'POST') return new Promise(() => {})
    posts.push({ url, opts, body: JSON.parse(opts.body) })
    const next = replies.shift()
    return next instanceof Error ? Promise.reject(next) : Promise.resolve({ status: next.status, ok: next.status < 300, json: async () => next.body })
  }
  return { page: load(status, Q0, { fetch }), posts }
}
const fill = (page, reason, word) => { page.$('ctlReason').value = reason; page.$('ctlWord').value = word; page.run('renderDialog()') }
const send = page => page.run('sendControl({ preventDefault() {} })')
const result = page => page.$('ctlResult').textContent

test('the dialog needs the typed word and a reason, shows the player count, and posts only the three fields', async () => {
  const job = { id: null, action: 'restart', state: 'running', dryRun: false, by: 'Jake', reason: 'Testing the restart', requestedAt: new Date().toISOString(), finishedAt: null }
  const { page, posts } = withFetch(withControls(S0, { online: 0 }), [{ status: 202, body: { job } }])
  page.run('openControl("restart")')
  assert.equal(page.$('ctl').open, true)
  assert.equal(page.$('ctlTitle').textContent, 'Restart the game server')
  assert.equal(page.$('ctlWordLabel').textContent, 'Type RESTART to confirm')
  assert.match(page.$('ctlPlayers').textContent, /^Players online now: 0 \(checked /)
  const first = page.run('ctl.requestId')
  assert.match(first, UUID_V4)
  for (const [reason, word] of [['', ''], ['Testing the restart', ''], ['Testing the restart', 'restart'], ['Test', 'RESTART'], ['\n\u202e \t', 'RESTART']]) {
    fill(page, reason, word)
    assert.equal(page.$('ctlGo').disabled, true, `${JSON.stringify(reason)} ${word}`)
  }
  fill(page, '  Testing\nthe restart ', ' RESTART ')
  assert.equal(page.$('ctlGo').disabled, false)
  job.id = first
  await send(page)
  assert.equal(posts.length, 1)
  const [{ url, opts, body }] = posts
  assert.equal(url, '/api/site/staff/server/actions/restart')
  assert.equal(opts.method, 'POST')
  assert.equal(opts.credentials, 'same-origin')
  assert.deepEqual({ ...opts.headers }, { 'Content-Type': 'application/json', 'X-DBO-Control': '1' })
  assert.deepEqual(body, { requestId: first, reason: 'Testing the restart', confirm: 'RESTART' })
  assert.equal(result(page), 'Restart sent. Waiting for the server to confirm (up to 2 minutes)…')
  assert.equal(page.$('ctlGo').disabled, true, 'a sent request cannot be sent again from the same dialog')
  page.run('openControl("stop")')
  assert.notEqual(page.run('ctl.requestId'), first, 'every dialog gets a fresh requestId')
  assert.equal(result(page), '')
})

test('the dialog reports refusals, the dry run and a lost answer, and a lost answer resends the same requestId', async () => {
  const dry = { id: null, action: 'stop', state: 'done', dryRun: true, by: 'Jake', reason: 'Checking the stop', requestedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }
  const { page, posts } = withFetch(withControls(S0, { online: 0 }), [
    { status: 409, body: { error: 'playersOnline' } },
    { status: 409, body: { error: 'claimed', holder: 'claude-nate' } },
    { status: 413, body: { error: 'The request is too large.' } },
    new Error('offline'),
    { status: 202, body: { job: dry } },
  ])
  page.run('openControl("stop")')
  fill(page, 'Checking the stop', 'STOP')
  const expected = [PLAYERS_ONLINE, 'The game server is in use in the ops ledger by claude-nate. Try again when it is free.', 'The request is too large.',
    'Cannot reach the server. Press the button again: the same request never runs twice.', 'Dry run: Stop passed every check. Nothing was changed.']
  for (const text of expected) {
    assert.equal(page.$('ctlGo').disabled, false)
    await send(page)
    assert.equal(result(page), text)
  }
  assert.equal(new Set(posts.map(p => p.body.requestId)).size, 1)
  assert.ok(posts.every(p => p.url === '/api/site/staff/server/actions/stop'))
})

test('while the dialog waits, a job the backend no longer has ends the wait, and one cut short by a backend restart says so', async () => {
  const job = { id: null, action: 'restart', state: 'running', dryRun: false, by: 'Jake', reason: 'Testing the restart', requestedAt: new Date().toISOString(), finishedAt: null }
  const polls = []
  const fetch = (url, opts = {}) => {
    if (opts.method === 'POST') return Promise.resolve({ status: 202, ok: true, json: async () => ({ job }) })
    if (!url.startsWith('/api/site/staff/server/jobs/')) return new Promise(() => {})
    polls.push(url)
    return Promise.resolve({ status: 404, ok: false, json: async () => ({ error: 'notFound' }) })
  }
  const page = load(withControls(S0, { online: 0 }), Q0, { fetch, setTimeout: fn => { setImmediate(fn); return 0 } })
  page.run('openControl("restart")')
  job.id = page.run('ctl.requestId')
  fill(page, 'Testing the restart', 'RESTART')
  await send(page)
  for (let i = 0; i < 20 && !polls.length; i++) await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
  assert.equal(polls.length, 1)
  assert.equal(result(page), 'The backend lost track of this action. Check the panel above.')
  assert.equal(page.$('ctlGo').disabled, true)
  page.run('ctl.job = { ...ctl.job, state: "interrupted" }; renderDialog()')
  assert.equal(result(page), 'The backend restarted before Restart was confirmed. Check the panel above.')
  const head = load(withControls(S0, { online: 0, job: { ...job, state: 'interrupted' } }), Q0).lines('srvHead')
  assert.ok(head.some(l => /^Last action: Restart by Jake, \d\d:\d\d UTC: not followed to its end \(the backend restarted\) · Testing the restart$/.test(l)), head.join(' | '))
})

test('the dialog blocks the action when the status says it cannot run', () => {
  const page = load(withControls(S0, { online: 0 }), Q0)
  page.run('openControl("restart")')
  fill(page, 'Testing the restart', 'RESTART')
  assert.equal(page.$('ctlGo').disabled, false)
  page.run('srv.status = input.status; srv.status = { ...srv.status, players: { ...srv.status.players, online: 3 }, controls: { ...srv.status.controls, canStop: false, canRestart: false, why: "playersOnline" } }; renderServer()')
  assert.equal(page.$('ctlGo').disabled, true)
  assert.equal(result(page), PLAYERS_ONLINE)
  assert.match(page.$('ctlPlayers').textContent, /^Players online now: 3 /)
})
