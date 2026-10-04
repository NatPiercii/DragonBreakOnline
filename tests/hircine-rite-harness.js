// Hircine's rite: surviving the Great Hunt gives Sanies Lupinus, not the beast, and only at huntMarkChance (Nate, 2026-09-26).
// Loads the real supernatural.js against a stub api and runs /rite, /rite confirm and the rite's rounds.
// node tests/hircine-rite-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
// supernatural.js keeps the Blood Crown in supernatural.json in the working directory, and the Embrace below claims it:
// run in a temp dir, or the file lands in whatever tree run-all runs in
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hircine-rite-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
const store = new Map(); // `${id}|${prop}` -> value
const said = [];
const cmds = {}, ui = {}, timers = {};
const online = [];
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
  isAdmin: () => false, findByName: () => null, onlineActors: () => online, every: (n, ms, fn) => { timers[n] = fn; }, profileOf: (a) => a,
  nameOf: String, isWorldspace: () => true, needsFeed: noop, hungerOf: () => 0,
  // The rite's flow and outcomes, not how a strike is judged: legacyDeadly 'allow' lets this client without riteJudge take
  // the deadly rites as before (review LAT-2); tests/rite-client-harness.js checks the 'safe' default.
  cfg: { supernatural: { rite: { legacyDeadly: 'allow' } } },
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

// A rite the player never touched must not kill them: swag, 2026-09-27, the Blood Fever opened a second after
// joining with no cursor and no keyboard, and three silent timeouts killed the character. Driven by firing the
// round timers directly rather than waiting 23 s of real time.
const fireTimeout = () => { const r = globalThis.__dboRites.get(A); if (r && r.timer && r.timer._onTimeout) r.timer._onTimeout(); };
store.set(`${A}|isDead`, false);
// A fever that has had its three game days of play (incubation counts played time since 2026-09-29)
store.set(`${A}|private.supernatural`, { disease: { kind: 'vampire', since: 0, played: 3 } });
globalThis.__dboRites.delete(A);
online.push(A);
globalThis.__dboConnectedAt = new Map([[A, Date.now()]]);   // just joined
timers.superSlow();
ok(!globalThis.__dboRites.has(A), 'a fever that peaks moments after joining does not open the rite yet');
globalThis.__dboConnectedAt = new Map([[A, Date.now() - 600000]]);   // settled in
timers.superSlow();
ok(globalThis.__dboRites.has(A), '...and opens once the player has settled');
for (let i = 0; i < 8 && globalThis.__dboRites.has(A); i++) fireTimeout();
ok(!globalThis.__dboRites.has(A), '...and a Blood Fever nobody touched closes itself');
ok(store.get(`${A}|isDead`) !== true, '...without killing the character who never saw it');
ok(said.some((t) => /moment swims and passes you by/.test(t)), '...telling them it will come again');

// A werewolf does not catch vampirism from a vampire's bite: swag, 2026-09-27, an established werewolf was
// handed the Blood Fever, and surviving it would have overwritten his lycanthropy. The voluntary paths still
// convert. B is a vampire attacker; every roll lands so the only thing that can stop it is the immunity.
const B = 8;
globalThis.__dboRites.delete(A);
const rndImmune = Math.random; Math.random = () => 0;
store.set(`${B}|private.supernatural`, { kind: 'vampire', disease: null, stage: 1 });
store.set(`${A}|private.supernatural`, { kind: 'werewolf', disease: null });
globalThis.__dboSuperHit(B, A);
ok(!state().disease, "a werewolf does not catch a vampire's disease from a bite");

store.set(`${A}|private.supernatural`, { kind: null, disease: null });
globalThis.__dboSuperHit(B, A);
ok(state().disease && state().disease.kind === 'vampire', '...but a mortal still does');

store.set(`${A}|private.supernatural`, { kind: 'vampire', disease: null, stage: 1 });
// A GM cannot give a vampire the other side's disease either (super-cure-paths 4b0b664c): winning its rite would end the
// curse with no black soul gem, so the GM is told to lift the curse first
said.length = 0;
cmds.curse(A, "me infectwerewolf");
ok(!state().disease && state().kind === 'vampire' && said.some((t) => /Lift that curse first/.test(t)), '...and an admin cannot give one the other disease: lift the curse first', said);
Math.random = rndImmune;

console.log(fail ? `${fail} failed` : 'all checks passed');
process.exit(fail ? 1 : 0);
