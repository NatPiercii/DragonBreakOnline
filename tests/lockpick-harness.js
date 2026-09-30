// Scripted test for server\lockpick.js (Oblivion-style tumblers). No server and no game: run it from this folder's parent with
//
//   node tests\lockpick-harness.js
//
// It loads the module against a mock mp with a fixed random source and plays locks by sending the widget's reports.
'use strict';
const path = require('path');

const MODULE = path.resolve(__dirname, '..', 'lockpick.js');
const A = 0xff000001, DOOR = 0x0a0001, PICK = 0x0000000a;
const props = new Map();
const set = (id, k, v) => props.set(id + '|' + k, v);
const get = (id, k) => props.get(id + '|' + k);
const mp = { get, set, getDescFromId: (id) => (id >>> 0).toString(16) };
let widgets = [];
const ui = {};
const audits = [];
const events = [];
globalThis.__alduinakMasteryEvent = (k, a, d) => events.push([k, a, d]);
const load = (cfg) => {
  delete require.cache[require.resolve(MODULE)];
  delete globalThis.__dboLockpick;
  require(MODULE)({
    mp, log: () => {}, personal: () => {}, audit: (t) => audits.push(t), who: () => 'P',
    openWidget: (a, w) => { widgets.push(w); return true; }, closeWidget: () => true,
    onUi: (ev, fn) => { ui[ev] = fn; }, cfg,
  });
};
const picks = (n) => set(A, 'inventory', { entries: [{ baseId: PICK, count: n }] });
const pickCount = () => ((get(A, 'inventory') || {}).entries || []).reduce((n, e) => n + (e.baseId === PICK ? e.count : 0), 0);
set(A, 'pos', [0, 0, 0]); set(DOOR, 'pos', [100, 0, 0]);
const last = () => widgets[widgets.length - 1];

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };

load({});
check('off by default, so old clients keep the dice roll', globalThis.__dboLockpick === null);

// A report's hold is capped by the time the server saw pass, so the scripted plays below run on a clock that moves two
// seconds each time it is read; the timing checks at the end set their own
let autoClock = 1_000_000;
Date.now = () => (autoClock += 2000);
const realRandom = Math.random;
let roll = 0.5;
Math.random = () => roll;
load({ lockpick: { enabled: true } });
check('on when switched on', !!globalThis.__dboLockpick);

picks(0);
check('no lockpick, no lock', globalThis.__dboLockpick.begin(A, { target: DOOR, level: 2, label: 'Cell door' }) === false);

picks(3);
let opened = 0;
widgets = [];
globalThis.__dboLockpick.begin(A, { target: DOOR, level: 2, label: 'Cell door', onSuccess: () => { opened++; } });
let w = last();
check('an Adept lock has three tumblers', w.holds.length === 3 && w.set.every((x) => x === false), JSON.stringify(w.holds));
check('a non-Lockpicker gets the base hang time', w.holds[0] === 560 + 0 - 180, w.holds[0]);
check('it is busy while open', globalThis.__dboLockpick.busy(A));

const nonce = w.nonce;
const land = (i) => ui.lockpickTry(A, [nonce, i, 1000, 1000 + w.riseMs + 50]);
ui.lockpickTry(A, [nonce, 1, 1000, 1500]);
check('only the first loose tumbler can be set', last() === w);
land(0);
w = last();
check('a set inside the hang holds the tumbler', w.set[0] === true && w.set[1] === false);

roll = 0.9; // no snap
ui.lockpickTry(A, [nonce, 1, 1000, 1100]);
w = last();
check('too early is a miss, and the pick holds when the roll allows', /pick holds/.test(w.notice) && w.set[0] === true && pickCount() === 3 && !w.done);

roll = 0.1; // snap
ui.lockpickTry(A, [nonce, 1, 1000, 1000 + w.riseMs + w.holds[1] + 500]);
w = last();
check('a snapped pick costs a lockpick and drops the tumblers', pickCount() === 2 && w.set.every((x) => x === false) && /snaps/.test(w.notice) && !w.done);

roll = 0.5;
land(0); w = last(); land(1); w = last(); land(2); w = last();
check('three good sets open the lock', w.done && w.noticeKind === 'win' && opened === 1 && !globalThis.__dboLockpick.busy(A));
check('the Lockpicking skill hears about it', events.some((e) => e[0] === 'lock' && e[2].level === 2) && /picked an Adept cell door/.test(audits[audits.length - 1]));

// the last pick
picks(1);
roll = 0.1;
globalThis.__dboLockpick.begin(A, { target: DOOR, level: 0, label: 'Chest' });
w = last();
ui.lockpickTry(A, [w.nonce, 0, 1000, 1001]);
check('snapping the last pick ends the lock', last().done && last().noticeKind === 'fail' && !globalThis.__dboLockpick.busy(A));

// walking away
picks(2);
roll = 0.5;
globalThis.__dboLockpick.begin(A, { target: DOOR, level: 0, label: 'Chest' });
w = last();
set(A, 'pos', [2000, 0, 0]);
ui.lockpickTry(A, [w.nonce, 0, 1000, 1000 + w.riseMs + 20]);
check('stepping away ends it', last().done && /stepped away/.test(last().notice));
set(A, 'pos', [0, 0, 0]);

// a skilled picker
set(A, 'private.mastery', { order: ['lockpicking'], skills: { lockpicking: { rank: 4 } } });
globalThis.__dboLockpick.begin(A, { target: DOOR, level: 4, label: 'Chest' });
w = last();
check('a Master picker on a Master lock: five tumblers, longer hangs', w.holds.length === 5 && w.holds[0] === 560 + 90 * 5 - 360, w.holds[0]);
ui.lockpickCancel(A, [w.nonce]);
check('leaving ends it', !globalThis.__dboLockpick.busy(A));
set(A, 'private.mastery', null);

// a lock whose client went away (crash, relog) never sends Escape: it must not keep the player busy until a restart
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
picks(2);
globalThis.__dboLockpick.begin(A, { target: DOOR, level: 1, label: 'Cell door' });
w = last();
clock += 30000;
check('a lock in play for half a minute still keeps the player busy', globalThis.__dboLockpick.busy(A));
ui.lockpickTry(A, [w.nonce, 0, 1000, 1000 + w.riseMs + 20]);
clock += 45000;
check('a try counts as touching it, so a slow picker is not cut off', globalThis.__dboLockpick.busy(A));
clock += 61000;
check('a lock left a minute with no try is abandoned: the player can pick again', !globalThis.__dboLockpick.busy(A));
check('...and a new lock opens for them', globalThis.__dboLockpick.begin(A, { target: DOOR, level: 0, label: 'Chest' }) === true && last().nonce !== w.nonce);
ui.lockpickCancel(A, [last().nonce]);
Date.now = realNow;

// the pick has to stay in hand: losing the last one mid-lock (dropped, traded, stolen) ends the lock
picks(1);
roll = 0.1; // every mistimed set would snap a pick if there were one
let won = 0;
globalThis.__dboLockpick.begin(A, { target: DOOR, level: 2, label: 'Cell door', onSuccess: () => { won++; } });
w = last();
ui.lockpickTry(A, [w.nonce, 0, 1000, 1000 + w.riseMs + 20]);
check('a first tumbler set with the pick in hand', last().set[0] === true);
picks(0);
ui.lockpickTry(A, [w.nonce, 1, 1000, 1001]);
check('with no pick left a miss does not leave the set tumblers standing', last().done && last().noticeKind === 'fail' && !globalThis.__dboLockpick.busy(A), JSON.stringify({ set: last().set, notice: last().notice }));
ui.lockpickTry(A, [w.nonce, 1, 1000, 1000 + w.riseMs + 20]);
ui.lockpickTry(A, [w.nonce, 2, 1000, 1000 + w.riseMs + 20]);
check('...and the lock cannot then be finished without a pick', won === 0);

// ---- the hold is measured against the server's own clock (2026-09-30) ----
let t = 5_000_000;
Date.now = () => t;
roll = 0.99;                                   // a mistimed set never snaps here, so only the timing decides
const timed = (level) => {
  picks(5); widgets = []; let n = 0;
  globalThis.__dboLockpick.begin(A, { target: DOOR, level, label: 'Cell door', onSuccess: () => { n++; } });
  return { w: last(), won: () => n };
};
let L2 = timed(4);
for (let i = 0; i < 5; i++) ui.lockpickTry(A, [L2.w.nonce, i, 0, L2.w.riseMs + 20]);
check('a report of a perfect hold with no time passed sets nothing', L2.won() === 0 && last().set.every((x) => !x), JSON.stringify(last().set));
check('...and costs nothing when the roll spares the pick', pickCount() === 5, pickCount());
widgets = [];
t += 60_001; globalThis.__dboLockpick.busy(A);
L2 = timed(4);
for (let i = 0; i < 5; i++) { t += L2.w.riseMs + 20; ui.lockpickTry(A, [L2.w.nonce, i, 0, L2.w.riseMs + 20]); }
check('the same holds with the time really passing open a Master lock', L2.won() === 1, JSON.stringify(last().set));
t += 60_001; globalThis.__dboLockpick.busy(A);
L2 = timed(4);
for (let i = 0; i < 5; i++) { t += L2.w.riseMs + 20 - 140; ui.lockpickTry(A, [L2.w.nonce, i, 0, L2.w.riseMs + 20]); }
check('packets arriving up to 140 ms closer together than the holds (network jitter) still count', L2.won() === 1, JSON.stringify(last().set));
t += 60_001; globalThis.__dboLockpick.busy(A);
L2 = timed(0);
t += 100; ui.lockpickTry(A, [L2.w.nonce, 0, 0, L2.w.riseMs + 20]);
check('a hold reported 370 ms longer than the server saw is a miss', L2.won() === 0 && !last().set[0], JSON.stringify(last().set));
t += 60_001; globalThis.__dboLockpick.busy(A);
L2 = timed(0);
t += 30_000; ui.lockpickTry(A, [L2.w.nonce, 0, 0, L2.w.riseMs + 20]);
check('a player who waits before pushing is not held to the wait: only the hold is judged', L2.won() === 1);
t += 60_001; globalThis.__dboLockpick.busy(A);
L2 = timed(0);
t += 5000; ui.lockpickTry(A, [L2.w.nonce, 0, 0, 1]);
check('a hold that really was too short is still a miss', L2.won() === 0);

Math.random = realRandom;
console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
