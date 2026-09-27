'use strict'
// website/dashboard.html's script against a small fake DOM, fed a real status and queue from the panel fixture

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { createServerStatus } = require('../sources/serverStatus')
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
}

// The page with main() parked on a sign-in fetch that never answers, then one renderServer() with the given data
function render(status, queue) {
  const byId = new Map()
  const $ = id => { if (!byId.has(id)) byId.set(id, new FakeEl('div')); return byId.get(id) }
  const document = { getElementById: $, createElement: tag => new FakeEl(tag), createElementNS: (_ns, tag) => new FakeEl(tag) }
  const ctx = vm.createContext({ document, fetch: () => new Promise(() => {}), setInterval: () => 0, setTimeout: () => 0, console, input: { status, queue } })
  vm.runInContext(SCRIPT, ctx)
  vm.runInContext('srv.status = input.status; srv.queue = input.queue; renderServer()', ctx)
  return id => $(id).kids.map(k => k.textContent)
}

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
