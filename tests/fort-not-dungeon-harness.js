// Fort Caractacus is not a dungeon (Nate, 1 Oct 2026): the Legion's fort, whose claim spawned its garrison and a prisoner
// for a party to kill (and the prisoner's death gave a Bruma bounty). dungeons.js drops it with Lakeside Retreat before
// anything is built: no gate on its doors, no claim, no spawns, and its containers stay ordinary. A claim running when
// the new code loads keeps its soldiers until it ends, then goes with nothing left behind. Loads the real dungeons.js
// against the real dungeons.json entry of the fort and one ordinary cave.
//   node tests/fort-not-dungeon-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const DUNGEONS = path.join(ROOT, 'dungeons.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-fort-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
global.setTimeout = () => 0;

let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };
const FORT = 'CYRFortCaractacusLocation';
const all = JSON.parse(fs.readFileSync(path.join(ROOT, 'dungeons.json'), 'utf8')).dungeons;
const fort = all.find((d) => d.id === FORT);
const cave = all.find((d) => d.id === 'CYRAngaLocation');
ok(!!fort && !!cave, 'the real dungeons.json still lists the fort (it is generated) and Anga');
fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [fort, cave] }));
const extra = JSON.parse(fs.readFileSync(path.join(ROOT, 'tooling', 'ck-mcp', 'dungeons_extra.json'), 'utf8'));
ok(!extra.cells.includes('CYRFortCaractacus01'), 'the generator\'s hand list no longer adds the fort, so a regeneration leaves it out');

// Descs to ids: each desc gets its own number
const ids = new Map(); let next = 0x01000000;
const idOf = (d) => { const k = String(d).toLowerCase(); if (!ids.has(k)) ids.set(k, next++); return ids.get(k); };
const A = 0x14, PID = 1;
const FORT_CELL = fort.cells[0].desc;
const props = new Map([[`${A}|worldOrCellDesc`, FORT_CELL]]);
// A claim the old code made a few minutes ago, with the garrison spawned
const zone = { Name: `dungeon:${FORT}:0`, npcs: [] };
const lease = { id: FORT, name: 'Fort Caractacus', difficulty: 'normal', leader: PID, members: new Set([PID]), startedAt: Date.now() - 300000,
  endsAt: Date.now() + 3300000, warned: false, lastInsideAt: Date.now(), locked: new Map(), zones: [zone], seenNpcs: new Set(), deadNpcs: new Set(),
  bossZones: new Set(), bossIds: new Set(), stocked: false };
globalThis.__dboDungeons = { leases: new Map([[FORT, lease]]), parties: new Map(), memberOf: new Map(), invites: new Map(), pending: new Map() };
globalThis.__dboDungeonsBooted = true;
fs.writeFileSync('NPC-Spawns.json', JSON.stringify({ zones: [zone, { Name: 'wild:goblin:p1' }] }));

const timers = new Map(), said = [], audits = [], moves = [];
require(DUNGEONS)({
  mp: {
    get: (id, p) => (p === 'profileId' ? (id === A ? PID : -1) : props.get(`${id}|${p}`)),
    set: (id, p, v) => { if (p === 'locationalData') moves.push([id, v]); props.set(`${id}|${p}`, v); },
    getIdFromDesc: idOf, getActorsByProfileId: (p) => (p === PID ? [A] : []),
  },
  log: () => {}, personal: (a, t) => said.push(t), system: (a, t) => said.push(t), audit: (t) => audits.push(t),
  registerChatCommand: () => {}, onUi: () => {}, openWidget: () => true, closeWidget: () => true,
  sendPacket: () => true, findByName: () => 0, display: () => 'P', who: () => 'P',
  profileOf: (a) => (a === A ? PID : -1), nameOf: () => 'P', onlineActors: () => [A],
  isAdmin: () => false, giveItem: () => true, cfg: {}, every: (name, ms, fn) => timers.set(name, fn),
});

// ---- no dungeon any more ----
const cells = globalThis.__dboDungeonCells || new Set();
const norm = (d) => String(d).toLowerCase();
ok(![...cells].some((c) => norm(c) === norm(FORT_CELL)), 'the fort\'s cell is no dungeon cell', [...cells]);
ok([...cells].some((c) => norm(c) === norm(cave.cells[0].desc)), '...while Anga\'s still is');
const door = idOf(fort.entrances[0].outsideDesc);
const v = globalThis.__dboDungeonActivate(door, A);
ok(v !== false, 'the fort\'s doors open as ordinary doors: no claim gate', v);
ok(!said.some((t) => /claim|Fort Caractacus/i.test(t)), '...and nothing is offered or refused', said);

// ---- a claim running at the reload ----
const tick = timers.get('dungeons.tick');
let threw = null; try { tick(); } catch (e) { threw = e.message; }
ok(!threw && globalThis.__dboDungeons.leases.has(FORT), 'a claim made before the change keeps running until it ends (its soldiers stay till then)', threw);
lease.endsAt = Date.now() - 1000;
said.length = 0; moves.length = 0;
try { tick(); } catch (e) { threw = e.message; }
ok(!threw && !globalThis.__dboDungeons.leases.has(FORT), 'when it runs out it ends without an error', threw);
const spawns = JSON.parse(fs.readFileSync('NPC-Spawns.json', 'utf8')).zones.map((z) => z.Name);
ok(!spawns.some((n) => n.startsWith(`dungeon:${FORT}`)) && spawns.includes('wild:goblin:p1'), 'its zones leave NPC-Spawns.json, and other zones stay', spawns);
ok(!moves.length, 'nobody inside is moved out (the fort has no gate to send them to); they walk out of an ordinary fort', moves);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
