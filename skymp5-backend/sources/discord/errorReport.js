'use strict'
// Opens a thread in the error-report forum for one problem report: the title is the reporter's
// Discord name, the body is the summary, and the logs and any screenshot ride along as attachments.
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

// wanted: tag names; on a tag refusal they are looked up in the forum's own tags by exact name first
async function createThread(channelId, payload, files, deadline, wanted = []) {
  const mp = buildMultipart(payload, files)
  try {
    return await request('POST', `/channels/${channelId}/threads`, { multipart: mp, deadline })
  } catch (err) {
    if (err.statusCode === 429) {
      let wait = 1000
      try { wait = Math.min((JSON.parse(err.body).retry_after || 1) * 1000 + 250, 20000) } catch { /* default */ }
      if (Date.now() + wait >= deadline) throw err
      await new Promise(r => setTimeout(r, wait))
      return request('POST', `/channels/${channelId}/threads`, { multipart: buildMultipart(payload, files), deadline })
    }
    // A required or stale tag: retry once with the forum's current tags, or with none, rather than losing the report
    if (err.statusCode === 400 && /tag/i.test(err.body || '')) {
      const channel = await request('GET', `/channels/${channelId}`, { deadline })
      const tags = channel.available_tags || []
      const named = wanted.map(n => tags.find(t => t.name === n)).filter(Boolean)
      // Any tag only when the forum requires one: the REQUIRE_TAG flag, or a refusal of an untagged post
      const anyTag = channel.flags & 16 || !payload.applied_tags ? [tags.find(t => /bug|error|launcher|report/i.test(t.name)) || tags[0]] : []
      const pick = named.length ? named : anyTag.filter(Boolean)
      if (pick.length || payload.applied_tags) {
        console.warn(`[report] forum refused the tags; retrying with ${pick.map(t => t.name).join(', ') || 'no tags'}`)
        const { applied_tags: _stale, ...rest } = payload
        const retry = pick.length ? { ...rest, applied_tags: pick.map(t => t.id) } : rest
        return request('POST', `/channels/${channelId}/threads`, { multipart: buildMultipart(retry, files), deadline })
      }
    }
    throw err
  }
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
