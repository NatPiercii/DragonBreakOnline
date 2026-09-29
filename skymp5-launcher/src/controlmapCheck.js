'use strict'
/**
 * The control maps the game loads must hold every input context, in order.
 *
 * GroundedPasta's container crash (2026-09-29): SKSE's GetMappedKey read context 3 (Item Menus) of the game's loaded
 * control map, and it was null. The same player's menu cursor never moved, and the Cursor context (9) is what turns
 * mouse movement into cursor movement. A map that ends early leaves every later context missing. A map from before
 * 1.6.1130 has no Creations Menu context, so Favor lands in its slot and the last one is empty.
 *
 * Before launch, every map the game reads is parsed:
 *   - ControlMap_Custom.txt in the game root. The game writes it when a player remaps a control, and it overrides
 *     controlmap.txt.
 *   - The controlmap.txt that wins in Data. Under MO2 that is the overwrite folder, then the enabled mods from the top
 *     of modlist.txt, then the game's own Data. Without MO2 it is the game's own Data. The archive copy is vanilla.
 * Blank lines separate the contexts, as the file's own header says; tab-only lines count, as in the vanilla file.
 * A block counts as its context when it holds at least half of that context's events in the launcher's seed map
 * (assets/controlmap.txt: the vanilla 1.6.1130+ map with only Wait unbound). A map short of any context is moved
 * aside, dated, and logged, so a report shows it. The next map down then applies, and applyControlmapOverride seeds
 * the game's own Data again when nothing is left.
 */
const fs = require('fs')
const path = require('path')

const SEED = path.join(__dirname, '..', 'assets', 'controlmap.txt')
const CUSTOM = 'ControlMap_Custom.txt'
const DATA_REL = path.join('Interface', 'Controls', 'PC', 'controlmap.txt')
// SKSE 2.2.6 GameInput.h, InputManager::kContext_* for 1.6.1130+, in order
const CONTEXT_NAMES = [
  'Gameplay', 'Menu Mode', 'Console', 'Item Menus', 'Inventory', 'Debug Text', 'Favorites', 'Map', 'Stats', 'Cursor',
  'Book', 'Debug Overlay', 'Journal', 'TFC Mode', 'Map Debug', 'Lockpicking', 'Creations Menu', 'Favor',
]

// The event names of each context block. Comment lines are skipped, and a block of comments alone is not a context.
function parseBlocks(text) {
  const blocks = []
  let current = null
  for (const raw of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    if (!raw.trim()) { current = null; continue }
    if (!current) { current = []; blocks.push(current) }
    if (raw.trim().startsWith('//')) continue
    const name = raw.includes('\t') ? raw.split('\t')[0] : ((/^(.*?)\s+0x/i.exec(raw) || [])[1] || '')
    if (name.trim()) current.push(name.trim())
  }
  return blocks.filter(b => b.length).map(b => [...new Set(b)])
}

let expectedCache = null
function expectedContexts() {
  if (!expectedCache) expectedCache = parseBlocks(fs.readFileSync(SEED, 'utf8'))
  return expectedCache
}

// { ok, found, expected, blocks, missing: [context names] }
function analyzeControlmap(text) {
  const want = expectedContexts()
  const blocks = parseBlocks(text)
  const missing = []
  want.forEach((events, i) => {
    const have = new Set(blocks[i] || [])
    const hit = events.filter(e => have.has(e)).length
    if (hit * 2 < events.length) missing.push(CONTEXT_NAMES[i] || `context ${i}`)
  })
  return { ok: missing.length === 0, found: want.length - missing.length, expected: want.length, blocks: blocks.length, missing }
}

// Mod names switched on in an MO2 modlist.txt, top line (highest priority) first
function enabledMods(modlistText) {
  return String(modlistText).split(/\r?\n/).filter(l => l.startsWith('+')).map(l => l.slice(1).trim()).filter(Boolean)
}

/**
 * The map files the game reads, as { custom, data }: the root ControlMap_Custom.txt or null, and the loose
 * controlmap.txt candidates in Data, highest priority first. mo2 is { overwriteDir, modsDir, mods } or null.
 */
function controlmapFiles(gameDir, mo2 = null) {
  const exists = f => { try { return fs.statSync(f).isFile() } catch { return false } }
  const data = []
  if (mo2) {
    data.push(path.join(mo2.overwriteDir, DATA_REL))
    for (const mod of mo2.mods || []) data.push(path.join(mo2.modsDir, mod, DATA_REL))
  }
  data.push(path.join(gameDir, 'Data', DATA_REL))
  const custom = path.join(gameDir, CUSTOM)
  return { custom: exists(custom) ? custom : null, data: data.filter(exists) }
}

function stamp(now) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

function moveAside(file, now) {
  let aside = `${file}.incomplete-${stamp(now)}`
  for (let n = 2; fs.existsSync(aside); n++) aside = `${file}.incomplete-${stamp(now)}-${n}`
  fs.renameSync(file, aside)
  return aside
}

/**
 * Checks the custom map and the Data maps down to the first complete one, moving incomplete ones aside.
 * Returns the lines to log: one per map read, so a report shows which map the game was given.
 */
function checkControlmaps({ gameDir, mo2 = null, now = new Date() } = {}) {
  if (!gameDir) return []
  const lines = []
  const { custom, data } = controlmapFiles(gameDir, mo2)
  // true when the file is complete (or unreadable, so left to the game)
  const check = file => {
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch (err) {
      lines.push(`controlmap: could not read ${file}: ${err.message}`)
      return true
    }
    const r = analyzeControlmap(text)
    if (r.ok) {
      lines.push(`controlmap: ${file} has ${r.found} of ${r.expected} contexts`)
      return true
    }
    const aside = moveAside(file, now)
    lines.push(`controlmap: ${file} has ${r.found} of ${r.expected} contexts (missing ${r.missing.join(', ')}), ` +
      `moved aside to ${path.basename(aside)}`)
    return false
  }
  if (custom) check(custom)
  let settled = false
  for (const file of data) if ((settled = check(file))) break
  if (!settled) lines.push('controlmap: no loose controlmap.txt is left in Data; the game\'s own applies until the launcher seeds one')
  return lines
}

module.exports = { CONTEXT_NAMES, parseBlocks, analyzeControlmap, enabledMods, controlmapFiles, checkControlmaps }
