// Locked dungeon chests (Jake, 2 Oct, "Systems not working ASAP": players could not pick locks or gain Lockpicking).
// Anyone with a pick may try a Novice lock; the levels above need a Lockpicker of that tier. An untrained win fires the
// 'lock' mastery event, which masterySystem banks until it offers the skill. Real dungeons.js and Rielle's chests.
//   node tests/chest-lock-untrained-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${got !== undefined && !ok ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

const ids = new Map(); let nextId = 0x100;
const idOf = (d) => { const k = String(d).toLowerCase(); if (!ids.has(k)) ids.set(k, nextId++); return ids.get(k); };
const all = JSON.parse(fs.readFileSync(path.join(ROOT, 'dungeons.json'), 'utf8')).dungeons;
const hasDoor = (d) => (d.entrances || []).some((e) => e && (e.doorPos || e.pos) && e.outsideDesc && e.insideCell);
const RIELLE = all.find((d) => d.id === 'CYRRielleLocation');
const OTHER = all.find((d) => d.id !== 'CYRRielleLocation' && hasDoor(d) && !(d.entrances || []).some((e) => e && e.expedition));
if (!RIELLE || !hasDoor(RIELLE) || !OTHER) { console.log('FAIL  Rielle (with a door) or a second dungeon is missing from dungeons.json'); process.exit(1); }
const doorOf = (d) => d.entrances.find((e) => e && (e.doorPos || e.pos) && e.outsideDesc && e.insideCell);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-jake-chestlock-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
for (const f of ['loot.json', 'ayleid-loot.json', 'dungeon-pools.json']) if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), f);
fs.writeFileSync('expeditions.json', JSON.stringify({ expeditions: [] }));
fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [RIELLE, OTHER] }));

let now = 1_790_000_000_000;
Date.now = () => now;
const timers = [];
global.setTimeout = (fn, ms) => { timers.push({ fn, at: now + (ms || 0) }); return timers.length; };
const advance = (ms) => { now += ms; for (let i = 0; i < 20; i++) { const due = timers.filter((t) => !t.done && t.at <= now); if (!due.length) return; for (const t of due) { t.done = true; t.fn(); } } };

const A = 0xff000101, B = 0xff000102, C = 0xff000103;
const PROFILE = { [A]: 1, [B]: 2, [C]: 3 };
let online = [A, B, C];
const props = new Map(), said = [], ui = new Map();
const home = (a, d) => { const e = doorOf(d); props.set(`${a}|worldOrCellDesc`, e.world || e.cell); props.set(`${a}|pos`, e.doorPos || e.pos); };
const inside = (a, d) => { const v = props.get(`${a}|locationalData`); return !!(v && String(v.cellOrWorldDesc).toLowerCase() === String(doorOf(d).insideCell).toLowerCase()); };
const saidTo = (a) => said.filter(([x]) => x === a).map(([, t]) => t);
const cfgFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'gamemode-config.json'), 'utf8'));
let ST = null;
const load = (extra) => {
  delete require.cache[require.resolve(path.join(ROOT, 'dungeons.js'))];
  globalThis.__dboDungeons = undefined; globalThis.__dboDungeonAccountRest = undefined;
  ui.clear();
  for (const t of timers) t.done = true;   // a reload drops the last case's pending turns
  require(path.join(ROOT, 'dungeons.js'))({
    mp: { get: (id, p) => (p === 'profileId' ? (PROFILE[id] ?? -1) : props.get(`${id}|${p}`)), set: (id, p, v) => props.set(`${id}|${p}`, v), getIdFromDesc: idOf,
      lookupEspmRecordById: () => ({ record: null }) },
    log: () => {}, personal: (a, t) => said.push([a, t]), system: (a, t) => said.push([a, t]), audit: () => {},
    registerChatCommand: () => {}, onUi: (n, fn) => { const l = ui.get(n) || []; l.push(fn); ui.set(n, l); },
    openWidget: () => true, closeWidget: () => true, sendPacket: () => true, findByName: () => 0, display: String, who: String,
    profileOf: (a) => PROFILE[a] ?? -1, nameOf: () => 'P', onlineActors: () => online, isAdmin: () => false,
    giveItem: () => true, cfg: { dungeons: Object.assign({}, cfgFile.dungeons || {}, extra || {}) }, every: () => {},
  });
  ST = globalThis.__dboDungeons;
  ST.parties.set(1, { leader: 1, leaderName: 'P', members: new Set([1, 2, 3]) });
  for (const m of [1, 2, 3]) ST.memberOf.set(m, 1);
};
const arrived = [];   // ruinbuttons.js plays a ruin's opened stair for each late entrant
globalThis.__dboRuinArrived = (id, a) => { arrived.push([id, a]); return 1; };
const arrivedIn = (a, d) => arrived.some(([id, x]) => id === d.id && x === a);
const fire = (n, a, args) => (ui.get(n) || []).forEach((f) => f(a, args, 0));
const claim = (d) => {
  for (const a of [A, B, C]) { home(a, d); props.delete(`${a}|locationalData`); }
  globalThis.__dboDungeonActivate(idOf(doorOf(d).outsideDesc), A);
  const pend = ST.pending.get(A);
  if (pend) fire('dungeonClaim', A, [pend.nonce, 'normal']);
  return ST.leases.get(d.id) || null;
};
const door = (a, d) => globalThis.__dboDungeonActivate(idOf(doorOf(d).outsideDesc), a);


const chests = RIELLE.chests || [];
if (chests.length < 2) { console.log('FAIL  Rielle has fewer than 2 chests in dungeons.json'); process.exit(1); }
const CH = idOf(chests[0].ref), CH2 = idOf(chests[1].ref);
const begun = [], events = [];
globalThis.__alduinakMasteryEvent = (kind, a, d) => events.push([kind, a, d && d.level]);
const lockpickStub = { busy: () => false, begin: (a, o) => { begun.push(Object.assign({ a }, o)); return true; } };
const asLockpicker = (a, rank) => props.set(`${a}|private.mastery`, { order: ['blade', 'lockpicking'], skills: { lockpicking: { rank, level: 1 } } });
const untrained = (a) => props.set(`${a}|private.mastery`, { order: ['blade', 'miner', 'cook'], skills: {} });
const open = (a, id) => globalThis.__dboDungeonActivate(id, a);

load({ entryStagger: { enabled: false } });
let lease = claim(RIELLE);
globalThis.__dboLockpick = lockpickStub;
check('the party claims Rielle', !!lease && inside(A, RIELLE));

// 1. Untrained, Novice lock: the tumblers open for them
untrained(A); lease.locked.set(CH, 0); said.length = 0; begun.length = 0;
check('an untrained player may try a Novice lock: the lock opens for them to pick', open(A, CH) === false && begun.length === 1 && begun[0].level === 0 && begun[0].target === CH, { begun, said: saidTo(A) });
check('...and is not told only a Lockpicker can open it', !saidTo(A).some((t) => /Only a Lockpicker|untrained hand/.test(t)), saidTo(A));
if (begun[0]) begun[0].onSuccess(A);
check('a win unlocks the chest for the party', lease.unlocked.has(CH) && saidTo(A).some((t) => /Novice lock gives way/.test(t)), saidTo(A).slice(-1));
check('...and the next use opens it', open(A, CH) === null);

// 2. Untrained, a harder lock: refused, pointed at the skill
lease.locked.set(CH2, 2); said.length = 0; begun.length = 0;
check('an untrained player is refused an Adept lock, and told how to go further', open(A, CH2) === false && begun.length === 0 && saidTo(A).some((t) => /locked \(Adept\)\. An untrained hand can only try Novice locks: take up Lockpicking in your skills \(K\)/.test(t)), saidTo(A));

// 3. A Lockpicker below the lock's tier is refused as before; at or above it, may try
asLockpicker(A, 1); said.length = 0; now += 60000;   // deny() says a line once a while
check('a tier-2 Lockpicker is refused an Adept lock (tier 3 needed)', open(A, CH2) === false && begun.length === 0 && saidTo(A).some((t) => /not yet up to it \(tier 3 needed\)/.test(t)), saidTo(A));
asLockpicker(A, 2);
check('a tier-3 Lockpicker may try it', open(A, CH2) === false && begun.length === 1 && begun[0].level === 2);

// 4. The fallback roll (lockpick.js not loaded): an untrained Novice win fires the 'lock' mastery event
globalThis.__dboLockpick = null; untrained(A); lease.locked.set(CH2, 0); lease.unlocked.delete(CH2); said.length = 0;
const rnd = Math.random; Math.random = () => 0;
const r = open(A, CH2);
Math.random = rnd;
check('without lockpick.js an untrained Novice pick can still win, and is credited to Lockpicking', r === true && lease.unlocked.has(CH2) && events.some(([k, a, l]) => k === 'lock' && a === A && l === 0), { r, events });

// 5. Only the claiming party
props.delete(`${B}|private.mastery`); lease.members.delete(2); lease.locked.set(CH, 0); lease.unlocked.delete(CH); said.length = 0;
globalThis.__dboLockpick = lockpickStub; begun.length = 0;
check('someone outside the claiming party still cannot touch its chests', open(B, CH) === false && begun.length === 0 && saidTo(B).some((t) => /belongs to the party that claimed/.test(t)), saidTo(B));

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
