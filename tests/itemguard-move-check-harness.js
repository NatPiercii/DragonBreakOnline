// itemguards.js checks every put and take a player makes: the pack's and the container's counts of the base are read
// before the engine moves them and again after, and a move that changed their total is logged (a store that left the
// items in the pack as well, 3 Oct). Every move is logged too only with itemGuards.logMoves true (off by default for its
// volume). Across a relog: the pack and the containers used are written down at logout, and a total that grew is logged
// at the next login. Runs in a scratch folder (item-snapshots.json).
//   node tests/itemguard-move-check-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const home = process.cwd();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-movecheck-'));
process.chdir(dir);
const MODULE = path.resolve(__dirname, '..', 'itemguards.js');
const realTimeout = setTimeout;
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
ok(!moves().length, 'by default a normal move is not logged');
inv[P] = [{ baseId: HERB, count: 4 }, { baseId: SWORD, count: 1 }]; inv[CHEST] = [{ baseId: HERB, count: 1 }];
load({ itemGuards: { logMoves: true } });
ok(put(3), 'with logMoves true: a put of 3 of 4 passes');
ok(moves().length === 1 && /^ITEMGUARD move put by Pff001771 at 806da23: 7601924 x3 \(pack 4 -> 1, container 1 -> 4\)$/.test(moves()[0]), 'one line for it, with both counts', logs);
logs.length = 0;
ok(take(2), 'a take of 2 passes');
ok(logs.length === 1 && /move take by Pff001771 at 806da23: 7601924 x2 \(pack 1 -> 3, container 4 -> 2\)/.test(logs[0]), '...logged the same way', logs);
logs.length = 0;
ok(put(2, true), 'a put the engine applies only to the container');
ok(logs.filter((l) => !/^ITEMGUARD trace/.test(l)).length === 1 && /^ITEMGUARD move changed the total by \+2: put by Pff001771 at 806da23: 7601924 x2 \(pack 3 -> 3, container 2 -> 4\)$/.test(logs.filter((l) => !/^ITEMGUARD trace/.test(l))[0]), '...is logged as having made 2', logs);
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

// ---- the move trace (logMoves true; 10 Oct: the container bounce) ----------------------------------------------------------
const traces = () => logs.filter((l) => /^ITEMGUARD trace/.test(l));
load({ itemGuards: { logMoves: true } });
inv[P] = [{ baseId: HERB, count: 5 }]; inv[CHEST] = [];
logs.length = 0;
put(2);
ok(traces().some((l) => /^ITEMGUARD trace put asked by Pff001771 at 806da23: 7601924 x2, allowed$/.test(l)), 'a put is traced with its verdict', logs);
ok(!traces().some((l) => /bounced|moved nothing/.test(l)), '...a put that stays put is not called a bounce', logs);
logs.length = 0;
put(99);
ok(traces().some((l) => /put asked .* x99, refused by the guard$/.test(l)), 'a refused put is traced as refused by the guard', logs);
logs.length = 0;
// The engine took the items out of the pack, then they came back (the client's bounce): seen BOUNCE_MS later
mp.onPutItem(CHEST, P, HERB, 1); add(P, HERB, -1); add(CHEST, HERB, 1);
{ const due = pending; pending = []; due.forEach((f) => f()); }   // the 0 ms check: moved
add(P, HERB, 1); add(CHEST, HERB, -1);                            // the bounce
flush();                                                           // the BOUNCE_MS check
ok(traces().some((l) => /^ITEMGUARD trace put bounced back: put by Pff001771 at 806da23: 7601924 x1 .*3 s later pack 3, container 2$/.test(l)), 'a put whose items are back in the pack is traced as bounced', logs);
logs.length = 0;
// A put the engine never applied (another listener, or nothing moved)
mp.onPutItem(CHEST, P, HERB, 1); flush();
ok(traces().some((l) => /^ITEMGUARD trace put moved nothing: /.test(l)), 'a put that moved nothing is traced', logs);
// A container activation goes through the trace with the chain's verdict, players only
{
  const CONT_BASE = 0x1234;
  types[CONT_BASE] = 'CONT';
  const getBase = mp.get;
  mp.get = (id, k) => (k === 'profileId' ? (id === P ? 7 : -1) : k === 'baseDesc' ? '1234:Skyrim.esm' : getBase(id, k));
  mp.getIdFromDesc = () => CONT_BASE;
  let chain = true;
  mp.onActivate = () => chain;
  load({ itemGuards: { logMoves: true } });
  logs.length = 0;
  ok(mp.onActivate(CHEST, P) === true && traces().some((l) => /^ITEMGUARD trace activate 806da23 \(base 1234\) by Pff001771: allowed/.test(l)), 'a container activation by a player is traced, allowed', logs);
  chain = false; logs.length = 0;
  ok(mp.onActivate(CHEST, P) === false && traces().some((l) => /refused by the activate chain/.test(l)), '...and a refused one, with the verdict passed through unchanged', logs);
  logs.length = 0;
  mp.onActivate(CHEST, 0xff000999);
  ok(!traces().length, 'an NPC activation is not traced', logs);
  // Bounded: 20 lines a minute per player, then one count
  logs.length = 0; chain = true; globalThis.__dboItemGuards.trace.delete(P);
  for (let i = 0; i < 50; i++) mp.onActivate(CHEST, P);
  ok(traces().length === 20, 'at most trace.perMinute (20) lines a minute per player', traces().length);
  globalThis.__dboItemGuards.trace.get(P).since -= 61000;
  logs.length = 0; mp.onActivate(CHEST, P);
  ok(logs.some((l) => /30 line\(s\) for Pff001771 left out in the last minute/.test(l)), '...then one count of what was left out', logs);
  // gamemode.js builds its activate chain afresh before every load of itemguards.js
  const fresh = () => chain;
  mp.onActivate = fresh;
  load({ itemGuards: { logMoves: false } });
  ok(mp.onActivate === fresh, 'logMoves false leaves the activate chain alone');
  mp.get = getBase; delete types[CONT_BASE]; mp.onActivate = undefined;
}

// ---- across a relog ------------------------------------------------------------------------------------------------------
const FILE = path.join(dir, 'item-snapshots.json');
const wait = (ms) => new Promise((r) => realTimeout(r, ms));
const idle = async () => { for (let i = 0; i < 200 && globalThis.__dboItemGuards && (globalThis.__dboItemGuards.snapWriting || globalThis.__dboItemGuards.snapDirty); i++) await wait(10); await wait(20); };
(async () => {
  load({});
  inv[P] = [{ baseId: HERB, count: 5 }, { baseId: SWORD, count: 1 }]; inv[CHEST] = [];
  put(5);
  globalThis.__dboItemLeave(P);
  await idle();
  ok(fs.existsSync(FILE) && JSON.parse(fs.readFileSync(FILE, 'utf8'))['ff001771'].pack['7601924'] === undefined && JSON.parse(fs.readFileSync(FILE, 'utf8'))['ff001771'].containers['806da23']['7601924'] === 5, 'logout: the pack and the chest used are written down', fs.existsSync(FILE) && fs.readFileSync(FILE, 'utf8'));
  // A load that brings the stored items back to the pack while the chest keeps them
  add(P, HERB, 5);
  logs.length = 0;
  const grew = globalThis.__dboItemLogin(P);
  ok(grew && grew.length === 1 && grew[0].base === '7601924', 'login: the herb whose total grew is found', grew);
  ok(logs.some((l) => /^ITEMGUARD relog total grew for Pff001771 \(logout \d+ min ago, 1 container\(s\) used\): 7601924 pack 0 -> 5, containers 5 -> 5$/.test(l)), '...and logged with both counts', logs);
  ok(globalThis.__dboItemLogin(P) === null, 'the snapshot is used once');
  // An honest relog: nothing moved while away
  inv[P] = [{ baseId: HERB, count: 2 }]; inv[CHEST] = [{ baseId: HERB, count: 3 }];
  put(1); globalThis.__dboItemLeave(P);
  logs.length = 0;
  const none = globalThis.__dboItemLogin(P);
  ok(Array.isArray(none) && !none.length && !logs.some((l) => /relog total grew/.test(l)), 'an honest relog logs nothing', [none, logs]);
  // Taken out of the pack while away (an offline body looted): a loss is not a growth
  globalThis.__dboItemLeave(P); add(P, HERB, -1);
  ok(globalThis.__dboItemLogin(P).length === 0, 'a smaller total is not reported');
  // A hot reload keeps what was written down, and a restart reads it from the file
  globalThis.__dboItemLeave(P); add(P, SWORD, 1);
  await idle();
  globalThis.__dboItemGuards = undefined; delete require.cache[MODULE];
  require(MODULE)({ mp, log: (...a) => logs.push(a.join(' ')), who: (a) => `P${(a >>> 0).toString(16)}`, recordOf: (id) => (types[id] ? { record: { type: types[id] } } : null), cfg: {} });
  const afterRestart = globalThis.__dboItemLogin(P);
  ok(afterRestart && afterRestart.some((g) => g.base === '12eb7'), 'after a restart the file still holds the logout snapshot', afterRestart);
  await idle();
  delete globalThis.__dboItemGuards; delete globalThis.__dboTakeGuard;
  process.chdir(home);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
