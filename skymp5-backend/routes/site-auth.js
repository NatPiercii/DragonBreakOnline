'use strict'
// Website Discord sign-in, mounted at /api/site; its own OAuth flow, separate from the launcher and dashboard flows

const router        = require('express').Router()
const crypto        = require('crypto')
const fs            = require('fs')
const net           = require('net')
const rateLimit     = require('express-rate-limit')
const config        = require('../config')
const oauth         = require('../sources/discord/oauth')
const siteSessions  = require('../sources/siteSessions')
const players       = require('../sources/players')
const profiles      = require('../sources/profiles')
const serverAccess  = require('../sources/serverAccess')
const bans          = require('../sources/bans')
const nameTable     = require('../sources/nameTable')
const officials     = require('../sources/officials')
const factions      = require('../sources/factionWhitelist')
const { charFromCf, fileChangeForms } = require('../sources/characters')

const STATE_COOKIE   = 'db_site_state'
const SESSION_COOKIE = 'db_site'
const STATE_TTL_MS   = 10 * 60 * 1000
const CALLBACK_PATH  = '/api/site/callback'
// Only /api/site reads the session, so the browser sends it nowhere else on the host
const SESSION_PATH   = '/api/site'
const PROFILE_PAGE   = '/profile.html'
// Runtime-created forms have no plugin part in their file name, and every player character is one
const PLAYER_FORM_FILE = /^[0-9a-f]+\.json$/
// Gold001, the same id masterySystem.ts and bountyBoardSystem.ts use
const GOLD_BASE_ID   = 0x0000000f
const STORE_CACHE_MS = 3000
// A stalled Discord member lookup takes about a minute to fail; the badge stops waiting long before nginx's 60 s
const ACCESS_DEADLINE_MS = 8000

// Secure comes from config: TLS ends at Cloudflare, so the request itself always looks like plain http
const SECURE = config.websiteUrl.startsWith('https:')

let websiteOrigin = null
try { websiteOrigin = new URL(config.websiteUrl).origin } catch { /* malformed WEBSITE_URL: logout refuses every Origin */ }

// Sign-in must start on the host Discord returns to, or the host-only state cookie never comes back
let loginUrl = null
try { loginUrl = new URL('/api/site/login', config.discordSiteRedirectUri) } catch { /* malformed redirect URI: sign-in starts on any host */ }

// Every website user reaches the backend through the same proxy hop; Cloudflare puts the visitor's own address in CF-Connecting-IP
function visitorIp(req) {
  const ip = req.get('cf-connecting-ip')
  return typeof ip === 'string' && net.isIP(ip) ? ip : null
}

const limitOptions = {
  windowMs: 60 * 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many sign-ins right now. Please try again in a minute.',
}

// Per visitor, so one client cannot use up the site-wide budget; requests without the header meet only the site-wide limit
const visitorLimiter = rateLimit({
  ...limitOptions,
  max: 5,
  skip: req => !visitorIp(req),
  keyGenerator: req => rateLimit.ipKeyGenerator(visitorIp(req)),
})

// Site-wide backstop for the Discord app shared with the launcher
const siteLimiter = rateLimit({
  ...limitOptions,
  max: 60,
  keyGenerator: () => 'site-callback',
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

// Characters in the changeForms store with their file's mtime; throws when the directory is unreadable
let storeCache = { at: 0, forms: [] }
function readStore() {
  if (Date.now() - storeCache.at < STORE_CACHE_MS) return storeCache.forms
  fs.accessSync(config.changeFormsDir, fs.constants.R_OK)
  const forms = []
  for (const [file, cf] of fileChangeForms(config.changeFormsDir, PLAYER_FORM_FILE)) {
    const char = charFromCf(cf)
    if (!char) continue
    let mtime
    try { mtime = fs.statSync(file).mtime } catch { continue }
    forms.push({ cf, char, mtime })
  }
  storeCache = { at: Date.now(), forms }
  return forms
}

function dynamicFields(cf) {
  return cf.dynamicFields && typeof cf.dynamicFields === 'object' ? cf.dynamicFields : {}
}

// A character stamped with a different Discord id is never shown, even when its profileId matches
function ownedBy(cf, discordId) {
  const stamped = dynamicFields(cf)['private.indexed.discordId']
  return stamped === undefined || stamped === null || stamped === discordId
}

function percent(fraction) {
  return Number.isFinite(fraction) ? Math.round(Math.min(1, Math.max(0, fraction)) * 100) : null
}

function characterName(cf, appearance) {
  if (typeof cf.displayName === 'string' && cf.displayName) return cf.displayName
  if (appearance && typeof appearance.name === 'string' && appearance.name) return appearance.name
  return appearance ? 'Unnamed' : 'Unnamed (in creation)'
}

// Same tests as the select screen and creation flow in skymp5-server/ts/systems/spawn.ts
function characterStatus(cf, char, df) {
  if (df['private.permaDead'] === true) return 'permaDead'
  if (char.dead) return 'dead'
  if (!char.appearance || cf.isRaceMenuOpen === true || df['private.creationPending'] === true) return 'creating'
  return 'alive'
}

// Titles for every character of the account: hold offices are per profile, faction rows per Discord id with an optional character slot
function accountTitles(profileId, discordId) {
  let rows = []
  try { rows = factions.getPlayerGameFactions(discordId) }
  catch (err) { console.error('[site-auth] faction whitelist unreadable:', err.message) }
  return { offices: officials.officesOf(profileId), factions: rows }
}

// The titles the game applies to the character in this slot: offices first like housingSystem.holdRanks, then faction rows for every slot or this one (filterAccessForSlot)
function titlesOf(account, slot) {
  const rows   = account.factions.filter(f => f.slot === null || (Number.isInteger(slot) && f.slot === slot))
  const seen   = new Set()
  const titles = []
  for (const { title, group } of [...account.offices, ...rows]) {
    if (typeof title !== 'string' || !title) continue
    const groupName = typeof group === 'string' ? group : ''
    const key       = `${title}\n${groupName}`
    if (seen.has(key)) continue
    seen.add(key)
    titles.push({ title, group: groupName })
  }
  return titles
}

// Built field by field: nothing from the changeform is passed through whole, and position is never read
function toSiteCharacter({ cf, char, mtime }, names, account) {
  const df         = dynamicFields(cf)
  const appearance = char.appearance
  const mastery    = df['private.mastery']
  const tag        = df['private.charTag']
  return {
    key:        String(char.formDesc),
    name:       characterName(cf, appearance),
    status:     characterStatus(cf, char, df),
    sex:        appearance && typeof appearance.isFemale === 'boolean' ? (appearance.isFemale ? 'female' : 'male') : null,
    weight:     appearance && Number.isFinite(appearance.weight) ? appearance.weight : null,
    vitals: {
      health:   percent(char.health),
      magicka:  percent(char.magicka),
      stamina:  percent(char.stamina),
    },
    gold:       char.inventory.reduce((n, e) => n + (e && e.baseId === GOLD_BASE_ID && Number.isInteger(e.count) ? e.count : 0), 0),
    itemStacks: char.inventory.length,
    masteries:  mastery && Array.isArray(mastery.order) ? mastery.order.length : 0,
    tag:        typeof tag === 'string' && tag.length === 4 ? tag : null,
    race:       nameTable.raceOf(names, appearance && appearance.raceId),
    location:   config.siteShowLocation ? nameTable.placeOf(names, char.worldOrCell) : null,
    titles:     account ? titlesOf(account, df['private.charSlot']) : null,
    lastSaved:  mtime.toISOString(),
  }
}

// GET /api/site/login: binds a random state to this browser, then sends it to Discord
router.get('/login', (req, res) => {
  if (!config.discordClientId || !config.discordSiteRedirectUri) {
    return res.redirect(`${PROFILE_PAGE}?error=unconfigured`)
  }
  if (loginUrl && String(req.hostname || '').toLowerCase() !== loginUrl.hostname) return res.redirect(loginUrl.href)
  const state = crypto.randomBytes(32).toString('hex')
  setCookie(res, STATE_COOKIE, state, CALLBACK_PATH, STATE_TTL_MS)
  res.redirect(oauth.authorizeUrl({ redirectUri: config.discordSiteRedirectUri, state }))
})

// Discord's redirect is checked against the state cookie first, so only requests that would call Discord count toward the limits
function checkCallback(req, res, next) {
  setCookie(res, STATE_COOKIE, '', CALLBACK_PATH, 0)
  const { code, state, error } = req.query

  if (error) return res.redirect(`${PROFILE_PAGE}?error=cancelled`)
  if (!sameSecret(state, readCookie(req, STATE_COOKIE))) return res.redirect(`${PROFILE_PAGE}?error=state`)
  if (typeof code !== 'string' || !code) return res.redirect(`${PROFILE_PAGE}?error=discord`)
  next()
}

// GET /api/site/callback: Discord's redirect; the state is checked before any Discord call, and nothing but the site session is written
router.get('/callback', checkCallback, visitorLimiter, siteLimiter, async (req, res) => {
  try {
    const tokenData = await oauth.exchangeCode({ code: req.query.code, redirectUri: config.discordSiteRedirectUri })
    const user      = await oauth.getUser(tokenData.access_token)
    if (typeof user.id !== 'string' || !user.id) throw new Error('Discord returned a user without an id')

    const token = siteSessions.create({
      discordId: user.id,
      username:  String(user.global_name || user.username || ''),
      avatar:    oauth.avatarUrl(user),
    })
    setCookie(res, SESSION_COOKIE, token, SESSION_PATH, config.siteSessionTtlHours * 60 * 60 * 1000)
    res.redirect(PROFILE_PAGE)
  } catch (err) {
    console.error('[site-auth] callback error:', err.message)
    res.redirect(`${PROFILE_PAGE}?error=discord`)
  }
})

// The game's gates for this account: the bans.json snapshot by Discord id or hwid (master-api.js session check), then the Discord roles
async function accessOf(discordId) {
  const row = players.load()[discordId]
  if (bans.isBanned({ discordId, hwid: row && row.hwid })) return { allowed: false, reason: 'banned' }

  let timer
  const deadline = new Promise(resolve => { timer = setTimeout(resolve, ACCESS_DEADLINE_MS, null) })
  try {
    const access = await Promise.race([serverAccess.getDiscordAccess(discordId), deadline])
    if (!access) {
      console.warn(`[site-auth] Discord access lookup took over ${ACCESS_DEADLINE_MS} ms`)
      return { allowed: false, reason: 'accessUnavailable' }
    }
    return { allowed: access.allowed === true, reason: access.allowed === true ? null : (access.error || null) }
  } catch (err) {
    console.error('[site-auth] Discord access lookup failed:', err.message)
    return { allowed: false, reason: 'accessUnavailable' }
  } finally {
    clearTimeout(timer)
  }
}

// GET /api/site/whoami: the signed-in account, built field by field from local files only
router.get('/whoami', (req, res) => {
  try {
    const session = currentSession(req)
    if (!session) return res.json({ signedIn: false })

    const row = players.load()[session.discordId]
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
    })
  } catch (err) {
    console.error('[site-auth] whoami error:', err.message)
    res.status(500).json({ error: 'internal' })
  }
})

// GET /api/site/access: the access badge, a request of its own because it may wait on Discord
router.get('/access', async (req, res) => {
  try {
    const session = currentSession(req)
    if (!session) return res.status(401).json({ error: 'signedOut' })
    res.json(await accessOf(session.discordId))
  } catch (err) {
    console.error('[site-auth] access error:', err.message)
    res.status(500).json({ error: 'internal' })
  }
})

// GET /api/site/characters: the signed-in player's own characters, oldest first
router.get('/characters', (req, res) => {
  const session = currentSession(req)
  if (!session) return res.status(401).json({ error: 'signedOut' })

  const profileId = profileIdOf(session.discordId)
  if (profileId === null) return res.json({ characters: [] })

  let forms
  try { forms = readStore() }
  catch (err) {
    console.error('[site-auth] changeForms store unreadable:', err.message)
    return res.status(503).json({ error: 'storeUnavailable' })
  }

  const names      = nameTable.load()
  const account    = config.siteShowFactions ? accountTitles(profileId, session.discordId) : null
  const characters = forms
    .filter(({ cf, char }) => char.profileId === profileId && !char.deleted && ownedBy(cf, session.discordId))
    .sort((a, b) => parseInt(a.char.formDesc, 16) - parseInt(b.char.formDesc, 16))
    .map(form => toSiteCharacter(form, names, account))
  res.json({ characters })
})

// POST /api/site/logout: same-origin only, so another site cannot sign the visitor out
router.post('/logout', (req, res) => {
  if (!websiteOrigin || req.get('origin') !== websiteOrigin) return res.status(403).json({ error: 'badOrigin' })
  const token = readCookie(req, SESSION_COOKIE)
  if (token) siteSessions.revoke(token)
  setCookie(res, SESSION_COOKIE, '', SESSION_PATH, 0)
  res.status(204).end()
})

module.exports = router
