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

// SKSE and SkyrimPlatform write here; present only after the game has been launched at least once.
// documentsDir comes from Electron because a OneDrive-moved Documents folder is not under the home folder.
const GAME_LOGS = [['skyrim-platform.log', 'gameLog'], ['skse64.log', 'skseLog']]

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

  // A player with more than one edition installed has a log per edition; the most recently written one is this session's
  const newest = {}
  for (const { file, field } of gameLogCandidates(documentsDir || path.join(os.homedir(), 'Documents'), myGamesVariants)) {
    let mtime
    try { mtime = fs.statSync(file).mtimeMs } catch { continue }
    if (!newest[field] || mtime > newest[field].mtime) newest[field] = { file, mtime }
  }
  for (const [field, { file }] of Object.entries(newest)) {
    const text = tail(file, 80 * 1024)
    if (text) files[field] = redact(text)
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

module.exports = { collect, redact, tail }
