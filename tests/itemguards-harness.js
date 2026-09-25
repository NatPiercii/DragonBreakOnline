// Scripted test for server\itemguards.js (audit B1/B2: drop, put and take guards). Run: node tests\itemguards-harness.js
'use strict';
const path = require('path');
const P = 0x14, CHEST = 0x5000;
const SWORD = 0x12eb7, POTION = 0x3eadd, KEY = 0x6000, NPC = 0x1e7e2, CONT = 0x1234, UNKNOWN = 0x999999;
const types = { [SWORD]: 'WEAP', [POTION]: 'ALCH', [KEY]: 'KEYM', [NPC]: 'NPC_', [CONT]: 'CONT' };
const inv = { [P]: [{ baseId: SWORD, count: 1 }, { baseId: POTION, count: 3 }, { baseId: POTION, count: 2 }], [CHEST]: [] };
const logs = []; let prevCalls = 0;
const mp = { get: (id, k) => (k === 'inventory' ? { entries: inv[id] || [] } : undefined), onPutItem: () => { prevCalls++; return true; } };
const g = require(path.resolve(__dirname, '..', 'itemguards.js'))({ mp, log: (...a) => logs.push(a.join(' ')), who: (a) => `P${a.toString(16)}`,
  recordOf: (id) => (types[id] ? { record: { type: types[id] } } : null) });
let failures = 0; const check = (n, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

check('a normal drop passes', mp.onDropItem(P, SWORD, 1) !== false);
check('dropping 5 of 5 owned potions (two stacks) passes', mp.onDropItem(P, POTION, 5) !== false);
check('a count of 0 is refused', mp.onDropItem(P, SWORD, 0) === false);
check('a negative or non-number count is refused', mp.onDropItem(P, SWORD, -3) === false && mp.onDropItem(P, SWORD, 'x') === false);
check('more than owned is refused', mp.onDropItem(P, POTION, 6) === false);
check('an item not owned at all is refused', mp.onDropItem(P, KEY, 1) === false);
check('an unknown record is refused (the crash)', mp.onDropItem(P, UNKNOWN, 1) === false);
check('an NPC or a container record is refused', mp.onDropItem(P, NPC, 1) === false && mp.onDropItem(P, CONT, 1) === false);
check('put: a normal put passes and reaches the earlier handler', mp.onPutItem(CHEST, P, SWORD, 1) !== false && prevCalls === 1);
check('put: count 0, unowned and non-items are refused before it', mp.onPutItem(CHEST, P, SWORD, 0) === false && mp.onPutItem(CHEST, P, KEY, 1) === false && mp.onPutItem(CHEST, P, NPC, 1) === false && prevCalls === 1);
inv[CHEST] = [{ baseId: KEY, count: 1 }, { baseId: 0xf, count: 50 }]; types[0xf] = 'MISC';
check('take: a normal take passes', globalThis.__dboTakeGuard(CHEST, P, KEY, 1) !== false);
check('take: more than the container holds is refused (gold duplication)', globalThis.__dboTakeGuard(CHEST, P, 0xf, 51) === false && globalThis.__dboTakeGuard(CHEST, P, 0xf, 50) !== false);
check('take: count 0 is refused (fake keys)', globalThis.__dboTakeGuard(CHEST, P, KEY, 0) === false);
check('take: non-item records are refused', globalThis.__dboTakeGuard(CHEST, P, NPC, 1) === false);
check('refusals are logged, once a minute per actor and reason', logs.filter((l) => /ITEMGUARD refused drop by P14: 12eb7 x0 \(count below 1\)/.test(l)).length === 1);
const before = logs.length; for (let i = 0; i < 50; i++) mp.onDropItem(P, SWORD, 0);
check('a flood of bad packets does not flood the log', logs.length === before);
// Reload: the guard chains to the original handler, not to itself
delete require.cache[path.resolve(__dirname, '..', 'itemguards.js')];
require(path.resolve(__dirname, '..', 'itemguards.js'))({ mp, log: () => {}, who: (a) => '', recordOf: (id) => (types[id] ? { record: { type: types[id] } } : null) });
prevCalls = 0; mp.onPutItem(CHEST, P, SWORD, 1);
check('after a hot reload the earlier handler runs exactly once', prevCalls === 1, prevCalls);

// log mode lets it through and says what it would refuse; off installs nothing
const logs2 = []; delete require.cache[path.resolve(__dirname, '..', 'itemguards.js')]; globalThis.__dboItemGuards = undefined;
require(path.resolve(__dirname, '..', 'itemguards.js'))({ mp, log: (...a) => logs2.push(a.join(' ')), who: () => 'P', recordOf: (id) => (types[id] ? { record: { type: types[id] } } : null), cfg: { itemGuards: { mode: 'log' } } });
check('log mode lets a bad drop through and logs it', mp.onDropItem(P, SWORD, 0) !== false && logs2.some((l) => /would refuse drop/.test(l)));
delete require.cache[path.resolve(__dirname, '..', 'itemguards.js')];
require(path.resolve(__dirname, '..', 'itemguards.js'))({ mp, log: () => {}, who: () => 'P', recordOf: () => null, cfg: { itemGuards: { mode: 'off' } } });
check('off leaves no take guard behind', globalThis.__dboTakeGuard === null);
prevCalls = 0;
check('and hands drop and put back to the original handlers', !mp.onPutItem.__dboGuard && mp.onPutItem(CHEST, P, SWORD, 0) === true && prevCalls === 1 && mp.onDropItem === undefined);
delete globalThis.__dboItemGuards; delete globalThis.__dboTakeGuard;
console.log(''); console.log(failures ? `${failures} FAILURES` : 'all checks passed'); process.exit(failures ? 1 : 0);
