'use strict'
// One problem report from the launcher, the game or the website: logs are scrubbed, a screenshot must be
// a small JPEG from a signed-in player, and the report becomes a thread in the error-report forum.

const crypto  = require('crypto')
const express = require('express')
const config  = require('../config')
const { scrub, dropUiLines } = require('./scrubLog')
const { postReport } = require('./discord/errorReport')
const audit = require('./discord/audit')

const LOG_FIELDS = [['launcherLog', 'launcher.log'], ['clientLog', 'client.log'], ['gameLog', 'skyrim-platform.log'],
                    ['skseLog', 'skse64.log']]
// Only these context fields are ever repeated back into Discord, and each is scrubbed like a log
const CONTEXT_FIELDS = ['launcherVersion', 'clientVersion', 'filesVersion', 'os', 'gameVersion',
                        'installDir', 'step', 'error', 'mo2Enabled', 'freeSpaceGb']
const SOURCES = { launcher: 'from the launcher', game: 'in game', site: 'from the website' }
// A 1080p JPEG at quality 80 measured 213-489 KiB; the cap leaves room for the logs inside a 2 MB body
const MAX_IMAGE_BYTES = 700 * 1024
const MAX_IMAGE_BASE64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 8
const NOTE_CHARS = 600
const DEDUPE_MS = 60 * 60 * 1000
const seenReports = new Map()

// Compressed bodies are refused: inflating one would let a 2 kB request cost a 2 MB parse
const parseReport = express.json({ limit: '2mb', inflate: false })

// Only plain values become text; objects and arrays in a text field are ignored rather than stringified
function text(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

// Names go into a thread title and a bold header line, so control characters and markdown are neutralised
function cleanName(value) {
  const name = [...text(value).replace(/[\x00-\x1f\x7f\u00ad\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim()]
    .slice(0, 64).join('').trim()
  return name || 'Unknown player'
}
// '<' and ':' too, so a typed mention or link cannot render as one
const escapeMarkdown = s => s.replace(/[\\*_~`|<>#[\]():]/g, '\\$&')

// Keyed per sender, so one sender can never mark another sender's report as a duplicate
function seenReport(key) {
  const now = Date.now()
  for (const [id, entry] of seenReports) if (entry.state === 'done' && now - entry.at > DEDUPE_MS) seenReports.delete(id)
  return seenReports.get(key) || null
}

function decodeScreenshot(shot) {
  if (shot === undefined || shot === null || shot === '') return {}
  if (typeof shot !== 'object' || shot.type !== 'image/jpeg' || typeof shot.data !== 'string') {
    return { error: 'The screenshot must be a JPEG image.' }
  }
  if (shot.data.length > MAX_IMAGE_BASE64) return { error: 'The screenshot is too large. Send a smaller image.' }
  const data = Buffer.from(shot.data, 'base64')
  // JPEG files start FF D8 FF; checking the bytes stops anything else riding in under the label
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) {
    return { error: 'The screenshot must be a JPEG image.' }
  }
  if (data.length > MAX_IMAGE_BYTES) return { error: 'The screenshot is too large. Send a smaller image.' }
  return { data }
}

// reporter: { name, verified, profileId, discordId }. Files the report and returns the HTTP reply to send.
async function submit(reporter, body) {
  if (!config.discordErrorForumChannelId) {
    return { status: 503, json: { error: 'Reporting is not configured on this server.' } }
  }
  const source = Object.prototype.hasOwnProperty.call(SOURCES, body.source) ? body.source : 'launcher'
  const hasShot = body.screenshot !== undefined && body.screenshot !== null && body.screenshot !== ''
  // Without a verified sender the route would be an anonymous image upload into a staff channel
  if (hasShot && !reporter.verified) {
    return { status: 403, json: { error: 'Sign in with Discord to include a screenshot.' } }
  }
  const shot = decodeScreenshot(body.screenshot)
  if (shot.error) return { status: 400, json: { error: shot.error } }

  const files = []
  let redactions = 0
  for (const [field, filename] of LOG_FIELDS) {
    const raw = text(body[field])
    if (!raw) continue
    const cleaned = scrub(field === 'gameLog' ? dropUiLines(raw) : raw)
    redactions += cleaned.redactions
    files.push({ name: filename, text: cleaned.text })
  }
  if (shot.data) files.push({ name: 'screenshot.jpg', data: shot.data, type: 'image/jpeg' })
  const note = text(body.note).trim().slice(0, NOTE_CHARS)
  if (!files.length && !note) return { status: 400, json: { error: 'The report has no logs, screenshot or description.' } }

  const reportId = typeof body.reportId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(body.reportId)
    ? body.reportId : crypto.randomUUID()
  const who = reporter.discordId ? `d:${reporter.discordId}` : reporter.profileId != null ? `p:${reporter.profileId}` : 'anon'
  const dedupeKey = `${who}:${reportId}`
  const seen = seenReport(dedupeKey)
  if (seen && seen.state === 'done') return { status: 200, json: { ok: true, reportId, duplicate: true } }
  // A copy sent while the first is still posting gets the first one's real outcome, not a hopeful answer
  if (seen) {
    const first = await seen.promise
    return first.status === 200 ? { status: 200, json: { ...first.json, duplicate: true } } : first
  }

  const name = cleanName(reporter.name)
  const lines = [`**${escapeMarkdown(name)}** reported a problem ${SOURCES[source]}.`]
  const ids = []
  // A mention shows the account itself; allowed_mentions is empty in the poster, so nobody is pinged
  if (reporter.discordId && /^\d{5,25}$/.test(String(reporter.discordId))) ids.push(`Discord <@${reporter.discordId}>`)
  if (reporter.profileId !== null && reporter.profileId !== undefined) ids.push(`profile ${reporter.profileId}`)
  if (ids.length) lines.push(ids.join(' | '))
  for (const key of CONTEXT_FIELDS) {
    const value = text(body[key])
    if (!value) continue
    lines.push(`${key}: ${scrub(value, 300).text}`)
  }
  // Four bytes per character is the worst case, so a full description in any script survives the byte cap
  if (note) lines.push('', 'What they said:', scrub(note, NOTE_CHARS * 4).text)
  const logs = files.filter(f => f.text !== undefined).length
  lines.push('', `_${logs} log file(s)${shot.data ? ', 1 screenshot' : ''}, ${redactions} redaction(s) applied by the server._`)

  const entry = { state: 'pending', at: Date.now() }
  entry.promise = (async () => {
    try {
      const thread = await postReport({ title: name, summary: lines.join('\n'), files })
      entry.state = 'done'
      entry.at = Date.now()
      audit.log(`REPORT problem ${SOURCES[source]} from ${name}`
                + `${reporter.discordId ? ` (discord ${reporter.discordId})` : ''}`
                + `${reporter.profileId != null ? ` (profile ${reporter.profileId})` : ''}${thread ? ` -> thread ${thread}` : ''}`)
      return { status: 200, json: { ok: true, reportId, thread } }
    } catch (err) {
      seenReports.delete(dedupeKey)
      console.error(`[report] ${reportId} from ${name} could not be filed:`, err.message)
      return { status: 502, json: { error: 'Could not file the report. Tell a staff member directly.' } }
    }
  })()
  seenReports.set(dedupeKey, entry)
  return entry.promise
}

// Sends the reply for a submit() result; an unexpected throw still answers in JSON
async function respond(res, reporter, body) {
  try {
    const result = await submit(reporter, body)
    res.status(result.status).json(result.json)
  } catch (err) {
    console.error('[report] unexpected error:', err.message)
    res.status(500).json({ error: 'Could not file the report. Tell a staff member directly.' })
  }
}

// Body-parser failures answer in JSON instead of the default HTML page with a stack trace
function bodyErrors(err, _req, res, next) {
  if (!err || typeof err.type !== 'string' || !/^(entity\.|encoding\.|charset\.|request\.)/.test(err.type)) return next(err)
  const status = err.type === 'entity.too.large' ? 413
    : err.type === 'encoding.unsupported' || err.type === 'charset.unsupported' ? 415 : 400
  const error = status === 413 ? 'The request is too large.'
    : status === 415 ? 'Send plain, uncompressed JSON.' : 'The request is not valid JSON.'
  res.status(status).json({ error })
}

module.exports = { submit, respond, bodyErrors, parseReport, cleanName, MAX_IMAGE_BYTES }
