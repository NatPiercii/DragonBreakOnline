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
const { scrub } = require('../sources/scrubLog')
const { postReport } = require('../sources/discord/errorReport')
const { lookupSession } = require('./master-api')
const audit = require('../sources/discord/audit')

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

// POST /api/files/report - the launcher's "send logs to staff" button and its crash path.
// Under /api/files because the public proxy forwards only a fixed list of /api paths and this one is on it.

// Keyed by play session so one broken machine retrying cannot use up everyone else's budget; the proxy
// makes every external request look like one IP, so req.ip alone would be a single shared bucket.
const reportLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => req.headers['x-session'] || req.body?.hwid || ipKeyGenerator(req.ip),
  message: { error: 'Too many reports from this launcher. Wait a few minutes and try again.' },
})

// Only these context fields are ever repeated back into Discord, and each is scrubbed like a log
const CONTEXT_FIELDS = ['launcherVersion', 'clientVersion', 'filesVersion', 'os', 'gameVersion',
                        'installDir', 'step', 'error', 'mo2Enabled', 'freeSpaceGb']

router.post('/report', express.json({ limit: '900kb' }), reportLimiter, async (req, res) => {
  if (!config.discordErrorForumChannelId) {
    return res.status(503).json({ error: 'Reporting is not configured on this server.' })
  }
  const body = req.body || {}
  const session = req.headers['x-session'] ? lookupSession(req.headers['x-session']) : null
  // A verified name comes from the session; anything the launcher claims for itself is labelled as such
  const claimed = typeof body.discordUsername === 'string' ? body.discordUsername.slice(0, 32) : ''
  const name = session?.username || (claimed ? `${claimed} (unverified)` : 'Unknown player')

  const files = []
  let redactions = 0
  for (const [field, filename] of [['launcherLog', 'launcher.log'], ['clientLog', 'client.log'],
                                   ['gameLog', 'game.log']]) {
    if (!body[field]) continue
    const cleaned = scrub(body[field])
    redactions += cleaned.redactions
    files.push({ name: filename, text: cleaned.text + (cleaned.truncated ? '' : '') })
  }
  if (!files.length) return res.status(400).json({ error: 'No log content in the report.' })

  const lines = [`**${name}** reported a launcher problem.`]
  if (session) lines.push(`profile ${session.profileId}`)
  for (const key of CONTEXT_FIELDS) {
    if (body[key] === undefined || body[key] === null || body[key] === '') continue
    lines.push(`${key}: ${scrub(String(body[key]), 300).text}`)
  }
  if (typeof body.note === 'string' && body.note.trim()) {
    lines.push('', 'What they said:', scrub(body.note, 600).text)
  }
  lines.push('', `_${files.length} log file(s), ${redactions} redaction(s) applied by the server._`)

  try {
    const thread = await postReport({ title: name, summary: lines.join('\n'), files })
    audit.log(`REPORT launcher problem from ${name}${session ? ` (profile ${session.profileId})` : ''}`
              + `${thread ? ` -> thread ${thread}` : ''}`)
    res.json({ ok: true, thread })
  } catch (err) {
    console.error('[files] launcher report failed:', err.message)
    res.status(502).json({ error: 'Could not file the report. Tell a staff member directly.' })
  }
})

module.exports = router
