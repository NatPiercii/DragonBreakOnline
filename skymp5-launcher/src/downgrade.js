'use strict'
/**
 * Downgrading a Steam Skyrim SE to 1.6.1170 from the launcher (docs/DOWNGRADE_1_6_1170.md).
 *
 * The owner's method (Jake's SkyrimSteamDowngrader.ps1, 2026-09-29) in Node: the player downloads the three 1.6.1170
 * depots with Steam's own download_depot, signed in to their own account; the launcher finds them under
 * steamapps\content, checks them, moves every file it replaces into a backup and copies the depot files over the game
 * folder. It never handles Steam credentials and ships no game file, only the sizes and hashes in
 * downgrade-1.6.1170.json.
 *
 * Everything here is fs work on the paths it is given, so the tests run it on temporary folders; main.js supplies the
 * registry, process, dialog and shell parts.
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const gameversion = require('./gameversion')
const REF = require('./downgrade-1.6.1170.json')

const APP_ID = REF.app
const TARGET = REF.exeVersion.split('.').slice(0, 3).join('.')
const EXE_DEPOT = '489833'
const BACKUP_DIR = '_DragonBreakDowngrade'
const RECORD = 'backup.json'
// A depot counts as downloaded once nothing in its folder has changed for this long
const STABLE_MS = 20000
// A depot still short of a file after this long with nothing arriving has stopped downloading
const STALLED_MS = 120000
const SKSE_RUNTIME_DLL = 'skse64_1_6_1170.dll'
const ADDRESS_LIBRARY_BIN = 'versionlib-1-6-1170-0.bin'

// Reference entries by lower-case game-relative path with forward slashes
const REF_FILES = new Map(Object.entries(REF.files).map(([p, v]) => [p.toLowerCase(), { path: p, ...v }]))
const refKey = rel => rel.split(path.sep).join('/').toLowerCase()
const isTarget = v => !!v && (v === REF.exeVersion || v.startsWith(`${TARGET}.`))

const DEPOTS = REF.depots.map(d => ({ ...d, command: `download_depot ${APP_ID} ${d.id} ${d.manifest}` }))

/**
 * The language depot Steam lays over the base depots for a non-English install (French 489834 ... Japanese 544861,
 * downgrade-1.6.1170.json languageDepots), or null for English or an unknown language. command is null while its
 * 1.6.1170 manifest id is not known: then it is searched for on disk (the verified copy checks every file by hash)
 * but not offered in the panel, and the in-place downgrade does not use it.
 */
function languageDepot(language) {
  const lang = String(language || 'english').toLowerCase()
  const d = (REF.languageDepots || {})[lang]
  if (!d) return null
  return {
    id: d.id, manifest: d.manifest || null, language: lang, holds: `the ${lang} language files`,
    command: d.manifest ? `download_depot ${APP_ID} ${d.id} ${d.manifest}` : null,
  }
}

// "path" entries of Steam's libraryfolders.vdf
function parseLibraryFolders(text) {
  const out = []
  for (const m of String(text).matchAll(/^\s*"path"\s+"(.+)"\s*$/gm)) out.push(m[1].replace(/\\\\/g, '\\'))
  return out
}

// <library> for a game folder at <library>\steamapps\common\<name>; null for a folder Steam does not manage
function steamLibraryOf(gameDir) {
  if (!gameDir) return null
  const common = path.dirname(path.resolve(gameDir))
  const steamapps = path.dirname(common)
  if (path.basename(common).toLowerCase() !== 'common' || path.basename(steamapps).toLowerCase() !== 'steamapps') return null
  return path.dirname(steamapps)
}

function acfPathFor(gameDir) {
  const lib = steamLibraryOf(gameDir)
  return lib ? path.join(lib, 'steamapps', `appmanifest_${APP_ID}.acf`) : null
}

// Every folder a download_depot result can sit under: the Steam client roots, their libraries and the game's own library
function steamRoots({ clientRoots = [], gameDir = null } = {}) {
  const roots = []
  for (const r of clientRoots.filter(Boolean)) {
    roots.push(path.resolve(r))
    try {
      for (const lib of parseLibraryFolders(fs.readFileSync(path.join(r, 'steamapps', 'libraryfolders.vdf'), 'utf8'))) {
        roots.push(path.resolve(lib))
      }
    } catch { /* no library list */ }
  }
  const own = steamLibraryOf(gameDir)
  if (own) roots.push(own)
  const seen = new Set()
  return roots.filter(r => !seen.has(r.toLowerCase()) && seen.add(r.toLowerCase()))
}

const isDir = p => { try { return fs.statSync(p).isDirectory() } catch { return false } }

// The four layouts Jake's Resolve-DepotPath accepts, below a steamapps\content folder
function resolveDepot(contentDir, depotId) {
  for (const rel of [path.join(`app_${APP_ID}`, `depot_${depotId}`), path.join(APP_ID, depotId), `depot_${depotId}`, depotId]) {
    const dir = path.join(contentDir, rel)
    if (isDir(dir)) return dir
  }
  return null
}

// Each depot with its command and the folder it was downloaded to (dir null while it has not been); with a language,
// its language depot too (languageDepot)
function findDepots(roots, { language = null } = {}) {
  const lang = languageDepot(language)
  return [...DEPOTS, ...(lang ? [lang] : [])].map(d => {
    for (const root of roots) {
      const dir = resolveDepot(path.join(root, 'steamapps', 'content'), d.id)
      if (dir) return { ...d, dir }
    }
    return { ...d, dir: null }
  })
}

// Regular files below dir, relative to it; links and other oddities are reported as unsafe, never followed
function listFiles(dir) {
  const files = []
  const unsafe = []
  const walk = sub => {
    for (const e of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = path.join(sub, e.name)
      if (e.isDirectory()) walk(rel)
      else if (e.isFile()) {
        const st = fs.statSync(path.join(dir, rel))
        files.push({ rel, size: st.size, mtimeMs: st.mtimeMs })
      } else unsafe.push(rel)
    }
  }
  walk('')
  return { files, unsafe }
}

/**
 * Where one depot's download stands: waiting (no folder), downloading, stalled (a file is still short and nothing has
 * arrived for two minutes), done, wrong (the exe is another build) or unsafe. prev is this function's last result for
 * the same depot, so a folder that stopped changing is recognised.
 */
function depotState(depot, prev, now, readVersion = gameversion.readPeFileVersion) {
  if (!depot.dir) return { state: 'waiting', bytes: 0, files: 0 }
  let listed
  try { listed = listFiles(depot.dir) } catch { return { state: 'waiting', bytes: 0, files: 0 } }
  const { files, unsafe } = listed
  const bytes = files.reduce((n, f) => n + f.size, 0)
  const signature = `${files.length}:${bytes}:${files.reduce((m, f) => Math.max(m, f.mtimeMs), 0)}`
  const since = prev && prev.signature === signature ? prev.since : now
  const base = { bytes, files: files.length, signature, since }
  if (unsafe.length) return { ...base, state: 'unsafe', detail: `unexpected entries: ${unsafe.slice(0, 3).join(', ')}` }
  const have = new Map(files.map(f => [refKey(f.rel), f]))
  const expected = depot.files || []
  const listedMissing = expected.some(e => (have.get(e.path.toLowerCase()) || {}).size !== e.size)
  // A file whose 1.6.1170 size is known and that is not that size yet is still arriving
  const short = files.some(f => { const want = REF_FILES.get(refKey(f.rel)); return want && want.size !== f.size })
  if (files.length && (listedMissing || short) && now - since >= STALLED_MS) return { ...base, state: 'stalled' }
  if (!files.length || listedMissing || short || now - since < STABLE_MS) return { ...base, state: 'downloading' }
  if (depot.id === EXE_DEPOT) {
    const exe = have.get('skyrimse.exe')
    if (!exe) return { ...base, state: 'wrong', detail: 'it holds no SkyrimSE.exe' }
    const version = readVersion(path.join(depot.dir, exe.rel))
    if (!version) return { ...base, state: 'downloading' }
    if (!isTarget(version)) return { ...base, state: 'wrong', version, detail: `its SkyrimSE.exe is ${version}` }
    return { ...base, state: 'done', version }
  }
  return { ...base, state: 'done' }
}

// rel below root, or an error when full is not inside root (Jake's Get-SafeRelativePath)
function safeRelative(root, full) {
  const rel = path.relative(path.resolve(root), path.resolve(full))
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Unsafe path: ${full}`)
  }
  return rel
}

// A backup folder name, the way Jake's tool names them: yyyyMMdd-HHmmss (local time)
function stampOf(d) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * The file jobs of a downgrade: every depot file with where it goes and, for a file the game folder already has, where
 * the old one is kept. Throws, before anything is touched, on a missing or empty depot or an unsafe path.
 */
function planInstall(depots, gameDir, stamp) {
  const game = path.resolve(gameDir)
  const backupDir = path.join(game, BACKUP_DIR, stamp)
  const byKey = new Map()
  for (const d of depots) {
    if (!d.dir) throw new Error(`Depot ${d.id} was not found. Nothing was changed.`)
    const { files, unsafe } = listFiles(d.dir)
    if (unsafe.length) throw new Error(`Depot ${d.id} holds unexpected entries (${unsafe[0]}). Nothing was changed.`)
    if (!files.length) throw new Error(`Depot ${d.id} is empty. Nothing was changed.`)
    for (const f of files) {
      const from = path.join(d.dir, f.rel)
      const rel = safeRelative(d.dir, from)
      if (refKey(rel).split('/')[0] === BACKUP_DIR.toLowerCase()) throw new Error(`Unsafe path: ${from}`)
      const to = path.join(game, rel)
      safeRelative(game, to)
      byKey.set(refKey(rel), { rel, from, to, size: f.size, depot: d.id })
    }
  }
  const jobs = [...byKey.values()].map(j => {
    let replaces = false
    try {
      const st = fs.statSync(j.to)
      if (st.isDirectory()) throw new Error(`${j.to} is a folder. Nothing was changed.`)
      replaces = true
    } catch (err) { if (err.code !== 'ENOENT') throw err }
    return { ...j, replaces, backup: path.join(backupDir, j.rel) }
  })
  return {
    gameDir: game,
    backupDir,
    jobs,
    bytes: jobs.reduce((n, j) => n + j.size, 0),
    replaced: jobs.filter(j => j.replaces).length,
    added: jobs.filter(j => !j.replaces).length,
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(file).on('error', reject).on('data', c => h.update(c)).on('end', () => resolve(h.digest('hex')))
  })
}

/**
 * Checks the downloads before anything is touched: the exe must be 1.6.1170, the base masters must be there, and
 * every file with a known 1.6.1170 size or hash must match it.
 */
async function verifyPlan(plan, { readVersion = gameversion.readPeFileVersion, hashFile = sha256File, onProgress = () => {} } = {}) {
  const exe = plan.jobs.find(j => refKey(j.rel) === 'skyrimse.exe')
  if (!exe) throw new Error('The downloads hold no SkyrimSE.exe. Nothing was changed.')
  const version = readVersion(exe.from)
  if (!isTarget(version)) {
    throw new Error(`The downloaded SkyrimSE.exe is ${version || 'unreadable'}, not ${TARGET}. Nothing was changed.`)
  }
  const problems = []
  const byKey = new Map(plan.jobs.map(j => [refKey(j.rel), j]))
  for (const [key, want] of REF_FILES) if (want.required && !byKey.has(key)) problems.push(`${want.path} is missing`)
  const checks = plan.jobs.map(j => ({ j, want: REF_FILES.get(refKey(j.rel)) })).filter(c => c.want)
  let i = 0
  for (const { j, want } of checks) {
    onProgress({ step: 'verify', index: ++i, total: checks.length, file: j.rel })
    if (j.size !== want.size) problems.push(`${j.rel} is ${j.size} bytes, not ${want.size}`)
    else if (want.sha256 && (await hashFile(j.from)) !== want.sha256) problems.push(`${j.rel} is not the 1.6.1170 file`)
  }
  if (problems.length) {
    throw new Error(`The downloads are not the 1.6.1170 files (${problems.join('; ')}). Nothing was changed.`)
  }
  return { version, checked: checks.length }
}

const fsOps = {
  rename: (a, b) => fs.promises.rename(a, b),
  copyFile: (a, b) => fs.promises.copyFile(a, b),
  rm: p => fs.promises.rm(p, { force: true }),
}

function writeRecord(backupDir, record) {
  fs.writeFileSync(path.join(backupDir, RECORD), JSON.stringify(record, null, 2) + '\n')
}

// Moves a file, or copies it when a move is refused (another drive, a file held open)
async function moveOrCopy(from, to, ops) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  try { await ops.rename(from, to); return 'moved' } catch { await ops.copyFile(from, to); return 'copied' }
}

/**
 * Backs up and copies, file by file. backup.json in the backup folder lists every replaced and every added file as it
 * goes, so Restore works even after a crash half-way. A failed copy puts back what was done so far and throws.
 */
async function runPlan(plan, { onProgress = () => {}, ops = fsOps, now = new Date() } = {}) {
  fs.mkdirSync(plan.backupDir, { recursive: true })
  const record = { target: REF.exeVersion, at: now.toISOString(), replaced: [], added: [], complete: false }
  writeRecord(plan.backupDir, record)
  const done = []
  let current = null
  try {
    for (const [i, job] of plan.jobs.entries()) {
      current = job
      onProgress({ step: 'copy', index: i + 1, total: plan.jobs.length, file: job.rel })
      if (job.replaces) {
        const how = await moveOrCopy(job.to, job.backup, ops)
        done.push({ job, how })
        record.replaced.push(job.rel)
      } else {
        done.push({ job, how: null })
        record.added.push(job.rel)
      }
      writeRecord(plan.backupDir, record)
      fs.mkdirSync(path.dirname(job.to), { recursive: true })
      await ops.copyFile(job.from, job.to)
    }
  } catch (err) {
    const back = await undo(done, ops)
    // Fully undone, the backup is spent; files that could not be put back stay listed for Restore
    record.rolledBack = back.failed.length === 0
    record.replaced = record.replaced.filter(r => back.failed.includes(r))
    record.added = []
    writeRecord(plan.backupDir, record)
    const tail = back.failed.length
      ? ` ${back.failed.length} file(s) could not be put back; they are in ${plan.backupDir}.`
      : ' Every file was put back as it was.'
    throw new Error(`Copying ${current ? current.rel : 'a file'} failed (${err.message}).${tail}`)
  }
  record.complete = true
  writeRecord(plan.backupDir, record)
  return { copied: plan.jobs.length, replaced: record.replaced.length, added: record.added.length, backupDir: plan.backupDir }
}

// Undoes runPlan's work in reverse: added files go, replaced ones come back from the backup
async function undo(done, ops) {
  const failed = []
  for (const { job, how } of [...done].reverse()) {
    try {
      await ops.rm(job.to)
      if (how === 'moved') await moveOrCopy(job.backup, job.to, ops)
      else if (how === 'copied') await ops.copyFile(job.backup, job.to)
    } catch {
      if (how) failed.push(job.rel)
    }
  }
  return { failed }
}

/**
 * The backup Restore would use, or null. Only the newest one counts: an older one holds files from before an earlier
 * downgrade, and putting those back over a game Steam has updated since would mix two builds. A restored or fully
 * rolled-back newest backup therefore means there is nothing to restore.
 */
function latestBackup(gameDir) {
  const base = path.join(path.resolve(gameDir), BACKUP_DIR)
  let names = []
  try { names = fs.readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) } catch { return null }
  for (const name of names.sort().reverse()) {
    let record
    try { record = JSON.parse(fs.readFileSync(path.join(base, name, RECORD), 'utf8')) } catch { continue /* not ours */ }
    return record.restored || record.rolledBack ? null : { dir: path.join(base, name), name, record }
  }
  return null
}

// The jobs that put a backup back: replaced files return, added files go. Paths are checked like planInstall's.
function planRestore(gameDir, backupDir) {
  const game = path.resolve(gameDir)
  const record = JSON.parse(fs.readFileSync(path.join(backupDir, RECORD), 'utf8'))
  const job = (rel, kind) => {
    const to = path.join(game, rel)
    safeRelative(game, to)
    if (refKey(rel).split('/')[0] === BACKUP_DIR.toLowerCase()) throw new Error(`Unsafe path: ${rel}`)
    const from = path.join(backupDir, rel)
    safeRelative(backupDir, from)
    return { rel, kind, from, to }
  }
  return {
    gameDir: game,
    backupDir,
    record,
    jobs: [...(record.replaced || []).map(r => job(r, 'replaced')), ...(record.added || []).map(r => job(r, 'added'))],
  }
}

async function runRestore(plan, { onProgress = () => {}, ops = fsOps, now = new Date() } = {}) {
  const failed = []
  for (const [i, j] of plan.jobs.entries()) {
    onProgress({ step: 'restore', index: i + 1, total: plan.jobs.length, file: j.rel })
    try {
      if (j.kind === 'added') { await ops.rm(j.to); continue }
      if (!fs.existsSync(j.from)) { failed.push(`${j.rel} (not in the backup)`); continue }
      await ops.rm(j.to)
      await moveOrCopy(j.from, j.to, ops)
    } catch (err) {
      failed.push(`${j.rel} (${err.message})`)
    }
  }
  const record = { ...plan.record, restored: now.toISOString(), restoreFailed: failed }
  writeRecord(plan.backupDir, record)
  return { restored: plan.jobs.length - failed.length, failed }
}

// "AutoUpdateBehavior" in an appmanifest: 0 keep updated, 1 only when launched, 2 high priority
function readAutoUpdate(text) {
  const m = /"AutoUpdateBehavior"\s+"(\d+)"/.exec(String(text))
  return m ? m[1] : null
}

// The appmanifest text with updates only on launch; every other byte stays
function setAutoUpdateOnLaunch(text) {
  const src = String(text)
  const current = readAutoUpdate(src)
  if (current === '1') return { text: src, changed: false }
  if (current !== null) {
    return { text: src.replace(/("AutoUpdateBehavior"\s+")\d+(")/, (_m, a, b) => `${a}1${b}`), changed: true }
  }
  // Missing: added as the first key of AppState, indented like the key it goes before
  const m = /"AppState"\s*\{(\r?\n)([ \t]*)/.exec(src)
  if (!m) throw new Error('This is not a Steam app manifest (no AppState block).')
  const at = m.index + m[0].length
  return { text: `${src.slice(0, at)}"AutoUpdateBehavior"\t\t"1"${m[1]}${m[2]}${src.slice(at)}`, changed: true }
}

/**
 * What the launcher offers for a game folder:
 *   none      it is the right build (an unreadable exe never blocks, as in checkGameVersion), or its data verdict is
 *             "unknown" (a file missing), which is only logged
 *   downgrade a Steam install on another build, or with the 1.6.1170 exe on newer data: 1.7.99 changed the masters and
 *             archives but not the exe (gameversion.checkGameData). Both block PLAY (Nate, 2026-09-29)
 *   gog       a GOG install on another build: rolled back in GOG Galaxy, not here
 *   refuse    Epic Games or Microsoft Store: no 1.6.1170 build can be put there
 */
function assess(gameDir, edition, readVersion = gameversion.readPeFileVersion) {
  const exe = path.join(gameDir, 'SkyrimSE.exe')
  const version = readVersion(exe)
  const out = { gameDir, edition, version, exe, required: REF.exeVersion, newerData: [] }
  if (edition === 'GOG') {
    const ok = version === null || version === gameversion.GAME_VERSION_GOG
    return { ...out, required: gameversion.GAME_VERSION_GOG, action: ok ? 'none' : 'gog', blocking: !ok }
  }
  const exeOk = version === null || isTarget(version)
  if (edition === 'Epic Games' || edition === 'Microsoft Store') {
    return { ...out, action: exeOk ? 'none' : 'refuse', blocking: !exeOk }
  }
  if (!exeOk) return { ...out, action: 'downgrade', blocking: true }
  const data = gameversion.checkGameData(gameDir, edition)
  if (data.verdict === gameversion.NEWER_DATA) {
    return { ...out, data: data.verdict, newerData: data.differ, action: 'downgrade', blocking: true }
  }
  return { ...out, data: data.verdict, action: 'none', blocking: false }
}

// Mod names switched on in an MO2 modlist.txt
function enabledMods(modlistText) {
  return String(modlistText).split(/\r?\n/).filter(l => l.startsWith('+')).map(l => l.slice(1).trim()).filter(Boolean)
}

// SKSE's 1.6.1170 runtime beside the exe, and Address Library's 1.6.1170 table in the game or an enabled MO2 mod
function runtimeChecks(runDir, { modsDir = null, mods = [] } = {}) {
  const has = p => fs.existsSync(p)
  const skse = has(path.join(runDir, 'skse64_loader.exe')) && has(path.join(runDir, SKSE_RUNTIME_DLL))
  const plugins = ['SKSE', 'Plugins', ADDRESS_LIBRARY_BIN]
  const addressLibrary = has(path.join(runDir, 'Data', ...plugins)) ||
    (!!modsDir && mods.some(m => has(path.join(modsDir, m, ...plugins))))
  return { skse, addressLibrary }
}

module.exports = {
  APP_ID, TARGET, DEPOTS, BACKUP_DIR, STABLE_MS, STALLED_MS, SKSE_RUNTIME_DLL, ADDRESS_LIBRARY_BIN,
  parseLibraryFolders, steamLibraryOf, acfPathFor, steamRoots, resolveDepot, languageDepot, findDepots, listFiles, depotState,
  safeRelative, stampOf, planInstall, verifyPlan, runPlan, latestBackup, planRestore, runRestore,
  readAutoUpdate, setAutoUpdateOnLaunch, assess, enabledMods, runtimeChecks, sha256File,
}
