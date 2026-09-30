// E pressed by a vampire or werewolf on something that is not a fresh corpse (Onny #FLC7, 2026-09-30): the feeding
// check read isDead on every activated tree, door and workbench, which throws in C++ for a non-actor and logged a
// context dump plus a "treat it as Actor" warning each time. Only a fresh corpse (one __dboSuperDeath recorded) may
// have isDead read; everything else is refused before any mp.get on the target. Feeding on a fresh corpse still works.
// Loads the real supernatural.js in a scratch folder.
//   node tests/super-activate-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const SUPER = path.resolve(__dirname, '..', 'supernatural.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'super-activate-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });

const VAMP = 0xff0003f4, HUMAN = 0xff000500, VICTIM = 0xff000501, STALE = 0xff000502;
const TREE = 0x0802d963, BENCH = 0x3c12ae11;
const OBJECTS = new Set([TREE, BENCH]);
const store = new Map(), reads = [], said = [], timers = {};
globalThis.__dboClock = { gameDays: () => 100, sendTo: () => {} };
global.setTimeout = () => 0;
const mp = {
  get: (id, p) => {
    id >>>= 0;
    reads.push([id, p]);
    // The C++: an actor property on an ObjectReference throws (WorldState::GetFormAt<MpActor>)
    if (OBJECTS.has(id) && p !== 'type' && p !== 'pos' && p !== 'worldOrCellDesc' && p !== 'baseDesc') throw new Error(`Form with id ${id.toString(16)} is not Actor`);
    if (p === 'type') return OBJECTS.has(id) ? 'MpObjectReference' : 'MpActor';
    return store.get(`${id}|${p}`);
  },
  set: (id, p, v) => store.set(`${id >>> 0}|${p}`, v),
  getDescFromId: (id) => `${(id >>> 0).toString(16)}:x`,
  getIdFromDesc: () => 0x1234,
  callPapyrusFunction: () => null,
  lookupEspmRecordById: () => null,
};
const api = {
  mp, log: () => {}, audit: () => {}, personal: (a, t) => said.push([a, t]), registerChatCommand: () => {},
  onUi: () => {}, openWidget: () => {}, closeWidget: () => {}, sendPacket: () => {}, display: (a) => `P${a.toString(16)}`, who: String, isAdmin: () => false,
  findByName: () => null, onlineActors: () => [VAMP, HUMAN], every: (k, ms, f) => { timers[k] = f; },
  // Players (the vampire, the human and both corpses) have profiles; the tree and the bench do not
  profileOf: (a) => (OBJECTS.has(a >>> 0) ? -1 : 1), nameOf: String, isWorldspace: () => true, needsFeed: () => {}, hungerOf: () => 0, cfg: {},
};
fs.writeFileSync('supernatural.json', JSON.stringify({ crown: null, revoke: [] }));
store.set(`${VAMP}|private.supernatural`, { kind: 'vampire', pure: false, stage: 3, lastFed: 97, spells: [], disease: null });
store.set(`${HUMAN}|private.supernatural`, { kind: null, disease: null });
delete globalThis.__dboSuperState;
require(SUPER)(api);

let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fail++; };
const act = globalThis.__dboSuperActivate;
const readsOf = (id) => reads.filter(([x]) => x === id >>> 0).map(([, p]) => p);

reads.length = 0;
ok(act(TREE, VAMP) === false, 'a vampire pressing E on a tree is not a feed');
ok(readsOf(TREE).length === 0, 'and nothing is read from the tree (no C++ throw, no context dump)', readsOf(TREE));
reads.length = 0;
ok(act(BENCH, VAMP) === false, 'nor on a workbench');
ok(readsOf(BENCH).length === 0, 'and nothing is read from the workbench', readsOf(BENCH));

reads.length = 0;
ok(act(HUMAN, VAMP) === false, 'a living player is not fed on by E');
ok(!readsOf(HUMAN).includes('isDead'), 'and its isDead is not read either: it never died', readsOf(HUMAN));

// A corpse that died longer ago than corpseFreshMinutes (10) is refused before isDead too
const realNow = Date.now;
store.set(`${STALE}|isDead`, true);
Date.now = () => realNow() - 11 * 60000; globalThis.__dboSuperDeath(STALE, 0); Date.now = realNow;
reads.length = 0;
ok(act(STALE, VAMP) === false, 'a corpse older than ten minutes is refused');
ok(!readsOf(STALE).includes('isDead'), 'without reading isDead', readsOf(STALE));

// A fresh corpse still feeds, once
store.set(`${VICTIM}|isDead`, true);
globalThis.__dboSuperDeath(VICTIM, 0);
said.length = 0; reads.length = 0;
ok(act(VICTIM, VAMP) === true, 'a vampire still feeds on a fresh corpse');
ok(readsOf(VICTIM).includes('isDead'), 'reading its isDead as before');
ok(said.some(([a, t]) => a === VAMP && /drink deep/.test(t)), 'and is told so', said);
ok(act(VICTIM, VAMP) === false, 'but only once per corpse');

// Someone with no curse never reaches any of it
reads.length = 0;
ok(act(VICTIM, HUMAN) === false && !readsOf(VICTIM).includes('isDead'), 'a player with no curse is refused before the corpse is looked at');

console.log(fail ? `${fail} failed` : 'all passed');
process.exit(fail ? 1 : 0);
