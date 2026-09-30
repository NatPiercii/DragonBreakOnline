// Dungeon rooms with no enemies (Road to Alpha: "20 of 86 multi-room dungeons have a room with no enemies"):
// tools/dungeons/fill_empty_rooms.py adds "fill" zones to dungeons.json. This claims Serpent's Trail (inside the Bruma
// lock; its rooms 02 and 03 were empty) through the real dungeons.js and checks the claim now spawns enemies there,
// of the dungeon's own kind, and that the data keeps the rules the filler follows.
//   node tests/dungeon-fill-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ALL = JSON.parse(fs.readFileSync(path.join(ROOT, 'dungeons.json'), 'utf8')).dungeons;
let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 300) : ''}`); if (!ok) failures++; };

// ---- the data -------------------------------------------------------------------------------------------------------
const multi = ALL.filter((d) => d.cells.length >= 2);
const emptyAfter = multi.filter((d) => d.cells.some((c) => !d.zones.some((z) => z.cell.toLowerCase() === c.desc.toLowerCase())));
const fills = ALL.flatMap((d) => d.zones.filter((z) => z.fill).map((z) => ({ d, z })));
check('fill zones exist, each marked with its reason', fills.length > 0 && fills.every(({ z }) => z.fill === 'own' || z.fill === 'family'), fills.map(({ z }) => z.fill));
check('every fill zone sits in one of its own dungeon\'s cells', fills.every(({ d, z }) => d.cells.some((c) => c.desc.toLowerCase() === z.cell.toLowerCase())));
check('a family fill copies the dungeon\'s own ordinary placements (edid and options), never a boss', fills.filter(({ z }) => z.fill === 'family').every(({ d, z }) =>
  z.npcs.every((n) => !/boss/i.test(n.edid) && d.zones.some((oz) => !oz.fill && oz.npcs.some((on) => on.edid === n.edid && JSON.stringify(on.options) === JSON.stringify(n.options))))));
check('every fill zone has an x, y, z pos like every other zone', fills.every(({ z }) => Array.isArray(z.pos) && z.pos.length === 3), fills.map(({ z }) => z.pos).filter((p) => p.length !== 3));
check('2 to 4 enemies per family-filled room', fills.filter(({ z }) => z.fill === 'family').every(({ z }) => z.npcs.length >= 2 && z.npcs.length <= 4));
const left = emptyAfter.flatMap((d) => d.cells.filter((c) => !d.zones.some((z) => z.cell.toLowerCase() === c.desc.toLowerCase())).map((c) => c.edid));
check('the rooms still empty are only templates and orphan cells no door of the dungeon leads into', left.every((e) => /EmptyCell|DUPLICATE|WindhelmPrison01|Hrota|SoulCairn|Irkngthand04/.test(e)), left);
check('a dungeon that can never be claimed (config dungeons.exclude: the Abandoned Prison) is not filled', !ALL.find((d) => d.id === 'AbandonedPrisonLocation').zones.some((z) => z.fill));
const fb = ALL.find((d) => d.id === 'CYRMountainwatchFrostironmine');
check('Frostiron Mine gets its own disabled goblins back, not a stand-in', fb.zones.filter((z) => z.fill === 'own').flatMap((z) => z.npcs).every((n) => /Goblin/.test(n.edid) && n.ref) && fb.zones.some((z) => z.fill === 'own'));
check('no quest actor comes back (the Caller, Miraak, MQ103 soldiers)', !fills.some(({ z }) => z.npcs.some((n) => /Caller|Miraak|MQ103/i.test(n.edid))));

// ---- a claim through the real dungeons.js -----------------------------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-dungeon-fill-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
process.chdir(dir);
for (const f of ['loot.json', 'ayleid-loot.json', 'dungeon-pools.json']) fs.copyFileSync(path.join(ROOT, f), f);
const D = ALL.find((d) => d.id === 'CYRSerpentsTrailLocation');
fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [D] }));
fs.writeFileSync('expeditions.json', JSON.stringify({ expeditions: [] }));
global.setTimeout = () => 0;
let nextId = 0x1000;
const ids = new Map();
const idOf = (d) => { const k = String(d).toLowerCase(); if (!ids.has(k)) ids.set(k, nextId++); return ids.get(k); };
const A = 0x14;
const e0 = D.entrances[0];
const props = new Map([[`${A}|worldOrCellDesc`, e0.world || e0.cell], [`${A}|pos`, e0.doorPos || e0.pos]]);
const ui = new Map();
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'gamemode-config.json'), 'utf8'));
globalThis.__dboDungeons = undefined;
require(path.join(ROOT, 'dungeons.js'))({
  mp: { get: (id, p) => (p === 'profileId' ? (id === A ? 1 : -1) : props.get(`${id}|${p}`)), set: (id, p, v) => props.set(`${id}|${p}`, v), getIdFromDesc: idOf, lookupEspmRecordById: () => ({ record: null }) },
  log: () => {}, personal: () => {}, system: () => {}, audit: () => {}, registerChatCommand: () => {},
  onUi: (n, fn) => { const l = ui.get(n) || []; l.push(fn); ui.set(n, l); }, openWidget: () => true, closeWidget: () => true,
  sendPacket: () => true, findByName: () => 0, display: String, who: String,
  profileOf: (a) => (a === A ? 1 : -1), nameOf: () => 'P', onlineActors: () => [A], isAdmin: () => false,
  giveItem: () => true, cfg: { dungeons: cfg.dungeons || {} }, every: () => {},
});
globalThis.__dboDungeonActivate(idOf(e0.outsideDesc), A);
const pend = globalThis.__dboDungeons.pending.get(A);
(ui.get('dungeonClaim') || []).forEach((f) => f(A, [pend && pend.nonce, 'normal'], 0));
check('Serpent\'s Trail is claimed', !!globalThis.__dboDungeons.leases.get(D.id));
const spawns = JSON.parse(fs.readFileSync('NPC-Spawns.json', 'utf8'));
const zones = (spawns.zones || spawns).filter((z) => String(z.Name).startsWith(`dungeon:${D.id}:`));
const inCell = (edid) => { const c = D.cells.find((x) => x.edid === edid); return zones.filter((z) => String(z.ID).toLowerCase() === c.desc.toLowerCase()); };
check('the claim spawns enemies in room 02, which was empty', inCell('CYRSerpentsTrail02').length >= 1, inCell('CYRSerpentsTrail02').length);
check('...and in room 03, which was empty', inCell('CYRSerpentsTrail03').length >= 1, inCell('CYRSerpentsTrail03').length);
check('the rooms that always had enemies still do', inCell(D.cells.find((c) => !/02|03/.test(c.edid)).edid).length >= 1);
console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
