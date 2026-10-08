'use strict'
// rolePanel: the 18+ button toggles the role, refuses the ban role, ignores other buttons, posts once and then edits.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const serverAccess = require('../sources/access/serverAccess')
const rolePanel = require('../sources/discord/rolePanel')

function click(has, customId = rolePanel.BUTTON_ID) {
  const roles = new Set(has)
  const log = []
  return {
    log, roles,
    isButton: () => true,
    customId,
    member: { roles: { cache: roles, add: async r => { roles.add(r); log.push('add') }, remove: async r => { roles.delete(r); log.push('remove') } } },
    reply: async m => { log.push(m.content) },
  }
}

test('the button gives the role, then takes it back', async () => {
  const i = click([])
  assert.strictEqual(await rolePanel.handleInteraction(i, { roleId: 'R' }), true)
  assert.ok(i.roles.has('R') && i.log[0] === 'add')
  await rolePanel.handleInteraction(i, { roleId: 'R' })
  assert.ok(!i.roles.has('R') && i.log[2] === 'remove')
})

test('a banned member is refused and another button is not ours', async () => {
  const orig = serverAccess.load
  serverAccess.load = () => ({ bannedRoleId: 'B' })
  const i = click(['B'])
  await rolePanel.handleInteraction(i, { roleId: 'R' })
  serverAccess.load = orig
  assert.ok(!i.roles.has('R') && /cannot/.test(i.log[0]))
  assert.strictEqual(await rolePanel.handleInteraction(click([], 'ticket:close'), { roleId: 'R' }), false)
})

test('the panel is posted once, then edited in place', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbo-rp-')), 'role-panel.json')
  const msgs = new Map()
  let posts = 0, edits = 0
  const channel = {
    send: async () => { posts++; const m = { id: 'M' + posts, edit: async () => { edits++ } }; msgs.set(m.id, m); return m },
    messages: { fetch: async id => { if (!msgs.has(id)) throw new Error('gone'); return msgs.get(id) } },
  }
  const client = { channels: { fetch: async () => channel } }
  await rolePanel.ensurePanel(client, { channelId: 'C', stateFile: file })
  await rolePanel.ensurePanel(client, { channelId: 'C', stateFile: file })
  assert.deepStrictEqual([posts, edits], [1, 1])
})
