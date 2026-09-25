// Exercises the pure skill-point maths against the numbers in server\SKILLS_DESIGN.md.
// usage: node test_skillPoints.js <bundled skillPoints.js>
'use strict';
const S = require(process.argv[2]);
let fails = 0, checks = 0;
const eq = (label, got, want, tol = 0) => {
  checks++;
  const ok = typeof want === 'number' ? Math.abs(got - want) <= tol : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`  FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};

// cumulative units per the design's table
eq('units to L25', S.unitsForLevel(25), 250);
eq('units to L50', S.unitsForLevel(50), 750);
eq('units to L75', S.unitsForLevel(75), 1750);
eq('units to L90', S.unitsForLevel(90), 2950);
eq('units to L95', S.unitsForLevel(95), 3950);
eq('units to L100', S.unitsForLevel(100), 5950);

// hours saturated at 30 units/hour: 8.3 / 25 / 58 / 98 / 132 / 198
for (const [lv, hours] of [[25, 8.3], [50, 25], [75, 58.3], [90, 98.3], [95, 131.7], [100, 198.3]]) {
  eq(`hours to L${lv}`, S.unitsForLevel(lv) / 30, hours, 0.1);
}

// round trip
for (const u of [0, 10, 249, 250, 751, 1751, 2951, 3951, 5949, 5950, 99999]) {
  const { level } = S.levelFromUnits(u);
  eq(`levelFromUnits(${u}) round trip`, S.unitsForLevel(level) <= u + 0.001, true);
}
eq('levelFromUnits caps at 100', S.levelFromUnits(999999).level, 100);

// tiers: Novice 1-24, Apprentice 25-49, Journeyman 50-74, Expert 75-89, Master 90-100
eq('tier at 0', S.tierOfLevel(0), -1);
eq('tier at 1', S.tierOfLevel(1), 0);
eq('tier at 24', S.tierOfLevel(24), 0);
eq('tier at 25', S.tierOfLevel(25), 1);
eq('tier at 74', S.tierOfLevel(74), 2);
eq('tier at 75', S.tierOfLevel(75), 3);
eq('tier at 89', S.tierOfLevel(89), 3);
eq('tier at 90', S.tierOfLevel(90), 4);
eq('tier at 100', S.tierOfLevel(100), 4);

// migration: every live character lands in the tier it already holds
for (const [hours, tier] of [[0, -1], [10, 1], [30, 2], [70, 3], [150, 4]]) {
  const { level } = S.levelFromOldPoints(hours);
  eq(`migrate ${hours}h -> tier`, S.tierOfLevel(level), tier);
}
eq('migrate 10h level', S.levelFromOldPoints(10).level, 27);
eq('migrate 70h level', S.levelFromOldPoints(70).level, 79);
eq('migrate 150h level', S.levelFromOldPoints(150).level, 96);
eq('three maxed skills fit the 300 pool', 3 * S.levelFromOldPoints(150).level <= 300, true);

// addUnits / removeUnits
eq('10 units from nothing = level 1', S.addUnits(0, 0, 10).level, 1);
eq('addUnits respects a cap', S.addUnits(89, 0, 10000, 90).level, 90);
eq('addUnits reports levels gained', S.addUnits(0, 0, 250).gained, 25);
const back = S.removeUnits(30, 0, 100, 25);
eq('removeUnits stops at the floor', back.level >= 25, true);
eq('removeUnits never goes under the floor', S.removeUnits(26, 0, 99999, 25).level, 25);
eq('removeUnits reports what it took', S.removeUnits(50, 0, 40, 25).taken, 40, 0.001);

// weights stay inside 0.5..3
for (const k of ['craft', 'kill', 'hit', 'cast', 'hurt', 'mine', 'skin', 'chop', 'read', 'activate', 'eat', 'nonsense']) {
  const w = S.weightOf({ kind: k, value: 99999 });
  eq(`weight ${k} in range`, w >= 0.5 && w <= 3, true);
}
eq('a rabbit is worth less than a giant', S.weightOf({ kind: 'kill', value: 20 }) < S.weightOf({ kind: 'kill', value: 400 }), true);
eq('iron ore is worth less than ebony', S.weightOf({ kind: 'mine', value: 0 }) < S.weightOf({ kind: 'mine', value: 4 }), true);
eq('a fox pelt is worth less than a cave bear', S.weightOf({ kind: 'skin', value: 0 }) < S.weightOf({ kind: 'skin', value: 300 }), true);
eq('a skin is never below a chop', S.weightOf({ kind: 'skin', value: 0 }) >= S.weightOf({ kind: 'chop' }), true);

// ── the scale terms, now that emitters actually pass a value (2026-09-20) ────────────────────────
// Every kind that takes a value must rise with it and must not sit at the flat base any more.
// A kind that is deliberately flat (`hit`) must stay flat however large the value it is handed.
eq('a leather helmet is worth less than a daedric greatsword',
  S.weightOf({ kind: 'craft', value: 60 }) < S.weightOf({ kind: 'craft', value: 2500 }), true);
eq('a craft is no longer flat', S.weightOf({ kind: 'craft', value: 900 }) > 0.5, true);
eq('Flames is worth less than Incinerate',
  S.weightOf({ kind: 'cast', value: 14 }) < S.weightOf({ kind: 'cast', value: 171 }), true);
eq('a cast is no longer flat', S.weightOf({ kind: 'cast', value: 86 }) > 0.5, true);
eq('a scratch is worth less than a maul',
  S.weightOf({ kind: 'hurt', value: 3 }) < S.weightOf({ kind: 'hurt', value: 60 }), true);
eq('a hurt is no longer flat', S.weightOf({ kind: 'hurt', value: 40 }) > 0.5, true);
eq('a level 1 bandit is worth less than a level 32 giant',
  S.weightOf({ kind: 'kill', value: 1 }) < S.weightOf({ kind: 'kill', value: 32 }), true);
eq('hit stays flat whatever it is handed', S.weightOf({ kind: 'hit', value: 99999 }), 0.5);
eq('hit is flat at zero too', S.weightOf({ kind: 'hit', value: 0 }), 0.5);
// A missing value must still yield the old flat base, so an emitter that sends none never regresses.
for (const k of ['craft', 'kill', 'cast', 'hurt']) {
  eq(`${k} with no value falls back to the base`, S.weightOf({ kind: k }), 0.5);
}
// Junk must not escape the clamp: weightOf is the only guard between a bad espm read and the ladder.
for (const bad of [NaN, Infinity, -Infinity, -50, 1e12]) {
  for (const k of ['craft', 'kill', 'cast', 'hurt', 'mine']) {
    const w = S.weightOf({ kind: k, value: bad });
    eq(`${k} clamps ${bad}`, w >= 0.5 && w <= 3, true);
  }
}

// repetition decay: the 9th identical act is worth half
let ring = [];
const now = 1000000;
let f1 = S.repetitionFactor(ring, 42, now); ring = f1.ring;
eq('first act is full value', f1.factor, 1);
for (let i = 0; i < 7; i++) { const r = S.repetitionFactor(ring, 42, now); ring = r.ring; }
eq('9th identical act is halved', S.repetitionFactor(ring, 42, now).factor, 0.5, 0.001);
eq('a different target is full value again', S.repetitionFactor(ring, 43, now).factor, 1);
eq('the ring is bounded', S.repetitionFactor(ring, 44, now).ring.length <= 16, true);
eq('old entries fall out of the window', S.repetitionFactor([{ h: 42, at: now - 7200000 }], 42, now).factor, 1);

// token bucket
const b0 = S.bucketAfterRefill(undefined, now, 30, 20);
eq('a new bucket starts full', b0.tokens, 20);
const spent = S.bucketSpend(b0, 5);
eq('spending takes tokens', spent.spent, 5);
eq('an empty bucket pays nothing', S.bucketSpend({ tokens: 0, at: now }, 3).spent, 0);
eq('refill is 30/hour', S.bucketAfterRefill({ tokens: 0, at: now - 3600000 }, now, 30, 100).tokens, 30, 0.01);
eq('refill never exceeds the burst', S.bucketAfterRefill({ tokens: 0, at: now - 36000000 }, now, 30, 20).tokens, 20);

// daily caps
const caps = { low: 360, expert: 180, master: 60 };
eq('daily cap below 75', S.dailyCapForLevel(50, caps), 360);
eq('daily cap at 75', S.dailyCapForLevel(75, caps), 180);
eq('daily cap at 90', S.dailyCapForLevel(90, caps), 60);
eq('90->95 takes at least 17 days', Math.ceil((S.unitsForLevel(95) - S.unitsForLevel(90)) / 60), 17);
eq('95->100 takes at least 34 days', Math.ceil((S.unitsForLevel(100) - S.unitsForLevel(95)) / 400 * 400 / 60), 34);

// structural caps
const opts = { capPerSkill: 100, seatAbove: 90, seatCount: 1, expertAbove: 75, expertCount: 3 };
eq('a free Seat allows 100', S.structuralCap({ smith: 80 }, 'smith', opts), 100);
eq('someone else holds the Seat', S.structuralCap({ smith: 80, mage: 95 }, 'smith', opts), 90);
eq('the Seat holder keeps its cap', S.structuralCap({ smith: 95, mage: 80 }, 'smith', opts), 100);
eq('a fourth Expert is capped', S.structuralCap({ a: 80, b: 80, c: 80, d: 10 }, 'd', opts), 75);
// an existing Expert already holds its slot, so a free Seat is still open to it
eq('an existing Expert may take a free Seat', S.structuralCap({ a: 80, b: 80, c: 80, d: 80 }, 'd', opts), 100);
eq('an existing Expert is capped at 90 when the Seat is taken', S.structuralCap({ a: 80, b: 80, c: 95, d: 80 }, 'd', opts), 90);

// donors
const sk = (id, level, lock) => ({ id, level, xp: 0, lock });
const d1 = S.chooseDonors([sk('smith', 90, 'raise'), sk('cook', 60, 'lower'), sk('bow', 50, 'lower'), sk('alch', 40, 'hold')], 'smith', 100, 25);
eq('marked to fall give first, highest first', d1.from[0].id, 'cook');
eq('held skills never give', d1.from.some((x) => x.id === 'alch'), false);
const d2 = S.chooseDonors([sk('smith', 90, 'raise'), sk('cook', 60, 'raise'), sk('bow', 30, 'raise')], 'smith', 20, 25);
eq('without a marked donor the lowest raise gives', d2.from[0].id, 'bow');
const d3 = S.chooseDonors([sk('smith', 90, 'raise'), sk('cook', 25, 'lower')], 'smith', 50, 25);
eq('nothing can give at the floor', d3.short > 0, true);
eq('pool used is the sum of levels', S.poolUsed([sk('a', 10, 'raise'), sk('b', 20, 'raise')]), 30);


// ── applyGain / firstTouch / derivedOrder ────────────────────────────────────────────────────────
console.log('\napplyGain:');
const cfg = { pool: 300, capPerSkill: 100, seatAbove: 90, seatCount: 1, expertAbove: 75, expertCount: 3,
  transferFloor: 25, firstTouchCost: 1, bucketBurst: 20, bucketPerHour: 30,
  dailyCaps: { low: 360, expert: 180, master: 60 }, characterDaily: 1080 };
const T = 1700000000000;
const mk = (skills) => ({ skills: Object.fromEntries(Object.entries(skills).map(([k, v]) => [k, typeof v === 'number' ? { level: v, xp: 0, lock: 'raise' } : v])) });

let r = mk({ smith: 0 });
let o = S.applyGain(r, 'smith', 10, cfg, T);
eq('10 units at level 0 gives a level', o.gained, 1);
eq('the bucket was charged', r.skills.smith.bucket.tokens, 10, 0.001);

// the bucket, not the weight, caps the hour
r = mk({ smith: 0 });
o = S.applyGain(r, 'smith', 500, cfg, T);
eq('one huge act is capped by the burst', o.units, 20);
o = S.applyGain(r, 'smith', 500, cfg, T);
eq('an empty bucket refuses', o.refused, 'bucket');
o = S.applyGain(r, 'smith', 5, cfg, T + 3600000);
eq('an hour later it pays again', o.units, 5);

// daily cap at the top is the calendar floor
r = mk({ smith: { level: 92, xp: 0, lock: 'raise' } });
let total = 0;
for (let h = 0; h < 48; h++) { const g = S.applyGain(r, 'smith', 20, cfg, T + h * 3600000); total += g.units; }
eq('a Master skill is capped at 60 units a day', total <= 60 * 3, true);

// structural caps
r = mk({ smith: 89, mage: 95, cook: 80, bow: 80 });
o = S.applyGain(r, 'smith', 20, cfg, T);
eq('the Seat is taken, so 90 is the ceiling', r.skills.smith.level <= 90, true);

// the pool transfers from a skill marked to fall. A level has to be genuinely gained for there to be
// overflow, so the gaining skill is low (10 units a level) and the burst can pay for it.
r = mk({ smith: { level: 10, xp: 0, lock: 'raise' }, cook: { level: 270, xp: 0, lock: 'lower' }, bow: { level: 20, xp: 0, lock: 'hold' } });
eq('pool starts full', S.poolUsed(Object.entries(r.skills).map(([id, v]) => ({ id, ...v }))), 300);
o = S.applyGain(r, 'smith', 10, cfg, T);
eq('the skill still gained its level', o.gained, 1);
eq('the gain took from the skill marked to fall', o.tookFrom.length > 0 && o.tookFrom[0].id, 'cook');
eq('the donor actually lost a level', r.skills.cook.level < 270, true);
eq('the held skill was untouched', r.skills.bow.level, 20);
eq('the pool is still within budget', S.poolUsed(Object.entries(r.skills).map(([id, v]) => ({ id, ...v }))) <= 300, true);

// nothing can give: the gain is refused, not silently lost. Every other skill sits exactly on the floor.
// smith is low enough that one burst really does complete a level, so the pool must find a donor
const floored = { smith: { level: 10, xp: 0, lock: 'raise' }, pad: { level: 15, xp: 0, lock: 'hold' } };
for (let i = 0; i < 11; i++) floored['s' + i] = { level: 25, xp: 0, lock: 'lower' };
r = mk(floored);
eq('pool is exactly full', S.poolUsed(Object.entries(r.skills).map(([id, v]) => ({ id, ...v }))), 300);
o = S.applyGain(r, 'smith', 10, cfg, T);
eq('a full pool with every donor at the floor is refused', o.refused, 'pool');
eq('no donor was pushed under the floor', Object.entries(r.skills).filter(([k]) => /^s\d+$/.test(k)).every(([, x]) => x.level >= 25), true);

// first touch
r = mk({});
eq('first touch opens a trade', S.firstTouch(r, 'smith', cfg), true);
eq('first touch costs one level', r.skills.smith.level, 1);
eq('first touch is idempotent', S.firstTouch(r, 'smith', cfg) && r.skills.smith.level, 1);
const full = mk({ a: 150, b: 150 });
eq('a full pool refuses a new trade', S.firstTouch(full, 'smith', cfg), false);
const fallingPool = mk({ a: { level: 100, xp: 0, lock: 'lower' }, b: 100, c: 100 });
eq('with a skill marked to fall, a full pool opens the trade', S.firstTouch(fallingPool, 'smith', cfg), true);
eq('the level comes from the falling skill', fallingPool.skills.a.level, 99);
eq('the raised skills are untouched', [fallingPool.skills.b.level, fallingPool.skills.c.level], [100, 100]);
eq('the pool stays within its limit', Object.values(fallingPool.skills).reduce((n, x) => n + x.level, 0) <= cfg.pool, true);
const partXp = mk({ a: { level: 60, xp: 7, lock: 'lower' }, b: 100, c: 100, d: 40 });
eq('a falling skill part-way through a level still pays one level', S.firstTouch(partXp, 'smith', cfg) && partXp.skills.a.level, 59);
const twoFalling = mk({ a: { level: 50, xp: 0, lock: 'lower' }, e: { level: 80, xp: 0, lock: 'lower' }, b: 100, c: 70 });
eq('the highest falling skill pays first', S.firstTouch(twoFalling, 'smith', cfg) && [twoFalling.skills.e.level, twoFalling.skills.a.level], [79, 50]);
const held = mk({ a: { level: 100, xp: 0, lock: 'hold' }, b: 100, c: 100 });
eq('a held skill never pays', S.firstTouch(held, 'smith', cfg), false);
const atFloor = mk({ a: { level: 25, xp: 0, lock: 'lower' }, b: 100, c: 100, d: 75 });
eq('a falling skill at the floor cannot pay', S.firstTouch(atFloor, 'smith', cfg), false);
eq('and nothing changed', atFloor.skills.a.level + '/' + (atFloor.skills.smith ? 'opened' : 'closed'), '25/closed');

// the shim the gameplay layer reads
r = mk({ smith: 80, cook: 10, bow: 0 });
eq('order lists touched skills, strongest first', S.derivedOrder(r), ['smith', 'cook']);
eq('an untouched skill is not in order', S.derivedOrder(r).includes('bow'), false);
eq('rank comes from the level', S.tierOfLevel(r.skills.smith.level), 3);

console.log(fails ? `\n${fails} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
process.exit(fails ? 1 : 0);
