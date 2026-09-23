'use strict'
// One problem report from the launcher, the game or the website: logs are scrubbed, a screenshot must be
// a small JPEG from a signed-in player, and the report becomes a thread in the error-report forum.

const crypto = require('crypto')
const config = require('../config')
const { scrub } = require('./scrubLog')
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
const DEDUPE_MS = 60 * 60 * 1000
const seenReports = new Map()

// A retried upload carries the same id and is acknowledged without a second thread
function isDuplicate(reportId) {
  const now = Date.now()
  for (const [id, at] of seenReports) if (now - at > DEDUPE_MS) seenReports.delete(id)
  if (seenReports.has(reportId)) return true
  seenReports.set(reportId, now)
  return false
}

function decodeScreenshot(shot) {
  if (shot === undefined || shot === null || shot === '') return {}
  if (typeof shot !== 'object' || shot.type !== 'image/jpeg' || typeof shot.data !== 'string') {
    return { error: 'The screenshot must be a JPEG image.' }
  }
  const data = Buffer.from(shot.data, 'base64')
  // JPEG files start FF D8 FF; checking the bytes stops anything else riding in under the label
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) {
    return { error: 'The screenshot must be a JPEG image.' }
  }
  if (data.length > MAX_IMAGE_BYTES) return { error: 'The screenshot is too large. Send a smaller image.' }
  return { data }
}

// reporter: { name, verified, profileId }. Returns the HTTP reply, plus send() when there is a thread to post.
function prepare(reporter, body) {
  if (!config.discordErrorForumChannelId) {
    return { status: 503, json: { error: 'Reporting is not configured on this server.' } }
  }
  const source = Object.prototype.hasOwnProperty.call(SOURCES, body.source) ? body.source : 'launcher'
  const shot = decodeScreenshot(body.screenshot)
  if (shot.error) return { status: 400, json: { error: shot.error } }
  // Without a verified sender the route would be an anonymous image upload into a staff channel
  if (shot.data && !reporter.verified) {
    return { status: 403, json: { error: 'Sign in with Discord to include a screenshot.' } }
  }

  const files = []
  let redactions = 0
  for (const [field, filename] of LOG_FIELDS) {
    if (!body[field]) continue
    const cleaned = scrub(body[field])
    redactions += cleaned.redactions
    files.push({ name: filename, text: cleaned.text })
  }
  if (shot.data) files.push({ name: 'screenshot.jpg', data: shot.data, type: 'image/jpeg' })
  const note = typeof body.note === 'string' ? body.note.trim() : ''
  if (!files.length && !note) return { status: 400, json: { error: 'The report has no logs, screenshot or description.' } }

  const reportId = typeof body.reportId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(body.reportId)
    ? body.reportId : crypto.randomUUID()
  if (isDuplicate(reportId)) return { status: 200, json: { ok: true, reportId, duplicate: true } }

  const lines = [`**${reporter.name}** reported a problem ${SOURCES[source]}.`]
  if (reporter.profileId !== null && reporter.profileId !== undefined) lines.push(`profile ${reporter.profileId}`)
  for (const key of CONTEXT_FIELDS) {
    if (body[key] === undefined || body[key] === null || body[key] === '') continue
    lines.push(`${key}: ${scrub(String(body[key]), 300).text}`)
  }
  if (note) lines.push('', 'What they said:', scrub(note, 600).text)
  const logs = files.filter(f => f.text !== undefined).length
  lines.push('', `_${logs} log file(s)${shot.data ? ', 1 screenshot' : ''}, ${redactions} redaction(s) applied by the server._`)

  const send = async () => {
    try {
      const thread = await postReport({ title: reporter.name, summary: lines.join('\n'), files })
      audit.log(`REPORT problem ${SOURCES[source]} from ${reporter.name}`
                + `${reporter.profileId != null ? ` (profile ${reporter.profileId})` : ''}${thread ? ` -> thread ${thread}` : ''}`)
    } catch (err) {
      console.error(`[report] ${reportId} could not be filed:`, err.message)
      seenReports.delete(reportId)
    }
  }
  return { status: 202, json: { ok: true, reportId }, send }
}

module.exports = { prepare, MAX_IMAGE_BYTES }
