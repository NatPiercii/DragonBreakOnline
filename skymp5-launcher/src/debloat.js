'use strict'
// Disk use: Vortex's archives used where they are, our downloads cleared after a launch, crash files capped, stale parts pruned

const fs = require('fs')
const path = require('path')

const ARCHIVE_RE = /\.(7z|zip|rar)$/i
const CRASH_RE = /^crash-.*\.log$|\.dmp$/i
const PART_RE = /\.part$/i
const CRASH_KEEP = 10
const CRASH_MAX_BYTES = 200 * 1024 * 1024
const PART_MAX_AGE_MS = 24 * 60 * 60 * 1000
// Vortex writes this file into the root of its download folder (downloadDirectory.ts)
const VORTEX_TAG = '__vortex_downloads_folder'
const VORTEX_STATE_MAX_BYTES = 64 * 1024 * 1024

const norm = p => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase()
const within = (p, dir) => { const a = norm(p), b = norm(dir); return a === b || a.startsWith(b + path.sep) }
// True when dir is, holds or sits inside a folder we must never delete from (Vortex's, the player's Downloads)
const isProtected = (dir, protect) => protect.some(p => p && (within(dir, p) || within(p, dir)))

function filesIn(dir, re) {
  let names
  try { names = fs.readdirSync(dir) } catch { return [] }
  const out = []
  for (const name of names) {
    if (!re.test(name)) continue
    const full = path.join(dir, name)
    try {
      const st = fs.statSync(full)
      if (st.isFile()) out.push({ name, full, size: st.size, mtimeMs: st.mtimeMs, nlink: st.nlink })
    } catch { /* gone or locked */ }
  }
  return out
}

const remove = full => { try { fs.rmSync(full, { force: true }); return true } catch { return false } }

// JSON path strings in Vortex's state.v2 (LevelDB; the download pattern is stored at settings###downloads###path)
function vortexPathCandidates(buf) {
  const text = buf.toString('latin1')
  const re = /"((?:[A-Za-z]:|\{[A-Za-z]+\})(?:(?:\\\\|\/)[^"\\/\x00-\x1f]+)+)(?:\\\\|\/)?"/g
  const out = new Set()
  for (let m; (m = re.exec(text));) {
    try { out.add(JSON.parse(Buffer.from(`"${m[1]}"`, 'latin1').toString('utf8'))) } catch { /* not a JSON string */ }
  }
  return [...out]
}

function readVortexState(stateDir) {
  const files = filesIn(stateDir, /\.(log|ldb)$/i).sort((a, b) => b.mtimeMs - a.mtimeMs)
  const out = new Set()
  let read = 0
  for (const f of files) {
    if (read + f.size > VORTEX_STATE_MAX_BYTES) break
    read += f.size
    try { for (const c of vortexPathCandidates(fs.readFileSync(f.full))) out.add(c) } catch { /* locked */ }
  }
  return [...out]
}

// Vortex's getDownloadPath: {USERDATA} and {USERNAME} filled in, relative patterns resolved against its user data
function resolveVortexPattern(pattern, userData, username) {
  const filled = String(pattern).replace(/\{userdata\}/ig, userData).replace(/\{username\}/ig, username || '')
  return path.isAbsolute(filled) ? filled : path.resolve(userData, filled)
}

// Vortex's download folders for a game: the default one, and any moved one its settings name that carries Vortex's tag
function vortexDownloadDirs({ userDataDirs, username = '', gameId = 'skyrimse', readState = readVortexState }) {
  const out = []
  const add = dir => { if (!out.some(d => norm(d) === norm(dir)) && fs.existsSync(dir)) out.push(dir) }
  for (const userData of userDataDirs.filter(Boolean)) {
    if (!fs.existsSync(userData)) continue
    let patterns = []
    try { patterns = readState(path.join(userData, 'state.v2')) } catch { /* unreadable: default only */ }
    for (const p of patterns) {
      const base = resolveVortexPattern(p, userData, username)
      if (fs.existsSync(path.join(base, VORTEX_TAG))) add(path.join(base, gameId))
    }
    add(path.join(userData, 'downloads', gameId))
  }
  return out
}

// Archives (and .meta files) in our downloads folder; one hard-linked from Vortex only loses our name for it
function clearDownloads(dir, protect = []) {
  if (isProtected(dir, protect)) return { removed: 0, bytes: 0, refused: true }
  let removed = 0, bytes = 0
  for (const a of filesIn(dir, ARCHIVE_RE)) {
    if (!remove(a.full)) continue
    removed++
    if (a.nlink <= 1) bytes += a.size
    remove(`${a.full}.meta`)
  }
  return { removed, bytes, refused: false }
}

// Our copies of archives another folder (Vortex's) already holds under the same name and size
function clearDuplicates(dir, otherDirs = [], protect = []) {
  if (isProtected(dir, protect)) return { removed: 0, bytes: 0, refused: true }
  const others = new Map()
  for (const d of otherDirs.filter(d => d && norm(d) !== norm(dir))) {
    for (const a of filesIn(d, ARCHIVE_RE)) others.set(`${a.name.toLowerCase()}\0${a.size}`, a.full)
  }
  let removed = 0, bytes = 0
  for (const a of filesIn(dir, ARCHIVE_RE)) {
    if (!others.has(`${a.name.toLowerCase()}\0${a.size}`) || !remove(a.full)) continue
    removed++
    if (a.nlink <= 1) bytes += a.size
    remove(`${a.full}.meta`)
  }
  return { removed, bytes, refused: false }
}

// Crash logs and dumps across the folders: the newest kept while under both caps, the newest one always
function capCrashFiles(dirs, { keep = CRASH_KEEP, maxBytes = CRASH_MAX_BYTES, protect = [] } = {}) {
  const all = dirs.filter(d => d && !isProtected(d, protect)).flatMap(d => filesIn(d, CRASH_RE))
  all.sort((a, b) => b.mtimeMs - a.mtimeMs)
  let kept = 0, total = 0, full = false, removed = 0
  for (const f of all) {
    if (!full && (kept === 0 || (kept < keep && total + f.size <= maxBytes))) { kept++; total += f.size; continue }
    full = true
    if (remove(f.full)) removed++
  }
  return { kept, removed }
}

// Partial downloads (*.part, or those nameRe matches) untouched for a day
function pruneStaleParts(dir, { now = Date.now(), maxAgeMs = PART_MAX_AGE_MS, nameRe = PART_RE, protect = [] } = {}) {
  if (isProtected(dir, protect)) return 0
  let removed = 0
  for (const f of filesIn(dir, nameRe)) if (now - f.mtimeMs > maxAgeMs && remove(f.full)) removed++
  return removed
}

// Client zips of earlier packages left in the temp folder
function pruneClientZips(dir, keep = '') {
  let removed = 0
  for (const f of filesIn(dir, /^alduinak-client.*\.zip$/i)) if (f.name !== path.basename(keep) && remove(f.full)) removed++
  return removed
}

module.exports = {
  vortexPathCandidates, readVortexState, resolveVortexPattern, vortexDownloadDirs,
  clearDownloads, clearDuplicates, capCrashFiles, pruneStaleParts, pruneClientZips, isProtected,
  VORTEX_TAG, CRASH_KEEP, CRASH_MAX_BYTES, PART_MAX_AGE_MS,
}
