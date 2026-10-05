// A forced werewolf change is felt coming (Nate, 5 Oct; #bugs 1556456325079244860): feralWarn.seconds before the
// change the player is told and the screen shakes (dboShake packets, harder each time), and the change happens only if
// they still can change then. Loads the real supernatural.js against a stub api and drives its timers by hand.
// node tests/feral-warning-harness.js   (from server/)
'use strict';
const path = require('path');
const store = new Map();
const said = [], packets = [], logs = [], changes = [];
const cmds = {}, timers = {};
let online = [];
const noop = () => {};
let now = Date.UTC(2026, 9, 5, 3, 0);
Date.now = () => now;
// Timers queued by due time and run by hand
let queue = [];
const realSetTimeout = setTimeout;
globalThis.setTimeout = (fn, ms) => { queue.push({ at: now + (Number(ms) || 0), fn }); return queue.length; };
const advance = (ms) => { const end = now + ms; for (;;) { queue.sort((x, y) => x.at - y.at); const n = queue[0]; if (!n || n.at > end) break; queue.shift(); now = n.at; n.fn(); } now = end; };
globalThis.__dboClock = { gameDays: () => 0, isNight: () => false, isFullMoon: () => false, weatherFor: () => 0 };
const mp = {
  get: (id, p) => store.get(`${id}|${p}`),
  set: (id, p, v) => { store.set(`${id}|${p}`, v); },
  getDescFromId: (id) => `${id.toString(16)}:x`, getIdFromDesc: () => 0x1234,
  callPapyrusFunction: () => null, lookupEspmRecordById: () => null,
};
const api = {
  mp, log: (...x) => logs.push(x.join(' ')), audit: noop, personal: (a, t) => said.push([a, t]), registerChatCommand: (n, f) => { cmds[n] = f; },
  onUi: noop, openWidget: noop, closeWidget: noop, sendPacket: (a, p) => packets.push([a, p]), display: String, who: String,
  isAdmin: () => true, findByName: () => null, onlineActors: () => online, every: (n, ms, fn) => { timers[n] = fn; }, profileOf: (a) => a,
  nameOf: String, isWorldspace: () => true, needsFeed: noop, hungerOf: () => 100, cfg: {},
};
globalThis.__dboBeastTransform = (a, key, forced) => { changes.push([a, key, forced]); store.set(`${a}|private.beast`, { form: key }); return true; };
const MODULE = path.resolve(__dirname, '..', 'supernatural.js');
const load = (cfg) => { api.cfg = cfg || {}; delete require.cache[MODULE]; require(MODULE)(api); };
load();

let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fail++; };
const A = 7;
const shakes = () => packets.filter(([a, p]) => a === A && p.customPacketType === 'dboShake').map(([, p]) => p);
const reset = () => { said.length = 0; packets.length = 0; changes.length = 0; logs.length = 0; queue = []; store.delete(`${A}|private.beast`); globalThis.__dboFeralDue && globalThis.__dboFeralDue.clear(); };
store.set(`${A}|private.supernatural`, { kind: 'werewolf', disease: null, stage: 0, blessed: false });
store.set(`${A}|isDead`, false);
online = [A];
const realRandom = Math.random;
Math.random = () => 0;   // every roll goes feral

// ---- the warning comes first ----
reset();
timers.superFeral();
ok(changes.length === 0, 'a feral roll does not change the werewolf at once');
ok(said.some(([a, t]) => a === A && /The beast is coming\./.test(t)) && packets.some(([a, p]) => a === A && p.customPacketType === 'dboBanner' && /The beast is coming/.test(p.text)), 'the player is told the beast is coming (chat and banner)', said);
ok(shakes().length === 1 && shakes()[0].strength === 0.25 && shakes()[0].seconds === 2, 'the first shake comes with the warning, softly', shakes());
advance(6000);
ok(shakes().length === 2 && shakes()[1].strength === 0.45, 'a harder shake halfway (6 s before)', shakes());
advance(5000);
ok(shakes().length === 3 && shakes()[2].strength === 0.7 && changes.length === 0, 'the hardest a second before the change, still no change', shakes());
timers.superFeral();
ok(shakes().length === 3, 'a second roll while one is coming starts nothing new');
advance(1000);
ok(changes.length === 1 && changes[0][1] === 'werewolf' && changes[0][2] === true, 'the change comes 12 s after the warning, forced', changes);
ok(said.some(([a, t]) => a === A && /beast (tears free|takes you without asking)/.test(t)) && logs.some((l) => /went feral \(hunger 100/.test(l)), 'with the old change line and the old log line');
ok(!globalThis.__dboFeralDue.has(A), 'nothing is left pending');

// ---- it passes when the werewolf can no longer change ----
reset();
timers.superFeral();
store.set(`${A}|isDead`, true);
advance(12000);
ok(changes.length === 0 && logs.some((l) => /forced change passed/.test(l)), 'a werewolf who died in the meantime does not change');
store.set(`${A}|isDead`, false);
reset();
timers.superFeral();
online = [];
advance(12000);
ok(changes.length === 0, 'nor one who logged out');
online = [A];
reset();
timers.superFeral();
store.set(`${A}|private.beast`, { form: 'werewolf' });
advance(12000);
ok(changes.length === 0, 'nor one already in beast form');

// ---- configured ----
reset();
load({ supernatural: { feralWarn: { seconds: 0 } } });
timers.superFeral();
ok(changes.length === 1 && shakes().length === 0, 'feralWarn.seconds 0 changes at once, as before');
reset();
load({ supernatural: { feralWarn: { seconds: 5, shakes: [{ at: 5, strength: 3, seconds: 1 }] } } });
timers.superFeral();
ok(shakes().length === 1 && shakes()[0].strength === 1, 'a shake is held to strength 1', shakes());
advance(5000);
ok(changes.length === 1, 'a configured lead applies (5 s)');

// ---- the full moon's change is warned the same way ----
reset();
load();
globalThis.__dboClock = { gameDays: () => 1, isNight: () => true, isFullMoon: () => true, weatherFor: () => 0 };
timers.superMoon();
ok(changes.length === 0 && said.some(([, t]) => /full moon pulls at your blood/.test(t)) && shakes().length === 1, 'the full moon warns first too');
advance(12000);
ok(changes.length === 1, '...and the change follows');

Math.random = realRandom;
globalThis.setTimeout = realSetTimeout;
console.log(fail ? `${fail} FAILED` : 'all passed');
process.exit(fail ? 1 : 0);
