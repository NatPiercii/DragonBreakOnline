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
 * aside, dated, and logged, so a report shows it.
 *
 * Line endings count too. The vanilla map, and every map the game or a PC-built launcher wrote, ends its lines in CRLF;
 * the launchers built on CT 115 from 27 Sep shipped the seed with LF only, and every player who has the stuck menu
 * cursor or the container crash installed after that. A map with lines ending in LF alone is moved aside the same way. The next map down then applies, and applyControlmapOverride seeds
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

// Lines that end in LF without the CR before it
function bareLfCount(text) {
  return (String(text).match(/(?<!\r)\n/g) || []).length
}

// The text with every line ending CRLF
function toCrlf(text) {
  return String(text).replace(/\r?\n/g, '\r\n')
}

let expectedCache = null
function expectedContexts() {
  if (!expectedCache) expectedCache = parseBlocks(fs.readFileSync(SEED, 'utf8'))
  return expectedCache
}

// { ok, found, expected, blocks, missing: [context names], lf: lines ending in LF only }
function analyzeControlmap(text) {
  const want = expectedContexts()
  const blocks = parseBlocks(text)
  const missing = []
  want.forEach((events, i) => {
    const have = new Set(blocks[i] || [])
    const hit = events.filter(e => have.has(e)).length
    if (hit * 2 < events.length) missing.push(CONTEXT_NAMES[i] || `context ${i}`)
  })
  const lf = bareLfCount(text)
  return { ok: missing.length === 0 && lf === 0, found: want.length - missing.length, expected: want.length, blocks: blocks.length, missing, lf }
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

function moveAside(file, now, tag) {
  let aside = `${file}.${tag}-${stamp(now)}`
  for (let n = 2; fs.existsSync(aside); n++) aside = `${file}.${tag}-${stamp(now)}-${n}`
  fs.renameSync(file, aside)
  return aside
}

// ---- keeping a player's remaps -------------------------------------------------------------------------------
//
// Skyrim writes ControlMap_Custom.txt in the game root when a player remaps a key, and it overrides controlmap.txt.
// Moving it aside prevented the crash but threw the player's keys away on every launch ("my keybinds reset when
// loading in", Onny and exsenus, 2026-09-30). So a map that is short or LF is now REPAIRED instead: the player's own
// lines are merged over the complete seed and written back CRLF, with their original kept as a dated .bak.
//
// Blocks are matched by which events they hold, not by position: a custom map may carry only the contexts the player
// touched, in whatever order, so aligning by index would write one context's bindings into another.

// Blocks of { name, line } keeping the whole line, so a player's binding survives the merge
function parseFullBlocks(text) {
  const blocks = [];
  let current = null;
  for (const raw of String(text).replace(/^\ufeff/, '').split(/\r?\n/)) {
    if (!raw.trim()) { current = null; continue; }
    if (!current) { current = []; blocks.push(current); }
    if (raw.trim().startsWith('//')) continue;
    const name = raw.includes('\t') ? raw.split('\t')[0] : ((/^(.*?)\s+0x/i.exec(raw) || [])[1] || '');
    if (name.trim()) current.push({ name: name.trim(), line: raw });
  }
  return blocks.filter(b => b.length);
}

// The seed block a custom block belongs to: the one sharing the most event names. null when it shares none.
function matchBlock(customBlock, seedBlocks, taken) {
  const names = new Set(customBlock.map(e => e.name));
  let best = null, bestHits = 0;
  seedBlocks.forEach((block, i) => {
    if (taken.has(i)) return;
    const hits = block.filter(e => names.has(e.name)).length;
    if (hits > bestHits) { best = i; bestHits = hits; }
  });
  return bestHits > 0 ? best : null;
}

/**
 * The seed with the player's own bindings written over it, or null when nothing could be carried across.
 * Only events the seed already knows are taken, so a junk file cannot inject lines.
 */
function mergeCustomOverSeed(customText, seedText) {
  const seedBlocks = parseFullBlocks(seedText);
  const customBlocks = parseFullBlocks(customText);
  if (!seedBlocks.length || !customBlocks.length) return null;
  const taken = new Set();
  const replacement = new Map();   // "blockIndex\u0000eventName" -> the player's line
  for (const block of customBlocks) {
    const i = matchBlock(block, seedBlocks, taken);
    if (i === null) continue;
    taken.add(i);
    const known = new Set(seedBlocks[i].map(e => e.name));
    for (const entry of block) if (known.has(entry.name)) replacement.set(`${i}\u0000${entry.name}`, entry.line);
  }
  if (!replacement.size) return null;
  // Walk the seed text itself, so its comments, blank lines and context order are kept exactly
  let block = -1, inBlock = false;
  const out = [];
  for (const raw of String(seedText).replace(/^\ufeff/, '').split(/\r?\n/)) {
    if (!raw.trim()) { inBlock = false; out.push(raw); continue; }
    if (!inBlock) { inBlock = true; block++; }
    if (raw.trim().startsWith('//')) { out.push(raw); continue; }
    const name = raw.includes('\t') ? raw.split('\t')[0] : ((/^(.*?)\s+0x/i.exec(raw) || [])[1] || '');
    const mine = replacement.get(`${block}\u0000${name.trim()}`);
    out.push(mine === undefined ? raw : mine);
  }
  return toCrlf(out.join('\n'));
}

/**
 * Repairs one control map in place: the player's bindings merged over the seed, CRLF, original kept as a dated .bak.
 * Returns the backup path, or null when the file could not be repaired (the caller then moves it aside as before).
 * A repaired map analyses as complete, so the next launch leaves it alone: no rewrite, no second backup.
 */
function repairControlmap(file, now, seedText) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { return null; }
  const merged = mergeCustomOverSeed(text, seedText === undefined ? fs.readFileSync(SEED, 'utf8') : seedText);
  if (!merged || !analyzeControlmap(merged).ok) return null;
  let bak = `${file}.bak-${stamp(now)}`;
  for (let n = 2; fs.existsSync(bak); n++) bak = `${file}.bak-${stamp(now)}-${n}`;
  fs.copyFileSync(file, bak);
  fs.writeFileSync(file, merged);
  return bak;
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
    const why = [
      r.missing.length ? `missing ${r.missing.join(', ')}` : '',
      r.lf ? `${r.lf} line(s) end in LF only, the game's own map uses CRLF` : '',
    ].filter(Boolean).join('; ')
    // Keep the player's keys: merge them over the seed rather than throwing the file away
    const bak = repairControlmap(file, now, undefined)
    if (bak) {
      lines.push(`controlmap: ${file} has ${r.found} of ${r.expected} contexts (${why}), repaired in place with the player's bindings kept; original saved as ${path.basename(bak)}`)
      return true
    }
    const aside = moveAside(file, now, r.missing.length ? 'incomplete' : 'lf')
    lines.push(`controlmap: ${file} has ${r.found} of ${r.expected} contexts (${why}), nothing could be carried across, moved aside to ${path.basename(aside)}`)
    return false
  }
  if (custom) check(custom)
  let settled = false
  for (const file of data) if ((settled = check(file))) break
  if (!settled) lines.push('controlmap: no loose controlmap.txt is left in Data; the game\'s own applies until the launcher seeds one')
  return lines
}

module.exports = { CONTEXT_NAMES, parseBlocks, parseFullBlocks, analyzeControlmap, enabledMods, controlmapFiles, checkControlmaps, bareLfCount, toCrlf, mergeCustomOverSeed, repairControlmap }
