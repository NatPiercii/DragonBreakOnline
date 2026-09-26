'use strict'
// Collects what staff need to diagnose a failed install or launch and sends it to the backend, which
// files it as a thread in the error-report forum under the player's Discord name.
// Redacts here as well as on the server: a log should not leave the machine carrying a live key.

const fs   = require('fs')
const os   = require('os')
const path = require('path')

const PER_FILE_BYTES = 160 * 1024   // the proxy caps the whole request at 2 MB
const REDACTIONS = [
  [/([A-Za-z]:[\\/]Users[\\/])[^\\/\r\n"'<>|]+/gi, '$1<user>'],
  [/((?:key|nmm_key)=)[A-Za-z0-9._~-]{6,}/gi, '$1<redacted>'],
  [/((?:expires|user_id)=)\d+/gi, '$1<redacted>'],
  [/(Bearer\s+)[A-Za-z0-9._-]{10,}/gi, '$1<redacted>'],
  [/((?:session|token|secret|password|api[_-]?key|auth)["'\s:=]{1,4})[A-Za-z0-9._-]{10,}/gi, '$1<redacted>'],
  [/\b([0-9a-f]{8})[0-9a-f]{24,120}\b/gi, '$1<redacted>'],
]

function redact(text) {
  let out = String(text || '')
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement)
  return out
}

// Keeps the end of the file: the failure is at the bottom
function tail(file, bytes = PER_FILE_BYTES) {
  try {
    const stat = fs.statSync(file)
    const fd = fs.openSync(file, 'r')
    const length = Math.min(stat.size, bytes)
    const buf = Buffer.alloc(length)
    fs.readSync(fd, buf, 0, length, Math.max(0, stat.size - length))
    fs.closeSync(fd)
    const text = buf.toString('utf8')
    return stat.size > length ? '[earlier lines cut]\n' + text.replace(/^[^\n]*\n/, '') : text
  } catch { return null }
}

// SkyrimPlatform logs the first 120 characters of every script it runs in the game's UI and every page it
// loads (`[12:34:56:789] JS ...`, `LoadUrl ...`): chat and private messages, the character's name, the voice
// room link. None of it explains a crash, and a report must not carry what players said to each other.
const UI_LINE = /^\[\d\d:\d\d:\d\d:\d{3}\] (?:JS|LoadUrl) /

function dropUiLines(text) {
  const kept = []
  let dropped = 0
  for (const line of text.split('\n')) {
    if (UI_LINE.test(line)) { dropped++; continue }
    if (dropped) { kept.push(`[${dropped} UI line(s) left out]`); dropped = 0 }
    kept.push(line)
  }
  if (dropped) kept.push(`[${dropped} UI line(s) left out]`)
  return kept.join('\n')
}

function keepEnd(text, bytes) {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= bytes) return text
  return '[earlier lines cut]\n' + buf.subarray(buf.length - bytes).toString('utf8').replace(/^[^\n]*\n/, '')
}

// SKSE and SkyrimPlatform write here; present only after the game has been launched at least once.
// documentsDir comes from Electron because a OneDrive-moved Documents folder is not under the home folder.
const GAME_LOGS = [['skyrim-platform.log', 'gameLog'], ['skse64.log', 'skseLog']]
const GAME_LOG_BYTES = 80 * 1024

function gameLogCandidates(documentsDir, variants) {
  const out = []
  for (const [name, field] of GAME_LOGS) {
    for (const variant of variants) out.push({ file: path.join(documentsDir, 'My Games', variant, 'SKSE', name), field })
  }
  return out
}

// context: whatever the launcher already knows (versions, install dir, the step that failed)
function collect({ userDataDir, installDir, documentsDir, myGamesVariants = ['Skyrim Special Edition'], context = {} }) {
  const files = {}
  const launcher = tail(path.join(userDataDir, 'install.log'))
  if (launcher) files.launcherLog = redact(launcher)

  // A player with more than one edition installed has a log per edition; the most recently written readable one is this session's
  const found = []
  for (const { file, field } of gameLogCandidates(documentsDir || path.join(os.homedir(), 'Documents'), myGamesVariants)) {
    try { found.push({ file, field, mtime: fs.statSync(file).mtimeMs }) } catch { /* not there */ }
  }
  found.sort((a, b) => b.mtime - a.mtime)
  for (const { file, field } of found) {
    if (files[field]) continue
    // UI lines can be most of a session's log, so read further back and keep the end of what is left
    const text = tail(file, 6 * GAME_LOG_BYTES)
    if (text) files[field] = redact(keepEnd(dropUiLines(text), GAME_LOG_BYTES))
  }

  if (installDir) {
    // A directory listing is often the whole answer: a foreign modlist or a missing Data folder shows up here
    try {
      const entries = fs.readdirSync(installDir, { withFileTypes: true })
        .slice(0, 60).map(e => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n')
      files.clientLog = (files.clientLog ? files.clientLog + '\n\n' : '')
        + `== install directory ==\n${redact(installDir)}\n${redact(entries)}`
    } catch { /* unreadable directory is itself reported by the step that failed */ }
  }

  return {
    ...files,
    os: `${os.platform()} ${os.release()}`,
    freeSpaceGb: undefined,
    ...context,
  }
}

module.exports = { collect, redact, tail, dropUiLines }
