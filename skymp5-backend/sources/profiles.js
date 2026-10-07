'use strict'
// Discord id -> game profile id. An id is handed out once and never again: the game keeps each profile's characters
// under its id, and id 1 is the owner's. So this store is read fail closed (sources/storeFile.js): a profiles.json that
// exists but cannot be read stops every sign-in until it is repaired, instead of starting over at id 1.

const path = require('path')
const { readStore, storeExists, storeError, replaceFile, isPlainObject } = require('./storeFile')

const FILE = path.join(__dirname, '..', 'data', 'profiles.json')
// players.js writes it only after a profile id was given out, so it existing means profiles.json was lost, not a first run
const PLAYERS_FILE = path.join(__dirname, '..', 'data', 'players.json')

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
  const data = readStore(FILE, problemOf)
  if (data) return { nextId: data.nextId, map: data.map }
  if (storeExists(PLAYERS_FILE)) throw storeError(FILE, 'is missing while players.json exists, so this is not a first run')
  return { nextId: 1, map: {} }
}

function save(data) {
  replaceFile(FILE, JSON.stringify(data, null, 2) + '\n')
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
  load,
  save,
  list,
  getOrCreateProfileId,
  getDiscordIdByProfileId,
  deleteByDiscordId,
}
