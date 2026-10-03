// Imperial Luck on lease chest coin (dungeons.js __dboTakeItem -> racial.js goldBonus): paid only on the coin the chest
// was rolled with and still holds, so gold a player puts in and takes back out pays nothing (G's review of
// racial-passives, 3 Oct). Loads the real dungeons.js with a mock gamemode api, as lease-gold-harness does, and records
// what it asks __dboRaceGold for.
//   node tests/racial-gold-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const DUNGEONS = path.resolve(__dirname, '..', 'dungeons.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-racial-gold-'));
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
const paid = [];
globalThis.__dboRaceGold = (a, amount, why) => { paid.push([a, amount, why]); return Math.floor(amount / 10); };
let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${got !== undefined && !ok ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const take = (count, who = A) => globalThis.__dboTakeItem(CHEST, who, GOLD, count);
const luckOf = (a) => paid.filter((p) => p[0] === a).reduce((n, p) => n + p[1], 0);
const reset = (rolled) => { gold.set(A, 0); gold.set(B, 0); gold.set(C, 0); paid.length = 0; where.set(B, CELL); where.set(C, CELL); lease.rolledGold = rolled === undefined ? undefined : new Map([[CHEST, rolled]]); };
const alone = () => { where.set(B, OUTSIDE); where.set(C, OUTSIDE); };

// Alone: the chest's own 60 coin counts
reset(60); alone(); gold.set(A, 60); take(60);
check('alone, the chest\'s rolled 60 taken: luck counted on 60', luckOf(A) === 60 && paid.length === 1, paid);
// Put it back and take it again: the rolled coin is spent
paid.length = 0; take(60);
check('...put back and taken again: nothing more', paid.length === 0, paid);
// The exploit: 1000 of one's own put into a chest that held 60, then the pile taken
reset(60); alone(); gold.set(A, 1060); take(1060);
check('own 1000 put into a chest of 60, pile taken: luck only on the 60', luckOf(A) === 60, paid);
paid.length = 0; take(1060);
check('...and the same pile again: nothing', paid.length === 0, paid);
// An empty chest (no coin rolled): own gold put in and taken pays nothing
reset(); alone(); gold.set(A, 500); take(500);
check('a chest that rolled no coin: own gold put in pays nothing', paid.length === 0, paid);
// Taken in two parts: 40 then 40 of a rolled 60 -> 40 then 20
reset(60); alone(); gold.set(A, 40); take(40); gold.set(A, 80); take(40);
check('taken in parts: 40 then the last 20 of the rolled 60', luckOf(A) === 60 && paid.length === 2 && paid[1][1] === 20, paid);
// A party of three takes a rolled 90: each counts their 30
reset(90); gold.set(A, 90); take(90);
check('a party of three, 90 rolled: luck on 30 each', luckOf(A) === 30 && luckOf(B) === 30 && luckOf(C) === 30, paid);
// A party, with 900 of the finder's own added to a rolled 90: only the rolled tenth of each share counts
reset(90); gold.set(A, 990); take(990);
check('a party, own 900 added to a rolled 90: luck only on the rolled 90, 30 each', luckOf(A) === 30 && luckOf(B) === 30 && luckOf(C) === 30 && gold.get(A) + gold.get(B) + gold.get(C) === 990, { paid, gold: [...gold] });
// Another chest of the lease, never rolled: nothing
reset(90); alone(); gold.set(A, 90); globalThis.__dboTakeItem(OTHER_CHEST, A, GOLD, 90);
check('a container that is not a lease chest: nothing', paid.length === 0, paid);
// fillChests records the roll: the source says so
const src = fs.readFileSync(DUNGEONS, 'utf8');
check('fillChests records each chest\'s rolled coin on the lease', /if \(lease\) lease\.rolledGold = new Map\(\);/.test(src) && /lease\.rolledGold\.set\(id >>> 0, g\)/.test(src));

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
