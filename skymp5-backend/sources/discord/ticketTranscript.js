'use strict'
// Keeps a ticket before its channel is deleted: posted to a staff-only channel, or saved as 0600 files when none is set or the post fails.
// Text goes through the log scrubber, so no IP address, token or account name survives; attachments are downloaded and kept with it.

const fs = require('fs')
const path = require('path')
const { OverwriteType, PermissionFlagsBits } = require('discord.js')
const config = require('../../config')
const { scrub } = require('../scrubLog')

const DIR = path.join(__dirname, '..', '..', 'data', 'ticket-transcripts')
const MAX_MESSAGES = 5000
const UPLOAD_BYTES = 8 * 1024 * 1024        // per staff-channel message, under Discord's 10 MiB default upload limit
const FILES_PER_MESSAGE = 10
const MAX_FILE_BYTES = 64 * 1024 * 1024     // all of one ticket's attachments; more keeps the channel open for staff
const DOWNLOAD_MS = 60 * 1000
const CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net'])
const clean = value => (value ? scrub(String(value), 64 * 1024).text : '')
const byId = (a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)

// Newest first, as Discord serves them; past MAX_MESSAGES the oldest are left out and the result says so
async function fetchMessages(channel) {
  const all = []
  let before
  for (;;) {
    const page = [...(await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) })).values()].sort(byId)
    all.push(...page)
    if (page.length < 100) return { messages: all.sort(byId), truncated: false }
    before = page[0].id
    if (all.length >= MAX_MESSAGES) {
      // One more look tells a ticket of exactly the cap from a longer one
      const more = await channel.messages.fetch({ limit: 1, before })
      return { messages: all.sort(byId), truncated: more.size > 0 }
    }
  }
}

const embedsOf = m => (m.embeds || []).map(e => ({
  title: clean(e.title), description: clean(e.description),
  fields: (e.fields || []).map(f => ({ name: clean(f.name), value: clean(f.value) })), footer: clean(e.footer?.text),
}))

// wanted collects every attachment to download; the record names the file it is kept as
function record(m, wanted) {
  const keep = msg => [...(msg.attachments?.values() || [])].map(a => {
    const safe = clean(a.name).replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(-80) || 'file'
    const file = `${String(wanted.length + 1).padStart(3, '0')}-${safe}`
    wanted.push({ file, url: String(a.url || ''), size: a.size || 0 })
    return { name: clean(a.name), file, size: a.size || 0 }
  })
  // A forwarded message keeps its text and files in a snapshot, not in the message itself
  const forwarded = [...(m.messageSnapshots?.values() || [])].map(s => ({
    content: clean(s.content), embeds: embedsOf(s), attachments: keep(s), stickers: s.stickers?.size || 0,
  }))
  const poll = m.poll ? {
    question: clean(m.poll.question?.text),
    answers: [...(m.poll.answers?.values() || [])].map(a => ({ text: clean(a.text), votes: a.voteCount || 0 })),
  } : null
  return {
    id: m.id,
    at: new Date(m.createdTimestamp).toISOString(),
    author: { id: m.author?.id || null, name: clean(m.author?.tag || m.author?.username), bot: !!m.author?.bot },
    system: !!m.system,
    content: clean(m.content),
    embeds: embedsOf(m),
    attachments: keep(m),
    stickers: m.stickers?.size || 0,
    ...(forwarded.length ? { forwarded } : {}),
    ...(poll ? { poll } : {}),
  }
}

const isBlank = m => !m.content && !m.embeds.length && !m.attachments.length && !m.stickers && !m.forwarded && !m.poll

function summary(t, base) {
  return [`Transcript of **${base}**: ${t.topic || 'no topic'}. Closed by ${t.closedBy.name}.`,
    `${t.messages.length} message(s), ${t.files} file(s).`,
    t.blank ? `${t.blank} message(s) from people came back empty: check the bot's Message Content intent.` : '',
    t.truncated ? `Longer than ${MAX_MESSAGES} messages: only the newest are here, and the channel was kept.` : '',
  ].filter(Boolean).join(' ')
}

function toText(t) {
  const lines = [`Ticket #${t.ticket} (channel ${t.channelId})`, `Topic: ${t.topic || '-'}`,
    `Closed by ${t.closedBy.name} (${t.closedBy.id}) at ${t.closedAt}`, `${t.messages.length} message(s), ${t.files || 0} file(s)`]
  if (t.truncated) lines.push(`Longer than ${MAX_MESSAGES} messages: the oldest are not in this transcript.`)
  if (t.blank) lines.push(`${t.blank} message(s) from people came back empty: the bot may lack the Message Content intent.`)
  const body = (m, pad) => {
    if (m.content) lines.push(pad + m.content.split('\n').join(`\n${pad}`))
    for (const e of m.embeds) {
      lines.push(...[e.title && `${pad}  [embed] ${e.title}`, e.description && `${pad}  ${e.description}`].filter(Boolean))
      for (const f of e.fields) lines.push(`${pad}  ${f.name}: ${f.value}`)
      if (e.footer) lines.push(`${pad}  ${e.footer}`)
    }
    for (const a of m.attachments) lines.push(`${pad}  [file] ${a.name} kept as ${a.file}`)
    if (m.stickers) lines.push(`${pad}  [${m.stickers} sticker(s)]`)
  }
  for (const m of t.messages) {
    lines.push('', `[${m.at.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}] ${m.author.name} (${m.author.id})${m.author.bot ? ' [bot]' : ''}:`)
    body(m, '')
    for (const f of m.forwarded || []) { lines.push('  [forwarded]'); body(f, '  ') }
    if (m.poll) {
      lines.push(`  [poll] ${m.poll.question}`)
      for (const a of m.poll.answers) lines.push(`    ${a.text}: ${a.votes} vote(s)`)
    }
  }
  return lines.join('\n') + '\n'
}

// Only Discord's own CDN is fetched, so a crafted attachment url cannot make the bot call anything else
async function download({ url }) {
  let host = ''
  try { host = new URL(url).hostname } catch { /* not a url */ }
  if (!url.startsWith('https://') || !CDN_HOSTS.has(host)) throw new Error('attachment is not on the Discord CDN')
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_MS) })
  if (!res.ok) throw new Error(`attachment download failed (${res.status})`)
  return Buffer.from(await res.arrayBuffer())
}

async function build(channel, closer, fetchFile) {
  const { messages: raw, truncated } = await fetchMessages(channel)
  const wanted = []
  const messages = raw.map(m => record(m, wanted))
  const people = messages.filter(m => !m.author.bot && !m.system)
  const blank = people.filter(isBlank).length
  // Every message from people empty is the Message Content intent switched off, not a quiet ticket
  if (people.length && blank === people.length) {
    throw new Error(`all ${blank} message(s) from people came back empty: the bot lacks the Message Content intent`)
  }
  const declared = wanted.reduce((n, w) => n + w.size, 0)
  if (declared > MAX_FILE_BYTES) throw new Error(`attachments too large to keep (${Math.ceil(declared / 1048576)} MiB)`)
  // Attachment links expire and die with the channel, so every file is downloaded now or the ticket stays open
  const files = []
  let total = 0
  for (const w of wanted) {
    const data = await fetchFile(w)
    total += data.length
    if (total > MAX_FILE_BYTES) throw new Error('attachments too large to keep')
    files.push({ file: w.file, data })
  }
  const t = {
    ticket: channel.name, channelId: channel.id, topic: clean(channel.topic),
    closedBy: { id: closer.id, name: clean(closer.tag || closer.username) }, closedAt: new Date().toISOString(),
    blank, truncated, files: files.length, messages,
  }
  return { t, files }
}

// Administrator roles see every channel and are skipped; any other role or member that can view it must be staff
function openTo(target, client) {
  const roles = target.guild?.roles
  if (!roles?.everyone || !roles.cache) return 'the server roles are unknown'
  const staff = new Set(config.discordStaffRoleIds || [])
  const me = client.user?.id
  const view = PermissionFlagsBits.ViewChannel
  for (const role of [roles.everyone, ...roles.cache.values()]) {
    if (staff.has(role.id) || (me && role.tags?.botId === me)) continue
    if (role.id !== roles.everyone.id && role.permissions?.has(PermissionFlagsBits.Administrator)) continue
    const perms = target.permissionsFor(role)
    if (!perms || perms.has(view)) return `role ${role.name || role.id} can view it`
  }
  for (const o of target.permissionOverwrites?.cache?.values() || []) {
    if (o.type === OverwriteType.Member && o.id !== me && o.allow?.has(view)) return `member ${o.id} can view it`
  }
  return ''
}

// Groups files into messages of at most FILES_PER_MESSAGE files and UPLOAD_BYTES
function pack(uploads) {
  const out = []
  for (const u of uploads) {
    if (u.data.length > UPLOAD_BYTES) throw new Error(`${u.name} is too large for the transcript channel`)
    const last = out[out.length - 1]
    const size = last ? last.reduce((n, x) => n + x.data.length, 0) : 0
    if (last && last.length < FILES_PER_MESSAGE && size + u.data.length <= UPLOAD_BYTES) last.push(u)
    else out.push([u])
  }
  return out
}

// A channel people outside staff can read, or one in another server, is refused rather than trusted
async function postToStaff(client, channel, t, files, base) {
  const target = await client.channels.fetch(config.discordTicketTranscriptChannelId).catch(() => null)
  if (!target || typeof target.send !== 'function') throw new Error('transcript channel not found')
  if (target.guildId !== channel.guildId) throw new Error('transcript channel is in another server')
  const open = openTo(target, client)
  if (open) throw new Error(`transcript channel is not staff only: ${open}`)
  const groups = pack([{ name: `${base}.txt`, data: Buffer.from(toText(t)) },
    { name: `${base}.json`, data: Buffer.from(JSON.stringify(t, null, 2)) }, ...files.map(f => ({ name: f.file, data: f.data }))])
  for (const [i, group] of groups.entries()) {
    await target.send({
      content: (i ? `Transcript of **${base}**, files ${i + 1} of ${groups.length}.` : summary(t, base)).slice(0, 1900),
      files: group.map(u => ({ attachment: u.data, name: u.name })),
      allowedMentions: { parse: [] },
    })
  }
}

function saveFile(t, files, base, dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
  const body = JSON.stringify(t, null, 2) + '\n'
  for (const stem of [base, `${base}-${Date.now()}`]) {
    const sub = path.join(dir, `${stem}-files`)
    if (fs.existsSync(sub)) continue
    try {
      fs.writeFileSync(path.join(dir, `${stem}.json`), body, { mode: 0o600, flag: 'wx' })
    } catch (err) {
      if (err.code === 'EEXIST') continue
      throw err
    }
    if (!files.length) return `${stem}.json`
    fs.mkdirSync(sub, { mode: 0o700 })
    for (const f of files) fs.writeFileSync(path.join(sub, f.file), f.data, { mode: 0o600, flag: 'wx' })
    return `${stem}.json with ${files.length} file(s) in ${stem}-files`
  }
  throw new Error('transcript file name taken')
}

// Returns where the transcript went; throws when it was kept nowhere, or was kept but the channel must stay open
async function save(channel, closer, { client = channel.client, dir = DIR, fetchFile = download } = {}) {
  const { t, files } = await build(channel, closer, fetchFile)
  const base = String(channel.name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 80) || `ticket-${channel.id}`
  let where = ''
  if (config.discordTicketTranscriptChannelId) {
    try {
      await postToStaff(client, channel, t, files, base)
      where = 'posted to the transcript channel'
    } catch (err) {
      console.error(`[tickets] transcript post for #${base} failed, saving a file instead:`, err.message)
    }
  }
  if (!where) where = `saved as ${saveFile(t, files, base, dir)}`
  if (t.truncated) {
    const err = new Error(`longer than ${MAX_MESSAGES} messages, the newest ${where}; the channel stays open`)
    err.channelNote = 'This ticket is too long to keep in full, so this channel stays open. Tell a staff member.'
    throw err
  }
  return where
}

module.exports = { save, toText, download, MAX_MESSAGES }
