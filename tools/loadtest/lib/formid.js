// Form ids from plugin descs ("87829:BSHeartland.esm"), resolved the way the server resolves them.
// Mirrors fork\libespm\src\Combiner.cpp: full and light plugins are counted separately in load order, a full
// plugin owns id >> 24, a light one lives at 0xFE | slot << 12 with a 12-bit local id. The TES4 flag that
// marks a light plugin is 0x200, read from bytes 8..11 of the file.
// The result is checked against the ids CLAUDE.md records as known-good before anything uses it.
'use strict';
const fs = require('fs');
const path = require('path');

const SMALL_FILE_FLAG = 0x200;

// CLAUDE.md "Facts that cost hours to learn": plugin index << 24 | local id, with these positions verified
// against live log lines. If our computation disagrees, the load order changed and every id would be wrong.
const KNOWN_INDEX = {
  'skyrim.esm': 0x00,
  'dawnguard.esm': 0x02,
  'bsassets.esm': 0x07,
  'bsheartland.esm': 0x08,
};

function isLight(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(12);
    if (fs.readSync(fd, head, 0, 12, 0) < 12) throw new Error('short plugin header: ' + file);
    if (head.toString('latin1', 0, 4) !== 'TES4') throw new Error('not a plugin (no TES4): ' + file);
    return (head.readUInt32LE(8) & SMALL_FILE_FLAG) !== 0;
  } finally {
    fs.closeSync(fd);
  }
}

// loadOrder is the server-settings.json array, dataDir the folder those names live in
function buildIndex(dataDir, loadOrder) {
  const slots = new Map(); // lowercase plugin name -> { light, index }
  let nextFull = 0;
  let nextLight = 0;
  for (const name of loadOrder) {
    const file = path.isAbsolute(name) ? name : path.join(dataDir, name);
    const light = isLight(file);
    slots.set(path.basename(name).toLowerCase(), light
      ? { light: true, index: nextLight++ }
      : { light: false, index: nextFull++ });
  }
  const problems = [];
  for (const [name, index] of Object.entries(KNOWN_INDEX)) {
    const got = slots.get(name);
    if (!got) continue;
    if (got.light || got.index !== index) {
      problems.push(name + ' resolved to ' + JSON.stringify(got) + ', CLAUDE.md records index 0x' + index.toString(16));
    }
  }
  if (problems.length) throw new Error('load order index disagrees with verified facts:\n  ' + problems.join('\n  '));
  return slots;
}

// "87829:BSHeartland.esm" -> 0x08087829
function idFromDesc(slots, desc) {
  const i = String(desc).indexOf(':');
  if (i < 0) throw new Error('not a desc: ' + desc);
  const local = parseInt(desc.slice(0, i), 16);
  const name = desc.slice(i + 1).toLowerCase();
  const slot = slots.get(name);
  if (!slot) throw new Error('plugin not in the load order: ' + desc);
  if (!Number.isFinite(local)) throw new Error('bad local id: ' + desc);
  if (slot.light) {
    if (local > 0xfff) throw new Error('local id over 12 bits in a light plugin: ' + desc);
    return (0xfe000000 | ((slot.index & 0xfff) << 12) | local) >>> 0;
  }
  if (local > 0xffffff) throw new Error('local id over 24 bits: ' + desc);
  return (((slot.index & 0xff) << 24) | local) >>> 0;
}

module.exports = { buildIndex, idFromDesc };
