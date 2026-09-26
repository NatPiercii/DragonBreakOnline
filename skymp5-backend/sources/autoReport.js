'use strict'
// Automatic error and crash reports (docs/auto-report-v1.md): POST /api/files/report with x-report-kind: auto

const config = require('../config')
const { validate, ignoreReason, CONTRACT_VERSIONS } = require('./autoSchema')
const autoStore = require('./autoStore')
const bans = require('./bans')
const players = require('./players')

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
  next()
}

// Counted per UTC day in auto-state.json, so a restart does not reset it
function profileDailyLimit(req, res, next) {
  const now = Date.now()
  const day = autoStore.today(req.reporter.profileId, now)
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

// 422 or 202; a report seen before for this profile is not stored again
function accept(req, res) {
  try {
    noteOnMode()
    const receivedAt = Date.now()
    const { profileId, name, session } = req.reporter
    const result = validate(req.body, { receivedAt, scrubContext: { names: { discord: [name] } } })
    if (!result.ok) return res.status(result.status).json(result.json)
    const { report, flags, invalid } = result
    const duplicate = autoStore.isSeen(profileId, report.reportId, receivedAt)
    if (!duplicate) {
      const ignored = ignoreReason(report)
      if (ignored) dropBulk(report, true)
      const trust = session.launchCheck && session.launchCheck.filesOk === true ? 'verified' : 'unverified-launch'
      const record = { v: 1, receivedAt, profileId, trust, ignored, flags, invalid, report }
      let text = JSON.stringify(record)
      if (autoStore.today(profileId, receivedAt).bytes + Buffer.byteLength(text) > config.autoReportLimits.profileBytesPerDay) {
        dropBulk(report, false)
        flags.push('overBudget')
        text = JSON.stringify(record)
      }
      autoStore.add(record, text)
    }
    res.status(202).json({ ok: true, id: report.reportId, duplicate })
  } catch (err) {
    console.error('[auto-report] report not stored:', err.message)
    res.status(500).json({ error: 'internal' })
  }
}

module.exports = { killSwitch, versionInfo, rateLimitHandler, requireVerified, profileDailyLimit, requireJson, accept }
