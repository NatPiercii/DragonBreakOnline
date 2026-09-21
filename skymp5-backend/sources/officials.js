'use strict'
// Hold and stronghold offices from the game server's zones.json and officials.json, read the way skymp5-server/ts/systems/zones.ts reads them

const path      = require('path')
const config    = require('../config')
const jsonCache = require('./jsonCache')

// Same order as Zones.load
const ZONE_LISTS = ['holds', 'strongholds', 'regions']

// Offices a profile holds as {title, group}: per zone, the first of the zone's ranks that lists the profile (Zones.rankOf)
function officesOf(profileId) {
  const zones     = jsonCache.read(path.join(config.zonesDir, 'zones.json'))
  const officials = jsonCache.read(path.join(config.zonesDir, 'officials.json'))
  if (!zones || typeof zones !== 'object' || !officials || typeof officials !== 'object') return []

  const rankTitles = zones.rankTitles && typeof zones.rankTitles === 'object' ? zones.rankTitles : {}
  const offices    = []
  for (const list of ZONE_LISTS) {
    for (const zone of Array.isArray(zones[list]) ? zones[list] : []) {
      // officials.json keys starting with "_" are comments
      if (!zone || typeof zone.id !== 'string' || zone.id.startsWith('_') || !Object.hasOwn(officials, zone.id)) continue
      const table = officials[zone.id]
      if (!table || typeof table !== 'object') continue
      const ranks = Array.isArray(zone.officials) ? zone.officials.map(String) : []
      const rank  = ranks.find(r => Object.hasOwn(table, r) && Array.isArray(table[r]) && table[r].map(Number).includes(profileId))
      if (!rank) continue
      offices.push({
        title: String((Object.hasOwn(rankTitles, rank) && rankTitles[rank]) || rank),
        group: String(zone.name || zone.id),
      })
    }
  }
  return offices
}

module.exports = { officesOf }
