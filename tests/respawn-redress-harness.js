// Waking naked after a death (Onny #FLC7, bug-tracker 2026-09-30 00:00: "every time i die, i spawn in naked").
// Evidence: every naked login followed a death while logged out (Falcius 02:32, Purr 04:44, Onny 16:20 and 23:56). The
// engine's respawn left nothing worn on the stored body, so the client came in naked; Onny's first equipment report
// came 23 s after his character loaded, outside the 15 s login window, so it counted as undressing by hand and the
// 12 s fallback had already passed. Part 1 lifts gamemode.js's real redress() and equipment hook and runs them
// against a stub mp; part 2 loads downed.js and checks that every way of waking at the temple asks for a re-dress.
//   node tests/respawn-redress-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fail++; };
let now = 1790000000000;
Date.now = () => now;
const pending = [];
const runPending = () => { while (pending.length) pending.shift()(); };

// ---- part 1: the login re-dress, lifted from gamemode.js ----
const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const cut = (from, to) => { const i = src.indexOf(from); const j = src.indexOf(to, i); if (i < 0 || j < 0) throw new Error(`gamemode.js: ${from} not found`); return src.slice(i, j + to.length); };
const redressSrc = cut('const redress = (a) => {', '\n};\n');
const equipSrc = cut('const wornOf = (equipment) =>', '\nequipHook.__dbo = true;');
const props = new Map(), equips = [];
const mp = {
  get: (id, k) => props.get(`${id}|${k}`), set: (id, k, v) => props.set(`${id}|${k}`, v),
  getDescFromId: (id) => (id >>> 0).toString(16),
  callPapyrusFunction: (kind, cls, fn, self, args) => { if (fn === 'EquipItem') equips.push(parseInt(args[0].desc, 16)); },
};
const G = {};
const { equipHook, connectedAt } = new Function('globalThis', 'mp', 'log', 'display', 'recordOf', 'cfg', 'armourSwap', 'creationPending', 'setTimeout',
  `${equipSrc.replace(/\nequipHook\.__dbo = true;$/, '')}\n${redressSrc}\nreturn { equipHook, connectedAt };`)(
  G, mp, () => {}, String, () => null, {}, null, () => false, (fn) => pending.push(fn));
const ONNY = 0xff0003f4, BOOTS = 0xfe00c903, TUNIC = 0xfe00c90a, SWORD = 0x12eb7;
const inv = (ids) => ({ entries: ids.map((baseId) => ({ baseId, count: 1 })) });
const report = (ids) => ({ inv: { entries: [BOOTS, TUNIC, SWORD].map((baseId) => ({ baseId, count: 1, worn: ids.includes(baseId) })) }, numChanges: 1 });
const login = () => { connectedAt.set(ONNY, now); };

// Onny, 23:57: saved outfit on record, the body respawned with nothing worn, the first report 23 s after loading
props.set(`${ONNY}|private.lastWorn`, [[BOOTS, 0], [TUNIC, 0]]);
props.set(`${ONNY}|inventory`, inv([BOOTS, TUNIC, SWORD]));
props.set(`${ONNY}|equipment`, report([]));
login();
now += 23000;
equipHook(ONNY, report([]), true); runPending();
ok(equips.length === 2 && equips.includes(BOOTS) && equips.includes(TUNIC), 'a naked first report 23 s after loading still re-dresses from the saved outfit', equips.map((x) => x.toString(16)));
ok(JSON.stringify(props.get(`${ONNY}|private.lastWorn`)) === JSON.stringify([[BOOTS, 0], [TUNIC, 0]]), 'and does not overwrite the saved outfit');

// Later in the session, undressing by hand is left alone and remembered as it is
equips.length = 0; now += 60000;
equipHook(ONNY, report([TUNIC]), true);
ok(JSON.stringify(props.get(`${ONNY}|private.lastWorn`)) === JSON.stringify([[TUNIC, 0]]), 'a later change of clothes is remembered');
now += 5000;
equipHook(ONNY, report([]), true); runPending();
ok(equips.length === 0, 'undressing by hand later in the session is not undone');

// A new session starts over: its first report is the login's again
equips.length = 0;
props.set(`${ONNY}|private.lastWorn`, [[BOOTS, 0], [TUNIC, 0]]);
props.set(`${ONNY}|equipment`, report([]));
now += 3600000; login(); now += 40000;
equipHook(ONNY, report([]), true); runPending();
ok(equips.length === 2, 'the next login is dressed again, even 40 s after loading', equips.length);
// A quick loader inside the old window is dressed as before
equips.length = 0; now += 3600000; login(); now += 3000;
equipHook(ONNY, report([]), true); runPending();
ok(equips.length === 2, 'a naked report 3 s after loading re-dresses as before');
// A dressed first report needs nothing, and redress() leaves a dressed player alone
equips.length = 0; now += 3600000; login(); now += 30000;
props.set(`${ONNY}|equipment`, report([BOOTS, TUNIC]));
equipHook(ONNY, report([BOOTS, TUNIC]), true); runPending();
ok(equips.length === 0, 'a login that comes in dressed is not re-dressed');

// Onny #HFVA, 2-3 Oct (14 sessions): a slow login reports the outfit first, then nothing worn 3 s later
equips.length = 0; now += 3600000; login(); now += 43000;
props.set(`${ONNY}|private.lastWorn`, [[BOOTS, 0], [TUNIC, 0]]);
props.set(`${ONNY}|equipment`, report([BOOTS, TUNIC]));
equipHook(ONNY, report([BOOTS, TUNIC]), true); runPending();
ok(equips.length === 0, 'a dressed first report 43 s after loading needs nothing yet');
now += 3000;
props.set(`${ONNY}|equipment`, report([]));
equipHook(ONNY, report([]), true); runPending();
ok(equips.length === 2 && equips.includes(BOOTS) && equips.includes(TUNIC), '...and the naked report 3 s after it re-dresses from the saved outfit', equips.map((x) => x.toString(16)));
ok(JSON.stringify(props.get(`${ONNY}|private.lastWorn`)) === JSON.stringify([[BOOTS, 0], [TUNIC, 0]]), '...the saved outfit is untouched by the burst');
equips.length = 0; now += 15000;
equipHook(ONNY, report([]), true); runPending();
ok(equips.length === 0, 'undressing by hand once the burst is over is still left alone');

// ---- part 2: waking at the temple asks for the re-dress (downed.js) ----
const dprops = new Map();
const dset = (id, k, v) => dprops.set(`${id}|${k}`, v), dget = (id, k) => dprops.get(`${id}|${k}`);
const P = 0xff000001, OFF = 0xff000002, WOLF = 0xff0000aa;
for (const [a, prof] of [[P, 1], [OFF, 2]]) {
  dset(a, 'profileId', prof); dset(a, 'isDead', false); dset(a, 'percentages', { health: 1, stamina: 1, magicka: 1 });
  dset(a, 'pos', [0, 0, 0]); dset(a, 'worldOrCellDesc', 'a764b:BSHeartland.esm'); dset(a, 'angle', [0, 0, 0]);
  dset(a, 'spawnPoint', { cellOrWorldDesc: 'temple', pos: [1, 2, 3], rot: [0, 0, 0] });
}
dset(WOLF, 'profileId', -1);
const dmp = {
  get: (id, k) => { const v = dget(id, k); if (v === undefined && k === 'private.permaDead') return false; return v; },
  set: dset, getIdFromDesc: (d) => parseInt(d, 16), getDescFromId: (id) => (id >>> 0).toString(16), callPapyrusFunction: () => true,
  onHitDamageAttempt: () => true, onHitDamage: () => undefined, onDeath: () => undefined, onSpellHit: () => undefined, onSpellCast: () => undefined,
};
const timers = {}, ui = {}, dressed = [];
let online = [P, OFF];
global.setTimeout = (fn) => { pending.push(fn); return 0; };
globalThis.__dboDownedState = undefined; globalThis.__dboDownedTimersSent = undefined;
require(path.resolve(__dirname, '..', 'downed.js'))({
  mp: dmp, log: () => {}, personal: () => {}, sendPacket: () => true, audit: () => {}, who: String, display: String,
  profileOf: (a) => Number(dget(a, 'profileId')), nameOf: String, onlineActors: () => online,
  every: (n, ms, fn) => { timers[n] = fn; }, registerChatCommand: () => {}, cfg: { downed: { giveUpAfterSeconds: 0 } },
  openWidget: () => true, closeWidget: () => {}, onUi: (n, fn) => { ui[n] = fn; }, redress: (a) => dressed.push(a),
});
const die = (a) => { dset(a, 'isDead', true); dmp.onDeath(a, WOLF); };
die(P); now += 61000; dset(P, 'isDead', false); timers.downedPanel(); runPending();
ok(dressed.includes(P), 'the engine respawn at the end of the bleed-out re-dresses the player', dressed);
dressed.length = 0; die(P); now += 20000; ui.uiCaps && ui.uiCaps(P, ['downed']);
dset(P, 'isDead', true); globalThis.__dboDownedState && null;
// Give up goes through toTemple
const giveUp = () => { const d = globalThis.__dboDownedState && globalThis.__dboDownedState.downed && globalThis.__dboDownedState.downed.get(P); return d; };
now += 1000;
if (ui.downedGiveUp) { const d = giveUp(); ui.downedGiveUp(P, [d && d.nonce]); runPending(); }
ok(dressed.includes(P), 'giving up at the temple re-dresses the player', dressed);
dressed.length = 0; online = [P]; die(OFF); now += 61000; dset(OFF, 'isDead', false); timers.downedPanel(); runPending();
ok(!dressed.includes(OFF), 'a body that respawns while its player is logged out is left for the login to dress');

console.log(fail ? `${fail} failed` : 'all checks passed');
process.exit(fail ? 1 : 0);
