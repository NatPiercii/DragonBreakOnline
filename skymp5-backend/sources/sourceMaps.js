'use strict'
// Archived source maps (docs/auto-report-v1.md §5.4): <autoSourceMapDir>/<client|front>/<build>.map with its .json meta

const fs = require('fs')
const path = require('path')
const { SourceMap } = require('module')
const config = require('../config')
const { PATTERNS } = require('./autoSchema')

const KINDS = ['client', 'front']
const MAPS_KEPT = 3
const LOADS_PER_MINUTE = 6
const MINUTE_MS = 60 * 1000
const METAS_KEPT = 32
const MISSING_RECHECK_MS = MINUTE_MS

// Both caches are keyed by folder too, so tests can point config.autoSourceMapDir elsewhere
const metas = new Map()
const maps = new Map()
const loads = []

const cacheKey = (kind, build) => `${config.autoSourceMapDir}|${kind}|${build}`
const fileOf = (kind, build, ext) => path.join(config.autoSourceMapDir, kind, `${build}.${ext}`)
const isBuild = (kind, build) => KINDS.includes(kind) && typeof build === 'string' && PATTERNS.build.test(build)

function remember(cache, key, value, max) {
  cache.delete(key)
  cache.set(key, value)
  if (cache.size > max) cache.delete(cache.keys().next().value)
}

// The archived meta of a build, or null when the build is unknown; small enough to read inside a request
function meta(kind, build, now = Date.now()) {
  if (!isBuild(kind, build)) return null
  const key = cacheKey(kind, build)
  const hit = metas.get(key)
  if (hit && (hit.meta || now - hit.at < MISSING_RECHECK_MS)) return hit.meta
  let value = null
  try {
    const saved = JSON.parse(fs.readFileSync(fileOf(kind, build, 'json'), 'utf8'))
    if (saved && saved.build === build && saved.kind === kind) value = saved
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[auto-report] source map meta ${kind}/${build} unreadable:`, err.message)
  }
  remember(metas, key, { meta: value, at: now }, METAS_KEPT)
  return value
}

// Waits while 6 maps have been loaded in the last minute
async function loadSlot() {
  for (;;) {
    const now = Date.now()
    while (loads.length && now - loads[0] >= MINUTE_MS) loads.shift()
    if (loads.length < LOADS_PER_MINUTE) {
      loads.push(now)
      return
    }
    await new Promise(resolve => setTimeout(resolve, MINUTE_MS - (now - loads[0])).unref())
  }
}

const sourcePath = source => source.replace(/^webpack:\/\/[^/]*\//, '').replace(/^\.\//, '').replace(/[?#].*$/, '')

// A position resolves only to a mapping on its own line, so a position past the mapped code stays unresolved
function lookup(map, line, col) {
  const entry = map.findEntry(line - 1, col - 1)
  if (!entry || entry.generatedLine !== line - 1 || typeof entry.originalSource !== 'string') return null
  return { source: sourcePath(entry.originalSource), line: entry.originalLine + 1 }
}

// (line, col) => { source, line } or null, 1-based; null when the map is missing or unreadable
async function resolver(kind, build) {
  if (!isBuild(kind, build)) return null
  const key = cacheKey(kind, build)
  if (maps.has(key)) {
    const cached = maps.get(key)
    remember(maps, key, cached, MAPS_KEPT)
    return cached
  }
  await loadSlot()
  let value = null
  try {
    const map = new SourceMap(JSON.parse(await fs.promises.readFile(fileOf(kind, build, 'map'), 'utf8')))
    value = (line, col) => lookup(map, line, col)
  } catch (err) {
    console.error(`[auto-report] source map ${kind}/${build} not loaded:`, err.code === 'ENOENT' ? 'missing' : err.message)
  }
  remember(maps, key, value, MAPS_KEPT)
  return value
}

// { client } or { front }: the meta and the resolver for an error report's build, {} when the build is unknown
async function forReport(report) {
  const e = report.error
  const build = e && report.build && report.build[e.source]
  const found = e ? meta(e.source, build) : null
  if (!found) return {}
  return { [e.source]: { meta: found, lookup: e.frames.length || e.site ? await resolver(e.source, build) : null } }
}

module.exports = { meta, resolver, forReport }
