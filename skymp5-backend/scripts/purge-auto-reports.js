'use strict'

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })

/**
 * Removes one player's automatic reports (docs/auto-report-v1.md §6.3). Stop the backend first: it keeps
 * auto-state.json and error-groups.json in memory and would write the purged ids back.
 *   node scripts/purge-auto-reports.js --profile <id>
 * Deletes <AUTO_REPORT_DIR>/reports/<id>-*, the profile's seen ids, counters, mute and pending entries in
 * auto-state.json, and its id and hardware hash from every group in error-groups.json. Groups keep their counts:
 * the id becomes one anonymous key for this run.
 */

const crypto = require('crypto')
const fs     = require('fs')
const path   = require('path')
const config = require('../config')
const { writeAtomic, readJson } = require('../sources/atomicFile')

const PROFILE = /^\d{1,16}$/
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

function purgeReports(dir, pid) {
  const folder = path.join(dir, 'reports')
  if (!fs.existsSync(folder)) return 0
  const names = fs.readdirSync(folder).filter(name => name.startsWith(`${pid}-`))
  for (const name of names) fs.unlinkSync(path.join(folder, name))
  return names.length
}

function purgeState(dir, pid) {
  const file = path.join(dir, 'auto-state.json')
  const saved = readJson(file, isObject)
  if (!saved) return
  if (isObject(saved.profiles)) delete saved.profiles[pid]
  if (Array.isArray(saved.pending)) saved.pending = saved.pending.filter(e => !Array.isArray(e) || String(e[1]) !== pid)
  writeAtomic(file, JSON.stringify(saved))
}

// Returns how many groups named the profile
function purgeGroups(dir, pid, token) {
  const file = path.join(dir, 'error-groups.json')
  const saved = readJson(file, v => isObject(v) && isObject(v.groups))
  if (!saved) return 0
  let named = 0
  for (const g of Object.values(saved.groups)) {
    if (!isObject(g)) continue
    const before = JSON.stringify(g)
    const swap = id => (id === pid ? token : id)
    if (isObject(g.players) && g.players[pid]) {
      g.players[token] = g.players[pid]
      delete g.players[pid]
    }
    if (Array.isArray(g.promotion)) g.promotion = g.promotion.map(e => (Array.isArray(e) && e[0] === pid ? [token, null] : e))
    if (isObject(g.regression) && Array.isArray(g.regression.profiles)) g.regression.profiles = g.regression.profiles.map(swap)
    for (const slot of Array.isArray(g.daily) ? g.daily : []) if (Array.isArray(slot.players)) slot.players = slot.players.map(swap)
    for (const v of isObject(g.versions) ? Object.values(g.versions) : []) {
      if (Array.isArray(v.samples)) v.samples = v.samples.filter(key => !String(key).startsWith(`${pid}-`))
    }
    if (JSON.stringify(g) !== before) named++
  }
  if (isObject(saved.profiles)) delete saved.profiles[pid]
  writeAtomic(file, JSON.stringify(saved))
  return named
}

function purge(profileId, dir = config.autoReportDir) {
  const pid = String(profileId)
  if (!PROFILE.test(pid)) throw new Error(`--profile ${profileId} is not a profile id`)
  const reports = purgeReports(dir, pid)
  purgeState(dir, pid)
  const groups = purgeGroups(dir, pid, `purged-${crypto.randomBytes(4).toString('hex')}`)
  const copies = fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => /\.json\.bad-\d+$/.test(name)) : []
  return { reports, groups, copies }
}

function main(argv = process.argv.slice(2)) {
  try {
    if (argv.length !== 2 || argv[0] !== '--profile') throw new Error('usage: purge-auto-reports.js --profile <id>')
    const { reports, groups, copies } = purge(argv[1])
    console.log(`[purge-auto-reports] profile ${argv[1]}: ${reports} report file(s) deleted, removed from ${groups} group(s)`)
    if (copies.length) console.log(`[purge-auto-reports] not edited, check or delete by hand: ${copies.join(', ')}`)
    return 0
  } catch (err) {
    console.error(`[purge-auto-reports] ${err.message}`)
    return 1
  }
}

if (require.main === module) process.exitCode = main()

module.exports = { purge, main }
