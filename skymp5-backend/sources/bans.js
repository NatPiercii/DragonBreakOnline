'use strict'

// data/bans.json: one entry per banned discordId with hwid/ip captured at ban time, so alt accounts can be matched later

const fs   = require('fs')
const path = require('path')

const FILE    = path.join(__dirname, '..', 'data', 'bans.json')
const LOG_DIR = process.env.BAN_LOG_DIR || 'C:\\Users\\Administrator\\Desktop\\logs'

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n')
}

// Every player reaches the game server through the host's port forward, so the address the server reports for all of
// them is one internal one (9 Oct 2026: 146 of 173 players share it). Storing or matching it would make one ban refuse
// everyone, so internal, loopback, link-local and carrier-grade NAT addresses never go into a ban or match one.
function isInternalIp(ip) {
  let a = String(ip || '').trim().toLowerCase()
  if (!a) return false
  if (a.startsWith('::ffff:')) a = a.slice(7)
  const m = a.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const [x, y] = [Number(m[1]), Number(m[2])]
    return x === 10 || x === 127 || x === 0 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) ||
      (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127)
  }
  return a === '::1' || a === '::' || /^f[cd][0-9a-f]{0,2}:/.test(a) || /^fe[89ab][0-9a-f]?:/.test(a)
}

const publicIp = (ip) => {
  const a = String(ip || '').trim()
  return a && !isInternalIp(a) ? a : ''
}

function list() {
  return load()
}

// Returns the first entry matching ANY given identifier (empty/null ones are ignored), or null
function isBanned({ discordId, hwid, ip } = {}) {
  const id   = String(discordId || '').trim()
  const hw   = String(hwid || '').trim()
  const addr = publicIp(ip)
  if (!id && !hw && !addr) return null
  return load().find(entry =>
    (id && entry.discordId && String(entry.discordId) === id) ||
    (hw && entry.hwid && String(entry.hwid) === hw) ||
    (addr && publicIp(entry.ip) === addr)
  ) || null
}

// Adds a ban entry; an existing entry for the same discordId is replaced
function add(input) {
  const discordId = String((input && input.discordId) || '').trim()
  if (!discordId) throw new Error('discordId is required')
  const entry = {
    discordId,
    hwid: input.hwid || null,
    ip: publicIp(input.ip) || null,
    reason: String(input.reason || ''),
    bannedAt: input.bannedAt || new Date().toISOString(),
    bannedBy: input.bannedBy || null,
  }
  const data = load().filter(e => String(e.discordId) !== discordId)
  data.push(entry)
  save(data)
  return entry
}

function removeByDiscordId(discordId) {
  const id = String(discordId || '').trim()
  const data = load()
  const next = data.filter(e => String(e.discordId) !== id)
  if (next.length === data.length) return false
  save(next)
  return true
}

// Appends a timestamped line to ban.log; logging failures must never break the ban flow
function logBan(line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(path.join(LOG_DIR, 'ban.log'), `${new Date().toISOString()} ${line}\n`)
  } catch (e) {
    console.error('[bans] failed to write ban.log:', e.message)
  }
}

module.exports = {
  isInternalIp,
  list,
  isBanned,
  add,
  removeByDiscordId,
  logBan,
}
