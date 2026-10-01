'use strict';
// node tests/revert-gm-gift-1001-harness.js: the one-off take-back of GM Jake's 1 Oct admin-panel gift (revert-gm-gift-1001.js)
const path = require('path');

let pass = 0, fail = 0;
const check = (name, cond, extra) => { if (cond) { pass++; console.log(`ok    ${name}`); } else { fail++; console.log(`FAIL  ${name}${extra !== undefined ? ` (${JSON.stringify(extra)})` : ''}`); } };

const MOD = path.join(__dirname, '..', 'revert-gm-gift-1001.js');
const ACTOR = 0xff000304;

function world(entries, opts = {}) {
  const props = new Map([[`${ACTOR}:inventory`, { entries }]]);
  const logs = [], audits = [], told = [];
  const mp = {
    get(id, k) { if (opts.unreachable) throw new Error('no such form'); return props.get(`${id}:${k}`); },
    set(id, k, v) { if (opts.unreachable) throw new Error('no such form'); props.set(`${id}:${k}`, v); },
  };
  const timers = new Map();
  const api = {
    mp, log: (...a) => logs.push(a.join(' ')), audit: (t) => audits.push(t), personal: (a, t) => told.push([a, t]),
    every: (name, ms, fn) => timers.set(name, fn), stopTimer: (name) => timers.delete(name),
    onlineActors: () => (opts.online ? [ACTOR] : []),
  };
  return { props, logs, audits, told, timers, api, inv: () => props.get(`${ACTOR}:inventory`).entries };
}
const count = (entries, id) => entries.filter((e) => (e.baseId >>> 0) === id).reduce((s, e) => s + e.count, 0);
const load = (api) => { delete require.cache[MOD]; return require(MOD)(api); };

// Today's 23:22Z save, plus an unrelated stack and a worn helmet
const ENTRIES = () => [
  { baseId: 0x040284fa, count: 1, worn: true }, { baseId: 0x00106e19, count: 17 }, { baseId: 0x03003545, count: 25 },
  { baseId: 0x00085500, count: 20 }, { baseId: 0x0007edf5, count: 20 }, { baseId: 0x00106e1b, count: 14 },
  { baseId: 0x0006bc0b, count: 20 }, { baseId: 0x12005eb6, count: 1 }, { baseId: 0x000a6d7f, count: 1 },
  { baseId: 0x0002e4f3, count: 20 }, { baseId: 0x000727de, count: 18 }, { baseId: 0x0001b3bd, count: 18 },
  { baseId: 0x0006b689, count: 19 }, { baseId: 0x0000000f, count: 500 },
];

{
  const w = world(ENTRIES(), { online: true });
  load(w.api);
  const inv = w.inv();
  check('every gifted item is taken back down to the 23:00Z count', count(inv, 0x00106e19) === 0 && count(inv, 0x03003545) === 0 && count(inv, 0x000727de) === 0 && count(inv, 0x040284fa) === 0, inv);
  check('the Hagraven Claw held before the gift stays', count(inv, 0x0006b689) === 1, count(inv, 0x0006b689));
  check('unrelated items are untouched (gold 500)', count(inv, 0x0000000f) === 500);
  check('the run is marked done on the character', w.props.get(`${ACTOR}:private.dboRevert1001`) === true);
  check('one audit line names what was taken', w.audits.length === 1 && /Cyrodilic Spadetail x17/.test(w.audits[0]) && /Hagraven Claw x18/.test(w.audits[0]), w.audits);
  check('the online player is told once', w.told.length === 1 && w.told[0][0] === ACTOR);
  check('no retry timer when it ran at once', w.timers.size === 0);
  load(w.api);
  check('a second load does nothing (flag set)', w.audits.length === 1 && count(w.inv(), 0x0006b689) === 1);
}
{
  const e = ENTRIES(); e.push({ baseId: 0x00106e19, count: 5, worn: true });
  const w = world(e);
  const m = load(w.api);
  check('offline: no message, still reverted', w.told.length === 0 && w.props.get(`${ACTOR}:private.dboRevert1001`) === true);
  check('takes at most what was given (23 of 22 Spadetail held)', count(w.inv(), 0x00106e19) === 0 && m.plan(ENTRIES()).find((t) => t.name === 'Cyrodilic Spadetail').take === 17);
}
{
  const w = world([{ baseId: 0x00106e19, count: 30 }]);
  load(w.api);
  check('never more than the gift (30 held, 23 given -> 7 stay)', count(w.inv(), 0x00106e19) === 7, count(w.inv(), 0x00106e19));
}
{
  const w = world([{ baseId: 0x0006b689, count: 1 }]);
  load(w.api);
  check('nothing left of the gift: inventory unchanged, still marked done', count(w.inv(), 0x0006b689) === 1 && w.props.get(`${ACTOR}:private.dboRevert1001`) === true && /nothing/.test(w.audits[0]));
}
{
  const w = world([], { unreachable: true });
  load(w.api);
  check('character not reachable: a retry timer is set, nothing logged as done', w.timers.has('revertGmGift1001') && w.audits.length === 0);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
