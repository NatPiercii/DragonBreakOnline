'use strict'
// Staff dashboard Server panel, read only in Phase 1: game server state, what is live, the release queue and recent releases.
// Staff only, with a Discord role check on every request as in site-staff.js; Owners are flagged for display only.
// Every request first meets a limit per signed-in account or visitor address, so signed-out and non-staff callers are limited too.
//
//   GET /api/site/staff/server                    status (5 s shared cache)
//   GET /api/site/staff/server/queue              the queue, with an ETag over all it lists and 304 on a match
//   GET /api/site/staff/server/releases?before=n  ten history rows older than row n

const router = require('express').Router()
const rateLimit = require('express-rate-limit')
const config = require('../config')
const { getHeartbeat } = require('./servers')
const { requireStaff, isOwner } = require('./site-staff').internals
const { currentSession } = require('./site-auth').internals
const { visitorIp } = require('../sources/visitorIp')
const { createServerStatus } = require('../sources/serverStatus')
const { queueEtag } = require('../sources/releaseQueue')

const status = createServerStatus({ config, getHeartbeat })
const releaseQueue = status.queue

router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, private')
  next()
})

// Before requireStaff, so a caller that is signed out or not staff never reaches the Discord role lookup unlimited
router.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => {
    const session = currentSession(req)
    return session?.discordId ? `s:${session.discordId}` : `anon:${rateLimit.ipKeyGenerator(visitorIp(req) || req.ip)}`
  },
  message: { error: 'tooMany' },
}))

const perStaff = limit => rateLimit({
  windowMs: 60 * 1000,
  limit,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => `d:${req.staff.discordId}`,
  message: { error: 'tooMany' },
})
const statusLimiter = perStaff(60)
const queueLimiter = perStaff(30)
const releasesLimiter = perStaff(30)

const answer = fn => (req, res, next) => fn(req, res).catch(next)

function etagMatches(header, etag) {
  if (!header) return false
  return header.split(',').map(t => t.trim().replace(/^W\//, '')).some(t => t === etag || t === '*')
}

router.get('/', requireStaff, statusLimiter, answer(async (req, res) => {
  const [{ generatedAt, ...rest }, owner] = await Promise.all([status.get(), isOwner(req.staff.discordId)])
  res.json({ v: 1, generatedAt, owner, ...rest })
}))

router.get('/queue', requireStaff, queueLimiter, answer(async (req, res) => {
  const value = await releaseQueue.queue()
  const etag = queueEtag(value)
  res.set('ETag', etag)
  if (etagMatches(req.get('if-none-match'), etag)) return res.status(304).end()
  res.json(value)
}))

router.get('/releases', requireStaff, releasesLimiter, answer(async (req, res) => {
  const { before } = req.query
  if (before !== undefined && !(typeof before === 'string' && /^\d{1,6}$/.test(before))) return res.status(400).json({ error: 'badRequest' })
  res.json({ v: 1, ...(await releaseQueue.releases(before)) })
}))

// A failed source (a git timeout, a missing repo) answers 503 in JSON, never with a stack trace
router.use((err, _req, res, _next) => {
  console.error('[site-server]', err.code || 'error', err.message)
  if (!res.headersSent) res.status(503).json({ error: 'unavailable' })
})

module.exports = router
