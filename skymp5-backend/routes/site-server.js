'use strict'
// Staff dashboard Server panel: game server state, what is live, the release queue and recent releases, for staff.
// Owners also get Start, Stop and Restart at 0 players, each re-checked against Discord and guarded as in sources/serverControl.js.
// Every request first meets a limit per signed-in account or visitor address, so signed-out and non-staff callers are limited too.
//
//   GET  /api/site/staff/server                    status (5 s shared cache) with the viewer's controls
//   GET  /api/site/staff/server/queue              the queue, with an ETag over all it lists and 304 on a match
//   GET  /api/site/staff/server/releases?before=n  ten history rows older than row n
//   POST /api/site/staff/server/actions/<start|stop|restart>  {requestId, reason, confirm}, Owners only, 202 {job}
//   GET  /api/site/staff/server/jobs/<requestId>   an action's job

const express = require('express')
const router = express.Router()
const rateLimit = require('express-rate-limit')
const config = require('../config')
const { getHeartbeat } = require('./servers')
const { requireStaff, isOwner } = require('./site-staff').internals
const { currentSession, sameOrigin } = require('./site-auth').internals
const { visitorIp } = require('../sources/visitorIp')
const { createServerStatus } = require('../sources/serverStatus')
const { createServerControl, parseRequest, ACTIONS } = require('../sources/serverControl')
const { queueEtag } = require('../sources/releaseQueue')
const { bodyErrors } = require('../sources/problemReport')

const status = createServerStatus({ config, getHeartbeat })
const control = createServerControl({ status, getHeartbeat })
const releaseQueue = status.queue

router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, private')
  next()
})

const limiter = (windowMs, limit, keyGenerator, extra = {}) => rateLimit({
  windowMs, limit, keyGenerator, standardHeaders: true, legacyHeaders: false, message: { error: 'tooMany' }, ...extra,
})

// Before requireStaff, so a caller that is signed out or not staff never reaches the Discord role lookup unlimited
router.use(limiter(60 * 1000, 120, req => {
  const session = currentSession(req)
  return session?.discordId ? `s:${session.discordId}` : `anon:${rateLimit.ipKeyGenerator(visitorIp(req) || req.ip)}`
}))

const perStaff = limit => limiter(60 * 1000, limit, req => `d:${req.staff.discordId}`)
const statusLimiter = perStaff(60)
const queueLimiter = perStaff(30)
const releasesLimiter = perStaff(30)
const jobLimiter = perStaff(120)
// Every control request from an account counts, before its Owner lookup
const controlTries = limiter(10 * 60 * 1000, 10, req => `d:${req.controlSession.discordId}`)
// Site-wide, only actions that went ahead count; a repeated requestId is not a new action
const controlActions = limiter(60 * 60 * 1000, 6, () => 'server-actions', { skipFailedRequests: true, skip: req => control.known(req.control.requestId) })

const answer = fn => (req, res, next) => fn(req, res).catch(next)

function etagMatches(header, etag) {
  if (!header) return false
  return header.split(',').map(t => t.trim().replace(/^W\//, '')).some(t => t === etag || t === '*')
}

router.get('/', requireStaff, statusLimiter, answer(async (req, res) => {
  const [{ generatedAt, ...rest }, owner, setting] = await Promise.all([status.get(), isOwner(req.staff.discordId), control.setting()])
  res.json({ v: 1, generatedAt, owner, controls: control.controlsFor(rest, { owner, setting }), ...rest })
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

// Same-origin JSON from the dashboard only (exact Origin, fetch metadata when sent, the control header), then a session
function controlRequest(req, res, next) {
  if (!ACTIONS.includes(req.params.action)) return res.status(404).json({ error: 'notFound' })
  // A body some earlier parser already read is refused, so this route only ever acts on a body it read after its checks
  if (req._body) return res.status(400).json({ error: 'badRequest' })
  const site = req.get('sec-fetch-site')
  if (!sameOrigin(req) || (site && site !== 'same-origin')) return res.status(403).json({ error: 'badOrigin' })
  if (!req.is('application/json')) return res.status(415).json({ error: 'badContentType' })
  if (req.get('x-dbo-control') !== '1') return res.status(403).json({ error: 'badHeader' })
  const session = currentSession(req)
  if (!session) return res.status(401).json({ error: 'signedOut' })
  req.controlSession = session
  next()
}

// Discord is asked on every action; the bot keeps a member's roles for at most 60 s
async function requireOwner(req, res, next) {
  const { discordId, username } = req.controlSession
  if (!(await isOwner(discordId))) {
    control.notOwner(username, discordId)
    return res.status(403).json({ error: 'notOwner' })
  }
  next()
}

function controlBody(req, res, next) {
  const parsed = parseRequest(req.params.action, req.body)
  if (parsed.error) return res.status(400).json({ error: parsed.error })
  req.control = parsed
  next()
}

// The body is read only after the Owner check, by this route alone (server.js keeps the global parser off these paths)
router.post('/actions/:action', controlRequest, controlTries, requireOwner, express.json({ limit: '2kb', inflate: false }), controlBody, controlActions,
  answer(async (req, res) => {
    const { discordId, username } = req.controlSession
    const { status: code, body } = await control.perform(req.params.action, { ...req.control, by: username, discordId })
    res.status(code).json(body)
  }))
router.use('/actions', bodyErrors)

router.get('/jobs/:id', requireStaff, jobLimiter, (req, res) => {
  const job = control.job(req.params.id)
  if (!job) return res.status(404).json({ error: 'notFound' })
  res.json({ v: 1, job })
})

// A failed source (a git timeout, a missing repo) answers 503 in JSON, never with a stack trace
router.use((err, _req, res, _next) => {
  console.error('[site-server]', err.code || 'error', err.message)
  if (!res.headersSent) res.status(503).json({ error: 'unavailable' })
})

// Run once by server.js at start: records dashboard actions a backend restart cut short and gives back their claim
router.recover = () => control.recover().catch(err => console.error('[site-server] recover failed:', err.message))

module.exports = router
