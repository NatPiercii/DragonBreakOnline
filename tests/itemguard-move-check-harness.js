// itemguards.js checks every put and take a player makes: the pack's and the container's counts of the base are read
// before the engine moves them and again after, and a move that changed their total is logged (a store that left the
// items in the pack as well, 3 Oct). Moves are logged one line each unless itemGuards.logMoves is false.
//   node tests/itemguard-move-check-harness.js   (from server/)
'use strict';
const path = require('path');
const MODULE = path.resolve(__dirname, '..', 'itemguards.js');
let pending = [];
global.setTimeout = (fn) => { pending.push(fn); return pending.length; };
const flush = () => { const due = pending; pending = []; due.forEach((f) => f()); };
const P = 0xff001771, CHEST = 0x806da23, HERB = 0x7601924, SWORD = 0x12eb7;
const types = { [HERB]: 'INGR', [SWORD]: 'WEAP' };
const inv = { [P]: [{ baseId: HERB, count: 4 }, { baseId: SWORD, count: 1 }], [CHEST]: [{ baseId: HERB, count: 1 }] };
const logs = [];
const moves = () => logs.filter((l) => /^ITEMGUARD move/.test(l));
const mp = {
  get: (id, k) => (k === 'inventory' && inv[id] ? { entries: inv[id].map((e) => Object.assign({}, e)) } : undefined),
  set: () => {},
};
const add = (id, baseId, n) => { const e = inv[id].find((x) => x.baseId === baseId); if (e) e.count += n; else inv[id].push({ baseId, count: n }); inv[id] = inv[id].filter((x) => x.count > 0); };
const load = (cfg) => { delete require.cache[MODULE]; globalThis.__dboItemGuards = undefined; logs.length = 0;
  require(MODULE)({ mp, log: (...a) => logs.push(a.join(' ')), who: (a) => `P${(a >>> 0).toString(16)}`, recordOf: (id) => (types[id] ? { record: { type: types[id] } } : null), cfg }); };
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };
// The engine after the gamemode says yes: a put moves from the pack to the container; `faulty` adds without removing
const put = (n, faulty) => { if (mp.onPutItem(CHEST, P, HERB, n) === false) return false; add(CHEST, HERB, n); if (!faulty) add(P, HERB, -n); flush(); return true; };
const take = (n, faulty) => { if (globalThis.__dboTakeGuard(CHEST, P, HERB, n) === false) return false; add(P, HERB, n); if (!faulty) add(CHEST, HERB, -n); flush(); return true; };

load({});
ok(put(3), 'a put of 3 of 4 passes');
ok(moves().length === 1 && /^ITEMGUARD move put by Pff001771 at 806da23: 7601924 x3 \(pack 4 -> 1, container 1 -> 4\)$/.test(moves()[0]), 'one line for it, with both counts', logs);
logs.length = 0;
ok(take(2), 'a take of 2 passes');
ok(logs.length === 1 && /move take by Pff001771 at 806da23: 7601924 x2 \(pack 1 -> 3, container 4 -> 2\)/.test(logs[0]), '...logged the same way', logs);
logs.length = 0;
ok(put(2, true), 'a put the engine applies only to the container');
ok(logs.length === 1 && /^ITEMGUARD move changed the total by \+2: put by Pff001771 at 806da23: 7601924 x2 \(pack 3 -> 3, container 2 -> 4\)$/.test(logs[0]), '...is logged as having made 2', logs);
logs.length = 0;
ok(take(1, true), 'a take the engine applies only to the pack');
ok(logs.some((l) => /changed the total by \+1: take/.test(l)), '...is logged as having made 1', logs);
logs.length = 0;
ok(put(99) === false, 'a put of more than is held is refused, as before');
ok(!logs.some((l) => /ITEMGUARD move/.test(l)), '...and no move is checked for it', logs);
logs.length = 0;
// A take another hook refuses after the guard: nothing moves, nothing is logged
globalThis.__dboTakeGuard(CHEST, P, HERB, 1); flush();
ok(!moves().length, 'a take that moved nothing logs nothing', logs);

load({ itemGuards: { logMoves: false } });
inv[P] = [{ baseId: HERB, count: 5 }]; inv[CHEST] = [];
logs.length = 0;
put(2);
ok(!logs.some((l) => /ITEMGUARD move/.test(l)), 'logMoves false: a normal move is not logged', logs);
put(1, true);
ok(logs.some((l) => /changed the total by \+1/.test(l)), '...a move that made items still is', logs);

delete globalThis.__dboItemGuards; delete globalThis.__dboTakeGuard;
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
