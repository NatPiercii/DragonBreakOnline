// Does private.xpBoost { mult, until } make metered work move a skill further, without widening the bucket or the daily caps?
//
//   node tests/mastery-boost-harness.js <bundled masterySystem.js>
//   (bundle with: cd fork/skymp5-server && ./node_modules/.bin/esbuild ts/systems/masterySystem.ts \
//      --bundle --platform=node --format=cjs --outfile=<out>)
//
// The boost is fork client-playtester-xpboost (masterySystem.xpBoostOf, skillPoints.applyGain's boost). A fork without it
// is reported as skipped, as the front harnesses do for a widget their client line does not have yet.
// The gameplay side that sets the property is tests/playtester-boost-harness.js.
'use strict';
const fs = require('fs');
const path = require('path');

const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests/mastery-boost-harness.js <bundled masterySystem.js>'); process.exit(2); }
if (!fs.readFileSync(path.resolve(bundle), 'utf8').includes('private.xpBoost')) {
  require('./expect')('mastery-boost', 'this fork\'s masterySystem has no private.xpBoost');
  console.log('skipped: this fork\'s masterySystem has no private.xpBoost (fork client-playtester-xpboost)');
  process.exit(0);
}
const { MasterySystem } = require(path.resolve(bundle));

let fails = 0, checks = 0;
const ok = (label, cond, got) => { checks++; if (!cond) { fails++; console.log(`  FAIL ${label}${got !== undefined ? `: got ${JSON.stringify(got)}` : ''}`); } };
const near = (a, b) => Math.abs(a - b) < 1e-6;

// skillPoints' bands (server/SKILLS_DESIGN.md): xp per unit by the level it is earned at
const BANDS = [[0, 10], [25, 5], [50, 2.5], [75, 1.25], [90, 0.5], [95, 0.25]];
const perUnit = (lv) => { let x = BANDS[0][1]; for (const [from, v] of BANDS) if (lv >= from) x = v; return x; };
const unitsAt = (s) => { let u = 0; for (let l = 0; l < s.level; l++) u += 100 / perUnit(l); return u + (s.xp || 0) / perUnit(s.level); };

const CFG = {
  pool: 300, capPerSkill: 100, seatAbove: 90, seatCount: 1, expertAbove: 75, expertCount: 3,
  transferFloor: 25, firstTouchCost: 1, bucketBurst: 20, bucketPerHour: 30,
  dailyCaps: { low: 360, expert: 180, master: 60 }, characterDaily: 1080,
};
const PLAYER = 0xff000014, OTHER = 0xff000015, NPC = 0xff0000aa;
const props = new Map();
const mp = {
  get: (id, key) => {
    if (key === 'profileId') return id === PLAYER ? 2 : id === OTHER ? 3 : -1;
    const v = props.get(`${id >>> 0}:${key}`);
    return v === undefined ? undefined : JSON.parse(v);
  },
  set: (id, key, value) => props.set(`${id >>> 0}:${key}`, JSON.stringify(value)),
  getUserByActor: () => 65535,
  getUserActor: () => 0,
  sendCustomPacket: () => { },
};
const ctx = { svr: mp };
const sys = new MasterySystem(() => { });
sys.points = CFG;
sys.skills = [{ id: 'blade', category: 'combat', label: 'Blade', title: '', description: '', tiers: [], vanillaSkills: [], counts: {}, gates: {} }];
sys.rules = { blade: { gateStations: new Set(), gatePrefixes: [] } };
sys.candidates = new Map([['hit', ['blade']]]);
sys.matches = () => true;
sys.syncRank = () => { };

const realNow = Date.now;
let clock = Date.parse('2026-10-03T06:00:00Z');
Date.now = () => clock;
const LV = 5;
const start = (actorId, extra) => mp.set(actorId, 'private.mastery', { v: 2, skills: { blade: Object.assign({ level: LV, xp: 0, lastPointAt: 0, rank: 0, granted: [], lock: 'raise' }, extra || {}) }, order: ['blade'], respecs: 0 });
const blade = (actorId) => mp.get(actorId, 'private.mastery').skills.blade;
const gained = (actorId) => unitsAt(blade(actorId)) - unitsAt({ level: LV, xp: 0 });
let target = 0;
const hitN = (actorId, n) => { for (let i = 0; i < n; i++) sys.creditActivity(ctx, { kind: 'hit', actorId, detail: { targetId: NPC + (target++ % 4096), sourceId: 0x12eb7 } }); };
const boost = (actorId, v) => mp.set(actorId, 'private.xpBoost', v);

// 1. ten fresh hits (0.5 units each): the boosted character moves twice as far on the same metered work
start(PLAYER); start(OTHER);
boost(PLAYER, { mult: 2, until: clock + 3600000 });
hitN(PLAYER, 10); hitN(OTHER, 10);
ok('plain: 10 hits = 5 units', near(gained(OTHER), 5), gained(OTHER));
ok('boosted: the same 10 hits = 10 units', near(gained(PLAYER), 10), gained(PLAYER));
ok('same work counted against the day', blade(PLAYER).spentToday === blade(OTHER).spentToday, [blade(PLAYER).spentToday, blade(OTHER).spentToday]);
ok('same bucket drained', near(blade(PLAYER).bucket.tokens, blade(OTHER).bucket.tokens), [blade(PLAYER).bucket, blade(OTHER).bucket]);

// 2. an empty bucket refuses the boosted character too: the boost buys no extra work
start(PLAYER, { bucket: { tokens: 0, at: clock } });
boost(PLAYER, { mult: 2, until: clock + 3600000 });
hitN(PLAYER, 4);
ok('empty bucket: boosted gains nothing', near(gained(PLAYER), 0), gained(PLAYER));

// 3. an hour of hard work at the bucket rate: the boosted character ends twice as far along
const hour = (actorId, on) => {
  start(actorId); boost(actorId, on ? { mult: 2, until: clock + 2 * 3600000 } : null);
  const t0 = clock;
  for (let t = 0; t < 3600; t += 10) { clock = t0 + t * 1000; hitN(actorId, 4); }
  clock = t0;
  return gained(actorId);
};
const h1 = hour(OTHER, false), h2 = hour(PLAYER, true);
ok('an hour at the bucket rate: about 50 units plain', h1 > 45 && h1 < 52, h1);
ok('the same hour boosted: twice that', near(h2, 2 * h1), [h1, h2]);

// 4. only while it runs, bounded, and odd shapes are ignored
for (const [label, v, want] of [
  ['expired', { mult: 2, until: clock - 1 }, 5], ['a bare number', 2, 5], ['no until', { mult: 2 }, 5], ['a string', 'x2', 5],
  ['mult 1', { mult: 1, until: clock + 60000 }, 5], ['mult 0.5', { mult: 0.5, until: clock + 60000 }, 5], ['mult 10 held at 3', { mult: 10, until: clock + 60000 }, 15],
]) {
  start(PLAYER); boost(PLAYER, v); hitN(PLAYER, 10);
  ok(`${label}: 10 hits = ${want} units`, near(gained(PLAYER), want), gained(PLAYER));
}

// 5. work banked on a skill not yet taken up is boosted too
props.clear();
boost(PLAYER, { mult: 2, until: clock + 3600000 });
hitN(PLAYER, 4);
ok('boosted bank: 4 hits = 4 units', near(mp.get(PLAYER, 'private.mastery').skills.blade.shadow, 4), mp.get(PLAYER, 'private.mastery').skills.blade);

Date.now = realNow;
console.log(`${checks - fails}/${checks} checks passed`);
process.exit(fails ? 1 : 0);
