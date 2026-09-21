'use strict'
// Race and place names from the name-table.json the game server writes (skymp5-server/ts/systems/nameTable.ts)

const config    = require('../config')
const jsonCache = require('./jsonCache')

// The current table, or null when the game server has not written one yet
function load() {
  const table = jsonCache.read(config.nameTablePath)
  if (!table || table.v !== 1) return null
  if (!table.races || typeof table.races !== 'object' || !table.places || typeof table.places !== 'object') return null
  return table
}

// Same rule as normDesc in skymp5-server/ts/systems/zones.ts, which keys the table's places
function normDesc(desc) {
  const s = String(desc || '')
  const i = s.indexOf(':')
  if (i < 0) return s.toLowerCase()
  const id = parseInt(s.slice(0, i), 16)
  return (Number.isFinite(id) ? id.toString(16) : s.slice(0, i).toLowerCase()) + ':' + s.slice(i + 1).toLowerCase()
}

// raceId is appearanceDump's global form id; the table keys races by that id in decimal
function raceOf(table, raceId) {
  if (!table || !Number.isInteger(raceId) || raceId <= 0) return null
  const race = Object.hasOwn(table.races, String(raceId)) ? table.races[String(raceId)] : null
  return race && typeof race.label === 'string' && race.label ? { label: race.label } : null
}

// A worldspace or cell by its desc: the display name when the plugin has one, else the editor id, flagged as such
function placeOf(table, desc) {
  if (!table || typeof desc !== 'string' || !desc) return null
  const key   = normDesc(desc)
  const place = Object.hasOwn(table.places, key) ? table.places[key] : null
  if (!place || typeof place.edid !== 'string' || !place.edid) return null
  if (typeof place.full === 'string' && place.full) return { label: place.full, editorId: false }
  return { label: place.edid, editorId: true }
}

module.exports = { load, raceOf, placeOf }
