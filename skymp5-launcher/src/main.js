// Load .env before anything else - only in unpackaged (dev/local) builds.
// Packaged installers use real environment variables set by the OS / process manager.
if (!require('electron').app.isPackaged) {
  require('dotenv').config()
}

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron')

// Basic/Remote display adapters (RDP, VMs, servers) bugcheck the video
// scheduler when Chromium drives them; the launcher UI does not need the GPU.
app.disableHardwareAcceleration()
const path   = require('path')
const fs     = require('fs')
const os     = require('os')
const crypto = require('crypto')
const zlib   = require('zlib')
const http   = require('http')
const https  = require('https')
const { spawn, execFileSync } = require('child_process')
const Store  = require('electron-store')
const AdmZip = require('adm-zip')
const config = require('./config')
const mo2    = require('./mo2')
const nexus  = require('./nexus')
const ini    = require('./ini')
const prefsSeed = require('./prefsSeed')
const controlmapCheck = require('./controlmapCheck')
const gameversion = require('./gameversion')
const downgrade = require('./downgrade')
const gamecopy = require('./gamecopy')
const isolation = require('./isolation')
const report = require('./report')
const crashWatch = require('./crashWatch')
const nxmLinks = require('./nxm')
const legalLib = require('./legal')
const installProgress = require('./renderer/installProgress')
const installGate  = installProgress.createGate()
const installTrack = installProgress.createTracker()

// Settings stay in the folder named after the launcher's original product name.
const USER_DATA_DIR = path.join(app.getPath('appData'), 'DragonBreak Online Launcher')
fs.mkdirSync(USER_DATA_DIR, { recursive: true })
app.setPath('userData', USER_DATA_DIR)

const isDev = process.argv.includes('--dev')

// One launcher at a time: a "Mod Manager Download" click on Nexus starts a second copy with the nxm:// link,
// which is handed to the running one (second-instance) and the copy quits.
const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) app.quit()

// Always log installs: a packaged launcher that fails on a player's machine is
// undiagnosable without one. Dev builds keep using the temp path.
const LOG_FILE = isDev
  ? path.join(require('os').tmpdir(), 'alduinak-install.log')
  : path.join(app.getPath('userData'), 'install.log')

function log(...args) {
  const line = args.join(' ')
  console.log(line)
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`) } catch { }
}

try {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
  // Keep the previous run: a player who hits an error usually reopens the launcher before asking for
  // help, and truncating here would throw away the log of the run that actually failed.
  try { if (fs.existsSync(LOG_FILE)) fs.renameSync(LOG_FILE, LOG_FILE.replace(/\.log$/, '.prev.log')) } catch { }
  fs.writeFileSync(LOG_FILE, `=== dragonbreak install log ${new Date().toISOString()} ===\n`)
} catch { }

// Route module debug output through the same logger
mo2.setLogger(log)
nexus.setLogger(log)

// Whatever takes the launcher down, or leaves it half-dead, is written to install.log, so a report can show it
// (Silanth, 2026-09-29: "Repair All crashes the launcher", with nothing in the log). An uncaught error used to show
// only Electron's own dialog; a renderer or helper process that died left no trace at all.
const errorText = (err) => (err && err.stack) || String(err)
process.on('uncaughtException', (err) => {
  log(`[crash] uncaught error in the launcher: ${errorText(err)}`)
  try { send('install:log', `The launcher hit an unexpected error: ${err && err.message ? err.message : err}. Press Report a Problem so staff get the log.`) } catch { /* no window yet */ }
})
process.on('unhandledRejection', (reason) => log(`[crash] unhandled rejection in the launcher: ${errorText(reason)}`))
app.on('render-process-gone', (_e, _contents, details) =>
  log(`[crash] the launcher window's renderer is gone: ${details && details.reason} (exit code ${details && details.exitCode})`))
app.on('child-process-gone', (_e, details) =>
  log(`[crash] a launcher helper process is gone: ${details && details.type} ${details && details.reason} (exit code ${details && details.exitCode})`))

// Only user-specific preferences live in the store.
const store = new Store({
  defaults: {
    skyrimPath:        '',
    activeServerIndex: 0,
    cachedServers:     [],   // last-known server list fetched from /api/servers
    filesVersion:      '',   // version tag from last successful file download
    discordUser:       null,
    mo2Enabled:        true,   // launch the game through the managed portable MO2
    nexusApiKey:       '',     // Nexus API key (websocket SSO flow)
    nexusOauth:        null,   // { accessToken, refreshToken, expiresAt } (OAuth flow)
    nexusUser:         null,   // { name, isPremium } from the last validation
    isolatedGame:      true,  // play from the isolated game copy instead of skyrimPath
    gameDirPath:       '',     // legacy: pre-base-dir location of the game copy
    baseDirPath:       '',     // DragonBreak base dir: MO2 root, with the game at <base>\skyrim
    forcedDefaultsApplied: false, // server-required graphics defaults seeded once at first install
    archiveDir:        '',     // a folder of mod archives already downloaded (Vortex's), used before asking Nexus
  }
})

mo2.setRootProvider(() => store.get('baseDirPath') || DEFAULT_BASE_DIR)

// Terms of Service and Privacy Policy: the texts, this player's acceptance, and accepting (legal.js)
const legal = legalLib.createLegal({
  apiUrl: config.apiUrl, fetchJSON, postJSON, log,
  getSession: () => store.get('gameSession'),
  launcherVersion: app.getVersion(),
})
const LEGAL_BLOCK_MESSAGE = 'Accept the Terms of Service and the Privacy Policy first: press Terms & Privacy at the bottom of the launcher.'

// Nexus nxm:// links: ours only while an install waits for the player's downloads, then back to Vortex or whichever
// manager had them (nxm.js)
const nxm = nxmLinks.createNxm({ store, log, ownExes: () => [process.execPath, path.join(mo2.getRoot(), 'nxmhandler.exe')] })
const nxmHandlerExe = () => (app.isPackaged ? process.execPath : path.join(mo2.getRoot(), 'nxmhandler.exe'))
let nxmWaiting = false

// Default install root for MO2 + the portable game copy when none is stored.
const DEFAULT_BASE_DIR = 'C:\\DragonBreak'

let win = null

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  // Each progress line is also the panel's detail line
  const line = channel === 'install:progress' ? args[0] && args[0].file : channel === 'isolated:progress' ? args[0] : null
  if (typeof line === 'string' && installTrack.running()) {
    installTrack.detail(line)
    sendInstallState()
  }
}

// Active server helper
// Returns the currently selected game server from the cached API list,
// or null if no servers have been fetched yet.
function activeServer() {
  const servers = store.get('cachedServers') || []
  if (servers.length === 0) return null
  const idx = Math.min(store.get('activeServerIndex') || 0, servers.length - 1)
  return servers[idx]
}

// Effective game path
// Creates an isolated copy, this keeps the base directory clean
function isolatedGameDir() {
  const base = store.get('baseDirPath')
  if (base) return path.join(base, 'skyrim')
  // Legacy layouts from before the base-dir structure
  const legacy = store.get('gameDirPath')
  if (legacy) return legacy
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(local, 'DragonBreak', 'GameDir')
}

// A usable game copy needs more than SkyrimSE.exe (it is copied first, so an interrupted run leaves it behind with a
// partial Data): the verified copy's record, the legacy completion marker written by copyGameDir, or for copies made
// before the marker the masters (copied nearly last, so their presence implies the BSAs made it too). isolation.js
function gameCopyComplete(dir) {
  return isolation.copyReady(dir)
}

function isolatedGameReady() {
  return gameCopyComplete(isolatedGameDir())
}

// Where the game runs and the client files go. In isolated mode it is the copy or nothing: never the Skyrim folder,
// so SKSE, the preloader DLLs, Data\Platform and the client settings cannot land in Steam's folder (phase 2 leak fix)
function effectiveGamePath() {
  return isolation.gamePathFor({
    isolated: !!store.get('isolatedGame'), copyReady: isolatedGameReady(), copyDir: isolatedGameDir(), skyrimPath: store.get('skyrimPath'),
  })
}

// What every install and launch path says when effectiveGamePath() is null
const noGamePathError = () => isolation.noGamePathError(!!store.get('isolatedGame'))

// The bundled vanilla list for the Skyrim folder's edition: null for Epic and Microsoft Store, ready false while the
// file in src is still the placeholder (or, for GOG, until a GOG list ships)
// and the language Steam installed it in (isolation.steamLanguage): a language without its own list stays legacy
const copyManifests = new Map()
function copyManifest(edition = mo2.detectEdition(store.get('skyrimPath')), language = isolation.steamLanguage(store.get('skyrimPath'))) {
  const key = `${edition}|${language}`
  if (!copyManifests.has(key)) copyManifests.set(key, isolation.manifestFor(edition, undefined, { language }))
  return copyManifests.get(key)
}

// 'verified' (only hash-checked files, the rest from Steam's depot download) once the list for the player's edition
// has files; until then 'legacy', today's copy by name from the Skyrim folder
function copyMode() {
  return isolation.copyMode({ isolated: !!store.get('isolatedGame'), manifest: copyManifest() })
}

// The folder whose version decides startup and PLAY: the copy once it is ready, so a changed Steam exe never blocks
// a good copy (isolation.versionGateDir)
function versionGateDir() {
  return isolation.versionGateDir({
    isolated: !!store.get('isolatedGame'), copyReady: isolatedGameReady(), copyDir: isolatedGameDir(),
    skyrimPath: store.get('skyrimPath'), mode: copyMode(),
  })
}

// downgrade.assess for that folder, or null when there is nothing to gate
function playTarget() {
  const dir = versionGateDir()
  if (!dir || !fs.existsSync(path.join(dir, 'SkyrimSE.exe'))) return null
  return downgrade.assess(dir, mo2.detectEdition(dir))
}

// Skyrim path auto-detection
// Registry keys the store editions write at install time, probed in order.
const SKYRIM_REGISTRY_PROBES = [
  { key: 'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1801825368', value: 'path' },   // Skyrim AE GOG
  { key: 'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1711230643', value: 'path' },   // Skyrim SE GOG
  { key: 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Steam App 489830', value: 'InstallLocation' },  // Steam
  { key: 'HKLM\\SOFTWARE\\WOW6432Node\\Bethesda Softworks\\Skyrim Special Edition', value: 'installed path' },
]

// GOG product ids differ per store listing, so enumerate the whole Games key
// instead of relying on the pinned ids above.
function gogSkyrimPaths() {
  const out = []
  for (const root of ['HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games', 'HKLM\\SOFTWARE\\GOG.com\\Games']) {
    let listing = ''
    try {
      listing = execFileSync('reg', ['query', root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch { continue }
    for (const line of listing.split(/\r?\n/)) {
      const key = line.trim()
      if (!key.startsWith('HK')) continue
      const p = regQueryValue(key, 'path')
      if (p) out.push(p)
    }
  }
  return out
}

// Common Steam library roots, for installs outside the default library.
function steamSkyrimPaths() {
  const out = []
  const suffix = path.join('steamapps', 'common', 'Skyrim Special Edition')
  for (const drive of ['C', 'D', 'E', 'F', 'G']) {
    out.push(path.join(`${drive}:\\`, 'Program Files (x86)', 'Steam', suffix))
    out.push(path.join(`${drive}:\\`, 'Steam', suffix))
    out.push(path.join(`${drive}:\\`, 'SteamLibrary', suffix))
    out.push(path.join(`${drive}:\\`, 'Games', 'Steam', suffix))
  }
  return out
}

// Read a single registry value via reg.exe (argv array, same pattern as mo2.js).
function regQueryValue(key, value) {
  try {
    const out = execFileSync('reg', ['query', key, '/v', value],
      { encoding: 'utf8', timeout: 5000, windowsHide: true })
    const m = out.match(/REG_(?:EXPAND_)?SZ\s+(.+)/)
    return m ? m[1].trim() : null
  } catch { return null }   // key or value missing
}

function isValidSkyrimPath(p) {
  return !!p && fs.existsSync(path.join(p, 'SkyrimSE.exe'))
}

// Stable per-machine id (Windows MachineGuid) for the backend ban system; null when unavailable, treated as optional.
function getHwid() {
  if (process.platform !== 'win32') return null
  const guid = regQueryValue('HKLM\\SOFTWARE\\Microsoft\\Cryptography', 'MachineGuid')
  return guid && /^[0-9a-fA-F-]{10,64}$/.test(guid) ? guid : null
}

// Fire-and-forget: attach this machine's hwid to the fresh play session.
async function reportHwid(token) {
  const hwid = getHwid()
  if (!hwid || !token) return
  try {
    await postJSON(`${config.apiUrl}/api/users/me/hwid`, { hwid }, { Authorization: `Bearer ${token}` })
  } catch (err) {
    log(`[hwid] report failed (${err.statusCode || err.message}) - continuing without it`)
  }
}

// First registry hit that exists on disk and contains SkyrimSE.exe, or null.
function detectSkyrimPath() {
  if (process.platform !== 'win32') return null
  for (const probe of SKYRIM_REGISTRY_PROBES) {
    const p = regQueryValue(probe.key, probe.value)
    if (isValidSkyrimPath(p)) return p
  }
  for (const p of gogSkyrimPaths()) {
    if (isValidSkyrimPath(p)) return p
  }
  for (const p of steamSkyrimPaths()) {
    if (isValidSkyrimPath(p)) return p
  }
  return null
}

// When the stored path is empty or invalid, auto-fill it from the registry and persist.
function ensureSkyrimPath() {
  const stored = store.get('skyrimPath')
  if (isValidSkyrimPath(stored)) return stored
  const detected = detectSkyrimPath()
  if (detected) {
    store.set('skyrimPath', detected)
    log(`[detect] Skyrim path auto-detected: ${detected}`)
  }
  return detected
}

ipcMain.handle('game:detectPath', () => {
  // Fill-only: the renderer shows the result and Save persists it
  return { path: detectSkyrimPath() }
})

// Window
function createWindow() {
  win = new BrowserWindow({
    width:     1280,
    height:    720,
    minWidth:  1024,
    minHeight: 600,
    frame:     false,
    resizable: true,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
    backgroundColor: '#080503',
    show: false,
  })

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  // Closing mid-install asks first; a re-run keeps finished downloads and installed mods
  win.on('close', (e) => {
    if (!installGate.running()) return
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Keep installing', 'Close anyway'], defaultId: 0, cancelId: 0, noLink: true,
      title: 'DragonBreak Online', message: 'An install is running. Close anyway?',
      detail: 'It picks up where it stopped next time: finished downloads and installed mods are kept, and only the file that was downloading starts again.',
    })
    if (choice !== 1) e.preventDefault()
  })
  win.once('ready-to-show', () => {
    win.show()
    // Chained so the two startup modals never stack
    maybeWarnNeverLaunched().then(() => {
      // Our copy decides once it is ready: another launcher's change to Steam's exe no longer opens the panel
      const target = playTarget()
      if (gameVersionProblem() || (target && target.action !== 'none')) showDowngradePanel()
    })
  })

  if (isDev) win.webContents.openDevTools({ mode: 'detach' })
}

app.whenReady().then(() => {
  ensureSkyrimPath()
  createWindow()
  // No install waits yet: links left with us by a crash, or by a launcher up to 2.1.29, go back
  nxm.release()
  // A Creations catalog still aside from a session that ended while the launcher was closed goes back
  putBackCatalogAtStart().catch(err => log(`[defaults] ${err.message}`))
  app.on('second-instance', (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus() }
    handleNxmArgv(argv)
  })
  handleNxmArgv(process.argv)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => { if (nxmWaiting) nxm.release() })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Window controls
ipcMain.on('window:minimize', () => win?.minimize())
ipcMain.on('window:maximize', () => {
  if (win?.isMaximized()) win.unmaximize()
  else win?.maximize()
})
ipcMain.on('window:close', () => win?.close())

// Settings
ipcMain.handle('settings:load', async () => {
  // Refresh the server list from the backend on every load.
  // On failure we keep the previously cached list so offline launches still work.
  try {
    const fetched = await fetchJSON(`${config.apiUrl}/api/servers`)
    if (Array.isArray(fetched) && fetched.length > 0) {
      store.set('cachedServers', fetched)
    }
  } catch { /* keep existing cache */ }

  // Auto-fill an empty/invalid Skyrim path from the registry (runs at startup and on settings open).
  ensureSkyrimPath()

  const servers = store.get('cachedServers') || []
  // Whitelist only what the renderer reads. Never spread the whole store: it
  // holds secrets (nexusApiKey, nexusOauth tokens, gameSession, gameProfileId)
  // the renderer must never receive.
  return {
    skyrimPath:        store.get('skyrimPath'),
    baseDirPath:       store.get('baseDirPath') || DEFAULT_BASE_DIR,
    activeServerIndex: store.get('activeServerIndex'),
    mo2Enabled:        store.get('mo2Enabled'),
    isolatedGame:      store.get('isolatedGame'),
    archiveDir:        store.get('archiveDir') || '',
    vortexDownloads:   vortexDownloadsDir(),
    servers,
    multiServer:       servers.length > 1,
    discordUser:       store.get('discordUser') || null,
  }
})
// Settings an install reads as it goes: where the game is, where things are installed, where archives live, and which
// install shape to use. Changing one mid-install would point later steps somewhere else than the earlier ones, so they
// are refused while the gate is held (Worker F's F1). Everything else still saves, so the server picker keeps working.
const INSTALL_SETTINGS = ['skyrimPath', 'baseDirPath', 'archiveDir', 'mo2Enabled', 'isolatedGame']
ipcMain.handle('settings:save', (_e, data) => {
  const allowed = ['skyrimPath', 'baseDirPath', 'activeServerIndex', 'mo2Enabled', 'isolatedGame', 'archiveDir']
  const clean = {}
  for (const k of allowed) if (k in (data || {})) clean[k] = data[k]
  if (installGate.running()) {
    const blocked = INSTALL_SETTINGS.filter(k => k in clean)
    if (blocked.length) {
      for (const k of blocked) delete clean[k]
      if (Object.keys(clean).length) store.set(clean)
      return { ok: false, error: installGate.refusal(), blocked }
    }
  }
  store.set(clean)
  return { ok: true }
})

// Graphics / hotkey settings (Settings tab)
// Graphics edit the MO2 portable profile's SkyrimPrefs.ini. NOTE: this assumes
// the DragonBreak profile uses profile-specific INI files; and if SSEDisplayTweaks is
// active it may override window mode via its own ini.
// Skyrim reads the two camera FOV settings from Skyrim.ini [Display], NOT from SkyrimPrefs.ini.
// SkyrimPrefs only holds fDefaultFOV [General], which is the menu and inventory view.
// The camera FOV the game will actually use, read from Skyrim.ini [Display]; falls back to whatever the
// caller found in SkyrimPrefs so an older profile still shows a sensible number.
function fovFromSkyrimIni(fallback) {
  try {
    const v = parseFloat(((ini.read(skyrimIniPath()) || {})['Display'] || {})['fDefaultWorldFOV'])
    if (Number.isFinite(v) && v >= 50 && v <= 140) return Math.round(v)
  } catch { /* no profile ini yet */ }
  return fallback
}
function skyrimIniPath() {
  return path.join(mo2.getProfileDir(), 'skyrim.ini')
}
function skyrimPrefsPath() {
  return path.join(mo2.getProfileDir(), 'skyrimprefs.ini')
}
// Server hotkeys live in the Skyrim Platform client settings (the object exposed
// to the client as settings["skymp5-client"] - the file content is that object).
// null without a game folder (isolated mode before the copy is ready): never a path relative to the launcher's folder
function clientSettingsPath() {
  const gp = effectiveGamePath()
  return gp ? path.join(gp, 'Data', 'Platform', 'Plugins', 'skymp5-client-settings.txt') : null
}
function readClientSettings() {
  const f = clientSettingsPath()
  if (!f) return {}
  try {
    const obj = JSON.parse(fs.readFileSync(f, 'utf8'))
    return obj && typeof obj === 'object' ? obj : {}
  } catch { return {} }
}

ipcMain.handle('graphics:load', () => {
  try {
    const p = skyrimPrefsPath()
    const data = ini.read(p)
    const disp = data['Display'] || {}
    const controls = data['Controls'] || {}
    const full = String(disp['bFull Screen'] || '0') === '1'
    // Default to borderless when the ini doesn't say otherwise (missing file
    // or keys). An explicit bFull Screen=0 + bBorderless=0 reads as windowed.
    const hasMode = ('bFull Screen' in disp) || ('bBorderless' in disp)
    const borderless = hasMode ? String(disp['bBorderless'] || '0') === '1' : true
    // Fallback chain for player-owned values: profile ini, then the player's
    // original My Games ini, then the engine default.
    let orig = {}
    try {
      const src = findOriginalPrefsIni()
      if (src) orig = ini.read(src)
    } catch { /* fall through to defaults */ }
    const origDisp = orig['Display'] || {}
    const val = (section, key, dflt) => {
      const a = data[section] || {}
      if (key in a) return String(a[key])
      const b = orig[section] || {}
      if (key in b) return String(b[key])
      return dflt
    }
    const num = (section, key, dflt) => {
      const n = parseInt(val(section, key, ''), 10)
      return Number.isNaN(n) ? dflt : n
    }
    const skip = num('Display', 'iTexMipMapSkip', 0)
    const shadowRes = num('Display', 'iShadowMapResolution', 2048)
    const reflH = num('Water', 'iWaterReflectHeight', 512)
    const maxDecals = num('Decals', 'uMaxDecals', 250)
    return {
      ok: true,
      path: p,
      exists: fs.existsSync(p),
      windowMode: full ? 'fullscreen' : (borderless ? 'borderless' : 'windowed'),
      width:  disp['iSize W'] || origDisp['iSize W'] || '1920',
      height: disp['iSize H'] || origDisp['iSize H'] || '1080',
      invertY: String(controls['bInvertYValues'] || '0') === '1',
      // Read back from the file the game actually reads it from. 80 is Skyrim's own default, so the box
      // shows what the player has rather than a guess.
      fov: fovFromSkyrimIni(num('General', 'fDefaultFOV', 80)),
      texQuality: skip >= 2 ? 'low' : (skip === 1 ? 'medium' : 'high'),
      aa: val('Display', 'bUseTAA', '1') === '1' ? 'taa'
        : (val('Display', 'bFXAAEnabled', '0') === '1' ? 'fxaa' : 'off'),
      shadowQuality: shadowRes <= 512 ? 'low' : (shadowRes <= 1024 ? 'medium' : (shadowRes <= 2048 ? 'high' : 'ultra')),
      decals: val('Decals', 'bDecals', '1') === '0' ? 'off'
        : (maxDecals <= 100 ? 'low' : (maxDecals <= 250 ? 'medium' : (maxDecals <= 350 ? 'high' : 'ultra'))),
      reflections: reflH >= 1024
        ? (val('Water', 'bReflectLODTrees', '0') === '1' ? 'ultra' : 'high')
        : (val('Water', 'bReflectLODLand', '0') === '1' ? 'medium' : 'low'),
      godrays:   val('Display', 'bVolumetricLightingEnable', '1') === '1',
      lensFlare: val('Imagespace', 'bLensFlare', '1') === '1',
      ao:        val('Display', 'bSAOEnable', '1') === '1',
      precip:    val('Display', 'bPrecipitationOcclusion', '1') === '1',
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('graphics:save', (_e, g) => {
  try {
    g = g || {}
    const display = {}
    const general = {}
    if (g.windowMode === 'fullscreen')      { display['bFull Screen'] = '1'; display['bBorderless'] = '0' }
    else if (g.windowMode === 'borderless') { display['bFull Screen'] = '0'; display['bBorderless'] = '1' }
    else if (g.windowMode === 'windowed')   { display['bFull Screen'] = '0'; display['bBorderless'] = '0' }
    if (g.width)  display['iSize W'] = String(g.width)
    if (g.height) display['iSize H'] = String(g.height)
    // Field of view. Three settings in two files, and they are not interchangeable:
    //   Skyrim.ini      [Display] fDefaultWorldFOV      third person
    //   Skyrim.ini      [Display] fDefault1stPersonFOV  first person
    //   SkyrimPrefs.ini [General] fDefaultFOV           menus, inventory, lockpicking
    // 2.1.31 shipped all of it into SkyrimPrefs [Display], which the game does not read, so the setting
    // did nothing. Both halves are written now, and the client re-applies the pair after the character
    // creator, which sets its own close-up value and never restores it.
    const fov = Number(g.fov)
    const fovValue = Number.isFinite(fov) && fov >= 50 && fov <= 140 ? String(Math.round(fov)) : ''
    if (fovValue) general['fDefaultFOV'] = fovValue
    const TEX = { high: '0', medium: '1', low: '2' }
    if (TEX[g.texQuality]) display['iTexMipMapSkip'] = TEX[g.texQuality]
    if (['off', 'fxaa', 'taa'].includes(g.aa)) {
      display['bUseTAA']      = g.aa === 'taa'  ? '1' : '0'
      display['bFXAAEnabled'] = g.aa === 'fxaa' ? '1' : '0'
    }
    const SHADOW = { low: '512', medium: '1024', high: '2048', ultra: '4096' }
    if (SHADOW[g.shadowQuality]) display['iShadowMapResolution'] = SHADOW[g.shadowQuality]
    if (typeof g.godrays === 'boolean') display['bVolumetricLightingEnable'] = g.godrays ? '1' : '0'
    if (typeof g.ao === 'boolean')      display['bSAOEnable'] = g.ao ? '1' : '0'
    if (typeof g.precip === 'boolean')  display['bPrecipitationOcclusion'] = g.precip ? '1' : '0'
    const edits = { Display: display, Controls: { bInvertYValues: g.invertY ? '1' : '0' } }
    if (typeof g.lensFlare === 'boolean') {
      display['bIBLFEnable'] = g.lensFlare ? '1' : '0'
      edits.Imagespace = { bLensFlare: g.lensFlare ? '1' : '0' }
    }
    const DECALS = {
      off:    { bDecals: '0', bSkinnedDecals: '0' },
      low:    { bDecals: '1', bSkinnedDecals: '1', uMaxDecals: '100',  uMaxSkinDecals: '25',  uMaxSkinDecalsPerActor: '20' },
      medium: { bDecals: '1', bSkinnedDecals: '1', uMaxDecals: '250',  uMaxSkinDecals: '50',  uMaxSkinDecalsPerActor: '40' },
      high:   { bDecals: '1', bSkinnedDecals: '1', uMaxDecals: '350',  uMaxSkinDecals: '75',  uMaxSkinDecalsPerActor: '50' },
      ultra:  { bDecals: '1', bSkinnedDecals: '1', uMaxDecals: '1000', uMaxSkinDecals: '100', uMaxSkinDecalsPerActor: '60' },
    }
    if (DECALS[g.decals]) edits.Decals = DECALS[g.decals]
    const REFLECTIONS = {
      low:    { iWaterReflectHeight: '512',  iWaterReflectWidth: '512',  bReflectLODLand: '0', bReflectLODObjects: '0', bReflectLODTrees: '0', bReflectSky: '0' },
      medium: { iWaterReflectHeight: '512',  iWaterReflectWidth: '512',  bReflectLODLand: '1', bReflectLODObjects: '0', bReflectLODTrees: '0', bReflectSky: '1' },
      high:   { iWaterReflectHeight: '1024', iWaterReflectWidth: '1024', bReflectLODLand: '1', bReflectLODObjects: '1', bReflectLODTrees: '0', bReflectSky: '1' },
      ultra:  { iWaterReflectHeight: '1024', iWaterReflectWidth: '1024', bReflectLODLand: '1', bReflectLODObjects: '1', bReflectLODTrees: '1', bReflectSky: '1' },
    }
    if (REFLECTIONS[g.reflections]) edits.Water = Object.assign({ bUseWaterReflections: '1' }, REFLECTIONS[g.reflections])
    if (Object.keys(general).length) edits.General = Object.assign({}, edits.General || {}, general)
    ini.write(skyrimPrefsPath(), edits)
    // The two camera FOV settings live in Skyrim.ini, so they are a second write to a different file.
    // ini.write keeps every other key, and a missing profile Skyrim.ini is seeded elsewhere at install.
    if (fovValue && fs.existsSync(skyrimIniPath())) {
      try {
        ini.write(skyrimIniPath(), { Display: { fDefaultWorldFOV: fovValue, fDefault1stPersonFOV: fovValue } })
      } catch (err) {
        log('[graphics] could not write the field of view to Skyrim.ini:', err.message)
      }
    }
    return { ok: true, path: skyrimPrefsPath() }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('hotkeys:load', () => {
  try {
    const c = readClientSettings()
    migrateHotkeyDefaults(c)
    const numOrNull = (v) => (typeof v === 'number' ? v : null)
    return {
      ok: true,
      path: clientSettingsPath(),
      chatFocus:  Array.isArray(c.chatFocusKeyCodes) ? c.chatFocusKeyCodes : null,
      freeCursor: numOrNull(c.freeCursorKeyCode),
      housing:    numOrNull(c.housingMenuKeyCode),
      faction:    numOrNull(c.factionMenuKeyCode),
      personal:   numOrNull(c.personalMenuKeyCode),
      voicePtt:   numOrNull(c.voicePushToTalkKeyCode),
      adminMenu:  numOrNull(c.adminMenuKeyCode),
      hideUi:     numOrNull(c.hideUiKeyCode),
      skills:     numOrNull(c.masteryMenuKeyCode),
      emote:      numOrNull(c.emoteWheelKeyCode),
      nametag:    numOrNull(c.nametagKeyCode),
      voiceMode:  numOrNull(c.voiceModeKeyCode),
      mask:       numOrNull(c.maskToggleKeyCode),
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// Voice tab and Interface section: player preferences that live beside the hotkeys in the client settings file
ipcMain.handle('clientprefs:load', () => {
  try {
    const c = readClientSettings()
    return { ok: true, voice: c.voice && typeof c.voice === 'object' ? c.voice : {}, uiScale: Number(c.uiScale) || 0, panelScaleReset: Number(c.panelScaleReset) || 0 }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('clientprefs:save', (_e, p) => {
  try {
    p = p || {}
    const c = readClientSettings()
    if (p.voice && typeof p.voice === 'object') c.voice = p.voice
    if (typeof p.uiScale === 'number') { if (p.uiScale > 0) c.uiScale = p.uiScale; else delete c.uiScale }
    if (typeof p.panelScaleReset === 'number' && p.panelScaleReset > 0) c.panelScaleReset = p.panelScaleReset
    const f = clientSettingsPath()
    if (!f) return { ok: false, error: noGamePathError() }
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify(c, null, 2))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('hotkeys:save', (_e, h) => {
  try {
    h = h || {}
    const c = readClientSettings()
    migrateHotkeyDefaults(c)
    if (Array.isArray(h.chatFocus))        c.chatFocusKeyCodes  = h.chatFocus.filter(n => typeof n === 'number')
    if (typeof h.freeCursor === 'number')  c.freeCursorKeyCode  = h.freeCursor
    if (typeof h.housing === 'number')     { c.housingMenuKeyCode = h.housing; c.playerActionKeyCode = h.housing }
    if (typeof h.faction === 'number')     c.factionMenuKeyCode = h.faction
    if (typeof h.personal === 'number')    c.personalMenuKeyCode = h.personal
    if (typeof h.voicePtt === 'number')    c.voicePushToTalkKeyCode = h.voicePtt
    if (typeof h.adminMenu === 'number')   c.adminMenuKeyCode = h.adminMenu
    if (typeof h.hideUi === 'number')      c.hideUiKeyCode = h.hideUi
    if (typeof h.skills === 'number')      c.masteryMenuKeyCode = h.skills
    if (typeof h.emote === 'number')       c.emoteWheelKeyCode = h.emote
    if (typeof h.nametag === 'number')     c.nametagKeyCode = h.nametag
    if (typeof h.voiceMode === 'number')   c.voiceModeKeyCode = h.voiceMode
    if (typeof h.mask === 'number')        c.maskToggleKeyCode = h.mask
    const p = clientSettingsPath()
    if (!p) return { ok: false, error: noGamePathError() }
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(c, null, 2))
    return { ok: true, path: p }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// Game hotkeys edit the keyboard column of the game's controlmap.txt.
// Values are DirectInput scan codes, the same space the renderer's KEY_TABLE uses.
const GAME_HOTKEY_EVENTS = ['Activate', 'Jump', 'Sprint', 'Sneak', 'Shout', 'Toggle POV']

function controlmapPath() {
  const gp = effectiveGamePath()
  return gp ? path.join(gp, 'Data', 'Interface', 'Controls', 'PC', 'controlmap.txt') : ''
}

const CONTROLMAP_SEED = path.join(__dirname, '..', 'assets', 'controlmap.txt')

function readControlmapText() {
  const p = controlmapPath()
  if (p && fs.existsSync(p)) return { path: p, text: upgradeControlmapText(fs.readFileSync(p, 'utf8')), exists: true }
  return { path: p, text: controlmapCheck.toCrlf(fs.readFileSync(CONTROLMAP_SEED, 'utf8')), exists: false }
}

function controlmapEventRe(ev) {
  const escaped = ev.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('^(' + escaped + '[ \\t]+)(0x[0-9a-fA-F]+)', 'm')
}

// Stale launcher copies lack the AE Creations Menu context or still bind Wait on the gamepad
function isStaleLauncherControlmap(text) {
  if (!/launcher controlmap override/.test(text)) return false
  const wait = text.match(/^Wait[ \t]+\S+[ \t]+\S+[ \t]+(\S+)/m)
  return !/^PurchaseCredits[ \t]/m.test(text) || (!!wait && wait[1].toLowerCase() !== '0xff')
}

// Rebuilds a stale launcher copy from the seed, keeping the keyboard rebinds the Settings tab manages
function upgradeControlmapText(text) {
  if (!isStaleLauncherControlmap(text)) return text
  let upgraded = fs.readFileSync(CONTROLMAP_SEED, 'utf8')
  for (const ev of GAME_HOTKEY_EVENTS) {
    const m = text.match(controlmapEventRe(ev))
    if (m) upgraded = upgraded.replace(controlmapEventRe(ev), (_m, head) => head + m[2])
  }
  return upgraded
}

// Seeds the Wait-unbound controlmap when the game has none, upgrades a stale launcher copy and gives a launcher copy
// with LF-only lines CRLF, as the vanilla map has (launchers built on CT 115 wrote LF from 27 Sep). A player's own map
// is never touched here; controlmapCheck judges those.
function applyControlmapOverride(gamePath) {
  try {
    if (!gamePath) return
    const dest = path.join(gamePath, 'Data', 'Interface', 'Controls', 'PC', 'controlmap.txt')
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, controlmapCheck.toCrlf(fs.readFileSync(CONTROLMAP_SEED, 'utf8')))
      log('[defaults] wrote controlmap override (Wait unbound on keyboard and gamepad) to ' + dest)
      return
    }
    const text = fs.readFileSync(dest, 'utf8')
    let next = upgradeControlmapText(text)
    const why = next !== text ? 'rebuilt the stale controlmap override from the current seed' : ''
    const ours = /launcher controlmap override/.test(next)
    if (ours && controlmapCheck.bareLfCount(next)) next = controlmapCheck.toCrlf(next)
    if (next !== text) {
      fs.writeFileSync(dest, next)
      log(`[defaults] ${why || 'gave the controlmap override CRLF line endings, as the game\'s own map has,'} at ${dest}`)
    }
  } catch (err) {
    log('[defaults] could not write controlmap override:', err.message)
  }
}

ipcMain.handle('gameHotkeys:load', () => {
  try {
    const cm = readControlmapText()
    const keys = {}
    for (const ev of GAME_HOTKEY_EVENTS) {
      const m = cm.text.match(controlmapEventRe(ev))
      keys[ev] = m ? parseInt(m[2], 16) : null
    }
    return { ok: true, path: cm.path, exists: cm.exists, hasGamePath: !!cm.path, keys }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('gameHotkeys:save', (_e, keys) => {
  try {
    const p = controlmapPath()
    if (!p) return { ok: false, error: 'Skyrim path is not configured yet' }
    let { text } = readControlmapText()
    for (const [ev, code] of Object.entries(keys || {})) {
      if (!GAME_HOTKEY_EVENTS.includes(ev) || typeof code !== 'number' || code <= 0 || code > 0xff) continue
      const hex = '0x' + code.toString(16)
      text = text.replace(controlmapEventRe(ev), (_m, head) => head + hex)
    }
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, controlmapCheck.toCrlf(text))
    return { ok: true, path: p }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// Forced server defaults
// The server ships a couple of required defaults. We apply them once, when the
// DragonBreak install is first set up, so later tweaks in the Settings tab aren't
// reverted on every client update:
//   • borderless window mode → MO2 profile's SkyrimPrefs.ini [Display]
//     (resolution is player-owned: it comes from the seeded ini, or the
//      Settings tab default when the ini doesn't specify one)
//   • Wait unbound (T, pad Back) → controlmap override (waiting is disabled here)
function applyForcedServerDefaults(gamePath) {
  // One-time repair for profiles created before resolution became
  // player-owned: earlier builds force-stamped 1920x1080 into the profile
  // ini, hiding the player's real resolution. Re-import it once from the
  // original My Games ini; from then on the Settings tab owns the values.
  if (!store.get('resolutionMigrated')) {
    try {
      const src  = findOriginalPrefsIni()
      const prof = skyrimPrefsPath()
      if (src && fs.existsSync(prof)) {
        const orig = ini.read(src)['Display'] || {}
        if (orig['iSize W'] && orig['iSize H']) {
          ini.write(prof, { Display: { 'iSize W': String(orig['iSize W']), 'iSize H': String(orig['iSize H']) } })
          log(`[defaults] re-imported resolution ${orig['iSize W']}x${orig['iSize H']} from the original ini`)
        }
      }
      store.set('resolutionMigrated', true)
    } catch (err) {
      log('[defaults] resolution migration failed:', err.message)
    }
  }

  // Graphics: force borderless window mode. ini.write preserves every other
  // key, including whatever resolution the player's ini carries.
  if (!store.get('forcedDefaultsApplied')) {
    try {
      ini.write(skyrimPrefsPath(), {
        Display: { 'bFull Screen': '0', 'bBorderless': '1' },
      })
      store.set('forcedDefaultsApplied', true)
      log('[defaults] forced borderless window mode into SkyrimPrefs.ini')
    } catch (err) {
      log('[defaults] could not write graphics defaults:', err.message)
    }
  }

  // Skyrim writes bGamepadEnable=1 back on every exit with a controller connected, and gamepad mode leaves no mouse cursor in menus
  if (fs.existsSync(skyrimPrefsPath())) {
    try {
      ini.write(skyrimPrefsPath(), { MAIN: { bGamepadEnable: '0' } })
      log('[defaults] turned the controller off in SkyrimPrefs.ini')
    } catch (err) {
      log('[defaults] could not turn the controller off:', err.message)
    }
  }

  applyControlmapOverride(gamePath)

  // AE popup suppression, re-applied on every install pass so existing installs pick it up.
  try {
    // Portable copies only: never blank the ccc of a player's real install.
    if (gamePath && store.get('isolatedGame') && gamePath === isolatedGameDir()) {
      const ccc = path.join(gamePath, 'Skyrim.ccc')
      if (!fs.existsSync(ccc) || fs.statSync(ccc).size > 0) {
        fs.writeFileSync(ccc, '')
        log('[defaults] wrote empty Skyrim.ccc (no CC content expected)')
      }
    }
  } catch (err) {
    log('[defaults] could not write Skyrim.ccc:', err.message)
  }
  // Creations manifests the engine cached from Bethesda.net (Creations menu) are parsed at startup, and a
  // malformed one throws inside the engine ("invalid stoull argument" in InstalledContent, 20-30 s in, before the
  // main menu). The copy never uses that content, so the cache is emptied every launch.
  try {
    const dir = path.join(gamePath, 'Creations')
    if (fs.existsSync(dir)) {
      let n = 0
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        try { fs.rmSync(p, { recursive: true, force: true }); n++ } catch { /* locked by the game */ }
      }
      if (n) log(`[defaults] emptied the Creations cache (${n} entr${n === 1 ? 'y' : 'ies'})`)
    }
  } catch (err) {
    log('[defaults] could not clear the Creations cache:', err.message)
  }
  // The Creations catalog in %LOCALAPPDATA% is moved aside right before a launch instead (moveCatalogForLaunch), so an
  // install pass that does not launch leaves the player's catalog where it is.
  // Profile ini: kill the Bethesda.net platform, which drives the "AE content available for download" prompt and the CC news.
  try {
    const dest = path.join(mo2.getProfileDir(), 'skyrim.ini')
    // Seed from the player's own ini first so a minimal profile ini never hides their settings (language, archives, etc).
    seedProfileSkyrimIni(gamePath)
    const cur = ini.read(dest)['Bethesda.net'] || {}
    if (String(cur['bEnablePlatform'] || '') !== '0') {
      ini.write(dest, { 'Bethesda.net': { bEnablePlatform: '0' } })
      log('[defaults] disabled the Bethesda.net platform in the profile Skyrim.ini')
    }
    // Skyrim Platform writes the spawn save to My Games\Skyrim Special Edition\Saves\ and asks the engine to load it by
    // name; an ini seeded from a Vortex profile points SLocalSavePath at a subfolder, so the engine never finds it and
    // the player stays on the main menu after Create.
    const general = ini.read(dest)['General'] || {}
    const savePath = String(general['SLocalSavePath'] || '').trim()
    if (savePath && savePath.replace(/[\\/]+$/, '').toLowerCase() !== 'saves') {
      ini.write(dest, { General: { SLocalSavePath: 'Saves\\' } })
      log(`[defaults] profile Skyrim.ini SLocalSavePath was "${savePath}"; reset to Saves\\ so the spawn save is found`)
    }
    // sTestFileN lines force-load plugins regardless of plugins.txt (Vortex and the vanilla launcher leave them
    // behind); the server's load order is the only one allowed, so they go.
    try {
      const raw = fs.readFileSync(dest, 'utf8')
      const eol = raw.includes('\r\n') ? '\r\n' : '\n'
      const kept = raw.split(/\r?\n/).filter(l => !/^\s*sTestFile\d+\s*=/i.test(l))
      const dropped = raw.split(/\r?\n/).length - kept.length
      if (dropped > 0) { fs.writeFileSync(dest, kept.join(eol)); log(`[defaults] removed ${dropped} sTestFile line(s) from the profile Skyrim.ini`) }
    } catch { /* the ini is rewritten on the next launch */ }
  } catch (err) {
    log('[defaults] could not write the profile Skyrim.ini:', err.message)
  }

  // MO2 only honors the profile inis the Settings tab edits when local settings are enabled.
  try {
    const settingsIni = path.join(mo2.getProfileDir(), 'settings.ini')
    const general = ini.read(settingsIni)['General'] || {}
    if (String(general['LocalSettings'] || '') !== 'true') {
      ini.write(settingsIni, { General: { LocalSettings: 'true', LocalSaves: 'false' } })
      log('[defaults] enabled profile-local inis in the MO2 profile')
    }
  } catch (err) {
    log('[defaults] could not enable profile-local inis:', err.message)
  }
}

// Folder picker
ipcMain.handle('dialog:openFolder', async (_e, title) => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title: typeof title === 'string' && title ? title : 'Select Skyrim Installation Folder',
  })
  return result.canceled ? null : result.filePaths[0]
})

// Copy Log in the Repair tab
ipcMain.handle('clipboard:write', (_e, text) => { try { clipboard.writeText(String(text || '')); return true } catch { return false } })

// Open external URL - http/https only
ipcMain.on('open:external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    shell.openExternal(url)
  }
})

// News
ipcMain.handle('api:news', async () => {
  try {
    const items = await fetchJSON(`${config.apiUrl}/api/news`)
    return { ok: true, items: Array.isArray(items) ? items : [] }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// Server status
ipcMain.handle('api:status', async () => {
  try {
    const data = await fetchJSON(`${config.apiUrl}/api/status`)
    // The public /api/status is answered by a status probe that carries no player count (2026-09-27: Leerod asked for
    // one; the badge only showed ONLINE). /api/servers always has it, so the count comes from there when missing.
    if (data && data.players == null) {
      try {
        const list = await fetchJSON(`${config.apiUrl}/api/servers`)
        // The selected server, picked the way activeServer() picks it from the cached list
        const idx = Array.isArray(list) && list.length ? Math.min(store.get('activeServerIndex') || 0, list.length - 1) : -1
        const online = idx >= 0 ? Number(list[idx].online) : NaN
        if (Number.isFinite(online)) data.players = online
      } catch { /* no count: the badge shows ONLINE alone */ }
    }
    return { ok: true, ...data }
  } catch {
    return { ok: false }
  }
})

// Server info
// Include the stored session token so the backend's session-aware `allowed`
// field reflects whether this user is on the whitelist / server lock list.
ipcMain.handle('api:serverinfo', async () => {
  const session = store.get('gameSession')
  const headers = session ? { 'x-session': session } : {}
  let info
  try { info = await fetchJSON(`${config.apiUrl}/api/serverinfo`, headers) }
  catch { return null }
  // sessionValid:false with a session sent means the stored login expired, not a whitelist verdict
  if (session && info && info.sessionValid === false) {
    log('[discord] stored session is no longer valid - cleared, user must log in again')
    clearDiscordAuth()
    return { ...info, sessionExpired: true }
  }
  return info
})

// Discord OAuth

ipcMain.handle('discord:getUser', () => store.get('discordUser') || null)

function clearDiscordAuth() {
  legal.reset()
  store.set('discordUser',   null)
  store.set('gameProfileId', null)
  store.set('gameSession',   null)

  // Clear auth-data-no-load.js so the SkyMP in-game client reverts to showing
  // its own Discord OAuth dialog (//null is read as null by the SkyMP client).
  const skyrimPath = effectiveGamePath()
  if (skyrimPath) {
    const authDataPath = path.join(skyrimPath, 'Data', 'Platform', 'PluginsNoLoad', 'auth-data-no-load.js')
    try { fs.writeFileSync(authDataPath, '//null') } catch { /* file may not exist yet */ }
  }
}

// A 401 means the stored login expired: cleared here like the launch check does, so the window asks for a new one
ipcMain.handle('legal:load', () => legal.load())
ipcMain.handle('legal:status', async () => {
  const s = await legal.status()
  if (s.sessionExpired) clearDiscordAuth()
  return s
})
ipcMain.handle('legal:accept', async (_e, version) => {
  const r = await legal.accept(typeof version === 'string' ? version : '')
  if (r.sessionExpired) clearDiscordAuth()
  return r
})

ipcMain.handle('discord:logout', () => {
  clearDiscordAuth()
  return { success: true }
})

ipcMain.handle('discord:login', async () => {
  const state = crypto.randomBytes(32).toString('hex')

  // Open the backend's login-discord URL in the user's default browser.
  // The backend registers the state, redirects to Discord, exchanges the code
  // on callback, and makes the result available at the /status endpoint.
  shell.openExternal(`${config.apiUrl}/api/users/login-discord?state=${state}`)

  // Poll the status endpoint until auth completes or times out (5 minutes).
  const POLL_INTERVAL_MS = 2000
  const deadline = Date.now() + 5 * 60 * 1000
  let unexpectedStreak = 0    // consecutive non-401 poll failures
  let stateRegistered  = false // backend has answered 401 (= browser reached /login-discord)

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))

    let data
    try {
      data = await fetchJSON(
        `${config.apiUrl}/api/users/login-discord/status?state=${encodeURIComponent(state)}`
      )
    } catch (err) {
      if (err.statusCode === 401) { stateRegistered = true; unexpectedStreak = 0; continue }  // still pending - keep polling
      if (err.statusCode === 403) {
        // The state only exists server-side once the browser loads the login
        // URL. A 403 before we ever saw it pending just means the browser is
        // still opening (cold start, open-link prompt) - keep waiting.
        if (!stateRegistered) { unexpectedStreak = 0; continue }
        return { success: false, error: 'Login attempt expired - please try again.' }
      }

      // Anything else (cross-host redirect, 404 from a stale backend, 5xx,
      // network blip): keep polling briefly, but give up with the real reason
      // instead of burning the full five minutes in silence.
      unexpectedStreak++
      log(`[discord] status poll failed (${err.statusCode ? 'HTTP ' + err.statusCode : err.message}), ${unexpectedStreak} in a row`)
      if (unexpectedStreak >= 10) {
        return {
          success: false,
          error: `Cannot read the login status from the backend (${err.statusCode ? 'HTTP ' + err.statusCode : err.message}).`,
        }
      }
      continue
    }
    unexpectedStreak = 0

    // 200 OK - auth complete.
    // token is the play-session token; masterApiId is the stable numeric profileId.
    const { token, masterApiId, discordUsername, discordAvatar } = data

    const discordUser = {
      username: discordUsername || `Player ${masterApiId}`,
      tag:      discordUsername || `Player ${masterApiId}`,
      avatar:   discordAvatar   || null,
    }

    store.set('discordUser',   discordUser)
    store.set('gameProfileId', masterApiId)
    store.set('gameSession',   token)
    log(`[discord] logged in as ${discordUser.username} (profileId ${masterApiId})`)

    reportHwid(token) // not awaited: login must not block on the ban-system hwid

    return { success: true, user: discordUser }
  }

  return { success: false, error: 'Login timed out - please try again.' }
})

// MO2 integration

ipcMain.handle('mo2:status', () => mo2.getStatus())

ipcMain.handle('mo2:open', () => {
  try { mo2.openUI(); return { success: true } }
  catch (err) { return { success: false, error: err.message } }
})

// Open the portable install (base) folder in the OS file manager.
ipcMain.handle('install:openFolder', async () => {
  const dir = store.get('baseDirPath') || mo2.getRoot()
  if (!dir || !fs.existsSync(dir)) {
    return { success: false, error: 'No portable install folder yet - set one up first.' }
  }
  const err = await shell.openPath(dir)
  return err ? { success: false, error: err } : { success: true }
})

// Nexus Mods login

ipcMain.handle('nexus:getUser', () => store.get('nexusUser') || null)

ipcMain.handle('nexus:logout', () => {
  store.set('nexusApiKey', '')
  store.set('nexusOauth', null)
  store.set('nexusUser', null)
  return { success: true }
})

// One-click web login. Prefers OAuth (authorization code + PKCE) when a
// client id is configured; falls back to the older websocket SSO when only
// the application slug is set. The renderer flow is identical either way.
ipcMain.handle('nexus:ssoAvailable', () => !!(config.nexusOauthClientId || config.nexusAppSlug))

// Current Nexus credential for API calls: OAuth bearer (refreshed when close
// to expiry) or the SSO-era API key. Null when logged out.
async function getNexusAuth() {
  const oauth = store.get('nexusOauth')
  if (oauth && oauth.accessToken) {
    const nearExpiry = oauth.expiresAt && Date.now() > oauth.expiresAt - 60_000
    if (nearExpiry && oauth.refreshToken && config.nexusOauthClientId) {
      try {
        const t = await nexus.refreshOauth(config.nexusOauthClientId, oauth.refreshToken)
        const next = {
          accessToken:  t.access_token,
          refreshToken: t.refresh_token || oauth.refreshToken,
          expiresAt:    Date.now() + (t.expires_in ? t.expires_in * 1000 : 6 * 3600 * 1000),
        }
        store.set('nexusOauth', next)
        log('[nexus] OAuth token refreshed')
        return { bearer: next.accessToken }
      } catch (err) {
        log('[nexus] token refresh failed:', err.message)
        // The old token may still work; the API answers 401 if not.
      }
    }
    return { bearer: oauth.accessToken }
  }
  const key = store.get('nexusApiKey')
  return key ? { apiKey: key } : null
}

ipcMain.handle('nexus:ssoLogin', async () => {
  try {
    if (config.nexusOauthClientId) {
      const tokens = await nexus.oauthLogin({
        clientId: config.nexusOauthClientId,
        port:     config.nexusOauthPort,
        openUrl:  url => shell.openExternal(url),
      })
      store.set('nexusOauth', {
        accessToken:  tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        expiresAt:    Date.now() + (tokens.expires_in ? tokens.expires_in * 1000 : 6 * 3600 * 1000),
      })
      store.set('nexusApiKey', '')   // the bearer token replaces any old key
      const user = await nexus.oauthUserInfo(tokens.access_token)
      store.set('nexusUser', user)
      log(`[nexus] OAuth login as ${user.name} (premium: ${user.isPremium})`)
      return { success: true, user }
    }

    if (!config.nexusAppSlug) {
      return { success: false, error: 'Nexus login is not configured in this build (missing OAuth client id / application slug).' }
    }
    const apiKey = await nexus.ssoLogin(config.nexusAppSlug, url => shell.openExternal(url))
    const user   = await nexus.validateKey(apiKey)
    store.set('nexusApiKey', apiKey)
    store.set('nexusUser', user)
    log(`[nexus] SSO login as ${user.name} (premium: ${user.isPremium})`)
    return { success: true, user }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// Isolated game copy

ipcMain.handle('game:isolatedStatus', () => ({
  enabled: !!store.get('isolatedGame'),
  ready:   isolatedGameReady(),
  dir:     isolatedGameDir(),
  base:    store.get('baseDirPath') || '',
}))

// True if either path is the same as, or nested inside, the other; junctions are followed so a linked folder compares as its target.
function pathsOverlap(a, b) {
  const real = p => { try { return fs.realpathSync.native(p) } catch { return path.resolve(p) } }
  const norm = p => real(p).replace(/[\\/]+$/, '').toLowerCase() + path.sep
  const na = norm(a), nb = norm(b)
  return na.startsWith(nb) || nb.startsWith(na)
}

ipcMain.handle('game:createIsolated', async (_e, baseDirOverride, opts) => {
  const gate = beginInstall('the game copy')
  if (!gate.ok) return { success: false, error: gate.error }
  try {
    return await createIsolatedImpl(baseDirOverride, !!(opts && opts.force))
  } finally {
    endInstall()
  }
})

// force re-copies (legacy) or re-checks by hash (verified) every vanilla file; SKSE, client files and the controlmap in
// the copy are other Repair sections and stay. progress, when given, also receives the verified copy's progress events
// (the Skyrim Version panel passes one).
async function createIsolatedImpl(baseDirOverride, force = false, { progress = null } = {}) {
  const src = store.get('skyrimPath')
  if (!src || !fs.existsSync(path.join(src, 'SkyrimSE.exe'))) {
    return { success: false, error: 'Set a valid Skyrim path first (SkyrimSE.exe not found).' }
  }
  const edition = mo2.detectEdition(src)
  // The verified copy takes only files whose sha256 matches the bundled list and gets the rest from Steam's own
  // download, so Steam may be on any build. The legacy copy (no list for this edition yet) copies by name from the
  // Skyrim folder, which therefore has to be the right build.
  const verified = isolation.copyMode({ isolated: true, manifest: copyManifest(edition) }) === 'verified'

  // Install target: the Install Location field, else the stored/default base dir, nested under \DragonBreak. Worked
  // out first, because the gates below need to know whether a working copy is already there.
  const base = isolation.resolveBase({ override: baseDirOverride, stored: store.get('baseDirPath'), fallback: DEFAULT_BASE_DIR })
  const dst = path.join(base, 'skyrim')

  // Nothing is ever written through a link inside the copy (a Data junction into the Steam folder)
  const linkProblem = isolation.copyLinkProblem(dst, { forbidden: linkForbiddenRoots() })
  if (linkProblem) return { success: false, error: linkProblem }

  if (!verified) {
    // The legacy copy is made by name from the Skyrim folder, so that folder has to be the right build, exe and data:
    // Steam's 1.7.99 data shipped with the 1.6.1170 exe (isolation.trustSource). Checked before anything is deleted
    // or copied, so a working copy is left exactly as it is.
    const trust = isolation.trustSource(src, edition)
    if (!trust.ok) {
      const have = gameCopyComplete(dst)
      let error
      if (trust.unreadable) {
        error = `The game copy was not ${have ? 'repaired' : 'made'}: ${trust.why}. Check that no antivirus holds the file, then try again.`
      } else if (have) {
        error = `Repair Game Copy takes the game files from your Skyrim folder, and ${trust.why}. The game copy was left as it is and keeps working.`
      } else {
        showDowngradePanel()
        error = `The game copy is made from your Skyrim folder, and ${trust.why}. Downgrade it in the Skyrim Version panel first, then try again.`
      }
      log(`[isolated] ${error}`)
      return { success: false, error }
    }
  }

  if (!findOriginalPrefsIni()) {
    return { success: false, error: NEVER_LAUNCHED_ERROR }
  }

  // No clean-install check needed: only vanilla files are copied, so a modded source is fine.

  // Dummy protection for those trying to install it on their base directory
  if (pathsOverlap(src, dst) || pathsOverlap(src, base)) {
    await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Cannot install on top of itself',
      message: 'Warning, you are trying to download the game on top of itself. ' +
               'Please choose a new spot to install a copy of Skyrim, such as the root folder (c:/).',
      detail:
        'DragonBreak uses a portable Skyrim install for maximum compatibility with other modlists or servers.\n' +
        "If you're short on disk space, you can turn this feature off in the troubleshooting tab.",
      buttons: ['OK'],
      defaultId: 0,
    })
    return {
      success: false,
      error: 'Choose an install location OUTSIDE your Skyrim folder. ' +
             'Portable install is for compatibility. If you lack the diskspace, turn off portable install.',
    }
  }

  try {
    store.set('baseDirPath', base)
    // Mark this folder as an DragonBreak instance so future setups reuse it in
    // place instead of nesting again.
    try { fs.mkdirSync(base, { recursive: true }); fs.writeFileSync(path.join(base, 'alduinak-instance.txt'), '') } catch {}

    // What the player is told before anything is copied: where, about how big, that their own Skyrim stays as it is,
    // and the free-space check. The verified copy checks the space again once it knows exactly what it will write.
    const preview = await copyPreview(base)
    send('isolated:progress', preview.text)
    send('isolated:progress', preview.spaceText)
    log(`[isolated] ${preview.mode} copy: ${preview.text} ${preview.spaceText}`)
    if (!preview.enough && (force || !gameCopyComplete(dst))) return { success: false, error: preview.spaceText }

    send('isolated:progress', 'Installing Mod Organizer 2…')
    await mo2.ensureInstalled(msg => send('isolated:progress', msg))

    // The copy folder could have become a link into the original install since the first check
    if (force && pathsOverlap(src, dst)) return { success: false, error: 'The game copy folder resolves into your original Skyrim install - remove the link before repairing.' }
    let counts = {}
    if (verified) {
      const copy = await buildVerifiedCopy(src, dst, { force, progress })
      if (!copy.success) return copy
      counts = { copied: copy.copied, kept: copy.kept }
    } else {
      if (force) {
        send('isolated:progress', 'Removing the old vanilla game files…')
        try { fs.rmSync(path.join(dst, isolation.COPY_MARKER), { force: true }) } catch {}
        for (const job of vanillaJobs(src)) {
          try { fs.rmSync(path.join(dst, job.sub, job.rel), { force: true }) } catch {}
        }
      }
      // portable copy setup (re-copies when a previous copy was interrupted:
      // SkyrimSE.exe lands first, so its presence alone proves nothing)
      if (force || !gameCopyComplete(dst)) {
        const copy = await copyGameDir(src, dst)
        if (!copy.success) return copy
        if (copy.warning) counts = { warning: copy.warning }
      } else {
        log('[isolated] reusing existing game copy at ' + dst)
      }
    }

    // configuration
    let serverInfo = null
    try { serverInfo = await fetchJSON(`${config.apiUrl}/api/serverinfo`) } catch {}
    mo2.ensureInstance(dst, serverInfo?.loadOrder)
    mo2.writeNxmHandlerIni()
    seedProfilePrefs(src)

    store.set('isolatedGame', true)
    store.set('mo2Enabled', true)

    log(`[isolated] DragonBreak install ready at ${base}`)
    return { success: true, dir: base, ...counts }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

// Free space and the setup text for a base folder, before anything is copied (also the game:copyPreview IPC).
// The legacy estimate is the vanilla files of the Skyrim folder less what the copy already holds; the verified one is
// the listed files the copy does not hold at the right size, less depot files on the same drive (moved, not copied).
async function copyPreview(base) {
  const src = store.get('skyrimPath') || null
  const edition = mo2.detectEdition(src)
  const dst = path.join(base, 'skyrim')
  const manifest = copyManifest(edition)
  const verified = isolation.copyMode({ isolated: true, manifest }) === 'verified'
  let total = 0
  let needed = 0
  if (verified) {
    const e = await gamecopy.estimateBytes(manifest, dst, { depotDir: depotDirMap(src) })
    total = e.total
    needed = e.bytes
  } else if (src && fs.existsSync(path.join(src, 'Data'))) {
    for (const job of vanillaJobs(src)) {
      const size = fileSize(jobSource(src, job))
      if (size < 0) continue
      total += size
      needed += Math.max(0, size - Math.max(0, fileSize(path.join(dst, job.sub, job.rel))))
    }
  }
  const free = await gamecopy.freeBytes(dst)
  const space = isolation.spaceCheck({ needed, free })
  return {
    ok: true, base, dir: dst, edition, mode: verified ? 'verified' : 'legacy', neededBytes: needed, freeBytes: free,
    enough: space.enough, text: isolation.setupText({ dir: dst, edition, totalBytes: total }), spaceText: space.text,
  }
}

ipcMain.handle('game:copyPreview', async (_e, baseDirOverride) => {
  try {
    const base = isolation.resolveBase({ override: baseDirOverride, stored: store.get('baseDirPath'), fallback: DEFAULT_BASE_DIR })
    return await copyPreview(base)
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// Vanilla root files, by store edition. Only those present get copied.
// Skyrim.ccc is deliberately NOT copied: only the free CC plugins below are copied (the load order lists them), and
// an orphan ccc list makes the engine treat the AE/CC content set as changed,
// which pops the Creation Club announcement over the main menu on first boot.
// That box is modal and SkyrimPlatform cannot dismiss pre-game menus.
// copyGameDir instead writes an EMPTY Skyrim.ccc and applyForcedServerDefaults keeps it empty.
// With the Bethesda.net platform disabled too, AE owners never get the "download AE content" prompt.
const VANILLA_ROOT_FILES = [
  'SkyrimSE.exe', 'SkyrimSELauncher.exe', 'bink2w64.dll',
  'steam_api64.dll', 'Galaxy64.dll', 'EOSSDK-Win64-Shipping.dll',
  'High.ini', 'Medium.ini', 'Low.ini', 'Ultra.ini', 'Skyrim_Default.ini',
  'installscript.vdf',
]

// Vanilla BSAs the engine loads without a matching plugin (cc* still excluded).
const VANILLA_STANDALONE_BSAS = new Set(['marketplacetextures.bsa', '_resourcepack.bsa'])

// Creation Club plugins every 1.6 install ships free; USSEP and other mods list them as masters.
const FREE_CC_PLUGINS = new Set([
  'ccbgssse001-fish.esm', 'ccqdrsse001-survivalmode.esl', 'ccbgssse037-curios.esl', 'ccbgssse025-advdsgs.esm',
])
const FREE_CC_BASES = [...FREE_CC_PLUGINS].map(p => p.replace(/\.es[ml]$/, ''))

const DOWNGRADE_DEPOT_DATA = path.join('steamapps', 'content', 'app_489830', 'depot_489831', 'Data')
let steamClientRootsCache = null

// download_depot writes under the Steam client root, which may differ from the game's library.
function steamClientRoots() {
  if (!steamClientRootsCache) {
    steamClientRootsCache = [
      regQueryValue('HKCU\\Software\\Valve\\Steam', 'SteamPath'),
      regQueryValue('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'),
    ].filter(Boolean).map(p => path.resolve(p))
  }
  return steamClientRootsCache
}

// Local copies of a free CC archive the source Data lost: the Steam downgrade depot, then our own quarantine.
function ccArchiveFallbackDirs(src) {
  const depots = [path.resolve(src, '..', '..', '..'), ...steamClientRoots()].map(r => path.join(r, DOWNGRADE_DEPOT_DATA))
  const seen = new Set()
  return [...depots.map(dir => ({ dir, needPlugin: true })), { dir: path.join(src, mo2.CC_DISABLED_DIR), needPlugin: false }]
    .filter(f => !seen.has(f.dir.toLowerCase()) && seen.add(f.dir.toLowerCase()))
}
const jobSource = (src, job) => job.from || path.join(src, job.sub, job.rel)
const fileSize = p => { try { return fs.statSync(p).size } catch { return -1 } }

// A Data file is vanilla if it is a known master, a free CC plugin or its BSA, or a vanilla-named BSA.
function isVanillaDataFile(name) {
  const l = name.toLowerCase()
  if (FREE_CC_PLUGINS.has(l) || FREE_CC_BASES.some(b => l === `${b}.bsa`)) return true
  if (l.startsWith('cc')) return false
  if (VANILLA_MASTERS.has(l)) return true
  if (l.endsWith('.bsa')) {
    if (l.startsWith('skyrim - ') || VANILLA_STANDALONE_BSAS.has(l)) return true
    const base = l.replace(/\.bsa$/, '')
    return base === 'skyrim' || VANILLA_MASTERS.has(`${base}.esm`) || VANILLA_MASTERS.has(`${base}.esl`)
  }
  return false
}

// The vanilla file inventory of a source install: exactly what copyGameDir
// copies, and what the integrity check verifies. Only vanilla files can ever
// appear here (isVanillaDataFile), so skse, the engine-fixes preloader, and
// downloaded client files are naturally out of scope.
function vanillaJobs(src) {
  const jobs = []
  for (const name of VANILLA_ROOT_FILES) {
    if (fs.existsSync(path.join(src, name))) jobs.push({ rel: name, sub: '' })
  }
  const dataDir = path.join(src, 'Data')
  try {
    for (const e of fs.readdirSync(dataDir, { withFileTypes: true })) {
      if (e.isFile() && isVanillaDataFile(e.name)) jobs.push({ rel: e.name, sub: 'Data' })
    }
  } catch { /* no Data dir; the SkyrimSE.exe check already guards the source */ }
  // Free CC archives the source Data lost come from a fallback folder whose plugin matches the source build
  const have = new Map(jobs.filter(j => j.sub === 'Data').map(j => [j.rel.toLowerCase(), j.rel]))
  const lost = new Map()
  for (const b of [...FREE_CC_BASES, '_resourcepack']) {
    const plugin = have.get(`${b}.esm`) || have.get(`${b}.esl`)
    if (plugin && !have.has(`${b}.bsa`)) lost.set(`${b}.bsa`, plugin)
  }
  for (const { dir, needPlugin } of lost.size ? ccArchiveFallbackDirs(src) : []) {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const l = e.name.toLowerCase()
        const plugin = lost.get(l)
        if (!e.isFile() || !plugin || have.has(l)) continue
        const sibling = fileSize(path.join(dir, plugin))
        if (sibling === -1 ? needPlugin : sibling !== fileSize(path.join(dataDir, plugin))) continue
        jobs.push({ rel: e.name, sub: 'Data', from: path.join(dir, e.name) })
        have.set(l, e.name)
      }
    } catch { /* fallback folder absent */ }
  }
  try {
    for (const e of fs.readdirSync(path.join(dataDir, 'Video'), { withFileTypes: true })) {
      if (e.isFile()) jobs.push({ rel: e.name, sub: path.join('Data', 'Video') })
    }
  } catch { /* no Video folder */ }
  try {
    // Vanilla loose strings exist on localized installs; English keeps them in the BSAs.
    const bases = [...VANILLA_MASTERS].map(m => m.replace(/\.es[mlp]$/, '')).concat(FREE_CC_BASES)
    for (const e of fs.readdirSync(path.join(dataDir, 'Strings'), { withFileTypes: true })) {
      const l = e.name.toLowerCase()
      if (e.isFile() && bases.some(b => l.startsWith(`${b}_`))) {
        jobs.push({ rel: e.name, sub: path.join('Data', 'Strings') })
      }
    }
  } catch { /* no Strings folder */ }
  return jobs
}

// A fallback CC archive is optional: drop the partial file and let the launch warning report it.
function optionalCopyFailed(job, to, err) {
  if (!job.from) return false
  try { fs.rmSync(to, { force: true }) } catch {}
  log(`[integrity] skipped ${job.rel} from ${job.from}: ${err.message}`)
  return true
}

// Copy only Bethesda's vanilla files from the (possibly modded) source so the user's install stays intact.
async function copyGameDir(src, dst) {
  let jobs = vanillaJobs(src)

  if (!jobs.some(j => j.rel.toLowerCase() === 'skyrim.esm')) {
    return { success: false, error: 'Skyrim.esm not found in Data - is the Skyrim path correct?' }
  }

  // The exe must be the target build (isolation.vetFile). A Data file whose known 1.6.1170 sha256 differs (a cleaned
  // master, often) is still copied, as before: refusing would push the player into the in-place Steam downgrade, the
  // very write isolation avoids. It is logged and named once in the warning; the verified copy (with the vanilla list)
  // replaces it with a clean one. A wrong optional CC archive from a fallback folder is left out.
  send('isolated:progress', 'Checking the Skyrim files before copying…')
  const edition = mo2.detectEdition(src)
  const vetted = []
  const changedData = []
  for (const job of jobs) {
    const v = await isolation.vetFile(path.join(job.sub, job.rel), jobSource(src, job), { edition })
    if (v.ok) { vetted.push(job); continue }
    if (job.from) { log(`[isolated] left out ${job.rel} from ${job.from}: ${v.why}`); continue }
    if (v.kind === 'data') {
      log(`[isolated] ${v.why}: copied anyway (legacy copy, until DragonBreak's own clean copy is available)`)
      changedData.push(job.rel)
      vetted.push(job)
      continue
    }
    if (v.unreadable) return { success: false, error: `The game copy was not made: in your Skyrim folder, ${v.why}. Check that no antivirus holds the file, then try again.` }
    showDowngradePanel()
    return { success: false, error: `The game copy was not made: in your Skyrim folder, ${v.why}. Downgrade it in the Skyrim Version panel, then try again.` }
  }
  jobs = vetted
  const warning = isolation.changedDataWarning(changedData)
  if (warning) send('isolated:progress', `⚠ ${warning}`)

  let copied = 0
  // Weighted by bytes for the progress bar: the archives dwarf the rest
  const sizes = jobs.map(j => { try { return fs.statSync(jobSource(src, j)).size } catch { return 0 } })
  const totalBytes = sizes.reduce((n, b) => n + b, 0)
  let doneBytes = 0
  installStep('copy', { index: 0, total: totalBytes })
  // A fresh run invalidates any previous completion marker.
  try { fs.rmSync(path.join(dst, 'vanilla-copy-complete.json'), { force: true }) } catch {}
  for (const [i, job] of jobs.entries()) {
    const to = path.join(dst, job.sub, job.rel)
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true })
      await fs.promises.copyFile(jobSource(src, job), to)
    } catch (err) {
      if (!optionalCopyFailed(job, to, err)) return { success: false, error: `Failed copying ${job.rel}: ${err.message}` }
      continue
    }
    copied++
    doneBytes += sizes[i]
    installTrack.step('copy', { index: doneBytes, total: totalBytes })
    send('isolated:progress', `Copying vanilla game files… ${copied}/${jobs.length} (${job.rel})`)
  }
  // AE popup fix: an empty Skyrim.ccc declares no CC content expected, so the engine never prompts AE owners to download it.
  try { fs.writeFileSync(path.join(dst, 'Skyrim.ccc'), '') } catch { /* re-applied by applyForcedServerDefaults */ }
  // Completion marker: file presence alone cannot prove the copy finished
  // (the esms sort after the BSAs, so partial copies look deceptively full).
  try {
    fs.writeFileSync(path.join(dst, 'vanilla-copy-complete.json'),
      JSON.stringify({ files: copied, at: new Date().toISOString() }) + '\n')
  } catch { /* marker is an optimization; the masters check still applies */ }
  log(`[isolated] copied ${copied} vanilla file(s) to ${dst}`)
  return { success: true, copied, warning }
}

// The copy's link policy (isolation.linkPolicy): a folder in the copy may be a link (a player moved Data to another
// drive), but never into the Skyrim folder or a Steam library, which writing through it would change
function linkForbiddenRoots() {
  const skyrim = store.get('skyrimPath') || null
  return [skyrim, ...downgrade.steamRoots({ clientRoots: steamClientRoots(), gameDir: skyrim })].filter(Boolean)
}
const copyLinkAllowed = () => isolation.linkPolicy(linkForbiddenRoots())
// copyLinkProblem with that policy; the links it allows are logged once per launcher run
const loggedCopyLinks = new Set()
function copyLinkCheck(dir) {
  for (const l of isolation.copyLinks(dir)) {
    const key = `${l.rel}>${l.real}`
    if (!loggedCopyLinks.has(key)) { loggedCopyLinks.add(key); log(`[isolated] ${l.rel} in the game copy is a link to ${l.real || '(missing)'}`) }
  }
  return isolation.copyLinkProblem(dir, { forbidden: linkForbiddenRoots() })
}

// Verified copy (src/gamecopy.js): Steam's download_depot output as { depotId: folder }, in any of the four layouts
function depotDirMap(gameDir) {
  return Object.fromEntries(downgradeDepots(gameDir, { all: true }).filter(d => d.dir).map(d => [d.id, d.dir]))
}

// Root DLLs in the copy that are ours: SKSE's, the Engine Fixes preloader's and those the client package put there
function rootDllAllow(dir) {
  let skse = []
  try { skse = fs.readdirSync(dir).filter(n => /^skse64_.*\.dll$/i.test(n)) } catch { /* no copy */ }
  return [...skse, ...PRELOADER_DLLS, ...(store.get('clientRootDlls') || [])]
}

// gamecopy progress events as one line each, at most a few per second, to a sink(text, event)
function copyProgressLine(sink) {
  let last = 0
  let lastFile = null
  return p => {
    const now = Date.now()
    if (p.file === lastFile && now - last < 250) return
    last = now
    lastFile = p.file
    const verb = p.step === 'copy' ? 'Copying verified game files' : 'Checking game files'
    const pct = p.totalBytes ? ` ${Math.min(100, Math.floor(100 * (p.doneBytes || 0) / p.totalBytes))}%` : ''
    sink(`${verb}… ${p.index}/${p.total}${pct} (${p.file})`, p)
  }
}

const depotNames = ids => {
  const known = downgradeDepots(store.get('skyrimPath'), { all: true })
  return ids.map(id => (known.find(d => d.id === id) || { holds: `depot ${id}` }).holds).join(', ')
}

/**
 * The verified copy: built from files whose sha256 matches the bundled list (gamecopy.build). Files the copy already
 * holds right stay, so a stopped build resumes and a copy made by launcher 2.1.36 or older is checked by hash rather
 * than copied again. When the Skyrim folder lacks right copies of some files the player is sent to the Skyrim Version
 * panel to download them; they then go into the copy, and the Steam folder is never written.
 */
async function buildVerifiedCopy(src, dst, { force = false, progress = null, signal, quiet = false } = {}) {
  const manifest = copyManifest(mo2.detectEdition(src))
  if (!manifest || !manifest.ready) return { success: false, error: 'This launcher has no Skyrim file list for your edition.' }
  if (force) {
    try { fs.rmSync(path.join(dst, gamecopy.RECORD_FILE), { force: true }) } catch { /* rebuilt below */ }
  }
  // The bar only belongs to the game copy's own install run (Repair Game Copy, first PLAY), not the modpack's
  const ownBar = installTrack.kind() === 'other'
  if (ownBar) installStep('copy', { index: 0, total: manifest.bytes })
  const line = copyProgressLine((text, p) => {
    send('isolated:progress', text)
    if (ownBar && p.step === 'copy') { installTrack.step('copy', { index: p.doneBytes || 0, total: p.totalBytes || 0 }); sendInstallState() }
  })
  const res = await gamecopy.build(src, dst, {
    manifest, depotDir: depotDirMap(src), signal, allowLink: copyLinkAllowed(),
    onProgress: p => { line(p); if (progress) progress(p) },
    checkSpace: async need => {
      const c = isolation.spaceCheck({ needed: need.bytes + need.largest, free: await gamecopy.freeBytes(dst) })
      return c.enough ? null : c.text
    },
  })
  if (!res.ok) {
    if (res.error) return { success: false, error: res.error }
    const files = [...res.unresolved.map(u => u.path), ...res.failed.map(f => f.path)]
    store.set('copyNeedsDepots', { files: files.slice(0, 50), count: files.length, depots: res.depotsNeeded, at: Date.now() })
    log(`[isolated] verified copy needs ${files.length} file(s) from depot(s) ${res.depotsNeeded.join(', ') || '?'}: ${files.slice(0, 20).join(', ')}`)
    if (!quiet) showDowngradePanel()
    return {
      success: false, needDepots: true, files,
      error: `${files.length} Skyrim file(s) in your Skyrim folder are not the ${isolation.targetBuild(mo2.detectEdition(src))} files ` +
        `(${files.slice(0, 4).join(', ')}${files.length > 4 ? ', …' : ''}). Download them with Steam's own download in the Skyrim Version ` +
        `panel (the download${res.depotsNeeded.length > 1 ? 's' : ''} for ${depotNames(res.depotsNeeded)}); they go into DragonBreak's copy, and your Steam Skyrim is not changed.`,
    }
  }
  store.delete('copyNeedsDepots')
  // AE popup fix, as in copyGameDir: the launcher keeps Skyrim.ccc empty (it is left out of the list for that reason)
  try { fs.writeFileSync(path.join(dst, 'Skyrim.ccc'), '') } catch { /* re-applied by applyForcedServerDefaults */ }
  try { fs.rmSync(path.join(dst, isolation.COPY_MARKER), { force: true }) } catch { /* the record replaces it */ }
  log(`[isolated] verified copy at ${dst}: ${res.kept} file(s) already right, ${res.written} copied or moved in`)
  return { success: true, copied: res.written, kept: res.kept }
}

// ensureVanillaIntegrity for the verified copy
async function verifiedIntegrity(gamePath, { signal } = {}) {
  const src = store.get('skyrimPath') || null
  const sink = copyProgressLine(text => send('install:progress', { phase: 'download', file: text, index: 0, total: 0, skipped: false }))
  try {
    const record = await gamecopy.readRecord(gamePath)
    if (!record) {
      // A copy made by launcher 2.1.36 or older (by file name): checked once by hash, wrong files replaced. One that
      // played until now (cleaned masters, say) keeps playing with a warning while the clean files are not downloaded
      log('[integrity] the game copy has no record yet: checking it against the 1.6.1170 file list')
      // While a previous check is still waiting for downloads that are not there yet, the copy is not hashed again on
      // every pass (15 GB): it keeps playing with the same warning. Repair Game Copy, or the downloads, run it again
      const pending = store.get('copyNeedsDepots')
      if (pending && gameCopyComplete(gamePath) && !Object.keys(depotDirMap(src)).length) {
        return isolation.migrationResult({ success: false, needDepots: true, files: pending.files || [] }, { playable: true })
      }
      let built
      try { built = await buildVerifiedCopy(src, gamePath, { signal, quiet: true }) } catch (err) {
        if (signal && signal.aborted) throw err
        log(`[integrity] checking the old game copy failed: ${err.message}`)
        built = { success: false, error: err.message }
      }
      return isolation.migrationResult(built, { playable: gameCopyComplete(gamePath) })
    }
    const manifest = copyManifest(record.platform === 'gog' ? 'GOG' : 'Steam', record.language || 'english')
    if (!manifest || !manifest.ready) return { ok: true, warning: null }
    const d = await gamecopy.drift(gamePath, record, manifest, { allowRootDlls: rootDllAllow(gamePath), signal, allowLink: copyLinkAllowed() })
    // Until the client package has been unpacked once by this launcher, its own root DLLs are not known: nothing is
    // set aside then, it is only logged (store clientRootDlls, written by extractClientZip)
    const clientKnown = Array.isArray(store.get('clientRootDlls'))
    const foreign = clientKnown ? isolation.dllsToSetAside(d.extraRootDlls) : []
    if (!clientKnown && d.extraRootDlls.length) log(`[integrity] root DLLs left in place until the client files are next unpacked: ${d.extraRootDlls.join(', ')}`)
    const others = d.extraRootDlls.filter(n => !foreign.includes(n))
    if (others.length) log(`[integrity] other DLLs in the game copy's root, left alone: ${others.join(', ')}`)
    if (!d.changed.length && !d.missing.length && !d.linked.length && !foreign.length && !d.touched.length) {
      return { ok: true, warning: null }
    }
    log(`[integrity] changed: ${d.changed.join(', ') || '-'}; missing: ${d.missing.join(', ') || '-'}; linked: ${d.linked.join(', ') || '-'}; foreign DLLs: ${foreign.join(', ') || '-'}`)
    const r = await gamecopy.repair(gamePath, d, [
      { dir: record.source && record.source.dir, kind: 'source' },
      { dir: depotDirMap(src), kind: 'depot' },
    ], { record, manifest, signal, setAside: foreign, onProgress: sink, allowLink: copyLinkAllowed() })
    if (!r.ok) {
      const files = r.unresolved.map(u => u.path)
      const depots = [...new Set(r.unresolved.map(u => u.depot).filter(Boolean))].sort()
      store.set('copyNeedsDepots', { files: files.slice(0, 50), count: files.length, depots, at: Date.now() })
      showDowngradePanel()
      return { ok: false, error: `Skyrim files in DragonBreak's game copy were changed, and no right copy was found: ${files.slice(0, 4).join(', ')}` +
        `${files.length > 4 ? ', …' : ''}. Download them with Steam's own download in the Skyrim Version panel; your Steam Skyrim is not changed.` }
    }
    store.delete('copyNeedsDepots')
    if (r.repaired.length) log(`[integrity] repaired from verified files: ${r.repaired.join(', ')}`)
    return {
      ok: true, repaired: r.repaired.length,
      warning: r.setAside.length ? `Moved ${r.setAside.join(', ')} out of the DragonBreak game copy (kept in ${gamecopy.SET_ASIDE_DIR}): another program had put ${r.setAside.length > 1 ? 'them' : 'it'} there.` : null,
    }
  } catch (err) {
    if (signal && signal.aborted) return { ok: false, error: 'Cancelled.' }
    log(`[integrity] ${err.message}`)
    return { ok: false, error: `Checking the game copy failed: ${err.message}` }
  }
}

// Vanilla files in the game copy that are missing or the wrong size compared
// to the original install.
function vanillaMismatches(src, dir) {
  const bad = []
  for (const job of vanillaJobs(src)) {
    const want = fileSize(jobSource(src, job))
    if (want >= 0 && fileSize(path.join(dir, job.sub, job.rel)) !== want) bad.push(job)
  }
  return bad
}

// Vanilla integrity gate, run on every install pass (so before every PLAY).
//   verified copy  checked against its own record (size, mtime, file id; only what differs is hashed) and repaired
//                  only from files whose sha256 matches: the record's source folder, then Steam's depot download
//   legacy copy    compared by size with the Skyrim folder, as before, but (isolation.legacyRepairPlan) never an exe
//                  of another build and nothing from a folder on another build; the copy's own file stays when the
//                  folder is the one that changed. A Data file whose known 1.6.1170 sha256 differs (a cleaned master)
//                  never replaces the copy's existing file; a missing one is copied with a warning, as setup does.
// When playing from the real install there is no clean source to copy from, so a failed check only warns.
async function ensureVanillaIntegrity(gamePath, { signal } = {}) {
  const portable = store.get('isolatedGame') && isolatedGameReady() && gamePath === isolatedGameDir()
  // Every install pass writes into the copy's Data next: never through a link into another install
  const linkProblem = portable ? copyLinkCheck(gamePath) : null
  if (linkProblem) return { ok: false, error: linkProblem }
  if (portable && copyMode() === 'verified') return verifiedIntegrity(gamePath, { signal })
  if (portable) {
    const original = store.get('skyrimPath')
    if (!original || !fs.existsSync(path.join(original, 'Data', 'Skyrim.esm'))) {
      // No source to verify against; the launch gate still blocks a broken copy.
      return { ok: true, warning: null }
    }
    const bad = vanillaMismatches(original, gamePath)
    if (bad.length === 0) return { ok: true, warning: null }
    const decided = await isolation.legacyRepairPlan(bad.map(job => ({
      rel: path.join(job.sub, job.rel), from: jobSource(original, job), to: path.join(gamePath, job.sub, job.rel), optional: !!job.from, job,
    })), { srcDir: original, edition: mo2.detectEdition(original), tolerateData: true })
    for (const k of decided.keep) log(`[integrity] kept the game copy's ${k.rel}: in the Skyrim folder, ${k.why}`)
    for (const k of decided.warned) log(`[integrity] ${k.why}: copied anyway into the game copy, which had none (legacy copy)`)
    const warning = isolation.changedDataWarning(decided.warned.map(k => k.rel))
    for (const k of decided.skipped) log(`[integrity] skipped ${k.rel}: ${k.why}`)
    if (decided.broken.length) {
      const list = decided.broken.map(b => `${b.rel} (${b.why})`).join('; ')
      log(`[integrity] cannot repair: ${list}`)
      return { ok: false, error: `The game copy is missing or has wrong Skyrim files, and your Skyrim folder has no right copy of them: ${list}. ` +
        'Downgrade your Skyrim folder in Settings > Repair > Skyrim Version, then press Repair Game Copy.' }
    }
    const jobs = decided.copy.map(c => c.job)
    if (!jobs.length) return { ok: true, warning }
    log(`[integrity] repairing ${jobs.length} vanilla file(s): ${jobs.map(j => j.rel).join(', ')}`)
    let done = 0
    for (const job of jobs) {
      const to = path.join(gamePath, job.sub, job.rel)
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true })
        await fs.promises.copyFile(jobSource(original, job), to)
      } catch (err) {
        if (!optionalCopyFailed(job, to, err)) return { ok: false, error: `Vanilla file repair failed on ${job.rel}: ${err.message}` }
        continue
      }
      done++
      send('install:progress', { phase: 'download', file: `Repairing vanilla game files… ${done}/${jobs.length} (${job.rel})`, index: done, total: jobs.length, skipped: false })
    }
    return { ok: true, warning, repaired: done }
  }
  // Real install: the masters every SE edition ships must at least exist.
  const missing = [...VANILLA_MASTERS]
    .filter(m => m !== '_resourcepack.esl')
    .filter(m => !fs.existsSync(path.join(gamePath, 'Data', m)))
  if (missing.length > 0) {
    return { ok: true, warning: `Vanilla file check failed: ${missing.join(', ')} missing from the game folder. Restore them with Settings > Repair > Skyrim Version (Steam) or GOG Galaxy; never verify through Steam, it updates Skyrim past 1.6.1170.` }
  }
  return { ok: true, warning: null }
}

// First-launch sanity check
// The game writes its My Games inis (and registry entries) the first time
// vanilla Skyrim reaches the main menu. Installing MO2 before that leaves the
// profile with unconfigured defaults and the engine unregistered, which
// breaks in confusing ways - so installs are blocked until the ini exists.
// Folder name varies by store edition, mirroring pluginsTxtDirs().
const MYGAMES_VARIANTS = [
  'Skyrim Special Edition',
  'Skyrim Special Edition GOG',
  'Skyrim Special Edition EPIC',
  'Skyrim Special Edition MS',
]

function findOriginalIni(name) {
  const docs = app.getPath('documents')
  for (const v of MYGAMES_VARIANTS) {
    const p = path.join(docs, 'My Games', v, name)
    if (fs.existsSync(p)) return p
  }
  return null
}

function findOriginalPrefsIni() {
  return findOriginalIni('SkyrimPrefs.ini')
}

const NEVER_LAUNCHED_ERROR =
  'Skyrim has never been launched on this PC (no SkyrimPrefs.ini in Documents\\My Games). ' +
  'Start the game once the normal way (Steam/GOG), reach the main menu, quit, then run this install again.'

// Startup warning, once per launch. Fires only when a Skyrim install was found
// but the My Games inis are missing; a missing game has its own renderer flow.
let neverLaunchedWarned = false
async function maybeWarnNeverLaunched() {
  if (neverLaunchedWarned) return
  neverLaunchedWarned = true
  if (!store.get('skyrimPath') || findOriginalPrefsIni()) return
  return dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Skyrim has never been launched',
    message: "Skyrim's My Documents ini files are missing.",
    detail:
      'Run vanilla Skyrim once (Steam/GOG), reach the main menu, then quit so the game creates them. ' +
      'The DragonBreak install steps stay blocked until then.',
    buttons: ['OK'],
    defaultId: 0,
  })
}

// Wrong game version: the Skyrim version panel in the window, which downgrades a Steam install to 1.6.1170 itself and
// explains GOG and the editions it cannot downgrade (downgrade.js, docs/DOWNGRADE_1_6_1170.md)
function showDowngradePanel() {
  send('downgrade:show')
}

// The original install and the game copy, each with its exe version and whether its data is 1.6.1170's
// (gameversion.checkGameData: a 1.6.1170 exe on 1.7.99+ data passes the exe gate). Logged at start, on every PLAY and
// in Report a Problem; nothing blocks on the data yet.
function gameFolders() {
  const out = []
  for (const [label, dir] of [['Skyrim folder', store.get('skyrimPath')], ['game copy', isolatedGameReady() ? isolatedGameDir() : null]]) {
    if (!dir || out.some(f => f.dir === dir)) continue
    const edition = mo2.detectEdition(dir)
    out.push({ label, dir, gv: gameversion.checkGameVersion(dir, edition), data: gameversion.checkGameData(dir, edition) })
  }
  return out
}

function logGameFolders(folders = gameFolders()) {
  for (const f of folders) {
    log(`[version] ${f.gv.exe} = ${f.gv.version || 'unreadable'}`)
    log(`[version] ${f.label} ${f.dir}: ${f.data.text}`)
  }
  return folders
}

// One line for a report's header: each folder's exe version and data verdict, with the files whose size differs
function gameVersionSummary(folders) {
  return folders.map(f => `${f.label}: exe ${f.gv.version || 'unreadable'}, ${f.data.verdict}` +
    (f.data.differ.length ? ` (${f.data.differ.join(', ')} differ)` : '') +
    (f.data.missing.length ? ` (${f.data.missing.join(', ')} missing)` : '')).join('; ')
}

// Both folders are still logged; only the one that decides (versionGateDir: the copy once it is ready) counts
function gameVersionProblem() {
  const folders = logGameFolders()
  const dir = versionGateDir()
  const f = dir && folders.find(x => path.resolve(x.dir).toLowerCase() === path.resolve(dir).toLowerCase())
  return f && !f.gv.ok ? f.gv : null
}

// Seed the MO2 profile SkyrimPrefs.ini from the player's own prefs (or, without any, the game's template or a
// preset), then rewrite the server's forced window mode (borderless) and controller-off on top. Resolution is
// deliberately NOT rewritten: it stays whatever the player's ini says, and
// the Settings tab only shows 1080p as a fallback when the ini has none.
// A profile ini holding only the launcher's own writes is rebuilt the same way, keeping those keys (prefsSeed.js).
function seedProfilePrefs(skyrimPath) {
  const dest = path.join(mo2.getProfileDir(), 'skyrimprefs.ini')
  try {
    const lines = prefsSeed.ensureProfilePrefs(dest, {
      documentsPrefs: findOriginalPrefsIni(),
      gameDirs: [skyrimPath, isolatedGameReady() ? isolatedGameDir() : null],
      forced: {
        Display: { 'bFull Screen': '0', 'bBorderless': '1' },
        MAIN: { bGamepadEnable: '0' },
      },
    })
    for (const line of lines) log(`[isolated] ${line}`)
  } catch (err) {
    log(`[isolated] could not seed SkyrimPrefs.ini: ${err.message}`)
  }
}

// The profile Skyrim.ini the same way: the player's own, else the game's Skyrim_Default.ini; one without [Archive]
// (the launcher's writes only) is rebuilt, keeping its keys (prefsSeed.js)
function seedProfileSkyrimIni(gamePath) {
  try {
    const lines = prefsSeed.ensureProfileSkyrimIni(skyrimIniPath(), {
      documentsIni: findOriginalIni('Skyrim.ini'),
      gameDirs: [gamePath, store.get('skyrimPath')],
    })
    for (const line of lines) log(`[defaults] ${line}`)
  } catch (err) {
    log(`[defaults] could not seed Skyrim.ini: ${err.message}`)
  }
}

// Metrics
ipcMain.handle('api:metrics', async () => {
  try {
    const data = await fetchJSON(`${config.apiUrl}/api/metrics`)
    return { ok: true, ...data }
  }
  catch { return { ok: false, error: 'Backend unreachable' } }
})

// Servers
ipcMain.handle('api:servers', async () => {
  try {
    const servers = await fetchJSON(`${config.apiUrl}/api/servers`)
    if (Array.isArray(servers) && servers.length > 0) store.set('cachedServers', servers)
    return servers
  } catch {
    return store.get('cachedServers') || []
  }
})

// Modlist
ipcMain.handle('api:modlist', async () => {
  try {
    const items = await fetchJSON(`${config.apiUrl}/api/modlist`)
    return { ok: true, items: Array.isArray(items) ? items : [] }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// Game process detection
// Used by the renderer to switch the Play button into its "running" state.
function isProcessRunning(imageName) {
  return new Promise(resolve => {
    require('child_process').exec(
      `tasklist /FI "IMAGENAME eq ${imageName}" /NH`,
      { timeout: 5000, windowsHide: true },
      (err, stdout) => resolve(!err && stdout.toLowerCase().includes(imageName.toLowerCase()))
    )
  })
}

// The title of SkyrimSE.exe's window, or '' until it has one (tasklist /v shows "N/A" before then)
function gameWindowTitle() {
  return new Promise(resolve => {
    require('child_process').exec(
      'tasklist /V /FO CSV /NH /FI "IMAGENAME eq SkyrimSE.exe"',
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve('')
        const row = stdout.split(/\r?\n/).find(l => /^"SkyrimSE\.exe"/i.test(l))
        const cells = row ? row.split('","').map(c => c.replace(/^"|"$/g, '')) : []
        const title = cells.length ? cells[cells.length - 1] : ''
        resolve(title && title !== 'N/A' ? title : '')
      }
    )
  })
}

// Once the game's window exists the launcher steps aside. Windows gives the keyboard only to the program that last had
// the player's input, and that was the launcher (the game starts through MO2 and the SKSE loader), so the game showed
// in front while the launcher kept the keys: players could not move until they tabbed out (2026-09-27). Minimizing the
// launcher hands the keyboard to the window behind it, the game. Gives up after two minutes.
function stepAsideForGame() {
  if (process.platform !== 'win32') return
  const started = Date.now()
  const tick = async () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return
    if (await gameWindowTitle()) { if (!win.isDestroyed() && !win.isMinimized()) win.minimize(); return }
    if (Date.now() - started < 120_000) setTimeout(tick, 1500)
  }
  setTimeout(tick, 1500)
}

// The Creations catalog, %LOCALAPPDATA%\Skyrim Special Edition\ContentCatalog.txt, lives outside the game folder, so
// emptying Creations never reached it. A CSV2_<uuid> entry in there makes the engine stoull a uuid and throw "invalid
// stoull argument" (Leerod, 2026-09-22 17:16, still on 2.1.26). It is a Bethesda.net cache our copy never reads, and a
// machine with no catalog launches fine, so it is moved aside right before each launch and put back once the game has
// closed: it belongs to the player's own Skyrim. The store keeps a mark of the file we moved (catalogAside), and only
// that one is put back, never a .dbo-disabled left by launcher 2.1.36 over a newer catalog (isolation.js).
function moveCatalogForLaunch() {
  try {
    const r = isolation.moveCatalogAside(process.env.LOCALAPPDATA, store.get('catalogAside') || null)
    if (r.moved === 'moved') {
      store.set('catalogAside', r.mark)
      log('[defaults] moved the Creations content catalog aside for this launch (kept as ContentCatalog.txt.dbo-disabled)')
    } else if (r.moved === 'session') {
      log('[defaults] moved a new Creations content catalog aside; the player\'s own is still kept as .dbo-disabled')
    }
  } catch (err) {
    log('[defaults] could not move the Creations content catalog aside:', err.message)
  }
  restoreCatalogAfterGame()
}
function putBackCatalog(when) {
  const mark = store.get('catalogAside')
  if (!mark) return
  try {
    const r = isolation.restoreCatalog(process.env.LOCALAPPDATA, mark)
    if (r === 'restored') log(`[defaults] put the Creations content catalog back (${when})`)
    else if (r === 'stale') log('[defaults] the catalog kept aside is not the one this launcher moved; left as it is')
    if (r) store.delete('catalogAside')
  } catch (err) {
    log(`[defaults] could not put the Creations content catalog back: ${err.message}`)
  }
}
// MO2 starts the game for us, so it counts as the game running too
const skyrimRunning = async () => (await isProcessRunning('SkyrimSE.exe')) || (await isProcessRunning('skse64_loader.exe')) ||
  (await isProcessRunning('ModOrganizer.exe'))
// Polls until the game has come and gone (or never started within five minutes), then puts the catalog back. Every
// launch starts the watch afresh, so a quick second PLAY cannot inherit a watch that already saw the first game end.
let catalogWatch = null
function restoreCatalogAfterGame() {
  if (catalogWatch) { clearTimeout(catalogWatch); catalogWatch = null }
  if (process.platform !== 'win32' || !isolation.catalogAside(process.env.LOCALAPPDATA, store.get('catalogAside'))) return
  const started = Date.now()
  let seen = false
  const tick = async () => {
    const running = await skyrimRunning()
    if (running) seen = true
    if (running || (!seen && Date.now() - started < 5 * 60_000)) { catalogWatch = setTimeout(tick, 10_000); return }
    catalogWatch = null
    putBackCatalog('the game has closed')
  }
  catalogWatch = setTimeout(tick, 10_000)
}
// The launcher's start puts back one left aside by a session that ended while the launcher was closed
async function putBackCatalogAtStart() {
  if (process.platform !== 'win32') return
  if (await skyrimRunning()) { restoreCatalogAfterGame(); return }
  if (store.get('catalogAside')) { putBackCatalog('at launcher start'); return }
  // One launcher 2.1.36 left aside goes back only when the player has no catalog now (nothing newer is replaced)
  try {
    if (isolation.restoreOrphanCatalog(process.env.LOCALAPPDATA)) log('[defaults] put back the Creations content catalog an older launcher had moved aside')
  } catch (err) { log(`[defaults] could not put the older Creations catalog back: ${err.message}`) }
}

// After a launch, watch the game and tell the server how it closed (src/crashWatch.js). One watcher at a time; it
// only speaks for a signed-in player, and a failure here never touches the game.
let gameWatchRunning = false
function watchGameExit() {
  if (process.platform !== 'win32' || gameWatchRunning) return
  const session = store.get('gameSession')
  if (!session) return
  gameWatchRunning = true
  const docs = documentsDirOrNull()
  const run = (file, args) => new Promise((resolve, reject) =>
    require('child_process').execFile(file, args, { windowsHide: true, maxBuffer: 64 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout))))
  crashWatch.watchGame({
    run,
    crashDirs: docs ? MYGAMES_VARIANTS.map(v => path.join(docs, 'My Games', v, 'SKSE')) : [],
    launchedAt: Date.now(),
    log,
    send: note => postJSON(`${config.apiUrl}/api/files/session-end`,
      { ...note, launcherVersion: app.getVersion(), filesVersion: store.get('filesVersion') || '' },
      { 'x-session': store.get('gameSession') || session }),
  }).then(note => offerCrashReport(note))
    .catch(err => log(`[crashWatch] ${err.message}`)).finally(() => { gameWatchRunning = false })
}

// After a crash, offer the report there and then. crashWatch has already found the crash log and the player should
// not have to remember to press Report a Problem afterwards: through 2.1.34 not one of 21 crashes produced a log,
// although every note said one existed (measured 2026-09-30).
//
// Asked ONCE PER CRASH and only for a crash: the note's endedAt keys it, the key is written BEFORE the dialog opens
// so a second crash cannot double-ask, and nothing is asked at startup. "Not now" is remembered for that crash only,
// so the next crash asks again.
const CRASH_PROMPT_KEYS = 20   // keep the newest few keys; without a bound the store would grow for ever
let crashPromptOpen = false
async function offerCrashReport(note) {
  if (!note || note.outcome !== 'crash' || crashPromptOpen) return
  const key = `crashAsked.${Number(note.endedAt) || 0}`
  if (store.get(key)) return
  crashPromptOpen = true
  try {
    store.set(key, true)
    pruneCrashPromptKeys()
    const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed()) || null
    const opts = {
      type: 'warning', buttons: ['Send', 'Not now'], defaultId: 0, cancelId: 1, noLink: true,
      title: 'DragonBreak Online',
      message: 'Skyrim closed unexpectedly. Send the crash report to the DragonBreak team?',
      detail: 'It sends the crash log and the game log. Folder paths and anything said in chat are removed first.',
    }
    const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    if (response !== 0) {
      log('[crashPrompt] the player chose Not now')
      return
    }
    const res = await submitReport({ note: 'Crash report offered by the launcher after the game closed unexpectedly.' })
    log(`[crashPrompt] ${res && res.ok ? 'sent' : `not sent: ${res && res.error}`}`)
    if (!(res && res.ok) && win) {
      dialog.showMessageBox(win, { type: 'info', buttons: ['OK'], noLink: true, title: 'DragonBreak Online',
        message: 'The crash report could not be sent.',
        detail: `${(res && res.error) || 'Unknown error'}\n\nReport a Problem in the launcher still works.` }).catch(() => {})
    }
  } catch (err) {
    log(`[crashPrompt] failed: ${err.message}`)
  } finally {
    crashPromptOpen = false
  }
}

function pruneCrashPromptKeys() {
  try {
    const keys = Object.keys(store.store || {}).filter(k => k.startsWith('crashAsked.'))
    if (keys.length <= CRASH_PROMPT_KEYS) return
    keys.map(k => [k, Number(k.slice('crashAsked.'.length)) || 0]).sort((a, b) => a[1] - b[1])
      .slice(0, keys.length - CRASH_PROMPT_KEYS).forEach(([k]) => store.delete(k))
  } catch (err) {
    log(`[crashPrompt] could not prune the asked list: ${err.message}`)
  }
}

// Lightweight update probe for the Play/Update button: compares the server's
// published client-files version with what was last installed.
ipcMain.handle('files:updateCheck', async () => {
  try {
    const vd = await fetchJSON(`${config.apiUrl}/api/files/version`)
    const gamePath   = effectiveGamePath()
    const allPresent = clientFilesPresent(gamePath)
    // A failed modpack install also flips the Play button to UPDATE so one
    // click re-runs the install and self-heals the incomplete state.
    const modpackFailed = store.get('mo2Enabled') && store.get('modpackState') === 'failed'
    let extrasCurrent = true
    if (!store.get('dboFilesDisabled')) { try { extrasCurrent = extrasUpToDate(await fetchExtraManifest(), gamePath) } catch { /* backend hiccup: keep Play */ } }
    return {
      ok: true,
      updateAvailable: vd.version !== store.get('filesVersion') || !allPresent || modpackFailed || !extrasCurrent,
      serverVersion:   vd.version,
    }
  } catch {
    return { ok: false, updateAvailable: false }
  }
})

// MO2 can take a while to boot Skyrim, so a fresh launch blocks relaunching until the game shows up or this runs out
const LAUNCH_GRACE_MS = 90_000
let launchInFlight = false
let launchStartedAt = 0

async function gameProcessRunning() {
  if (process.platform !== 'win32') return false
  const running = (await isProcessRunning('SkyrimSE.exe')) || (await isProcessRunning('skse64_loader.exe'))
  if (running) launchStartedAt = 0
  return running
}

// Refuses a launch while another is being prepared, starting, or the game already runs
async function guardLaunch(launch) {
  if (launchInFlight) return { success: false, error: 'The game is already launching.' }
  if (installGate.running()) return { success: false, error: installGate.refusal() }
  launchInFlight = true
  try {
    if (await gameProcessRunning()) return { success: false, error: 'Skyrim is already running.' }
    if (Date.now() - launchStartedAt < LAUNCH_GRACE_MS) {
      return { success: false, error: 'Skyrim is still starting - give MO2 a moment.' }
    }
    if (legal.blocksLaunch()) return { success: false, legalRequired: true, error: LEGAL_BLOCK_MESSAGE }
    const result = await launch()
    if (result.success) launchStartedAt = Date.now()
    return result
  } finally {
    launchInFlight = false
  }
}

ipcMain.handle('game:isRunning', gameProcessRunning)

let pendingReportId = null

// Electron can fail to resolve Documents on a broken profile; the collector then falls back to the home folder
function documentsDirOrNull() {
  try { return app.getPath('documents') } catch { return null }
}

// Send this launcher's logs to staff. The backend redacts again, then files them as a thread in the
// error-report forum under the player's Discord name.
// GPU name, VRAM and the free space on the game drive, for the hardware line in a problem report. One PowerShell
// call with a short timeout: if it is slow, missing or refused the report still sends without these two fields.
// AdapterRAM is a uint32 and wraps above 4 GB, so a card with more reports its size modulo 4 GiB; the value is taken
// as a floor and marked with a + rather than pretending to be exact.
const HW_TIMEOUT_MS = 6000
async function hardwareExtras(gameDir) {
  const out = { gpu: '', freeSpaceGb: undefined }
  if (process.platform !== 'win32') return out
  const drive = String(gameDir || '').slice(0, 2)
  const ps = "$g = Get-CimInstance Win32_VideoController | Select-Object -First 1 Name,AdapterRAM; " +
             "$d = Get-PSDrive -Name '" + (drive.replace(/[^A-Za-z]/g, '') || 'C') + "' -ErrorAction SilentlyContinue; " +
             "Write-Output ($g.Name); Write-Output ($g.AdapterRAM); Write-Output ($d.Free)"
  try {
    const stdout = await new Promise((resolve, reject) => {
      const child = require('child_process').execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', ps],
        { windowsHide: true, timeout: HW_TIMEOUT_MS, maxBuffer: 64 * 1024 },
        (err, so) => (err ? reject(err) : resolve(so)))
      child.on('error', reject)
    })
    const [name, ram, free] = String(stdout).split(/\r?\n/).map(x => x.trim())
    const ramBytes = Number(ram)
    const gib = Number.isFinite(ramBytes) && ramBytes > 0 ? Math.round(ramBytes / 1024 / 1024 / 1024) : 0
    if (name) out.gpu = gib ? `${name} ${gib} GB+` : name
    const freeBytes = Number(free)
    if (Number.isFinite(freeBytes) && freeBytes > 0) out.freeSpaceGb = Math.round(freeBytes / 1024 / 1024 / 1024)
  } catch (err) {
    log(`[report] could not read the GPU or free space: ${err.message}`)
  }
  return out
}

// Both Report a Problem and the after-a-crash prompt file the same report through here.
async function submitReport({ note, private: keepPrivate } = {}) {
  const user    = store.get('discordUser') || null
  const session = store.get('gameSession')
  try {
    const payload = report.collect({
      userDataDir:     app.getPath('userData'),
      installDir:      store.get('skyrimPath') || '',
      documentsDir:    documentsDirOrNull(),
      myGamesVariants: MYGAMES_VARIANTS,
      // Crash Logger's crash-*.log can land in MO2's overwrite\SKSE as well as in Documents
      mo2Root:         mo2.getRoot(),
      // The client's dbo-diag log is written where the game runs: the isolated copy when there is one
      gameDirs:        [effectiveGamePath()],
      context: {
        launcherVersion: app.getVersion(),
        filesVersion:    store.get('filesVersion') || '',
        mo2Enabled:      store.get('mo2Enabled') ? 'yes' : 'no',
        discordUsername: user && user.username ? user.username : '',
        note:            typeof note === 'string' ? note.slice(0, 300) : '',
        // The player's own choice, made before sending: no public thread is opened for this one
        private:         keepPrivate === true,
        ...(await hardwareExtras(effectiveGamePath())),
      },
    })
    // Each folder's exe version and data verdict goes in the report's header, the sizes with the install listing
    try {
      const folders = gameFolders()
      if (folders.length) {
        payload.gameVersion = gameVersionSummary(folders)
        payload.clientLog = (payload.clientLog ? payload.clientLog + '\n\n' : '') + '== game data ==\n' +
          folders.map(f => report.redact(`${f.label} ${f.dir}: exe ${f.gv.version || 'unreadable'}, ${f.data.text}`)).join('\n')
      }
    } catch (err) {
      log(`[report] could not check the game data: ${err.message}`)
    }
    const previous = report.tail(path.join(app.getPath('userData'), 'install.prev.log'))
    if (previous && !payload.launcherLog) payload.launcherLog = report.redact(previous)
    if (!payload.launcherLog) return { ok: false, error: 'No launcher log to send yet.' }

    // The id is kept until a send succeeds, so a retry of a report the server did file is not filed twice
    if (!pendingReportId) pendingReportId = crypto.randomUUID()
    payload.reportId = pendingReportId
    // The server now waits for Discord before answering, so this allows longer than the usual 10 s
    const res = await postJSON(`${config.apiUrl}/api/files/report`, payload,
                               session ? { 'x-session': session } : {}, 30_000)
    log(`[report] filed ${payload.reportId}${res && res.thread ? ` as thread ${res.thread}` : ''}`)
    pendingReportId = null
    return { ok: true }
  } catch (err) {
    log(`[report] failed: ${err.statusCode || ''} ${err.message}`)
    if (err.statusCode === 429) return { ok: false, error: 'Too many reports just now. Wait a few minutes.' }
    if (err.statusCode === 503) return { ok: false, error: 'Reporting is switched off on the server.' }
    if (err.statusCode === 413) return { ok: false, error: 'The report is too large to send.' }
    if (err.statusCode === 502) return { ok: false, error: 'The report could not be filed just now. Try again in a minute.' }
    return { ok: false, error: 'Could not reach the server. Tell a staff member directly.' }
  }
}

ipcMain.handle('report:send', (_e, args) => submitReport(args))

// Launcher update check
ipcMain.handle('app:checkUpdate', async () => {
  const current = app.getVersion()
  try {
    const data = await fetchJSON(`${config.apiUrl}/api/version`)
    const latest    = data.version
    const hasUpdate = compareVersions(latest, current) > 0
    return { current, latest, hasUpdate, downloadUrl: data.downloadUrl || '' }
  } catch {
    return { current, latest: null, hasUpdate: false, downloadUrl: '' }
  }
})

// Reject remote plain-HTTP downloads of payloads we run or extract: guards
// against MITM tampering and https->http redirect downgrades. Loopback stays
// allowed so the http://localhost dev backend still works.
//
// The configured backend is also allowed over plain http. Its address is compiled
// into this build (config.apiUrl), not supplied at runtime, and the launcher already
// takes the modlist, the install manifest and every sha256 from it - anyone able to
// tamper with the payload on that path could tamper with the hashes too, so requiring
// https here buys nothing while blocking a server that has no certificate. This does
// NOT cover the self-update installer, which executes code and stays https-only.
function assertSecureDownloadUrl(url) {
  if (/^https:/i.test(url)) return
  let host = ''
  try { host = new URL(url).hostname } catch {}
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return
  try {
    if (new URL(url).origin === new URL(config.apiUrl).origin) return
  } catch { /* unparsable apiUrl: fall through and refuse */ }
  throw new Error(`Refusing to download over an insecure (non-HTTPS) URL: ${url}`)
}

// Download a URL to a local file, following redirects (release URLs hit a CDN).
// Settles exactly once on every outcome, including an aborted response.
function downloadToFile(url, dest, onProgress, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    try { assertSecureDownloadUrl(url) } catch (err) { return reject(err) }
    let file = null
    let settled = false
    const finish = val => { if (!settled) { settled = true; resolve(val) } }
    // Destroy the stream before unlinking: an open handle leaves the partial file delete-pending on Windows and blocks every retry this session.
    const fail = err => {
      if (settled) return
      settled = true
      if (file && !file.destroyed) {
        file.once('close', () => { try { fs.unlinkSync(dest) } catch {} reject(err) })
        file.destroy()
      } else {
        try { fs.unlinkSync(dest) } catch {}
        reject(err)
      }
    }
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        if (redirectsLeft <= 0) return fail(new Error('Too many redirects'))
        return finish(downloadToFile(res.headers.location, dest, onProgress, redirectsLeft - 1))
      }
      if (res.statusCode !== 200) { res.resume(); return fail(new Error(`HTTP ${res.statusCode}`)) }
      const total = parseInt(res.headers['content-length'] || '0', 10)
      let received = 0
      file = fs.createWriteStream(dest)
      res.on('data', c => { received += c.length; if (onProgress) onProgress(received, total) })
      res.pipe(file)
      file.on('finish', () => file.close(() => finish(dest)))
      file.on('error', fail)
      res.on('error',  fail)
      res.on('aborted', () => fail(new Error('Download interrupted')))
    })
    req.on('error', fail)
    req.setTimeout(120_000, () => { req.destroy(); fail(new Error('Download timed out')) })
  })
}

// In-app launcher update: download the new installer, run it silently, and let
// it relaunch us (--force-run). Replaces the "open the download page" flow.
ipcMain.handle('app:installUpdate', async () => {
  if (installGate.running()) return { ok: false, error: installGate.refusal() }
  try {
    const data = await fetchJSON(`${config.apiUrl}/api/version`)
    if (!data.downloadUrl) return { ok: false, error: 'No download URL is configured on the server.' }
    // The installer is executed with the user's privileges, so refuse to fetch
    // it over anything but HTTPS (no plain-http, no redirect downgrade).
    if (!/^https:/i.test(data.downloadUrl)) {
      return { ok: false, error: 'Refusing to install an update from a non-HTTPS URL.' }
    }

    const dest = path.join(os.tmpdir(), 'DragonBreakLauncher-update.exe')
    send('update:progress', { phase: 'download', received: 0, total: 0 })
    await downloadToFile(data.downloadUrl, dest, (received, total) =>
      send('update:progress', { phase: 'download', received, total }))

    send('update:progress', { phase: 'install' })
    // /S silent + --force-run: NSIS replaces our files and relaunches the app.
    spawn(dest, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
    setTimeout(() => app.quit(), 1200)   // release our files so the installer can overwrite
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// Launch SKSE

// Files that must exist before we allow launching
const REQUIRED_FILES = [
  path.join('Data', 'Platform', 'Plugins', 'skymp5-client.js'),
  path.join('Data', 'SKSE', 'Plugins', 'SkyrimPlatform.dll'),
  path.join('Data', 'SKSE', 'Plugins', 'MpClientPlugin.dll'),
]

// Engine fixes preloader
const PRELOADER_DLLS = ['d3dx9_42.dll', 'winhttp.dll']
const preloaderPresent = (gamePath) =>
  !!gamePath && PRELOADER_DLLS.some(f => fs.existsSync(path.join(gamePath, f)))

// True when every client-package file the launcher can check is on disk.
const clientFilesPresent = (gamePath) =>
  !!gamePath &&
  REQUIRED_FILES.every(f => fs.existsSync(path.join(gamePath, f))) &&
  preloaderPresent(gamePath)

ipcMain.handle('launch:skse', () => guardLaunch(async () => {
  const skyrimPath = effectiveGamePath()
  const mo2Enabled = store.get('mo2Enabled')

  if (!skyrimPath) {
    return { success: false, error: noGamePathError() }
  }

  if (mo2Enabled && !mo2.isInstalled()) {
    return { success: false, error: 'MO2 is not set up - open Settings → Repair and run Repair MO2.' }
  }

  // Shared pre-launch steps: client settings, load order, file validation.
  const prep = await prepareForLaunch(skyrimPath, mo2Enabled)
  if (!prep.success) return prep

  try {
    if (mo2Enabled) {
      // MO2 manages plugins.txt itself via the profile; launch through its VFS.
      mo2.launchGame(skyrimPath)
    } else {
      // Direct launch (manual mod installs): run SKSE in active game dir
      const exe = path.join(skyrimPath, 'skse64_loader.exe')
      if (!fs.existsSync(exe)) {
        return { success: false, error: `skse64_loader.exe not found in ${skyrimPath}. Install SKSE there, or enable MO2.` }
      }
      spawn(exe, [], { detached: true, stdio: 'ignore', cwd: skyrimPath }).unref()
    }
    stepAsideForGame()
    watchGameExit()
    return { success: true, loadOrderFixed: prep.loadOrderFixed, warning: prep.warning }
  } catch (err) {
    return { success: false, error: err.message }
  }
}))

// Troubleshooting: force a launch path regardless of the mo2Enabled setting.
ipcMain.handle('launch:viaMO2', () => guardLaunch(async () => {
  const skyrimPath = effectiveGamePath()
  if (!skyrimPath) return { success: false, error: noGamePathError() }
  if (!mo2.isInstalled()) return { success: false, error: 'MO2 is not installed - use Repair MO2 first.' }
  const prep = await prepareForLaunch(skyrimPath, true)
  if (!prep.success) return prep
  try { mo2.launchGame(skyrimPath); stepAsideForGame(); watchGameExit(); return { success: true } }
  catch (err) { return { success: false, error: err.message } }
}))

ipcMain.handle('launch:direct', () => guardLaunch(async () => {
  const skyrimPath = effectiveGamePath()
  if (!skyrimPath) return { success: false, error: noGamePathError() }
  const prep = await prepareForLaunch(skyrimPath, false)
  if (!prep.success) return prep
  const exe = path.join(skyrimPath, 'skse64_loader.exe')
  if (!fs.existsSync(exe)) {
    return { success: false, error: `skse64_loader.exe not found in ${skyrimPath}. Install SKSE there first.` }
  }
  try {
    spawn(exe, [], { detached: true, stdio: 'ignore', cwd: skyrimPath }).unref()
    stepAsideForGame()
    watchGameExit()
    return { success: true }
  } catch (err) { return { success: false, error: err.message } }
}))

/**
 * Common pre-launch pipeline:
 *  1. Re-write skymp5-client-settings.txt so server-ip/port/gameData are current.
 *  2. Sync plugins.txt with the server's published load order (if available).
 *     Blocks the launch when required plugins are missing from Data/.
 *  3. Verify the SkyMP client files exist.
 */
 
// Adds two missing folders to prevent a code 2 crash
function ensureClientDirs(gamePath) {
  if (!gamePath) return
  for (const d of ['PluginsDev', 'PluginsNoLoad']) {
    try { fs.mkdirSync(path.join(gamePath, 'Data', 'Platform', d), { recursive: true }) } catch {}
  }
}

/** Read-only pre-launch staging check; returns a list of problems (empty = ready to launch). */
function verifyLaunchReadiness(skyrimPath, viaMO2, serverInfo) {
  const problems = []

  // SkyMP / Skyrim Platform client files.
  const missingFiles = REQUIRED_FILES.filter(f => !fs.existsSync(path.join(skyrimPath, f)))
  if (missingFiles.length > 0) {
    const names = missingFiles.map(f => path.basename(f)).join(', ')
    const hint  = viaMO2 ? 'run Repair Modlist in Settings' : 'run Repair Client Files in Settings'
    problems.push(`Client files missing (${names}); ${hint} first.`)
  }

  // SKSE runtime.
  if (!fs.existsSync(path.join(skyrimPath, 'skse64_loader.exe'))) {
    problems.push('SKSE is not installed (skse64_loader.exe missing); install the modpack first.')
  }

  // Vanilla masters: without them the engine hard-crashes before the menu.
  if (!fs.existsSync(path.join(skyrimPath, 'Data', 'Skyrim.esm')) ||
      !fs.existsSync(path.join(skyrimPath, 'Data', 'Update.esm'))) {
    problems.push('Vanilla game files missing (Skyrim.esm/Update.esm); click UPDATE to repair the game copy.')
  }

  // Server load order: every required plugin must be present.
  if (Array.isArray(serverInfo?.loadOrder) && serverInfo.loadOrder.length > 0) {
    const missingPlugins = viaMO2
      ? missingPluginsForMO2(skyrimPath, serverInfo.loadOrder)
      : serverInfo.loadOrder
          .map(f => path.basename(f))
          .filter(f => !VANILLA_MASTERS.has(f.toLowerCase()) &&
                       !fs.existsSync(path.join(skyrimPath, 'Data', f)))
    if (missingPlugins.length > 0) {
      problems.push(`Required plugins missing (${missingPlugins.join(', ')}); install the server modlist first.`)
    }
  }

  // Fallback if install fails
  if (viaMO2 && store.get('modpackState') === 'failed') {
    problems.push('The last modpack install did not finish. Press PLAY (it will show UPDATE) or run Repair Modlist to complete it first.')
  }

  // Fallback for engine fixes failure (like with AV software)
  if (!preloaderPresent(skyrimPath)) {
    problems.push('The Engine Fixes preloader dll is missing from the game folder; press PLAY (it will show UPDATE) to reinstall the client files.')
  }

  // Online servers need a launcher Discord login so auth-data-no-load.js can be seeded; without it SkyMP shows its own auth menu and never connects.
  if (serverInfo && serverInfo.offlineMode === false) {
    const session   = store.get('gameSession')
    const user      = store.get('discordUser')
    const profileId = store.get('gameProfileId')
    if (!(session && user && profileId != null)) {
      problems.push('Discord login required; log in from the launcher topbar before playing, otherwise the in-game auth menu appears and you stay on the main menu.')
    }
  }

  return problems
}

// Skyrim version panel (downgrade.js, docs/DOWNGRADE_1_6_1170.md). The panel polls downgrade:status every 2 s while it
// is open; the player downloads the three 1.6.1170 depots in Steam's own console under their own account, and the
// launcher checks them, backs up what they replace, copies them over the original game folder and refreshes the game
// copy from it. Steam credentials never pass through the launcher.
const depotStates = new Map()
let downgradeBusy = false
const DOWNGRADE_GAME_PROCESSES = ['SkyrimSE.exe', 'skse64_loader.exe', 'ModOrganizer.exe']

// The original game folder and what it needs; null until a Skyrim folder is set
function downgradeTarget() {
  const gameDir = store.get('skyrimPath')
  if (!gameDir || !fs.existsSync(path.join(gameDir, 'SkyrimSE.exe'))) return null
  return downgrade.assess(gameDir, mo2.detectEdition(gameDir))
}

// The launcher's game copy, when PLAY runs one apart from the original folder
function gameCopyDir(gameDir) {
  if (!store.get('isolatedGame') || !isolatedGameReady()) return null
  const copy = isolatedGameDir()
  return path.resolve(copy).toLowerCase() === path.resolve(gameDir).toLowerCase() ? null : copy
}

// A game-relative path the game copy keeps (copyGameDir's inventory): a vanilla root file or a vanilla Data file
function isVanillaRel(rel) {
  const parts = rel.split(/[\\/]/)
  if (parts.length === 1) return VANILLA_ROOT_FILES.some(f => f.toLowerCase() === parts[0].toLowerCase())
  if (parts[0].toLowerCase() !== 'data') return false
  if (parts.length === 2) return isVanillaDataFile(parts[1])
  return parts.length === 3 && ['video', 'strings'].includes(parts[1].toLowerCase())
}

// Brings the legacy game copy in line with the original after an in-place downgrade: the changed vanilla files are
// copied across and the removed ones deleted. Explicit, because the integrity check compares sizes only.
// Only from a Skyrim folder that is now the right build, and only files not known to be wrong (isolation.js): after a
// Restore the folder is on its old build again and the copy keeps its 1.6.1170 files. The verified copy never takes
// files this way (it repairs itself from hash-checked sources).
async function refreshGameCopy(gameDir, changed, removed) {
  const copy = gameCopyDir(gameDir)
  if (!copy || copyMode() === 'verified') return 0
  const edition = mo2.detectEdition(gameDir)
  const trust = isolation.trustSource(gameDir, edition)
  if (!trust.ok) {
    log(`[downgrade] game copy ${copy} left as it is: ${trust.why}`)
    return 0
  }
  let n = 0
  for (const rel of changed.filter(isVanillaRel)) {
    const vet = await isolation.vetFile(rel, path.join(gameDir, rel), { edition })
    if (!vet.ok) { log(`[downgrade] not copied into the game copy: ${vet.why}`); continue }
    const to = path.join(copy, rel)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    await fs.promises.copyFile(path.join(gameDir, rel), to)
    send('downgrade:progress', { step: 'refresh', index: ++n, total: changed.length, file: rel })
  }
  for (const rel of removed.filter(isVanillaRel)) {
    try { fs.rmSync(path.join(copy, rel), { force: true }) } catch { /* left for the integrity check */ }
  }
  log(`[downgrade] game copy ${copy}: ${n} file(s) refreshed, ${removed.filter(isVanillaRel).length} removed`)
  return n
}

// SKSE's 1.6.1170 runtime and the Address Library table where the game will look for them
function downgradeRuntime(gameDir) {
  let mods = []
  try { mods = downgrade.enabledMods(fs.readFileSync(path.join(mo2.getProfileDir(), 'modlist.txt'), 'utf8')) } catch { /* no MO2 yet */ }
  return downgrade.runtimeChecks(gameCopyDir(gameDir) || gameDir, { modsDir: mo2.getModsDir(), mods })
}

async function runningGameProcesses() {
  const out = []
  for (const name of DOWNGRADE_GAME_PROCESSES) if (await isProcessRunning(name)) out.push(name)
  return out
}

function freeBytes(dir) {
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize } catch { return null }
}

const gb = n => `${(n / 1024 ** 3).toFixed(1)} GB`

// The three base depots plus the install's language depot (downgrade.languageDepot). all: also a language depot whose
// 1.6.1170 manifest is not known yet (the verified copy looks for its files and checks them by hash); otherwise only
// depots with a command, which the panel offers and the in-place downgrade uses
function downgradeDepots(gameDir, { all = false } = {}) {
  const depots = downgrade.findDepots(downgrade.steamRoots({ clientRoots: steamClientRoots(), gameDir }), { language: isolation.steamLanguage(gameDir) })
  return all ? depots : depots.filter(d => d.command)
}

ipcMain.handle('downgrade:status', async () => {
  const a = downgradeTarget()
  if (!a) return { ok: false, error: 'Set your Skyrim folder first (Settings > Repair > Skyrim Installation Path).' }
  const now = Date.now()
  const depots = downgradeDepots(a.gameDir).map(d => {
    const st = downgrade.depotState(d, depotStates.get(d.id), now)
    depotStates.set(d.id, st)
    return { id: d.id, command: d.command, holds: d.holds, state: st.state, bytes: st.bytes, detail: st.detail || null }
  })
  const acfPath = downgrade.acfPathFor(a.gameDir)
  let acf = null
  if (acfPath) {
    try { acf = { value: downgrade.readAutoUpdate(fs.readFileSync(acfPath, 'utf8')) } } catch { acf = { value: null, missing: true } }
  }
  const backup = downgrade.latestBackup(a.gameDir)
  const copy = gameCopyDir(a.gameDir)
  const copyVersion = copy ? gameversion.readPeFileVersion(path.join(copy, 'SkyrimSE.exe')) : null
  // In isolated mode the copy counts: with the verified copy the panel fills the copy from the downloads instead of
  // changing the Steam folder (isolation.panelState)
  const mode = copyMode()
  const panel = isolation.panelState({
    mode, isolated: !!store.get('isolatedGame'), copyReady: isolatedGameReady(), steam: a,
    copy: copy ? downgrade.assess(copy, mo2.detectEdition(copy)) : null, needs: mode === 'verified' ? store.get('copyNeedsDepots') : null,
  })
  // The Steam folder is not downgraded (verified) or not needed (a right copy), so its update setting does not matter
  if (mode === 'verified' || panel.copyOwn) acf = null
  return {
    ok: true,
    busy: downgradeBusy,
    action: panel.action,
    blocking: panel.blocking,
    copyOwn: panel.copyOwn,
    copyBuild: panel.copyBuild,
    copyWrong: panel.copyWrong,
    copyDir: isolatedGameDir(),
    copyVersion,
    version: a.version,
    required: a.required,
    edition: a.edition,
    newerData: a.newerData,
    gameDir: a.gameDir,
    copyStale: mode === 'legacy' && a.action === 'none' && !!copyVersion && !!a.version && copyVersion !== a.version,
    depots,
    steamRunning: acf ? await isProcessRunning('steam.exe') : false,
    acf,
    backup: backup ? { name: backup.name, replaced: (backup.record.replaced || []).length, added: (backup.record.added || []).length } : null,
    runtime: panel.action === 'none' ? downgradeRuntime(a.gameDir) : null,
  }
})

ipcMain.handle('downgrade:openConsole', () => { shell.openExternal('steam://open/console'); return true })
ipcMain.handle('downgrade:steamVerify', () => { shell.openExternal(`steam://validate/${downgrade.APP_ID}`); return true })

// Verified copy: the Install button fills DragonBreak's own copy from the downloaded depots (a move on the same drive)
// through the normal game copy setup. No backup, no appmanifest edit, nothing written to the Steam folder.
async function runCopyFromDepots() {
  const running = await runningGameProcesses()
  if (running.length) return { ok: false, error: `Close ${running.join(', ')} first. Nothing was changed.` }
  const depots = downgradeDepots(store.get('skyrimPath'))
  if (!depots.some(d => d.dir)) return { ok: false, error: 'No downloaded depot was found yet: run the commands above in Steam\'s console first.' }
  const busy = depots.filter(d => d.dir && (depotStates.get(d.id) || {}).state !== 'done')
  if (busy.length) return { ok: false, error: `Depot ${busy.map(d => d.id).join(', ')} has not finished downloading. Nothing was changed.` }
  const gate = beginInstall('the game copy')
  if (!gate.ok) return { ok: false, error: gate.error }
  try {
    const line = copyProgressLine((_text, p) => send('downgrade:progress', { step: p.step === 'copy' ? 'gamecopy' : 'gamecheck', index: p.index, total: p.total, file: p.file }))
    const r = await createIsolatedImpl(undefined, false, { progress: line })
    depotStates.clear()
    if (!r.success) return { ok: false, error: r.error }
    log(`[downgrade] the game copy was filled from the depot downloads: ${r.copied || 0} file(s) in, ${r.kept || 0} already right`)
    return {
      ok: true, copy: true, copied: r.copied || 0, kept: r.kept || 0, dir: isolatedGameDir(),
      version: isolation.targetVersion(mo2.detectEdition(store.get('skyrimPath'))), runtime: downgradeRuntime(store.get('skyrimPath')),
    }
  } finally {
    endInstall()
  }
}

async function runDowngrade() {
  if (copyMode() === 'verified') return runCopyFromDepots()
  const a = downgradeTarget()
  if (!a || a.action !== 'downgrade') return { ok: false, error: 'This Skyrim folder does not need a downgrade.' }
  const running = await runningGameProcesses()
  if (running.length) return { ok: false, error: `Close ${running.join(', ')} first. Nothing was changed.` }
  const depots = downgradeDepots(a.gameDir)
  const pending = depots.filter(d => (depotStates.get(d.id) || {}).state !== 'done')
  if (pending.length) return { ok: false, error: `Depot ${pending.map(d => d.id).join(', ')} has not finished downloading. Nothing was changed.` }
  const plan = downgrade.planInstall(depots, a.gameDir, downgrade.stampOf(new Date()))
  const free = freeBytes(a.gameDir)
  if (free !== null && free < plan.bytes + 512 * 1024 ** 2) {
    return { ok: false, error: `Not enough free space on the game's drive: ${gb(plan.bytes)} needed, ${gb(free)} free. Nothing was changed.` }
  }
  log(`[downgrade] ${a.gameDir} (${a.version}): ${plan.jobs.length} file(s), ${plan.replaced} replaced, ${plan.added} added; backup ${plan.backupDir}`)
  const progress = p => send('downgrade:progress', p)
  await downgrade.verifyPlan(plan, { onProgress: progress })
  const res = await downgrade.runPlan(plan, { onProgress: progress })
  const installed = gameversion.readPeFileVersion(path.join(a.gameDir, 'SkyrimSE.exe'))
  if (installed !== gameversion.GAME_VERSION_REQUIRED) {
    return { ok: false, error: `The files were copied, but SkyrimSE.exe reads ${installed || 'unreadable'}. Press Restore to put the previous files back.` }
  }
  const refreshed = await refreshGameCopy(a.gameDir, plan.jobs.map(j => j.rel), [])
  depotStates.clear()
  log(`[downgrade] done: SkyrimSE.exe ${installed}, ${res.replaced} replaced, ${res.added} added, ${refreshed} refreshed in the game copy`)
  const acfPath = downgrade.acfPathFor(a.gameDir)
  return {
    ok: true, version: installed, replaced: res.replaced, added: res.added, refreshed,
    steamManaged: !!acfPath && fs.existsSync(acfPath), runtime: downgradeRuntime(a.gameDir),
  }
}

async function exclusive(fn) {
  if (downgradeBusy) return { ok: false, error: 'A Skyrim version step is already running.' }
  if (installGate.running()) return { ok: false, error: installGate.refusal() }
  downgradeBusy = true
  try { return await fn() } catch (err) {
    log(`[downgrade] ${err.message}`)
    return { ok: false, error: err.message }
  } finally { downgradeBusy = false }
}

ipcMain.handle('downgrade:install', () => exclusive(runDowngrade))

// Steam keeps each game's state in memory and writes the appmanifest itself, so it is only edited while Steam is closed
ipcMain.handle('downgrade:setAutoUpdate', () => exclusive(async () => {
  const a = downgradeTarget()
  const acfPath = a && downgrade.acfPathFor(a.gameDir)
  if (!acfPath || !fs.existsSync(acfPath)) return { ok: false, error: 'Steam does not manage this Skyrim folder, so it has no update setting to change.' }
  if (await isProcessRunning('steam.exe')) return { ok: false, steamRunning: true, error: 'Close Steam first (Steam > Exit): it rewrites this setting while it runs.' }
  const text = fs.readFileSync(acfPath, 'utf8')
  const out = downgrade.setAutoUpdateOnLaunch(text)
  if (!out.changed) return { ok: true, changed: false }
  const keep = path.join(app.getPath('userData'), 'downgrade', `appmanifest_${downgrade.APP_ID}.acf.${downgrade.stampOf(new Date())}`)
  fs.mkdirSync(path.dirname(keep), { recursive: true })
  fs.writeFileSync(keep, text)
  const tmp = `${acfPath}.dragonbreak-tmp`
  fs.writeFileSync(tmp, out.text)
  fs.renameSync(tmp, acfPath)
  log(`[downgrade] ${acfPath}: AutoUpdateBehavior 1 (only when launched from Steam); the old file is kept as ${keep}`)
  return { ok: true, changed: true }
}))

ipcMain.handle('downgrade:restore', async () => {
  const gameDir = store.get('skyrimPath')
  const backup = gameDir && downgrade.latestBackup(gameDir)
  if (!backup) return { ok: false, error: 'There is no downgrade backup to restore.' }
  const replaced = (backup.record.replaced || []).length
  const added = (backup.record.added || []).length
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Restore previous Skyrim files',
    message: 'Put back the Skyrim files the downgrade replaced?',
    detail: `${replaced} file(s) come back from ${backup.dir}, and the ${added} file(s) the downgrade added are removed.\n\n` +
      'Skyrim will be on the newer version again, and DragonBreak will not start until it is downgraded.',
    buttons: ['Restore', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  })
  if (response !== 0) return { ok: false, cancelled: true }
  return exclusive(async () => {
    const running = await runningGameProcesses()
    if (running.length) return { ok: false, error: `Close ${running.join(', ')} first. Nothing was changed.` }
    const plan = downgrade.planRestore(gameDir, backup.dir)
    const res = await downgrade.runRestore(plan, { onProgress: p => send('downgrade:progress', p) })
    await refreshGameCopy(gameDir, plan.record.replaced || [], plan.record.added || [])
    depotStates.clear()
    log(`[downgrade] restored ${backup.dir}: ${res.restored} file(s)${res.failed.length ? `, failed: ${res.failed.join(', ')}` : ''}`)
    return res.failed.length
      ? { ok: false, error: `${res.failed.length} file(s) could not be put back: ${res.failed.join(', ')}. Let Steam repair Skyrim instead.` }
      : { ok: true, restored: res.restored }
  })
})

function ccArchiveWarning(names) {
  return `Game archives missing: ${names.join(', ')}. The game still starts, but some buildings, stalls and plants will look purple or be missing. ` +
    `Copy only these .bsa files into your Skyrim install's Data folder from Steam\\${DOWNGRADE_DEPOT_DATA} if you have that folder, ` +
    'otherwise run the downgrade again (Settings > Repair > Skyrim Version), then press PLAY. Never verify or update Skyrim through Steam: it moves the game past 1.6.1170.'
}

async function prepareForLaunch(skyrimPath, viaMO2) {
  ensureClientDirs(skyrimPath)

  // Every PLAY logs both folders' exe versions and data sizes, so a report shows the game it ran
  try { logGameFolders() } catch (err) { log(`[version] could not check the game data: ${err.message}`) }

  // Version gate on the folder the game runs from: in isolated mode that is our copy (skyrimPath here is
  // effectiveGamePath()), never Steam's folder, so another launcher's change to Steam does not block a good copy.
  // The Skyrim Version panel opens and PLAY stops here.
  const ownCopy = !!store.get('isolatedGame') && skyrimPath === isolatedGameDir()
  const linkProblem = ownCopy ? copyLinkCheck(skyrimPath) : null
  if (linkProblem) return { success: false, error: linkProblem }
  const copyFix = () => {
    // The legacy copy is rebuilt from the Skyrim folder, which then has to be on 1.6.1170 itself
    const steam = downgradeTarget()
    if (copyMode() === 'verified' || (steam && steam.blocking)) showDowngradePanel()
    return 'Press Settings > Repair > Repair Game Copy to rebuild it' +
      (copyMode() === 'legacy' && steam && steam.blocking ? ' (downgrade your Skyrim folder in the Skyrim Version panel first)' : '') +
      ', then press PLAY again.'
  }
  const gv = gameversion.checkGameVersion(skyrimPath, mo2.detectEdition(skyrimPath))
  if (!gv.ok) {
    if (ownCopy) return { success: false, error: `DragonBreak's game copy has Skyrim ${gv.version}; it needs ${gv.required}. ${copyFix()}` }
    showDowngradePanel()
    return { success: false, error: `Skyrim ${gv.version} found in ${skyrimPath}; DragonBreak needs ${gv.required}. Downgrade it in the Skyrim Version panel, then press PLAY again.` }
  }
  // The 1.6.1170 exe on newer game data blocks too (Nate, 2026-09-29): 1.7.99 changed the masters and archives, not the
  // exe. Only a Steam install's "newer data" verdict counts; "unknown" (GOG, a missing file) stays in the log.
  const target = playTarget()
  if (target && target.action === 'downgrade' && target.blocking) {
    const differ = (target.newerData || []).join(', ') || 'the exe'
    if (ownCopy) return { success: false, error: `DragonBreak's game copy has game data from a newer Steam update (${differ} differ from 1.6.1170). ${copyFix()}` }
    showDowngradePanel()
    return {
      success: false,
      error: `Skyrim's game data is from a newer Steam update (${differ} differ from 1.6.1170). ` +
        'DragonBreak needs 1.6.1170: downgrade it in the Skyrim Version panel, then press PLAY again.',
    }
  }

  const srv = activeServer()
  let serverInfo = null
  if (srv) {
    try { serverInfo = await fetchJSON(`${config.apiUrl}/api/serverinfo`) } catch {}
  }

  // Non-portable installs play from the user's real Skyrim folder: quarantine
  // Creation Club content the server doesn't use into "disabled CC mods", or
  // the engine force-loads it via Skyrim.ccc and fights the server load order.
  // The isolated game copy only holds the free CC files, so it is skipped.
  if (skyrimPath === store.get('skyrimPath')) {
    mo2.disableCcContent(skyrimPath, serverInfo?.loadOrder)
  }

  // Staging gate: surface everything missing before we write settings or launch
  const notReady = verifyLaunchReadiness(skyrimPath, viaMO2, serverInfo)
  if (notReady.length > 0) {
    return { success: false, error: 'Not ready to launch:\n' + notReady.map(p => '• ' + p).join('\n') }
  }

  if (srv) {
    const settingsPath = path.join(skyrimPath, 'Data', 'Platform', 'Plugins', 'skymp5-client-settings.txt')
    try {
      writeClientSettings(settingsPath, srv, serverInfo)
      log('[launch] client settings written')
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  // A CC plugin without its archive still loads, so this only warns
  const lostArchives = mo2.missingCcArchives(skyrimPath, serverInfo?.loadOrder)
  const warning = lostArchives.length > 0 ? ccArchiveWarning(lostArchives) : null
  if (warning) log('[launch] ' + warning)

  // Every control map the game reads must hold all its input contexts, with CRLF lines: a short one crashed every
  // container and froze the menu cursor (controlmapCheck.js). The seed goes first, so our own copy is converted rather
  // than moved aside, and again after, to refill Data when a map there was moved aside.
  applyControlmapOverride(skyrimPath)
  try {
    let maps = null
    if (viaMO2) {
      let mods = []
      try { mods = controlmapCheck.enabledMods(fs.readFileSync(path.join(mo2.getProfileDir(), 'modlist.txt'), 'utf8')) } catch { /* no profile yet */ }
      maps = { overwriteDir: path.join(mo2.getRoot(), 'overwrite'), modsDir: mo2.getModsDir(), mods }
    }
    for (const line of controlmapCheck.checkControlmaps({ gameDir: skyrimPath, mo2: maps })) log(`[launch] ${line}`)
  } catch (err) {
    log(`[launch] could not check the control maps: ${err.message}`)
  }

  applyControlmapOverride(skyrimPath)

  // Load order sync
  let loadOrderFixed = false
  // Heal the instance ini (paths + SKSE shortcut) before every MO2 launch, even when serverinfo is unavailable.
  if (viaMO2) mo2.ensureInstance(skyrimPath, serverInfo?.loadOrder)
  if (Array.isArray(serverInfo?.loadOrder) && serverInfo.loadOrder.length > 0) {
    if (viaMO2) {
      const missing = missingPluginsForMO2(skyrimPath, serverInfo.loadOrder)
      if (missing.length > 0) {
        return {
          success: false,
          error: `Missing required plugins: ${missing.join(', ')}. ` +
                 `Run Repair Modlist in Settings first.`,
        }
      }
      loadOrderFixed = true
    } else {
      const result = fixLoadOrder(skyrimPath, serverInfo.loadOrder)
      loadOrderFixed = result.changed
      if (result.missing.length > 0) {
        return {
          success: false,
          error: `Missing required plugins: ${result.missing.join(', ')}. ` +
                 `Install the server's modlist first (see the Modlist panel).`,
        }
      }
      if (result.changed) log('[launch] plugins.txt updated to match server load order')
    }
  } else {
    log('[launch] server load order unavailable - leaving plugins.txt untouched')
  }

  // MO2 lockdown
  // Disables plugins or skse scripts not part of the server files
  if (viaMO2) {
    // Wipe stray plugins/BSAs from the overwrite folder first: they load at top
    // priority and would otherwise desync the client load order from the server.
    const wiped = mo2.cleanOverwrite()
    if (wiped.length > 0) log(`[launch] cleaned stray overwrite items: ${wiped.join(', ')}`)
    // Data\Platform files a game run left in overwrite outrank the game folder's (the page, the session)
    for (const line of mo2.cleanOverwritePlatform()) log(`[launch] ${line}`)
    // Profiles made before 2.1.34 with no inis to copy hold only the launcher's own writes
    seedProfilePrefs(store.get('skyrimPath') || skyrimPath)
    seedProfileSkyrimIni(skyrimPath)
    const removed = mo2.enforceModRules()
    if (removed.length > 0) log(`[launch] disabled unauthorised mods: ${removed.join(', ')}`)
  }

  // Launch sanity check: report our files version + plugin list so the backend
  // approves this session for the game server's session validation. Backend
  // unreachable = fail open (the server itself still enforces at connect).
  const session = store.get('gameSession')
  if (session && serverInfo && serverInfo.offlineMode === false) {
    try {
      const check = await postJSON(`${config.apiUrl}/api/launch-check`, {
        filesVersion: store.get('filesVersion') || '',
        plugins: Array.isArray(serverInfo.loadOrder)
          ? serverInfo.loadOrder.map(f => path.basename(f))
          : [],
      }, { 'x-session': session })
      if (!check.ok) {
        if (check.filesOk === false) {
          return { success: false, error: 'Your client files are out of date. Press the button again to update, then launch.' }
        }
        return { success: false, error: 'Your plugin load order does not match the server. Run Repair Modlist in Settings.' }
      }
      log('[launch] launch-check passed')
    } catch (err) {
      // 401: the session expired and launching would only end in "not authorized", so ask for a fresh login
      if (err.statusCode === 401) {
        log('[launch] Discord session expired - cleared, user must log in again')
        clearDiscordAuth()
        return { success: false, authExpired: true, error: 'Your Discord login has expired. Log in again from the top bar, then press PLAY.' }
      }
      log(`[launch] launch-check unavailable (${err.message}) - continuing, server will enforce`)
    }
  }

  // SKSE, client files, plugins, and Discord auth were all confirmed by the staging gate above. Last step before the
  // game starts: the player's Creations catalog goes aside, and comes back once the game has closed
  moveCatalogForLaunch()
  return { success: true, loadOrderFixed, ...(warning ? { warning } : {}) }
}

const VANILLA_MASTERS = new Set([
  'skyrim.esm', 'update.esm', 'dawnguard.esm', 'hearthfires.esm', 'dragonborn.esm', '_resourcepack.esl',
])

function pluginsTxtDirs() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const variants = [
    'Skyrim Special Edition',
    'Skyrim Special Edition GOG',
    'Skyrim Special Edition EPIC',
    'Skyrim Special Edition MS',
  ]
  const existing = variants.map(v => path.join(local, v)).filter(p => fs.existsSync(p))
  return existing.length > 0 ? existing : [path.join(local, variants[0])]
}

// Plugin sync
function fixLoadOrder(skyrimPath, serverLoadOrder) {
  const dataDir = path.join(skyrimPath, 'Data')

  const serverPlugins = serverLoadOrder
    .map(f => path.basename(f))
    .filter(f => !VANILLA_MASTERS.has(f.toLowerCase()))

  const missing = serverPlugins.filter(f => !fs.existsSync(path.join(dataDir, f)))
  if (missing.length > 0) return { changed: false, missing }

  const next  = serverPlugins.map(f => `*${f}`).join('\r\n') + '\r\n'
  let changed = false

  for (const dir of pluginsTxtDirs()) {
    const pluginsPath = path.join(dir, 'Plugins.txt')

    let current = null
    try { current = fs.readFileSync(pluginsPath, 'utf8') } catch {}

    if (current !== next) {
      const dropped = (current || '')
        .split(/\r?\n/)
        .filter(l => l.startsWith('*'))
        .map(l => l.slice(1).trim())
        .filter(f => f && !serverPlugins.some(p => p.toLowerCase() === f.toLowerCase()) &&
                     !VANILLA_MASTERS.has(f.toLowerCase()))
      if (dropped.length > 0) {
        log(`[launch] disabling client-side plugins (not allowed on this server): ${dropped.join(', ')}`)
      }
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(pluginsPath, next)
      changed = true
      log(`[launch] wrote ${pluginsPath} (exactly ${serverPlugins.length} server plugins)`)
    }
  }

  return { changed, missing: [] }
}

function missingPluginsForMO2(skyrimPath, serverLoadOrder) {
  const dataDir = path.join(skyrimPath, 'Data')
  const modsDir = mo2.getModsDir()

  let modDirs = []
  try {
    modDirs = fs.readdirSync(modsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => path.join(modsDir, e.name))
  } catch {}

  return serverLoadOrder
    .map(f => path.basename(f))
    .filter(f => !VANILLA_MASTERS.has(f.toLowerCase()))
    .filter(f =>
      !fs.existsSync(path.join(dataDir, f)) &&
      !modDirs.some(dir => fs.existsSync(path.join(dir, f))))
}

// Install files

let installAbort = null   // AbortController for the running install's waits
let installStateAt = 0

// The progress panel's state: at once for a step change or the end, else at most ten times a second
function sendInstallState(now = false) {
  if (!now && Date.now() - installStateAt < 100) return
  installStateAt = Date.now()
  send('install:state', installTrack.snapshot())
}
// flow: 'mo2' or 'client' draw a weighted bar; anything else a bar that only shows the install is working
function beginInstall(what, flow = 'other') {
  const gate = installGate.begin(what)
  if (!gate.ok) return gate
  installTrack.begin(flow)
  sendInstallState(true)
  return gate
}
function endInstall() {
  installGate.end()
  installTrack.end()
  sendInstallState(true)
}
function installStep(id, info) {
  installTrack.step(id, info)
  sendInstallState(true)
}

// opts.force: 'client' re-downloads the zip, 'modlist' rebuilds every mod (Repair buttons).
ipcMain.on('install:start', (_e, mode, opts) => {
  const mo2Run = mode === 'mo2' || mode === 'modlist' || (mode !== 'client' && !!store.get('mo2Enabled'))
  const gate = beginInstall(mode === 'client' ? 'the client files' : 'the modpack', mo2Run ? 'mo2' : 'client')
  if (!gate.ok) {
    // Never ignore the click silently: the user has no other way to know an
    // earlier install is still running (e.g. parked on a downloads wait).
    send('install:progress', {
      phase: 'mods',
      file: 'An install is already running - press Cancel Install to stop it first.',
      index: 0, total: 0, skipped: false,
    })
    send('install:complete', { success: false, error: 'An install is already running - wait for it to finish.' })
    return
  }
  installAbort = new AbortController()
  const force = !!(opts && opts.force)

  let fn
  if (mode === 'client') {
    fn = runDirectInstall(force)
  } else if (mode === 'mo2') {
    fn = runMO2Install()
  } else if (mode === 'modlist') {
    fn = runMO2Install({ modlistOnly: true, force })
  } else {
    // Auto mode (used by the Play button) - delegate based on mo2Enabled setting
    fn = store.get('mo2Enabled') ? runMO2Install() : runDirectInstall()
  }
  fn.catch(err => {
    log('[install] Unhandled error:', err.message)
    send('install:complete', { success: false, error: `Unexpected error: ${err.message}` })
    endInstall()
  })
})

// Cancels the running install at its next wait/step boundary.
ipcMain.on('install:cancel', () => {
  if (installGate.running() && installAbort) installAbort.abort()
})

// Standalone install steps (Repair tab buttons); all stream progress over the shared install:progress channel.

// MO2 only: download/unpack MO2 and refresh the portable instance. force reinstalls MO2's own files.
ipcMain.handle('install:mo2only', async (_e, opts) => {
  const gate = beginInstall('Mod Organizer 2')
  if (!gate.ok) return { success: false, error: gate.error }
  try {
    const skyrimPath = store.get('skyrimPath')
    if (skyrimPath && pathsOverlap(skyrimPath, mo2.getRoot())) {
      return { success: false, error: 'The install location is inside your Skyrim folder - pick one outside it in Settings before repairing MO2.' }
    }
    if (await isProcessRunning('ModOrganizer.exe')) {
      return { success: false, error: 'Mod Organizer 2 is running - close it before repairing.' }
    }
    const progress = msg => send('install:progress', { phase: 'download', file: msg, index: 0, total: 0, skipped: false })
    if (opts && opts.force) await mo2.reinstall(progress)
    else await mo2.ensureInstalled(progress)
    if (store.get('isolatedGame') && !isolatedGameReady()) {
      log('[install] mo2only: game copy not ready, leaving the original install untouched')
    } else {
      const gamePath = effectiveGamePath()
      if (gamePath && fs.existsSync(path.join(gamePath, 'SkyrimSE.exe'))) {
        let serverInfo = null
        try { serverInfo = await fetchJSON(`${config.apiUrl}/api/serverinfo`) } catch {}
        mo2.ensureInstance(gamePath, serverInfo?.loadOrder)
        mo2.writeNxmHandlerIni()
        applyForcedServerDefaults(gamePath)
      }
    }
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  } finally {
    endInstall()
  }
})

// SKSE only: download the edition-matched SKSE and install it into the game root. force drops the cached archive so a fresh copy is fetched.
ipcMain.handle('install:skse', async (_e, opts) => {
  if (installGate.running()) return { success: false, error: installGate.refusal() }
  // With isolation on, SKSE must land in the portable copy, never the original install
  let gamePath
  if (store.get('isolatedGame')) {
    gamePath = isolatedGameDir()
    if (!isolatedGameReady()) {
      return { success: false, error: 'Install the game copy first - SKSE belongs in the portable copy, not your original Skyrim.' }
    }
  } else {
    gamePath = effectiveGamePath()
  }
  if (!gamePath || !fs.existsSync(path.join(gamePath, 'SkyrimSE.exe'))) {
    return { success: false, error: 'No game folder found - install the game copy or set a valid Skyrim path first.' }
  }
  beginInstall('SKSE')
  try {
    if (opts && opts.force) {
      try { fs.rmSync(path.join(mo2.getDownloadsDir(), mo2.skseSourceFor(gamePath).fileName), { force: true }) } catch {}
      store.set('installedRootHash', '')
    }
    await installSkseIntoRoot(gamePath)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  } finally {
    endInstall()
  }
})

// Read-only integrity scan over every Repair section; nothing on disk changes.
ipcMain.handle('install:check', async () => {
  const gate = beginInstall('the file check')
  if (!gate.ok) return { ok: false, error: gate.error }
  try {
    return await checkFilesImpl()
  } catch (err) {
    return { ok: false, error: err.message }
  } finally {
    endInstall()
  }
})

const CHECK_PROGRESS_EVERY = 25
const CHECK_NOTE_SAMPLE    = 10
// Files under Data/Platform and Data/SKSE/Plugins written by the launcher, Skyrim Platform or SKSE rather than shipped in the client zip.
const CLIENT_OWN_FILE_RES = [/^data\/platform\/(logs|pluginsnoload|pluginsdev)\//, /skymp5-client-settings\.txt$/, /\.log$/, /^data\/skse\/plugins\/skse64_/]

function crc32File(p) {
  return new Promise((resolve, reject) => {
    let crc = 0
    fs.createReadStream(mo2.lp(p))
      .on('data', d => { crc = zlib.crc32(d, crc) })
      .on('end', () => resolve((crc >>> 0).toString(16).toUpperCase().padStart(8, '0')))
      .on('error', reject)
  })
}

// Issues carry { kind: missing|corrupt|extra|outdated, path, fix: mo2|game|skse|client|modlist }; notes explain skipped checks.
async function checkFilesImpl() {
  const issues = []
  const notes  = []
  let ev = null // the per-file sync manifest, shared by the client-files and DragonBreak-files sections
  const root   = mo2.getRoot()
  const show   = p => {
    const r = path.relative(root, p)
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : p
  }
  const add = (kind, p, fix) => {
    issues.push({ kind, path: p, fix })
    log(`[check] [${kind}] ${p} -> ${fix}`)
  }
  const progress = file => send('install:progress', { phase: 'check', file, index: 0, total: 0, skipped: false })
  const yieldNow = () => new Promise(r => setImmediate(r))
  const sizeOf   = p => { try { return fs.statSync(mo2.lp(p)).size } catch { return -1 } }
  // Size first, so multi-GB files are only hashed when they could still match.
  const verifyFile = async (full, f, label, fix) => {
    const size = sizeOf(full)
    if (size === -1) return add('missing', label, fix)
    if (Number.isFinite(f.size) && size !== f.size) return add('corrupt', `${label} (size ${size}, expected ${f.size})`, fix)
    if (!f.sha256) return
    let sha = ''
    try { sha = await mo2.sha256FileAsync(full) } catch { return add('corrupt', `${label} (unreadable)`, fix) }
    if (sha.toLowerCase() !== String(f.sha256).toLowerCase()) add('corrupt', `${label} (sha256)`, fix)
  }
  const portable = !!store.get('isolatedGame')
  const gamePath = portable ? isolatedGameDir() : store.get('skyrimPath')
  const gameOk   = !!gamePath && fs.existsSync(path.join(gamePath, 'SkyrimSE.exe'))

  // MO2
  progress('Checking Mod Organizer 2…')
  if (!mo2.isInstalled()) {
    add('missing', 'ModOrganizer.exe', 'mo2')
  } else {
    const stamp = mo2.readMo2Stamp()
    if (!stamp) add('missing', `${mo2.MO2_STAMP} (MO2 binaries unverified)`, 'mo2')
    else if (stamp.version !== mo2.MO2_VERSION) add('outdated', `ModOrganizer.exe (${stamp.version}, launcher ships ${mo2.MO2_VERSION})`, 'mo2')
    else {
      const now = mo2.mo2BinaryStats()
      if (now.size !== stamp.size || now.count !== stamp.count) {
        add('corrupt', `MO2 binaries (${now.count} files / ${now.size} bytes, stamp ${stamp.count} / ${stamp.size})`, 'mo2')
      }
    }
    for (const f of ['portable.txt', 'ModOrganizer.ini']) if (!fs.existsSync(path.join(root, f))) add('missing', f, 'mo2')
    for (const f of ['modlist.txt', 'plugins.txt']) {
      if (!fs.existsSync(path.join(mo2.getProfileDir(), f))) add('missing', `profiles/${mo2.PROFILE}/${f}`, 'mo2')
    }
  }
  await yieldNow()

  // Game copy (portable only; a real install has no clean source to compare against)
  if (portable) {
    progress('Checking the game copy…')
    const src = store.get('skyrimPath')
    if (!gameOk) {
      add('missing', show(path.join(gamePath, 'SkyrimSE.exe')), 'game')
    } else if (copyMode() === 'verified') {
      // Against the copy's own record, never the Steam folder (reads nothing but the copy; changes nothing)
      const record = await gamecopy.readRecord(gamePath)
      const manifest = record && copyManifest(record.platform === 'gog' ? 'GOG' : 'Steam', record.language || 'english')
      if (!record || !manifest || !manifest.ready) {
        add('missing', `${show(path.join(gamePath, gamecopy.RECORD_FILE))} (the next PLAY checks the game copy by hash)`, 'game')
      } else {
        const d = await gamecopy.drift(gamePath, record, manifest, { allowRootDlls: rootDllAllow(gamePath), allowLink: copyLinkAllowed() })
        for (const rel of d.missing) add('missing', show(gamecopy.safeJoin(gamePath, rel)), 'game')
        for (const rel of d.changed) add('corrupt', show(gamecopy.safeJoin(gamePath, rel)), 'game')
        for (const rel of d.linked) add('corrupt', `${show(gamecopy.safeJoin(gamePath, rel))} (linked to another install)`, 'game')
        for (const n of isolation.dllsToSetAside(d.extraRootDlls)) add('corrupt', `${show(path.join(gamePath, n))} (another program's DLL)`, 'game')
      }
    } else {
      // Legacy copy: by size against the Skyrim folder, but only while that folder is on 1.6.1170 itself; a folder
      // another launcher changed says nothing about our copy
      const trust = src ? isolation.trustSource(src, mo2.detectEdition(src)) : { ok: false, why: 'no Skyrim folder is set' }
      if (src && trust.ok && fs.existsSync(path.join(src, 'Data', 'Skyrim.esm'))) {
        for (const job of vanillaMismatches(src, gamePath)) {
          const full = path.join(gamePath, job.sub, job.rel)
          add(sizeOf(full) === -1 ? 'missing' : 'corrupt', show(full), 'game')
        }
      } else {
        notes.push(`Game copy: the vanilla files were not compared with your Skyrim folder (${trust.ok ? 'it is unreadable' : trust.why}).`)
        if (!gameCopyComplete(gamePath)) add('missing', `${show(path.join(gamePath, 'Data', 'Skyrim.esm'))} (game copy incomplete)`, 'game')
      }
      const marker = path.join(gamePath, isolation.COPY_MARKER)
      if (!fs.existsSync(marker)) add('missing', show(marker), 'game')
      const ccc = sizeOf(path.join(gamePath, 'Skyrim.ccc'))
      if (ccc !== 0) add(ccc === -1 ? 'missing' : 'corrupt', `${show(path.join(gamePath, 'Skyrim.ccc'))}${ccc > 0 ? ' (must be empty)' : ''}`, 'game')
    }
    await yieldNow()
  }

  if (!gameOk) {
    notes.push('SKSE and client files: no game folder found, both sections skipped.')
  } else {
    // SKSE
    progress('Checking SKSE…')
    const skse    = mo2.skseSourceFor(gamePath)
    const archive = path.join(mo2.getDownloadsDir(), skse.fileName)
    const entries = fs.existsSync(archive) ? await mo2.listArchiveEntries(archive) : null
    if (entries) {
      // installSkse copies every exe/dll from the archive root, one wrapper folder deep at most.
      for (const e of entries) {
        const parts = e.path.split('/')
        const name  = parts[parts.length - 1]
        if (parts.length > 2 || !/\.(exe|dll)$/i.test(name)) continue
        const full = path.join(gamePath, name)
        const size = sizeOf(full)
        if (size === -1) add('missing', show(full), 'skse')
        else if (size !== e.size) add('corrupt', `${show(full)} (size ${size}, archive ${e.size})`, 'skse')
        else if (e.crc && typeof zlib.crc32 === 'function' && await crc32File(full) !== e.crc) add('corrupt', `${show(full)} (crc)`, 'skse')
      }
    } else {
      notes.push(`SKSE: no cached ${skse.fileName} in downloads, so the root files were only checked for presence.`)
      let names = []
      try { names = fs.readdirSync(gamePath) } catch {}
      if (!names.some(n => /^skse64_loader\.exe$/i.test(n))) add('missing', show(path.join(gamePath, 'skse64_loader.exe')), 'skse')
      if (!names.some(n => /^skse64_.*\.dll$/i.test(n))) add('missing', `${show(path.join(gamePath, 'skse64_*.dll'))} (runtime dll)`, 'skse')
    }
    if (!fs.existsSync(path.join(mo2.getModsDir(), 'SKSE', 'meta.ini'))) add('missing', 'mods/SKSE/meta.ini', 'skse')
    await yieldNow()

    // Client files. The per-file sync (DragonBreak files) owns anything it lists, so those are checked
    // against its manifest below; the zip's copy of a plugin can lag behind it.
    progress('Checking client files…')
    try { ev = await fetchExtraManifest() }
    catch (err) { notes.push(`DragonBreak files: could not read the server list (${err.message}), section skipped.`) }
    const syncOwned = new Set(extraEntries(ev, gamePath).map(x => x.path.toLowerCase()))
    let vd = null
    try { vd = await fetchJSON(`${config.apiUrl}/api/files/version`) }
    catch (err) { notes.push(`Client files: could not read the server version (${err.message}), version and checksum checks skipped.`) }
    if (vd) {
      const installed = store.get('filesVersion') || ''
      if (vd.version !== installed) add('outdated', `client files (installed ${installed || 'none'}, server ${vd.version})`, 'client')
    }
    const files = vd && Array.isArray(vd.files)
      ? vd.files.filter(f => f && typeof f.path === 'string' && !f.path.split('/').includes('..'))
      : []
    if (files.length === 0) {
      if (vd) notes.push('Client files: the server publishes no per-file list, so only presence and version were checked.')
      for (const f of REQUIRED_FILES) if (!fs.existsSync(path.join(gamePath, f))) add('missing', show(path.join(gamePath, f)), 'client')
      if (!preloaderPresent(gamePath)) add('missing', `${show(path.join(gamePath, PRELOADER_DLLS[0]))} (Engine Fixes preloader)`, 'client')
    } else {
      const listed = new Set()
      for (let i = 0; i < files.length; i++) {
        const f    = files[i]
        const full = path.join(gamePath, ...f.path.split('/'))
        const l    = f.path.toLowerCase()
        listed.add(l)
        // Launcher-owned files are rewritten on every launch, so the published hash never matches
        if (CLIENT_OWN_FILE_RES.some(re => re.test(l)) || syncOwned.has(l)) continue
        await verifyFile(full, f, show(full), 'client')
        if ((i + 1) % CHECK_PROGRESS_EVERY === 0) { progress(`Checking client files… ${i + 1}/${files.length}`); await yieldNow() }
      }
      // Unlisted files are only reported: Repair Client Files re-extracts the zip and never deletes
      const extras = []
      for (const sub of ['Data/Platform', 'Data/SKSE/Plugins']) {
        for (const rel of mo2.listFilesRel(path.join(gamePath, ...sub.split('/')))) {
          const p = `${sub}/${rel}`
          const l = p.toLowerCase()
          if (listed.has(l) || CLIENT_OWN_FILE_RES.some(re => re.test(l))) continue
          extras.push(show(path.join(gamePath, ...p.split('/'))))
        }
      }
      if (extras.length) {
        const more = extras.length > CHECK_NOTE_SAMPLE ? ` and ${extras.length - CHECK_NOTE_SAMPLE} more` : ''
        notes.push(`Client files: ${extras.length} file(s) not in the server package were left alone: ${extras.slice(0, CHECK_NOTE_SAMPLE).join(', ')}${more}.`)
      }
    }
    await yieldNow()
  }

  // DragonBreak files (repaired with the client files, which re-runs syncExtraFiles)
  if (gameOk) {
    progress('Checking DragonBreak files…')
    const files = store.get('dboFilesDisabled') ? [] : extraEntries(ev, gamePath)
    if (store.get('dboFilesDisabled')) notes.push('DragonBreak files are disabled (Settings > Repair > Enable DragonBreak Files); PLAY enables them again.')
    for (let i = 0; i < files.length; i++) {
      const full = path.join(gamePath, ...files[i].path.split('/'))
      await verifyFile(full, files[i], show(full), 'client')
      if ((i + 1) % CHECK_PROGRESS_EVERY === 0) { progress(`Checking DragonBreak files… ${i + 1}/${files.length}`); await yieldNow() }
    }
  }

  // Modlist
  progress('Fetching the install manifest…')
  let manifest = null
  try { manifest = await fetchJSON(`${config.apiUrl}/api/install-manifest`) }
  catch (err) { notes.push(`Modlist: could not fetch the install manifest (${err.serverError || err.message}), section skipped.`) }
  if (manifest && Array.isArray(manifest.mods)) {
    const modsDir  = mo2.getModsDir()
    const sanitize = n => String(n).replace(/[<>:"/\\|?*]/g, '')
    const total    = manifest.mods.length
    let skippedConfigChecks = 0
    for (let i = 0; i < total; i++) {
      const m      = manifest.mods[i]
      const folder = sanitize(m.name)
      const dir    = path.join(modsDir, folder)
      progress(`Checking mods… ${i + 1}/${total} (${m.name})`)
      if (!fs.existsSync(mo2.lp(dir))) { add('missing', `mods/${folder}`, 'modlist'); continue }
      if (m.hash && mo2.readModHash(m.name) !== m.hash) add('outdated', `mods/${folder} (installed from an older manifest)`, 'modlist')
      const files    = Array.isArray(m.files) ? m.files : []
      const expected = new Set(files.map(f => String(f.to).toLowerCase()))
      for (let n = 0; n < files.length; n++) {
        const f = files[n]
        // A plugin or MCM rewrites these itself; an edited copy is not damage (mo2.isRewrittenConfig)
        if (mo2.isRewrittenConfig(f.to)) { skippedConfigChecks++; continue }
        await verifyFile(path.join(dir, ...String(f.to).split('/')), f, `mods/${folder}/${f.to}`, 'modlist')
        if ((n + 1) % CHECK_PROGRESS_EVERY === 0) {
          progress(`Checking mods… ${i + 1}/${total} (${m.name}: ${n + 1}/${files.length} files)`)
          await yieldNow()
        }
      }
      for (const rel of mo2.listFilesRel(dir)) {
        const l = rel.toLowerCase()
        if (l === 'meta.ini' || expected.has(l) || /\.log(\.\d+)?$/.test(l) || mo2.isRewrittenConfig(rel)) continue
        add('extra', `mods/${folder}/${rel}`, 'modlist')
      }
      await yieldNow()
    }

    if (skippedConfigChecks) log(`[check] ${skippedConfigChecks} config file(s) that plugins or MCM rewrite were not compared`)
    progress('Checking the MO2 profile…')
    const order = (Array.isArray(manifest.order) && manifest.order.length) ? manifest.order.slice() : manifest.mods.map(m => m.name)
    for (const name of mo2.listStaleManagedMods(order)) add('extra', `mods/${name}`, 'modlist')

    const profile   = mo2.getProfileDir()
    const readLines = p => {
      try { return fs.readFileSync(p, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')) }
      catch { return null }
    }
    const plugins = readLines(path.join(profile, 'plugins.txt'))
    if (plugins && Array.isArray(manifest.plugins) && manifest.plugins.length) {
      // Every launch rewrites plugins.txt from the server load order, so that rendering counts as intact too.
      // MO2 appends disabled entries for plugins it discovers, so only the enabled sequence is compared.
      let serverInfo = null
      try { serverInfo = await fetchJSON(`${config.apiUrl}/api/serverinfo`) } catch {}
      const enabled  = lines => lines.filter(l => l.startsWith('*')).join('\n')
      const accepted = [manifest.plugins, mo2.serverPluginLines(serverInfo?.loadOrder)].filter(a => a.length).map(enabled)
      if (!accepted.includes(enabled(plugins))) {
        if (mo2.serverPluginLines(serverInfo?.loadOrder).length) notes.push(`Modlist: profiles/${mo2.PROFILE}/plugins.txt was rewritten by MO2; the launcher restores the server order at every launch.`)
        else add('corrupt', `profiles/${mo2.PROFILE}/plugins.txt (load order drift)`, 'modlist')
      }
    }
    const modlist = readLines(path.join(profile, 'modlist.txt'))
    if (modlist) {
      const want = order.slice()
      if (fs.existsSync(path.join(modsDir, 'SKSE')) && !want.includes('SKSE')) want.push('SKSE')
      const have = modlist.filter(l => /^[+-]/.test(l)).slice(0, want.length)
      if (have.join('\n') !== want.map(n => `+${n}`).join('\n')) add('corrupt', `profiles/${mo2.PROFILE}/modlist.txt (mod order drift)`, 'modlist')
    }
    for (const name of mo2.listOverwriteJunk()) add('extra', `overwrite/${name}`, 'modlist')
  }

  log(`[check] done: ${issues.length} issue(s)`)
  return { ok: true, issues, notes }
}

// DragonBreak files on/off: the per-file sync's plugins, archives and assets leave the game copy so the
// same install can join another server, and come back on Enable or on the next PLAY here.
const removeEmptyParents = (file, stopAt) => {
  let dir = path.dirname(file)
  while (dir.length > stopAt.length && dir.startsWith(stopAt)) {
    try { if (fs.readdirSync(dir).length) break; fs.rmdirSync(dir) } catch { break }
    dir = path.dirname(dir)
  }
}
ipcMain.handle('extras:state', () => ({
  disabled: !!store.get('dboFilesDisabled'),
  count: (store.get('extraFilesInstalled') || []).length,
  baseDir: store.get('baseDirPath') || DEFAULT_BASE_DIR,
}))
ipcMain.handle('extras:disable', async () => {
  if (installGate.running()) return { success: false, error: installGate.refusal() }
  try {
    const gamePath = effectiveGamePath()
    if (!gamePath) return { success: false, error: 'No game copy is installed.' }
    if (await gameProcessRunning()) return { success: false, error: 'Close Skyrim first.' }
    let paths = store.get('extraFilesInstalled') || []
    try { paths = extraEntries(await fetchExtraManifest(), gamePath).map(f => f.path) } catch { /* offline: the remembered list */ }
    const dataDir = path.join(gamePath, 'Data')
    let removed = 0
    for (const p of paths) {
      const full = path.join(gamePath, ...p.split('/'))
      try { fs.unlinkSync(mo2.lp(full)); removed++ } catch { /* already gone */ }
      removeEmptyParents(full, dataDir)
    }
    store.set('dboFilesDisabled', true)
    store.set('extraHashCache', {})
    log(`[extras] disabled: removed ${removed} of ${paths.length} DragonBreak file(s)`)
    return { success: true, removed, total: paths.length }
  } catch (err) { return { success: false, error: err.message } }
})
ipcMain.handle('extras:enable', async () => {
  if (installGate.running()) return { success: false, error: installGate.refusal() }
  try {
    const gamePath = effectiveGamePath()
    if (!gamePath) return { success: false, error: 'No game copy is installed.' }
    if (await gameProcessRunning()) return { success: false, error: 'Close Skyrim first.' }
    store.set('dboFilesDisabled', false)
    const r = await syncExtraFiles(gamePath)
    if (r.success) log(`[extras] enabled: ${r.count} file(s) restored`)
    return r
  } catch (err) { return { success: false, error: err.message } }
})
// Uninstall: the whole install location (game copy, MO2, mods, downloads) goes; the launcher and its settings stay
ipcMain.handle('install:uninstall', async () => {
  if (installGate.running()) return { success: false, error: installGate.refusal() }
  try {
    const base = store.get('baseDirPath') || DEFAULT_BASE_DIR
    if (await gameProcessRunning()) return { success: false, error: 'Close Skyrim first.' }
    if (!fs.existsSync(base)) return { success: true, removed: false, base }
    // Refuse anything that is not our own layout, so a wrong path never wipes a real folder
    const ours = fs.existsSync(path.join(base, 'skyrim', 'vanilla-copy-complete.json')) || fs.existsSync(path.join(base, 'ModOrganizer.exe')) || fs.existsSync(path.join(base, 'portable.txt'))
    if (!ours) return { success: false, error: `${base} does not look like a DragonBreak install; nothing was removed.` }
    const win = BrowserWindow.getAllWindows()[0]
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Uninstall', 'Cancel'], defaultId: 1, cancelId: 1,
      title: 'Uninstall DragonBreak',
      message: 'Remove the DragonBreak install?',
      detail: `This deletes ${base}: the game copy, Mod Organizer, every downloaded mod and the DragonBreak files. Your Steam copy of Skyrim and this launcher's settings are not touched.`,
    })
    if (response !== 0) return { success: false, cancelled: true }
    send('install:progress', { phase: 'uninstall', file: 'Removing the DragonBreak install…', index: 0, total: 0, skipped: false })
    await new Promise((resolve, reject) => fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }, err => err ? reject(err) : resolve()))
    for (const k of ['filesVersion', 'modpackState', 'extraHashCache', 'extraFilesInstalled', 'dboFilesDisabled', 'cachedServers']) store.delete(k)
    log(`[uninstall] removed ${base}`)
    return { success: true, removed: true, base }
  } catch (err) { return { success: false, error: err.message } }
})

// Shared download + extract helpers

/**
 * Stream the client zip from the backend to a local temp file.
 * Calls onProgress(bytesReceived, totalBytes) as data arrives.
 */
function downloadClientZip(tempPath, onProgress) {
  const url = `${config.apiUrl}/api/files/zip`
  return new Promise((resolve, reject) => {
    try { assertSecureDownloadUrl(url) } catch (err) { return reject(err) }
    let file = null
    let settled = false
    const finish = () => { if (!settled) { settled = true; resolve() } }
    // Destroy the stream before unlinking: an open handle leaves the partial file delete-pending on Windows and blocks every retry this session.
    const fail = err => {
      if (settled) return
      settled = true
      if (file && !file.destroyed) {
        file.once('close', () => { try { fs.unlinkSync(tempPath) } catch {} reject(err) })
        file.destroy()
      } else {
        try { fs.unlinkSync(tempPath) } catch {}
        reject(err)
      }
    }
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, res => {
      if (res.statusCode === 404) {
        res.resume()
        return fail(new Error('Update package not found on server. Run npm run merge on the backend.'))
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume()
        return fail(new Error(`Server returned HTTP ${res.statusCode}`))
      }

      const total    = parseInt(res.headers['content-length'] || '0', 10)
      let   received = 0

      file = fs.createWriteStream(tempPath)
      res.on('data', chunk => {
        received += chunk.length
        if (onProgress) onProgress(received, total)
      })
      res.pipe(file)
      file.on('finish', () => file.close(finish))
      file.on('error', fail)
      res.on('error',  fail)
      res.on('aborted', () => fail(new Error('Download interrupted')))
    })
    req.on('error', fail)
    req.setTimeout(60_000, () => { req.destroy(); fail(new Error('Download timed out')) })
  })
}

/**
 * Extract the zip at zipPath into destDir, preserving the internal path structure.
 * Calls onProgress(entryName, index, total) for each file entry.
 * Returns the number of files extracted. Files are written with the async API and the loop
 * yields between entries, so the window keeps painting (a synchronous loop over the 170 MB
 * client zip left Windows showing "Not Responding" for the whole extraction).
 */
async function sameContent(file, data) {
  try {
    const st = await fs.promises.stat(file)
    if (st.size !== data.length) return false
    return (await fs.promises.readFile(file)).equals(data)
  } catch { return false }
}

async function writeRetry(file, data) {
  for (let i = 0; ; i++) {
    try { return await fs.promises.writeFile(file, data) } catch (err) {
      // Defender and a running game briefly lock files; a lock that outlasts ~5 s is reported with the file named
      if (i >= 9 || !['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) throw err
      await new Promise(r => setTimeout(r, 500))
    }
  }
}

async function extractClientZip(zipPath, destDir, onProgress) {
  const zip     = new AdmZip(zipPath)
  const entries = zip.getEntries().filter(e => !e.isDirectory)
  const total   = entries.length
  // The client package's own root DLLs (the preloader and any others): the game copy's check must not take them
  // for another program's (rootDllAllow)
  store.set('clientRootDlls', entries.map(e => e.entryName).filter(n => !/[\\/]/.test(n) && /\.dll$/i.test(n)))

  // Zip-slip guard (defense-in-depth over adm-zip): reject any entry whose
  // resolved destination escapes destDir before writing it.
  const root = path.resolve(destDir)
  for (let i = 0; i < total; i++) {
    const entry = entries[i]
    const resolved = path.resolve(destDir, entry.entryName)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`Refusing to extract entry outside the target directory: ${entry.entryName}`)
    }
    if (onProgress) onProgress(entry.entryName, i + 1, total)
    await new Promise(r => setImmediate(r))
    await fs.promises.mkdir(path.dirname(resolved), { recursive: true })
    const data = entry.getData()
    // An unchanged file is left alone: another program holding it open (Dark and Darker's TavernComn service held
    // SkyrimPlatformCEF.exe, 2026-09-23) used to abort the whole update over a file with nothing new in it
    if (await sameContent(resolved, data)) continue
    await writeRetry(resolved, data)
  }

  return total
}

// Extra files: DragonBreak's own plugins, BSAs and assets that no Nexus page hosts, synced per file from /api/files/extra

const extraFileUrl = rel => `${config.apiUrl}/api/files/extra/${rel.split('/').map(encodeURIComponent).join('/')}`

async function fetchExtraManifest() {
  try { return await fetchJSON(`${config.apiUrl}/api/files/extra`) }
  catch (err) { if (err.statusCode === 404) return null; throw err }
}

// Entries with a sha256 whose path stays inside the game's Data folder
function extraEntries(vd, skyrimPath) {
  const data = path.resolve(skyrimPath, 'Data') + path.sep
  return (vd && Array.isArray(vd.files) ? vd.files : []).filter(f =>
    f && typeof f.path === 'string' && /^[0-9a-f]{64}$/i.test(String(f.sha256)) &&
    path.resolve(skyrimPath, ...f.path.split('/')).startsWith(data))
}

// Cheap check for the Play button: same manifest version and every file present at its published size
function extrasUpToDate(vd, skyrimPath) {
  if (!vd) return true
  if (vd.version !== store.get('extraFilesVersion')) return false
  return extraEntries(vd, skyrimPath).every(f => {
    try { return fs.statSync(mo2.lp(path.join(skyrimPath, ...f.path.split('/')))).size === f.size } catch { return false }
  })
}

async function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to) } catch (err) {
      // Defender and a running game briefly lock freshly written files
      if (i >= 9 || !['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) throw err
      await new Promise(r => setTimeout(r, 500))
    }
  }
}

async function syncExtraFiles(skyrimPath, force = false) {
  let vd
  try { vd = await fetchExtraManifest() } catch (err) { return { success: false, error: `Could not read the DragonBreak file list: ${err.message}` } }
  if (!vd || (!force && extrasUpToDate(vd, skyrimPath))) { store.set('extraFilesInstalled', extraEntries(vd, skyrimPath).map(f => f.path)); return { success: true, count: 0 } }
  const files = extraEntries(vd, skyrimPath)
  store.set('extraFilesInstalled', files.map(f => f.path))
  const progress = (file, index, total) => send('install:progress', { phase: 'download', file, index, total, skipped: false })

  // Hashes are cached by size + mtime across launches, so only new or changed files are read in full
  const cache = store.get('extraHashCache') || {}
  const stale = []
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    const full = mo2.lp(path.join(skyrimPath, ...f.path.split('/')))
    progress(`Checking DragonBreak files… ${i + 1}/${files.length}`, i + 1, files.length)
    let st = null
    try { st = fs.statSync(full) } catch { /* missing */ }
    if (!st || st.size !== f.size) { stale.push(f); continue }
    const c = cache[f.path]
    let sha = c && c.size === st.size && c.mtimeMs === st.mtimeMs ? c.sha256 : ''
    if (!sha) {
      try { sha = (await mo2.sha256FileAsync(full)).toLowerCase() } catch { stale.push(f); continue }
      cache[f.path] = { size: st.size, mtimeMs: st.mtimeMs, sha256: sha }
    }
    if (sha !== f.sha256.toLowerCase()) stale.push(f)
  }

  if (stale.length && await gameProcessRunning()) {
    store.set('extraHashCache', cache)
    return { success: false, error: 'Close Skyrim first: some DragonBreak files need updating and the game holds them open.' }
  }
  const mb = n => (n / 1048576).toFixed(1)
  const totalBytes = stale.reduce((s, f) => s + f.size, 0)
  let doneBytes = 0
  try {
    for (let i = 0; i < stale.length; i++) {
      const f = stale[i]
      const full = mo2.lp(path.join(skyrimPath, ...f.path.split('/')))
      const part = `${full}.part`
      fs.mkdirSync(path.dirname(full), { recursive: true })
      await downloadToFile(extraFileUrl(f.path), part, received =>
        progress(`Downloading ${f.path.split('/').pop()} (${i + 1}/${stale.length}) ${mb(doneBytes + received)} / ${mb(totalBytes)} MB`, doneBytes + received, totalBytes))
      const sha = (await mo2.sha256FileAsync(part)).toLowerCase()
      if (sha !== f.sha256.toLowerCase()) {
        try { fs.unlinkSync(part) } catch {}
        throw new Error(`${f.path} arrived damaged (checksum mismatch)`)
      }
      await renameRetry(part, full)
      const st = fs.statSync(full)
      cache[f.path] = { size: st.size, mtimeMs: st.mtimeMs, sha256: sha }
      doneBytes += f.size
    }
  } catch (err) {
    store.set('extraHashCache', cache)
    return { success: false, error: `Updating DragonBreak files failed: ${err.message}` }
  }
  store.set('extraHashCache', cache)
  store.set('extraFilesVersion', vd.version)
  log(`[extra] ${stale.length} of ${files.length} DragonBreak file(s) updated, version ${vd.version}`)
  return { success: true, count: stale.length }
}

// Client files install core
// Shared by the direct and MO2 installers: version check, download, extract, client settings.

async function installClientFilesCore(skyrimPath, srv, serverInfo, force = false) {
  const tempZip = path.join(os.tmpdir(), 'alduinak-client.zip')
  const clientSettingsPath = path.join(skyrimPath, 'Data', 'Platform', 'Plugins', 'skymp5-client-settings.txt')

  try {
    // 1. Check whether a download is needed
    let serverVersion = null
    try {
      const vd = await fetchJSON(`${config.apiUrl}/api/files/version`)
      serverVersion = vd.version
    } catch (err) {
      if (err.statusCode === 404) {
        return { success: false, error: 'Client files have not been packaged on the server yet. Ask the server admin to run `npm run build-client`.' }
      }
      if (force) return { success: false, error: 'Backend unreachable, client files were not reinstalled' }
      // Network error - play on cached files if they exist
      const allPresent = clientFilesPresent(skyrimPath)
      if (!allPresent) return { success: false, error: 'Backend unreachable and client files are not installed. Check your connection.' }
      log('[install] Backend unreachable - files already installed, updating settings only')
      writeClientSettings(clientSettingsPath, srv, serverInfo)
      return { success: true, upToDate: true }
    }

    const allPresent    = clientFilesPresent(skyrimPath)
    const needsDownload = force || serverVersion !== store.get('filesVersion') || !allPresent

    if (store.get('dboFilesDisabled')) { log('[install] DragonBreak files were disabled; enabling them for this launch'); store.set('dboFilesDisabled', false) }
    if (!needsDownload) {
      const extras = await syncExtraFiles(skyrimPath)
      if (!extras.success) return extras
      log('[install] Files up to date, updating settings only')
      writeClientSettings(clientSettingsPath, srv, serverInfo)
      return { success: true, upToDate: true }
    }

    // 2. Download
    const directRun = installTrack.kind() === 'client'
    if (directRun) installStep('client')
    send('install:progress', { phase: 'download', file: 'Connecting to server…', index: 0, total: 0, skipped: false })
    await downloadClientZip(tempZip, (received, total) => {
      if (directRun) installTrack.file('The client files', received, total)
      const mb  = n => (n / 1024 / 1024).toFixed(1)
      const pct = total > 0 ? ` (${Math.round(received / total * 100)}%)` : ''
      send('install:progress', {
        phase: 'download',
        file:  `Downloading update… ${mb(received)} / ${mb(total)} MB${pct}`,
        index: received, total, skipped: false,
      })
    })

    // 3. Extract directly into Skyrim directory.
    // The zip's stock skymp5-client-settings.txt would clobber hotkey rebinds; snapshot it so writeClientSettings sees the pre-extract file.
    let settingsSnapshot = null
    try { settingsSnapshot = fs.readFileSync(clientSettingsPath, 'utf8') } catch { /* first install */ }
    // An interrupted extract must show as an update on the next Play
    store.set('filesVersion', '')
    if (directRun) installStep('unpack')
    const extracted = await extractClientZip(tempZip, skyrimPath, (file, i, total) => {
      if (directRun) installTrack.step('unpack', { index: i, total })
      send('install:progress', { phase: 'extract', file, index: i, total, skipped: false })
    })
    if (settingsSnapshot !== null) {
      try { fs.writeFileSync(clientSettingsPath, settingsSnapshot) } catch { /* fall back to zip copy */ }
    }
    log(`[install] extracted ${extracted} files`)
    ensureClientDirs(skyrimPath)

    if (!preloaderPresent(skyrimPath)) {
      return {
        success: false,
        error: 'The client package installed, but no Engine Fixes preloader dll (d3dx9_42.dll / winhttp.dll) is next to SkyrimSE.exe. ' +
               'The server admin needs to add the preloader files to the client package and rebuild it (npm run merge).',
      }
    }

    const extras = await syncExtraFiles(skyrimPath, force)
    if (!extras.success) return extras

    // 4. Write server settings
    writeClientSettings(clientSettingsPath, srv, serverInfo)
    store.set('filesVersion', serverVersion)

    return { success: true }
  } catch (err) {
    return { success: false, error: `Install failed: ${err.message}` }
  } finally {
    try { fs.unlinkSync(tempZip) } catch {}
  }
}

// Direct install (no mod manager)

async function runDirectInstall(force = false) {
  const skyrimPath = effectiveGamePath()
  const srv        = activeServer()

  const fail = (msg) => {
    log('[install] ABORT:', msg)
    send('install:complete', { success: false, error: msg })
    endInstall()
  }

  if (!skyrimPath) return fail(noGamePathError())
  if (!srv)        return fail('No server selected - open Settings and choose a server.')

  // Vanilla integrity (repairs portable copies, warns for the real install).
  const integrity = await ensureVanillaIntegrity(skyrimPath, { signal: installAbort ? installAbort.signal : undefined })
  if (!integrity.ok) return fail(integrity.error)

  let serverInfo = null
  try { serverInfo = await fetchJSON(`${config.apiUrl}/api/serverinfo`) } catch {}

  const core = await installClientFilesCore(skyrimPath, srv, serverInfo, force)
  if (core.success) applyForcedServerDefaults(skyrimPath)
  send('install:complete', core.success
    ? { success: true, upToDate: core.upToDate, ...(integrity.warning ? { warning: integrity.warning } : {}) }
    : { success: false, error: core.error })
  endInstall()
}

// Filename pattern for a Nexus archive: downloads embed the mod id (…-17230-…); a renamed
// file still matches on the mod's name words. `version` additionally pins the release
// (Nexus encodes v2020.3 as "2020-3" in filenames).
function nexusNamePattern(modId, displayName, version) {
  const words = String(displayName).toLowerCase().match(/[a-z]{4,}/g) || []
  const nameRe = words.slice(0, 2).join('.*')
  const base = `(?:^|[^0-9])${modId}(?:[^0-9]|$)` + (nameRe ? `|${nameRe}` : '')
  if (!version) return new RegExp(base, 'i')
  const verRe = String(version).replace(/[.-]/g, '[.-]')
  return new RegExp(`^(?=.*${verRe})(?=.*(?:${base}))`, 'i')
}

// nxm:// links from "Mod Manager Download" on Nexus: the site puts a one-time key in the link, and with it a
// free account may fetch the file through the API. The archive lands in the downloads folder under the name
// the install expects, so the next PLAY picks it up. A link the launcher has no use for goes on to the manager that
// had the links before (nxm.js): any link while no install waits, a collection or another game's file, or a file
// DragonBreak's list does not name. With no such manager, a file is downloaded as named.
const nxmLog = msg => { log(`[nxm] ${msg}`); send('install:log', msg) }
const NOT_A_FILE = 'That Nexus link is not a single mod file (a Vortex collection, or another game). The launcher installs '
  + "DragonBreak's mod list itself when you press Install. To add a collection in Vortex, turn on \"Handle Mod Manager Download buttons on nexusmods.com\" in Vortex's Settings, Download tab."
function handleNxmArgv(argv) {
  for (const a of argv || []) if (typeof a === 'string' && /^nxm:\/\//i.test(a)) handleNxmLink(a)
}
let nxmQueue = Promise.resolve()
function handleNxmLink(link) {
  nxmQueue = nxmQueue.then(() => handleNxmLinkNow(link)).catch(err => nxmLog(`Nexus download failed: ${err.message}`))
}
async function handleNxmLinkNow(link) {
  const kind = nxm.classify(link)
  if (kind === 'bad') return nxmLog(`Ignored an unreadable link: ${link}`)
  if (kind === 'other' || !nxmWaiting) {
    const to = nxm.forward(link)
    if (to) return nxmLog(`Passed that Nexus link on to ${to}.`)
    if (kind === 'other') return nxmLog(NOT_A_FILE)
  }
  const u = new URL(link)
  const m = u.pathname.match(/^\/mods\/(\d+)\/files\/(\d+)/)
  const modId = Number(m[1]), fileId = Number(m[2])
  const key = u.searchParams.get('key') || '', expires = u.searchParams.get('expires') || ''
  if (!key || !expires) return nxmLog('That link has no download key; use the Mod Manager Download button on the Nexus file page.')
  let expected = null
  try {
    const manifest = await fetchJSON(`${config.apiUrl}/api/install-manifest`)
    expected = (manifest.archives || []).find(a => a.source && a.source.type === 'nexus' && Number(a.source.modId) === modId && Number(a.source.fileId) === fileId) || null
  } catch { /* the name comes from Nexus instead */ }
  if (!expected) {
    const to = nxm.forward(link)
    if (to) return nxmLog(`That file is not on DragonBreak's list: passed it on to ${to}.`)
  }
  const auth = await getNexusAuth()
  if (!auth) return nxmLog('Sign in to Nexus with the button in the top bar, then click Mod Manager Download again.')
  const downloadsDir = mo2.getDownloadsDir()
  let fileName = expected ? expected.name : ''
  if (!fileName) { try { const info = await nexus.fileInfo(auth, modId, fileId); fileName = info.file_name || `${modId}-${fileId}.zip` } catch { fileName = `${modId}-${fileId}.zip` } }
  const mb = n => (n / 1048576).toFixed(1)
  const name = await nexus.downloadWithKey(auth, modId, fileId, key, expires, fileName, downloadsDir, (r, t) => {
    installTrack.file(fileName, r, t, expected ? expected.id : undefined)
    send('install:progress', { phase: 'download', file: `Downloading ${fileName} ${mb(r)}${t ? ' / ' + mb(t) : ''} MB`, index: 0, total: 0, skipped: false })
  })
  if (expected && expected.hash && !(await mo2.verifyArchiveAsync(path.join(downloadsDir, name), expected.hash))) {
    try { fs.unlinkSync(path.join(downloadsDir, name)) } catch {}
    return nxmLog(`${fileName}: the download does not match the version the server expects; open the file page from the download list and pick the listed version.`)
  }
  nxmLog(`Downloaded ${fileName}${expected ? ' (verified)' : ''}. Press PLAY when the list is done.`)
}

// Open the MO2 downloads folder (archive staging) + the backend page listing the
// file-pinned Nexus links, once per install run. `missing` narrows the page to
// the archives this install still needs, so nothing already downloaded is listed.
let _downloadListOpened = false
// Restored for 2.1.33: ad3808ad replaced this definition with vortexDownloadsDir() but left its caller in the install,
// so a player not signed in to Nexus hit "openDownloadList is not defined" (post-hoc review A8-1, 2026-09-28)
function openDownloadList(downloadsDir, missing) {
  if (_downloadListOpened) return
  _downloadListOpened = true
  try { fs.mkdirSync(downloadsDir, { recursive: true }); shell.openPath(downloadsDir) } catch {}
  const need = (missing || [])
    .filter(a => a.source && a.source.modId)
    .map(a => `${a.source.modId}-${a.source.fileId || 'any'}`)
    .join(',')
  const query = need ? `?need=${encodeURIComponent(need)}` : ''
  shell.openExternal(`${config.apiUrl}/api/nexus-downloads${query}`)
}

// Vortex's Skyrim SE download folder at its default place ({USERDATA}\downloads\<game id>, Vortex's
// getDownloadPath), or '' when there is none; a moved one is set by the player (archiveDir)
function vortexDownloadsDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const dir = path.join(appData, 'Vortex', 'downloads', 'skyrimse')
  return fs.existsSync(dir) ? dir : ''
}
const otherArchiveDirs = () => [store.get('archiveDir'), vortexDownloadsDir()].filter(d => d && fs.existsSync(d))

// One Nexus page at a time for the files still missing (nxm.js)
const nexusGuide = items => nxmLinks.createGuide(items, { open: url => shell.openExternal(url), say: msg => send('install:log', msg) })

// MO2 install
// Full modpack pipeline: MO2 itself → SkyMP client files → manifest replay.
// Mods are reproduced from the backend's compiled install manifest (download +
// verify each archive, extract once, apply per-file directives) so every player
// gets the reference install's exact, byte-identical layout.

// Download SKSE (edition-aware) and install it into the game root. Shared by
// the manifest root step and the empty-manifest path: without SKSE nothing
// can launch, no matter how few mods the server ships.
async function installSkseIntoRoot(skyrimPath) {
  const mb = n => (n / 1024 / 1024).toFixed(1)
  const skse = mo2.skseSourceFor(skyrimPath)
  send('install:progress', { phase: 'mods', file: `Downloading SKSE (${skse.edition})…`, index: 0, total: 0, skipped: false })
  const name = await mo2.downloadToDownloads(skse.url, skse.fileName, (r, t) => {
    const pct = t > 0 ? ` (${Math.round(r / t * 100)}%)` : ''
    send('install:progress', { phase: 'mods', file: `Downloading SKSE (${skse.edition})… ${mb(r)} MB${pct}`, index: 0, total: 0, skipped: false })
  })
  send('install:progress', { phase: 'mods', file: 'Installing SKSE…', index: 0, total: 0, skipped: false })
  await mo2.installSkse(path.join(mo2.getDownloadsDir(), name), skyrimPath)
}

// opts.force rebuilds every mod and the SKSE root step from scratch (Repair Modlist).
async function runMO2Install(opts = {}) {
  const modlistOnly = opts.modlistOnly === true
  const force       = opts.force === true
  _downloadListOpened = false
  const fail = (msg) => {
    log('[mo2-install] ABORT:', msg)
    // The modpack is not in a known-good state: the launch gate blocks PLAY
    // and the update check flips the button to UPDATE until a run succeeds.
    store.set('modpackState', 'failed')
    send('install:complete', { success: false, error: msg })
    endInstall()
  }

  const skyrimPath = effectiveGamePath()
  if (!skyrimPath) return fail(noGamePathError())

  const srv = activeServer()
  if (!srv) return fail('No server selected - open Settings and choose a server.')

  if (!findOriginalPrefsIni()) return fail(NEVER_LAUNCHED_ERROR)

  try {
    // 0. Vanilla integrity: verify the game copy (existence + size) against
    // the original install and repair portable copies file by file. Playing
    // from the real install only produces a warning.
    const integrity = await ensureVanillaIntegrity(skyrimPath, { signal: installAbort ? installAbort.signal : undefined })
    if (!integrity.ok) return fail(integrity.error)
    if (integrity.repaired) log(`[mo2-install] repaired ${integrity.repaired} vanilla file(s)`)
    const vanillaWarning = integrity.warning || null

    // 1. MO2 itself, the portable instance, and the nxm:// handler
    await mo2.ensureInstalled(msg =>
      send('install:progress', { phase: 'download', file: msg, index: 0, total: 0, skipped: false }))

    let serverInfo = null
    try { serverInfo = await fetchJSON(`${config.apiUrl}/api/serverinfo`) } catch {}
    mo2.ensureInstance(skyrimPath, serverInfo?.loadOrder)
    mo2.writeNxmHandlerIni()
    seedProfilePrefs(store.get('skyrimPath') || skyrimPath)
    applyForcedServerDefaults(skyrimPath)

    // 2. SkyMP client files into the real Data/ (skipped by Repair Modlist)
    let coreUpToDate = false
    if (!modlistOnly) {
      const core = await installClientFilesCore(skyrimPath, srv, serverInfo)
      if (!core.success) return fail(core.error)
      coreUpToDate = !!core.upToDate
    }

    // 3. Mods from the compiled install manifest
    let manifest
    try { manifest = await fetchJSON(`${config.apiUrl}/api/install-manifest`) }
    catch (err) {
      // A 404 means the backend never compiled (or lost, after a fresh
      // deploy) its manifest - surface the backend's own explanation.
      if (err.statusCode === 404) {
        return fail(err.serverError ||
          'The server has not published a mod manifest yet - ask the server admin to run `npm run compile-manifest` on the backend.')
      }
      return fail(`Could not fetch the install manifest: ${err.message}`)
    }
    if (!manifest || !Array.isArray(manifest.mods) || !Array.isArray(manifest.archives)) {
      return fail('Install manifest is missing or malformed - run "npm run compile-manifest" on the backend.')
    }

    const finishOrder = () => {
      const order = (Array.isArray(manifest.order) && manifest.order.length)
        ? manifest.order.slice()
        : manifest.mods.map(m => m.name)
      if (fs.existsSync(path.join(mo2.getModsDir(), 'SKSE')) && !order.includes('SKSE')) order.push('SKSE')
      mo2.setModlistOrder(order)        // also prunes managed mods dropped from the manifest
      mo2.setPlugins(manifest.plugins)
      store.set('installedRootHash', manifest.rootHash || '')
    }

    if (manifest.mods.length === 0) {
      // No mods yet, but the game root still needs SKSE or nothing can launch,
      // and the run must reach 'ready' or the button stays stuck on UPDATE.
      if (!fs.existsSync(path.join(skyrimPath, 'skse64_loader.exe'))) {
        try { await installSkseIntoRoot(skyrimPath) }
        catch (err) { return fail(`SKSE install failed: ${err.message}`) }
      }
      finishOrder()
      store.set('modpackState', 'ready')
      send('install:complete', {
        success: true, mo2: true, upToDate: coreUpToDate, modsTotal: 0,
        warning: [vanillaWarning, 'The install manifest has no mods yet - compile it from the reference MO2 install on the backend.']
          .filter(Boolean).join(' | '),
      })
      return
    }

    // 3a. Acquire every referenced archive, verified by sha256
    const downloadsDir = mo2.getDownloadsDir()
    const nexusAuth = await getNexusAuth()   // OAuth bearer or SSO API key
    const premium   = !!(nexusAuth && store.get('nexusUser')?.isPremium)
    const mb = n => (n / 1024 / 1024).toFixed(1)
    const sanitize       = n => String(n).replace(/[<>:"/\\|?*]/g, '')
    const modFolderPath  = m => path.join(mo2.getModsDir(), sanitize(m.name))
    if (force) {
      send('install:progress', { phase: 'mods', file: 'Clearing the build and extraction caches…', index: 0, total: 0, skipped: false })
      mo2.clearBuildCache()
      mo2.clearCache()
    }
    let skippedConfigs = 0
    const modChanged = m => {
      if (force) return true
      if (!fs.existsSync(modFolderPath(m))) return true
      if (!m.hash) return true                     // pre-hash manifest: be safe, reinstall
      if (mo2.readModHash(m.name) !== m.hash) return true
      // Cheap integrity gate: the summed directive sizes vs the folder's
      // actual bytes. The install-time hash stamp alone cannot see files an
      // AV quarantined or a player deleted; a mismatch rebuilds the mod.
      const files = Array.isArray(m.files) ? m.files : []
      if (!files.length || !files.every(f => Number.isFinite(f.size))) return false
      // Config files a plugin or MCM rewrites itself are not compared (mo2.isRewrittenConfig)
      const { expected, actual, skipped } = mo2.modSizeCheck(m)
      skippedConfigs += skipped
      if (actual === -1) {
        // Unreadable mid-scan (AV holding a handle): do not wipe a mod over a
        // transient lock, only over a real size mismatch.
        log(`[mo2-install] ${m.name}: folder unreadable during verify - skipping size check`)
        return false
      }
      if (actual !== expected) {
        log(`[mo2-install] ${m.name}: folder is ${actual} bytes, manifest expects ${expected} - repairing`)
        return true
      }
      return false
    }
    const rootSetUp      = fs.existsSync(path.join(skyrimPath, 'skse64_loader.exe'))
    const rootChanged    = (store.get('installedRootHash') || '') !== (manifest.rootHash || '')
    const needsRoot      = force || !rootSetUp || rootChanged
    log(`[mo2-install] root check: skse=${rootSetUp} hashChanged=${rootChanged} force=${force} -> needsRoot=${needsRoot}`)
    const modsToInstall  = []
    for (let i = 0; i < manifest.mods.length; i++) {
      if (modChanged(manifest.mods[i])) modsToInstall.push(manifest.mods[i])
      if ((i + 1) % 10 === 0 || i + 1 === manifest.mods.length) {
        send('install:progress', { phase: 'verify', index: i + 1, total: manifest.mods.length })
        installStep('verify', { index: i + 1, total: manifest.mods.length })
      }
      // Yield between folder walks so the UI stays responsive on slow disks
      await new Promise(r => setImmediate(r))
    }
    if (skippedConfigs) log(`[mo2-install] ${skippedConfigs} config file(s) that plugins or MCM rewrite were left out of the size check`)

    if (modsToInstall.length === 0 && !needsRoot) {
      finishOrder()
      store.set('modpackState', 'ready')
      send('install:complete', {
        success: true, mo2: true, upToDate: true, modsTotal: manifest.mods.length,
        ...(vanillaWarning ? { warning: vanillaWarning } : {}),
      })
      return
    }

    const archivePaths = {}      // archiveId -> verified local path
    const needBrowser  = []      // nexus archives we couldn't auto-download

    // Acquire only the archives the to-install mods (and root files) reference.
    const neededArchiveIds = new Set()
    for (const m of modsToInstall) for (const f of m.files) if (f.archive) neededArchiveIds.add(f.archive)
    if (needsRoot) for (const f of (manifest.root || [])) if (f.archive) neededArchiveIds.add(f.archive)
    const needed   = manifest.archives.filter(x => neededArchiveIds.has(x.id))
    const modBytes = m => Math.max(1, (m.files || []).reduce((n, f) => n + (Number(f.size) || 0), 0))
    installTrack.plan({ archives: needed.map(a => ({ id: a.id, size: a.size })), installBytes: modsToInstall.reduce((n, m) => n + modBytes(m), 0) })
    installStep('download', { index: 0, total: needed.length })
    const gotArchive = (a, k) => {
      installTrack.acquired(a.id)
      installTrack.step('download', { index: k + 1, total: needed.length })
      sendInstallState()
    }

    const locate = async (a) => {
      const names = []
      if (a.source.type === 'nexus') { const n = mo2.findDownloadByFileId(a.source.fileId); if (n) names.push(n) }
      names.push(a.name)
      for (const name of names) {
        const p = path.join(downloadsDir, name)
        if (!fs.existsSync(p)) continue
        // Hashed in the background, with a line per archive: a multi-GB archive used to freeze the window here
        send('install:progress', { phase: 'mods', file: `Checking ${name}…`, index: 0, total: 0, skipped: false })
        if (await mo2.verifyArchiveAsync(p, a.hash)) return p
      }
      // A manually moved / renamed file, or one Vortex already downloaded (the collection), linked in without a copy
      const found = await mo2.findArchiveByHash(a.hash, a.size, otherArchiveDirs())
      if (!found || path.dirname(found) === downloadsDir) return found
      reused++
      return mo2.adoptArchive(found)
    }
    let reused = 0

    for (const [k, a] of needed.entries()) {
      const existing = await locate(a)
      if (existing) { archivePaths[a.id] = existing; gotArchive(a, k); continue }

      if (a.source.type === 'url') {
        send('install:progress', { phase: 'mods', file: `Downloading ${a.name}…`, index: 0, total: 0, skipped: false })
        const name = await mo2.downloadToDownloads(a.source.url, a.name, (r, t) => {
          const pct = t > 0 ? ` (${Math.round(r / t * 100)}%)` : ''
          installTrack.file(a.name, r, t, a.id)
          send('install:progress', { phase: 'mods', file: `Downloading ${a.name}… ${mb(r)} MB${pct}`, index: 0, total: 0, skipped: false })
        })
        const p = path.join(downloadsDir, name)
        if (!(await mo2.verifyArchiveAsync(p, a.hash))) return fail(`${a.name}: downloaded file failed verification (hash mismatch).`)
        archivePaths[a.id] = p
        gotArchive(a, k)
      } else if (a.source.type === 'nexus' && premium) {
        send('install:progress', { phase: 'mods', file: `Downloading ${a.name}…`, index: 0, total: 0, skipped: false })
        let name = null
        try {
          name = await nexus.downloadFileEntry(nexusAuth, a.source.modId, { fileId: a.source.fileId, fileName: a.name }, downloadsDir, (r, t) => {
            const pct = t > 0 ? ` (${Math.round(r / t * 100)}%)` : ''
            installTrack.file(a.name, r, t, a.id)
            send('install:progress', { phase: 'mods', file: `Downloading ${a.name}… ${mb(r)} / ${mb(t)} MB${pct}`, index: 0, total: 0, skipped: false })
          })
        } catch (err) {
          // A dead pin (HTTP 404 = the file was removed or archived on Nexus)
          // must not abort the whole install: fall back to the manual browser
          // flow, which also accepts an already-downloaded copy by sha256.
          log(`[install] auto-download failed for ${a.name} (mod ${a.source.modId}, file ${a.source.fileId}): ${err.message} - falling back to manual download`)
          send('install:progress', { phase: 'mods', file: `${a.name}: auto-download failed (${err.message}) - queued for manual download`, index: 0, total: 0, skipped: false })
          needBrowser.push(a)
          continue
        }
        const p = path.join(downloadsDir, name)
        if (!(await mo2.verifyArchiveAsync(p, a.hash))) return fail(`${a.name}: downloaded file failed verification (hash mismatch - the version pin may have changed).`)
        archivePaths[a.id] = p
        gotArchive(a, k)
      } else if (a.source.type === 'nexus') {
        needBrowser.push(a)
      } else {
        return fail(`${a.name}: no download source. Add a URL in data/manifest-sources.json on the backend.`)
      }
    }

    if (reused) send('install:log', `Used ${reused} mod archive(s) you already had (${store.get('archiveDir') ? `in ${store.get('archiveDir')} or Vortex's downloads` : "Vortex's downloads"}), without copying them or downloading them again.`)

    // 3b. Free / no-key path: open the downloads list page + MO2 staging folder
    if (needBrowser.length > 0) {
      // "Mod Manager Download" comes to the launcher only while it waits here; after, the links go back
      nxm.claim(nxmHandlerExe())
      nxmWaiting = true
      try {
        // Signed in to Nexus: one page at a time, and its Slow download reaches the launcher, nothing to move.
        // Not signed in: the whole list, downloaded by hand into the downloads folder.
        const guide = nexusAuth ? nexusGuide(needBrowser) : null
        if (!guide) openDownloadList(downloadsDir, needBrowser)
        installStep('wait', { index: 0, total: needBrowser.length })
        // The page the guide just opened: the panel asks the player for that one file
        const openPage = found => {
          const i = guide(found)
          if (i === null || i === undefined) return
          installTrack.waiting({ page: found.filter(Boolean).length + 1, pages: needBrowser.length, name: needBrowser[i].name })
          sendInstallState(true)
        }
        send('install:progress', {
          phase: 'mods',
          file:  guide
            ? `${needBrowser.length} mod(s) to download from Nexus, one page at a time: click "Slow download" on each page the launcher opens; it downloads the file and opens the next. Mods you already have in Vortex's downloads are used as they are.`
            : 'Opened the downloads list: open each link, click "Slow Download" (about 5 at a time), and move every archive into the DragonBreak downloads folder. Sign in to Nexus in the top bar first and each mod becomes one click with nothing to move.',
          index: 0, total: needBrowser.length, skipped: false,
        })
        if (guide) openPage(needBrowser.map(() => false))
        // Matched by sha256, so paths come back verified regardless of filename; the
        // namePattern only flags likely wrong-version files in the status message.
        const paths = await mo2.waitForDownloads(
          needBrowser.map(a => ({ name: a.name, hash: a.hash, size: a.size, namePattern: nexusNamePattern(a.source.modId, a.name) })),
          (done, total, message, found) => {
            (found || []).forEach((f, j) => { if (f) installTrack.acquired(needBrowser[j].id) })
            installTrack.step('wait', { index: done, total })
            if (guide && found) openPage(found)
            if (done >= total) installTrack.waiting(null)
            const { waiting: w, file: f } = installTrack.snapshot()
            const line = f && f.total > 0 && f.done < f.total ? `Downloading ${f.name}…`
              : guide && w && done < total ? `Waiting for you: click "Slow download" on the Nexus page that just opened (page ${w.page} of ${w.pages}): ${w.name}`
                : message
            send('install:progress', { phase: 'mods', file: line, index: done, total, skipped: false })
          },
          installAbort?.signal)
        needBrowser.forEach((a, i) => { archivePaths[a.id] = paths[i] })
      } finally {
        nxmWaiting = false
        nxm.release()
      }
    }

    // 3c. Replay the manifest: extract each archive once, apply directives
    // Reference-count archives across mods + root so each extraction is freed
    // as soon as its last consumer is done (bounds temp disk use).
    const refCount = new Map()
    const bump = ids => { for (const id of ids) refCount.set(id, (refCount.get(id) || 0) + 1) }
    for (const m of modsToInstall) bump(new Set(m.files.filter(f => f.archive).map(f => f.archive)))
    if (needsRoot) bump(new Set((manifest.root || []).filter(f => f.archive).map(f => f.archive)))

    mo2.clearCache()
    const extractedDirs = {}
    // Extraction runs in the background, with a line per archive, so the window stays alive through a Repair Modlist
    const ensureExtracted = async (ids, index = 0, total = 0) => {
      for (const id of ids) {
        if (extractedDirs[id]) continue
        if (!archivePaths[id]) throw new Error(`archive ${id} was never downloaded`)
        send('install:progress', { phase: 'mods', file: `Extracting ${path.basename(archivePaths[id])}…`, index, total, skipped: false })
        extractedDirs[id] = await mo2.extractToCache(archivePaths[id], id)
      }
    }
    const release = ids => {
      for (const id of ids) {
        const left = (refCount.get(id) || 0) - 1
        refCount.set(id, left)
        if (left <= 0 && extractedDirs[id]) { mo2.clearCache(id); delete extractedDirs[id] }
      }
    }

    const failed = []
    for (let i = 0; i < modsToInstall.length; i++) {
      const mod = modsToInstall[i]
      const ids = [...new Set(mod.files.filter(f => f.archive).map(f => f.archive))]
      installStep('install', { index: i, total: modsToInstall.length })
      send('install:progress', { phase: 'mods', file: `Installing ${mod.name}…`, index: i, total: modsToInstall.length, skipped: false })
      try {
        await ensureExtracted(ids, i, modsToInstall.length)
        const r = await mo2.applyMod(mod.name, mod.files, extractedDirs, mod.modId, mod.hash)
        if (r.error) failed.push(`${mod.name} (${r.error})`)
      } catch (err) {
        failed.push(`${mod.name} (${err.message})`)
      }
      release(ids)
      installTrack.installed(modBytes(mod))
      installTrack.step('install', { index: i + 1, total: modsToInstall.length })
      sendInstallState()
    }

    installStep('finish')
    if (needsRoot && manifest.root && manifest.root.length > 0) {
      const ids = [...new Set(manifest.root.filter(f => f.archive).map(f => f.archive))]
      try {
        await ensureExtracted(ids)
        await mo2.applyRootFiles(manifest.root, extractedDirs, skyrimPath)
      } catch (err) {
        failed.push(`root files (${err.message})`)
      }
      release(ids)
    }

    mo2.clearCache()

    if (failed.length > 0) return fail(`${failed.length} item(s) failed to install: ${failed.join('; ')}`)

    // 4. Game-root components (only on a version change / fresh game copy)
    if (needsRoot) {
      // SKSE - the build matching the player's game edition (Steam vs GOG).
      try { await installSkseIntoRoot(skyrimPath) }
      catch (err) { return fail(`SKSE install failed: ${err.message}`) }
    }

    // 5. Match MO2 priority + plugin order, record the installed version
    finishOrder()

    store.set('modpackState', 'ready')
    send('install:complete', {
      success: true, mo2: true, upToDate: coreUpToDate, modsTotal: manifest.mods.length,
      ...(vanillaWarning ? { warning: vanillaWarning } : {}),
    })
  } catch (err) {
    if (err.message === 'Cancelled') { fail('Install cancelled.'); return }
    fail(`Install failed: ${err.message}`)
    return
  } finally {
    endInstall()
  }
}

// Helpers

/**
 * Write the SkyMP client settings file (skymp5-client-settings.txt).
 *
 * Format per SkyMP docs:
 *
 *   Offline mode (server offlineMode: true):
 *     { "server-ip": "...", "server-port": N,
 *       "master": "", "server-master-key": null,
 *       "gameData": { "profileId": <integer> } }
 *
 *   Online mode (server offlineMode: false):
 *     { "server-ip": "...", "server-port": N,
 *       "master": "<masterUrl>", "server-master-key": "<masterKey>" }
 *     Also writes PluginsNoLoad/auth-data-no-load.js so the SkyMP in-game client
 *     finds pre-existing credentials and skips its own Discord OAuth dialog.
 *
 * @param {string} destPath   Absolute path to skymp5-client-settings.txt
 * @param {object} srv        Active server entry { address, port }
 * @param {object} serverInfo Cached serverinfo { offlineMode, masterKey, masterUrl }
 */
// Moves bindings still on the pre-2.1.19 defaults (faction G, cursor F6, housing H, hide UI F1) to the current ones
function migrateHotkeyDefaults(prev) {
  if (prev.dboHotkeyDefaults >= 2) return
  const old = { factionMenuKeyCode: [34, 61], freeCursorKeyCode: [64, 66], housingMenuKeyCode: [35, 45], hideUiKeyCode: [59, 60] }
  for (const [k, [from, to]] of Object.entries(old)) if (prev[k] === from) prev[k] = to
  prev.dboHotkeyDefaults = 2
}

function writeClientSettings(destPath, srv, serverInfo) {
  // Start fresh every time - do not preserve stale keys from previous writes.
  // Exception: user hotkey bindings, owned by the settings UI; a launch must never reset them to defaults.
  const HOTKEY_KEYS = [
    'chatFocusKeyCodes', 'freeCursorKeyCode', 'housingMenuKeyCode',
    'factionMenuKeyCode', 'personalMenuKeyCode',
    'voicePushToTalkKeyCode', 'adminMenuKeyCode', 'hideUiKeyCode', 'masteryMenuKeyCode', 'emoteWheelKeyCode', 'nametagKeyCode', 'dboHotkeyDefaults',
    'playerActionKeyCode', 'voiceModeKeyCode', 'maskToggleKeyCode', 'voice', 'uiScale', 'panelScaleReset',
  ]
  let prev = {}
  try { prev = JSON.parse(fs.readFileSync(destPath, 'utf8')) || {} } catch { /* first run */ }
  migrateHotkeyDefaults(prev)
  const settings = {}
  for (const k of HOTKEY_KEYS) if (prev[k] !== undefined) settings[k] = prev[k]

  settings['server-ip']   = srv.address
  settings['server-port'] = Number(srv.port)

  // Default to false (online mode) when serverInfo is unavailable - safer
  // than defaulting to offline, which would write a wrong profileId-based gameData.
  const offlineMode = serverInfo?.offlineMode ?? false

  settings['master']            = serverInfo?.masterUrl || ''
  settings['server-master-key'] = serverInfo?.masterKey || null

  if (offlineMode) {
    // Offline mode is not authentication: the client simply states which profile it is, so there is
    // nothing for a Discord login to prove and an offline server may have no Discord app configured
    // at all. Mint an id once and keep it, so the character behind it survives relaunches.
    // Never 1: that is the conventional admin id in adminProfileIds, and handing it out would make
    // every offline player share one character and one set of admin rights.
    let profileId = store.get('gameProfileId')
    if (profileId == null) {
      profileId = Math.floor(Math.random() * 2000000000) + 2
      store.set('gameProfileId', profileId)
      log('[writeClientSettings] offline server, no Discord login: minted profileId', profileId)
    }
    settings['gameData'] = { profileId }
  } else {
    // Write auth-data-no-load.js so the SkyMP in-game client finds pre-existing
    // credentials and skips its own Discord OAuth dialog.
    // The SkyMP client reads: {skyrimPath}/Data/Platform/PluginsNoLoad/auth-data-no-load.js
    // Format: //<RemoteAuthGameData JSON>
    // Shape:  { session, masterApiId, discordUsername, discordDiscriminator, discordAvatar }
    const session     = store.get('gameSession')
    const discordUser = store.get('discordUser')
    const profileId   = store.get('gameProfileId')
    if (session && discordUser && profileId != null) {
      const authDataPath = path.join(path.dirname(destPath), '..', 'PluginsNoLoad', 'auth-data-no-load.js')
      const authData = {
        session,
        masterApiId:          profileId,
        discordUsername:      discordUser.username || discordUser.tag || null,
        discordDiscriminator: null,
        discordAvatar:        discordUser.avatar   || null,
      }
      try {
        fs.mkdirSync(path.dirname(authDataPath), { recursive: true })
        fs.writeFileSync(authDataPath, '//' + JSON.stringify(authData))
        log('[writeClientSettings] auth-data-no-load.js written for', discordUser.username || profileId)
      } catch (err) {
        log('[writeClientSettings] Failed to write auth-data-no-load.js:', err.message)
      }
    }
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  fs.writeFileSync(destPath, JSON.stringify(settings, null, 2) + '\n')
}

function fetchJSON(url, headers = {}, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const mod    = url.startsWith('https') ? https : http
    const urlObj = new URL(url)
    const opts   = {
      hostname: urlObj.hostname,
      port:     urlObj.port || (url.startsWith('https') ? 443 : 80),
      path:     urlObj.pathname + urlObj.search,
      method:   'GET',
      headers,
    }
    const req = mod.request(opts, res => {
      // Follow same-host redirects (e.g. the reverse proxy upgrading http to
      // https). Cross-host hops and https->http downgrades stay errors so the
      // session header can never leak to another origin.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        let next = null
        try { next = new URL(res.headers.location, url) } catch { /* malformed location */ }
        const sameHost  = next && next.hostname === urlObj.hostname
        const downgrade = next && urlObj.protocol === 'https:' && next.protocol !== 'https:'
        if (next && sameHost && !downgrade && redirectsLeft > 0) {
          return resolve(fetchJSON(next.href, headers, redirectsLeft - 1))
        }
        const e = new Error(`HTTP ${res.statusCode} from ${url} (redirect to ${res.headers.location})`)
        e.statusCode = res.statusCode
        reject(e)
        return
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        // Read a little of the body: backend errors carry an explanatory
        // { error } that is far more useful than the bare status code.
        let body = ''
        res.on('data', c => { if (body.length < 4096) body += c })
        res.on('end', () => {
          let detail = ''
          try { detail = JSON.parse(body).error || '' } catch { /* not JSON */ }
          const e = new Error(`HTTP ${res.statusCode} from ${url}${detail ? `: ${detail}` : ''}`)
          e.statusCode   = res.statusCode
          e.serverError  = detail || undefined
          reject(e)
        })
        res.on('error', () => {
          const e = new Error(`HTTP ${res.statusCode} from ${url}`)
          e.statusCode = res.statusCode
          reject(e)
        })
        return
      }
      // Accumulate Buffers, not a growing string: the install manifest can be
      // hundreds of MB and string += chunk degrades quadratically there.
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch (e) { reject(new Error(`Invalid JSON from ${url}: ${e.message}`)) }
      })
    })
    req.on('error', reject)
    req.setTimeout(10_000, () => {
      req.destroy()
      reject(new Error(`Request timed out: ${url}`))
    })
    req.end()
  })
}

// POST JSON and parse the JSON reply. No redirect following: launch-check and
// friends are same-origin API calls where a redirect means misconfiguration.
function postJSON(url, body, headers = {}, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const mod    = url.startsWith('https') ? https : http
    const urlObj = new URL(url)
    const payload = JSON.stringify(body || {})
    const req = mod.request({
      hostname: urlObj.hostname,
      port:     urlObj.port || (url.startsWith('https') ? 443 : 80),
      path:     urlObj.pathname + urlObj.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const e = new Error(`HTTP ${res.statusCode} from ${url}`)
          e.statusCode = res.statusCode
          return reject(e)
        }
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(new Error(`Invalid JSON from ${url}: ${e.message}`)) }
      })
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Request timed out: ${url}`)) })
    req.write(payload)
    req.end()
  })
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}
