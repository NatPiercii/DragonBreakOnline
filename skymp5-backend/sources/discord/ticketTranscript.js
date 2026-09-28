'use strict'
// Keeps a ticket before its channel is deleted: posted to a staff-only channel, or saved as a 0600 file when none is set or the post fails.
// Text goes through the log scrubber, so no IP address, token or account name survives; attachments are kept as name and link.

const fs = require('fs')
const path = require('path')
const { PermissionFlagsBits } = require('discord.js')
const config = require('../../config')
const { scrub } = require('../scrubLog')

const DIR = path.join(__dirname, '..', '..', 'data', 'ticket-transcripts')
const MAX_MESSAGES = 5000
const clean = value => (value ? scrub(String(value), 64 * 1024).text : '')
const byId = (a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)

async function fetchMessages(channel) {
  const all = []
  let before
  while (all.length < MAX_MESSAGES) {
    const page = [...(await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) })).values()].sort(byId)
    all.push(...page)
    if (page.length < 100) break
    before = page[0].id
  }
  return all.sort(byId)
}

function record(m) {
  return {
    id: m.id,
    at: new Date(m.createdTimestamp).toISOString(),
    author: { id: m.author?.id || null, name: clean(m.author?.tag || m.author?.username), bot: !!m.author?.bot },
    content: clean(m.content),
    embeds: (m.embeds || []).map(e => ({
      title: clean(e.title), description: clean(e.description),
      fields: (e.fields || []).map(f => ({ name: clean(f.name), value: clean(f.value) })), footer: clean(e.footer?.text),
    })),
    attachments: [...(m.attachments?.values() || [])].map(a => ({ name: clean(a.name), url: a.url })),
    stickers: m.stickers?.size || 0,
  }
}

function toText(t) {
  const lines = [`Ticket #${t.ticket} (channel ${t.channelId})`, `Topic: ${t.topic || '-'}`,
    `Closed by ${t.closedBy.name} (${t.closedBy.id}) at ${t.closedAt}`, `${t.messages.length} message(s)`]
  if (t.blank) lines.push(`${t.blank} message(s) from people came back empty: the bot may lack the Message Content intent.`)
  for (const m of t.messages) {
    lines.push('', `[${m.at.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}] ${m.author.name} (${m.author.id})${m.author.bot ? ' [bot]' : ''}:`)
    if (m.content) lines.push(m.content)
    for (const e of m.embeds) {
      lines.push(...[e.title && `  [embed] ${e.title}`, e.description && `  ${e.description}`].filter(Boolean))
      for (const f of e.fields) lines.push(`  ${f.name}: ${f.value}`)
      if (e.footer) lines.push(`  ${e.footer}`)
    }
    for (const a of m.attachments) lines.push(`  [file] ${a.name} ${a.url}`)
    if (m.stickers) lines.push(`  [${m.stickers} sticker(s)]`)
  }
  return lines.join('\n') + '\n'
}

async function build(channel, closer) {
  const messages = (await fetchMessages(channel)).map(record)
  const blank = messages.filter(m => !m.author.bot && !m.content && !m.embeds.length && !m.attachments.length && !m.stickers).length
  return {
    ticket: channel.name, channelId: channel.id, topic: clean(channel.topic),
    closedBy: { id: closer.id, name: clean(closer.tag || closer.username) }, closedAt: new Date().toISOString(),
    blank, messages,
  }
}

// A channel @everyone can read, or one in another server, is refused rather than trusted
async function postToStaff(client, channel, t, base) {
  const target = await client.channels.fetch(config.discordTicketTranscriptChannelId).catch(() => null)
  if (!target || typeof target.send !== 'function') throw new Error('transcript channel not found')
  const everyone = target.guild?.roles?.everyone
  const open = !everyone || target.permissionsFor(everyone)?.has(PermissionFlagsBits.ViewChannel) !== false
  if (open || target.guildId !== channel.guildId) throw new Error('transcript channel is not staff only')
  await target.send({
    content: `Transcript of **${base}**: ${t.topic || 'no topic'}. Closed by ${t.closedBy.name}. ${t.messages.length} message(s).`.slice(0, 1900),
    files: [{ attachment: Buffer.from(toText(t)), name: `${base}.txt` }, { attachment: Buffer.from(JSON.stringify(t, null, 2)), name: `${base}.json` }],
    allowedMentions: { parse: [] },
  })
}

function saveFile(t, base, dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
  const body = JSON.stringify(t, null, 2) + '\n'
  for (const name of [`${base}.json`, `${base}-${Date.now()}.json`]) {
    try {
      fs.writeFileSync(path.join(dir, name), body, { mode: 0o600, flag: 'wx' })
      return name
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
  }
  throw new Error('transcript file name taken')
}

// Returns where the transcript went, or throws when it could be kept nowhere
async function save(channel, closer, { client = channel.client, dir = DIR } = {}) {
  const t = await build(channel, closer)
  const base = String(channel.name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 80) || `ticket-${channel.id}`
  if (config.discordTicketTranscriptChannelId) {
    try {
      await postToStaff(client, channel, t, base)
      return 'posted to the transcript channel'
    } catch (err) {
      console.error(`[tickets] transcript post for #${base} failed, saving a file instead:`, err.message)
    }
  }
  return `saved as ${saveFile(t, base, dir)}`
}

module.exports = { save, toText }
