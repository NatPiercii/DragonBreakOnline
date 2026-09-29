'use strict'
/**
 * The MO2 profile's SkyrimPrefs.ini and Skyrim.ini must be whole files.
 *
 * With no SkyrimPrefs.ini in Documents\My Games to copy (the game never started the normal way, or Documents holds only
 * Vortex leftovers), the launcher's own writes built a skeleton of about 25 keys, and the engine ran on its built-in
 * defaults for everything else: GroundedPasta's profile (2026-09-29) had no [Interface] section at all. A missing or
 * skeleton profile ini is now built from a full prefs file (the player's own, the game's template, or one of the game's
 * presets), and a skeleton's keys are written back on top, so the player's resolution, window mode, FOV and graphics
 * choices stay. The skeleton itself is kept beside it.
 *
 * Skyrim.ini had the same gap: it was seeded only from Documents\My Games, so without one the profile's held just the
 * launcher's writes ([Bethesda.net], the FOV keys in [Display]). The launcher never writes [Archive] and every Skyrim.ini
 * the game or its launcher made has it, so a profile Skyrim.ini without [Archive] is rebuilt from the player's own or
 * the game's Skyrim_Default.ini the same way.
 */
const fs = require('fs')
const path = require('path')
const ini = require('./ini')

// The launcher writes about 25 keys; a prefs file the game or its launcher wrote has well over a hundred
const MIN_KEYS = 60
const PRESETS = ['High.ini', 'Medium.ini', 'Ultra.ini', 'Low.ini']

function keyCount(parsed) {
  return Object.keys(parsed).reduce((n, s) => n + (s ? Object.keys(parsed[s]).length : 0), 0)
}

function hasInterface(parsed) {
  return 'Interface' in parsed
}

// Where a full prefs file can come from, best first: the player's own, the game's template, then the presets the
// vanilla launcher copies in
function candidates(documentsPrefs, gameDirs) {
  const dirs = [...new Set(gameDirs.filter(Boolean))]
  const out = []
  if (documentsPrefs) out.push(documentsPrefs)
  for (const dir of dirs) out.push(path.join(dir, 'Skyrim', 'SkyrimPrefs.ini'))
  for (const name of PRESETS) for (const dir of dirs) out.push(path.join(dir, name))
  return [...new Set(out)]
}

// The first candidate with enough keys, and what was seen on the way
function pickSource(list) {
  const seen = []
  for (const file of list) {
    if (!fs.existsSync(file)) continue
    const parsed = ini.read(file)
    const keys = keyCount(parsed)
    if (keys >= MIN_KEYS) return { file, parsed, seen }
    seen.push(`${file} (${keys} keys)`)
  }
  return { file: null, parsed: null, seen }
}

function stamp(now) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

// Plain { Section: { key: value } } of every key in a parsed ini, the section-less head left out
function allKeys(parsed) {
  const out = {}
  for (const s of Object.keys(parsed)) {
    if (!s) continue
    out[s] = {}
    for (const k of Object.keys(parsed[s])) out[s][k] = parsed[s][k]
  }
  return out
}

// Replaces dest with source, writes every key dest held back on top and keeps the old file beside it
function rebuildFrom(dest, current, sourceFile, now) {
  const aside = `${dest}.incomplete-${stamp(now)}`
  fs.copyFileSync(dest, aside)
  fs.copyFileSync(sourceFile, dest)
  ini.write(dest, allKeys(current))
  return path.basename(aside)
}

/**
 * Seeds a missing profile prefs file, or rebuilds a skeleton one. Returns the lines to log (none when the file is fine).
 *   dest            the profile's skyrimprefs.ini
 *   documentsPrefs  Documents\My Games\...\SkyrimPrefs.ini, or null
 *   gameDirs        game folders to take the template or a preset from (the original install, the game copy)
 *   forced          edits applied to a freshly seeded file only ({ Section: { key: value } })
 */
function ensureProfilePrefs(dest, { documentsPrefs = null, gameDirs = [], forced = null, now = new Date() } = {}) {
  const exists = fs.existsSync(dest)
  const current = exists ? ini.read(dest) : null
  const currentKeys = current ? keyCount(current) : 0
  if (current && currentKeys >= MIN_KEYS && hasInterface(current)) return []

  const source = pickSource(candidates(documentsPrefs, gameDirs))
  const skipped = source.seen.length ? [`too few keys to use: ${source.seen.join(', ')}`] : []
  if (!exists) {
    if (!source.file) return ['no source SkyrimPrefs.ini found to seed', ...skipped]
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(source.file, dest)
    if (forced) ini.write(dest, forced)
    return [`seeded profile SkyrimPrefs.ini from ${source.file}`, ...skipped]
  }
  // A full file without [Interface] is left alone unless the source has one to give
  const skeleton = currentKeys < MIN_KEYS
  if (!skeleton && !(source.parsed && hasInterface(source.parsed))) return []
  const what = `${currentKeys} keys${hasInterface(current) ? '' : ', no [Interface]'}`
  if (!source.file) {
    return [`profile SkyrimPrefs.ini is incomplete (${what}) and no full prefs file was found to rebuild it`, ...skipped]
  }
  const aside = rebuildFrom(dest, current, source.file, now)
  return [
    `rebuilt profile SkyrimPrefs.ini (${what}) from ${source.file}, keeping its own ${currentKeys} keys; ` +
      `the old file is kept as ${aside}`,
    ...skipped,
  ]
}

function hasArchive(parsed) {
  return 'Archive' in parsed
}

/**
 * Seeds a missing profile Skyrim.ini, or rebuilds one without [Archive]. Returns the lines to log.
 *   dest          the profile's skyrim.ini
 *   documentsIni  Documents\My Games\...\Skyrim.ini, or null
 *   gameDirs      game folders holding Skyrim_Default.ini (the game copy, the original install)
 */
function ensureProfileSkyrimIni(dest, { documentsIni = null, gameDirs = [], now = new Date() } = {}) {
  const exists = fs.existsSync(dest)
  const current = exists ? ini.read(dest) : null
  if (current && hasArchive(current)) return []

  const list = [documentsIni, ...[...new Set(gameDirs.filter(Boolean))].map(d => path.join(d, 'Skyrim_Default.ini'))]
  const seen = []
  let source = null
  for (const file of [...new Set(list.filter(Boolean))]) {
    if (!fs.existsSync(file)) continue
    if (hasArchive(ini.read(file))) { source = file; break }
    seen.push(file)
  }
  const skipped = seen.length ? [`no [Archive] in ${seen.join(', ')}`] : []
  if (!exists) {
    if (!source) return ['no source Skyrim.ini found to seed', ...skipped]
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(source, dest)
    return [`seeded profile Skyrim.ini from ${source}`, ...skipped]
  }
  const keys = keyCount(current)
  if (!source) {
    return [`profile Skyrim.ini has no [Archive] (${keys} keys) and no full Skyrim.ini was found to rebuild it`, ...skipped]
  }
  const aside = rebuildFrom(dest, current, source, now)
  return [
    `rebuilt profile Skyrim.ini (${keys} keys, no [Archive]) from ${source}, keeping its own ${keys} keys; ` +
      `the old file is kept as ${aside}`,
    ...skipped,
  ]
}

module.exports = { ensureProfilePrefs, ensureProfileSkyrimIni, keyCount, MIN_KEYS }
