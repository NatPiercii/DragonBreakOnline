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

/**
 * The bundled vanilla list for an edition (mo2.detectEdition) and Steam language (steamLanguage), or null: Epic and
 * Microsoft Store have none. A language without its own list is not ready (gamecopy.bundledManifest)
 */
function manifestFor(edition, load = gamecopy.bundledManifest, { language = 'english' } = {}) {
  const platform = edition === 'Steam' ? 'steam' : edition === 'GOG' ? 'gog' : null
  if (!platform) return null
  try { return load(platform, { omit: MANAGED_IN_COPY, language }) } catch { return null }
}

// Steam's language codes in the voice archives' names (Skyrim - Voices_<code>0.bsa)
const VOICE_LANGUAGES = { en: 'english', fr: 'french', de: 'german', it: 'italian', es: 'spanish', pl: 'polish', ru: 'russian', ja: 'japanese' }

/**
 * The language Steam installed Skyrim in, the way the files themselves show it: the appmanifest's MountedConfig (else
 * UserConfig) language, else the voice archive in Data (a localized install has its own besides the English one), else
 * English. It decides which language list the verified copy uses, as the loose Strings the legacy copy takes from the
 * folder follow the installed language.
 */
function steamLanguage(gameDir, { readText = f => fs.readFileSync(f, 'utf8') } = {}) {
  if (!gameDir) return 'english'
  const common = path.dirname(path.resolve(gameDir))
  const acf = path.join(path.dirname(common), `appmanifest_${REF.app}.acf`)
  try {
    const text = readText(acf)
    for (const block of ['MountedConfig', 'UserConfig']) {
      const m = new RegExp(`"${block}"\\s*\\{([^}]*)\\}`).exec(text)
      const lang = m && /"language"\s+"([a-z]+)"/i.exec(m[1])
      if (lang) return lang[1].toLowerCase()
    }
  } catch { /* not a Steam library folder, or no appmanifest */ }
  try {
    const voices = fs.readdirSync(path.join(gameDir, 'Data'))
      .map(n => /^skyrim - voices_([a-z]{2})0\.bsa$/i.exec(n)).filter(Boolean).map(m => VOICE_LANGUAGES[m[1].toLowerCase()]).filter(Boolean)
    return voices.find(l => l !== 'english') || 'english'
  } catch { return 'english' }
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
    if (v === want) return { ok: true }
    if (!v) return { ok: false, kind: 'exe', unreadable: true, why: 'its SkyrimSE.exe could not be read (an antivirus holding it, or no permission to read it)' }
    return { ok: false, kind: 'exe', why: `its SkyrimSE.exe is ${v}, not ${want}` }
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
  if (!v) return { ok: false, unreadable: true, why: 'the Skyrim folder\'s SkyrimSE.exe could not be read (an antivirus holding it, or no permission to read it)' }
  if (v !== want) return { ok: false, why: `the Skyrim folder's SkyrimSE.exe is ${v}, not ${want}` }
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
 * With an untrusted folder (another launcher changed it), a file the copy lacks is skipped unless the game needs it
 * (SkyrimSE.exe, or a master marked required): a new video or BSA there says nothing about our copy. The copy's own
 * exe is kept when its version cannot be read, as gameversion.checkGameVersion and downgrade.assess accept it.
 * Returns { copy, keep, broken, skipped, warned, trusted }, keep/broken/skipped/warned entries with why.
 */
async function legacyRepairPlan(jobs, { srcDir, edition, readVersion, hash, known, tolerateData = false, copyDir = null } = {}) {
  const opts = { edition, readVersion, hash, known }
  const trusted = trustSource(srcDir, edition, { readVersion })
  const voices = copyDir ? copyVoices(copyDir) : new Set()
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
    if (own.ok || (exists && own.unreadable) || (tolerateData && exists && own.kind === 'data')) out.keep.push({ ...job, why: vet.why })
    else if (job.optional || (!exists && !trusted.ok && !requiredFile(job.rel, { voices }))) out.skipped.push({ ...job, why: `${vet.why}; ${own.why}` })
    else out.broken.push({ ...job, why: `${own.why}, and ${vet.why}` })
  }
  return out
}

// The base archives of 1.6.1170, by name (SE packs the DLC into these; it has no Dawnguard/HearthFires/Dragonborn .bsa): without one the game crashes or loses meshes and textures. A fixed
// list, so an archive a newer Steam build adds is not required. 1.6 has no Update.bsa, and the Anniversary update
// folded Skyrim - Patch.bsa into the others (STEP's SE game files guide). Voice archives depend on the language.
const REQUIRED_ARCHIVES = new Set([
  'Skyrim - Animations', 'Skyrim - Interface', 'Skyrim - Meshes0', 'Skyrim - Meshes1', 'Skyrim - Misc',
  'Skyrim - Shaders', 'Skyrim - Sounds', ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map(n => `Skyrim - Textures${n}`),
].map(n => `data/${n.toLowerCase()}.bsa`))
const VOICE_ARCHIVE = /^data\/skyrim - voices_([a-z]{2})\d+\.bsa$/

// The voice languages a copy has (Skyrim - Voices_<code>N.bsa in its Data), as codes
function copyVoices(copyDir) {
  try {
    return new Set(fs.readdirSync(path.join(copyDir, 'Data')).map(n => VOICE_ARCHIVE.exec(`data/${n.toLowerCase()}`)).filter(Boolean).map(m => m[1]))
  } catch { return new Set() }
}

// Files the game cannot run without: the exe, the masters downgrade-1.6.1170.json marks required, the 1.6.1170 base and
// DLC archives, and the voice archives of a language the copy already has (voices: copyVoices). A missing one is
// refused rather than skipped
function requiredFile(rel, { voices = new Set() } = {}) {
  const key = relKey(rel)
  if (key === 'skyrimse.exe' || !!(KNOWN_FILES.get(key) || {}).required || REQUIRED_ARCHIVES.has(key)) return true
  const v = VOICE_ARCHIVE.exec(key)
  return !!v && voices.has(v[1])
}

/**
 * What a verified build over a copy made by launcher 2.1.36 or older (no record yet) means for the install pass: a
 * copy that played until now keeps playing, with a warning, whatever kept the check from finishing (clean files not
 * downloaded yet, too little space, a file held open, an antivirus, a write error). It is never blocked for that.
 * built: buildVerifiedCopy's result (or { success: false, error } for a thrown error); playable: the copy was complete.
 */
function migrationResult(built, { playable }) {
  if (built.success) return { ok: true, warning: null, repaired: built.copied }
  if (playable && !built.needDepots) {
    return {
      ok: true,
      warning: `DragonBreak's game copy could not be checked against the clean Skyrim file list yet (${built.error || 'unknown error'}). ` +
        'It keeps playing as it is. Press Repair Game Copy to check it again.',
    }
  }
  if (built.needDepots && playable) {
    const files = built.files || []
    const some = files.slice(0, 3).map(f => path.basename(String(f))).join(', ') + (files.length > 3 ? ', …' : '')
    return {
      ok: true,
      warning: `DragonBreak's game copy still has ${files.length} changed Skyrim file(s) (${some}). It keeps playing with them; ` +
        'download the clean ones in Settings > Repair > Skyrim Version when you can. Your Steam Skyrim is not changed.',
    }
  }
  return { ok: false, error: built.error }
}

/**
 * Whether the install pass should check a 2.1.36 copy against the list again after a failed check (failed: what was
 * remembered, { error, needBytes }): not on every PLAY (that hashes about 15 GB and fails the same way), only once
 * the free space has grown past what was needed. Repair Game Copy clears the memory and always checks.
 */
function migrationRetry(failed, { free = null, margin = SPACE_MARGIN } = {}) {
  if (!failed) return true
  return !!failed.needBytes && free !== null && free >= failed.needBytes + margin
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
 *   legacy    as before: the Skyrim folder is downgraded in place, but only while there is no ready, right copy (then
 *             'none' with copyOwn). copyWrong when the folder is fine but the ready copy is on another build
 *   verified  the panel fills DragonBreak's copy from Steam's download instead of changing the Steam folder. The depot
 *             steps (action 'downgrade', copyBuild) show while a build or repair is short of files, or before the copy
 *             exists when the Skyrim folder is on another build; once the copy is ready, action 'none' with copyOwn
 * Returns { action, blocking, copyOwn, copyBuild, copyWrong }.
 */
function panelState({ mode, isolated, copyReady: ready, steam, copy, needs }) {
  const base = { action: steam.action, blocking: steam.blocking, copyOwn: false, copyBuild: null, copyWrong: false }
  if (mode !== 'verified') {
    // A ready copy that is right needs nothing from the Skyrim folder, whatever another launcher did to it: no
    // in-place downgrade is offered
    if (isolated && ready && copy && copy.action === 'none' && steam.action !== 'none') {
      return { ...base, action: 'none', blocking: false, copyOwn: true }
    }
    return { ...base, copyWrong: !!(isolated && ready && copy && copy.action !== 'none' && steam.action === 'none') }
  }
  if (needs) return { ...base, action: 'downgrade', blocking: true, copyBuild: { files: needs.files || [], count: needs.count || 0 } }
  if (ready) return { ...base, action: 'none', blocking: false, copyOwn: true }
  if (steam.action === 'downgrade') return { ...base, blocking: true, copyBuild: { files: [], count: 0 } }
  return base
}

// %LOCALAPPDATA%\Skyrim Special Edition\ContentCatalog.txt: the Creations cache shared by every Skyrim on the PC.
// Moved aside right before our game starts (a CSV2_<uuid> entry crashed it) and put back after, since it is the
// player's. The launcher keeps a mark (size and mtime) of the file it moved, and only that file is ever put back: a
// .dbo-disabled left by launcher 2.1.36, which moved it on every pass, is older than the catalog the player has now.
function catalogPaths(localAppData) {
  if (!localAppData) return null
  const catalog = path.join(localAppData, 'Skyrim Special Edition', 'ContentCatalog.txt')
  return { catalog, kept: `${catalog}.dbo-disabled`, session: `${catalog}.dbo-session`, old: `${catalog}.dbo-old` }
}

const statOf = p => { try { const st = fs.statSync(p); return { size: st.size, mtimeMs: Math.trunc(st.mtimeMs) } } catch { return null } }
const sameMark = (a, b) => !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs

/**
 * Moves the player's catalog aside before a launch. mark: the launcher's mark of the file it moved last, if any.
 * Returns { moved, mark }: moved 'moved' (mark is the new one to keep), 'session' when our own earlier one is still
 * aside (it is the player's and stays; the new one is a cache our game wrote), or null when there is nothing to move.
 * A .dbo-disabled that is not ours (2.1.36's) is kept as .dbo-old and never put back.
 */
function moveCatalogAside(localAppData, mark = null) {
  const p = catalogPaths(localAppData)
  const cur = p && statOf(p.catalog)
  if (!cur || cur.size <= 0) return { moved: null, mark }
  const kept = statOf(p.kept)
  if (kept && sameMark(kept, mark)) {
    fs.rmSync(p.session, { force: true })
    fs.renameSync(p.catalog, p.session)
    return { moved: 'session', mark }
  }
  if (kept) { fs.rmSync(p.old, { force: true }); fs.renameSync(p.kept, p.old) }
  fs.renameSync(p.catalog, p.kept)
  return { moved: 'moved', mark: statOf(p.kept) }
}

/**
 * Puts back the catalog the launcher moved (mark), keeping any one our game wrote meanwhile as .dbo-session.
 * 'restored'; 'stale' when the file aside is not the one we moved (left alone); 'gone' when there is none; null
 * without a mark.
 */
function restoreCatalog(localAppData, mark) {
  const p = catalogPaths(localAppData)
  if (!p || !mark) return null
  const kept = statOf(p.kept)
  if (!kept) return 'gone'
  if (!sameMark(kept, mark)) return 'stale'
  if (statOf(p.catalog)) {
    fs.rmSync(p.session, { force: true })
    fs.renameSync(p.catalog, p.session)
  }
  fs.renameSync(p.kept, p.catalog)
  return 'restored'
}

/**
 * A .dbo-disabled the launcher has no mark for (launcher 2.1.36 moved the catalog on every pass and never put it
 * back): put back only when the player has no catalog now, so nothing newer is ever replaced. 'restored' or null.
 */
function restoreOrphanCatalog(localAppData) {
  const p = catalogPaths(localAppData)
  if (!p || !statOf(p.kept) || statOf(p.catalog)) return null
  fs.renameSync(p.kept, p.catalog)
  return 'restored'
}

const catalogAside = (localAppData, mark) => { const p = catalogPaths(localAppData); return !!p && sameMark(statOf(p.kept), mark) }

// Folders the launcher writes into below the copy
const WRITTEN_FOLDERS = ['Data', 'Data/Platform', 'Data/Platform/Plugins', 'Data/Platform/PluginsNoLoad', 'Data/SKSE',
  'Data/SKSE/Plugins', 'Data/Interface', 'Data/Interface/Controls', 'Data/Interface/Controls/PC', 'Data/Scripts',
  'Data/Video', 'Data/Strings']

const norm = p => { const r = path.resolve(p).replace(/[\\/]+$/, ''); return process.platform === 'win32' ? r.toLowerCase() : r }
// True when a and b are the same folder or one is inside the other
function overlaps(a, b) {
  const na = norm(a) + path.sep
  const nb = norm(b) + path.sep
  return na.startsWith(nb) || nb.startsWith(na)
}

/**
 * The link policy for the copy: a folder in it may be a link (a player moved Data to another drive with a junction,
 * which launcher 2.1.36 played with), but never one that reaches the Skyrim folder or any Steam library, since
 * writing through it would change another install. forbidden: those folders (skyrimPath, downgrade.steamRoots).
 * Returns a predicate on a link's real path.
 */
function linkPolicy(forbidden = []) {
  // Each root as given and as it really is: a Steam folder moved to another drive with a link is reached through
  // its real path. A root whose real path cannot be read stays as given
  const roots = []
  for (const r of forbidden.filter(Boolean)) {
    roots.push(r)
    try { roots.push(fs.realpathSync(r)) } catch { /* not there, or real paths unreadable here */ }
  }
  return real => !roots.some(r => overlaps(real, r))
}

/** The folders of the copy the launcher writes into that are links, with their real paths (for the log) */
function copyLinks(dir) {
  const out = []
  if (!dir || !fs.existsSync(dir)) return out
  for (const rel of WRITTEN_FOLDERS) {
    let st
    try { st = fs.lstatSync(path.join(dir, ...rel.split('/'))) } catch { continue }
    if (!st.isSymbolicLink()) continue
    let real = null
    try { real = fs.realpathSync(path.join(dir, ...rel.split('/'))) } catch { /* a broken link */ }
    out.push({ rel, real })
  }
  return out
}

/**
 * Why the launcher must not write into this copy, or null: a folder in it that is a link into the Skyrim folder or a
 * Steam library (forbidden), or a broken link. Any other link is allowed (copyLinks lists them for the log).
 */
function copyLinkProblem(dir, { forbidden = [] } = {}) {
  const allowed = linkPolicy(forbidden)
  for (const { rel, real } of copyLinks(dir)) {
    if (real && allowed(real)) continue
    return `${rel.replace(/\//g, '\\')} in the DragonBreak game copy (${dir}) is a link ${real ? `into ${real}, which is part of your Skyrim or Steam folders` : 'whose target is gone'}, ` +
      'so the launcher writes nothing through it. Remove the link, then press Settings > Repair > Repair Game Copy.'
  }
  return null
}

module.exports = {
  MANAGED_IN_COPY, COPY_MARKER, KNOWN_FILES, FOREIGN_ROOT_DLLS, NO_COPY_ERROR, SPACE_MARGIN,
  manifestFor, steamLanguage, copyMode, copyReady, gamePathFor, noGamePathError, versionGateDir, vetFile, trustSource,
  legacyRepairPlan, requiredFile, copyVoices, migrationResult, migrationRetry, changedDataWarning, setupText, spaceCheck, resolveBase, dllsToSetAside, panelState,
  catalogPaths, moveCatalogAside, restoreCatalog, restoreOrphanCatalog, catalogAside, copyLinkProblem, copyLinks, linkPolicy,
  overlaps, targetVersion, targetBuild,
}
