'use strict'
// Auto report storage under config.autoReportDir: one 0600 file per report, and auto-state.json for what must survive a restart

const fs     = require('fs')
const path   = require('path')
const config = require('../config')
const { writeAtomic, readJson } = require('./atomicFile')

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const MUTE_MS = DAY_MS
const SEEN_MS = 8 * DAY_MS
const SEEN_MAX = 500
const RETENTION_MS = 30 * DAY_MS
const TMP_MAX_AGE_MS = 60 * 60 * 1000
const STATE_FILE = 'auto-state.json'
const REPORT_NAME = /^\d+-[0-9a-f-]{36}\.json$/
const TMP_NAME = /\.[0-9a-f]{12}\.tmp$/

// { dir, profiles: Map<profileId, profile>, seq, pending, groupedSeq }
// profile: { day, reports, bytes, seen: Map<reportId, receivedAt>, hour, invalid, mutedUntil }, invalid counted in that hour
// Seen ids are oldest first; pending lists [seq, profileId, reportId] of stored reports the groups have not saved yet
let state = null

const utcDay = at => new Date(at).toISOString().slice(0, 10)
const nextUtcDay = at => (Math.floor(at / DAY_MS) + 1) * DAY_MS
const hourOf = at => Math.floor(at / HOUR_MS)
const count = v => (Number.isSafeInteger(v) && v > 0 ? v : 0)
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const isPair = e => Array.isArray(e) && typeof e[0] === 'string' && Number.isFinite(e[1])
const isPending = e => Array.isArray(e) && Number.isSafeInteger(e[0]) && e[0] > 0 && Number.isSafeInteger(e[1]) && typeof e[2] === 'string'

// A read error throws and leaves the state unloaded, so the next call tries again instead of saving an empty state
function load() {
  const dir = config.autoReportDir
  const saved = readJson(path.join(dir, STATE_FILE), isObject) || {}
  state = { dir, profiles: new Map(), seq: 0, pending: [], groupedSeq: 0 }
  const profiles = isObject(saved.profiles) ? saved.profiles : {}
  for (const [id, p] of Object.entries(profiles)) {
    if (!p || typeof p !== 'object') continue
    state.profiles.set(id, {
      day: String(p.day || ''), reports: Number(p.reports) || 0, bytes: Number(p.bytes) || 0,
      seen: new Map((Array.isArray(p.seen) ? p.seen : []).filter(isPair)),
      hour: count(p.hour), invalid: count(p.invalid), mutedUntil: count(p.mutedUntil),
    })
  }
  state.pending = (Array.isArray(saved.pending) ? saved.pending : []).filter(isPending)
  state.seq = Math.max(Number.isSafeInteger(saved.seq) ? saved.seq : 0, ...state.pending.map(e => e[0]))
}

// Reloads when the folder changes, so tests can point config.autoReportDir at a temp dir
function current() {
  if (!state || state.dir !== config.autoReportDir) load()
  return state
}

function profile(profileId) {
  const { profiles } = current()
  const key = String(profileId)
  let p = profiles.get(key)
  if (!p) profiles.set(key, p = { day: '', reports: 0, bytes: 0, seen: new Map(), hour: 0, invalid: 0, mutedUntil: 0 })
  return p
}

// The profile's entry, its daily counters reset when the UTC day has changed
function today(profileId, now) {
  const p = profile(profileId)
  if (p.day !== utcDay(now)) Object.assign(p, { day: utcDay(now), reports: 0, bytes: 0 })
  return p
}

// Design §7: a muted profile gets a plain 202 and nothing it sends is stored or counted
function isMuted(profileId, now) {
  const p = current().profiles.get(String(profileId))
  return Boolean(p && p.mutedUntil > now)
}

function mute(profileId, now, reason) {
  const p = profile(profileId)
  if (p.mutedUntil > now) return
  p.mutedUntil = now + MUTE_MS
  console.log(`[auto-report] profile ${profileId} muted for 24 h: ${reason}`)
  save(now)
}

// A 422 schema refusal or an invalidField report (§2.12); past the hourly limit the profile is muted
function countInvalid(profileId, now) {
  const p = profile(profileId)
  if (p.hour !== hourOf(now)) Object.assign(p, { hour: hourOf(now), invalid: 0 })
  p.invalid++
  if (p.invalid > config.autoReportLimits.muteInvalidPerHour) mute(profileId, now, 'invalid reports')
  else save(now)
}

function isSeen(profileId, reportId, now) {
  const p = current().profiles.get(String(profileId))
  const at = p && p.seen.get(reportId)
  return at !== undefined && now - at <= SEEN_MS
}

// Drops expired seen ids, idle profiles and grouped entries; a failed write is logged, the counters stay in memory
function save(now) {
  const st = current()
  const out = {}
  for (const [id, p] of st.profiles) {
    for (const [reportId, at] of p.seen) if (now - at > SEEN_MS) p.seen.delete(reportId)
    if (!p.seen.size && p.day !== utcDay(now) && p.hour !== hourOf(now) && p.mutedUntil <= now) st.profiles.delete(id)
    else {
      const { day, reports, bytes, hour, invalid, mutedUntil } = p
      out[id] = { day, reports, bytes, seen: [...p.seen], hour, invalid, mutedUntil }
    }
  }
  st.pending = st.pending.filter(([seq]) => seq > st.groupedSeq)
  try { writeAtomic(path.join(st.dir, STATE_FILE), JSON.stringify({ v: 1, profiles: out, seq: st.seq, pending: st.pending })) }
  catch (err) { console.error(`[auto-report] ${STATE_FILE} not saved:`, err.message) }
}

const reportFile = (profileId, reportId) => path.join(current().dir, 'reports', `${profileId}-${reportId}.json`)

// text is JSON.stringify(record); throws when the report file cannot be written
function add(record, text) {
  const { profileId, receivedAt, report: { reportId } } = record
  writeAtomic(reportFile(profileId, reportId), text, receivedAt)
  const st = current()
  const p = today(profileId, receivedAt)
  p.bytes += Buffer.byteLength(text)
  p.seen.delete(reportId)
  p.seen.set(reportId, receivedAt)
  if (p.seen.size > SEEN_MAX) p.seen.delete(p.seen.keys().next().value)
  st.pending.push([++st.seq, profileId, reportId])
  save(receivedAt)
}

// Rewrites a stored report in place, keeping its receipt time as the file date
function rewrite(record) {
  writeAtomic(reportFile(record.profileId, record.report.reportId), JSON.stringify(record), record.receivedAt)
}

async function readReport(profileId, reportId) {
  try { return JSON.parse(await fs.promises.readFile(reportFile(profileId, reportId), 'utf8')) }
  catch (err) {
    if (err.code !== 'ENOENT') console.error('[auto-report] stored report unreadable:', err.message)
    return null
  }
}

const pending = () => current().pending

// The groups file saved everything up to seq; a sequence restarted from a lost state file never reuses a number
function grouped(seq) {
  const st = current()
  st.groupedSeq = Math.max(st.groupedSeq, seq)
  st.seq = Math.max(st.seq, seq)
}

// mkdir sets a mode only when it creates the folder, so an auto folder or reports/ made 0755 before is set to 0700 at start
function tightenFolders() {
  const dir = config.autoReportDir
  for (const folder of [dir, path.join(dir, 'reports')]) {
    try { fs.chmodSync(folder, 0o700) }
    catch (err) { if (err.code !== 'ENOENT') console.error('[auto-report] folder not set to 0700:', err.message) }
  }
}

// Deletes reports past 30 days (a report file is dated with its receipt time) and temp files a crash left behind
async function janitor(now = Date.now()) {
  const { dir } = current()
  let removed = 0
  for (const folder of [dir, path.join(dir, 'reports')]) {
    let names
    try { names = await fs.promises.readdir(folder) }
    catch (err) {
      if (err.code !== 'ENOENT') console.error('[auto-report] janitor cannot list a folder:', err.message)
      continue
    }
    for (const name of names) {
      const maxAge = TMP_NAME.test(name) ? TMP_MAX_AGE_MS : folder !== dir && REPORT_NAME.test(name) ? RETENTION_MS : null
      if (maxAge === null) continue
      const file = path.join(folder, name)
      try {
        if (now - (await fs.promises.stat(file)).mtimeMs <= maxAge) continue
        await fs.promises.unlink(file)
        removed++
      } catch (err) {
        if (err.code !== 'ENOENT') console.error(`[auto-report] janitor skipped ${name}:`, err.message)
      }
    }
  }
  return removed
}

module.exports = {
  load, today, isSeen, isMuted, mute, countInvalid, save, add, rewrite, readReport, pending, grouped, janitor, tightenFolders,
  writeAtomic, reportFile, nextUtcDay, hourOf, SEEN_MS, SEEN_MAX, RETENTION_MS, MUTE_MS,
}
