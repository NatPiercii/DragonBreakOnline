// Until client 0.3.75 a party enters Niryastare, Bawn and Rielle one at a time, entryStagger.seconds (30) apart
// (crash-wave-1001 §7.2; Jake, 2026-10-01): party members loading in together crashed, solo claims never did. Real
// dungeons.js and the real Rielle entry of dungeons.json, beside one dungeon the stagger does not cover.
//   node tests/ruin-stagger-harness.js   (from server/)
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
// A second dungeon that can be claimed: not one config dungeons.exclude leaves out (the SurWR rat cellar since 8 Oct)
const EXCLUDED = new Set(((JSON.parse(fs.readFileSync(path.join(ROOT, 'gamemode-config.json'), 'utf8')).dungeons || {}).exclude) || []);
const OTHER = all.find((d) => d.id !== 'CYRRielleLocation' && hasDoor(d) && !EXCLUDED.has(d.id) && !(d.entrances || []).some((e) => e && e.expedition));
if (!RIELLE || !hasDoor(RIELLE) || !OTHER) { console.log('FAIL  Rielle (with a door) or a second dungeon is missing from dungeons.json'); process.exit(1); }
const doorOf = (d) => d.entrances.find((e) => e && (e.doorPos || e.pos) && e.outsideDesc && e.insideCell);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-jake-bugs-stagger-'));
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

// 1. Rielle: the claimer goes in at once, the others 30 s and 60 s later, each told when
load();
said.length = 0;
let lease = claim(RIELLE);
check('the party leader claims Rielle and goes in at once', !!lease && inside(A, RIELLE), saidTo(A));
check('the second member waits and is told: 30 s', !inside(B, RIELLE) && saidTo(B).some((t) => /entering Rielle one at a time: you go in 30 s/.test(t)), saidTo(B));
check('the third member waits and is told: 60 s', !inside(C, RIELLE) && saidTo(C).some((t) => /you go in 60 s/.test(t)), saidTo(C));
advance(29000);
check('29 s on, nobody else has gone in', !inside(B, RIELLE) && !inside(C, RIELLE));
// The waiting member tries the door early: refused, with the wait
now += 0;
check('the second member using the door early is refused', door(B, RIELLE) === false && saidTo(B).some((t) => /you go in 1 s/.test(t)), saidTo(B).slice(-1));
advance(1000);
check('at 30 s the second member goes in', inside(B, RIELLE) && !inside(C, RIELLE));
advance(30000);
check('at 60 s the third goes in', inside(C, RIELLE));
check('each member let in at their turn is shown what the party already opened', arrivedIn(B, RIELLE) && arrivedIn(C, RIELLE), arrived);

// 2. A queued member who logs out, leaves the party, or whose claim ends is not moved
load(); lease = claim(RIELLE);
online = [A, B];
advance(61000);
check('a queued member who logged out is not moved in', !inside(C, RIELLE));
online = [A, B, C];
load(); lease = claim(RIELLE);
ST.parties.get(1).members.delete(2); ST.memberOf.delete(2);
advance(31000);
check('a queued member who left the party is not moved in, and is told the door decides', !inside(B, RIELLE) && saidTo(B).some((t) => /Your turn to enter Rielle has come/.test(t)), saidTo(B).slice(-1));
load(); lease = claim(RIELLE);
ST.leases.delete(RIELLE.id);
advance(61000);
check('when the claim ends first, nobody queued is moved in', !inside(B, RIELLE) && !inside(C, RIELLE));

// 3. A member who walked away misses their turn; they may use the door once the gap since the last entry has passed
load(); lease = claim(RIELLE);
props.set(`${B}|pos`, [0, 0, 0]); props.set(`${B}|worldOrCellDesc`, 'elsewhere');
advance(31000);
check('a queued member who walked off is told to use the entrance', !inside(B, RIELLE) && saidTo(B).some((t) => /Your turn to enter Rielle has come/.test(t)), saidTo(B).slice(-1));
advance(30000);   // C goes in at their turn
home(B, RIELLE);
check('...the door still makes them wait 30 s after that entry', door(B, RIELLE) === false && saidTo(B).some((t) => /you go in 30 s/.test(t)), saidTo(B).slice(-1));
advance(30000);
arrived.length = 0;
check('...and then lets them in', door(B, RIELLE) === true);
check('...showing them what the party already opened', arrivedIn(B, RIELLE), arrived);

// 4. A dungeon the stagger does not cover: everyone goes in together, as before
load(); said.length = 0;
lease = claim(OTHER);
check(`${OTHER.name} (not in entryStagger.ids): the whole party goes in at once`, !!lease && inside(A, OTHER) && inside(B, OTHER) && inside(C, OTHER));

// 5. The switch: entryStagger.enabled false leaves Rielle as it was
load({ entryStagger: { enabled: false } });
lease = claim(RIELLE);
check('with entryStagger.enabled false the party goes into Rielle together', !!lease && inside(A, RIELLE) && inside(B, RIELLE) && inside(C, RIELLE));

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
