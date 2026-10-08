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

test('the panel has no Bug Report or Map Changes kind (Map Creation is its own, Nate 8 Oct)', () => {
  assert.deepStrictEqual(tickets.TYPES.map(t => t.id), ['pk', 'mod', 'rep', 'fac', 'map', 'gm'])
})

test('on boot the panel edits its own message: no bug buttons, and a line to the front door', async () => {
  const stateFile = path.join(dir, 'tickets-edit.json')
  fs.writeFileSync(stateFile, JSON.stringify({ counter: 4, categories: {}, panelMessageId: '1554000000000000042' }))
  const { client, calls } = fakeClient('1554000000000000042')
  await tickets.ensurePanel(client, stateFile)
  assert.strictEqual(calls.sends.length, 0)
  assert.strictEqual(calls.edits.length, 1)
  assert.deepStrictEqual(buttonIds(calls.edits[0]), ['ticket:open:pk', 'ticket:open:mod', 'ticket:open:rep', 'ticket:open:fac', 'ticket:open:map', 'ticket:open:gm'])
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

// Faction Inquiry and Trial GM Application (Nate, 4 Oct)
const gmApplication = require('../sources/discord/gmApplication')
// Opening a ticket writes the real state file; put it back as it was
const realState = path.join(__dirname, '..', 'data', 'tickets.json')
const hadState = fs.existsSync(realState) ? fs.readFileSync(realState) : null
test.after(() => { if (hadState) fs.writeFileSync(realState, hadState); else fs.rmSync(realState, { force: true }) })

test('the panel has Faction Inquiry and Trial GM Application buttons, labelled', async () => {
  const stateFile = path.join(dir, 'tickets-new-types.json')
  fs.writeFileSync(stateFile, JSON.stringify({ counter: 0, categories: {}, panelMessageId: '1554000000000000044' }))
  const { client, calls } = fakeClient('1554000000000000044')
  await tickets.ensurePanel(client, stateFile)
  const labels = calls.edits[0].components.flatMap(r => r.toJSON().components.map(c => c.label))
  assert.ok(labels.includes('Faction Inquiry') && labels.includes('Trial GM Application') && labels.includes('Map Creation'))
  assert.match(panelText(calls.edits[0]), /Faction Inquiry/)
})

test('the GM application: every question, the acknowledgment, each message under Discord\'s limit', () => {
  assert.ok(gmApplication.length >= 2)
  for (const m of gmApplication) assert.ok(m.length <= 2000, `message of ${m.length} characters`)
  const all = gmApplication.join('\n')
  for (let n = 1; n <= 30; n++) assert.match(all, new RegExp(`^${n}\\. `, 'm'), `question ${n}`)
  assert.match(all, /Game Master Application/)
  assert.match(all, /Do you agree to these expectations\?/)
  assert.match(all, /Discord username:\nDate:$/)
})

test('a Trial GM Application ticket posts the questions after its opening message, with no pings', async () => {
  const sent = []
  const channel = { id: '1554000000000000200', name: 'gm-0001-applicant', send: async p => { sent.push(p) } }
  const guild = {
    roles: { everyone: { id: '1' } },
    channels: {
      cache: { get: () => null, find: () => ({ id: '1554000000000000300' }) },
      fetch: async () => null,
      create: async () => channel,
    },
  }
  const interaction = {
    guild, user: { id: '1554000000000000400', username: 'applicant', tag: 'applicant' },
    customId: 'ticket:submit:gm', isButton: () => false, isModalSubmit: () => true,
    deferReply: async () => {}, editReply: async () => {}, fields: { getTextInputValue: () => '' },
  }
  await tickets.handleInteraction(interaction)
  assert.strictEqual(sent.length, 1 + gmApplication.length)
  assert.ok(sent[0].embeds && /Trial GM Application/.test(JSON.stringify(sent[0].embeds[0].toJSON())))
  assert.deepStrictEqual(sent.slice(1).map(p => p.content), gmApplication)
  for (const p of sent.slice(1)) assert.deepStrictEqual(p.allowedMentions, { parse: [] })
})

test('a Faction Inquiry ticket posts only its opening message', async () => {
  const sent = []
  const channel = { id: '1554000000000000201', name: 'fac-0002-asker', send: async p => { sent.push(p) } }
  const guild = {
    roles: { everyone: { id: '1' } },
    channels: { cache: { get: () => null, find: () => ({ id: '1554000000000000301' }) }, fetch: async () => null, create: async () => channel },
  }
  await tickets.handleInteraction({
    guild, user: { id: '1554000000000000401', username: 'asker', tag: 'asker' },
    customId: 'ticket:submit:fac', isButton: () => false, isModalSubmit: () => true,
    deferReply: async () => {}, editReply: async () => {}, fields: { getTextInputValue: () => 'Joining the Fighters Guild' },
  })
  assert.strictEqual(sent.length, 1)
  assert.match(JSON.stringify(sent[0].embeds[0].toJSON()), /Faction Inquiry/)
})
