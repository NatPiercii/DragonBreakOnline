'use strict'
// In-game /bug reports waiting for the reporter's launcher to send their logs, one send each (data/bug-logs.json)

const fs = require('fs')
const path = require('path')

const BUG_DIR = process.env.DBO_BUG_DIR || '/var/lib/dbo-monitor/bugs'
const STATE_FILE = process.env.DBO_BUG_LOGS_STATE || path.join(__dirname, '..', 'data', 'bug-logs.json')
// A /bug older than this gets no logs: the session it describes is long over
const PENDING_MS = 2 * 60 * 60 * 1000
const KEEP_SENT_MS = 7 * 24 * 60 * 60 * 1000
const MAX_PENDING = 5
// debugsnap.js names a snapshot <ISO time with dashes>-<TAG>.json
const ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[A-Za-z0-9]{4}$/

const validId = id => typeof id === 'string' && ID_RE.test(id)

function readState(file = STATE_FILE) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
    return s && typeof s.sent === 'object' && s.sent ? s : { sent: {} }
  } catch {
    return { sent: {} }
  }
}

function writeState(state, file = STATE_FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file + '.tmp', JSON.stringify(state, null, 1))
    fs.renameSync(file + '.tmp', file)
  } catch (err) {
    console.error('[bug-logs] could not save state:', err.message)
  }
}

// [{ id, at }] newest first: this profile's /bug snapshots of the last two hours that have no logs yet
function pendingFor(profileId, { dir = BUG_DIR, stateFile = STATE_FILE, now = Date.now() } = {}) {
  if (!Number.isInteger(profileId) || profileId < 0) return []
  const sent = readState(stateFile).sent
  let names
  try { names = fs.readdirSync(dir) } catch { return [] }
  const out = []
  for (const name of names) {
    const id = name.replace(/\.json$/, '')
    if (!name.endsWith('.json') || !validId(id) || sent[id]) continue
    const file = path.join(dir, name)
    let st
    try { st = fs.statSync(file) } catch { continue }
    if (now - st.mtimeMs > PENDING_MS) continue
    let snap
    try { snap = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { continue }
    if (!snap || snap.profileId !== profileId) continue
    out.push({ id, at: String(snap.at || '') })
  }
  out.sort((a, b) => (a.id < b.id ? 1 : -1))
  return out.slice(0, MAX_PENDING)
}

const isPending = (id, profileId, opts) => validId(id) && pendingFor(profileId, opts).some(p => p.id === id)

function markSent(id, thread, { stateFile = STATE_FILE, now = Date.now() } = {}) {
  const state = readState(stateFile)
  state.sent[id] = { at: now, thread: thread || null }
  for (const [k, v] of Object.entries(state.sent)) if (!v || now - Number(v.at) > KEEP_SENT_MS) delete state.sent[k]
  writeState(state, stateFile)
}

module.exports = { pendingFor, isPending, markSent, validId, BUG_DIR, PENDING_MS }
