'use strict'
// Known client versions (docs/auto-report-v1.md §2.12, design §7): the current release and the 10 newest archived builds

const fs = require('fs')
const path = require('path')
const config = require('../config')
const { PATTERNS } = require('./autoSchema')
const { compareVersions } = require('./autoSignature')

const ARCHIVED_KEPT = 10
const RECHECK_MS = 60 * 1000

// { dir, at, versions: Promise<Set> }
let cache = null

// CLIENT_VERSION as GET /api/version serves it; required here, since the route requires autoReport
const currentVersion = () => require('../routes/version').readConst('CLIENT_VERSION', null)

// The clientVersion of every archived client meta (scripts/archive-symbols.js), newest first
async function archivedVersions(dir) {
  let names = []
  try { names = (await fs.promises.readdir(dir)).filter(name => name.endsWith('.json')) }
  catch (err) { if (err.code !== 'ENOENT') console.error('[auto-report] archived client builds not listed:', err.message) }
  const versions = new Set()
  for (const name of names) {
    try {
      const { clientVersion } = JSON.parse(await fs.promises.readFile(path.join(dir, name), 'utf8'))
      if (typeof clientVersion === 'string' && PATTERNS.version.test(clientVersion)) versions.add(clientVersion)
    } catch { /* a meta that cannot be read names no version */ }
  }
  return [...versions].sort((a, b) => compareVersions(b, a)).slice(0, ARCHIVED_KEPT)
}

async function load(dir) {
  const current = currentVersion()
  return new Set([...(current ? [current] : []), ...await archivedVersions(dir)])
}

// Read at most once a minute, so a version bump or a new archive counts without a restart
function known(now = Date.now()) {
  const dir = path.join(config.autoSourceMapDir, 'client')
  if (!cache || cache.dir !== dir || now - cache.at >= RECHECK_MS) cache = { dir, at: now, versions: load(dir) }
  return cache.versions
}

const isKnown = async version => (await known()).has(version)

module.exports = { known, isKnown }
