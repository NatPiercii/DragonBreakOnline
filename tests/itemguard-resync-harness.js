// A move refused for more than is held sends the player's own server inventory back to them (itemguards.js resync), so
// their client stops showing items the server never gave (Veltrius, 2026-10-01: ingredients that could be neither
// dropped nor stored). At most once a second per player, one note a minute, nothing for other refusals, and loaded
// over the state the live module (4304ef0c) built, as a hot reload would.
// node tests/itemguard-resync-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const MODULE = path.resolve(__dirname, '..', 'itemguards.js');
let now = Date.UTC(2026, 9, 1, 20, 0);
Date.now = () => now;
let pending = [];
global.setTimeout = (fn) => { pending.push(fn); return pending.length; };
const flush = () => { const due = pending; pending = []; due.forEach((f) => f()); };

const P = 0xff000304, Q = 0xff000305, CHEST = 0x5000;
const HERB = 0x6bc02, POTION = 0x3eadd, SWORD = 0x12eb7, NPC = 0x1e7e2;
const types = { [HERB]: 'INGR', [POTION]: 'ALCH', [SWORD]: 'WEAP', [NPC]: 'NPC_' };
const inv = { [P]: [{ baseId: POTION, count: 2 }, { baseId: SWORD, count: 1, worn: true }], [Q]: [], [CHEST]: [] };
const sets = [], logs = [], told = [];
const mp = {
  get: (id, k) => (k === 'inventory' && inv[id] ? { entries: inv[id].map((e) => Object.assign({}, e)) } : undefined),
  set: (id, k, v) => { sets.push([id, k, v]); },
};
const api = { mp, log: (...a) => logs.push(a.join(' ')), who: (a) => `P${(a >>> 0).toString(16)}`, personal: (a, t) => told.push([a, t]),
  recordOf: (id) => (types[id] ? { record: { type: types[id] } } : null), cfg: {} };
const load = (file) => { delete require.cache[file]; require(file)(api); };

let failures = 0, checks = 0;
const check = (n, ok, got) => { checks++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const setsTo = (a) => sets.filter(([id, k]) => id === a && k === 'inventory');

// The live module first, then this one over its globalThis state
globalThis.__dboItemGuards = undefined; globalThis.__dboTakeGuard = undefined;
let live = null;
try { live = execFileSync('git', ['show', '4304ef0c:itemguards.js'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { live = null; }
if (live) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-resync-'));
  fs.writeFileSync(path.join(tmp, 'itemguards.js'), live);
  load(path.join(tmp, 'itemguards.js'));
  check('live 4304ef0c: an unheld drop is refused', mp.onDropItem(P, HERB, 1) === false);
  fs.rmSync(tmp, { recursive: true, force: true });
} else console.log('skip live-then-new: 4304ef0c is not in this repository');
flush(); sets.length = 0; told.length = 0; logs.length = 0;
load(MODULE);

check('a drop of an ingredient the server never gave is still refused', mp.onDropItem(P, HERB, 1) === false);
check('...and nothing is sent inside the event itself', !sets.length);
flush();
check('...then the player\'s own server inventory is sent back to them', setsTo(P).length === 1 && JSON.stringify(setsTo(P)[0][2]) === JSON.stringify({ entries: inv[P] }), setsTo(P));
check('...worn state carried as it is', setsTo(P)[0][2].entries.some((e) => e.baseId === SWORD && e.worn === true));
check('...one note for the player', told.length === 1 && told[0][0] === P && /set right/.test(told[0][1]), told);
check('...and one log line', logs.filter((l) => /ITEMGUARD resynced the inventory of Pff000304/.test(l)).length === 1, logs);

now += 200;
mp.onDropItem(P, HERB, 1); mp.onPutItem(CHEST, P, HERB, 1); flush();
check('a second refusal within the second sends nothing more', setsTo(P).length === 1);
now += 1000;
mp.onPutItem(CHEST, P, HERB, 1); flush();
check('a refused put a second later resyncs again', setsTo(P).length === 2);
check('...but the note is not repeated within the minute', told.length === 1, told);
check('...nor the log line', logs.filter((l) => /ITEMGUARD resynced the inventory of Pff000304/.test(l)).length === 1, logs);
for (let i = 0; i < 30; i++) { now += 1000; mp.onDropItem(P, HERB, 1); flush(); }
check('a refusal every second for 30 s: a resync each time, still one log line and one note', setsTo(P).length === 32 && logs.filter((l) => /ITEMGUARD resynced/.test(l)).length === 1 && told.length === 1, [setsTo(P).length, told.length]);
now += 60000;
mp.onDropItem(P, POTION, 3); flush();
check('more potions than held: resync, and the note and the log line again a minute on', setsTo(P).length === 33 && told.length === 2 && logs.filter((l) => /ITEMGUARD resynced/.test(l)).length === 2);

now += 2000;
inv[CHEST] = [{ baseId: HERB, count: 1 }];
check('take: more than the chest holds is refused', globalThis.__dboTakeGuard(CHEST, Q, HERB, 2) === false);
flush();
check('...and the taker (not the chest) is resynced', setsTo(Q).length === 1 && !setsTo(CHEST).length);

now += 2000; const before = sets.length;
check('a count of 0 is refused', mp.onDropItem(P, SWORD, 0) === false);
check('an NPC record is refused', mp.onDropItem(P, NPC, 1) === false);
flush();
check('...neither of those resyncs anything', sets.length === before);
check('a drop that is held passes and resyncs nothing', mp.onDropItem(P, POTION, 2) !== false && (flush(), sets.length === before));

// A player gone before the timer: no write, no throw
now += 2000;
mp.onDropItem(0xff000999, HERB, 1); flush();
check('a player gone before the resync: nothing written', !setsTo(0xff000999).length);
// A write that throws is logged (once a minute, like the rest), not raised
now += 60000;
mp.set = () => { throw new Error('gone'); };
mp.onDropItem(P, HERB, 1);
let threw = false; try { flush(); } catch (e) { threw = true; }
check('a failing write is logged and does not throw', !threw && logs.some((l) => /inventory resync failed for Pff000304: gone/.test(l)));
for (let i = 0; i < 10; i++) { now += 1000; mp.onDropItem(P, HERB, 1); flush(); }
check('...and a write failing every second is logged once a minute', logs.filter((l) => /inventory resync failed/.test(l)).length === 1);

// log mode refuses nothing, so it resyncs nothing
mp.set = (id, k, v) => { sets.push([id, k, v]); };
globalThis.__dboItemGuards = undefined; delete require.cache[MODULE];
require(MODULE)(Object.assign({}, api, { cfg: { itemGuards: { mode: 'log' } } }));
const b2 = sets.length; now += 5000;
mp.onDropItem(P, HERB, 1); flush();
check('log mode: lets it through and resyncs nothing', sets.length === b2);

delete globalThis.__dboItemGuards; delete globalThis.__dboTakeGuard;
console.log(failures ? `\n${failures} of ${checks} FAILED` : `\nall ${checks} checks passed`);
process.exit(failures ? 1 : 0);
