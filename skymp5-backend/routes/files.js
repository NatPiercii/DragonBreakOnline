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

// POST /api/files/report - the launcher's "send logs to staff" button and its crash path; the game uses it too.
// Under /api/files because the public proxy forwards only a fixed list of /api paths and this one is on it.

// Who is reporting: a live play session is verified, anything the sender claims for itself is labelled as such
function identifyReporter(req, _res, next) {
  const session = req.headers['x-session'] ? lookupSession(req.headers['x-session']) : null
  const claimed = typeof req.body?.discordUsername === 'string' ? req.body.discordUsername.slice(0, 32) : ''
  req.reporter = session
    ? { name: session.username, verified: true, profileId: session.profileId }
    : { name: claimed ? `${claimed} (unverified)` : 'Unknown player', verified: false, profileId: null }
  next()
}

// Signed-in players each get their own budget; an unverified X-Session header no longer buys a fresh one
const reportLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: req => (req.reporter.verified ? 12 : 30),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => (req.reporter.verified ? `p:${req.reporter.profileId}` : `anon:${ipKeyGenerator(req.ip)}`),
  message: { error: 'Too many reports from this launcher. Wait a few minutes and try again.' },
})

router.post('/report', express.json({ limit: '2mb' }), identifyReporter, reportLimiter, (req, res) => {
  const body = req.body || {}
  const result = problemReport.prepare(req.reporter, { ...body, source: body.source === 'game' ? 'game' : 'launcher' })
  res.status(result.status).json(result.json)
  if (result.send) result.send()
})

module.exports = router
