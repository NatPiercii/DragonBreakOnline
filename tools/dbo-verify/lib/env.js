'use strict'
// Shared environment facts for the dbo-verify harness. Every fact here exists because getting it
// wrong once produced a false test result on a real run; see tools/dbo-verify/README.md.
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const HOME = process.env.USERPROFILE || process.env.HOME || ''
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local')
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming')

const PATHS = {
  gameCopy: 'C:\\DragonBreak\\skyrim',
  mo2Root: 'C:\\DragonBreak',
  profile: 'C:\\DragonBreak\\profiles\\DragonBreak',
  quarantine: 'C:\\DragonBreak\\skyrim\\DragonBreak Quarantine',
  uiDir: 'C:\\DragonBreak\\skyrim\\Data\\Platform\\UI',
  pluginsDir: 'C:\\DragonBreak\\skyrim\\Data\\Platform\\Plugins',
  steamGame: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Skyrim Special Edition',
  depots: 'C:\\Program Files (x86)\\Steam\\steamapps\\content\\app_489830',
  launcherExe: path.join(LOCALAPPDATA, 'Programs', 'DragonBreak Online Launcher', 'DragonBreak Launcher', 'DragonBreak Launcher.exe'),
  launcherData: path.join(APPDATA, 'DragonBreak Online Launcher'),
  installLog: path.join(APPDATA, 'DragonBreak Online Launcher', 'install.log'),
}

// Redact the Windows user and machine name from anything that leaves this PC.
function redact(s) {
  if (s == null) return s
  let out = String(s)
  for (const [v, tag] of [[process.env.USERNAME, '<user>'], [process.env.COMPUTERNAME, '<pc>']]) {
    if (v) out = out.split(v).join(tag)
  }
  return out
}

function ps(script) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 60000, windowsHide: true }).trim()
  } catch (e) {
    return ''
  }
}

function fileFacts(p) {
  try {
    const st = fs.statSync(p)
    return { exists: true, size: st.size, mtime: st.mtime.toISOString() }
  } catch { return { exists: false } }
}

// Processes matching the game/launcher/mod-manager set, with parents, as {name, pid, ppid}.
function processes() {
  const raw = ps("Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'ModOrganizer|usvfs|skse|SkyrimSE|SkyrimPlatformCEF|DragonBreak|Vortex' } | ForEach-Object { \"$($_.Name)|$($_.ProcessId)|$($_.ParentProcessId)\" }")
  if (!raw) return []
  return raw.split(/\r?\n/).filter(Boolean).map(l => {
    const [name, pid, ppid] = l.split('|')
    return { name, pid: Number(pid), ppid: Number(ppid) }
  })
}

// CONSTRAINT 1 - sandbox inheritance. A launcher started from an agent shell passes that shell's
// sandbox to MO2, which then cannot spawn skse64_loader.exe (ERROR_ACCESS_DENIED, which MO2
// misreports as an antivirus block). Any run whose launcher descends from a shell is INVALID.
const SHELL_ANCESTORS = /powershell|pwsh|cmd\.exe|bash\.exe|conhost/i
function launcherAncestry() {
  const raw = ps(`
$all = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'DragonBreak Launcher.exe' })
if (-not $all.Count) { 'NONE'; exit }
$ids = $all | ForEach-Object { $_.ProcessId }
$root = $all | Where-Object { $_.ParentProcessId -notin $ids } | Select-Object -First 1
if (-not $root) { $root = $all[0] }
$chain = @(); $cur = $root
for ($i = 0; $i -lt 8 -and $cur; $i++) {
  $chain += "$($cur.Name)($($cur.ProcessId))"
  $cur = Get-CimInstance Win32_Process -Filter "ProcessId=$($cur.ParentProcessId)" -ErrorAction SilentlyContinue
}
$chain -join ' <- '`)
  if (!raw || raw === 'NONE') return { running: false, chain: null, tainted: false }
  return { running: true, chain: raw, tainted: SHELL_ANCESTORS.test(raw) }
}

// CONSTRAINT 5 - Vortex deploys into the STEAM folder by hardlink and will invalidate any baseline
// taken around it. Detect both the running process and the on-disk evidence it leaves behind.
function vortexState() {
  const running = processes().filter(p => /^Vortex/i.test(p.name))
  const marker = path.join(PATHS.steamGame, 'Data', 'vortex.deployment.json')
  const m = fileFacts(marker)
  return {
    running: running.length,
    deploymentManifest: m.exists ? { path: 'Data/vortex.deployment.json', mtime: m.mtime } : null,
    contaminated: m.exists,
  }
}

// CONSTRAINT 4 - the launcher recreates install.log every session, so a stored line offset silently
// reports "no new lines". Identify a session by its first line, never by a count.
function readInstallLog() {
  if (!fs.existsSync(PATHS.installLog)) return { exists: false, lines: [], sessionId: null }
  const lines = fs.readFileSync(PATHS.installLog, 'utf8').split(/\r?\n/)
  return { exists: true, lines, sessionId: lines[0] || null }
}

function logLinesSince(prev) {
  const now = readInstallLog()
  if (!now.exists) return []
  // A different first line means the log was recreated: the whole file is new.
  if (!prev || prev.sessionId !== now.sessionId) return now.lines.map(redact)
  return now.lines.slice(prev.lines.length).map(redact)
}

// CONSTRAINT 6 - selfRepair moves stray files out of the game copy into a timestamped Quarantine
// folder, so test artifacts are not where the test left them. Cleanup must search here.
function quarantineEntries() {
  const root = PATHS.quarantine
  if (!fs.existsSync(root)) return []
  const out = []
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out.push({ rel: p.slice(root.length + 1), size: fs.statSync(p).size })
    }
  }
  try { walk(root) } catch { /* unreadable mid-scan */ }
  return out
}

function exeVersion(p) {
  if (!fs.existsSync(p)) return null
  return ps(`(Get-Item -LiteralPath '${p.replace(/'/g, "''")}').VersionInfo.FileVersion`) || null
}

function versions() {
  return {
    launcher: exeVersion(PATHS.launcherExe),
    gameCopyExe: exeVersion(path.join(PATHS.gameCopy, 'SkyrimSE.exe')),
    steamExe: exeVersion(path.join(PATHS.steamGame, 'SkyrimSE.exe')),
  }
}

module.exports = {
  PATHS, redact, ps, fileFacts, processes,
  launcherAncestry, vortexState,
  readInstallLog, logLinesSince, quarantineEntries,
  exeVersion, versions,
}
