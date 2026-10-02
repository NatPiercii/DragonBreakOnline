'use strict'
// SkyrimPlatform's browser keeps its cache and cef_debug.log in %TEMP%\Skyrim Platform\CEFTemp<hash of the game
// folder> (MyChromiumApp.cpp) and never removes either, so the logs pile up (Jake's PC, 2 Oct 2026: four folders, a
// log of ~51 MB in one session). Every SkyMP-based server shares that root, one folder per game install, and a
// folder's cache holds that server's UI cookies and storage. So only the debug log is removed: before a launch, with
// the game not running, the cef_debug.log of a folder nobody has written to for a few days goes. The folders and their
// caches stay, ours and other servers' alike (the isolated launcher's rule: never change another server's setup). A
// log that cannot be removed is left for the next launch.

const fs   = require('fs')
const os   = require('os')
const path = require('path')

const STALE_MS = 3 * 24 * 60 * 60 * 1000

const cefTempRoot = (tmp) => path.join(tmp || os.tmpdir(), 'Skyrim Platform')

// The newest write in a folder: the folder itself and what is directly in it (the log, the cache's own folders)
function lastWrite(dir) {
  let newest = 0
  try { newest = fs.statSync(dir).mtimeMs } catch { return 0 }
  let names = []
  try { names = fs.readdirSync(dir) } catch { return newest }
  for (const name of names) {
    try { newest = Math.max(newest, fs.statSync(path.join(dir, name)).mtimeMs) } catch { /* gone meanwhile */ }
  }
  return newest
}

// CEFTemp folders under root last written before now - staleMs
function staleCefTempFolders(root, now, staleMs = STALE_MS) {
  let names = []
  try { names = fs.readdirSync(root) } catch { return [] }
  return names
    .filter(n => /^CEFTemp\d*$/.test(n))
    .map(n => path.join(root, n))
    .filter(dir => { try { return fs.statSync(dir).isDirectory() } catch { return false } })
    .filter(dir => now - lastWrite(dir) >= staleMs)
}

// The debug logs CEF writes in a folder: cef_debug.log and any rotated copies of it
const DEBUG_LOG_RE = /^cef_debug\.log(\.\d+)?$/i

// Removes the debug logs of the stale folders, nothing else; { removed, failed } as folder names, bytes freed
function cleanCefTemp({ root = cefTempRoot(), now = Date.now(), staleMs = STALE_MS, log = () => {} } = {}) {
  const removed = [], failed = []
  let bytes = 0
  for (const dir of staleCefTempFolders(root, now, staleMs)) {
    let names = []
    try { names = fs.readdirSync(dir) } catch { continue }
    let any = false
    for (const name of names.filter(n => DEBUG_LOG_RE.test(n))) {
      const file = path.join(dir, name)
      try {
        const st = fs.lstatSync(file)
        if (!st.isFile()) continue
        fs.unlinkSync(file); bytes += st.size; any = true
      } catch (e) {
        if (!failed.includes(path.basename(dir))) failed.push(path.basename(dir))
        log(`[cefTemp] could not remove ${path.basename(dir)}\\${name}: ${e.code || e.message}`)
      }
    }
    if (any) removed.push(path.basename(dir))
  }
  if (removed.length) log(`[cefTemp] removed the stale browser debug log in ${removed.length} folder(s) (${Math.round(bytes / 1048576)} MB): ${removed.join(', ')}`)
  return { removed, failed, bytes }
}

module.exports = { STALE_MS, DEBUG_LOG_RE, cefTempRoot, staleCefTempFolders, cleanCefTemp }
