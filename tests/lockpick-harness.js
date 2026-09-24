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

Math.random = realRandom;
console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
