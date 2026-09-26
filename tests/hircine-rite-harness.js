// Hircine's rite: surviving the Great Hunt gives Sanies Lupinus, not the beast, and only at huntMarkChance (Nate, 2026-09-26).
// Loads the real supernatural.js against a stub api and runs /rite, /rite confirm and the rite's rounds.
// node tests/hircine-rite-harness.js   (from server/)
'use strict';
const path = require('path');
const store = new Map(); // `${id}|${prop}` -> value
const said = [];
const cmds = {}, ui = {};
const noop = () => {};
const mp = {
  get: (id, p) => store.get(`${id}|${p}`),
  set: (id, p, v) => { store.set(`${id}|${p}`, v); },
  getDescFromId: (id) => `${id.toString(16)}:x`, getIdFromDesc: () => 0x1234,
  callPapyrusFunction: () => null, lookupEspmRecordById: () => null,
};
const api = {
  mp, log: noop, audit: noop, personal: (a, t) => said.push(t), registerChatCommand: (n, f) => { cmds[n] = f; },
  onUi: (n, f) => { ui[n] = f; }, openWidget: noop, closeWidget: noop, sendPacket: noop, display: String, who: String,
  isAdmin: () => false, findByName: () => null, onlineActors: () => [], every: noop, profileOf: (a) => a,
  nameOf: String, isWorldspace: () => true, needsFeed: noop, hungerOf: () => 0, cfg: {},
};
require(path.resolve(__dirname, '..', 'supernatural.js'))(api);

let fail = 0;
const ok = (c, what) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}`); if (!c) fail++; };
const A = 7;
const atShrine = (deityId) => { globalThis.__dboPrayerLastShrine = new Map([[A, { deityId, at: Date.now() }]]); };
const state = () => store.get(`${A}|private.supernatural`) || {};
// Every strike lands (win) or misses (lose): widen or move the zone before striking
const runRite = (win) => {
  for (let i = 0; i < 20 && globalThis.__dboRites.has(A); i++) {
    const r = globalThis.__dboRites.get(A);
    r.current.startsAt = Date.now() - 400;
    if (win) r.current.width = 2; else { r.current.width = 0; r.current.center = 5; }
    ui.riteStrike(A, [r.nonce]);
  }
};

atShrine('hircine'); cmds.rite(A, ''); said.length = 0; cmds.rite(A, 'confirm');
ok(globalThis.__dboRites.has(A), 'the Great Hunt starts on /rite confirm');
const rnd0 = Math.random; Math.random = () => 0; // the mark roll lands
runRite(true);
Math.random = rnd0;
ok(!state().kind, 'surviving the Hunt does not make a werewolf');
ok(state().disease && state().disease.kind === 'werewolf', 'surviving the Hunt gives Sanies Lupinus');
ok(said.some((t) => /Sanies Lupinus/.test(t)), 'the player is told about the disease');

said.length = 0; atShrine('hircine'); cmds.rite(A, '');
ok(said.some((t) => /already in your blood/.test(t)), 'a second /rite while diseased is refused');

// Surviving without the mark: nothing caught, and the shrine waits riteFailCooldownHours
store.clear(); said.length = 0; globalThis.__dboRites.clear();
atShrine('hircine'); cmds.rite(A, ''); cmds.rite(A, 'confirm');
const rnd1 = Math.random; Math.random = () => 0.99; // the mark roll misses
runRite(true);
Math.random = rnd1;
ok(!state().kind && !state().disease, 'surviving without the mark gives nothing');
ok(said.some((t) => /unmarked/.test(t)), 'the unmarked survivor is told');
ok(Number(store.get(`${A}|private.riteUnmarkedAt`)) > 0 && !store.get(`${A}|private.riteFailedAt`), 'the unmarked wait starts (not the failure one)');
said.length = 0; atShrine('hircine'); cmds.rite(A, '');
ok(!globalThis.__dboRites.has(A) && !said.some((t) => /Great Hunt/.test(t)), 'an unmarked survivor cannot run the Hunt again straight away');
store.set(`${A}|private.riteUnmarkedAt`, Date.now() - 25 * 3600000);
said.length = 0; atShrine('hircine'); cmds.rite(A, '');
ok(said.some((t) => /Great Hunt/.test(t) && /may mark/.test(t)), 'after the wait the Hunt is offered again, as a chance');

// Molag Bal is unchanged: surviving the Embrace makes a pure-blood at once
store.clear(); said.length = 0; globalThis.__dboRites.clear();
atShrine('molagbal'); cmds.rite(A, ''); cmds.rite(A, 'confirm'); runRite(true);
ok(state().kind === 'vampire' && state().pure === true, 'surviving the Embrace still makes a pure-blood vampire');

// Losing the Hunt still costs as before (no disease, riteFailedAt set)
store.clear(); said.length = 0; globalThis.__dboRites.clear();
const rnd = Math.random; Math.random = () => 0.99; // no permadeath roll
atShrine('hircine'); cmds.rite(A, ''); cmds.rite(A, 'confirm'); runRite(false);
Math.random = rnd;
ok(!state().disease && !state().kind && Number(store.get(`${A}|private.riteFailedAt`)) > 0, 'losing the Hunt gives nothing and starts the cooldown');

console.log(fail ? `${fail} failed` : 'all checks passed');
process.exit(fail ? 1 : 0);
