// DragonBreak Online: NPCs under the terrain. Loaded by gamemode.js on every hot reload.
//
// terrain-heights.json (ck-mcp/terrain_heights.py; extracted game data, not tracked, copied by hand)
// holds the winning LAND heights of the Heartland world. Every second the server position of each NPC
// near an online player is compared with the terrain under it: "npcGround under" is logged when one
// stays more than 48 units below it, "npcGround over" only past 600 above, since actors on rocks and
// bridges stand above the terrain. globalThis.__dboTerrainDz answers the same for npcDrift lines.
// Which way a quad splits into triangles is not known, so both are computed: "under" means below the
// lower one, "over" above the higher one.
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = 'terrain-heights.json';
const CELL_UNITS = 4096;
const QUAD_UNITS = 128;
const EVERY_MS = 1000;
const UNDER_UNITS = 48;
const UNDER_SAMPLES = 2;
const OVER_UNITS = 600;
const LOG_EVERY_MS = 60000;
// The server owns the ground (Nat, 2026-09-25): an NPC held this far under the terrain for UNDER_SAMPLES is lifted
// onto it. A server move reaches the hoster as a teleport and everyone else through the hoster's stream. Only ever up,
// and only where the nearest player stands on the same terrain data, so a wrong height cannot throw NPCs about.
const FIX_UNITS = 64;
const FIX_LIFT = 24;
const FIX_EVERY_MS = 5000;
const PLAYER_TRUST_UNITS = 150;

const normDesc = (d) => {
  const s = String(d || '').trim().toLowerCase();
  const i = s.indexOf(':');
  if (i < 0) return s;
  const n = parseInt(s.slice(0, i), 16);
  return (Number.isFinite(n) ? n.toString(16) : s.slice(0, i)) + ':' + s.slice(i + 1);
};

// One cell's VHGT: a float offset, then 33x33 signed byte gradients, heights in units of 8
const decode = (b64) => {
  const buf = Buffer.from(b64, 'base64');
  const h = new Float64Array(33 * 33);
  let row = buf.readFloatLE(0);
  for (let y = 0; y < 33; y++) {
    row += buf.readInt8(4 + y * 33);
    let col = row;
    h[y * 33] = col * 8;
    for (let x = 1; x < 33; x++) {
      col += buf.readInt8(4 + y * 33 + x);
      h[y * 33 + x] = col * 8;
    }
  }
  return h;
};

const loadTerrain = (file) => {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const worlds = new Map();
  let cells = 0;
  for (const [desc, w] of Object.entries(raw.worlds || {})) {
    worlds.set(normDesc(desc), { cells: (w && w.cells) || {}, cache: new Map() });
    cells += Object.keys((w && w.cells) || {}).length;
  }
  // Terrain height under x,y for both triangle splits, or null where there is no data
  const at = (desc, x, y) => {
    const w = worlds.get(normDesc(desc));
    if (!w || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    const gx = Math.floor(x / CELL_UNITS);
    const gy = Math.floor(y / CELL_UNITS);
    const key = `${gx},${gy}`;
    let h = w.cache.get(key);
    if (!h) {
      if (!w.cells[key]) return null;
      w.cache.set(key, h = decode(w.cells[key]));
    }
    const lx = (x - gx * CELL_UNITS) / QUAD_UNITS;
    const ly = (y - gy * CELL_UNITS) / QUAD_UNITS;
    const i = Math.min(Math.floor(lx), 31);
    const j = Math.min(Math.floor(ly), 31);
    const fx = lx - i;
    const fy = ly - j;
    const a = h[j * 33 + i], b = h[j * 33 + i + 1], c = h[(j + 1) * 33 + i], d = h[(j + 1) * 33 + i + 1];
    const t1 = fx >= fy ? a + (b - a) * fx + (d - b) * fy : a + (c - a) * fy + (d - c) * fx;
    const t2 = fx + fy <= 1 ? a + (b - a) * fx + (c - a) * fy : d + (c - d) * (1 - fx) + (b - d) * (1 - fy);
    return { lo: Math.min(t1, t2), hi: Math.max(t1, t2) };
  };
  return { at, has: (desc) => worlds.has(normDesc(desc)), worlds: worlds.size, cells };
};

// Below the lower triangle is negative, above the higher one positive, between them 0
const dzOf = (t, z) => (z < t.lo ? z - t.lo : z > t.hi ? z - t.hi : 0);

module.exports = (api) => {
  const { mp, log, every, onlineActors, display } = api;
  const FIX = ((api.cfg || {}).npcGround || {}).fix !== false;
  const file = path.resolve(FILE);
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch (e) { /* no file */ }
  // Parsed once per file version; a hot reload reuses it
  const cached = globalThis.__dboTerrain;
  let terrain = cached && cached.mtime === mtime ? cached.terrain : null;
  if (!terrain && mtime) {
    try { terrain = loadTerrain(file); } catch (e) { log(`npcGround: ${FILE} unreadable: ${e.message}`); }
  }
  globalThis.__dboTerrain = { mtime, terrain };
  if (!terrain) log(`npcGround: no ${FILE}, the ground check is off`);
  else if (!cached || cached.terrain !== terrain) log(`npcGround: ${terrain.cells} terrain cells in ${terrain.worlds} world(s)`);

  globalThis.__dboTerrainDz = (desc, pos) => {
    if (!terrain || !Array.isArray(pos)) return null;
    const t = terrain.at(desc, Number(pos[0]), Number(pos[1]));
    return t ? Math.round(dzOf(t, Number(pos[2]))) : null;
  };

  // The terrain data is trusted where the player near the NPC stands on it within PLAYER_TRUST_UNITS
  const playerOnTerrain = (p, desc) => {
    try {
      if (String(mp.get(p, 'worldOrCellDesc') || '') !== desc) return false;
      const pp = mp.get(p, 'pos');
      const t = terrain.at(desc, pp[0], pp[1]);
      return !!t && Math.abs(dzOf(t, pp[2])) <= PLAYER_TRUST_UNITS;
    } catch (e) { return false; }
  };

  const state = globalThis.__dboNpcGround instanceof Map ? globalThis.__dboNpcGround : (globalThis.__dboNpcGround = new Map());
  const hex = (id) => (id >>> 0).toString(16);
  const check = (id, near, now) => {
    let desc, pos, base;
    try {
      desc = String(mp.get(id, 'worldOrCellDesc') || '');
      if (!terrain.has(desc) || mp.get(id, 'isDead') === true || mp.get(id, 'profileId') >= 0) return;
      pos = mp.get(id, 'pos');
      base = String(mp.get(id, 'baseDesc') || '?');
    } catch (e) { return; }
    const t = Array.isArray(pos) ? terrain.at(desc, pos[0], pos[1]) : null;
    if (!t) return;
    const dz = dzOf(t, pos[2]);
    let s = state.get(id);
    if (!s) state.set(id, s = { under: 0, underAt: 0, overAt: 0, fixedAt: 0 });
    const where = () => `${hex(id)} ${base} at ${pos.map(Math.round).join(',')} terrain ${Math.round(t.lo)}..${Math.round(t.hi)} dz ${Math.round(dz)}, near ${display(near)}`;
    if (dz < -UNDER_UNITS) {
      s.under++;
      if (s.under >= UNDER_SAMPLES && now - s.underAt >= LOG_EVERY_MS) {
        s.underAt = now;
        log(`npcGround under ${where()} for ${s.under} samples`);
      }
      if (FIX && s.under >= UNDER_SAMPLES && dz < -FIX_UNITS && now - s.fixedAt >= FIX_EVERY_MS && playerOnTerrain(near, desc)) {
        s.fixedAt = now;
        s.under = 0;
        try {
          let rot = [0, 0, 0]; try { rot = mp.get(id, 'angle') || rot; } catch (e) { /* default */ }
          mp.set(id, 'locationalData', { cellOrWorldDesc: desc, pos: [pos[0], pos[1], t.hi + FIX_LIFT], rot });
          log(`npcGround lifted ${where()} onto the terrain`);
        } catch (e) { log(`npcGround: lifting ${hex(id)} failed: ${e.message}`); }
      }
    } else {
      s.under = 0;
    }
    if (dz > OVER_UNITS && now - s.overAt >= LOG_EVERY_MS) {
      s.overAt = now;
      log(`npcGround over ${where()}`);
    }
  };

  every('npcGround', EVERY_MS, () => {
    if (!terrain) return;
    const now = Date.now();
    const players = onlineActors();
    const skip = new Set(players);
    for (const p of players) {
      let near = [];
      try { near = mp.get(p, 'actorNeighbors') || []; } catch (e) { continue; }
      for (const id of near) {
        if (skip.has(id)) continue;
        skip.add(id);
        check(id, p, now);
      }
    }
    for (const id of state.keys()) if (!skip.has(id)) state.delete(id);
  });
};

module.exports.loadTerrain = loadTerrain;
module.exports.dzOf = dzOf;
