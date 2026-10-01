// A disconnect mid-rite (a game crash, a dropped connection, Alt-F4) is judged on the rounds played, never a permadeath
// (2026-09-29): behind (more misses than hits) is lost, even or ahead is cancelled, untouched is abandoned. Closing the
// rite window is still a forfeit. Loads the real supernatural.js against a stub api.
// node tests/rite-disconnect-harness.js   (from server/)
'use strict';
const path = require('path');
const store = new Map();
const said = [], logs = [], audits = [];
const cmds = {}, ui = {}, timers = {};
let online = [];
const noop = () => {};
const mp = {
  get: (id, p) => store.get(`${id}|${p}`),
  set: (id, p, v) => { store.set(`${id}|${p}`, v); },
  getDescFromId: (id) => `${id.toString(16)}:x`, getIdFromDesc: () => 0x1234, callPapyrusFunction: () => null, lookupEspmRecordById: () => null,
};
const api = {
  mp, log: (...x) => logs.push(x.join(' ')), audit: (t) => audits.push(t), personal: (a, t) => said.push(t), registerChatCommand: (n, f) => { cmds[n] = f; },
  onUi: (n, f) => { ui[n] = f; }, openWidget: noop, closeWidget: noop, sendPacket: noop, display: String, who: String,
  isAdmin: () => false, findByName: () => null, onlineActors: () => online, every: (n, ms, fn) => { timers[n] = fn; }, profileOf: (a) => a,
  nameOf: String, isWorldspace: () => true, needsFeed: noop, hungerOf: () => 0,
  // The rite's flow and outcomes, not how a strike is judged: legacyDeadly 'allow' lets this client without riteJudge take
  // the deadly rites as before (review LAT-2); tests/rite-client-harness.js checks the 'safe' default.
  cfg: { supernatural: { rite: { legacyDeadly: 'allow' } } },
};
require(path.resolve(__dirname, '..', 'supernatural.js'))(api);

let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fail++; };
const A = 7;
const state = () => store.get(`${A}|private.supernatural`) || {};
const rite = () => globalThis.__dboRites.get(A);
const reset = () => { store.clear(); said.length = 0; logs.length = 0; audits.length = 0; globalThis.__dboRites.clear(); store.set(`${A}|isDead`, false); };
// Every roll lands, so a permadeath roll that ran would always end the character
const rnd = Math.random; Math.random = () => 0;
const startFever = () => {
  reset();
  store.set(`${A}|private.supernatural`, { kind: null, disease: { kind: 'vampire', since: 0, played: 3 } });
  globalThis.__dboConnectedAt = new Map([[A, Date.now() - 600000]]);
  online = [A];
  timers.superSlow();
  online = [];
  return rite();
};
const startEmbrace = () => {
  reset();
  globalThis.__dboPrayerLastShrine = new Map([[A, { deityId: 'molagbal', at: Date.now() }]]);
  cmds.rite(A, ''); cmds.rite(A, 'confirm');
  return rite();
};
const play = (r, hits, misses, acted) => { r.hits = hits; r.misses = misses; r.round = hits + misses; r.acted = acted; };
const leave = () => globalThis.__dboSuperLeave(A);
const dead = () => store.get(`${A}|isDead`) === true;
const permaDead = () => store.get(`${A}|private.permaDead`) === true;
const failedAt = () => Number(store.get(`${A}|private.riteFailedAt`)) || 0;

// ---- the Blood Fever ----
let r = startFever();
ok(!!r && r.type === 'fever_vampire', 'the Blood Fever opens');
play(r, 0, 1, true); leave();
ok(!rite() && dead() && !state().disease && !permaDead(), 'fever, behind: lost (dead, the disease burned out), no permadeath', state());
ok(logs.some((l) => /disconnected from The Blood Fever at 0 hit\(s\), 1 miss\(es\).*behind: counted as lost/.test(l)), '...and logged', logs.filter((l) => /disconnected/.test(l)));
r = startFever(); play(r, 1, 1, true); leave();
ok(!rite() && !dead() && state().disease && state().disease.played >= 3 && !state().kind, 'fever, even: cancelled, alive, the disease still waiting', state());
globalThis.__dboConnectedAt = new Map([[A, Date.now() - 600000]]); online = [A]; timers.superSlow(); online = [];
ok(!!rite(), '...and the fever comes back on a later tick');
r = startFever(); play(r, 2, 0, true); leave();
ok(!rite() && !dead() && state().disease && !state().kind, 'fever, ahead: cancelled, alive, not turned for free', state());
ok(logs.some((l) => /even or ahead: cancelled, the fever will come again/.test(l)), '...and logged');
r = startFever(); play(r, 0, 2, false); leave();
ok(!rite() && !dead() && state().disease, 'fever, never touched: abandoned, not counted', state());

// ---- Molag Bal's Embrace (voluntary, deadly) ----
r = startEmbrace();
ok(!!r && r.type === 'embrace', "Molag Bal's Embrace opens");
play(r, 0, 1, true); leave();
ok(!rite() && dead() && !permaDead() && failedAt() > 0, 'embrace, behind: lost (dead, the shrine waits), and no permadeath though every roll lands', { dead: dead(), perma: permaDead() });
ok(audits.some((t) => /behind: lost \(no permadeath on a disconnect\)/.test(t)), '...and audited');
r = startEmbrace(); play(r, 1, 1, true); leave();
ok(!rite() && !dead() && !permaDead() && failedAt() > 0 && !state().kind, 'embrace, even: cancelled, alive, the shrine waits', { dead: dead(), failedAt: failedAt(), kind: state().kind });
r = startEmbrace(); play(r, 3, 0, true); leave();
ok(!rite() && !dead() && !permaDead() && failedAt() > 0 && !state().kind, 'embrace, ahead: cancelled, alive, the shrine waits, no free turning', { dead: dead(), kind: state().kind });
ok(logs.some((l) => /even or ahead: cancelled, the shrine waits/.test(l)), '...and logged');
r = startEmbrace(); play(r, 0, 0, false); leave();
ok(!rite() && !dead() && !failedAt(), 'embrace, never touched: abandoned, no wait', failedAt());

// ---- closing the rite window on purpose is still a forfeit ----
r = startEmbrace(); play(r, 1, 0, true);
ui.riteClose(A);
ok(!rite() && permaDead(), 'closing the window is still a forfeit, with the permadeath roll (every roll lands here)', { perma: permaDead() });

Math.random = rnd;
console.log(fail ? `${fail} failed` : 'all checks passed');
process.exit(fail ? 1 : 0);
