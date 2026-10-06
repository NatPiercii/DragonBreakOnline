'use strict'
// Self-repair before PLAY and after a failed start (Nate, 2026-10-06: automate support as the player count grows).
// The 6 Oct logo hang was a client that died at start ("Cannot find module 'skyrimPlatform'") on installs whose
// Data\Platform held files the package does not list; Repair Client Files never removes those. So before each launch
// the files that start the client are checked against the server's list, strays in the folders SkyrimPlatform owns are
// moved into "DragonBreak Quarantine" (never deleted), and after a launch skyrim-platform.log is read for a failed start.
// Paths come in as arguments, so the tests run anywhere.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// Folders SkyrimPlatform owns outright: everything in them comes from our package or is written by the client
const OWNED_DIRS = ['Data/Platform/Plugins', 'Data/Platform/UI', 'Data/Platform/Distribution', 'Data/Platform/Modules']
// The client's own writes and the launcher's per-launch files, never stray (paths lower case, forward slashes)
const KEEP_RES = [
  /^data\/platform\/(logs|pluginsnoload|pluginsdev)\//,
  /skymp5-client-settings\.txt$/,
  /\.log$/,
]
// In Data\SKSE\Plugins only the platform's own DLLs (and their ini/pdb companions) are ours to police
const PLATFORM_DLL_RE = /^data\/skse\/plugins\/(skyrimplatform|mpclientplugin)[^/]*$/
// The files that decide whether the client starts at all
const CRITICAL_RES = [
  /^data\/skse\/plugins\/[^/]+\.dll$/,
  /^data\/platform\/distribution\/runtimedependencies\/[^/]+\.dll$/,
  /^data\/platform\/plugins\/skymp5-client\.js$/,
  /^data\/platform\/ui\/build\.js$/,
  /^data\/platform\/ui\/index\.html$/,
]
// Bigger files are checked by size only, so the pre-launch check stays quick (libcef.dll is 190 MB)
const HASH_LIMIT = 32 * 1024 * 1024

const norm = p => String(p).replace(/\\/g, '/').replace(/^\/+/, '')
const lower = p => norm(p).toLowerCase()

function sha256Sync(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

// Every file under dir, as forward-slash paths relative to dir
function listRel(dir) {
  const out = []
  const walk = (d, rel) => {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(d, e.name), r)
      else out.push(r)
    }
  }
  walk(dir, '')
  return out
}

/**
 * The critical client files that are missing or differ from the server's list.
 * files: [{ path, size, sha256 }] from /api/files/version. Returns [{ path, why }].
 */
function checkClient(gamePath, files, { hash = sha256Sync, hashLimit = HASH_LIMIT } = {}) {
  const bad = []
  for (const f of Array.isArray(files) ? files : []) {
    if (!f || typeof f.path !== 'string' || f.path.split('/').includes('..')) continue
    const l = lower(f.path)
    if (!CRITICAL_RES.some(re => re.test(l))) continue
    const full = path.join(gamePath, ...norm(f.path).split('/'))
    let st
    try { st = fs.statSync(full) } catch { bad.push({ path: f.path, why: 'missing' }); continue }
    if (Number.isFinite(f.size) && st.size !== f.size) { bad.push({ path: f.path, why: `size ${st.size}, expected ${f.size}` }); continue }
    if (!f.sha256 || st.size > hashLimit) continue
    let sha = ''
    try { sha = hash(full) } catch { bad.push({ path: f.path, why: 'unreadable' }); continue }
    if (sha.toLowerCase() !== String(f.sha256).toLowerCase()) bad.push({ path: f.path, why: 'sha256' })
  }
  return bad
}

/** Files in the folders we own that the package does not list: forward-slash paths relative to the game folder. */
function strayFiles(gamePath, files) {
  const listed = new Set((Array.isArray(files) ? files : []).filter(f => f && typeof f.path === 'string').map(f => lower(f.path)))
  // Without the server's list nothing can be called stray
  if (listed.size === 0) return []
  const stray = []
  for (const sub of OWNED_DIRS) {
    for (const rel of listRel(path.join(gamePath, ...sub.split('/')))) {
      const p = `${sub}/${rel}`
      const l = p.toLowerCase()
      if (listed.has(l) || KEEP_RES.some(re => re.test(l))) continue
      stray.push(p)
    }
  }
  for (const rel of listRel(path.join(gamePath, 'Data', 'SKSE', 'Plugins'))) {
    if (rel.includes('/')) continue
    const p = `Data/SKSE/Plugins/${rel}`
    const l = p.toLowerCase()
    if (PLATFORM_DLL_RE.test(l) && !listed.has(l) && !KEEP_RES.some(re => re.test(l))) stray.push(p)
  }
  return stray
}

const stampOf = (now) => now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

/**
 * Moves each relative path from root into quarantineRoot/<stamp>/<path>. Returns the paths moved; a file that cannot be
 * moved is left (and logged), never deleted.
 */
function moveAside(root, rels, quarantineRoot, { now = new Date(), log = () => {} } = {}) {
  const moved = []
  if (!rels.length) return moved
  const dest = path.join(quarantineRoot, stampOf(now))
  for (const rel of rels) {
    const from = path.join(root, ...norm(rel).split('/'))
    const to = path.join(dest, ...norm(rel).split('/'))
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true })
      try { fs.renameSync(from, to) } catch { fs.copyFileSync(from, to); fs.rmSync(from, { force: true }) }
      moved.push(rel)
    } catch (err) { log(`could not move ${rel} aside: ${err.message}`) }
  }
  return moved
}

/**
 * Under MO2 a game run that creates a file in Data lands in overwrite\, which outranks the game folder. A copy of the
 * platform's DLLs there would replace ours whatever the game folder holds. Returns the overwrite-relative paths
 * (SKSE/Plugins/<name>) to move aside.
 */
function overwritePlatformDlls(overwriteDir) {
  const out = []
  for (const rel of listRel(path.join(overwriteDir, 'SKSE', 'Plugins'))) {
    if (!rel.includes('/') && PLATFORM_DLL_RE.test(`data/skse/plugins/${rel.toLowerCase()}`)) out.push(`SKSE/Plugins/${rel}`)
  }
  return out
}

// SKSE plugins built on CommonLib find their log folder through Windows' Documents known folder, which fails when the
// registered Documents path is missing (a OneDrive redirect whose folder is gone): SkyPatcher then stops with "Failed to
// find standard logging directory" and other plugins can fail to load. Creating the registered folder and the SKSE log
// folder under it fixes that. registered: the "Personal" value of User Shell Folders, %VARS% unexpanded.
const MYGAMES_BY_EDITION = { Steam: 'Skyrim Special Edition', GOG: 'Skyrim Special Edition GOG', 'Epic Games': 'Skyrim Special Edition EPIC', 'Microsoft Store': 'Skyrim Special Edition MS' }

function expandEnv(p, env) {
  return String(p || '').replace(/%([^%]+)%/g, (all, name) => {
    const key = Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase())
    return key ? env[key] : all
  })
}

/** { docs, created: [paths], error } after making sure Documents and its SKSE log folder exist. */
function ensureSkseLogDir({ docs, registered, env = process.env, edition = 'Steam', mkdir = (p) => fs.mkdirSync(p, { recursive: true }), exists = fs.existsSync }) {
  const created = []
  const make = (p) => { if (exists(p)) return true; try { mkdir(p); created.push(p); return true } catch { return false } }
  let base = docs || null
  const reg = registered ? expandEnv(registered, env) : ''
  if (reg && !/%[^%]+%/.test(reg) && !exists(reg)) {
    if (!make(reg)) return { docs: base, created, error: `the Documents folder Windows points to (${reg}) is missing and could not be created` }
    base = base || reg
  }
  if (!base && reg) base = reg
  if (!base) return { docs: null, created, error: 'Windows could not say where the Documents folder is' }
  const logDir = path.join(base, 'My Games', MYGAMES_BY_EDITION[edition] || MYGAMES_BY_EDITION.Steam, 'SKSE')
  if (!make(logDir)) return { docs: base, created, error: `could not create ${logDir}` }
  return { docs: base, created, error: null }
}

// Where the game and MO2 live (CarloftFhang, 6 Oct: installed under "A:\Program Files (x86)\Games\DragonBreak", every start
// crashed in RaceMenu's BodyGen loader). Windows protects Program Files on the system drive, and a launcher that cannot
// write there cannot keep MO2's profile or the client files current. A folder that cannot be written stops PLAY; one inside
// a Program Files folder anywhere is only a warning, since on another drive it may be writable.
const PROGRAM_FILES_RE = /(^|[\\/])Program Files( \(x86\))?([\\/]|$)/i

function inProgramFiles(dir) { return PROGRAM_FILES_RE.test(String(dir || '')) }

/** True when a file can be created and removed in dir. */
function canWriteDir(dir, { fsx = fs } = {}) {
  const probe = path.join(dir, `.dragonbreak-write-test-${process.pid}-${Date.now()}`)
  try { fsx.writeFileSync(probe, ''); fsx.unlinkSync(probe); return true } catch { return false }
}

/** { unwritable, programFiles }: the { label, dir } entries that exist but cannot be written, and those inside Program Files. */
function installLocationCheck(dirs, { exists = fs.existsSync, canWrite = (d) => canWriteDir(d) } = {}) {
  const present = (dirs || []).filter(d => d && d.dir && exists(d.dir))
  return {
    unwritable: present.filter(d => !canWrite(d.dir)),
    programFiles: present.filter(d => inProgramFiles(d.dir)),
  }
}

// skyrim-platform.log lines that mean the client script never ran: a module the platform should provide could not be
// found, or the bundle could not even be parsed. Runtime errors later in a session are not this, so they are not matched.
const BOOT_FAILURE_RES = [
  { re: /Rethrowing JavaScript error: Error: Cannot find module '([^']+)'/, why: m => `the game could not load the module '${m[1]}'` },
  { re: /Rethrowing JavaScript error: SyntaxError\b/, why: () => 'the client script is damaged' },
]

/** null when the log shows no start failure, else { reason, line }. */
function bootFailure(logText) {
  for (const line of String(logText || '').split(/\r?\n/)) {
    for (const b of BOOT_FAILURE_RES) {
      const m = line.match(b.re)
      if (m) return { reason: b.why(m), line: line.trim().slice(0, 300) }
    }
  }
  return null
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * Reads skyrim-platform.log in each SKSE folder (written fresh by every game start) until it shows a start failure or
 * forMs passes. Only a log written since launchedAt counts. Resolves to { reason, line, file } or null.
 */
async function watchBoot({ logDirs, launchedAt = Date.now(), forMs = 180_000, everyMs = 3000, now = Date.now, wait = sleep, read = f => fs.readFileSync(f, 'utf8'), stat = f => fs.statSync(f) }) {
  for (const started = now(); now() - started < forMs; ) {
    for (const dir of logDirs) {
      const file = path.join(dir, 'skyrim-platform.log')
      let st
      try { st = stat(file) } catch { continue }
      if (st.mtimeMs < launchedAt - 2000) continue
      let text = ''
      try { text = read(file) } catch { continue }
      const fail = bootFailure(text)
      if (fail) return { ...fail, file }
    }
    await wait(everyMs)
  }
  return null
}

module.exports = {
  checkClient, strayFiles, moveAside, overwritePlatformDlls, bootFailure, watchBoot, ensureSkseLogDir, expandEnv,
  inProgramFiles, canWriteDir, installLocationCheck,
  OWNED_DIRS, CRITICAL_RES, HASH_LIMIT,
}
