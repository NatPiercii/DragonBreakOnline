'use strict'
// The player stores (profiles.json, players.json, sessions.json) live in skymp5-backend/data next to the code, where a
// live backend keeps its real ones. A test loads those modules with only the named files sent to its own temp folder:
// path.join is redirected while they load, and the load fails unless every named path was picked up.

const path = require('path')

const DATA = path.join(__dirname, '..', '..', 'data')

function loadWithDataIn(dir, names, load) {
  const moved = new Map(names.map(name => [path.join(DATA, name), path.join(dir, name)]))
  const seen = new Set()
  const join = path.join
  path.join = (...parts) => {
    const joined = join(...parts)
    if (!moved.has(joined)) return joined
    seen.add(joined)
    return moved.get(joined)
  }
  let loaded
  try { loaded = load() } finally { path.join = join }
  const missed = [...moved.keys()].filter(file => !seen.has(file))
  if (missed.length) throw new Error(`not sent to ${dir} (loaded before, or the path is built another way): ${missed.join(', ')}`)
  return loaded
}

module.exports = { DATA, loadWithDataIn }
