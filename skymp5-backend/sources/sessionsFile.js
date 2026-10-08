'use strict'
// master-api's launcher sessions on disk: data/sessions.json, a JSON array of [token, session] pairs, private to the
// backend (0600). Read fail closed and written whole (sources/storeFile.js), like profiles.json and players.json.

const fs   = require('fs')
const path = require('path')
const { readStore, replaceFile, storeError } = require('./storeFile')

const FILE = path.join(__dirname, '..', 'data', 'sessions.json')

// The saved pairs, none when there is no file yet; throws when the file exists but cannot be read, parsed, or is not a list
function read() {
  return readStore(FILE, value => (Array.isArray(value) ? null : 'is not a list of sessions'),
    'It is moved aside when the backend starts') || []
}

// What the backend starts with. sessions.json holds only launcher sign-ins, which a player gets back by signing in
// again, and no profile id is handed out from it. So one that cannot be read does not keep the backend down: it is
// renamed aside (sessions.json.bad-<ms>, still 0600, as sources/atomicFile.js names a corrupt file), every session in
// it is void, and the backend starts with none. Only when even the rename fails does this throw (the startup check
// then exits). profiles.json and players.json still stop the backend: ids and the ban checks' hwid and ip live there.
function load() {
  try { return read() }
  catch (err) {
    if (err.code !== 'ESTOREUNREADABLE') throw err
    const aside = `${FILE}.bad-${Date.now()}`
    try { fs.renameSync(FILE, aside) }
    catch (renameErr) { throw storeError(FILE, `cannot be read and could not be moved aside (${renameErr.code || renameErr.message})`) }
    console.error(`[store] FAIL CLOSED: ${FILE} moved aside to ${aside}; every launcher session in it is void, so players sign in again in the launcher`)
    return []
  }
}

// A new 0600 file replaces the old one, so a token is never written into a file someone else can read (X3). Saved
// several times per game start, so atomic but not fsynced (see storeFile.replaceFile)
function write(entries) {
  replaceFile(FILE, JSON.stringify(entries, null, 2) + '\n', { mode: 0o600 })
}

module.exports = { FILE, read, load, write }
