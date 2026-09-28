// Scripted test for NPC-Spawns.json shared by its writers: loads the real server/dungeons.js and server/placement.js
// against one mock mp in a scratch folder, with a dungeon lease whose zones are in the file, a hand-written zone and a
// wildlife zone, then places, moves and removes NPCs with the Place tool while the lease ends and dungeons.js rewrites
// the file. After every write each module's zones must still be there. No server and no game:
//
//   node tests/zones-shared-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DUNGEONS = path.resolve(__dirname, '..', 'dungeons.js');
const PLACEMENT = path.resolve(__dirname, '..', 'placement.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-zones-shared-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
global.setTimeout = () => 0;

const CELL = '1234:Skyrim.esm';
const WORLD = 'a764b:BSHeartland.esm';
const GM = 0x14;
const N1 = 0xff000100;
fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [{ id: 'TestCave', name: 'Test Cave', type: 'cave', entrances: [], cells: [{ desc: CELL }], chests: [], zones: [] }] }));
fs.writeFileSync('zone-spawns.json', JSON.stringify([N1]));
fs.writeFileSync('admin-placeables.json', JSON.stringify({ categories: [{ id: 'NPCs', label: 'NPCs', kind: 'npc', items: [['1e80e:Dragonborn.esm', 'Bandit', 'Dragonborn.esm']] }] }));
// As the file stands after dungeons.js claimed the lease: its zone beside a hand-written one and a wildlife one
const leaseZone = { Name: 'dungeon:TestCave:0', ID: CELL, POS: [0, 0, 0], Size: 100000, NPC: [{ id: '23a99:Skyrim.esm', count: 1 }], Despawn: 0, Respawn: 0 };
fs.writeFileSync('NPC-Spawns.json', JSON.stringify({ _comment: 'hand', zones: [
  { Name: 'hand:guard', ID: WORLD, POS: [0, 0, 0], NPC: ['23a99:Skyrim.esm 1'] },
  { Name: 'wild:wolf:0', ID: WORLD, POS: [10, 10, 0], NPC: [{ id: '23a99:Skyrim.esm', count: 1 }] },
  leaseZone,
] }));

const props = new Map([[`${N1}|private.npcSpawner`, 'dungeon:TestCave:0'], [`${GM}|worldOrCellDesc`, WORLD], [`${GM}|pos`, [1000, 2000, 300]], [`${GM}|profileId`, 1]]);
const dead = new Set([N1]);
const lease = { id: 'TestCave', name: 'Test Cave', difficulty: 'normal', leader: 1, members: new Set([1]), startedAt: Date.now(), endsAt: Date.now() + 3600000, warned: false, lastInsideAt: Date.now(), locked: new Map(), unlocked: new Set(), looted: new Set(), zones: [leaseZone], totalNpcs: 1, seenNpcs: new Set(), deadNpcs: new Set(), entrance: null, kinds: {}, armed: new Set() };
globalThis.__dboDungeons = { leases: new Map([['TestCave', lease]]), parties: new Map(), memberOf: new Map(), invites: new Map(), pending: new Map() };
globalThis.__dboDungeonsBooted = true;
globalThis.__alduinakNpcGivenUp = () => 0;

const mp = {
  get: (id, p) => (p === 'isDead' ? dead.has(id) : props.get(`${id}|${p}`)),
  set: (id, p, v) => props.set(`${id}|${p}`, v),
  getIdFromDesc: () => 0, getDescFromId: (id) => (id >>> 0).toString(16),
  callPapyrusFunction: () => null, destroyActor: () => {},
};
const timers = new Map();
const ui = {};
const quiet = () => {};
require(DUNGEONS)({
  mp, log: quiet, personal: quiet, system: quiet, audit: quiet, registerChatCommand: quiet, onUi: quiet, openWidget: () => true, closeWidget: () => true,
  sendPacket: () => true, findByName: () => 0, display: () => 'P', who: () => 'P', profileOf: (a) => (a === GM ? 1 : -1), nameOf: () => 'P',
  onlineActors: () => [GM], isAdmin: () => false, giveItem: () => true, cfg: {}, every: (name, ms, fn) => timers.set(name, fn),
});
require(PLACEMENT)({
  mp, log: quiet, personal: quiet, audit: quiet, who: () => 'GM', onUi: (ev, fn) => { ui[ev] = fn; }, sendPacket: () => true,
  isAdmin: (a) => a === GM, tierOf: (a) => (a === GM ? 'senior' : null), registerChatCommand: quiet, cfg: {},
});

let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const file = () => JSON.parse(fs.readFileSync('NPC-Spawns.json', 'utf8'));
const names = () => file().zones.map((z) => z.Name);
const has = (prefix) => names().some((n) => n.startsWith(prefix));
const others = () => has('hand:guard') && has('wild:wolf:0') && file()._comment === 'hand';

ui.placeObject(GM, ['1e80e:Dragonborn.esm', 'npc', [1100, 2000, 300], 0, true]);
check('a placement while a lease runs keeps the lease\'s zone and the others', has('placed:') && has('dungeon:TestCave:0') && others(), names());
const placed = globalThis.__dboPlacement.registry[0];
ui.placeMove(GM, [placed.id, [1200, 2000, 300], [0, 0, 90]]);
check('a move while the lease runs keeps them too', file().zones.find((z) => z.Name === 'placed:' + placed.id).POS[0] === 1200 && has('dungeon:TestCave:0') && others(), names());

// The lease ends (its one enemy is dead): dungeons.js rewrites the file without its zones
timers.get('dungeons.tick')();
check('the lease ended', !globalThis.__dboDungeons.leases.has('TestCave'));
check('dungeons.js took its own zone out and kept the placed NPC and the others', !has('dungeon:') && has('placed:' + placed.id) && others(), names());

// Alternating writers, as a busy evening would have them
for (let i = 0; i < 10; i++) {
  ui.placeObject(GM, ['1e80e:Dragonborn.esm', 'npc', [1000 + i * 50, 2100, 300], 0, false]);
  globalThis.__dboDungeons.leases.set('TestCave', Object.assign({}, lease, { zones: [Object.assign({}, leaseZone, { Name: `dungeon:TestCave:${i}` })] }));
  timers.get('dungeons.tick')();
}
check('after ten rounds of both writers every placement still has its zone', globalThis.__dboPlacement.registry.every((p) => names().includes('placed:' + p.id)) && globalThis.__dboPlacement.registry.length === 11 && others(), names().length);
ui.placeDelete(GM, [placed.id]);
check('a removal takes only its own zone out', !names().includes('placed:' + placed.id) && names().filter((n) => n.startsWith('placed:')).length === 10 && others());
check('no temp file is left behind', !fs.readdirSync('.').some((f) => /\.tmp$/.test(f)), fs.readdirSync('.'));

console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
