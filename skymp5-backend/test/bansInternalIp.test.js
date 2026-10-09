'use strict'

// One ban must never refuse everyone: the shared internal address every player arrives from is never stored or matched
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

// A private copy of bans.js beside its own data folder, so the real data/bans.json is never touched
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bans-test-'))
fs.mkdirSync(path.join(root, 'sources'))
fs.mkdirSync(path.join(root, 'data'))
fs.copyFileSync(path.join(__dirname, '..', 'sources', 'bans.js'), path.join(root, 'sources', 'bans.js'))
process.env.BAN_LOG_DIR = path.join(root, 'logs')
const bans = require(path.join(root, 'sources', 'bans.js'))

test('internal addresses are recognised', () => {
  for (const ip of ['10.10.10.1', '127.0.0.1', '172.16.0.4', '172.31.255.1', '192.168.12.100', '169.254.1.1', '100.64.0.1', '100.127.9.9', '::1', '::ffff:10.10.10.1', 'fd7a:115c::1', 'fe80::1']) {
    assert.equal(bans.isInternalIp(ip), true, ip)
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '203.0.113.9', '2001:db8::1', '', null]) {
    assert.equal(bans.isInternalIp(ip), false, String(ip))
  }
})

test('a ban never stores an internal address, so it refuses only the banned player', () => {
  const e = bans.add({ discordId: '111', hwid: null, ip: '10.10.10.1', reason: 'test' })
  assert.equal(e.ip, null)
  assert.ok(bans.isBanned({ discordId: '111', ip: '10.10.10.1' }))
  assert.equal(bans.isBanned({ discordId: '222', ip: '10.10.10.1' }), null)
})

test('an old entry holding an internal address matches no one by it', () => {
  const file = path.join(root, 'data', 'bans.json')
  fs.writeFileSync(file, JSON.stringify([{ discordId: '333', hwid: null, ip: '10.10.10.1' }]))
  assert.equal(bans.isBanned({ discordId: '444', ip: '10.10.10.1' }), null)
  assert.ok(bans.isBanned({ discordId: '333' }))
})

test('a public address still bans by address', () => {
  bans.add({ discordId: '555', ip: '203.0.113.9' })
  assert.ok(bans.isBanned({ discordId: '666', ip: '203.0.113.9' }))
  assert.equal(bans.isBanned({ discordId: '666', ip: '203.0.113.10' }), null)
})
