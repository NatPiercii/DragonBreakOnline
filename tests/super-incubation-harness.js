// Incubation counts only played time, and a circlet is not head cover (Nate, 2026-09-29). Loads the real
// supernatural.js against a stub api and a stub world clock, and drives its 15 s tick by hand.
// node tests/super-incubation-harness.js   (from server/)
'use strict';
const path = require('path');
const store = new Map(); // `${id}|${prop}` -> value
const said = [];
const cmds = {}, ui = {}, timers = {};
let online = [];
const noop = () => {};
let now = Date.UTC(2026, 8, 29, 12, 0);
Date.now = () => now;
// The world clock: 6 game minutes a real minute, so a game day every 4 real hours
const GAME_DAY_MS = 4 * 3600000;
const clockStart = now;
globalThis.__dboClock = { gameDays: () => (now - clockStart) / GAME_DAY_MS, isNight: () => false, weatherFor: () => 0 };
// Worn gear: a base id -> its BOD2 slot bits
const SLOT = { head: 1 << 0, hair: 1 << 1, body: 1 << 2, circlet: 1 << 12 };
const gear = { 0x500: SLOT.circlet, 0x501: SLOT.hair, 0x502: SLOT.head | SLOT.hair };
const bod2 = (bits) => { const d = new Uint8Array(8); new DataView(d.buffer).setUint32(0, bits, true); return d; };
const mp = {
  get: (id, p) => store.get(`${id}|${p}`),
  set: (id, p, v) => { store.set(`${id}|${p}`, v); },
  getDescFromId: (id) => `${id.toString(16)}:x`, getIdFromDesc: () => 0x1234,
  callPapyrusFunction: () => null,
  lookupEspmRecordById: (id) => (gear[id] ? { record: { fields: [{ type: 'BOD2', data: bod2(gear[id]) }] } } : null),
};
const api = {
  mp, log: noop, audit: noop, personal: (a, t) => said.push(t), registerChatCommand: (n, f) => { cmds[n] = f; },
  onUi: (n, f) => { ui[n] = f; }, openWidget: noop, closeWidget: noop, sendPacket: noop, display: String, who: String,
  isAdmin: () => true, findByName: (n) => (n === 'me' ? A : null), onlineActors: () => online, every: (n, ms, fn) => { timers[n] = fn; }, profileOf: (a) => a,
  nameOf: String, isWorldspace: () => true, needsFeed: noop, hungerOf: () => 0, cfg: {},
};
const MODULE = path.resolve(__dirname, '..', 'supernatural.js');
require(MODULE)(api);

let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fail++; };
const A = 7;
const state = () => store.get(`${A}|private.supernatural`) || {};
const played = () => Number((state().disease || {}).played) || 0;
// Play for a while: one tick every 15 real seconds
const play = (realMs) => { for (let t = 0; t < realMs; t += 15000) { now += 15000; timers.superSlow(); } };
store.set(`${A}|isDead`, false);
globalThis.__dboConnectedAt = new Map([[A, now - 3600000]]);

// ---- incubation counts played time ----
store.set(`${A}|private.supernatural`, { kind: null, disease: null });
cmds.curse(A, 'me infectvampire');
ok(state().disease && state().disease.kind === 'vampire' && played() === 0, 'a new disease starts with no played time', state().disease);
online = [A];
play(3600000);   // an hour online: a quarter of a game day
ok(Math.abs(played() - 0.25) < 0.01, 'an hour online counts a quarter of a game day', played());
online = [];
now += 20 * 3600000;   // logged out for 20 hours: five game days on the world clock
online = [A];
play(15000);
ok(Math.abs(played() - 0.25) < 0.01, 'twenty hours logged out count nothing', played());
ok(!globalThis.__dboRites.has(A), 'and the fever has not peaked, though five world days went by');
// A server restart loses the last tick: the first tick after it counts nothing either
delete globalThis.__dboSuperPlayTicks;
require(MODULE)(api);
now += 3 * 3600000;
play(15000);
ok(Math.abs(played() - 0.25) < 0.01, 'a restart\'s downtime counts nothing', played());
// Dead time does not count
store.set(`${A}|isDead`, true);
play(3600000);
store.set(`${A}|isDead`, false);
play(15000);
ok(Math.abs(played() - 0.25) < 0.01, 'an hour lying dead counts nothing', played());
// Ten more hours of play: 2.75 days, not yet
play(10 * 3600000);
ok(played() > 2.7 && played() < 3 && !globalThis.__dboRites.has(A), 'eleven hours of play: 2.75 game days, the fever has not peaked', played());
play(3600000 + 30000);
ok(played() >= 3 && globalThis.__dboRites.has(A), 'twelve hours of play: three game days, the fever peaks', played());
said.length = 0; cmds.curse(A, 'me status');
ok(said.some((t) => /3\.0 of 3 game days played/.test(t)), '/curse status shows the played days', said);
globalThis.__dboRites.delete(A);
store.set(`${A}|private.supernatural`, { kind: null, disease: { kind: 'werewolf', since: 0, played: 0.5 } });
cmds.curse(A, 'me fever');
ok(played() === 3, 'the admin fever sets the played days to the peak', played());

// ---- a circlet is not head cover ----
store.set(`${A}|private.supernatural`, { kind: 'vampire', stage: 1, disease: null });
store.set(`${A}|worldOrCellDesc`, 'tamriel');
const burn = (baseIds) => {
  store.set(`${A}|equipment`, { inv: { entries: baseIds.map((b) => ({ baseId: b, worn: true })) } });
  store.set(`${A}|percentages`, { health: 1, magicka: 1, stamina: 1 });
  timers.superSun();
  return +(1 - store.get(`${A}|percentages`).health).toFixed(5);
};
const bare = burn([]);
ok(burn([0x500]) === bare, 'a circlet (slot 42) takes none of the sun off', [bare, burn([0x500])]);
ok(burn([0x501]) < bare, 'a hood (slot 31) does', [bare, burn([0x501])]);
ok(burn([0x502]) === burn([0x501]), 'a helmet (30 and 31) counts as the head once, like a hood');
ok(burn([0x500, 0x501]) === burn([0x501]), 'a circlet worn with a hood adds nothing');

console.log(fail ? `${fail} failed` : 'all checks passed');
process.exit(fail ? 1 : 0);
