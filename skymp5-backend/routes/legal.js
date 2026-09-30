'use strict'

/**
 * Terms of Service and Privacy Policy (sources/legal.js). Mounted at /api/legal and at /api/files/legal: the public
 * proxy forwards only a fixed list of /api paths, and /api/files is on it (/api/legal needs its own nginx location).
 *   GET  /         public, cacheable: { version, effective, changes: [lines], terms, privacy } (the texts are markdown)
 *   GET  /status   x-session: { accepted, version, acceptedAt, lastAcceptedVersion, required }
 *   POST /accept   x-session, body { version, launcherVersion? }: { accepted, version, at, alreadyAccepted }
 *                  409 { error: 'versionMismatch', version } when version is not the current one
 * 401 without a live play session, 429 when rate limited, 503 when the documents cannot be read.
 */

const express = require('express')
const { rateLimit, ipKeyGenerator } = require('express-rate-limit')
const legal = require('../sources/legal')
const { visitorIp } = require('../sources/visitorIp')
const { lookupSession } = require('./master-api')

const router = express.Router()

const ipKey = req => `ip:${ipKeyGenerator(visitorIp(req) || req.ip)}`
const sessionKey = req => (req.legalSession ? `d:${req.legalSession.discordId}` : ipKey(req))
const limiter = (limit, keyGenerator) => rateLimit({
  windowMs: 10 * 60 * 1000,
  limit,
  keyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Wait a few minutes and try again.' },
})
const textLimiter = limiter(120, ipKey)
const statusLimiter = limiter(60, sessionKey)
const acceptLimiter = limiter(20, sessionKey)

// Headers only, so the limit runs before the session is required
function identify(req, _res, next) {
  const token = req.headers['x-session']
  const session = typeof token === 'string' && token ? lookupSession(token) : null
  req.legalSession = session && session.discordId ? session : null
  next()
}

function requireSession(req, res, next) {
  res.set('Cache-Control', 'no-store')
  if (!req.legalSession) return res.status(401).json({ error: 'Invalid or expired session.' })
  next()
}

function documentOr503(res) {
  try { return legal.currentDocument() }
  catch (err) {
    console.error(`[legal] cannot read the documents: ${err.message}`)
    res.set('Cache-Control', 'no-store').status(503).json({ error: 'legalUnavailable' })
    return null
  }
}

router.get('/', textLimiter, (_req, res) => {
  const doc = documentOr503(res)
  if (!doc) return
  res.set('Cache-Control', 'public, max-age=300')
  res.json({ version: doc.version, effective: doc.effective, changes: doc.changes, terms: doc.terms, privacy: doc.privacy })
})

router.get('/status', identify, statusLimiter, requireSession, (req, res) => {
  const doc = documentOr503(res)
  if (!doc) return
  try { res.json(legal.status(req.legalSession.discordId, doc)) }
  catch (err) {
    console.error(`[legal] cannot read the acceptances: ${err.message}`)
    res.status(503).json({ error: 'legalUnavailable' })
  }
})

router.post('/accept', identify, acceptLimiter, requireSession, express.json({ limit: '2kb' }), (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {}
  if (typeof body.version !== 'string' || !legal.VERSION_RE.test(body.version)) return res.status(400).json({ error: 'version' })
  const doc = documentOr503(res)
  if (!doc) return
  if (body.version !== doc.version) return res.status(409).json({ error: 'versionMismatch', version: doc.version })
  const s = req.legalSession
  let result
  try {
    result = legal.accept({ discordId: s.discordId, profileId: s.profileId, version: doc.version, launcherVersion: body.launcherVersion })
  } catch (err) {
    console.error(`[legal] could not record an acceptance: ${err.message}`)
    return res.status(500).json({ error: 'legalWriteFailed' })
  }
  if (result.created) console.log(`[legal] ${s.username || s.profileId} accepted ${doc.version}`)
  res.json({ accepted: true, version: result.record.version, at: result.record.at, alreadyAccepted: !result.created })
})

router.use(require('../sources/problemReport').bodyErrors)

module.exports = router
