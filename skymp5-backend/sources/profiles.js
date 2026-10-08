'use strict'
// Discord id -> game profile id. An id is handed out once and never again: the game keeps each profile's characters
// under its id, and id 1 is the owner's. So this store is read fail closed (sources/storeFile.js): a profiles.json that
// exists but cannot be read stops every sign-in until it is repaired, instead of starting over at id 1. Its saves are
// fsynced (durable), so a crash cannot lose a save and hand the same id out again.

const path = require('path')
const { readStore, storeExists, storeError, replaceFile, isPlainObject } = require('./storeFile')

const FILE = path.join(__dirname, '..', 'data', 'profiles.json')
// players.js writes it only after a profile id was given out, so it existing means profiles.json was lost, not a first run
const PLAYERS_FILE = path.join(__dirname, '..', 'data', 'players.json')
// What the FAIL CLOSED line tells the operator. There is no backup of this file on CT 115 (8 Oct 2026)
const RECOVERY = 'Do not delete it, start it empty or put back an older copy as it is: an older nextId hands out ids that ' +
  'already have characters. Rebuild it with the backend stopped: node scripts/rebuild-profiles.js (a dry run; add ' +
  '--from <older copy> for any copy you have, then --write); it keeps every pair in players.json and sets nextId above ' +
  'every profile id in use'

const isProfileId = value => Number.isSafeInteger(value) && value > 0

// null for a store this module writes, else what is wrong with it
function problemOf(data) {
  if (!isPlainObject(data)) return 'is not a profile store'
  if (!isProfileId(data.nextId)) return 'has no valid nextId'
  if (!isPlainObject(data.map)) return 'has no profile map'
  for (const profileId of Object.values(data.map)) {
    if (!isProfileId(profileId)) return 'has a profile id that is not a whole number above 0'
    // nextId is the next id handed out: at or below one in use, it would give a second player that profile
    if (profileId >= data.nextId) return `has nextId ${data.nextId}, not above profile id ${profileId} that is in use`
  }
  return null
}

function load() {
  const data = readStore(FILE, problemOf, RECOVERY)
  if (data) return { nextId: data.nextId, map: data.map }
  if (storeExists(PLAYERS_FILE)) throw storeError(FILE, 'is missing while players.json exists, so this is not a first run', RECOVERY)
  return { nextId: 1, map: {} }
}

function save(data) {
  replaceFile(FILE, JSON.stringify(data, null, 2) + '\n', { durable: true })
}

function getOrCreateProfileId(discordId) {
  const id = String(discordId || '').trim()
  if (!id) throw new Error('discordId is required')

  const data = load()
  if (!data.map[id]) {
    data.map[id] = data.nextId++
    save(data)
  }
  return data.map[id]
}

function getDiscordIdByProfileId(profileId) {
  const id = Number(profileId)
  const entry = Object.entries(load().map).find(([, value]) => value === id)
  return entry ? entry[0] : null
}

function list() {
  return Object.entries(load().map)
    .map(([discordId, profileId]) => ({ discordId, profileId }))
    .sort((a, b) => a.profileId - b.profileId)
}

// nextId is never rewound, so a deleted profile id is not handed to a new player
function deleteByDiscordId(discordId) {
  const id = String(discordId || '').trim()
  const data = load()
  if (!(id in data.map)) return false
  delete data.map[id]
  save(data)
  return true
}

module.exports = {
  FILE,
  problemOf,
  load,
  save,
  list,
  getOrCreateProfileId,
  getDiscordIdByProfileId,
  deleteByDiscordId,
}
