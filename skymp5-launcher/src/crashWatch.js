'use strict'
// Watches the game after a launch and tells the server how it closed: a crash, a normal close, or some other end
// (killed, frozen and closed, shut down by Windows). The server alone cannot tell these apart: each is a player who
// went silent (Jake, 2026-09-26). Only the outcome, the exit code, whether a crash log appeared and the two times
// leave the machine; the log itself and every path stay here. This is the slim part of Auto Report's crash watcher
// (docs/auto-report-v1 §2.4), sent to POST /api/files/session-end (skymp5-backend/sources/sessionEnds.js).
//
// How the exit code is read (contract §2.4): SkyrimSE.exe is started by skse64_loader.exe or by MO2, never by us, so
// Node cannot wait on it. PowerShell can: Get-Process, touch .Handle (without it .NET gives no exit code for a process
// it did not start), WaitForExit, then ExitCode, printed signed and turned unsigned here (-1073741819 is 0xC0000005).

const fs   = require('fs')
const path = require('path')

const FIND_EVERY_MS  = 3000
const FIND_FOR_MS    = 3 * 60 * 1000   // MO2 can take a while to boot the game
const CRASHLOG_FOR_MS = 20_000          // Crash Logger writes its log as the game dies; give it time to finish
const CRASHLOG_EVERY_MS = 2000

// The pid of SkyrimSE.exe from `tasklist /FO CSV /NH`, or 0
function parsePid(stdout) {
  const row = String(stdout || '').split(/\r?\n/).find(l => /^"SkyrimSE\.exe"/i.test(l))
  const pid = row ? Number(row.split('","')[1]) : 0
  return Number.isInteger(pid) && pid > 0 ? pid : 0
}

// PowerShell prints the exit code signed; anything that is not a whole number means none was read
function parseExitCode(stdout) {
  const text = String(stdout || '').trim().split(/\r?\n/).pop()
  if (!/^-?\d+$/.test(text || '')) return null
  const n = Number(text)
  return n >= -(2 ** 31) && n < 2 ** 32 ? n >>> 0 : null
}

// A Crash Logger log written since the launch, in any of the SKSE folders, and no longer growing
function crashLogSince(dirs, since) {
  const found = []
  for (const dir of dirs) {
    let names = []
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const name of names) {
      if (!/^crash-.*\.log$/i.test(name)) continue
      try { const st = fs.statSync(path.join(dir, name)); if (st.mtimeMs >= since - 2000) found.push(`${dir}|${name}|${st.size}`) } catch { /* gone */ }
    }
  }
  return found.sort().join(',')
}

// crash: a crash log appeared, or Windows ended the game with an exception (NTSTATUS error codes are 0xC0000000 up).
// closed: exit code 0 and no crash log. ended: anything else, such as 1 from Task Manager.
function classify(exitCode, crashLog) {
  if (crashLog || (exitCode !== null && exitCode >= 0xC0000000)) return 'crash'
  if (exitCode === 0) return 'closed'
  return 'ended'
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// run(file, args) resolves to stdout (rejects on failure); send(note) posts it. Everything is passed in for the tests.
async function watchGame({ run, send, crashDirs, launchedAt = Date.now(), log = () => {}, now = Date.now, wait = sleep }) {
  let pid = 0
  for (const started = now(); !pid && now() - started < FIND_FOR_MS; ) {
    try { pid = parsePid(await run('tasklist', ['/FI', 'IMAGENAME eq SkyrimSE.exe', '/FO', 'CSV', '/NH'])) } catch { /* try again */ }
    if (!pid) await wait(FIND_EVERY_MS)
  }
  if (!pid) { log('[crashWatch] the game never started; nothing to report'); return null }
  const startedAt = now()
  log(`[crashWatch] watching SkyrimSE.exe pid ${pid}`)

  let exitCode = null
  try {
    exitCode = parseExitCode(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$p = Get-Process -Id ${pid} -ErrorAction Stop; $null = $p.Handle; $p.WaitForExit(); $p.ExitCode`]))
  } catch (err) { log(`[crashWatch] could not wait on the game: ${err.message}`) }
  const endedAt = now()

  // Wait for a crash log to appear and stop growing, up to 20 s
  let crashLog = false
  for (let seen = '', t = now(); now() - t < CRASHLOG_FOR_MS; ) {
    const logs = crashLogSince(crashDirs, launchedAt)
    if (logs && logs === seen) { crashLog = true; break }
    seen = logs
    await wait(CRASHLOG_EVERY_MS)
  }
  // No exit code and no crash log says nothing: the watcher failed, not the game
  if (exitCode === null && !crashLog) { log('[crashWatch] no exit code and no crash log; nothing to report'); return null }

  const note = { outcome: classify(exitCode, crashLog), exitCode, crashLog, startedAt, endedAt }
  log(`[crashWatch] game ${note.outcome} (exit ${exitCode === null ? 'unknown' : '0x' + exitCode.toString(16)}${crashLog ? ', crash log' : ''})`)
  try { await send(note) } catch (err) { log(`[crashWatch] could not send: ${err.statusCode || ''} ${err.message}`) }
  return note
}

module.exports = { watchGame, parsePid, parseExitCode, crashLogSince, classify }
