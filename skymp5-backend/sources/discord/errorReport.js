'use strict'
// Opens one thread per problem report in the bug-tracker forum (formerly #error-report): the title is the reporter's
// name, the body is the summary, the logs and any screenshot ride along as attachments, and tags come from the tag map.
// Same shape as audit.js (plain https, bot token, retry once on a rate limit) so there is nothing new to learn.

const fs = require('fs')
const https = require('https')
const config = require('../../config')

const REQUEST_TIMEOUT_MS = 15 * 1000
// Everything one report does with Discord, retries included, ends inside this, under the launcher's 30 s wait
const REPORT_DEADLINE_MS = 25 * 1000

function request(method, path, { json, multipart, deadline } = {}) {
  return new Promise((resolve, reject) => {
    const allowed = Math.min(REQUEST_TIMEOUT_MS, deadline ? deadline - Date.now() : REQUEST_TIMEOUT_MS)
    if (allowed <= 0) return reject(new Error(`discord ${method} ${path} skipped: report deadline passed`))
    let body
    const headers = { Authorization: `Bot ${config.discordBotToken}` }
    if (multipart) {
      body = multipart.body
      headers['Content-Type'] = `multipart/form-data; boundary=${multipart.boundary}`
    } else if (json !== undefined) {
      body = Buffer.from(JSON.stringify(json))
      headers['Content-Type'] = 'application/json'
    }
    if (body) headers['Content-Length'] = body.length
    // IPv4 only: in CT 115 the default lookup waits ~5 s on an AAAA answer that never comes, an IPv4 one takes ~30 ms
    const req = https.request({ hostname: 'discord.com', path: `/api/v10${path}`, method, headers, family: 4 }, res => {
      let text = ''
      res.on('data', c => { text += c })
      res.on('end', () => {
        if (res.statusCode < 300) return resolve(text ? JSON.parse(text) : null)
        const err = new Error(`discord ${method} ${path} failed (${res.statusCode}): ${text.slice(0, 200)}`)
        err.statusCode = res.statusCode
        err.body = text
        reject(err)
      })
    })
    // A plain timer, as in oauth.js: req.setTimeout would inherit the default agent's 5 s socket timeout during the lookup
    const timer = setTimeout(() => req.destroy(new Error(`discord ${method} ${path} timed out`)), allowed)
    req.on('close', () => clearTimeout(timer))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

// Discord takes files as multipart with a payload_json part alongside each files[n] part.
function buildMultipart(payload, files) {
  const boundary = '----dbo' + Date.now().toString(16) + Math.random().toString(16).slice(2)
  const parts = []
  const field = (name, value, filename, type) => {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"`
      + (filename ? `; filename="${filename}"` : '')
      + `\r\nContent-Type: ${type}\r\n\r\n`))
    parts.push(Buffer.isBuffer(value) ? value : Buffer.from(value))
    parts.push(Buffer.from('\r\n'))
  }
  field('payload_json', JSON.stringify(payload), null, 'application/json')
  files.forEach((f, i) => field(`files[${i}]`, f.data || f.text, f.name, f.type || 'text/plain; charset=utf-8'))
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return { boundary, body: Buffer.concat(parts) }
}

// Tag ids by name from the forum's tag map file; a missing or unreadable file means no tags
function tagIds(names) {
  let map
  try { map = JSON.parse(fs.readFileSync(config.bugTagsFile, 'utf8')) } catch { return [] }
  if (!map || typeof map !== 'object') return []
  return names.map(n => map[n]).filter(id => typeof id === 'string' && /^\d{5,25}$/.test(id))
}

// A 400 or 403 of a tagged post may be its tags (stale or moderator-only); of an untagged one, only a 400 naming tags
function tagRefusal(err, payload) {
  if (payload.applied_tags) return err.statusCode === 400 || err.statusCode === 403
  return err.statusCode === 400 && /tag/i.test(err.body || '')
}

// Retries once with the forum's current tags, or with none, rather than losing the report
async function retryTags(post, channelId, payload, err, deadline, wanted) {
  // A forum that cannot be read only means the retry goes untagged
  const channel = await request('GET', `/channels/${channelId}`, { deadline }).catch(e => {
    console.warn(`[report] could not read the forum's tags: ${e.message}`)
    return null
  })
  const tags = (channel && channel.available_tags) || []
  const tried = payload.applied_tags || []
  // Stale ids (a 400) give way to the same names; a 403, or the same ids again, means the tags themselves are refused
  let pick = err.statusCode === 400 ? wanted.map(n => tags.find(t => t.name === n)).filter(Boolean) : []
  if (pick.every(t => tried.includes(t.id))) pick = []
  // Any tag only when the forum requires one: the REQUIRE_TAG flag, or a refusal of an untagged post
  if (!pick.length && channel && (channel.flags & 16 || !tried.length)) {
    pick = [tags.find(t => /bug|error|launcher|report/i.test(t.name)) || tags[0]].filter(Boolean)
  }
  if (!pick.length && !tried.length) throw err
  console.warn(`[report] forum refused the post (${err.statusCode}); retrying with ${pick.map(t => t.name).join(', ') || 'no tags'}`)
  const { applied_tags: _refused, ...rest } = payload
  return post(pick.length ? { ...rest, applied_tags: pick.map(t => t.id) } : rest)
}

// wanted: tag names; on a tag refusal they are looked up in the forum's own tags by exact name first
async function createThread(channelId, payload, files, deadline, wanted = []) {
  const post = body => request('POST', `/channels/${channelId}/threads`, { multipart: buildMultipart(body, files), deadline })
  let refusal
  try {
    return await post(payload)
  } catch (err) {
    refusal = err
  }
  // One wait on a rate limit; a refusal of that second try still gets the tag handling below
  if (refusal.statusCode === 429) {
    let wait = 1000
    try { wait = Math.min((JSON.parse(refusal.body).retry_after || 1) * 1000 + 250, 20000) } catch { /* default */ }
    if (Date.now() + wait >= deadline) throw refusal
    await new Promise(r => setTimeout(r, wait))
    try {
      return await post(payload)
    } catch (err) {
      refusal = err
    }
  }
  if (tagRefusal(refusal, payload)) return retryTags(post, channelId, payload, refusal, deadline, wanted)
  throw refusal
}

// files: [{ name, text }] logs or [{ name, data, type }] binaries; tags: tag names. Returns the thread id, or null when no forum channel is configured.
async function postReport({ title, summary, files = [], tags = [] }) {
  const channelId = config.discordErrorForumChannelId
  if (!channelId || !config.discordBotToken) return null
  const payload = {
    name: String(title || 'Problem report').slice(0, 100),
    message: {
      content: String(summary || '').slice(0, 1900),
      allowed_mentions: { parse: [] },
      attachments: files.map((f, i) => ({ id: i, filename: f.name })),
    },
  }
  const applied = tagIds(tags)
  if (applied.length) payload.applied_tags = applied
  const thread = await createThread(channelId, payload, files, Date.now() + REPORT_DEADLINE_MS, tags)
  return thread && thread.id
}

module.exports = { postReport, tagIds }
