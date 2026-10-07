'use strict'
// master-api's launcher sessions on disk: data/sessions.json, a JSON array of [token, session] pairs, private to the
// backend (0600). Read fail closed and written whole (sources/storeFile.js), like profiles.json and players.json.

const path = require('path')
const { readStore, replaceFile } = require('./storeFile')

const FILE = path.join(__dirname, '..', 'data', 'sessions.json')

// The saved pairs, none when there is no file yet; throws when the file exists but cannot be read, parsed, or is not a list
function read() {
  return readStore(FILE, value => (Array.isArray(value) ? null : 'is not a list of sessions')) || []
}

// A new 0600 file replaces the old one, so a token is never written into a file someone else can read (X3)
function write(entries) {
  replaceFile(FILE, JSON.stringify(entries, null, 2) + '\n', { mode: 0o600 })
}

module.exports = { FILE, read, write }
