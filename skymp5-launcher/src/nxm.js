'use strict'
/**
 * nxm:// links ("Mod Manager Download" and "Add to Vortex" on Nexus) and the manager that had them before us.
 *
 * The launcher takes the links only while an install waits for the player's Nexus downloads (claim), and hands them
 * back when that wait ends or the launcher starts (release), so Vortex or a standalone MO2 keeps working. While it
 * holds them, links it has no use for (collections, other games, files the mod list does not name) go on to that
 * manager (forward). Launchers up to 2.1.29 took the links at every install and never kept the old handler: release()
 * clears that too where a machine-wide manager was hidden behind ours.
 *
 * Plain functions over reg.exe and spawn, injectable, so the logic is tested without Windows (test/nxm.test.js).
 */
const fs   = require('fs')
const path = require('path')
const { execFileSync, spawn } = require('child_process')

const USER_KEY    = 'HKCU\\Software\\Classes\\nxm'
const USER_CMD    = `${USER_KEY}\\shell\\open\\command`
const MACHINE_CMD = 'HKLM\\Software\\Classes\\nxm\\shell\\open\\command'
// Links come from a web page: no whitespace or quote, and never through a shell
const LINK_RE      = /^nxm:\/\/[^\s"]{1,2000}$/i
const FORWARD_ONCE_MS = 60 * 1000

// The default value in `reg query <key> /ve` output (the "(Default)" label is localised), or null
function parseRegDefault(out) {
  const m = /^\s+\S.*?\s{2,}REG_(?:EXPAND_)?SZ\s{2,}(.*?)\s*$/m.exec(String(out || ''))
  return m && m[1] ? m[1] : null
}

// A Windows command line as its words; double quotes group words and are dropped
function splitCommand(cmd) {
  const words = []
  let cur = '', quoted = false, started = false
  for (const ch of String(cmd || '')) {
    if (ch === '"') { quoted = !quoted; started = true; continue }
    if (!quoted && /\s/.test(ch)) { if (started) words.push(cur); cur = ''; started = false; continue }
    cur += ch
    started = true
  }
  if (started) words.push(cur)
  return words
}

// The program and arguments that open link with a registered command: %1 is the link, else it goes last
function forwardCommand(cmd, link) {
  const words = splitCommand(cmd)
  if (!words.length || !words[0]) return null
  let placed = false
  const args = words.slice(1).map(w => {
    if (!w.includes('%1')) return w
    placed = true
    return w.split('%1').join(link)
  })
  if (!placed) args.push(link)
  return { file: words[0], args }
}

// A command that starts one of ours: this launcher, a launcher of ours installed elsewhere (the same exe name), or
// the portable MO2's nxmhandler
function isOwnCommand(cmd, ownExes) {
  const exe = splitCommand(cmd)[0]
  if (!exe) return false
  const norm = p => path.win32.normalize(String(p)).toLowerCase()
  const base = p => path.win32.basename(String(p)).toLowerCase()
  return (ownExes || []).filter(Boolean).some(own => norm(own) === norm(exe) || (base(own) !== 'nxmhandler.exe' && base(own) === base(exe)))
}

// 'file' for a Skyrim SE mod file (the only kind the launcher downloads), 'other' for any other nxm link
// (collections, other games), 'bad' for anything that is not a plain nxm link
function classify(link) {
  if (!LINK_RE.test(String(link || ''))) return 'bad'
  let u
  try { u = new URL(link) } catch { return 'bad' }
  return u.hostname.toLowerCase() === 'skyrimspecialedition' && /^\/mods\/\d+\/files\/\d+/.test(u.pathname) ? 'file' : 'other'
}

// A file's "Mod Manager Download" page on Nexus (the link Vortex opens for free accounts): its Slow download sends an
// nxm:// link, which the launcher downloads straight into the downloads folder
const nexusFilePage = (modId, fileId) =>
  `https://www.nexusmods.com/skyrimspecialedition/mods/${Number(modId)}?tab=files${fileId ? `&file_id=${Number(fileId)}` : ''}&nmm=1`

// One Nexus page at a time, as Vortex does for a collection: the first missing file's page, then the next each time
// another file arrives (found: which items are in, from waitForDownloads). Each page opens once; a file the player
// skips stays in the wait's list.
function createGuide(items, { open, say = () => {} }) {
  const opened = new Set()
  let arrived = -1
  return function next(found) {
    const got = found.filter(Boolean).length
    if (got <= arrived) return null
    arrived = got
    const i = found.findIndex((f, j) => !f && !opened.has(j))
    if (i < 0) return null
    opened.add(i)
    const a = items[i]
    const url = nexusFilePage(a.source.modId, a.source.fileId)
    open(url)
    say(`Nexus page ${got + 1} of ${items.length}: ${a.name}. Click "Slow download" there; the launcher downloads it for you, nothing to move. (${url})`)
    return i
  }
}

function createNxm({ store, log = () => {}, ownExes = () => [], run = execFileSync, spawnFn = spawn,
  exists = fs.existsSync, platform = process.platform, now = Date.now } = {}) {
  const reg = args => run('reg', args, { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  const query = key => { try { return parseRegDefault(String(reg(['query', key, '/ve']))) } catch { return null } }
  const isOurs = cmd => isOwnCommand(cmd, ownExes())
  const nameOf = cmd => path.win32.basename(splitCommand(cmd)[0] || 'the other mod manager')
  const recent = new Map()

  // Nexus links to handlerExe, remembering the manager they came from
  function claim(handlerExe) {
    if (platform !== 'win32') return false
    const user = query(USER_CMD)
    const before = user || query(MACHINE_CMD)
    if (before && !isOurs(before)) store.set('nxmPrevious', { scope: user ? 'user' : 'machine', command: before })
    try {
      reg(['add', USER_KEY, '/ve', '/d', 'URL:NXM Protocol', '/f'])
      reg(['add', USER_KEY, '/v', 'URL Protocol', '/d', '', '/f'])
      reg(['add', USER_CMD, '/ve', '/d', `"${handlerExe}" "%1"`, '/f'])
      store.set('nxmClaimed', true)
      log(`[nxm] Nexus links come to the launcher while the install waits for downloads${before && !isOurs(before) ? ` (${nameOf(before)} gets them back after)` : ''}`)
      return true
    } catch (err) {
      log(`[nxm] could not take Nexus links: ${err.message}`)
      return false
    }
  }

  // The links back to the manager that had them; kept when nobody else wants them or someone already took them back
  function release() {
    if (platform !== 'win32') return null
    store.set('nxmClaimed', false)
    const user = query(USER_CMD)
    if (!user || !isOurs(user)) return null
    const prev = store.get('nxmPrevious')
    const machine = query(MACHINE_CMD)
    try {
      let to = null
      if (prev && prev.scope === 'user' && prev.command && exists(splitCommand(prev.command)[0])) {
        reg(['add', USER_CMD, '/ve', '/d', prev.command, '/f'])
        to = prev.command
      } else if (machine && !isOurs(machine)) {
        // Ours hid a machine-wide manager (or a launcher up to 2.1.29 did): without our key, it answers again
        reg(['delete', USER_KEY, '/f'])
        to = machine
      }
      if (!to) return null
      store.delete('nxmPrevious')
      log(`[nxm] Nexus links handed back to ${nameOf(to)}`)
      return nameOf(to)
    } catch (err) {
      log(`[nxm] could not hand Nexus links back: ${err.message}`)
      return null
    }
  }

  // Open link with the manager that had the links before us; the program's name, or null when there is none
  function forward(link) {
    if (platform !== 'win32' || classify(link) === 'bad') return null
    const cmd = (store.get('nxmPrevious') || {}).command
    if (!cmd || isOurs(cmd)) return null
    const target = forwardCommand(cmd, link)
    if (!target || !exists(target.file)) return null
    // A link that comes straight back was not taken there either: never pass it round in a loop
    const t = now()
    for (const [k, at] of recent) if (t - at > FORWARD_ONCE_MS) recent.delete(k)
    if (recent.has(link)) return null
    recent.set(link, t)
    try {
      const child = spawnFn(target.file, target.args, { detached: true, stdio: 'ignore', windowsHide: false })
      child.on('error', err => log(`[nxm] ${nameOf(cmd)} did not start: ${err.message}`))
      child.unref()
      log(`[nxm] passed a Nexus link on to ${nameOf(cmd)}`)
      return nameOf(cmd)
    } catch (err) {
      log(`[nxm] could not pass the link on: ${err.message}`)
      return null
    }
  }

  return { claim, release, forward, classify, claimed: () => !!store.get('nxmClaimed') }
}

module.exports = { createNxm, createGuide, nexusFilePage, parseRegDefault, splitCommand, forwardCommand, isOwnCommand, classify, USER_KEY, USER_CMD, MACHINE_CMD }
