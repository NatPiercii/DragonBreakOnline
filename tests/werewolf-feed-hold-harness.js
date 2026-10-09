// A werewolf feeds through its feeding hold. In beast form the client holds the vanilla PlayerWerewolfFeed perk, whose
// Activate entry replaces E on a body, so no activation reaches __dboSuperActivate and no werewolf feed ever started on
// the live server (127 PlayerWerewolfFeedVictimSpell hits by werewolves 27 Sep - 8 Oct, 0 "started feeding" in beast form,
// every change ended at its first "time up"). The hold does reach gamemode's onSpellHit, which calls
// __dboSuperSpellHit(agg, tgt, spell). Loads the real supernatural.js and greathunt.js against a stub api.
// node tests/werewolf-feed-hold-harness.js   (from server/)
'use strict';
const path = require('path');
const store = new Map();
const timers = new Map();
const noop = () => {};
let now = Date.UTC(2026, 9, 5, 3, 48);
Date.now = () => now;
const WOLF = 7, VAMP = 8, MORTAL = 9;
const BANDIT = 0xff001c44, DEER = 0xff001c48, LIVING = 0xff001c41, FAR = 0xff001c42, OLD = 0xff001c43, EATEN = 0xff001c45;
// Form ids as the load order gives them: Skyrim.esm is index 00, Dawnguard 02
const idOf = (desc) => { const [hex, file] = String(desc).split(':'); const id = parseInt(hex, 16) >>> 0; return /dawnguard/i.test(file || '') ? (0x02000000 | id) >>> 0 : id; };
const FEED_HOLD = idOf('106396:Skyrim.esm');
const NORD = 0x13746, BANDIT_BASE = 0xb1, HUMANOID_KW = 0x13794;
const u32 = (...v) => { const b = new Uint8Array(4 * v.length); const d = new DataView(b.buffer); v.forEach((x, i) => d.setUint32(i * 4, x, true)); return b; };
const records = {
  [BANDIT_BASE]: { fields: [{ type: 'RNAM', data: u32(NORD) }] },
  [NORD]: { fields: [{ type: 'KWDA', data: u32(HUMANOID_KW) }] },
};
const mp = {
  get: (id, p) => store.get(`${id}|${p}`),
  set: (id, p, v) => { store.set(`${id}|${p}`, v); },
  getDescFromId: (id) => `${id.toString(16)}:x`, getIdFromDesc: idOf,
  callPapyrusFunction: () => null,
  lookupEspmRecordById: (id) => (records[id] ? { record: records[id], toGlobalRecordId: (x) => x } : null),
};
const said = [];
const fedMeals = [];
const api = {
  mp, log: noop, audit: noop, personal: (a, t) => said.push({ a, t }), registerChatCommand: noop,
  onUi: noop, openWidget: noop, closeWidget: noop, sendPacket: noop, display: String, who: String,
  isAdmin: () => false, findByName: () => null, onlineActors: () => [WOLF, VAMP, MORTAL], every: (n, ms, f) => timers.set(n, f), profileOf: (a) => (a < 100 ? a : -1),
  nameOf: String, isWorldspace: () => true, needsFeed: (a) => fedMeals.push(a), hungerOf: () => 50, cfg: {},
  zoneOfActor: () => null, zoneById: () => null,
};
for (const f of ['supernatural.js', 'greathunt.js']) { const p = path.resolve(__dirname, '..', f); delete require.cache[p]; }
delete globalThis.__dboGreatHunt;
require(path.resolve(__dirname, '..', 'supernatural.js'))(api);
require(path.resolve(__dirname, '..', 'greathunt.js'))(api);

let fail = 0;
const ok = (c, what, detail) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${detail !== undefined ? '   ' + detail : ''}`); if (!c) fail++; };
const renown = () => (store.get(`${WOLF}|private.greatHunt`) || {}).renown || 0;
const until = () => (store.get(`${WOLF}|private.beast`) || {}).until;
// Each hold comes after the werewolf's 3 s pace unless quick, so every refusal below is for its own reason
const hold = (agg, tgt, quick) => { if (!quick) now += 3001; return globalThis.__dboSuperSpellHit(agg, tgt, FEED_HOLD); };

store.set(`${WOLF}|private.supernatural`, { kind: 'werewolf' });
store.set(`${VAMP}|private.supernatural`, { kind: 'vampire', stage: 2 });
store.set(`${MORTAL}|private.supernatural`, { kind: null });
store.set(`${WOLF}|private.beast`, { form: 'werewolf', original: { raceId: NORD }, at: now, until: now + 150000 });
for (const id of [WOLF, VAMP, MORTAL, BANDIT, DEER, LIVING, OLD, EATEN]) { store.set(`${id}|worldOrCellDesc`, 'fort'); store.set(`${id}|pos`, [0, 0, 0]); }
store.set(`${FAR}|worldOrCellDesc`, 'fort'); store.set(`${FAR}|pos`, [5000, 0, 0]);
store.set(`${BANDIT}|baseDesc`, 'b1:Skyrim.esm');
for (const id of [BANDIT, DEER, FAR, OLD, EATEN]) store.set(`${id}|isDead`, true);
store.set(`${LIVING}|isDead`, false);

globalThis.__dboSuperDeath(OLD, WOLF);
now += 11 * 60000;
store.set(`${WOLF}|private.beast`, { form: 'werewolf', original: { raceId: NORD }, at: now, until: now + 150000 });
for (const t of [BANDIT, DEER, FAR, EATEN]) globalThis.__dboSuperDeath(t, WOLF);
const killed = renown();
ok(killed === 10, 'five kills in beast form earn 2 renown each (unchanged)', killed);

// The live case (Julian, 5 Oct 03:49:31): a bandit slain in beast form, then the feeding hold on its body
const before = until();
hold(WOLF, BANDIT);
ok(fedMeals.length === 1 && fedMeals[0] === WOLF, 'the feeding hold on a fresh body feeds: the hunger eases by a meal', JSON.stringify(fedMeals));
ok(until() === before + 30000, 'and the beast holds a Fledgling 30 s longer', `${(until() - before) / 1000} s`);
ok(renown() === killed + 10, 'and a person is worth 10 renown', renown() - killed);
ok(!!(store.get(`${WOLF}|private.supernatural`) || {}).firstMeal, 'and the first meal is kept for the Werewolf tab');
ok(said.some((s) => s.a === WOLF && /your hunger eases/.test(s.t)), 'and the werewolf is told');

hold(WOLF, BANDIT);
ok(fedMeals.length === 1 && renown() === killed + 10, 'a body is eaten once', `${fedMeals.length} meal(s)`);
hold(WOLF, DEER);
ok(fedMeals.length === 2 && renown() === killed + 15, 'an animal right after it feeds too, for 5 renown', renown() - killed);

// The hold is the client's word: one feed per 3 s per werewolf, and never a player's summon, raised corpse or companion
const SECOND = 0xff001c46, SUMMON = 0xff001c47;
for (const id of [SECOND, SUMMON]) { store.set(`${id}|worldOrCellDesc`, 'fort'); store.set(`${id}|pos`, [0, 0, 0]); store.set(`${id}|isDead`, true); }
store.set(`${SECOND}|baseDesc`, 'b1:Skyrim.esm'); store.set(`${SUMMON}|private.dboCompanion`, 'summon');
for (const id of [SECOND, SUMMON]) globalThis.__dboSuperDeath(id, WOLF);
const m0 = fedMeals.length;
hold(WOLF, SECOND, true);
ok(fedMeals.length === m0, 'a second body within 3 s of a feed waits (a modified client cannot eat every body at once)');
hold(WOLF, SECOND);
ok(fedMeals.length === m0 + 1, 'and is eaten once the 3 s have passed');
hold(WOLF, SUMMON);
ok(fedMeals.length === m0 + 1, "a player's summon is never eaten");
// A GM's raider released into the world keeps its companion tag but is an ordinary enemy: it is eaten; a warband
// follower still with its GM is not
const RAIDER = 0xff001c4a, FOLLOWER = 0xff001c49, FORGED = 0xff001c4b;
for (const id of [RAIDER, FOLLOWER, FORGED]) { store.set(`${id}|worldOrCellDesc`, 'fort'); store.set(`${id}|pos`, [0, 0, 0]); store.set(`${id}|isDead`, true); store.set(`${id}|baseDesc`, 'b1:Skyrim.esm'); store.set(`${id}|private.dboCompanion`, 'companion'); }
const prevWarband = globalThis.__dboWarband;
store.set(`${FORGED}|private.dboCompanion`, 'summon');
globalThis.__dboWarband = { owners: new Map([[RAIDER >>> 0, { released: true, hostile: true }], [FOLLOWER >>> 0, { released: false, hostile: false }], [FORGED >>> 0, { released: true, hostile: true }]]) };
for (const id of [RAIDER, FOLLOWER, FORGED]) globalThis.__dboSuperDeath(id, WOLF);
hold(WOLF, FORGED);
ok(fedMeals.length === m0 + 1, "a player's summon is never eaten, even with a released warband record on its id");
hold(WOLF, FOLLOWER);
ok(fedMeals.length === m0 + 1, "a GM's warband follower still with its GM is not eaten");
hold(WOLF, RAIDER);
ok(fedMeals.length === m0 + 2, 'a raider released into the world is eaten like any enemy');
globalThis.__dboWarband = prevWarband;

const n = fedMeals.length;
hold(WOLF, LIVING);
ok(fedMeals.length === n, 'no feed on someone still alive');
hold(WOLF, FAR);
ok(fedMeals.length === n, 'no feed on a body out of reach');
hold(WOLF, OLD);
ok(fedMeals.length === n, 'no feed on a body dead more than ten minutes');
store.set(`${VAMP}|private.beast`, null);
hold(VAMP, EATEN);
ok(fedMeals.length === n && store.get(`${VAMP}|private.supernatural`).stage === 2, 'a vampire is not fed by the hold');
hold(MORTAL, EATEN);
ok(fedMeals.length === n, 'nor a mortal');
const keep = until();
store.set(`${WOLF}|private.beast`, null);
hold(WOLF, EATEN);
ok(fedMeals.length === n, 'nor the werewolf once back in its own shape');
store.set(`${WOLF}|private.beast`, { form: 'werewolf', original: { raceId: NORD }, at: now, until: keep });

// E on a body (the activation) feeds as before, over the feed's seconds
ok(globalThis.__dboSuperActivate(EATEN, WOLF) === true, 'E on a fresh body still starts a timed feed');
now += 5001; timers.get('superFeed')();
ok(fedMeals.length === n + 1, 'which feeds when it is done', `${fedMeals.length - n}`);

console.log(fail ? `${fail} failure(s)` : 'all passed');
process.exit(fail ? 1 : 0);
