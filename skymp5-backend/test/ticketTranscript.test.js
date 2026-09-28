'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

// Discord is a fake ticket channel, staff channel and client; config and the audit log are stubbed
const stub = (rel, exports) => {
  const file = require.resolve(rel)
  require.cache[file] = { id: file, filename: file, loaded: true, exports }
}
const config = { discordTicketTranscriptChannelId: '' }
stub('../config', config)
stub('../sources/discord/audit', { log: () => {} })
const { save } = require('../sources/discord/ticketTranscript')
const { closeTicket } = require('../sources/discord/tickets')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbo-transcripts-'))
test.after(() => fs.rmSync(root, { recursive: true, force: true }))
const IP_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|2a02:c7c/
const GUILD = '1494109013300744312'
const id = n => `1554${String(n).padStart(15, '0')}`

function message(n, extra = {}) {
  return {
    id: id(n), createdTimestamp: Date.UTC(2026, 8, 28, 12, 0, n % 60), author: { id: id(9000), tag: 'arvel', bot: false },
    content: `message ${n}`, embeds: [], attachments: new Map(), stickers: new Map(), ...extra,
  }
}

// 150 messages, served newest first 100 at a time as Discord does
function ticketChannel() {
  const all = [
    message(1, { author: { id: id(1), tag: 'DragonBreak', bot: true }, content: '<@1554000000000009000>', embeds: [{
      title: 'Player Kill Request #0012', description: 'He killed me from 81.23.145.7', footer: { text: 'Opened from the game with /ticket' },
      fields: [{ name: 'Where', value: 'Whiterun (1024, -512, 30)' }, { name: 'Nearby (within 40 m)', value: 'Brelyna 12 m' }] }] }),
    message(2, { content: 'my ip is 203.0.113.9 and 2a02:c7c:1234:5600::1a, proof attached', attachments: new Map([['a', { name: 'proof.png', url: 'https://cdn.discordapp.com/attachments/1/2/proof.png?ex=1&hm=abc' }]]) }),
    message(3, { content: '' }),
  ]
  for (let n = 4; n <= 150; n++) all.push(message(n))
  const newestFirst = all.slice().reverse()
  return {
    id: id(500), name: 'pk-g0012-arvel', guildId: GUILD, topic: 'Player Kill Request | opened in game by Arvel (1554000000000009000)',
    messages: { fetch: async ({ limit, before }) => {
      const from = before ? newestFirst.findIndex(m => m.id === before) + 1 : 0
      return new Map(newestFirst.slice(from, from + limit).map(m => [m.id, m]))
    } },
    sent: [], deleted: false,
    send: async function (p) { this.sent.push(p) },
    delete: async function () { this.deleted = true },
  }
}

function staffClient({ everyoneCanView = false, guildId = GUILD } = {}) {
  const posts = []
  const everyone = { id: GUILD }
  const target = { guildId, guild: { roles: { everyone } }, send: async p => { posts.push(p) },
    permissionsFor: role => ({ has: () => role === everyone && everyoneCanView }) }
  return { posts, client: { channels: { fetch: async cid => (cid === id(777) ? target : null) } } }
}
const closer = { id: id(42), tag: 'staffer' }

test('a transcript goes to the staff channel with every message in order, attachments as links, no IP address', async () => {
  config.discordTicketTranscriptChannelId = id(777)
  const dir = path.join(root, 'posted')
  const { client, posts } = staffClient()
  assert.strictEqual(await save(ticketChannel(), closer, { client, dir }), 'posted to the transcript channel')
  assert.strictEqual(fs.existsSync(dir), false)
  assert.strictEqual(posts.length, 1)
  assert.deepStrictEqual(posts[0].allowedMentions, { parse: [] })
  const [txt, json] = posts[0].files
  assert.deepStrictEqual([txt.name, json.name], ['pk-g0012-arvel.txt', 'pk-g0012-arvel.json'])
  const t = JSON.parse(json.attachment.toString())
  assert.strictEqual(t.messages.length, 150)
  assert.deepStrictEqual(t.messages.slice(0, 3).map(m => m.id), [id(1), id(2), id(3)])
  assert.strictEqual(t.messages[149].content, 'message 150')
  assert.deepStrictEqual(t.messages[1].attachments, [{ name: 'proof.png', url: 'https://cdn.discordapp.com/attachments/1/2/proof.png?ex=1&hm=abc' }])
  assert.strictEqual(t.blank, 1)
  const text = txt.attachment.toString()
  assert.match(text, /Closed by staffer/)
  assert.match(text, /\[file\] proof\.png https:\/\/cdn\.discordapp\.com/)
  assert.match(text, /Nearby \(within 40 m\): Brelyna 12 m/)
  assert.match(text, /1 message\(s\) from people came back empty: the bot may lack the Message Content intent/)
  assert.match(text, /my ip is <ip> and <ip>, proof attached/)
  for (const body of [text, json.attachment.toString(), posts[0].content]) assert.doesNotMatch(body, IP_RE)
})

test('without a transcript channel the transcript is saved as a 0600 file in a 0700 folder', async () => {
  config.discordTicketTranscriptChannelId = ''
  const dir = path.join(root, 'saved')
  assert.strictEqual(await save(ticketChannel(), closer, { client: staffClient().client, dir }), 'saved as pk-g0012-arvel.json')
  assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700)
  const file = path.join(dir, 'pk-g0012-arvel.json')
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600)
  const body = fs.readFileSync(file, 'utf8')
  assert.doesNotMatch(body, IP_RE)
  assert.strictEqual(JSON.parse(body).messages.length, 150)
  // A second close of a channel with the same name never overwrites the first file
  assert.match(await save(ticketChannel(), closer, { client: staffClient().client, dir }), /^saved as pk-g0012-arvel-\d+\.json$/)
})

test('a transcript channel that @everyone can read, or in another server, is refused and a file saved', async () => {
  config.discordTicketTranscriptChannelId = id(777)
  for (const [n, opts] of [[1, { everyoneCanView: true }], [2, { guildId: id(3) }]]) {
    const dir = path.join(root, `refused-${n}`)
    const { client, posts } = staffClient(opts)
    assert.strictEqual(await save(ticketChannel(), closer, { client, dir }), 'saved as pk-g0012-arvel.json')
    assert.strictEqual(posts.length, 0)
  }
})

function closeClick(channel) {
  const replies = []
  return { replies, interaction: { channel, user: closer, reply: async r => { replies.push(r) } } }
}

test('closing deletes the channel only after its transcript is kept', async () => {
  const channel = ticketChannel()
  const saved = []
  const { interaction, replies } = closeClick(channel)
  await closeTicket(interaction, { wait: 0, transcripts: { save: async (c, who) => { saved.push([c.id, who.id]); return 'saved as x.json' } } })
  assert.deepStrictEqual(saved, [[id(500), id(42)]])
  assert.strictEqual(replies[0].content, 'Closing in 5 seconds.')
  assert.strictEqual(channel.deleted, true)
})

test('when the transcript cannot be kept the channel stays open and says so', async () => {
  const channel = ticketChannel()
  const { interaction } = closeClick(channel)
  await closeTicket(interaction, { wait: 0, transcripts: { save: async () => { throw new Error('disk full') } } })
  assert.strictEqual(channel.deleted, false)
  assert.match(channel.sent[0], /transcript could not be saved, so this channel stays open/)
})

test('a second Close while the first is running is answered privately and does nothing', async () => {
  const channel = ticketChannel()
  let release
  const first = closeClick(channel)
  const running = closeTicket(first.interaction, { wait: 0, transcripts: { save: () => new Promise(r => { release = r }) } })
  const second = closeClick(channel)
  await closeTicket(second.interaction, { wait: 0 })
  assert.deepStrictEqual(second.replies, [{ content: 'This ticket is already closing.', ephemeral: true }])
  while (!release) await new Promise(r => setTimeout(r, 1))
  release('posted to the transcript channel')
  await running
  assert.strictEqual(channel.deleted, true)
})
