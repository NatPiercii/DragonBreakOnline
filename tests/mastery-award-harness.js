// masterySystem's award (globalThis.__alduinakMasteryAward): work the gameplay judged for one held skill, inside the
// Wheel's limits. manuals.js uses it for smithing skill books (Nate, 2026-09-30), since no activity kind reaches
// Blacksmith away from a forge. A held skill gains and the units come back; a skill not held, an unknown skill or an NPC
// gains nothing; the same key again counts less; the hourly bucket stops it.
//
//   node tests/mastery-award-harness.js <bundled masterySystem.js>
//
// A masterySystem without the award has nothing to test, which is said and not failed.
'use strict';
const fs = require('fs');
const path = require('path');

const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests/mastery-award-harness.js <bundled masterySystem.js>'); process.exit(2); }
const SRC = fs.readFileSync(bundle, 'utf8');
if (!/__alduinakMasteryAward/.test(SRC)) { require('./expect')('mastery-award', 'this masterySystem has no award'); console.log('ok   skipped: this masterySystem has no award'); process.exit(0); }
const { MasterySystem } = require(path.resolve(bundle));

let fails = 0;
const ok = (label, cond, got) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && got !== undefined ? `: got ${JSON.stringify(got)}` : ''}`); if (!cond) fails++; };

const SMITH = 0xff000014, SCHOLAR = 0xff000015, PLAIN = 0xff000016, BOOSTED = 0xff000017, LAPSED = 0xff000018, NPC = 0xff0000aa, USER = 7;
const PLAYERS = new Set([SMITH, SCHOLAR, PLAIN, BOOSTED, LAPSED]);
const props = new Map();
const notices = [];
const mp = {
  get: (id, key) => {
    if (key === 'profileId') return PLAYERS.has(id >>> 0) ? 2 : -1;
    const v = props.get(`${id >>> 0}:${key}`);
    return v === undefined ? undefined : JSON.parse(v);
  },
  set: (id, key, value) => props.set(`${id >>> 0}:${key}`, JSON.stringify(value)),
  getUserByActor: () => USER,
  getUserActor: () => SMITH,
  sendCustomPacket: (u, s) => { const p = JSON.parse(s); if (p.customPacketType === 'masteryNotice') notices.push(p.text); },
};
const ctx = { svr: mp };
const sys = new MasterySystem(() => { });
sys.points = { pool: 300, capPerSkill: 100, seatAbove: 90, seatCount: 1, expertAbove: 75, expertCount: 3, transferFloor: 25, firstTouchCost: 1,
  bucketBurst: 20, bucketPerHour: 30, dailyCaps: { low: 360, expert: 180, master: 60 }, characterDaily: 1080 };
sys.skills = ['blacksmith', 'scholar'].map((id) => ({ id, category: 'profession', label: id === 'blacksmith' ? 'Blacksmith' : 'Scholar', title: '', description: '', tiers: [], vanillaSkills: [], counts: {}, gates: {} }));
sys.rules = {};
mp.set(SMITH, 'private.mastery', { v: 2, order: ['blacksmith'], skills: { blacksmith: { level: 10, xp: 0, rank: 0 } } });
mp.set(SCHOLAR, 'private.mastery', { v: 2, order: ['scholar'], skills: { scholar: { level: 10, xp: 0, rank: 0 } } });
const smithXp = () => { const s = mp.get(SMITH, 'private.mastery').skills.blacksmith; return s.level * 100 + s.xp; };

const BOOK = 0x1afce;
let before = smithXp();
const u1 = sys.award(ctx, SMITH, 'blacksmith', 3, BOOK);
ok('a held Blacksmith is credited, and the units come back', u1 > 0 && smithXp() > before, [u1, before, smithXp()]);
before = smithXp();
const u2 = sys.award(ctx, SMITH, 'blacksmith', 3, BOOK);
ok('the same key again within the hour counts less', u2 > 0 && u2 < u1, [u1, u2]);
const u3 = sys.award(ctx, SMITH, 'blacksmith', 50, 0x1afcf);
ok('a weight is held to 3 units', u3 > 0 && u3 <= 3, u3);
ok('a skill not held gains nothing and is not taken up', sys.award(ctx, SCHOLAR, 'blacksmith', 3, BOOK) === 0 && !mp.get(SCHOLAR, 'private.mastery').skills.blacksmith);
ok('an unknown skill gains nothing', sys.award(ctx, SMITH, 'weaving', 3, BOOK) === 0);
ok('an NPC gains nothing', sys.award(ctx, NPC, 'blacksmith', 3, BOOK) === 0 && mp.get(NPC, 'private.mastery') === undefined);
ok('no weight, no credit', sys.award(ctx, SMITH, 'blacksmith', 0, BOOK) === 0);
let total = 0;
for (let i = 0; i < 40; i++) total += sys.award(ctx, SMITH, 'blacksmith', 3, 0x100000 + i);
const last = sys.award(ctx, SMITH, 'blacksmith', 3, 0x200000);
ok('the hourly bucket stops it (burst 20 units)', total + u1 + u2 + u3 <= 20.001 && last === 0, [total, last]);
ok('the level-up notice is the Wheel\'s own', notices.some((t) => /Your Blacksmith rises to/.test(t)), notices);

// The playtesters' boost (private.xpBoost { mult, until }) doubles an award as it doubles any other work: brewing
// (alchemy.js) and smithing books (manuals.js) are credited through the award, and the boost promises all work
if (!/private\.xpBoost/.test(SRC)) { require('./expect')('mastery-boost', 'this masterySystem has no private.xpBoost to boost an award'); console.log('ok   skipped the boost cases: this masterySystem has no private.xpBoost'); }
else {
  const xpOf = (a) => { const s = mp.get(a, 'private.mastery').skills.blacksmith; return s.level * 100 + s.xp; };
  for (const a of [PLAIN, BOOSTED, LAPSED]) mp.set(a, 'private.mastery', { v: 2, order: ['blacksmith'], skills: { blacksmith: { level: 10, xp: 0, rank: 0 } } });
  mp.set(BOOSTED, 'private.xpBoost', { mult: 2, until: Date.now() + 3600000 });
  mp.set(LAPSED, 'private.xpBoost', { mult: 2, until: Date.now() - 1000 });
  const gained = {};
  for (const a of [PLAIN, BOOSTED, LAPSED]) { const x0 = xpOf(a); const u = sys.award(ctx, a, 'blacksmith', 2, 0x300000); gained[a] = { u, xp: xpOf(a) - x0 }; }
  ok('a boosted award moves the skill twice as far', gained[PLAIN].xp > 0 && gained[BOOSTED].xp === 2 * gained[PLAIN].xp, gained);
  ok('...from the same metered units: the bucket and the caps count it as before', gained[BOOSTED].u === gained[PLAIN].u, gained);
  ok('a boost that has run out adds nothing', gained[LAPSED].xp === gained[PLAIN].xp, gained);
}

console.log(fails ? `${fails} failure(s)` : 'all checks passed');
process.exit(fails ? 1 : 0);
