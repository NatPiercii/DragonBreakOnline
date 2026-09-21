'use strict'
// Website Discord sign-in, mounted at /api/site; its own OAuth flow, separate from the launcher and dashboard flows

const router        = require('express').Router()
const crypto        = require('crypto')
const rateLimit     = require('express-rate-limit')
const config        = require('../config')
const oauth         = require('../sources/discord/oauth')
const siteSessions  = require('../sources/siteSessions')
const players       = require('../sources/players')
const profiles      = require('../sources/profiles')
const serverAccess  = require('../sources/serverAccess')

const STATE_COOKIE   = 'db_site_state'
const SESSION_COOKIE = 'db_site'
const STATE_TTL_MS   = 10 * 60 * 1000
const CALLBACK_PATH  = '/api/site/callback'
const PROFILE_PAGE   = '/profile.html'

// Secure comes from config: TLS ends at Cloudflare, so the request itself always looks like plain http
const SECURE = config.websiteUrl.startsWith('https:')

let websiteOrigin = null
try { websiteOrigin = new URL(config.websiteUrl).origin } catch { /* malformed WEBSITE_URL: logout refuses every Origin */ }

// Every website user arrives from the same proxy address, so this one limit is global; it guards the Discord app shared with the launcher
const callbackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: () => 'site-callback',
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many sign-ins right now. Please try again in a minute.',
})

router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, private')
  next()
})

function setCookie(res, name, value, path, maxAgeMs) {
  res.cookie(name, value, { path, maxAge: maxAgeMs, httpOnly: true, sameSite: 'lax', secure: SECURE })
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return ''
}

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y)
}

function currentSession(req) {
  return siteSessions.validate(readCookie(req, SESSION_COOKIE))
}

// Read-only lookup on every request, so an admin delete or re-create never leaves a stale id
function profileIdOf(discordId) {
  const id = profiles.load().map[discordId]
  return Number.isInteger(id) ? id : null
}

// GET /api/site/login: binds a random state to this browser, then sends it to Discord
router.get('/login', (_req, res) => {
  if (!config.discordClientId || !config.discordSiteRedirectUri) {
    return res.redirect(`${PROFILE_PAGE}?error=unconfigured`)
  }
  const state = crypto.randomBytes(32).toString('hex')
  setCookie(res, STATE_COOKIE, state, CALLBACK_PATH, STATE_TTL_MS)
  res.redirect(oauth.authorizeUrl({ redirectUri: config.discordSiteRedirectUri, state }))
})

// GET /api/site/callback: Discord's redirect; the state is checked before any Discord call, and nothing but the site session is written
router.get('/callback', callbackLimiter, async (req, res) => {
  setCookie(res, STATE_COOKIE, '', CALLBACK_PATH, 0)
  const { code, state, error } = req.query

  if (error) return res.redirect(`${PROFILE_PAGE}?error=cancelled`)
  if (!sameSecret(state, readCookie(req, STATE_COOKIE))) return res.redirect(`${PROFILE_PAGE}?error=state`)
  if (typeof code !== 'string' || !code) return res.redirect(`${PROFILE_PAGE}?error=discord`)

  try {
    const tokenData = await oauth.exchangeCode({ code, redirectUri: config.discordSiteRedirectUri })
    const user      = await oauth.getUser(tokenData.access_token)
    if (typeof user.id !== 'string' || !user.id) throw new Error('Discord returned a user without an id')

    const token = siteSessions.create({
      discordId: user.id,
      username:  String(user.global_name || user.username || ''),
      avatar:    oauth.avatarUrl(user),
    })
    setCookie(res, SESSION_COOKIE, token, '/', config.siteSessionTtlHours * 60 * 60 * 1000)
    res.redirect(PROFILE_PAGE)
  } catch (err) {
    console.error('[site-auth] callback error:', err.message)
    res.redirect(`${PROFILE_PAGE}?error=discord`)
  }
})

// GET /api/site/whoami: the signed-in account, built field by field
router.get('/whoami', async (req, res) => {
  try {
    const session = currentSession(req)
    if (!session) return res.json({ signedIn: false })

    const row    = players.load()[session.discordId]
    const access = await serverAccess.getDiscordAccess(session.discordId)
    res.json({
      signedIn: true,
      discord: {
        name:      String(session.username || ''),
        avatarUrl: typeof session.avatar === 'string' ? session.avatar : null,
      },
      account: {
        hasProfile:        profileIdOf(session.discordId) !== null,
        createdAt:         row && typeof row.createdAt === 'string' ? row.createdAt : null,
        lastLauncherLogin: row && typeof row.lastSeenAt === 'string' ? row.lastSeenAt : null,
      },
      access: {
        allowed: access.allowed === true,
        reason:  access.allowed === true ? null : (access.error || null),
      },
    })
  } catch (err) {
    console.error('[site-auth] whoami error:', err.message)
    res.status(500).json({ error: 'internal' })
  }
})

// POST /api/site/logout: same-origin only, so another site cannot sign the visitor out
router.post('/logout', (req, res) => {
  if (!websiteOrigin || req.get('origin') !== websiteOrigin) return res.status(403).json({ error: 'badOrigin' })
  const token = readCookie(req, SESSION_COOKIE)
  if (token) siteSessions.revoke(token)
  setCookie(res, SESSION_COOKIE, '', '/', 0)
  res.status(204).end()
})

module.exports = router
