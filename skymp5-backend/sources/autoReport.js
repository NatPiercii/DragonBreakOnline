'use strict'
// Automatic error and crash reports (docs/auto-report-v1.md): POST /api/files/report with x-report-kind: auto

const crypto = require('crypto')
const config = require('../config')
const { validate, ignoreReason, checkBuild, CONTRACT_VERSIONS, KINDS, PATTERNS } = require('./autoSchema')
const autoStore = require('./autoStore')
const errorGroups = require('./errorGroups')
const sourceMaps = require('./sourceMaps')
const bans = require('./bans')
const players = require('./players')

const JANITOR_MS = 6 * 60 * 60 * 1000

// AUTO_REPORTS=off answers before any other work; senders drop the report and wait pauseSec
function killSwitch(_req, res, next) {
  if (config.autoReports !== 'off') return next()
  res.status(503).json({ error: 'paused', pauseSec: config.autoReportPauseSec })
}

// The autoReport block of GET /api/version, which the launcher reads before sending anything
function versionInfo() {
  return { mode: config.autoReports, crashWatch: config.autoReportCrashWatch, contract: CONTRACT_VERSIONS }
}

// The game client cannot read headers, so the wait is in the body as well
function rateLimited(res, retryAfterSec) {
  res.set('Retry-After', String(retryAfterSec))
  res.status(429).json({ error: 'rate', retryAfterSec })
}
const secondsUntil = (at, now) => Math.max(1, Math.ceil((at - now) / 1000))
const rateLimitHandler = (req, res) => {
  const reset = req.rateLimit && req.rateLimit.resetTime
  rateLimited(res, reset ? secondsUntil(reset.getTime(), Date.now()) : 600)
}

// Matches bans like the session gate in master-api.js, without its ban.log line
function requireVerified(req, res, next) {
  const { session } = req.reporter
  if (!session) return res.status(401).json({ error: 'session', reason: req.headers['x-session'] ? 'invalid' : 'missing' })
  const hwid = session.hwid || (players.load()[session.discordId] || {}).hwid || null
  if (bans.isBanned({ discordId: session.discordId, hwid })) return res.status(403).json({ error: 'refused' })
  req.reporter.hwid = hwid
  next()
}

// JSON with no stack, which senders treat as transient
function internal(res, err) {
  console.error('[auto-report] report not stored:', err.message)
  res.status(500).json({ error: 'internal' })
}

// Counted per UTC day in auto-state.json, so a restart does not reset it
function profileDailyLimit(req, res, next) {
  const now = Date.now()
  let day
  try { day = autoStore.today(req.reporter.profileId, now) } catch (err) { return internal(res, err) }
  if (day.reports >= config.autoReportLimits.profilePerDay) return rateLimited(res, secondsUntil(autoStore.nextUtcDay(now), now))
  day.reports++
  autoStore.save(now)
  next()
}

// express.json skips a body of another type instead of failing, which would come back as a 422
function requireJson(req, res, next) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  if (type === 'application/json' && !req.headers['content-encoding']) return next()
  res.status(415).json({ error: 'Send plain, uncompressed JSON.' })
}

// Metadata only: logs and crash sections go, and trail entries too for an ignored report
function dropBulk(report, withTrail) {
  delete report.logs
  if (report.crash) delete report.crash.sections
  if (withTrail) report.trail.entries = []
}

// Nothing posts to Discord yet, so on stores like collect
let onNoted = false
function noteOnMode() {
  if (config.autoReports !== 'on' || onNoted) return
  onNoted = true
  console.log('[auto-report] AUTO_REPORTS=on: Discord output is not built yet, reports are collected only')
}

// Only compared for equality when a held group needs a second machine (§6.2)
const hwidHash = hwid => (hwid ? crypto.createHash('sha256').update(`auto-report:${hwid}`).digest('hex').slice(0, 16) : null)

// Builds and writes the record of a validated report; its group is worked out after the 202
function store(result, { receivedAt, profileId, launchCheck, hwid }) {
  checkBuild(result, sourceMaps.meta('client', result.report.build && result.report.build.client))
  const { report, flags, invalid } = result
  // Launchers send their kinds only while crash watch is on (§1.8); a prerelease one could send them earlier
  const watchOff = !config.autoReportCrashWatch && KINDS[report.kind].sender === 'launcher'
  const ignored = watchOff ? 'crash-watch-off' : ignoreReason(report)
  if (ignored) dropBulk(report, true)
  const trust = launchCheck && launchCheck.filesOk === true ? 'verified' : 'unverified-launch'
  const record = { v: 1, receivedAt, profileId, trust, hwidHash: hwidHash(hwid), ignored, flags, invalid, report }
  let text = JSON.stringify(record)
  if (autoStore.today(profileId, receivedAt).bytes + Buffer.byteLength(text) > config.autoReportLimits.profileBytesPerDay) {
    dropBulk(report, false)
    flags.push('overBudget')
    text = JSON.stringify(record)
  }
  autoStore.add(record, text)
  return record
}

// 422 or 202; a report seen before for this profile is not stored again, and a muted profile's is not read
function accept(req, res) {
  try {
    noteOnMode()
    const receivedAt = Date.now()
    const { profileId, name, session, hwid } = req.reporter
    if (autoStore.isMuted(profileId, receivedAt)) {
      const id = req.body && req.body.reportId
      return res.status(202).json({ ok: true, id: typeof id === 'string' && PATTERNS.reportId.test(id) ? id : null, duplicate: false })
    }
    const result = validate(req.body, { receivedAt, scrubContext: { names: { discord: [name] } } })
    if (!result.ok) {
      if (result.json.error === 'schema') autoStore.countInvalid(profileId, receivedAt)
      return res.status(result.status).json(result.json)
    }
    const { reportId } = result.report
    const duplicate = autoStore.isSeen(profileId, reportId, receivedAt)
    const record = duplicate ? null : store(result, { receivedAt, profileId, launchCheck: session.launchCheck, hwid })
    if (record && record.flags.includes('invalidField')) autoStore.countInvalid(profileId, receivedAt)
    res.status(202).json({ ok: true, id: reportId, duplicate })
    if (!duplicate) errorGroups.kick()
  } catch (err) {
    internal(res, err)
  }
}

// At boot: the 30-day janitor now and every 6 hours, and grouping of reports stored before a restart
function start() {
  const sweep = () => autoStore.janitor().catch(err => console.error('[auto-report] janitor failed:', err.message))
  setInterval(sweep, JANITOR_MS).unref()
  return Promise.all([sweep(), errorGroups.kick()])
}

module.exports = { killSwitch, versionInfo, rateLimitHandler, requireVerified, profileDailyLimit, requireJson, accept, store, start }
