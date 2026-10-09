'use strict'

// Only members of the DragonBreak Online Discord may play (Nate, 9 Oct 2026); unknown membership lets the player in
const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')

const membership = new Map()
const stub = (rel, exports) => { const p = require.resolve(path.join(__dirname, '..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports } }
stub('config.js', { serverLocked: false, serverLockedRoleIds: [], serverLockedAllowList: [], whitelistRoleId: '', bannedRoleId: 'BANNED' })
stub('sources/discord/bot.js', {
  getMemberRoles: async (id) => (id === 'banned' ? ['BANNED'] : []),
  isGuildMember: async (id) => (membership.has(id) ? membership.get(id) : null),
})
const access = require('../sources/access/serverAccess')

test('a member plays', async () => {
  membership.set('m', true)
  assert.equal((await access.getDiscordAccess('m')).allowed, true)
})

test('someone not in the Discord is refused, with the reason', async () => {
  membership.set('out', false)
  const r = await access.getDiscordAccess('out')
  assert.equal(r.allowed, false)
  assert.equal(r.error, 'notWhitelisted')
  assert.equal(r.reason, 'notInDiscord')
})

test('Discord not answering lets the player in', async () => {
  assert.equal((await access.getDiscordAccess('unknown')).allowed, true)
})

test('the ban role still wins', async () => {
  membership.set('banned', true)
  assert.equal((await access.getDiscordAccess('banned')).error, 'banned')
})
