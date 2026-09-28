// Coin from a lease chest, shared with the party inside (dungeons.js __dboTakeItem): the shares must come out of the
// finder before anyone is paid, so putting the pile back in the chest mints nothing (post-hoc review A7-GOLD-1,
// 2026-09-28). Loads the real dungeons.js with a mock gamemode api and one lease of three members.
//   node tests/lease-gold-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const DUNGEONS = path.resolve(__dirname, '..', 'dungeons.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-lease-gold-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
global.setTimeout = () => 0;

const CELL = '1234:Skyrim.esm', OUTSIDE = '5678:Skyrim.esm';
const CHEST = 0x9000, OTHER_CHEST = 0x9001;
const A = 0x14, B = 0xff000020, C = 0xff000030;
const GOLD = 0xf;
fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [{ id: 'TestCave', name: 'Test Cave', type: 'cave', entrances: [], cells: [{ desc: CELL }], chests: [{ ref: '9000:Skyrim.esm' }], zones: [] }] }));
const pids = new Map([[A, 1], [B, 2], [C, 3]]);
const gold = new Map([[A, 0], [B, 0], [C, 0]]);
const where = new Map([[A, CELL], [B, CELL], [C, CELL]]);
const lease = { id: 'TestCave', name: 'Test Cave', difficulty: 'normal', leader: 1, members: new Set([1, 2, 3]), startedAt: Date.now(), endsAt: Date.now() + 3600000, warned: false, lastInsideAt: Date.now(), locked: new Map(), unlocked: new Set(), looted: new Set(), zones: [], totalNpcs: 0, seenNpcs: new Set(), deadNpcs: new Set(), entrance: null, kinds: {}, armed: new Set() };
globalThis.__dboDungeons = { leases: new Map([['TestCave', lease]]), parties: new Map(), memberOf: new Map(), invites: new Map(), pending: new Map() };
globalThis.__dboDungeonsBooted = true;
let giveFails = new Set();
const said = [];
require(DUNGEONS)({
  mp: {
    get: (id, p) => {
      if (p === 'profileId') return pids.has(id) ? pids.get(id) : -1;
      if (p === 'worldOrCellDesc') return where.get(id);
      if (p === 'inventory') return { entries: gold.get(id) ? [{ baseId: 0x12eb7, count: 1 }, { baseId: GOLD, count: gold.get(id) }] : [{ baseId: 0x12eb7, count: 1 }] };
      return undefined;
    },
    set: (id, p, v) => { if (p === 'inventory') gold.set(id, v.entries.filter((e) => e.baseId === GOLD).reduce((n, e) => n + e.count, 0)); },
    getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16),
  },
  log: () => {}, personal: (a, t) => said.push([a, t]), system: () => {}, audit: () => {},
  registerChatCommand: () => {}, onUi: () => {}, openWidget: () => true, closeWidget: () => true,
  sendPacket: () => true, findByName: () => 0, display: String, who: String,
  profileOf: (a) => (pids.has(a) ? pids.get(a) : -1), nameOf: () => 'Finder', onlineActors: () => [A, B, C],
  isAdmin: () => false, giveItem: (a, base, n) => { if (giveFails.has(a)) return false; if (base === GOLD) gold.set(a, (gold.get(a) || 0) + n); return true; },
  cfg: {}, every: () => {},
});
let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${got !== undefined && !ok ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const take = (count) => globalThis.__dboTakeItem(CHEST, A, GOLD, count);
const total = () => gold.get(A) + gold.get(B) + gold.get(C);
const reset = () => { gold.set(A, 0); gold.set(B, 0); gold.set(C, 0); said.length = 0; giveFails = new Set(); where.set(B, CELL); where.set(C, CELL); };

check('the take hook is installed', typeof globalThis.__dboTakeItem === 'function');

// A fair take: 90 coin, three inside, 30 each
reset(); gold.set(A, 90); take(90);
check('90 found by three: 30 each, nothing made or lost', gold.get(A) === 30 && gold.get(B) === 30 && gold.get(C) === 30, [...gold]);

// The exploit: the finder puts the pile back before the split runs. Nothing may be paid out of thin air.
reset(); take(90);
check('pile put back before the split: nobody is paid, no coin appears', total() === 0, [...gold]);
reset(); gold.set(A, 40); take(90);
check('only part kept: the shares are what could be taken (40 -> 20 each to two)', gold.get(A) === 0 && gold.get(B) === 20 && gold.get(C) === 20 && total() === 40, [...gold]);
reset(); gold.set(A, 41); take(90);
check('an odd coin of a split goes back to the finder', gold.get(A) === 1 && gold.get(B) === 20 && gold.get(C) === 20 && total() === 41, [...gold]);
// Five cycles of take, put back, take again never grow the party's coin
reset(); gold.set(A, 90); for (let i = 0; i < 5; i++) take(90);
check('repeating the take never grows the party purse', total() === 90, [...gold]);

// A failed give returns that share to the finder
reset(); gold.set(A, 90); giveFails.add(C); take(90);
check('a failed give goes back to the finder', gold.get(A) === 60 && gold.get(B) === 30 && gold.get(C) === 0 && total() === 90, [...gold]);

// Members outside the ruin get no share
reset(); gold.set(A, 90); where.set(C, OUTSIDE); take(90);
check('a member outside the ruin is not paid', gold.get(A) === 45 && gold.get(B) === 45 && gold.get(C) === 0, [...gold]);
reset(); gold.set(A, 90); where.set(B, OUTSIDE); where.set(C, OUTSIDE); take(90);
check('alone inside: the finder keeps it all', gold.get(A) === 90 && total() === 90, [...gold]);

// Not a lease chest, not gold, too little to split: untouched
reset(); gold.set(A, 90); globalThis.__dboTakeItem(OTHER_CHEST, A, GOLD, 90);
check('coin from a chest that is not the dungeon\'s is not split', gold.get(A) === 90 && total() === 90);
reset(); gold.set(A, 2); take(2);
check('fewer coins than members: nothing to share', gold.get(A) === 2 && total() === 2);
reset(); gold.set(A, 90); globalThis.__dboTakeItem(CHEST, A, 0x12eb7, 1);
check('an item that is not gold is not split', gold.get(A) === 90);

// The messages
reset(); gold.set(A, 90); take(90);
check('each member is told their share', said.filter(([a, t]) => (a === B || a === C) && /found 90 gold; your share is 30/.test(t)).length === 2, said);
check('the finder is told what went to the party', said.some(([a, t]) => a === A && /90 gold, shared with your party: 60 went to them/.test(t)), said);

console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
