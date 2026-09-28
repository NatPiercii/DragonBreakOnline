'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { OverwriteType, PermissionFlagsBits } = require('discord.js')

// Discord is a fake ticket channel, staff channel and client; config and the audit log are stubbed
const stub = (rel, exports) => {
  const file = require.resolve(rel)
  require.cache[file] = { id: file, filename: file, loaded: true, exports }
}
const id = n => `1554${String(n).padStart(15, '0')}`
const config = { discordTicketTranscriptChannelId: '', discordStaffRoleIds: [id(700)] }
stub('../config', config)
stub('../sources/discord/audit', { log: () => {} })
// No test may reach the network: attachments come from the fetchFile stub
globalThis.fetch = async url => { throw new Error(`network use in a test: ${url}`) }
const { save, download, MAX_MESSAGES } = require('../sources/discord/ticketTranscript')
const { closeTicket } = require('../sources/discord/tickets')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbo-transcripts-'))
test.after(() => fs.rmSync(root, { recursive: true, force: true }))
const IP_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|2a02:c7c/
const GUILD = '1494109013300744312'
const CDN = 'https://cdn.discordapp.com/attachments/1/2/'
const PROOF = Buffer.from('proof.png bytes')

function message(n, extra = {}) {
  return {
    id: id(n), createdTimestamp: Date.UTC(2026, 8, 28, 12, 0, n % 60), author: { id: id(9000), tag: 'arvel', bot: false },
    content: `message ${n}`, embeds: [], attachments: new Map(), stickers: new Map(), ...extra,
  }
}
const file = (name, size = 16) => new Map([[name, { name, size, url: `${CDN}${name}?ex=1&hm=abc` }]])

// count messages, served newest first 100 at a time as Discord does; more replaces or adds messages by number
function ticketChannel({ count = 150, more = {} } = {}) {
  const byNumber = {
    1: message(1, { author: { id: id(1), tag: 'DragonBreak', bot: true }, content: '<@1554000000000009000>', embeds: [{
      title: 'Player Kill Request #0012', description: 'He killed me from 81.23.145.7', footer: { text: 'Opened from the game with /ticket' },
      fields: [{ name: 'Where', value: 'Whiterun (1024, -512, 30)' }, { name: 'Nearby (within 40 m)', value: 'Brelyna 12 m' }] }] }),
    2: message(2, { content: 'my ip is 203.0.113.9 and 2a02:c7c:1234:5600::1a, proof attached', attachments: file('proof.png', PROOF.length) }),
    3: message(3, { content: '' }),
    ...more,
  }
  const all = []
  for (let n = 1; n <= count; n++) all.push(byNumber[n] || message(n))
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

// Downloads come from here; a name listed in fail is refused as an expired link would be
function files({ big = [], fail = [] } = {}) {
  const fetched = []
  return { fetched, fetchFile: async w => {
    fetched.push(w.url)
    const name = w.url.slice(CDN.length).replace(/\?.*/, '')
    if (fail.includes(name)) throw new Error('attachment download failed (404)')
    if (big.includes(name)) return Buffer.alloc(8 * 1024 * 1024 + 1)
    return name === 'proof.png' ? PROOF : Buffer.from(`${name} bytes`)
  } }
}

// Roles as on the server: @everyone, staff, the bot's own role, an Administrator role, and a member role that cannot view
function staffClient({ everyoneCanView = false, guildId = GUILD, memberRoleCanView = false, memberAllow = '', noPerms = false } = {}) {
  const posts = []
  const role = (rid, name, view, more = {}) => ({ id: rid, name, view, ...more,
    permissions: { has: bit => bit === PermissionFlagsBits.Administrator && !!more.admin } })
  const roles = [role(GUILD, '@everyone', everyoneCanView), role(id(700), 'Staff', true),
    role(id(701), 'DragonBreak', true, { tags: { botId: id(1) } }), role(id(702), 'Owners', true, { admin: true }),
    role(id(703), 'Whitelisted', memberRoleCanView)]
  const overwrites = new Map(memberAllow ? [[memberAllow, { id: memberAllow, type: OverwriteType.Member,
    allow: { has: bit => bit === PermissionFlagsBits.ViewChannel } }]] : [])
  const target = { guildId, guild: { roles: { everyone: roles[0], cache: new Map(roles.map(r => [r.id, r])) } },
    permissionOverwrites: { cache: overwrites }, send: async p => { posts.push(p) },
    permissionsFor: r => (noPerms ? null : { has: bit => bit === PermissionFlagsBits.ViewChannel && r.view }) }
  return { posts, client: { user: { id: id(1) }, channels: { fetch: async cid => (cid === id(777) ? target : null) } } }
}
const closer = { id: id(42), tag: 'staffer' }

test('a transcript goes to the staff channel with every message in order, attachments re-uploaded, no IP address', async () => {
  config.discordTicketTranscriptChannelId = id(777)
  const dir = path.join(root, 'posted')
  const { client, posts } = staffClient()
  const { fetchFile, fetched } = files()
  assert.strictEqual(await save(ticketChannel(), closer, { client, dir, fetchFile }), 'posted to the transcript channel')
  assert.strictEqual(fs.existsSync(dir), false)
  assert.deepStrictEqual(fetched, [`${CDN}proof.png?ex=1&hm=abc`])
  assert.strictEqual(posts.length, 1)
  assert.deepStrictEqual(posts[0].allowedMentions, { parse: [] })
  const [txt, json, proof] = posts[0].files
  assert.deepStrictEqual(posts[0].files.map(f => f.name), ['pk-g0012-arvel.txt', 'pk-g0012-arvel.json', '001-proof.png'])
  assert.deepStrictEqual(proof.attachment, PROOF)
  const t = JSON.parse(json.attachment.toString())
  assert.strictEqual(t.messages.length, 150)
  assert.deepStrictEqual(t.messages.slice(0, 3).map(m => m.id), [id(1), id(2), id(3)])
  assert.strictEqual(t.messages[149].content, 'message 150')
  assert.deepStrictEqual(t.messages[1].attachments, [{ name: 'proof.png', file: '001-proof.png', size: PROOF.length }])
  assert.deepStrictEqual([t.blank, t.truncated, t.files], [1, false, 1])
  const text = txt.attachment.toString()
  assert.match(text, /Closed by staffer/)
  assert.match(text, /\[file\] proof\.png kept as 001-proof\.png/)
  assert.match(text, /Nearby \(within 40 m\): Brelyna 12 m/)
  assert.match(text, /1 message\(s\) from people came back empty: the bot may lack the Message Content intent/)
  assert.match(text, /my ip is <ip> and <ip>, proof attached/)
  // Staff see the empty count in the line itself, not only inside the file
  assert.match(posts[0].content, /150 message\(s\), 1 file\(s\)\. 1 message\(s\) from people came back empty/)
  for (const body of [text, json.attachment.toString(), posts[0].content]) assert.doesNotMatch(body, IP_RE)
})

test('many attachments are split across messages within the upload limits', async () => {
  config.discordTicketTranscriptChannelId = id(777)
  const more = {}
  for (let n = 10; n < 22; n++) more[n] = message(n, { attachments: file(`clip${n}.png`) })
  const { client, posts } = staffClient()
  assert.strictEqual(await save(ticketChannel({ more }), closer, { client, dir: path.join(root, 'split'), ...files() }),
    'posted to the transcript channel')
  assert.deepStrictEqual(posts.map(p => p.files.length), [10, 5])
  assert.match(posts[1].content, /^Transcript of \*\*pk-g0012-arvel\*\*, files 2 of 2\.$/)
  assert.strictEqual(posts.flatMap(p => p.files).filter(f => /^\d{3}-/.test(f.name)).length, 13)
})

test('without a transcript channel the transcript and its files are saved 0600 in 0700 folders', async () => {
  config.discordTicketTranscriptChannelId = ''
  const dir = path.join(root, 'saved')
  assert.strictEqual(await save(ticketChannel(), closer, { client: staffClient().client, dir, ...files() }),
    'saved as pk-g0012-arvel.json with 1 file(s) in pk-g0012-arvel-files')
  assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700)
  const json = path.join(dir, 'pk-g0012-arvel.json')
  const proof = path.join(dir, 'pk-g0012-arvel-files', '001-proof.png')
  assert.strictEqual(fs.statSync(json).mode & 0o777, 0o600)
  assert.strictEqual(fs.statSync(path.dirname(proof)).mode & 0o777, 0o700)
  assert.strictEqual(fs.statSync(proof).mode & 0o777, 0o600)
  assert.deepStrictEqual(fs.readFileSync(proof), PROOF)
  const body = fs.readFileSync(json, 'utf8')
  assert.doesNotMatch(body, IP_RE)
  assert.strictEqual(JSON.parse(body).messages.length, 150)
  // A second close of a channel with the same name never overwrites the first
  assert.match(await save(ticketChannel(), closer, { client: staffClient().client, dir, ...files() }),
    /^saved as pk-g0012-arvel-\d+\.json with 1 file\(s\) in pk-g0012-arvel-\d+-files$/)
})

test('a transcript channel people outside staff can read, or in another server, is refused and files saved', async () => {
  config.discordTicketTranscriptChannelId = id(777)
  const cases = [{ everyoneCanView: true }, { guildId: id(3) }, { memberRoleCanView: true }, { memberAllow: id(9001) },
    { noPerms: true }]
  for (const [n, opts] of cases.entries()) {
    const dir = path.join(root, `refused-${n}`)
    const { client, posts } = staffClient(opts)
    assert.strictEqual(await save(ticketChannel(), closer, { client, dir, ...files() }),
      'saved as pk-g0012-arvel.json with 1 file(s) in pk-g0012-arvel-files', JSON.stringify(opts))
    assert.strictEqual(posts.length, 0, JSON.stringify(opts))
  }
})

test('an attachment too large for the channel sends the whole transcript to a file instead', async () => {
  config.discordTicketTranscriptChannelId = id(777)
  const dir = path.join(root, 'big')
  const { client, posts } = staffClient()
  assert.strictEqual(await save(ticketChannel(), closer, { client, dir, ...files({ big: ['proof.png'] }) }),
    'saved as pk-g0012-arvel.json with 1 file(s) in pk-g0012-arvel-files')
  assert.strictEqual(posts.length, 0)
  assert.strictEqual(fs.statSync(path.join(dir, 'pk-g0012-arvel-files', '001-proof.png')).size, 8 * 1024 * 1024 + 1)
})

test('forwarded messages and polls are kept and not counted as empty', async () => {
  config.discordTicketTranscriptChannelId = ''
  const snap = { content: 'forwarded evidence', embeds: [], attachments: file('fwd.png'), stickers: new Map() }
  const poll = { question: { text: 'Was it him?' }, answers: new Map([[1, { text: 'Yes', voteCount: 2 }], [2, { text: 'No', voteCount: 0 }]]) }
  const more = { 4: message(4, { content: '', messageSnapshots: new Map([['x', snap]]) }), 5: message(5, { content: '', poll }) }
  const dir = path.join(root, 'forwarded')
  await save(ticketChannel({ more }), closer, { client: staffClient().client, dir, ...files() })
  const t = JSON.parse(fs.readFileSync(path.join(dir, 'pk-g0012-arvel.json'), 'utf8'))
  assert.deepStrictEqual(t.messages[3].forwarded, [{ content: 'forwarded evidence', embeds: [], stickers: 0,
    attachments: [{ name: 'fwd.png', file: '002-fwd.png', size: 16 }] }])
  assert.deepStrictEqual(t.messages[4].poll, { question: 'Was it him?', answers: [{ text: 'Yes', votes: 2 }, { text: 'No', votes: 0 }] })
  assert.strictEqual(t.blank, 1, 'only message 3')
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'pk-g0012-arvel-files')).sort(), ['001-proof.png', '002-fwd.png'])
})

function closeClick(channel) {
  const replies = []
  return { replies, interaction: { channel, user: closer, reply: async r => { replies.push(r) } } }
}

test('an attachment that cannot be downloaded keeps the channel open', async () => {
  config.discordTicketTranscriptChannelId = ''
  const channel = ticketChannel()
  const dir = path.join(root, 'failed-download')
  const opts = { client: staffClient().client, dir, ...files({ fail: ['proof.png'] }) }
  await assert.rejects(save(ticketChannel(), closer, opts), /download failed/)
  const { interaction } = closeClick(channel)
  await closeTicket(interaction, { wait: 0, transcripts: { save: (c, who) => save(c, who, opts) } })
  assert.strictEqual(channel.deleted, false)
  assert.match(channel.sent[0], /transcript could not be saved, so this channel stays open/)
  assert.strictEqual(fs.existsSync(path.join(dir, 'pk-g0012-arvel.json')), false)
})

test('when every message from people came back empty the channel is kept', async () => {
  config.discordTicketTranscriptChannelId = id(777)
  const more = { 2: message(2, { content: '' }) }
  for (let n = 4; n <= 150; n++) more[n] = message(n, { content: '' })
  const channel = ticketChannel({ more })
  const { client, posts } = staffClient()
  const opts = { client, dir: path.join(root, 'intent'), ...files() }
  await assert.rejects(save(channel, closer, opts), /all 149 message\(s\) from people came back empty/)
  const { interaction } = closeClick(channel)
  await closeTicket(interaction, { wait: 0, transcripts: { save: (c, who) => save(c, who, opts) } })
  assert.strictEqual(channel.deleted, false)
  assert.strictEqual(posts.length, 0)
})

test('a ticket longer than the cap keeps the newest messages, says so and keeps the channel', async () => {
  config.discordTicketTranscriptChannelId = id(777)
  const channel = ticketChannel({ count: MAX_MESSAGES + 50 })
  const { client, posts } = staffClient()
  const opts = { client, dir: path.join(root, 'long'), ...files() }
  const { interaction } = closeClick(channel)
  await closeTicket(interaction, { wait: 0, transcripts: { save: (c, who) => save(c, who, opts) } })
  assert.strictEqual(channel.deleted, false)
  assert.match(channel.sent[0], /too long to keep in full, so this channel stays open/)
  const t = JSON.parse(posts[0].files[1].attachment.toString())
  assert.deepStrictEqual([t.truncated, t.messages.length, t.messages[0].id], [true, MAX_MESSAGES, id(51)])
  assert.match(posts[0].content, /Longer than 5000 messages: only the newest are here, and the channel was kept\./)
  assert.match(posts[0].files[0].attachment.toString(), /the oldest are not in this transcript/)
  // Exactly the cap is a whole ticket
  const exact = staffClient()
  assert.strictEqual(await save(ticketChannel({ count: MAX_MESSAGES }), closer, { ...opts, client: exact.client }),
    'posted to the transcript channel')
  assert.strictEqual(JSON.parse(exact.posts[0].files[1].attachment.toString()).truncated, false)
})

test('downloads go only to the Discord CDN', async () => {
  for (const url of ['https://evil.example/a.png', 'http://cdn.discordapp.com/a.png', 'https://cdn.discordapp.com.evil.example/a.png', '']) {
    await assert.rejects(download({ url }), /not on the Discord CDN/, url)
  }
})

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
