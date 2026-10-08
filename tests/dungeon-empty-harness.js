// Dungeons with nothing to fight (#bugs 1557606388090413177, 8 Oct: "Boreal Stone Cave No Enemies Novice ... Same happened
// in Echo Cave"). dungeons_build.py makes a dungeon's enemies from its cells' enabled, living placements and
// tools/dungeons/fill_empty_rooms.py only filled dungeons of two rooms or more, so a one-room dungeon whose occupants
// start disabled, dead or are a quest's own had no enemy in any claim. Boreal Stone Cave's ogre (CYRdunBorealStoneCaveOgre,
// 7cbd8) is placed disabled for a quest to enable; Echo Cave and Hjaltis Refuge hold only corpses and Frozen Grotto a
// unique quest character. Now the den's own ogre is its boss again (a Novice ogre on Novice, a balance call for Nate)
// and a site with nothing living in it is not offered for a claim (config dungeons.exclude).
// Loads the real dungeons.js with the real dungeons.json, gamemode-config.json and loot data in a scratch folder.
//   node tests/dungeon-empty-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got).slice(0, 600)}`); if (!c) fails++; };
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));

let rng = 0;
const reseed = (key) => { let h = 2166136261; for (const c of String(key)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); rng = h >>> 0; };
Math.random = () => { rng = (rng + 0x6d2b79f5) >>> 0; let t = Math.imul(rng ^ (rng >>> 15), rng | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const ALL = read('dungeons.json').dungeons;
const cfg = read('gamemode-config.json');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-jake-b-dng-empty-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
for (const f of ['dungeons.json', 'loot.json', 'ayleid-loot.json', 'dungeon-pools.json', 'artifacts.json', 'dragon-materials.json']) { try { fs.copyFileSync(path.join(ROOT, f), f); } catch (e) { /* optional */ } }
fs.writeFileSync('expeditions.json', JSON.stringify({ expeditions: [] }));
global.setTimeout = () => 0;

const ids = new Map(), descs = new Map(); let nextId = 0x100;
const idOf = (d) => { const k = String(d).toLowerCase(); if (!ids.has(k)) { ids.set(k, nextId); descs.set(nextId, k); nextId++; } return ids.get(k); };
const A = 0x14;
let LEVEL = 1;
globalThis.__dboCharLevel = () => LEVEL;
globalThis.__dboDungeons = undefined;
const props = new Map();
const ui = new Map(), cmds = new Map(), widgets = [];
require(path.join(ROOT, 'dungeons.js'))({
  mp: {
    get: (id, p) => (p === 'profileId' ? (id === A ? 1 : -1) : props.get(`${id}|${p}`)),
    set: (id, p, v) => props.set(`${id}|${p}`, v), getIdFromDesc: idOf, getDescFromId: (id) => descs.get(id),
    lookupEspmRecordById: () => ({ record: null }),
  },
  log: () => {}, personal: () => {}, system: () => {}, audit: () => {}, registerChatCommand: (n, fn) => cmds.set(n, fn),
  onUi: (n, fn) => { const l = ui.get(n) || []; l.push(fn); ui.set(n, l); },
  openWidget: (a, w) => { widgets.push(w); return true; }, closeWidget: () => true, sendPacket: () => true, findByName: () => 0,
  display: String, who: String, profileOf: (a) => (a === A ? 1 : -1), nameOf: () => 'P', onlineActors: () => [A],
  isAdmin: () => true, giveItem: () => true, cfg: { dungeons: Object.assign({}, cfg.dungeons || {}) }, every: () => {},
});
const fire = (n, a, args) => (ui.get(n) || []).forEach((f) => f(a, args, 0));
const norm = (d) => String(d).toLowerCase();
const cells = new Set([...(globalThis.__dboDungeonCells || [])].map(norm));
const offered = ALL.filter((d) => d.cells.some((c) => cells.has(norm(c.desc))));
const enemies = (d) => (d.zones || []).reduce((n, z) => n + (z.npcs || []).length, 0);

// ---- the data: nothing is offered without an enemy ----
ok(offered.length > 100, `the real dungeons.js offers the real dungeons.json's dungeons (${offered.length} of ${ALL.length})`);
const bare = offered.filter((d) => !enemies(d)).map((d) => d.id);
ok(!bare.length, 'every dungeon offered for a claim has at least one enemy in its data', bare);

// ---- Boreal Stone Cave: the den's own ogre, every claim, every difficulty ----
const BOREAL = ALL.find((d) => d.id === 'CYRBorealStoneCaveLocation');
const OWN = '7cbd9:bsheartland.esm';
const NOVICE = new Set(['5f056:bsheartland.esm', 'd6b7f:bsheartland.esm']);
const atDoor = (d) => { const e = d.entrances[0]; props.set(`${A}|worldOrCellDesc`, e.world); props.set(`${A}|pos`, e.doorPos || e.pos); return idOf(e.outsideDesc); };
const claim = (d, diff) => {
  props.delete(`${A}|private.dungeonCooldowns`); if (globalThis.__dboDungeonAccountRest) globalThis.__dboDungeonAccountRest.clear();
  widgets.length = 0;
  const v = globalThis.__dboDungeonActivate(atDoor(d), A);
  const pend = globalThis.__dboDungeons.pending.get(A);
  if (pend) fire('dungeonClaim', A, [pend.nonce, diff]);
  const lease = globalThis.__dboDungeons.leases.get(d.id);
  if (lease) cmds.get('dungeon')(A, `end ${d.id.toLowerCase()}`);
  return { v, gate: widgets.some((w) => w && w.type === 'dungeonGate'), lease };
};
const picks = { story: new Map(), normal: new Map(), hard: new Map(), nightmare: new Map() };
let none = 0, notBoss = 0, runs = 0;
for (const lvl of [1, 3, 5]) {
  LEVEL = lvl;
  for (const diff of Object.keys(picks)) {
    reseed(`boreal-${lvl}-${diff}`);
    for (let i = 0; i < 25; i++) {
      const r = claim(BOREAL, diff); runs++;
      const zones = r.lease ? r.lease.zones : [];
      if (!zones.length) { none++; continue; }
      for (const z of zones) { const id = norm(descs.get(z.NPC[0].id) || z.NPC[0].id); picks[diff].set(id, (picks[diff].get(id) || 0) + 1); if (!r.lease.bossZones.has(z.Name)) notBoss++; }
    }
  }
}
ok(!!BOREAL && none === 0, `Boreal Stone Cave: every claim has an enemy (${runs} claims, solo, levels 1, 3 and 5, every difficulty; ${none} had none)`, none);
ok(none === 0 && notBoss === 0, '...the den\'s ogre, its boss, never thinned away by a small party\'s count', notBoss);
const story = [...picks.story.keys()], higher = [...new Set([...picks.normal.keys(), ...picks.hard.keys(), ...picks.nightmare.keys()])];
ok(story.length > 0 && story.every((id) => NOVICE.has(id)), 'Novice meets a Novice ogre (CYREncOgre01 or 01a), not the level-32 den ogre', story);
ok(higher.length === 1 && higher[0] === OWN, 'Adept, Expert and Master meet the den\'s own ogre (CYRdunBorealStoneCaveOgre)', higher);
const zone = BOREAL.zones.find((z) => z.npcs.some((n) => n.ref === '7cbd8:BSHeartland.esm'));
ok(!!zone && zone.fill === 'own' && zone.npcs.length === 1 && zone.npcs[0].boss === true, 'the data marks it as fill_empty_rooms.py writes it: an own fill of its disabled placement, a boss', zone);

// ---- sites with nothing living in them: an ordinary door, no claim ----
for (const id of ['CYREchoCaveLocation', 'CYRHjaltisRefugeLocation', 'CYRFrozenGrottoLocation']) {
  const d = ALL.find((x) => x.id === id);
  const r = claim(d, 'story');
  ok(!!d && !cells.has(norm(d.cells[0].desc)) && r.v !== false && !r.gate && !r.lease, `${d ? d.name : id}: its door opens as an ordinary door, no claim offered`, { gate: r.gate, v: r.v, lease: !!r.lease });
}

// ---- a dungeon with enemies is as it was ----
LEVEL = 1; reseed('anga');
const anga = claim(ALL.find((d) => d.id === 'CYRAngaLocation'), 'normal');
ok(anga.gate && anga.lease && anga.lease.zones.length > 5, 'Anga still opens its gate and a claim fills it with enemies', anga.lease ? anga.lease.zones.length : 0);

// ---- the filler keeps it on a rerun ----
const TOOL = fs.readFileSync(path.join(ROOT, 'tools', 'dungeons', 'fill_empty_rooms.py'), 'utf8');
ok(!/len\(d\['cells'\]\) < 2 or/.test(TOOL) && /0x130F7/i.test(TOOL), 'fill_empty_rooms.py fills a one-room dungeon with no enemies from its own placements, and marks Bethesda\'s Boss as a boss');
const ex = (cfg.dungeons || {}).exclude || [];
ok(['CYREchoCaveLocation', 'CYRHjaltisRefugeLocation', 'CYRFrozenGrottoLocation'].every((id) => ex.includes(id)), 'the empty sites are in config dungeons.exclude, which the filler reads too', ex);

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
