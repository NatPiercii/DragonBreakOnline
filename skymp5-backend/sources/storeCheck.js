'use strict'
// Startup check, run by server.js before it starts anything: a player store that exists but cannot be read stops the
// backend with exit code 1, so systemd keeps restarting it and the log names the file, instead of serving an empty
// store (7 Oct 2026). server.js keeps itself alive on an uncaught exception, so a plain throw would not stop it.

const profiles     = require('./profiles')
const players      = require('./players')
const sessionsFile = require('./sessionsFile')

function checkStores() {
  profiles.load()
  players.load()
  sessionsFile.read()
}

function checkOrExit() {
  try { checkStores() }
  catch (err) {
    console.error(`[startup] FAIL CLOSED, backend not started: ${err.message}`)
    process.exit(1)
  }
}

module.exports = { checkStores, checkOrExit }
