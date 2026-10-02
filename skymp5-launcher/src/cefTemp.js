'use strict'
// SkyrimPlatform's browser keeps its cache and cef_debug.log in %TEMP%\Skyrim Platform\CEFTemp<hash of the game
// folder> (MyChromiumApp.cpp) and never removes one, so they pile up (Jake's PC, 2 Oct 2026: four of them, a log of
// ~51 MB in one session). Before a launch, with the game not running, a folder nobody has written to for a few days is
// removed; one that cannot be removed is left for the next launch.

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

// Removes the stale folders; { removed, failed } as folder names
function cleanCefTemp({ root = cefTempRoot(), now = Date.now(), staleMs = STALE_MS, log = () => {} } = {}) {
  const removed = [], failed = []
  for (const dir of staleCefTempFolders(root, now, staleMs)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); removed.push(path.basename(dir)) } catch (e) {
      failed.push(path.basename(dir))
      log(`[cefTemp] could not remove ${path.basename(dir)}: ${e.code || e.message}`)
    }
  }
  if (removed.length) log(`[cefTemp] removed ${removed.length} stale browser cache folder(s): ${removed.join(', ')}`)
  return { removed, failed }
}

module.exports = { STALE_MS, cefTempRoot, staleCefTempFolders, cleanCefTemp }
