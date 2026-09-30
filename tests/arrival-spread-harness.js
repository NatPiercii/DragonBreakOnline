// Scripted test for the Pale Pass arrival spread in gamemode.js (2026-09-30): a new character leaving the Realm lands on
// the first free one of 8 measured spots at the arrival (tools/arrival_spots.py --observed), not all on one point, and
// a landing moved in config falls back to that one point. It cuts the spot picker and the arrival code out of the
// gamemode and runs them with a fake mp. Run it from this folder's parent with
//
//   node tests/arrival-spread-harness.js
'use strict';
const fs = require('fs');
const path = require('path');

const gm = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const cutFrom = (src, from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a); if (a < 0 || b < 0) { console.log(`FAIL marker gone: ${from}`); process.exit(1); } return src.slice(a, b); };
const slices = (src) => ({ picker: cutFrom(src, 'const spotPicker = ', 'const creatorSpotHolds'), arrival: cutFrom(src, 'const ARRIVAL_MARKER = ', 'const sendToArrival = ') });
const NEW = slices(gm);

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

const WORLD = 'a764b:BSHeartland.esm';
const pos = new Map(), world = new Map(), offline = new Set(), deleted = new Set();
let online = [];
const fakeMp = { get: (a, k) => {
  if (deleted.has(a)) throw new Error('no such form');
  return k === 'pos' ? pos.get(a) : k === 'worldOrCellDesc' ? world.get(a) : k === 'isOnline' && offline.has(a) ? false : undefined;
} };
// keep: a hot reload, over the holds the loaded code built
const loadFrom = (code, landing, keep) => {
  if (!keep) delete globalThis.__dboArrivalSpotHolds;
  const LANDING = Object.assign({ world: WORLD, pos: [48236.2, 260600.4, 20405.1], angleZ: 135, radius: 2500 }, landing || {});
  const LANDING_LOC = { cellOrWorldDesc: LANDING.world, pos: LANDING.pos, rot: [0, 0, Number(LANDING.angleZ) || 135] };
  return new Function('mp', 'onlineActors', 'LANDING', 'LANDING_LOC', 'globalThis', code.picker + code.arrival + '\nreturn { ARRIVAL_SPOTS, arrivalLocFor, LANDING_LOC };')(
    fakeMp, () => online, LANDING, LANDING_LOC, globalThis);
};
const load = (landing) => loadFrom(NEW, landing);
const realNow = Date.now;
let now = 2_100_000_000_000;
Date.now = () => now;

let A = load();
const spots = A.ARRIVAL_SPOTS;
check('8 spots, the marker first', spots.length === 8 && spots[0][0] === 48236.2 && spots[0][1] === 260600.4 && spots[0][2] === 20405.1);
let minPair = Infinity, maxR = 0;
for (let i = 0; i < spots.length; i++) {
  maxR = Math.max(maxR, Math.hypot(spots[i][0] - spots[0][0], spots[i][1] - spots[0][1]));
  for (let j = i + 1; j < spots.length; j++) minPair = Math.min(minPair, Math.hypot(spots[i][0] - spots[j][0], spots[i][1] - spots[j][1]));
}
check('every two spots are at least 1.5 m (105 units) apart', minPair >= 105, Math.round(minPair));
check('all within 8 m (560 units) of the marker, down the road', maxR <= 560, Math.round(maxR));
const survey = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'tools', 'arrival_spots.json'), 'utf8'));
check('the spots are the survey\'s own output (tools/arrival_spots.json)', JSON.stringify(survey.spots) === JSON.stringify(spots), survey.spots);

// Arrivals: each lands where nobody stands
const land = (a) => { const loc = A.arrivalLocFor(a); online.push(a); world.set(a, loc.cellOrWorldDesc); pos.set(a, loc.pos.slice()); return loc; };
const first = land(1);
check('the first lands on the marker, in the Cyrodiil world, facing down the road', first.pos.join() === spots[0].join() && first.cellOrWorldDesc === WORLD && first.rot.join() === '0,0,135', first);
for (let i = 2; i <= 8; i++) land(i);
const taken = new Set(Array.from({ length: 8 }, (_, i) => pos.get(i + 1).join()));
check('8 arrivals land on 8 different spots', taken.size === 8, taken.size);
const ninth = land(9);
check('a 9th still lands on a checked spot (the least crowded)', spots.some((s) => s.join() === ninth.pos.join()));
// Somebody in another world standing on those coordinates does not count
online = [20]; world.set(20, '17482:DragonBreak Hub.esp'); pos.set(20, spots[0].slice());
now += 60000;
check('a player in another world at the same coordinates is no obstacle', A.arrivalLocFor(21).pos.join() === spots[0].join());
// A promised spot is not handed out again while that arrival is on its way (20 s)
online = [];
const p1 = A.arrivalLocFor(30).pos.join();
const p2 = A.arrivalLocFor(31).pos.join();
check('two arrivals in the same instant get different spots', p1 !== p2, [p1, p2]);
now += 20001;
check('the promise lapses after 20 s', A.arrivalLocFor(32).pos.join() === spots[0].join());

// An overflow at the arrival: 12 characters leaving the Realm inside 20 s, none of them landed yet
A = load();
online = []; now += 60000;
const burst = [];
for (let i = 0; i < 12; i++) { now += 1000; burst.push(spots.findIndex((s) => s.join() === A.arrivalLocFor(200 + i).pos.join())); }
const bc = new Map(); for (const i of burst) bc.set(i, (bc.get(i) || 0) + 1);
check('12 arrivals in 12 s: the first 8 take all 8 spots', new Set(burst.slice(0, 8)).size === 8, burst);
check('...the other 4 double 4 different spots, never a third', [...bc.values()].filter((n) => n === 2).length === 4 && Math.max(...bc.values()) === 2, [...bc.entries()]);

// A landing moved in config: the one configured point, as before
A = load({ pos: [60000, 200000, 1000] });
const moved = A.arrivalLocFor(40);
check('a landing moved in config falls back to that one point', moved === A.LANDING_LOC && moved.pos.join() === '60000,200000,1000');
A = load({ world: '6ade1:BSHeartland.esm' });
check('...and so does a landing in another world', A.arrivalLocFor(41) === A.LANDING_LOC);

// Holds do not pile up: each pick drops the expired ones and those whose player is gone (review of release-1004)
const holds = () => globalThis.__dboArrivalSpotHolds;
A = load();
online = [];
now += 60000;
for (let i = 50; i < 58; i++) A.arrivalLocFor(i);
check('8 arrivals inside 20 s hold 8 spots', holds().size === 8 && new Set([...holds().values()].map((h) => h.i)).size === 8, holds().size);
now += 20001;
A.arrivalLocFor(60);
check('after they expire, the next pick leaves only its own hold', holds().size === 1 && holds().has(60), [...holds().keys()]);
A.arrivalLocFor(61);
offline.add(61);
const afterOffline = A.arrivalLocFor(62).pos.join();
check('the hold of a player who went offline is dropped and their spot is free again', !holds().has(61) && afterOffline === spots[1].join() && holds().has(60), [...holds().keys()]);
A.arrivalLocFor(63);
deleted.add(63);
A.arrivalLocFor(64);
check('...and so is the hold of a character that no longer exists', !holds().has(63) && holds().has(64));
holds().set(65, null);
holds().set(66, { i: 2 });
A.arrivalLocFor(67);
check('a malformed hold is dropped, not read', !holds().has(65) && !holds().has(66));
offline.clear(); deleted.clear();

// Live-then-new: release-1004 (2a7d6dd1) builds the holds, then this code is loaded over the same globalThis
let liveSrc = null;
try { liveSrc = require('child_process').execFileSync('git', ['show', '2a7d6dd1:gamemode.js'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { liveSrc = null; }
if (!liveSrc) console.log('skip live-then-new: release-1004 (2a7d6dd1) is not in this repository');
else {
  const LIVE = loadFrom(slices(liveSrc));
  now += 60000;
  for (let i = 70; i < 75; i++) LIVE.arrivalLocFor(i);
  now += 25000;
  LIVE.arrivalLocFor(75);
  LIVE.arrivalLocFor(76);
  check('release-1004 keeps every hold (7 here, 5 of them expired)', holds().size === 7, holds().size);
  const liveMap = holds();
  const NEWA = loadFrom(NEW, null, true);
  check('the new code takes over the same map', holds() === liveMap);
  const taken = [liveMap.get(75).i, liveMap.get(76).i];
  const p77 = NEWA.arrivalLocFor(77).pos.join();
  check('the new code honours the live code\'s unexpired holds', !taken.some((i) => spots[i].join() === p77), p77);
  check('...and drops the live code\'s expired ones on its first pick', holds().size === 3 && [75, 76, 77].every((a) => holds().has(a)), [...holds().keys()]);
}

// Wiring
const toArrival = gm.slice(gm.indexOf('const sendToArrival = '), gm.indexOf('const sendToArrival = ') + 1400);
check('sendToArrival lands the character through arrivalLocFor', /mp\.set\(a, 'locationalData', arrivalLocFor\(a\)\);/.test(toArrival) && !/locationalData', LANDING_LOC\)/.test(toArrival));
check('the hub spread uses the same picker', /const creatorSpots = spotPicker\(\{ spots: CREATOR_SPOTS, holds: creatorSpotHolds/.test(gm));

Date.now = realNow;
delete globalThis.__dboArrivalSpotHolds;
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
