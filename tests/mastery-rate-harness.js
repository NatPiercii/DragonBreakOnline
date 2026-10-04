// Does the gameplay's skill rate (globalThis.__dboSkillRate, skillrates.js) scale what metered work is worth, after the
// repeat ring, the hourly bucket and the day's caps, without letting more work through them?
//
//   node tests/mastery-rate-harness.js <bundled masterySystem.js>
//   (bundle with: cd fork/skymp5-server && ./node_modules/.bin/esbuild ts/systems/masterySystem.ts \
//      --bundle --platform=node --format=cjs --outfile=<out>)
//
// The rate is fork mastery-skill-rates (masterySystem.rateOf, skillPoints.applyGain's rate). A fork without it is reported
// as skipped. The gameplay side that answers the hook is tests/skill-rates-harness.js.
'use strict';
const fs = require('fs');
const path = require('path');

const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests/mastery-rate-harness.js <bundled masterySystem.js>'); process.exit(2); }
if (!fs.readFileSync(path.resolve(bundle), 'utf8').includes('__dboSkillRate')) {
  require('./expect')('mastery-rate', 'this fork\'s masterySystem has no __dboSkillRate hook');
  console.log('skipped: this fork\'s masterySystem has no __dboSkillRate hook (fork mastery-skill-rates)');
  process.exit(0);
}
const { MasterySystem } = require(path.resolve(bundle));

let fails = 0, checks = 0;
const ok = (label, cond, got) => { checks++; if (!cond) { fails++; console.log(`  FAIL ${label}${got !== undefined ? `: got ${JSON.stringify(got)}` : ''}`); } else console.log(`  ok   ${label}`); };
const near = (a, b) => Math.abs(a - b) < 1e-6;

const BANDS = [[0, 10], [25, 5], [50, 2.5], [75, 1.25], [90, 0.5], [95, 0.25]];
const perUnit = (lv) => { let x = BANDS[0][1]; for (const [from, v] of BANDS) if (lv >= from) x = v; return x; };
const unitsAt = (s) => { let u = 0; for (let l = 0; l < s.level; l++) u += 100 / perUnit(l); return u + (s.xp || 0) / perUnit(s.level); };

// The live pointSystem (skills.json): burst 13, 20 an hour, 240 a day below 75
const SKILLS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'skills.json'), 'utf8'));
const CFG = Object.assign({}, SKILLS.pointSystem);
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
const def = (id, category) => ({ id, category, label: id, title: '', description: '', tiers: [], vanillaSkills: [], counts: {}, gates: {} });
sys.skills = [def('miner', 'profession'), def('blade', 'combat')];
sys.rules = { miner: { gateStations: new Set([1]), gatePrefixes: [] }, blade: { gateStations: new Set(), gatePrefixes: [] } };
sys.candidates = new Map([['mine', ['miner']], ['hit', ['blade']]]);
sys.matches = () => true;
sys.syncRank = () => { };

const realNow = Date.now;
let clock = Date.parse('2026-10-04T06:00:00Z');
Date.now = () => clock;
const LV = 5;
const start = (actorId, extra) => mp.set(actorId, 'private.mastery', { v: 2, skills: { miner: Object.assign({ level: LV, xp: 0, lastPointAt: 0, rank: 0, granted: [], lock: 'raise' }, extra || {}) }, order: ['miner'], respecs: 0 });
const miner = (actorId) => mp.get(actorId, 'private.mastery').skills.miner;
const gained = (actorId) => unitsAt(miner(actorId)) - unitsAt({ level: LV, xp: 0 });
let vein = 0;
const mineN = (actorId, n) => { for (let i = 0; i < n; i++) sys.creditActivity(ctx, { kind: 'mine', actorId, detail: { refrId: 0x1000 + (vein++ % 4096), value: 0 } }); };
const calls = [];
const hook = (fn) => { globalThis.__dboSkillRate = fn; };
const byActor = (rates) => (actorId, skillId, kind, detail) => { calls.push([actorId, skillId, kind, detail]); return rates[actorId] !== undefined ? rates[actorId] : 1; };

// 1. no hook: a fresh iron vein is one unit
delete globalThis.__dboSkillRate;
start(PLAYER); mineN(PLAYER, 5);
ok('no hook: 5 veins = 5 units', near(gained(PLAYER), 5), gained(PLAYER));

// 2. x2 for one character: the same metered work moves twice as far, the bucket and the day see the same work
hook(byActor({ [PLAYER]: 2 }));
start(PLAYER); start(OTHER);
mineN(PLAYER, 5); mineN(OTHER, 5);
ok('x2: 5 veins = 10 units', near(gained(PLAYER), 10), gained(PLAYER));
ok('x1 beside it: 5 veins = 5 units', near(gained(OTHER), 5), gained(OTHER));
ok('the same work counted against the day', near(miner(PLAYER).spentToday, miner(OTHER).spentToday), [miner(PLAYER).spentToday, miner(OTHER).spentToday]);
ok('the same bucket drained', near(miner(PLAYER).bucket.tokens, miner(OTHER).bucket.tokens), [miner(PLAYER).bucket, miner(OTHER).bucket]);
const last = calls[calls.length - 1];
ok('the hook is told the actor, the skill, the kind and the detail', last[0] === OTHER && last[1] === 'miner' && last[2] === 'mine' && last[3].refrId > 0, last);

// 3. an empty bucket refuses the faster character too
start(PLAYER, { bucket: { tokens: 0, at: clock } });
mineN(PLAYER, 4);
ok('empty bucket: x2 gains nothing', near(gained(PLAYER), 0), gained(PLAYER));

// 4. a heavy miner's hour (a vein every 20 s, 180 an hour): the bucket holds both to 13 + 20 units; x2 is worth twice that
const hour = (actorId) => {
  start(actorId);
  const t0 = clock;
  for (let t = 0; t < 3600; t += 20) { clock = t0 + t * 1000; mineN(actorId, 1); }
  clock = t0;
  return gained(actorId);
};
const h1 = hour(OTHER), h2 = hour(PLAYER);
ok('a heavy hour plain: the bucket\'s 13 + 20 units', h1 > 32 && h1 < 34, h1);
ok('the same hour at x2: twice that', near(h2, 2 * h1), [h1, h2]);

// 5. answers that are not a plain rate
for (const [label, fn, want] of [
  ['a throwing hook counts as x1', () => { throw new Error('boom'); }, 5], ['NaN counts as x1', () => NaN, 5], ['a string counts as x1', () => '2', 5],
  ['undefined counts as x1', () => undefined, 5], ['x0 gains nothing', () => 0, 0], ['a negative rate is held at 0', () => -3, 0],
  ['x9 is held at x5', () => 9, 25], ['x0.5 halves it', () => 0.5, 2.5],
]) {
  hook(fn); start(PLAYER); mineN(PLAYER, 5);
  ok(`${label}: 5 veins = ${want} units`, near(gained(PLAYER), want), gained(PLAYER));
}
hook(() => 0); start(PLAYER); mineN(PLAYER, 5);
ok('x0 spends no bucket room', miner(PLAYER).bucket === undefined, miner(PLAYER).bucket);
ok('x0 spends none of the day', !(miner(PLAYER).spentToday > 0) && !(mp.get(PLAYER, 'private.mastery').spentToday > 0), [miner(PLAYER).spentToday, mp.get(PLAYER, 'private.mastery').spentToday]);
ok('x0 still counts each act in the repeat ring', (miner(PLAYER).ring || []).length === 5, miner(PLAYER).ring);
// the same vein at x0 then at x1: the x1 act is the second time, so it is worth 1/(1 + 1/8)
start(PLAYER);
hook(() => 0); sys.creditActivity(ctx, { kind: 'mine', actorId: PLAYER, detail: { refrId: 0x7777, value: 0 } });
hook(() => 1); sys.creditActivity(ctx, { kind: 'mine', actorId: PLAYER, detail: { refrId: 0x7777, value: 0 } });
ok('an act after an x0 one is still a repeat (8/9 of a unit)', near(gained(PLAYER), 8 / 9) && near(miner(PLAYER).bucket.tokens, CFG.bucketBurst - 8 / 9), [gained(PLAYER), miner(PLAYER).bucket]);

// 6. with the playtesters' boost: both apply
hook(() => 2); start(PLAYER); mp.set(PLAYER, 'private.xpBoost', { mult: 2, until: clock + 3600000 });
mineN(PLAYER, 5);
ok('x2 rate with a x2 boost: 5 veins = 20 units', near(gained(PLAYER), 20), gained(PLAYER));
mp.set(PLAYER, 'private.xpBoost', null);

// 7. work banked on a combat skill not yet taken up is rated too
props.clear();
hook((a, skillId, kind) => (skillId === 'blade' && kind === 'hit' ? 3 : 1));
for (let i = 0; i < 4; i++) sys.creditActivity(ctx, { kind: 'hit', actorId: PLAYER, detail: { targetId: NPC + i, sourceId: 0x12eb7 } });
ok('x3 bank: 4 hits = 6 units banked', near(mp.get(PLAYER, 'private.mastery').skills.blade.shadow, 6), mp.get(PLAYER, 'private.mastery').skills.blade);

// 8. an award (a skill book read, a potion brewed) is rated as kind "award" with its key
calls.length = 0;
hook(byActor({ [PLAYER]: 2 }));
start(PLAYER);
const units = sys.award(ctx, PLAYER, 'miner', 1, 0x77);
ok('award at x2: 1 unit metered, 2 gained', near(units, 1) && near(gained(PLAYER), 2), [units, gained(PLAYER)]);
ok('...asked as kind "award" with its key', calls.length === 1 && calls[0][2] === 'award' && calls[0][3].key === 0x77, calls);

delete globalThis.__dboSkillRate;
Date.now = realNow;
console.log(`${checks - fails}/${checks} checks passed`);
process.exit(fails ? 1 : 0);
