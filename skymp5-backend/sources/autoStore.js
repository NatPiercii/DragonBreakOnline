'use strict'
// Auto report storage under config.autoReportDir: one 0600 file per report, and auto-state.json for what must survive a restart

const crypto = require('crypto')
const fs     = require('fs')
const path   = require('path')
const config = require('../config')

const DAY_MS = 24 * 60 * 60 * 1000
const SEEN_MS = 8 * DAY_MS
const SEEN_MAX = 500
const STATE_FILE = 'auto-state.json'

// { dir, profiles: Map<profileId, { day, reports, bytes, seen: Map<reportId, receivedAt> }> }, oldest seen id first
let state = null

const utcDay = at => new Date(at).toISOString().slice(0, 10)
const nextUtcDay = at => (Math.floor(at / DAY_MS) + 1) * DAY_MS
const isPair = e => Array.isArray(e) && typeof e[0] === 'string' && Number.isFinite(e[1])

// A unique temp name, so two writers never share one, and a crash mid-write never leaves a truncated file
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' })
    fs.renameSync(tmp, file)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
}

function load() {
  state = { dir: config.autoReportDir, profiles: new Map() }
  let saved
  try { saved = JSON.parse(fs.readFileSync(path.join(state.dir, STATE_FILE), 'utf8')) }
  catch (err) {
    if (err.code !== 'ENOENT') console.error(`[auto-report] ${STATE_FILE} unreadable, starting empty:`, err.message)
    return
  }
  const profiles = saved && typeof saved.profiles === 'object' && saved.profiles ? saved.profiles : {}
  for (const [id, p] of Object.entries(profiles)) {
    if (!p || typeof p !== 'object') continue
    state.profiles.set(id, {
      day: String(p.day || ''), reports: Number(p.reports) || 0, bytes: Number(p.bytes) || 0,
      seen: new Map((Array.isArray(p.seen) ? p.seen : []).filter(isPair)),
    })
  }
}

// Reloads when the folder changes, so tests can point config.autoReportDir at a temp dir
function current() {
  if (!state || state.dir !== config.autoReportDir) load()
  return state
}

// The profile's entry, its daily counters reset when the UTC day has changed
function today(profileId, now) {
  const { profiles } = current()
  const key = String(profileId)
  let p = profiles.get(key)
  if (!p) profiles.set(key, p = { day: '', reports: 0, bytes: 0, seen: new Map() })
  if (p.day !== utcDay(now)) Object.assign(p, { day: utcDay(now), reports: 0, bytes: 0 })
  return p
}

function isSeen(profileId, reportId, now) {
  const p = current().profiles.get(String(profileId))
  const at = p && p.seen.get(reportId)
  return at !== undefined && now - at <= SEEN_MS
}

// Drops expired seen ids and idle profiles; a failed write is logged, the counters stay in memory
function save(now) {
  const { dir, profiles } = current()
  const out = {}
  for (const [id, p] of profiles) {
    for (const [reportId, at] of p.seen) if (now - at > SEEN_MS) p.seen.delete(reportId)
    if (!p.seen.size && p.day !== utcDay(now)) profiles.delete(id)
    else out[id] = { day: p.day, reports: p.reports, bytes: p.bytes, seen: [...p.seen] }
  }
  try { writeAtomic(path.join(dir, STATE_FILE), JSON.stringify({ v: 1, profiles: out })) }
  catch (err) { console.error(`[auto-report] ${STATE_FILE} not saved:`, err.message) }
}

const reportFile = (profileId, reportId) => path.join(current().dir, 'reports', `${profileId}-${reportId}.json`)

// text is JSON.stringify(record); throws when the report file cannot be written
function add(record, text) {
  const { profileId, receivedAt, report: { reportId } } = record
  writeAtomic(reportFile(profileId, reportId), text)
  const p = today(profileId, receivedAt)
  p.bytes += Buffer.byteLength(text)
  p.seen.delete(reportId)
  p.seen.set(reportId, receivedAt)
  if (p.seen.size > SEEN_MAX) p.seen.delete(p.seen.keys().next().value)
  save(receivedAt)
}

module.exports = { load, today, isSeen, save, add, reportFile, nextUtcDay, SEEN_MS, SEEN_MAX }
