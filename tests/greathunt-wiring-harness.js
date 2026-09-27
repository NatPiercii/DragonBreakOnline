// The Great Hunt wired into the real supernatural.js: a kill in beast form earns renown, a werewolf in beast form feeds on
// a fresh animal (the feed time comes from its rank, the renown from the Hunt), a vampire still feeds only on people,
// and the changes a day follow the rank. Loads supernatural.js and greathunt.js against a stub api.
// node tests/greathunt-wiring-harness.js   (from server/)
'use strict';
const path = require('path');
const store = new Map();
const noop = () => {};
let now = Date.UTC(2026, 8, 27, 12, 0);
Date.now = () => now;
const WOLF = 7, VAMP = 8, DEER = 500;
const mp = {
  get: (id, p) => store.get(`${id}|${p}`),
  set: (id, p, v) => { store.set(`${id}|${p}`, v); },
  getDescFromId: (id) => `${id.toString(16)}:x`, getIdFromDesc: () => 0x1234,
  callPapyrusFunction: () => null, lookupEspmRecordById: () => null,
};
const said = [];
const api = {
  mp, log: noop, audit: noop, personal: (a, t) => said.push({ a, t }), registerChatCommand: noop,
  onUi: noop, openWidget: noop, closeWidget: noop, sendPacket: noop, display: String, who: String,
  isAdmin: () => false, findByName: () => null, onlineActors: () => [WOLF, VAMP], every: noop, profileOf: (a) => (a < 100 ? a : -1),
  nameOf: String, isWorldspace: () => true, needsFeed: noop, hungerOf: () => 0, cfg: {},
  zoneOfActor: () => null, zoneById: () => null,
};
for (const f of ['supernatural.js', 'greathunt.js']) { const p = path.resolve(__dirname, '..', f); delete require.cache[p]; }
delete globalThis.__dboGreatHunt;
require(path.resolve(__dirname, '..', 'supernatural.js'))(api);
require(path.resolve(__dirname, '..', 'greathunt.js'))(api);

let fail = 0;
const ok = (c, what, detail) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${detail !== undefined ? '   ' + detail : ''}`); if (!c) fail++; };
const renown = () => (store.get(`${WOLF}|private.greatHunt`) || {}).renown || 0;

store.set(`${WOLF}|private.supernatural`, { kind: 'werewolf' });
store.set(`${VAMP}|private.supernatural`, { kind: 'vampire', stage: 2 });
store.set(`${WOLF}|private.beast`, { form: 'werewolf', until: now + 60000 });
store.set(`${DEER}|isDead`, true);

globalThis.__dboSuperDeath(DEER, WOLF);
ok(renown() === 2, 'a kill in beast form earns renown through supernatural.js', renown());
ok(globalThis.__dboSuperActivate(DEER, VAMP) === false, 'a vampire still feeds only on people');
ok(globalThis.__dboSuperActivate(DEER, WOLF) === true, 'a werewolf in beast form feeds on a fresh animal');
ok(renown() === 7, 'which earns 5 renown', renown());
ok(store.get(`${WOLF}|private.beast`).until === now + 60000 + 30000, 'and holds the beast a Fledgling\'s 30 s longer');
ok(globalThis.__dboSuperActivate(DEER, WOLF) === false, 'a corpse is eaten once');

store.set(`${WOLF}|private.greatHunt`, { renown: 300, fedOn: {} });
store.set(`${WOLF}|private.beast`, null);
globalThis.__dboClock = { gameDays: () => 10.5, summary: () => ({ timeScale: 6 }) };
ok(globalThis.__dboBeastAllow(WOLF, 'werewolf', false) === null && globalThis.__dboBeastAllow(WOLF, 'werewolf', false) === null, 'a Hunter changes twice a game day');
ok(typeof globalThis.__dboBeastAllow(WOLF, 'werewolf', false) === 'string', 'and not a third time');

console.log(fail ? `${fail} failure(s)` : 'all passed');
process.exit(fail ? 1 : 0);
