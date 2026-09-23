'use strict'
// A character's progression as the gameplay layer records it: skills, deity, factions and the small
// tallies (shrines, people met). Catalogues come from the game server's own json files, reread when
// they change, so a new skill or faction appears without a backend restart.

const fs   = require('fs')
const path = require('path')
const config = require('../config')

const cache = new Map()   // file -> { mtimeMs, value }

function readJson(name) {
  const file = path.join(config.gameServerDir, name)
  let stat
  try { stat = fs.statSync(file) } catch { return null }
  const hit = cache.get(file)
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.value
  let value = null
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { value = null }
  cache.set(file, { mtimeMs: stat.mtimeMs, value })
  return value
}

function skillCatalog() {
  const doc = readJson('skills.json')
  const list = doc && Array.isArray(doc.skills) ? doc.skills
    : (doc && doc.skills && typeof doc.skills === 'object' ? Object.values(doc.skills) : [])
  const byId = new Map()
  for (const s of list) if (s && s.id) byId.set(s.id, { label: s.label || s.title || s.id, category: s.category || '' })
  return byId
}

// Factions with their resolved rank list: a faction either lists ranks or names a template
function factionCatalog() {
  const doc = readJson('guild-defs.json')
  const byId = new Map()
  if (!doc || !Array.isArray(doc.factions)) return byId
  const templates = doc.templates || {}
  for (const f of doc.factions) {
    if (!f || !f.id) continue
    const ranks = Array.isArray(f.ranks) ? f.ranks : (templates[f.template] || [])
    byId.set(f.id, { name: f.name || f.id, kind: f.kind || '', secret: !!f.secret, ranks })
  }
  return byId
}

// The authoritative roster, keyed { factionId: { actorId: { rank, since } } }; absent until anyone joins
function roster() {
  const doc = readJson('guilds.json')
  return doc && typeof doc === 'object' ? doc : {}
}

// Every faction this character belongs to, with the rank title and join date when the roster has them
function factionsOf(dynamicFields, formDesc) {
  const catalog = factionCatalog()
  const members = roster()
  const actorId = String(parseInt(String(formDesc || ''), 16) >>> 0)
  const seen = new Set()
  const out = []

  const add = (fid, role) => {
    if (seen.has(fid)) return
    const f = catalog.get(fid)
    if (!f) return
    seen.add(fid)
    const entry = members[fid] && members[fid][actorId]
    const rank = entry && Number.isInteger(entry.rank) ? f.ranks[entry.rank] : null
    out.push({
      id: fid,
      name: f.name,
      kind: f.kind,
      secret: f.secret,
      rank: rank && rank.title ? rank.title : (role || null),
      since: entry && Number.isFinite(entry.since) ? new Date(entry.since).toISOString() : null,
    })
  }

  // The roster is the truth; the mirror on the character covers a roster file that has not been written yet
  for (const [fid, byActor] of Object.entries(members)) if (byActor && byActor[actorId]) add(fid, null)
  const mirror = dynamicFields['private.dboGuilds']
  if (Array.isArray(mirror)) for (const m of mirror) if (m && m.id) add(m.id, m.role || null)
  return out
}

function skillsOf(dynamicFields) {
  const mastery = dynamicFields['private.mastery']
  const skills = mastery && mastery.skills && typeof mastery.skills === 'object' ? mastery.skills : {}
  const catalog = skillCatalog()
  const rows = []
  for (const [id, s] of Object.entries(skills)) {
    if (!s || typeof s !== 'object') continue
    const points = Number.isFinite(s.points) ? s.points : 0
    const level  = Number.isFinite(s.level) ? s.level : 0
    if (!points && !level) continue
    const meta = catalog.get(id) || { label: id, category: '' }
    rows.push({ id, label: meta.label, category: meta.category, level, points,
                rank: Number.isFinite(s.rank) ? s.rank : null })
  }
  rows.sort((a, b) => b.points - a.points || b.level - a.level)
  return rows
}

function countOf(value) {
  if (Array.isArray(value)) return value.length
  if (value && typeof value === 'object') return Object.keys(value).length
  return 0
}

// Built field by field; the supernatural state is reduced to a single word on purpose
function progressOf(dynamicFields, formDesc) {
  const df = dynamicFields || {}
  const skills = skillsOf(df)
  const deity = df['private.dboDeity']
  const supernatural = df['private.supernatural']
  return {
    skills,
    skillPoints: skills.reduce((n, s) => n + s.points, 0),
    deity: deity && typeof deity === 'object' && deity.name ? { name: String(deity.name), kind: deity.kind || null } : null,
    factions: factionsOf(df, formDesc),
    shrinesPrayed: countOf(df['private.prayedShrines']),
    peopleMet: countOf(df['private.metActors']),
    supernatural: supernatural && typeof supernatural.kind === 'string' ? supernatural.kind : null,
  }
}

module.exports = { progressOf, factionsOf, skillsOf }
