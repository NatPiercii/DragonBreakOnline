// Scripted test for character creation in the Realm (2026-09-30, for the launch):
//   1. worldclock.js sends a player in character creation the noon nearest now (the Realm's Sovngarde climate is dark
//      20:30-05:30 game time, and the world clock made the creator dark for 1.5 of every 4 real hours). Only that
//      player's packet changes: the clock, night, the moons and every server-side reader stay as they were.
//   2. gamemode.js spreads new characters over 19 checked spots around the Realm marker before RaceMenu opens, so
//      nobody is made standing inside someone else (Nate).
// Run it from this folder's parent with
//
//   node tests/creator-light-spread-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const home = process.cwd();
const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-creator-'));
process.chdir(dir);

// ---- 1. the clock ----
const CREATOR = 0x14, PLAYER = 0x15;
let creating = new Set([CREATOR]);
const sent = [];
const timers = {};
const loadClock = (cfg, inCreator) => {
  delete require.cache[path.join(root, 'worldclock.js')];
  delete globalThis.__dboWorldClock;
  require(path.join(root, 'worldclock.js'))({
    mp: {}, log: () => {}, personal: () => {}, system: () => {}, registerChatCommand: () => {}, sendPacket: (a, p) => sent.push([a, p]),
    onlineActors: () => [CREATOR, PLAYER], every: (n, ms, fn) => { timers[n] = fn; }, zoneOfActor: () => 'bruma', audit: () => {}, who: String, cfg: cfg || {},
    inCreator: inCreator === undefined ? (a) => creating.has(a) : inCreator,
  });
  return globalThis.__dboClock;
};
const realNow = Date.now;
let now = 1_800_000_000_000;
Date.now = () => now;
let clock = loadClock();
const setHour = (h) => { const ST = globalThis.__dboWorldClock; ST.epochRealMs = now; ST.epochGameDays = 1000 + h / 24; };
const lastTo = (a) => sent.filter(([x]) => x === a).map(([, p]) => p).pop();
const hourOf = (d) => Math.round(((d - Math.floor(d)) * 24) * 100) / 100;

setHour(1.6);
clock.sendTo(CREATOR); clock.sendTo(PLAYER);
check('at 01:36 a player in character creation is sent noon', hourOf(lastTo(CREATOR).gameDays) === 12 && lastTo(CREATOR).timeScale === 1, lastTo(CREATOR));
check('...the nearest noon, the same day (10.4 hours on)', Math.floor(lastTo(CREATOR).gameDays) === 1000);
check('everyone else gets the real clock and its timescale', hourOf(lastTo(PLAYER).gameDays) === 1.6 && lastTo(PLAYER).timeScale === 6, lastTo(PLAYER));
check('the server-side clock is untouched: still night at 01:36', Math.round(clock.hour() * 10) / 10 === 1.6 && clock.isNight() === true);
check('the weather goes to the creator as before', lastTo(CREATOR).weather === lastTo(PLAYER).weather);
setHour(21.6);
clock.sendTo(CREATOR);
check('at 21:36 the nearest noon is 9.6 hours back, the same day', hourOf(lastTo(CREATOR).gameDays) === 12 && Math.floor(lastTo(CREATOR).gameDays) === 1000);
setHour(23.9);
clock.sendTo(CREATOR);
check('at 23:54 the nearest noon is 11.9 hours back: never more than 12 either way', Math.floor(lastTo(CREATOR).gameDays) === 1000 && hourOf(lastTo(CREATOR).gameDays) === 12);
setHour(12.1);
clock.sendTo(CREATOR);
check('at 12:06 it is that noon, 6 minutes back', Math.floor(lastTo(CREATOR).gameDays) === 1000 && hourOf(lastTo(CREATOR).gameDays) === 12);
sent.length = 0;
timers.worldClock();
check('the broadcast sends the same: noon to the creator, the clock to the rest', hourOf(lastTo(CREATOR).gameDays) === 12 && hourOf(lastTo(PLAYER).gameDays) === 12.1);
creating = new Set();
clock.sendTo(CREATOR);
check('once out of creation the real clock again', hourOf(lastTo(CREATOR).gameDays) === 12.1 && lastTo(CREATOR).timeScale === 6);
clock = loadClock({ worldClock: { creatorHour: -1 } });
creating = new Set([CREATOR]);
setHour(2);
clock.sendTo(CREATOR);
check('worldClock.creatorHour -1 turns it off', hourOf(lastTo(CREATOR).gameDays) === 2);
clock = loadClock({}, () => { throw new Error('boom'); });
setHour(2);
clock.sendTo(CREATOR);
check('a creator test that throws sends the real clock', hourOf(lastTo(CREATOR).gameDays) === 2);
clock = loadClock({}, null);
setHour(2);
clock.sendTo(CREATOR);
check('no creator test (an older gamemode) sends the real clock', hourOf(lastTo(CREATOR).gameDays) === 2);

// ---- 2. the spots ----
const gm = fs.readFileSync(path.join(root, 'gamemode.js'), 'utf8');
const a0 = gm.indexOf('const CREATOR_SPOTS = ');
const b0 = gm.indexOf('// New characters spawn straight into the hub.', a0);
if (a0 < 0 || b0 < 0) { console.log('FAIL the creator spot markers are gone from gamemode.js'); process.exit(1); }
const HUB = { cellOrWorldDesc: '17482:DragonBreak Hub.esp', pos: [2122.2, 2079.6, 3], rot: [0, 0, 22.9] };
const pos = new Map(), inHubSet = new Set(), moves = [], opened = [];
let online = [];
const creationMap = new Map();
delete globalThis.__dboCreatorSpots; delete globalThis.__dboCreatorPlacedAt;
const S = new Function('HUB', 'mp', 'onlineActors', 'inHub', 'log', 'creationPending', 'creation', 'setFade', 'display', 'globalThis',
  gm.slice(a0, b0) + '\nreturn { CREATOR_SPOTS, CREATOR_SPACING, CREATOR_PLACE_MS, creatorSpotFor, placeInCreatorSpot, creatorSpotRelease, openCreator, creatorPlacedAt };')(
  HUB,
  { get: (a, k) => (k === 'pos' ? pos.get(a) : k === 'isOnline' ? true : undefined), set: (a, k, v) => { if (k === 'locationalData') { moves.push([a, v]); pos.set(a, v.pos.slice()); } },
    setRaceMenuOpen: (a, on) => { if (on) opened.push(a); } },
  () => online, (a) => inHubSet.has(a), () => {}, () => true, creationMap, () => {}, String, globalThis);

const spots = S.CREATOR_SPOTS;
check('19 spots: the marker, a ring of 6 and a ring of 12', spots.length === 19 && spots[0].join() === HUB.pos.join());
let minPair = Infinity, maxR = 0;
for (let i = 0; i < spots.length; i++) {
  maxR = Math.max(maxR, Math.hypot(spots[i][0] - HUB.pos[0], spots[i][1] - HUB.pos[1]));
  for (let j = i + 1; j < spots.length; j++) minPair = Math.min(minPair, Math.hypot(spots[i][0] - spots[j][0], spots[i][1] - spots[j][1]));
}
check('every two spots are at least 1.5 m (105 units) apart', minPair >= S.CREATOR_SPACING, Math.round(minPair));
check('all within 240 units of the marker (the checked flat ground reaches 300)', maxR <= 241 && spots.every((s) => s[2] === 3), Math.round(maxR));

const arrive = (a) => { online.push(a); inHubSet.add(a); pos.set(a, HUB.pos.slice()); };
now = 2_000_000_000_000;
arrive(1);
check('the first arrival stays on the marker, with no move', S.placeInCreatorSpot(1) === false && moves.length === 0);
arrive(2);
check('the second is moved off the first', S.placeInCreatorSpot(2) === true && moves.length === 1 && Math.hypot(pos.get(2)[0] - pos.get(1)[0], pos.get(2)[1] - pos.get(1)[1]) >= 105, pos.get(2));
check('...inside the Realm, facing the marker\'s way', moves[0][1].cellOrWorldDesc === HUB.cellOrWorldDesc && moves[0][1].rot.join() === HUB.rot.join());
// The third arrives before the second's move has landed on the server: the promised spot is still skipped
pos.set(2, HUB.pos.slice());
arrive(3);
S.placeInCreatorSpot(3);
check('a spot promised to someone whose move has not landed is not given again', moves[1][1].pos.join() !== moves[0][1].pos.join(), [moves[0][1].pos, moves[1][1].pos]);
pos.set(2, moves[0][1].pos.slice());
for (let i = 4; i <= 19; i++) { arrive(i); S.placeInCreatorSpot(i); }
const taken = [1, 2, 3].concat(Array.from({ length: 16 }, (_, i) => i + 4)).map((a) => pos.get(a).map(Math.round).join());
check('19 arrivals take 19 different spots', new Set(taken).size === 19, new Set(taken).size);
let closest = Infinity;
const ids = Array.from({ length: 19 }, (_, i) => i + 1);
for (const x of ids) for (const y of ids) if (x < y) closest = Math.min(closest, Math.hypot(pos.get(x)[0] - pos.get(y)[0], pos.get(x)[1] - pos.get(y)[1]));
check('...nobody within 1.5 m of anybody', closest >= 105, Math.round(closest));
arrive(20);
S.placeInCreatorSpot(20);
check('a 20th still gets a spot (the least crowded), not a crash', Array.isArray(pos.get(20)) && spots.some((s) => s.join() === pos.get(20).join()));
S.creatorSpotRelease(2);
online = online.filter((a) => a !== 2); inHubSet.delete(2);
arrive(21);
S.placeInCreatorSpot(21);
check('a spot left behind is handed out again', pos.get(21).join() === moves[0][1].pos.join(), pos.get(21));

// The creator opens after the move has landed, never during it
creationMap.clear(); opened.length = 0;
S.creatorPlacedAt.set(30, now);
S.openCreator(30);
check('RaceMenu does not open while a spot move is landing', opened.length === 0);
now += S.CREATOR_PLACE_MS;
S.openCreator(30);
check('...and opens once it has landed', opened.includes(30));

// ---- 3. the wiring in gamemode.js ----
const arrived = gm.slice(gm.indexOf("onUi('arrived'"), gm.indexOf("onUi('arrived'") + 1200);
check('on arriving in the hub the character is placed first, then RaceMenu opens after the landing time', /if \(placeInCreatorSpot\(a\)\) \{\s*creation\.set\(a, 'placed'\);\s*setTimeout\(\(\) => \{ creatorPlacedAt\.delete\(a >>> 0\); openCreator\(a\); \}, CREATOR_PLACE_MS\);/.test(arrived));
const toArrival = gm.slice(gm.indexOf('const sendToArrival = '), gm.indexOf('const sendToArrival = ') + 1400);
check('leaving the Realm frees the spot and sends the real clock at once', /creatorSpotRelease\(a\);/.test(toArrival) && /__dboClock\.sendTo\(a\)/.test(toArrival) && toArrival.indexOf('creation.delete(a)') < toArrival.indexOf('__dboClock.sendTo(a)'));
check('the clock asks the gamemode who is in creation (a reconnect mid-creation is still pending)', /inCreator: \(a\) => creationPending\(a\) \|\| \(creation\.has\(a >>> 0\) && inHub\(a\)\)/.test(gm));

Date.now = realNow;
process.chdir(home);
fs.rmSync(dir, { recursive: true, force: true });
delete globalThis.__dboCreatorSpots; delete globalThis.__dboCreatorPlacedAt; delete globalThis.__dboWorldClock; delete globalThis.__dboClock;
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
