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

// Keeps both ends of the file, for a log whose startup lines matter as much as its last ones
function ends(file, headBytes, tailBytes) {
  try {
    const size = fs.statSync(file).size
    if (size <= headBytes + tailBytes) return tail(file, headBytes + tailBytes)
    const fd = fs.openSync(file, 'r')
    try {
      const head = Buffer.alloc(headBytes)
      const end  = Buffer.alloc(tailBytes)
      fs.readSync(fd, head, 0, headBytes, 0)
      fs.readSync(fd, end, 0, tailBytes, size - tailBytes)
      return head.toString('utf8').replace(/[^\n]*$/, '') + '[middle lines cut]\n' + end.toString('utf8').replace(/^[^\n]*\n/, '')
    } finally { fs.closeSync(fd) }
  } catch { return null }
}

// SkyrimPlatform logs the first 120 characters of every script it runs in the game's UI and every page it
// loads (`[12:34:56:789] JS ...`, `LoadUrl ...`): chat and private messages, the character's name, the voice
// room link. None of it explains a crash, and a report must not carry what players said to each other.
const RECORD = /^\[\d\d:\d\d:\d\d:\d{3}\] /
const UI_LINE = /^\[\d\d:\d\d:\d\d:\d{3}\] (?:JS|LoadUrl) /

function dropUiLines(text) {
  const kept = []
  let dropped = 0
  let inUi = false
  for (const line of text.split('\n')) {
    if (UI_LINE.test(line)) { dropped++; inUi = true; continue }
    // LoadUrl logs the whole URL, newlines included: every line up to the next record belongs to it
    if (inUi && !RECORD.test(line)) { if (line.trim()) dropped++; continue }
    inUi = false
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

// The start of text up to bytes, cut at a line end
function startOf(text, bytes) {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= bytes) return text
  return buf.subarray(0, bytes).toString('utf8').replace(/[^\n]*$/, '')
}

// The end of text from bytes before its end, cut at a line start
function endOf(text, bytes) {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= bytes) return text
  return buf.subarray(buf.length - bytes).toString('utf8').replace(/^[^\n]*\n/, '')
}

// SkyrimPlatform's log with its UI lines left out and both ends kept: the session's start (the one-time
// diagnostics: front files, how the game reads the mouse, the menu cursor's first state) and its last lines
// (the failure). Each end is read readFactor times further than it keeps, so UI lines cannot crowd it out.
function gameLogEnds(file, headBytes, tailBytes, readFactor = 6) {
  try {
    const size = fs.statSync(file).size
    let head
    let rest
    if (size <= (headBytes + tailBytes) * readFactor) {
      const text = dropUiLines(fs.readFileSync(file, 'utf8'))
      if (Buffer.byteLength(text, 'utf8') <= headBytes + tailBytes) return text
      head = startOf(text, headBytes)
      rest = endOf(text, tailBytes)
    } else {
      const fd = fs.openSync(file, 'r')
      try {
        const start = Buffer.alloc(headBytes * readFactor)
        const end = Buffer.alloc(tailBytes * readFactor)
        fs.readSync(fd, start, 0, start.length, 0)
        fs.readSync(fd, end, 0, end.length, size - end.length)
        head = startOf(dropUiLines(start.toString('utf8').replace(/[^\n]*$/, '')), headBytes)
        rest = endOf(dropUiLines(end.toString('utf8').replace(/^[^\n]*\n/, '')), tailBytes)
      } finally { fs.closeSync(fd) }
    }
    return head + '[middle lines cut]\n' + rest
  } catch { return null }
}

// Crash Logger writes crash-<date>.log into an SKSE folder when the game dies: Documents\My Games\<edition>\SKSE, or
// MO2's overwrite\SKSE when the write is caught there. Report a Problem is the player's own send, so the newest one of the
// last day goes with it (a day, not "since the last launch": a player who relaunched after the crash reports it after),
// cut to what names the crash: the head and the exception, the first lines of the call stack, registers, stack and
// module list, and the SKSE plugins. The rest of each section is counted, not sent; the plugin list is the load order,
// which staff already have. crashWatch's automatic note still sends only that a log exists, never the log.
const CRASH_LOG_MAX_AGE_MS = 24 * 60 * 60 * 1000
const CRASH_LOG_BYTES = 48 * 1024
const CRASH_HEAD_LINES = 60
const CRASH_SECTION_LINES = { 'PROBABLE CALL STACK': 60, REGISTERS: 25, STACK: 30, MODULES: 80, 'SKSE PLUGINS': 80, PLUGINS: 0 }
const CRASH_SECTION_DEFAULT = 30
const CRASH_SECTION = /^([A-Z][A-Z0-9 ]*[A-Z0-9]):\s*$/

function newestCrashLog(dirs, now = Date.now()) {
  let best = null
  for (const dir of dirs) {
    let names = []
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const name of names) {
      if (!/^crash-.*\.log$/i.test(name)) continue
      try {
        const file = path.join(dir, name)
        const st = fs.statSync(file)
        if (!st.isFile() || now - st.mtimeMs > CRASH_LOG_MAX_AGE_MS) continue
        if (!best || st.mtimeMs > best.mtimeMs) best = { file, name, mtimeMs: st.mtimeMs, size: st.size }
      } catch { /* gone */ }
    }
  }
  return best
}

function condenseCrashLog(text) {
  const out = []
  let limit = CRASH_HEAD_LINES
  let kept = 0
  let cut = 0
  const flush = () => { if (cut) out.push(`\t[${cut} more line(s) cut]`); cut = 0 }
  for (const line of String(text).split(/\r?\n/)) {
    const section = CRASH_SECTION.exec(line.trim())
    if (section) {
      flush()
      limit = section[1] in CRASH_SECTION_LINES ? CRASH_SECTION_LINES[section[1]] : CRASH_SECTION_DEFAULT
      kept = 0
      out.push(line)
      continue
    }
    if (kept < limit) { out.push(line); kept++ } else if (line.trim()) cut++
  }
  flush()
  const joined = out.join('\n')
  return Buffer.byteLength(joined, 'utf8') > CRASH_LOG_BYTES ? startOf(joined, CRASH_LOG_BYTES) + '[rest cut]' : joined
}

// "Model x N cores", or '' when Node cannot read it. No paths, so nothing to redact.
function cpuSummary() {
  try {
    const c = os.cpus()
    if (!c || !c.length) return ''
    return `${String(c[0].model || '').trim()} x ${c.length} cores`
  } catch {
    return ''
  }
}

// The newest crash log of the last day, condensed, with a first line saying which file and how old; null when none
function crashLogFor(dirs, now = Date.now()) {
  const found = newestCrashLog(dirs, now)
  if (!found) return null
  let text
  try { text = fs.readFileSync(found.file, 'utf8') } catch { return null }
  const minutes = Math.max(0, Math.round((now - found.mtimeMs) / 60000))
  const where = /[\\/]overwrite[\\/]/i.test(found.file) ? 'MO2 overwrite' : 'Documents'
  return `[${found.name}, ${Math.round(found.size / 1024)} KB, written ${minutes} min before this report, from ${where}]\n`
    + condenseCrashLog(text)
}

// SKSE, SkyrimPlatform and Community Shaders write here; present only after the game has been launched at least once.
// documentsDir comes from Electron because a OneDrive-moved Documents folder is not under the home folder.
const GAME_LOGS = [['skyrim-platform.log', 'gameLog'], ['skse64.log', 'skseLog'], ['CommunityShaders.log', 'csLog']]
const GAME_LOG_BYTES = 80 * 1024
// Community Shaders logs the settings overrides it applied at startup and its shader compiles as they run,
// so both ends of its log are kept: [head, tail] bytes
const BOTH_ENDS = { csLog: [32 * 1024, 32 * 1024] }
// SkyrimPlatform's one-time diagnostics sit at the start of its log and the failure at the end: [head, tail] bytes
const GAME_LOG_ENDS = [16 * 1024, 64 * 1024]

function gameLogCandidates(documentsDir, variants) {
  const out = []
  for (const [name, field] of GAME_LOGS) {
    for (const variant of variants) out.push({ file: path.join(documentsDir, 'My Games', variant, 'SKSE', name), field })
  }
  return out
}

// The client's own diagnostics (the page/input one, the remote Vampire Lord animations) go through SkyrimPlatform's
// writeLogs, because logTrace reaches only the in-game console, never skyrim-platform.log. writeLogs writes
// Data\Platform\Logs\dbo-diag-logs.txt in the folder the game runs from, starting afresh every launch. Under MO2 a new
// file lands in the overwrite folder instead, which stands for Data, so there it is overwrite\Platform\Logs.
const DIAG_LOG_REL = path.join('Platform', 'Logs', 'dbo-diag-logs.txt')
// The end of it, where a crash cuts it off. It goes into clientLog, which the backend caps at 180 KB from the end
// (the install listing and the game data follow it there), and on the backend's fixed field list, so no backend change.
const DIAG_LOG_BYTES = 48 * 1024

function diagLogCandidates(gameDirs, mo2Root) {
  const out = []
  for (const dir of gameDirs) if (dir) out.push(path.join(dir, 'Data', DIAG_LOG_REL))
  if (mo2Root) out.push(path.join(mo2Root, 'overwrite', DIAG_LOG_REL))
  return [...new Set(out)]
}

// The newest copy is this session's: a copy beside the game outlives a switch to MO2, and the other way round
function diagFiles(gameDirs, mo2Root) {
  const found = []
  for (const file of diagLogCandidates(gameDirs, mo2Root)) {
    try { found.push({ file, mtime: fs.statSync(file).mtimeMs }) } catch { /* not there */ }
  }
  return found.sort((a, b) => b.mtime - a.mtime)
}

function diagLog(gameDirs, mo2Root, now) {
  const found = diagFiles(gameDirs, mo2Root)
  if (!found.length) return null
  const text = tail(found[0].file, DIAG_LOG_BYTES)
  if (!text) return null
  const minutes = Math.max(0, Math.round((now - found[0].mtime) / 60000))
  return `== client diagnostics (${found[0].file}, written ${minutes} min before this report${found.length > 1 ? `, newest of ${found.length}` : ''}) ==\n`
    + text.replace(/\s+$/, '')
}

// The client's diag log starts afresh at every launch, so the trail of a crashed session (the NPC calls the client
// made just before it) is gone once the player plays again. crashWatch keeps a copy of it at the crash; a report sent
// after a relaunch carries that copy as well.
const CRASH_DIAG_DIR = 'crash-diag'
const CRASH_DIAG_KEEP = 5
const CRASH_DIAG_MAX_AGE_MS = 24 * 3600 * 1000
const CRASH_DIAG_BYTES = 24 * 1024

function saveCrashDiag({ userDataDir, gameDirs = [], mo2Root = null, endedAt = Date.now() }) {
  const found = diagFiles(gameDirs, mo2Root)
  if (!found.length) return null
  const dir = path.join(userDataDir, CRASH_DIAG_DIR)
  try {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `dbo-diag-${Math.round(endedAt)}.txt`)
    fs.copyFileSync(found[0].file, file)
    const kept = fs.readdirSync(dir).filter(n => /^dbo-diag-\d+\.txt$/.test(n)).sort((a, b) => Number(b.slice(9, -4)) - Number(a.slice(9, -4)))
    for (const old of kept.slice(CRASH_DIAG_KEEP)) { try { fs.unlinkSync(path.join(dir, old)) } catch { /* in use */ } }
    return file
  } catch { return null }
}

// The newest saved copy of the last day, when the live log has been written since the crash (a relaunch); else null
function crashDiagLog(userDataDir, liveMtime, now) {
  const dir = path.join(userDataDir || '', CRASH_DIAG_DIR)
  let names = []
  try { names = fs.readdirSync(dir).filter(n => /^dbo-diag-\d+\.txt$/.test(n)) } catch { return null }
  const at = names.map(n => Number(n.slice(9, -4))).filter(t => now - t <= CRASH_DIAG_MAX_AGE_MS).sort((a, b) => b - a)[0]
  if (!at || !(liveMtime > at)) return null
  const text = tail(path.join(dir, `dbo-diag-${at}.txt`), CRASH_DIAG_BYTES)
  if (!text) return null
  return `== client diagnostics of the crashed session (saved at the crash, ${Math.max(0, Math.round((now - at) / 60000))} min before this report) ==\n`
    + text.replace(/\s+$/, '')
}

// context: whatever the launcher already knows (versions, install dir, the step that failed)
// gameDirs: the folders the game may have run from (the isolated copy first); installDir is tried after them
function collect({ userDataDir, installDir, documentsDir, myGamesVariants = ['Skyrim Special Edition'], mo2Root = null,
  gameDirs = [], context = {}, now = Date.now() }) {
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
    if (BOTH_ENDS[field]) {
      const text = ends(file, ...BOTH_ENDS[field])
      if (text) files[field] = redact(dropUiLines(text))
      continue
    }
    if (field === 'gameLog') {
      const text = gameLogEnds(file, ...GAME_LOG_ENDS)
      if (text) files[field] = redact(text)
      continue
    }
    // UI lines can be most of a session's log, so read further back and keep the end of what is left
    const text = tail(file, 6 * GAME_LOG_BYTES)
    if (text) files[field] = redact(keepEnd(dropUiLines(text), GAME_LOG_BYTES))
  }

  const docsBase = documentsDir || path.join(os.homedir(), 'Documents')
  const crashDirs = myGamesVariants.map(v => path.join(docsBase, 'My Games', v, 'SKSE'))
  if (mo2Root) crashDirs.push(path.join(mo2Root, 'overwrite', 'SKSE'))
  const crash = crashLogFor(crashDirs, now)
  if (crash) files.crashLog = redact(crash)

  const diag = diagLog([...gameDirs, installDir], mo2Root, now)
  if (diag) files.clientLog = redact(diag)
  const live = diagFiles([...gameDirs, installDir], mo2Root)[0]
  const saved = crashDiagLog(userDataDir, live ? live.mtime : Infinity, now)
  if (saved) files.clientLog = (files.clientLog ? files.clientLog + '\n\n' : '') + redact(saved)

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
    // Hardware, so a crash class can be read against the machine it happened on. These three need no extra process,
    // so they cannot fail or delay the report; the GPU and the free space come from main.js, which can shell out.
    ramGb: Math.round(os.totalmem() / 1024 / 1024 / 1024),
    ramFreeGb: Math.round(os.freemem() / 1024 / 1024 / 1024),
    cpu: cpuSummary(),
    freeSpaceGb: undefined,
    ...context,
  }
}

module.exports = { collect, redact, tail, ends, dropUiLines, gameLogEnds, condenseCrashLog, newestCrashLog, cpuSummary, saveCrashDiag }
