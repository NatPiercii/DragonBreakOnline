'use strict'
// Auto report groups (design §4.3, §4.4): error-groups.json under config.autoReportDir, fed in order from the store's pending list

const path = require('path')
const config = require('../config')
const autoStore = require('./autoStore')
const sourceMaps = require('./sourceMaps')
const { signature, compareVersions } = require('./autoSignature')
const { readJson } = require('./atomicFile')
const clientVersions = require('./clientVersions')

const FILE = 'error-groups.json'
const DAY_MS = 24 * 60 * 60 * 1000
const SAVE_DELAY_MS = 5000
const COUNT_GAP_MS = 10 * 60 * 1000
const DAILY_SLOTS = 14
const SAMPLES_PER_VERSION = 5
const PROMOTE_PLAYERS = 2
const REGRESSION_PLAYERS = 2
const PROMOTION_MAX = 50
const UNKNOWN_VERSIONS_MAX = 50

// { dir, seq, groups: { [id]: group }, profiles, unknownVersion, timer }; seq is the last pending entry applied to groups
// profiles: { [profileId]: { hour, tried: [signature ids new in that hour], day, created: groups opened that day } }
let state = null
let draining = null

const utcDay = at => new Date(at).toISOString().slice(0, 10)
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const versionOf = report => (report.versions && report.versions.client) || 'unknown'
const emptyUnknown = () => ({ reports: 0, lastSeen: null, versions: {} })

// Replaces the state in memory, as a restart would: changes not yet saved are dropped and applied again from pending
// A read error throws and keeps the old state, so grouping stops until the file can be read instead of starting empty
function load() {
  const dir = config.autoReportDir
  const saved = readJson(path.join(dir, FILE), v => isObject(v) && isObject(v.groups))
  if (state) clearTimeout(state.timer)
  state = { dir, seq: 0, groups: {}, profiles: {}, unknownVersion: emptyUnknown(), timer: null }
  if (!saved) return
  state.groups = saved.groups
  for (const [pid, p] of Object.entries(isObject(saved.profiles) ? saved.profiles : {})) {
    if (isObject(p) && Array.isArray(p.tried)) state.profiles[pid] = p
  }
  const unknown = saved.unknownVersion
  if (isObject(unknown) && Number.isSafeInteger(unknown.reports) && isObject(unknown.versions)) state.unknownVersion = unknown
  state.seq = Number.isSafeInteger(saved.seq) && saved.seq > 0 ? saved.seq : 0
  autoStore.grouped(state.seq)
}

// Reloads when the folder changes, so tests can point config.autoReportDir at a temp dir
function current() {
  if (!state || state.dir !== config.autoReportDir) load()
  return state
}

// New-signature counters from before the newest day seen can no longer count
function pruneProfiles(st) {
  const newest = Object.values(st.profiles).reduce((max, p) => (p.day > max ? p.day : max), '')
  for (const [pid, p] of Object.entries(st.profiles)) if (p.day !== newest) delete st.profiles[pid]
}

function save(st) {
  clearTimeout(st.timer)
  st.timer = null
  pruneProfiles(st)
  try {
    const { seq, groups, profiles, unknownVersion } = st
    autoStore.writeAtomic(path.join(st.dir, FILE), JSON.stringify({ v: 1, seq, groups, profiles, unknownVersion }))
    if (st.dir === config.autoReportDir) autoStore.grouped(st.seq)
  } catch (err) {
    console.error(`[auto-report] ${FILE} not saved:`, err.message)
  }
}

// At most one write per 5 s; entries not yet saved stay pending in auto-state.json and are applied again after a restart
function scheduleSave(st) {
  if (st.timer) return
  st.timer = setTimeout(() => save(st), SAVE_DELAY_MS)
  st.timer.unref()
}

const flush = () => save(current())

function createGroup(sig, record, reasons) {
  const at = record.receivedAt
  return {
    id: sig.id, canonical: sig.canonical, title: sig.title, kind: record.report.kind,
    type: sig.type, normMsg: sig.normMsg, frames: sig.frames,
    status: reasons.length ? 'held' : 'open', held: reasons, trust: record.trust,
    firstSeen: at, lastSeen: at, reports: 0, occurrences: 0, playerCount: 0,
    kinds: {}, players: {}, versions: {}, daily: [],
    promotion: [], promotedAt: null, fixedInVersion: null, fixedAt: null, regression: null,
  }
}

// The day's slot, keeping the last 14 days for the week-over-week trend
function daySlot(g, at) {
  const day = utcDay(at)
  let slot = g.daily.find(s => s.day === day)
  if (!slot) {
    slot = { day, occurrences: 0, players: [] }
    const oldest = utcDay(at - (DAILY_SLOTS - 1) * DAY_MS)
    g.daily = [...g.daily.filter(s => s.day >= oldest), slot].sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-DAILY_SLOTS)
  }
  return slot
}

function open(g, at) {
  Object.assign(g, { status: 'open', held: [], promotion: [], promotedAt: at })
}

// A held group opens on a report with nothing to hold it, or once 2 profiles on different machines hit it; suspect reports never count
function promote(g, record, reasons, at) {
  if (!reasons.length) return open(g, at)
  if (reasons.includes('suspect')) return
  const pid = String(record.profileId)
  const entry = g.promotion.find(([p]) => p === pid)
  if (!entry && g.promotion.length < PROMOTION_MAX) g.promotion.push([pid, record.hwidHash || null])
  else if (entry && !entry[1] && record.hwidHash) entry[1] = record.hwidHash
  const machines = new Set(g.promotion.map(([p, hwid]) => hwid || `profile:${p}`))
  if (g.promotion.length >= PROMOTE_PLAYERS && machines.size >= PROMOTE_PLAYERS) open(g, at)
}

// A fixed group reopens once 2 profiles hit it at or above fixedInVersion; hits on older versions only count
function regress(g, pid, version, at) {
  if (!g.fixedInVersion || version === 'unknown' || compareVersions(version, g.fixedInVersion) < 0) return
  const r = g.regression || (g.regression = { profiles: [], at: null, version: null })
  if (!r.profiles.includes(pid)) r.profiles.push(pid)
  if (r.profiles.length < REGRESSION_PLAYERS) return
  g.status = 'regression'
  Object.assign(r, { at, version })
}

// Design §7: a profile's first 5 new signatures an hour, and 15 a day, open groups; its other new ones count nowhere
// More than 15 distinct new signatures in an hour mute the profile. Counted by report time, so a replay decides the same
function admitNew(st, id, record) {
  const at = record.receivedAt
  const limits = config.autoReportLimits
  const pid = String(record.profileId)
  const p = st.profiles[pid] || (st.profiles[pid] = { hour: 0, tried: [], day: '', created: 0 })
  if (p.hour !== autoStore.hourOf(at)) Object.assign(p, { hour: autoStore.hourOf(at), tried: [] })
  if (p.day !== utcDay(at)) Object.assign(p, { day: utcDay(at), created: 0 })
  let index = p.tried.indexOf(id)
  if (index === -1) {
    if (p.tried.length > limits.muteNewSignaturesPerHour) return false
    index = p.tried.push(id) - 1
    if (p.tried.length > limits.muteNewSignaturesPerHour) autoStore.mute(record.profileId, at, 'new signatures')
  }
  if (index >= limits.newSignaturesPerHour || p.created >= limits.newSignaturesPerDay) return false
  p.created++
  return true
}

// Counts the report into its group, or returns null when it would open one past the profile's cap
// One profile adds at most 1 occurrence per group per 10 minutes
function hit(st, sig, record) {
  const at = record.receivedAt
  const { report } = record
  const pid = String(record.profileId)
  const version = versionOf(report)
  const reasons = [...sig.held]
  if (record.flags.includes('suspect')) reasons.push('suspect')
  if (record.trust !== 'verified') reasons.push('unverified-launch')

  let g = st.groups[sig.id]
  if (!g) {
    if (!admitNew(st, sig.id, record)) return null
    g = st.groups[sig.id] = createGroup(sig, record, reasons)
  }
  g.reports++
  g.lastSeen = Math.max(g.lastSeen, at)
  g.kinds[report.kind] = (g.kinds[report.kind] || 0) + 1
  if (record.trust === 'verified') g.trust = 'verified'
  const player = g.players[pid] || (g.players[pid] = { first: at, last: at, counted: null })
  player.last = at
  const ver = g.versions[version] || (g.versions[version] = { first: at, last: at, occurrences: 0, samples: [] })
  ver.last = at
  const slot = daySlot(g, at)
  if (!slot.players.includes(pid)) slot.players.push(pid)
  if (player.counted === null || at - player.counted >= COUNT_GAP_MS) {
    player.counted = at
    g.occurrences++
    ver.occurrences++
    slot.occurrences++
  }
  g.playerCount = Object.keys(g.players).length
  if (g.status === 'held') promote(g, record, reasons, at)
  else if (g.status === 'fixed') regress(g, pid, version, at)
  return g
}

// Full logs and crash sections stay with the first 5 samples per group and version (§6.3)
function keepsBulk(g, record) {
  const { report } = record
  if (!report.logs && !(report.crash && report.crash.sections)) return true
  const { samples } = g.versions[versionOf(report)]
  const key = `${record.profileId}-${report.reportId}`
  if (samples.includes(key)) return true
  if (samples.length >= SAMPLES_PER_VERSION) return false
  samples.push(key)
  return true
}

// A client version outside the known list is counted with no group and no map load (§2.12, §5.4); the list of them is capped
function countUnknown(st, record, version) {
  const u = st.unknownVersion
  u.reports++
  u.lastSeen = Math.max(u.lastSeen || 0, record.receivedAt)
  if (u.versions[version] !== undefined || Object.keys(u.versions).length < UNKNOWN_VERSIONS_MAX) u.versions[version] = (u.versions[version] || 0) + 1
}

async function apply(st, [, profileId, reportId]) {
  const record = await autoStore.readReport(profileId, reportId)
  if (!record || !record.report || !Array.isArray(record.flags) || record.ignored) return
  const version = record.report.versions && record.report.versions.client
  if (version && !(await clientVersions.isKnown(version))) return countUnknown(st, record, version)
  const g = hit(st, signature(record.report, await sourceMaps.forReport(record.report)), record)
  if (!g || keepsBulk(g, record)) return
  delete record.report.logs
  if (record.report.crash) delete record.report.crash.sections
  record.flags.push('overSamples')
  autoStore.rewrite(record)
}

async function drain() {
  for (;;) {
    const st = current()
    const next = autoStore.pending().find(([seq]) => seq > st.seq)
    if (!next) return
    try { await apply(st, next) }
    catch (err) { console.error('[auto-report] report not grouped:', err.message) }
    st.seq = Math.max(st.seq, next[0])
    scheduleSave(st)
  }
}

// Groups every pending report in order, after the 202; resolves once none is left
function kick() {
  if (!draining) {
    draining = drain()
      .catch(err => console.error('[auto-report] grouping stopped:', err.message))
      .finally(() => { draining = null })
  }
  return draining
}

const idle = () => draining || Promise.resolve()
const get = id => current().groups[id] || null
const list = () => Object.values(current().groups)
const unknownVersion = () => current().unknownVersion

// Staff marked the group fixed; a null version stays pending until the next client version is known
function markFixed(id, fixedInVersion, at = Date.now()) {
  const st = current()
  const g = st.groups[id]
  if (!g) return null
  Object.assign(g, { status: 'fixed', fixedInVersion: fixedInVersion || null, fixedAt: at, regression: null })
  scheduleSave(st)
  return g
}

module.exports = { load, kick, idle, flush, get, list, unknownVersion, markFixed }
