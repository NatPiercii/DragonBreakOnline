// Scripted test for when a dungeon lease counts as cleared: loads the real server\dungeons.js with a mock gamemode
// api and one lease, and checks that slots the spawn system has given up (globalThis.__alduinakNpcGivenUp) no longer
// hold it open. No server and no game: run it from this folder's parent with
//
//   node tests\dungeon-clear-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DUNGEONS = path.resolve(__dirname, '..', 'dungeons.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-dungeon-clear-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
global.setTimeout = () => 0;

const CELL = '1234:Skyrim.esm';
const A = 0x14;
const N1 = 0xff000100, N2 = 0xff000101;
fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [{ id: 'TestCave', name: 'Test Cave', type: 'cave', entrances: [], cells: [{ desc: CELL }], chests: [], zones: [] }] }));
fs.writeFileSync('zone-spawns.json', JSON.stringify([N1, N2]));
const props = new Map([[`${N1}|private.npcSpawner`, 'dungeon:TestCave:0'], [`${N2}|private.npcSpawner`, 'dungeon:TestCave:1'], [`${A}|worldOrCellDesc`, CELL]]);
const dead = new Set([N1, N2]);

const lease = { id: 'TestCave', name: 'Test Cave', difficulty: 'normal', leader: 1, members: new Set([1]), startedAt: Date.now(), endsAt: Date.now() + 3600000, warned: false, lastInsideAt: Date.now(), locked: new Map(), unlocked: new Set(), looted: new Set(), zones: [], totalNpcs: 3, seenNpcs: new Set(), deadNpcs: new Set(), entrance: null, kinds: {}, armed: new Set() };
globalThis.__dboDungeons = { leases: new Map([['TestCave', lease]]), parties: new Map(), memberOf: new Map(), invites: new Map(), pending: new Map() };
globalThis.__dboDungeonsBooted = true;

const timers = new Map();
const audits = [];
const said = [];
const commands = new Map();
require(DUNGEONS)({
  mp: {
    get: (id, p) => (p === 'profileId' ? (id === A ? 1 : -1) : p === 'isDead' ? dead.has(id) : props.get(`${id}|${p}`)),
    set: (id, p, v) => props.set(`${id}|${p}`, v), getIdFromDesc: () => 0,
  },
  log: () => {}, personal: (a, t) => said.push(t), system: (a, t) => said.push(t), audit: (t) => audits.push(t),
  registerChatCommand: (n, fn) => commands.set(n, fn), onUi: () => {}, openWidget: () => true, closeWidget: () => true,
  sendPacket: () => true, findByName: () => 0, display: () => 'P', who: () => 'P',
  profileOf: (a) => (a === A ? 1 : -1), nameOf: () => 'P', onlineActors: () => [A],
  isAdmin: () => false, giveItem: () => true, cfg: {}, every: (name, ms, fn) => timers.set(name, fn),
});

let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const tick = timers.get('dungeons.tick');
check('the lease tick is registered', typeof tick === 'function');

// Three enemies, two placed and killed, the third slot given up by the spawn system
delete globalThis.__alduinakNpcGivenUp;
tick();
check('without the spawn system hook the lease stays open (two of three seen)', globalThis.__dboDungeons.leases.has('TestCave') && lease.seenNpcs.size === 2);
globalThis.__alduinakNpcGivenUp = () => { throw new Error('boom'); };
tick();
check('a failing hook counts nothing given up', globalThis.__dboDungeons.leases.has('TestCave'));
let asked = '';
globalThis.__alduinakNpcGivenUp = (prefix) => { asked = prefix; return 1; };
commands.get('dungeon') && commands.get('dungeon')(A, '');
check('the status line counts only the enemies left to clear', said.some((t) => /Enemies 2\/2 down/.test(t)), said.filter((t) => /Enemies/.test(t)));
tick();
check('the hook is asked about this dungeon only', asked === 'dungeon:TestCave:', asked);
check('with the given-up slot left out, two dead of two clears the lease', !globalThis.__dboDungeons.leases.has('TestCave'));
check('...and it is released as cleared', audits.some((t) => /Test Cave released \(cleared\)/.test(t)), audits);

console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
