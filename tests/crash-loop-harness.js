// The crash loop of 1 Oct (crash-wave-1001 §2): a player who crashed inside a claimed dungeon logged back in inside the
// same fight and crashed again, 12 times that evening. Now a member whose newest launcher note is a recent crash wakes
// at the entrance, keeps the claim and the party, and pays no rest if the claim then ends empty.
// Real dungeons.js, one claimed dungeon, the launcher notes stubbed where downed.js would answer.
//   node tests/crash-loop-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const DUNGEONS = path.resolve(__dirname, '..', 'dungeons.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-jake-bugs-crashloop-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });

let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };

let now = 1_790_000_000_000;
Date.now = () => now;
const timers = [];
global.setTimeout = (fn, ms) => { timers.push({ fn, at: now + (ms || 0) }); return timers.length; };
const runTimers = () => { for (let i = 0; i < 20; i++) { const due = timers.filter((t) => t.at <= now && !t.done); if (!due.length) return; for (const t of due) { t.done = true; t.fn(); } } };

const W = 'a764b:BSHeartland.esm', INSIDE = '1111:BSHeartland.esm', OUTSIDE_CELL = 'a7646:BSHeartland.esm';
const ENTRANCE = { outsideDesc: '35f7:BSHeartland.esm', insideDesc: '35f8:BSHeartland.esm', world: W, cell: OUTSIDE_CELL, pos: [87525, 209776, 2648], rot: [0, 0, 1.5708], insidePos: [0, 0, 0], insideCell: INSIDE };
const RUIN = { id: 'CYRNiryastareLocation', name: 'Niryastare', type: 'ruin', cells: [{ desc: INSIDE }], chests: [], zones: [], entrances: [ENTRANCE] };
fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [RUIN] }));

const P1 = 0x14, P2 = 0x15, PID1 = 2, PID2 = 6;
const where = new Map([[P1, INSIDE], [P2, INSIDE]]);
const notes = new Map();   // pid -> the newest launcher note, as downed.js keeps it
const moves = [], said = [], audits = [];
let tick = null;
const lease = () => ({ id: RUIN.id, name: RUIN.name, difficulty: 'normal', leader: PID1, members: new Set([PID1, PID2]), startedAt: now, endsAt: now + 3600000, warned: false,
  lastInsideAt: now, locked: new Map(), zones: [], totalNpcs: 3, seenNpcs: new Set(), deadNpcs: new Set(), bossZones: new Set(), bossIds: new Set(), looted: new Set(), unlocked: new Set(), entrance: ENTRANCE });
const load = (cfg) => {
  delete require.cache[require.resolve(DUNGEONS)];
  globalThis.__dboDungeons = { leases: new Map([[RUIN.id, lease()]]), parties: new Map(), memberOf: new Map(), invites: new Map(), pending: new Map() };
  globalThis.__dboDungeonsBooted = true;
  globalThis.__dboDungeonAccountRest = new Map();
  globalThis.__dboLastSessionNote = (pid) => notes.get(pid) || null;
  require(DUNGEONS)({
    mp: {
      get: (id, p) => (p === 'profileId' ? (id === P1 ? PID1 : id === P2 ? PID2 : -1) : p === 'worldOrCellDesc' ? where.get(id) : undefined),
      set: (id, p, v) => { if (p === 'locationalData') { moves.push([id, v]); where.set(id, v.cellOrWorldDesc); } },
      getIdFromDesc: () => 0x01000000, lookupEspmRecordById: () => null,
    },
    log: () => {}, personal: (a, t) => said.push([a, t]), system: (a, t) => said.push([a, t]), audit: (t) => audits.push(t),
    registerChatCommand: () => {}, onUi: () => {}, openWidget: () => true, closeWidget: () => true,
    sendPacket: () => true, findByName: () => 0, display: () => 'P', who: () => 'P', profileOf: (a) => (a === P1 ? PID1 : a === P2 ? PID2 : -1), nameOf: () => 'P',
    onlineActors: () => [P1, P2], isAdmin: () => false, giveItem: () => true, cfg: cfg || {}, every: (name, ms, fn) => { if (name === 'dungeons.tick') tick = fn; },
  });
};
const reset = () => { moves.length = 0; said.length = 0; audits.length = 0; timers.length = 0; where.set(P1, INSIDE); where.set(P2, INSIDE); notes.clear(); };
const claim = () => globalThis.__dboDungeons.leases.get(RUIN.id);
const login = (a) => globalThis.__dboDungeonLoginCheck(a);

load();

// A crash a minute ago, then a login inside the claim: moved to the entrance, still a member
reset();
notes.set(PID1, { outcome: 'crash', at: now - 60000, endedAt: now - 61000 });
ok(login(P1) === true, 'a crash note a minute old and a login inside the claim: the login check moves them');
ok(moves.length === 1 && moves[0][1].cellOrWorldDesc === W && moves[0][1].pos.join() === '87525,209776,2648', 'to the claim\'s outside entrance', moves);
ok(said.some(([a, t]) => a === P1 && /You crashed inside Niryastare, so you've been moved to its entrance/.test(t)), 'with a short message saying why', said);
ok(claim() && claim().members.has(PID1) && claim().members.has(PID2), 'the claim stays, with both members');
ok(audits.some((t) => /^CRASHLOOP .* Niryastare: the game crashed 60 s before this login$/.test(t)), 'and it is audited', audits);

// The same note on a second login: moved once only
moves.length = 0;
where.set(P1, INSIDE);
ok(login(P1) === false && moves.length === 0, 'logging in again on the same note does not move them again', moves);

// A clean quit is the newest note: nothing happens
reset();
notes.set(PID2, { outcome: 'closed', at: now - 30000, endedAt: now - 31000 });
ok(login(P2) === false && moves.length === 0, 'a clean quit as the newest note: they stay inside', moves);

// A crash, then a clean quit later: the clean quit is newest, so no move
reset();
notes.set(PID2, { outcome: 'closed', at: now - 20000, endedAt: now - 21000 });
ok(login(P2) === false && moves.length === 0, 'a crash followed by a clean session: no move');

// Outside any claim: untouched
reset();
where.set(P2, OUTSIDE_CELL);
notes.set(PID2, { outcome: 'crash', at: now - 60000, endedAt: now - 61000 });
ok(login(P2) === false && moves.length === 0, 'logged in outside any dungeon: untouched', moves);

// A crash older than withinMinutes (15): untouched
reset();
notes.set(PID2, { outcome: 'crash', at: now - 20 * 60000, endedAt: now - 20 * 60000 });
ok(login(P2) === false && moves.length === 0, 'a crash twenty minutes ago: untouched', moves);

// The note lands a few seconds after the login: the late check moves them
reset();
ok(login(P2) === false && moves.length === 0, 'no note yet at login: they stay for now');
now += 5000; runTimers();
ok(moves.length === 0, 'five seconds on, still no note: nothing');
notes.set(PID2, { outcome: 'crash', at: now, endedAt: now - 70000 });
now += 5000; runTimers();
ok(moves.length === 1 && moves[0][0] === P2, 'the crash note lands after the login: the next check moves them', moves);

// The claim is kept while it is empty for keepClaimMinutes (10), beyond the usual grace (3); ending empty costs the
// crash-moved member no rest, and the member who simply left pays it as before
reset();
const L = claim();
L.crashMoved = new Set([PID2]); L.crashKeepUntil = now + 10 * 60000; L.lastInsideAt = now;
where.set(P1, OUTSIDE_CELL); where.set(P2, OUTSIDE_CELL);
now += 5 * 60000; tick();
ok(claim() === L, 'five minutes empty, past the usual 3 min grace: the claim is kept for the crashed member');
now += 6 * 60000; tick();
ok(!claim(), 'past keepClaimMinutes it ends as an empty claim does');
const rest = globalThis.__dboDungeonAccountRest;
ok(!rest.has(`${PID2}:${RUIN.id}`), 'the member who crashed inside pays no rest', [...rest.keys()]);
ok(rest.has(`${PID1}:${RUIN.id}`), 'the member who just left pays the usual hour', [...rest.keys()]);

// Once anything in the claim was looted the crashed member pays the rest too, so a reclaim can't refill the chests
load();
reset();
const L2 = claim();
L2.crashMoved = new Set([PID2]); L2.crashKeepUntil = now + 10 * 60000; L2.lastInsideAt = now; L2.looted.add(0xabc);
where.set(P1, OUTSIDE_CELL); where.set(P2, OUTSIDE_CELL);
now += 11 * 60000; tick();
const rest2 = globalThis.__dboDungeonAccountRest;
ok(!claim() && rest2.has(`${PID2}:${RUIN.id}`), 'after looting, the member who crashed inside pays the usual rest', [...rest2.keys()]);

// The switch: crashLoop.enabled false leaves everything as it was
load({ dungeons: { crashLoop: { enabled: false } } });
reset();
notes.set(PID1, { outcome: 'crash', at: now - 60000, endedAt: now - 61000 });
ok(login(P1) === false && moves.length === 0, 'with crashLoop.enabled false a crashed player logs in where they were', moves);

// Inside a dungeon without a claim of their own: the old move out, with its old message
load();
reset();
globalThis.__dboDungeons.leases.clear();
ok(login(P1) === true && said.some(([, t]) => /is claimed anew or rested since you left/.test(t)), 'without a claim the old move out is unchanged', said);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
