'use strict'
// JSON files another process writes, parsed again only when the file changes

const fs = require('fs')

// file -> { stamp, data }
const cache = new Map()

// The parsed file, or null when it is missing or not valid JSON
function read(file) {
  let stat
  try { stat = fs.statSync(file) } catch { cache.delete(file); return null }
  const stamp = `${stat.mtimeMs}:${stat.size}`
  const hit   = cache.get(file)
  if (hit && hit.stamp === stamp) return hit.data

  let data = null
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) }
  catch (err) { console.warn(`[jsonCache] ${file} unreadable:`, err.message) }
  cache.set(file, { stamp, data })
  return data
}

module.exports = { read }
