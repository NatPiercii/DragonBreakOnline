'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { createBugLogPoller, SENT_KEY } = require('../src/bugLogs')

// A store like electron-store, kept in a map
const memStore = () => { const m = new Map(); return { get: k => m.get(k), set: (k, v) => m.set(k, v) } }

test('each pending /bug gets its logs once, across polls and restarts', async () => {
  const store = memStore()
  const sent = []
  const fetchPending = async () => [{ id: 'A' }, { id: 'B' }]
  const send = async id => { sent.push(id); return { ok: true } }
  const poller = createBugLogPoller({ fetchPending, send, store })
  assert.strictEqual(await poller.poll(), 2)
  assert.strictEqual(await poller.poll(), 0)
  assert.deepStrictEqual(sent, ['A', 'B'])
  const restarted = createBugLogPoller({ fetchPending, send, store })
  assert.strictEqual(await restarted.poll(), 0)
  assert.deepStrictEqual(store.get(SENT_KEY), ['A', 'B'])
})

test('a failed send is tried again on the next poll; one the server no longer waits for is not', async () => {
  const store = memStore()
  let fail = true
  const tries = []
  const send = async id => { tries.push(id); return id === 'GONE' ? { ok: false, notPending: true } : fail ? { ok: false, error: 'offline' } : { ok: true } }
  const poller = createBugLogPoller({ fetchPending: async () => [{ id: 'A' }, { id: 'GONE' }], send, store })
  assert.strictEqual(await poller.poll(), 1)
  fail = false
  assert.strictEqual(await poller.poll(), 1)
  assert.deepStrictEqual(tries, ['A', 'GONE', 'A'])
})

test('a poll while one runs shares it, and an unreachable server sends nothing', async () => {
  const store = memStore()
  let calls = 0
  let release
  const gate = new Promise(r => { release = r })
  const poller = createBugLogPoller({ fetchPending: async () => { calls++; await gate; return [] }, send: async () => ({ ok: true }), store })
  const a = poller.poll()
  const b = poller.poll()
  release()
  await Promise.all([a, b])
  assert.strictEqual(calls, 1)
  const down = createBugLogPoller({ fetchPending: async () => { throw new Error('ECONNREFUSED') }, send: async () => { throw new Error('no') }, store })
  assert.strictEqual(await down.poll(), 0)
})

test('garbage from the server is ignored', async () => {
  const sent = []
  const poller = createBugLogPoller({ fetchPending: async () => [null, { id: 5 }, {}, { id: 'OK' }], send: async id => { sent.push(id); return { ok: true } }, store: memStore() })
  assert.strictEqual(await poller.poll(), 1)
  assert.deepStrictEqual(sent, ['OK'])
})
