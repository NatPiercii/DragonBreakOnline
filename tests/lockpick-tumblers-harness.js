// Tumblers per lock level (lockpick.js tumblersByLevel; Nate, 9 Oct: "higher the lock, more pins you have to do").
// Loads the real module on a mock mp and opens one lock per level under the default, the shipped config and bad values.
//   node tests/lockpick-tumblers-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MODULE = path.join(ROOT, 'lockpick.js');
globalThis.performance = { now: () => 1000 };
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };

const A = 0xff000001, DOOR = 0x0a0001, PICK = 0x0000000a;
const props = new Map();
const mp = { get: (id, k) => props.get(id + '|' + k), set: (id, k, v) => props.set(id + '|' + k, v), getDescFromId: (id) => (id >>> 0).toString(16) };
props.set(A + '|pos', [0, 0, 0]); props.set(DOOR + '|pos', [100, 0, 0]);
let widgets = [];
const load = (lockpick) => {
  delete require.cache[require.resolve(MODULE)];
  delete globalThis.__dboLockpick;
  require(MODULE)({ mp, log: () => {}, personal: () => {}, audit: () => {}, who: () => 'P', display: () => 'P',
    openWidget: (a, w) => { widgets.push(w); return true; }, closeWidget: () => true, onUi: () => {}, cfg: { lockpick: Object.assign({ enabled: true, clientJudged: false }, lockpick) }, hasUiCap: () => false });
};
const countsFor = () => [0, 1, 2, 3, 4].map((level) => {
  props.set(A + '|inventory', { entries: [{ baseId: PICK, count: 5 }] });
  widgets = [];
  globalThis.__dboLockpick.begin(A, { target: DOOR, level, label: 'Chest' });
  const w = widgets[widgets.length - 1];
  globalThis.__dboLockpick.cancel && globalThis.__dboLockpick.cancel(A);
  if (typeof globalThis.__dboLockpick.end === 'function') globalThis.__dboLockpick.end(A);
  return w ? w.holds.length : -1;
});

load({});
ok(JSON.stringify(countsFor()) === '[1,2,3,4,5]', 'by default a lock has one tumbler per level, as before', countsFor());
const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'gamemode-config.json'), 'utf8')).lockpick.tumblersByLevel;
ok(JSON.stringify(shipped) === '[2,3,4,6,8]', 'gamemode-config.json ships 2 / 3 / 4 / 6 / 8', shipped);
load({ tumblersByLevel: shipped });
const n = countsFor();
ok(JSON.stringify(n) === '[2,3,4,6,8]', 'under it a Novice lock has 2 tumblers and a Master lock 8', n);
props.set(A + '|inventory', { entries: [{ baseId: PICK, count: 5 }] }); widgets = [];
globalThis.__dboLockpick.begin(A, { target: DOOR, level: 4, label: 'Chest' });
const w = widgets[widgets.length - 1];
ok(w && w.set.length === 8 && w.set.every((x) => x === false), '...and the widget is told 8 unset tumblers', w && w.set);
load({ tumblersByLevel: [3] });
ok(JSON.stringify(countsFor()) === '[3,3,3,3,3]', 'a shorter list holds its last value', countsFor());
load({ tumblersByLevel: [0, 2.5, 'x', 40, -1] });
ok(JSON.stringify(countsFor()) === '[1,2,3,4,5]', 'a 0, a fraction, text, too many or a negative falls back to one per level', countsFor());
const SRC = fs.readFileSync(MODULE, 'utf8');
ok(!/length: level \+ 1/.test(SRC) && /MG\.pickMinMs\(L\.holds\.length, L\.minPickMs\) : L\.holds\.length \* /.test(SRC), "the client lock's least time counts the lock's own tumblers, not level + 1");
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
