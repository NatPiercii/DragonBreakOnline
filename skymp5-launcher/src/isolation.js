'use strict'
/**
 * The decisions main.js makes about DragonBreak's own game copy, as small pure functions so they are tested without
 * Electron. Isolated launcher phase 2: /opt/dragonbreak-handover/isolated-launcher/PHASE2-WIRING.md.
 *
 * Two copy paths:
 *   verified  the copy holds only files whose sha256 matches the bundled vanilla list (src/vanilla-1.6.1170.json),
 *             the rest come from Steam's download_depot output, and the copy is checked against its own record
 *             (gamecopy.js). Active only once the list for the player's edition has files.
 *   legacy    today's copy by file name and size from the Skyrim folder, for as long as there is no list (and for GOG
 *             until a GOG list exists). It keeps the leak fixes below: nothing whose content is known to be wrong is
 *             copied from the Skyrim folder, and the copy, not Steam, decides the version gates once it is ready.
 */
const fs = require('fs')
const path = require('path')
const gamecopy = require('./gamecopy')
const gameversion = require('./gameversion')
const REF = require('./downgrade-1.6.1170.json')

// Files the launcher itself rewrites in the copy, so never compared with the vanilla list: Skyrim.ccc is kept empty
const MANAGED_IN_COPY = ['Skyrim.ccc']
// The legacy copy's completion marker (main.js copyGameDir)
const COPY_MARKER = 'vanilla-copy-complete.json'
// The 1.6.1170 files whose size and sha256 are known without the full list (downgrade-1.6.1170.json)
const KNOWN_FILES = new Map(Object.entries(REF.files).map(([p, v]) => [p.toLowerCase(), { path: p, ...v }]))
// Root DLL names that graphics injectors and other servers' loaders use. Only these are moved out of the copy's root;
// any other unknown root DLL is reported, since a client package may bring its own
const FOREIGN_ROOT_DLLS = new Set(['dinput8.dll', 'd3d11.dll', 'dxgi.dll', 'd3d9.dll', 'd3d10.dll', 'd3d12.dll',
  'd3dcompiler_46e.dll', 'dsound.dll', 'version.dll', 'winmm.dll', 'opengl32.dll', 'xinput1_3.dll'])
const SPACE_MARGIN = 512 * 1024 ** 2
const NO_COPY_ERROR = 'The DragonBreak game copy is not set up yet. Press PLAY to set it up, or use Settings > Repair > ' +
  'Repair Game Copy. DragonBreak never plays from your Steam or GOG Skyrim folder itself.'

const relKey = rel => String(rel).split(/[\\/]/).join('/').toLowerCase()
const gb = n => `${(n / 1024 ** 3).toFixed(1)} GB`
const targetVersion = edition => (edition === 'GOG' ? gameversion.GAME_VERSION_GOG : gameversion.GAME_VERSION_REQUIRED)
const targetBuild = edition => targetVersion(edition).split('.').slice(0, 3).join('.')

/** The bundled vanilla list for an edition (mo2.detectEdition), or null: Epic and Microsoft Store have none */
function manifestFor(edition, load = gamecopy.bundledManifest) {
  const platform = edition === 'Steam' ? 'steam' : edition === 'GOG' ? 'gog' : null
  if (!platform) return null
  try { return load(platform, { omit: MANAGED_IN_COPY }) } catch { return null }
}

/** 'verified' when isolation is on and the list for the edition has files; 'legacy' otherwise (empty list, GOG today) */
function copyMode({ isolated, manifest }) {
  return isolated && manifest && manifest.ready ? 'verified' : 'legacy'
}

/**
 * Whether a game copy can be played: its exe plus the verified copy's record, the legacy completion marker, or (copies
 * made before the marker) both base masters. A copy whose first files landed before an interruption is not ready.
 */
function copyReady(dir) {
  if (!dir) return false
  const has = rel => fs.existsSync(path.join(dir, ...rel.split('/')))
  if (!has('SkyrimSE.exe')) return false
  if (has(gamecopy.RECORD_FILE) || has(COPY_MARKER)) return true
  return has('Data/Skyrim.esm') && has('Data/Update.esm')
}

/** Where the game runs and the client files go. Isolated mode never falls back to the Skyrim folder: null instead */
function gamePathFor({ isolated, copyReady: ready, copyDir, skyrimPath }) {
  if (isolated) return ready ? copyDir : null
  return skyrimPath || null
}

function noGamePathError(isolated) {
  return isolated ? NO_COPY_ERROR : 'Skyrim path not configured.'
}

/**
 * The folder whose Skyrim version decides startup and PLAY: our copy once it is ready, so a changed Steam exe never
 * blocks a good copy. Before that, the legacy copy is made from the Skyrim folder, so that folder decides; the verified
 * copy takes only right files whatever Steam's build is, so nothing does (null).
 */
function versionGateDir({ isolated, copyReady: ready, copyDir, skyrimPath, mode }) {
  if (isolated && ready) return copyDir
  if (isolated && mode === 'verified') return null
  return skyrimPath || null
}

/**
 * Whether a file from the Skyrim folder may go into the copy: not when its content is known to be wrong. SkyrimSE.exe
 * must be the target build (1.6.1170.0, GOG 1.6.1179.0; an unreadable one is refused too), and a file whose 1.6.1170
 * size and sha256 are known must have them (Steam only: GOG's 1.6.1179 files are not listed).
 * { ok, why, kind }: kind 'exe' for the exe check, 'data' for a known Data file (which the legacy copy tolerates).
 */
async function vetFile(rel, file, {
  edition, readVersion = gameversion.readPeFileVersion, hash = gamecopy.hashFile, known = KNOWN_FILES,
} = {}) {
  const key = relKey(rel)
  if (key === 'skyrimse.exe') {
    const want = targetVersion(edition)
    const v = readVersion(file)
    return v === want ? { ok: true } : { ok: false, kind: 'exe', why: `its SkyrimSE.exe is ${v || 'unreadable'}, not ${want}` }
  }
  const k = edition === 'GOG' ? null : known.get(key)
  if (!k) return { ok: true }
  let size
  try { size = fs.statSync(file).size } catch { return { ok: false, kind: 'data', why: `${k.path} is missing` } }
  if (size !== k.size) return { ok: false, kind: 'data', why: `${k.path} is not the ${targetBuild(edition)} file (size)` }
  if ((await hash(file)) !== k.sha256) return { ok: false, kind: 'data', why: `${k.path} is not the ${targetBuild(edition)} file (sha256)` }
  return { ok: true }
}

/**
 * Whether a Skyrim folder can serve as a source at all: its exe is the target build and its data is not from a newer
 * Steam update (gameversion.checkGameData). { ok, why }
 */
function trustSource(dir, edition, { readVersion = gameversion.readPeFileVersion } = {}) {
  if (!dir) return { ok: false, why: 'no Skyrim folder is set' }
  const want = targetVersion(edition)
  const v = readVersion(path.join(dir, 'SkyrimSE.exe'))
  if (v !== want) return { ok: false, why: `the Skyrim folder's SkyrimSE.exe is ${v || 'unreadable'}, not ${want}` }
  const data = gameversion.checkGameData(dir, edition)
  if (data.verdict === gameversion.NEWER_DATA) return { ok: false, why: `the Skyrim folder has newer game data (${data.differ.join(', ')})` }
  return { ok: true }
}

/**
 * The legacy repair, which compares the copy's sizes with the Skyrim folder, decided per file. jobs:
 * [{ rel, from, to, optional }]. A file is copied only when the folder is a trusted source and the file passes
 * vetFile. Otherwise the copy's own file stays when it is there and passes vetFile itself (the copy is the good one:
 * Steam was updated or modded); a missing or wrong copy file with no good source is broken, or skipped if optional.
 * tolerateData (the legacy copy, while there is no vanilla list): a known Data file with other bytes (a cleaned
 * master) is not an error. The copy's existing file is still never replaced by it, but a missing one is copied with a
 * warning (warned), as setup does. The exe and a folder on another build stay strict.
 * Returns { copy, keep, broken, skipped, warned, trusted }, keep/broken/skipped/warned entries with why.
 */
async function legacyRepairPlan(jobs, { srcDir, edition, readVersion, hash, known, tolerateData = false } = {}) {
  const opts = { edition, readVersion, hash, known }
  const trusted = trustSource(srcDir, edition, { readVersion })
  const out = { copy: [], keep: [], broken: [], skipped: [], warned: [], trusted }
  for (const job of jobs) {
    const vet = trusted.ok ? await vetFile(job.rel, job.from, opts) : { ok: false, kind: 'source', why: trusted.why }
    if (vet.ok) { out.copy.push(job); continue }
    const exists = fs.existsSync(job.to)
    if (tolerateData && vet.kind === 'data') {
      if (exists) out.keep.push({ ...job, why: vet.why })
      else { out.copy.push(job); out.warned.push({ ...job, why: vet.why }) }
      continue
    }
    const own = exists ? await vetFile(job.rel, job.to, opts) : { ok: false, why: 'it is missing from the game copy' }
    if (own.ok || (tolerateData && exists && own.kind === 'data')) out.keep.push({ ...job, why: vet.why })
    else if (job.optional) out.skipped.push({ ...job, why: `${vet.why}; ${own.why}` })
    else out.broken.push({ ...job, why: `${own.why}, and ${vet.why}` })
  }
  return out
}

/** The one warning naming the changed Data files the legacy copy took from the Skyrim folder anyway */
function changedDataWarning(names) {
  const list = [...new Set(names.map(n => path.basename(String(n).replace(/\\/g, '/'))))]
  if (!list.length) return null
  const named = list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
  return `Your Steam copy has a changed ${named}; DragonBreak will use it until its own clean copy is available.`
}

/** The setup text: where the copy goes, about how big, and that the player's own Skyrim and other servers stay as they are */
function setupText({ dir, edition, totalBytes = 0 }) {
  const size = totalBytes > 0 ? Math.max(1, Math.round(totalBytes / 1024 ** 3)) : 16
  const store = edition === 'GOG' ? 'GOG ' : edition === 'Steam' ? 'Steam ' : ''
  return `DragonBreak keeps its own Skyrim ${targetBuild(edition)} in ${dir} (about ${size} GB). ` +
    `Your ${store}Skyrim and other servers are not changed.`
}

/** The free-space check shown before copying: { enough, text }. free null means the drive could not be read (not refused) */
function spaceCheck({ needed, free, margin = SPACE_MARGIN }) {
  if (free === null || free === undefined || !Number.isFinite(free)) {
    return { enough: true, text: `Needs about ${gb(needed)} of free space (the free space on that drive could not be read).` }
  }
  if (free >= needed + margin) return { enough: true, text: `Free space: ${gb(free)} on that drive, ${gb(needed)} needed ✓` }
  return {
    enough: false,
    text: `Not enough free space: ${gb(needed)} needed, ${gb(free)} free on that drive. Free up some space, or choose ` +
      'another Install Location in Settings, then try again.',
  }
}

/** The install base the way createIsolatedImpl picks it: the field, else the stored base, else C:\DragonBreak, nested
 * under \DragonBreak unless it already is one (or holds the instance marker) */
function resolveBase({ override, stored, fallback, exists = fs.existsSync }) {
  let base = (typeof override === 'string' && override.trim()) || stored || fallback
  if (path.basename(base).toLowerCase() !== 'dragonbreak' && !exists(path.join(base, 'alduinak-instance.txt'))) {
    base = path.join(base, 'DragonBreak')
  }
  return base
}

/** The unknown root DLLs drift found that are moved out of the copy: the known injector and loader names only */
function dllsToSetAside(extraRootDlls) {
  return (extraRootDlls || []).filter(n => FOREIGN_ROOT_DLLS.has(n.toLowerCase()))
}

/**
 * What the Skyrim Version panel offers, from the Skyrim folder's assessment (downgrade.assess), the copy's own
 * assessment and the files a verified build last found no right copy of (needs):
 *   legacy    as before: the Skyrim folder is downgraded in place. copyWrong when the folder is fine but the ready
 *             copy is on another build (Repair Game Copy rebuilds it)
 *   verified  the panel fills DragonBreak's copy from Steam's download instead of changing the Steam folder. The depot
 *             steps (action 'downgrade', copyBuild) show while a build or repair is short of files, or before the copy
 *             exists when the Skyrim folder is on another build; once the copy is ready, action 'none' with copyOwn
 * Returns { action, blocking, copyOwn, copyBuild, copyWrong }.
 */
function panelState({ mode, isolated, copyReady: ready, steam, copy, needs }) {
  const base = { action: steam.action, blocking: steam.blocking, copyOwn: false, copyBuild: null, copyWrong: false }
  if (mode !== 'verified') {
    return { ...base, copyWrong: !!(isolated && ready && copy && copy.action !== 'none' && steam.action === 'none') }
  }
  if (needs) return { ...base, action: 'downgrade', blocking: true, copyBuild: { files: needs.files || [], count: needs.count || 0 } }
  if (ready) return { ...base, action: 'none', blocking: false, copyOwn: true }
  if (steam.action === 'downgrade') return { ...base, blocking: true, copyBuild: { files: [], count: 0 } }
  return base
}

// %LOCALAPPDATA%\Skyrim Special Edition\ContentCatalog.txt: the Creations cache shared by every Skyrim on the PC.
// Moved aside before our game starts (a CSV2_<uuid> entry crashed it) and put back after, since it is the player's.
function catalogPaths(localAppData) {
  if (!localAppData) return null
  const catalog = path.join(localAppData, 'Skyrim Special Edition', 'ContentCatalog.txt')
  return { catalog, kept: `${catalog}.dbo-disabled`, session: `${catalog}.dbo-session` }
}

const fileSize = p => { try { return fs.statSync(p).size } catch { return -1 } }

/**
 * Moves the player's catalog aside: 'moved', or 'session' when an earlier one is still aside (that one is the
 * player's and is never overwritten; the new one is a cache our game wrote), or null when there is nothing to move
 */
function moveCatalogAside(localAppData) {
  const p = catalogPaths(localAppData)
  if (!p || fileSize(p.catalog) <= 0) return null
  if (fileSize(p.kept) < 0) { fs.renameSync(p.catalog, p.kept); return 'moved' }
  fs.rmSync(p.session, { force: true })
  fs.renameSync(p.catalog, p.session)
  return 'session'
}

/** Puts the player's catalog back if we moved it ('restored'), keeping any one our game wrote meanwhile as .dbo-session */
function restoreCatalog(localAppData) {
  const p = catalogPaths(localAppData)
  if (!p || fileSize(p.kept) < 0) return null
  if (fileSize(p.catalog) >= 0) {
    fs.rmSync(p.session, { force: true })
    fs.renameSync(p.catalog, p.session)
  }
  fs.renameSync(p.kept, p.catalog)
  return 'restored'
}

const catalogAside = localAppData => { const p = catalogPaths(localAppData); return !!p && fileSize(p.kept) >= 0 }

module.exports = {
  MANAGED_IN_COPY, COPY_MARKER, KNOWN_FILES, FOREIGN_ROOT_DLLS, NO_COPY_ERROR, SPACE_MARGIN,
  manifestFor, copyMode, copyReady, gamePathFor, noGamePathError, versionGateDir, vetFile, trustSource,
  legacyRepairPlan, changedDataWarning, setupText, spaceCheck, resolveBase, dllsToSetAside, panelState, catalogPaths, moveCatalogAside,
  restoreCatalog, catalogAside, targetVersion, targetBuild,
}
