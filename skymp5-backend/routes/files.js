'use strict'

/**
 * File distribution endpoints, both built by `npm run merge` (scripts/merge-files.js); 404 until then.
 *   GET /api/files/version - version metadata the launcher uses to decide whether to re-download
 *   GET /api/files/zip     - the distributable zip streamed to the client
 */

const express = require('express')
const router = express.Router()
const path   = require('path')
const fs     = require('fs')
const { rateLimit, ipKeyGenerator } = require('express-rate-limit')
const config = require('../config')
const problemReport = require('../sources/problemReport')
const sessionEnds = require('../sources/sessionEnds')
const autoReport = require('../sources/autoReport')
const { visitorIp } = require('../sources/visitorIp')
const { lookupSession } = require('./master-api')

const ZIP_PATH     = path.join(config.clientFilesDir, config.clientZipName)
const VERSION_PATH = path.join(__dirname, '..', 'data', 'files-version.json')

const NOT_BUILT = { error: 'File package not found. Run `npm run merge` on the server first.' }

// Only the zip is rate-limited: /version is polled every 10s by every open launcher (90 requests/window each), which a router-wide cap of 100 would choke on
const filesRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
})

// GET /api/files/version

router.get('/version', (_req, res) => {
  if (!fs.existsSync(VERSION_PATH)) return res.status(404).json(NOT_BUILT)
  try {
    // Read fresh every time (do NOT use require(); it caches the module)
    res.json(JSON.parse(fs.readFileSync(VERSION_PATH, 'utf8')))
  } catch {
    res.status(500).json({ error: 'Could not read version file.' })
  }
})

// GET /api/files/extra - per-file manifest of the extra files (build-extra-manifest.js); 404 means none are published

const EXTRA_PATH = path.join(__dirname, '..', 'data', 'extra-files.json')

router.get('/extra', (_req, res) => {
  if (!fs.existsSync(EXTRA_PATH)) return res.status(404).json({ error: 'No extra files published. Run `npm run extra` on the server.' })
  try {
    res.json(JSON.parse(fs.readFileSync(EXTRA_PATH, 'utf8')))
  } catch {
    res.status(500).json({ error: 'Could not read the extra files manifest.' })
  }
})

// GET /api/files/zip

router.get('/zip', filesRateLimiter, (req, res) => {
  if (!fs.existsSync(ZIP_PATH)) return res.status(404).json(NOT_BUILT)

  const stat = fs.statSync(ZIP_PATH)
  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Length', stat.size)
  res.setHeader('Content-Disposition', 'attachment; filename="SkyMP-client.zip"')

  const stream = fs.createReadStream(ZIP_PATH)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
})

// POST /api/files/report - the launcher's "send logs to staff" button and its crash path; with x-report-kind: auto, automatic reports.
// Under /api/files because the public proxy forwards only a fixed list of /api paths and this one is on it.

// Headers only, so the rate limit runs before the body is read; a live play session is verified
function identifyReporter(req, _res, next) {
  const session = req.headers['x-session'] ? lookupSession(req.headers['x-session']) : null
  req.reporter = session
    ? { name: session.username, verified: true, profileId: session.profileId, discordId: session.discordId || null, session }
    : { name: null, verified: false, profileId: null, discordId: null, session: null }
  next()
}

// Every request arrives through the same relay, so an unverified sender is told apart by Cloudflare's visitor address
const anonKey = req => `anon:${ipKeyGenerator(visitorIp(req) || req.ip)}`
const reportLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: req => (req.reporter.verified ? 12 : 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => (req.reporter.verified ? `p:${req.reporter.profileId}` : anonKey(req)),
  message: { error: 'Too many reports from this launcher. Wait a few minutes and try again.' },
})
// A ceiling on all unverified reports together, for when the visitor address is missing or rotated
const anonymousCeiling = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 120,
  standardHeaders: false,
  legacyHeaders: false,
  skip: req => req.reporter.verified,
  keyGenerator: () => 'anon:all',
  message: { error: 'Too many reports right now. Wait a few minutes and try again.' },
})

// Automatic reports (docs/auto-report-v1.md §1.1); every limiter here answers 429 with retryAfterSec in the body
const autoLimiter = (limit, keyGenerator, skip) => rateLimit({
  windowMs: 10 * 60 * 1000, limit, keyGenerator, skip, standardHeaders: false, legacyHeaders: false, handler: autoReport.rateLimitHandler,
})
const autoIpLimiter = autoLimiter(() => config.autoReportLimits.ipPer10Min, anonKey)
const autoUnverifiedCeiling = autoLimiter(() => config.autoReportLimits.unverifiedPer10Min, () => 'anon:all', req => req.reporter.verified)
const autoProfileLimiter = [
  autoLimiter(() => config.autoReportLimits.profilePer10Min, req => `p:${req.reporter.profileId}`),
  autoReport.profileDailyLimit,
]

router.post('/report',
  (req, _res, next) => (req.headers['x-report-kind'] === 'auto' ? next() : next('route')),
  autoReport.killSwitch,
  autoIpLimiter,
  identifyReporter,
  autoUnverifiedCeiling,
  autoReport.requireVerified,
  autoProfileLimiter,
  autoReport.requireJson,
  express.json({ limit: '400kb', inflate: false, type: 'application/json' }),
  autoReport.accept)

router.post('/report', identifyReporter, reportLimiter, anonymousCeiling, problemReport.parseReport, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {}
  // Sent without x-report-kind, an auto payload would become an unverified manual thread
  if (body.contractVersion !== undefined) return res.status(400).json({ error: 'x-report-kind' })
  if (!req.reporter.verified) {
    // Anything the sender claims for itself is labelled as such
    const claimed = typeof body.discordUsername === 'string' ? problemReport.cleanName(body.discordUsername.slice(0, 32)) : ''
    req.reporter.name = claimed && claimed !== 'Unknown player' ? `${claimed} (unverified)` : 'Unknown player'
  }
  return problemReport.respond(res, req.reporter, { ...body, source: body.source === 'game' ? 'game' : 'launcher' })
})
// POST /api/files/session-end - the launcher says how the game closed: crashed, closed normally, or ended some other way
// (sources/sessionEnds.js). Only a signed-in player's launcher is heard: a crash note names someone in #server-monitor.
const sessionEndLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => `p:${req.reporter.profileId}`,
  message: { error: 'Too many notes from this launcher.' },
})
router.post('/session-end', identifyReporter, (req, res, next) => (req.reporter.verified ? next() : res.status(401).json({ error: 'sign in first' })),
  sessionEndLimiter, async (req, res) => {
    const result = await sessionEnds.submit(req.reporter, req.body)
    res.status(result.status).json(result.body)
  })

router.use(problemReport.bodyErrors)

module.exports = router
