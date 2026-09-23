'use strict'
// Staff dashboard data, behind the website sign-in and a Discord role check on EVERY request, so a
// member who loses the role loses the page at their next click rather than when their session expires.
// Roles: config.siteStaffRoleIds (Owners and Dragon Break Dev). The bot's role lookup fails closed:
// if Discord cannot be asked, the answer is no.
//
//   GET /api/site/staff/me        whether the signed-in visitor is staff
//   GET /api/site/staff/overview  server state and account totals
//   GET /api/site/staff/players   every account: Discord name, characters, last launcher sign-in, last game join, factions

const router  = require('express').Router()
const config  = require('../config')
const players = require('../sources/players')
const discordBot = require('../sources/discordBot')
const nameTable = require('../sources/nameTable')
const { getHeartbeat } = require('./servers')
const { internals } = require('./site-auth')
const { currentSession, readStore, toSiteCharacter, profileIdOf, dynamicFields } = internals

router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, private')
  next()
})

async function isStaff(discordId) {
  for (const roleId of config.siteStaffRoleIds) {
    try { if (await discordBot.memberHasRole(discordId, roleId)) return true }
    catch (err) { console.error('[site-staff] role lookup failed:', err.message) }
  }
  return false
}

async function requireStaff(req, res, next) {
  const session = currentSession(req)
  if (!session) return res.status(401).json({ error: 'signedOut' })
  if (!(await isStaff(session.discordId))) return res.status(403).json({ error: 'notStaff' })
  req.staff = session
  next()
}

router.get('/me', async (req, res) => {
  const session = currentSession(req)
  if (!session) return res.json({ signedIn: false, staff: false })
  res.json({ signedIn: true, staff: await isStaff(session.discordId), name: String(session.username || '') })
})

// Characters grouped by the account that owns them; a character stamped with another Discord id is skipped
function charactersByProfile() {
  const byProfile = new Map()
  for (const form of readStore()) {
    const pid = form.char.profileId
    if (!byProfile.has(pid)) byProfile.set(pid, [])
    byProfile.get(pid).push(form)
  }
  return byProfile
}

function within(iso, ms) {
  const t = Date.parse(iso || '')
  return Number.isFinite(t) && Date.now() - t < ms
}

router.get('/overview', requireStaff, (_req, res) => {
  const rows = Object.values(players.load())
  let characters = 0
  try { for (const forms of charactersByProfile().values()) characters += forms.filter(f => !f.char.deleted).length }
  catch { characters = null }
  const beat = getHeartbeat()
  const DAY = 24 * 3600 * 1000
  res.json({
    server: beat ? { name: beat.name, online: beat.online, maxPlayers: beat.maxPlayers, lastSeen: beat.lastSeen } : null,
    accounts: rows.length,
    characters,
    joinedGame24h: rows.filter(r => within(r.lastGameJoinAt, DAY)).length,
    joinedGame7d:  rows.filter(r => within(r.lastGameJoinAt, 7 * DAY)).length,
    launcher24h:   rows.filter(r => within(r.lastSeenAt, DAY)).length,
  })
})

// Deliberately NOT included: lastIp, hwid and admin notes. The page is for recognising people, not tracking them.
router.get('/players', requireStaff, (_req, res) => {
  let byProfile
  try { byProfile = charactersByProfile() }
  catch (err) {
    console.error('[site-staff] changeForms store unreadable:', err.message)
    return res.status(503).json({ error: 'storeUnavailable' })
  }

  const names = nameTable.load()
  const accounts = Object.entries(players.load()).map(([discordId, row]) => {
    const profileId = Number.isInteger(row.profileId) ? row.profileId : profileIdOf(discordId)
    const forms = (byProfile.get(profileId) || []).filter(f => {
      const stamped = dynamicFields(f.cf)['private.indexed.discordId']
      return !f.char.deleted && (stamped === undefined || stamped === null || stamped === discordId)
    })
    const characters = forms
      .sort((a, b) => parseInt(a.char.formDesc, 16) - parseInt(b.char.formDesc, 16))
      .map(form => {
        const c = toSiteCharacter(form, names, null)
        return {
          name: c.name, status: c.status, race: c.race, gold: c.gold,
          skillPoints: c.progress.skillPoints,
          topSkill: c.progress.skills[0] ? `${c.progress.skills[0].label} ${c.progress.skills[0].points}` : null,
          deity: c.progress.deity ? c.progress.deity.name : null,
          factions: c.progress.factions.map(f => ({ name: f.name, kind: f.kind, rank: f.rank })),
          lastSaved: c.lastSaved,
        }
      })
    const factionNames = [...new Set(characters.flatMap(c => c.factions.map(f => f.name)))]
    return {
      discordName: String(row.displayName || row.username || ''),
      username: String(row.username || ''),
      avatarUrl: typeof row.avatar === 'string' && row.avatar.startsWith('https://cdn.discordapp.com/') ? row.avatar : null,
      profileId,
      createdAt: row.createdAt || null,
      lastLauncherSignIn: row.lastSeenAt || null,
      lastGameJoin: row.lastGameJoinAt || null,
      characters,
      factions: factionNames,
    }
  })

  const newest = r => Math.max(Date.parse(r.lastGameJoin || 0) || 0, Date.parse(r.lastLauncherSignIn || 0) || 0)
  accounts.sort((a, b) => newest(b) - newest(a))
  res.json({ accounts })
})

module.exports = router
