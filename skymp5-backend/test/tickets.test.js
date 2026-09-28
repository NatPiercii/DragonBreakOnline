'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

// Discord is a fake client and interaction; config and the audit log are stubbed
const stub = (rel, exports) => {
  const file = require.resolve(rel)
  require.cache[file] = { id: file, filename: file, loaded: true, exports }
}
const config = {
  discordTicketPanelChannelId: '1554000000000000001', discordBugsForumChannelId: '1551936720713416755',
  discordSuggestionsChannelId: '', websiteUrl: 'https://example.test/', discordStaffRoleIds: [],
}
stub('../config', config)
stub('../sources/discord/audit', { log: () => {} })
const tickets = require('../sources/discord/tickets')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbo-tickets-'))
test.after(() => fs.rmSync(dir, { recursive: true, force: true }))

function fakeClient(existing) {
  const calls = { edits: [], sends: [] }
  const channel = {
    messages: { fetch: async id => (existing && id === existing ? { edit: async p => { calls.edits.push(p) } } : Promise.reject(new Error('Unknown Message'))) },
    send: async p => { calls.sends.push(p); return { id: '1554000000000000099' } },
  }
  return { calls, client: { channels: { fetch: async id => (id === config.discordTicketPanelChannelId ? channel : null) } } }
}
const panelText = p => JSON.stringify(p.embeds.map(e => e.toJSON()))
const buttonIds = p => p.components.flatMap(r => r.toJSON().components.map(c => c.custom_id))

test('the panel has no Bug Report or Map Changes kind', () => {
  assert.deepStrictEqual(tickets.TYPES.map(t => t.id), ['pk', 'mod', 'rep'])
})

test('on boot the panel edits its own message: no bug buttons, and a line to the front door', async () => {
  const stateFile = path.join(dir, 'tickets-edit.json')
  fs.writeFileSync(stateFile, JSON.stringify({ counter: 4, categories: {}, panelMessageId: '1554000000000000042' }))
  const { client, calls } = fakeClient('1554000000000000042')
  await tickets.ensurePanel(client, stateFile)
  assert.strictEqual(calls.sends.length, 0)
  assert.strictEqual(calls.edits.length, 1)
  assert.deepStrictEqual(buttonIds(calls.edits[0]), ['ticket:open:pk', 'ticket:open:mod', 'ticket:open:rep'])
  const text = panelText(calls.edits[0])
  assert.match(text, /Found a bug\?/)
  assert.match(text, /\/bug <what happened>/)
  assert.match(text, /<#1551936720713416755>/)
  assert.match(text, /Report a Problem in the launcher/)
  assert.match(text, /https:\/\/example\.test\/report\.html/)
  assert.match(text, /#suggestions/)
  assert.match(text, /Exploits and dupes: never in public/)
  assert.doesNotMatch(text, /Bug Report|Map Changes/)
})

test('a panel whose message is gone is posted again and its id saved', async () => {
  const stateFile = path.join(dir, 'tickets-new.json')
  fs.writeFileSync(stateFile, JSON.stringify({ counter: 4, categories: {}, panelMessageId: '1554000000000000043' }))
  const { client, calls } = fakeClient(null)
  await tickets.ensurePanel(client, stateFile)
  assert.strictEqual(calls.sends.length, 1)
  assert.strictEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).panelMessageId, '1554000000000000099')
})

test('a Bug Report button left on an old panel answers privately with the front door', async () => {
  let reply = null
  let modal = null
  const interaction = {
    customId: 'ticket:open:bug', isButton: () => true, isModalSubmit: () => false,
    reply: async r => { reply = r }, showModal: async m => { modal = m },
  }
  assert.strictEqual(await tickets.handleInteraction(interaction), true)
  assert.strictEqual(modal, null)
  assert.strictEqual(reply.ephemeral, true)
  assert.match(reply.content, /\/bug <what happened>/)
})

test('without a https website address the panel names the form without a link', async () => {
  config.websiteUrl = 'http://localhost:4001'
  const stateFile = path.join(dir, 'tickets-local.json')
  fs.writeFileSync(stateFile, JSON.stringify({ panelMessageId: '1554000000000000044' }))
  const { client, calls } = fakeClient('1554000000000000044')
  await tickets.ensurePanel(client, stateFile)
  assert.doesNotMatch(panelText(calls.edits[0]), /localhost/)
  assert.match(panelText(calls.edits[0]), /the report form on the website/)
  config.websiteUrl = 'https://example.test/'
})
