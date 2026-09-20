// Scripted test for the mastery damage bonus in server\gamemode.js. No server and no game: run it
// from this folder's parent with
//
//   node tests\mastery-damage-harness.js
//
// gamemode.js cannot be required (it needs a live `mp`), so this lifts the block between the two
// markers straight out of the file, the way tests\skinning-harness.js lifts the skinning functions,
// and runs it against a mock mp. What it covers: the weapon-to-skill classification from WEAP
// DNAM[0], the tier table, skills the player never chose, and every guard in masteryBonusDamage -
// the kill the bonus must not steal, the hit the engine already killed with, and the blocked hit.
//
// The end-to-end measurement (a real bot landing real hits through the real damage formula) is in
// CHECKLIST.md under 2026-09-19 (late); this file is the part that can run unattended.
'use strict';
const fs = require('fs');
const path = require('path');

const GAMEMODE = path.join(path.resolve(__dirname, '..'), 'gamemode.js');
const START = '// ---- mastery: the combat tiers reach the damage the target takes';
const END = '// Combat adjudication and damage clamp';

const src = fs.readFileSync(GAMEMODE, 'utf8');
const from = src.indexOf(START), to = src.indexOf(END);
if (from < 0 || to < 0) {
  console.error('mastery block markers not found in gamemode.js - did the block move or get renamed?');
  process.exit(1);
}
const block = src.slice(from, to);

// ---- the mock world ----------------------------------------------------------------------------
const IRON_SWORD = 0x12eb7, GREATSWORD = 0x1359d, LONGBOW = 0x3b562, GOLD = 0xf;
const ANIM = { [IRON_SWORD]: 1, [GREATSWORD]: 5, [LONGBOW]: 7 }; // Sword, Greatsword, Bow
const weap = (id) => ({ record: { type: 'WEAP', editorId: 'x', fields: [{ type: 'DNAM', data: Uint8Array.from([ANIM[id], 0, 0]) }] } });

const world = {
  mastery: new Map(),      // actorId -> record
  percentages: new Map(),  // actorId -> {health, magicka, stamina}
  writes: [],              // every mp.set(id, 'percentages', ...)
};
const mp = {
  lookupEspmRecordById: (id) => (ANIM[id] ? weap(id) : (id === GOLD ? { record: { type: 'MISC', fields: [] } } : null)),
  get: (id, prop) => {
    if (prop === 'private.mastery') return world.mastery.get(id) || null;
    if (prop === 'percentages') { const p = world.percentages.get(id); if (!p) throw new Error('not an actor'); return Object.assign({}, p); }
    throw new Error(`unexpected get ${prop}`);
  },
  set: (id, prop, v) => {
    if (prop !== 'percentages') throw new Error(`unexpected set ${prop}`);
    world.writes.push({ id, v });
    world.percentages.set(id, Object.assign({}, v));
  },
};

const logs = [];
const M = new Function('mp', 'cfg', 'log', 'display', 'recordOf', 'masteryOf',
  block + '\nreturn { masteryDamageMult, masteryBonusDamage, weaponSkillOf, MASTERY_DMG, MASTERY_MIN_HEALTH };')(
  mp, {}, (...a) => logs.push(a.join(' ')), (id) => `a${id.toString(16)}`,
  (id) => { try { const r = mp.lookupEspmRecordById(id >>> 0); return r && r.record ? r : null; } catch (e) { return null; } },
  (id) => { try { const r = mp.get(id, 'private.mastery'); return r && typeof r === 'object' ? r : null; } catch (e) { return null; } });

// ---- helpers -----------------------------------------------------------------------------------
const AGG = 0xff000000, TGT = 0xff000001;
let pass = 0, fail = 0;
const ok = (name, got, want) => {
  const same = Math.abs(Number(got) - Number(want)) < 1e-6;
  if (same) { pass++; } else { fail++; console.log(`  FAIL ${name}: got ${got}, want ${want}`); }
};
const chosen = (skill, rank) => world.mastery.set(AGG, { order: [skill], skills: { [skill]: { rank, points: 999 } } });
// One hit: the engine took dealtPct of the target's health, then the hook runs.
const hit = (health0, dealtPct, damage, mult) => {
  world.percentages.set(TGT, { health: Math.max(0, health0 - dealtPct), magicka: 1, stamina: 1 });
  globalThis.__dboMasteryPending = mult === 1 ? null : { agg: AGG, tgt: TGT, mult, health: health0 };
  const extra = M.masteryBonusDamage(AGG, TGT, damage);
  return { extra, health: world.percentages.get(TGT).health };
};

console.log('mastery damage harness');
console.log(`  block: ${block.split('\n').length} lines, MASTERY_DMG = ${JSON.stringify(M.MASTERY_DMG)}`);

// ---- 1. weapon classification (WEAP DNAM byte 0) -----------------------------------------------
ok('sword is one-handed', M.weaponSkillOf(IRON_SWORD) === 'onehanded', true);
ok('greatsword is two-handed', M.weaponSkillOf(GREATSWORD) === 'twohanded', true);
ok('bow is archery', M.weaponSkillOf(LONGBOW) === 'archery', true);
ok('a non-weapon source has no skill', M.weaponSkillOf(GOLD) === '', true);
ok('an unknown source has no skill', M.weaponSkillOf(0x999999) === '', true);

// ---- 2. the tier table -------------------------------------------------------------------------
for (const [rank, want] of [[0, 1], [1, 1], [2, 1.1], [3, 1.2], [4, 1.3]]) {
  chosen('onehanded', rank);
  ok(`one-handed rank ${rank}`, M.masteryDamageMult(AGG, IRON_SWORD), want);
}
chosen('onehanded', 4);
ok('a greatsword does not use the one-handed tier', M.masteryDamageMult(AGG, GREATSWORD), 1);
ok('gold is not a weapon', M.masteryDamageMult(AGG, GOLD), 1);
world.mastery.set(AGG, { order: [], skills: {} });
ok('an unchosen skill gives nothing', M.masteryDamageMult(AGG, IRON_SWORD), 1);
world.mastery.delete(AGG);
ok('an actor with no mastery record (an NPC) gives nothing', M.masteryDamageMult(AGG, IRON_SWORD), 1);

// ---- 3. the bonus itself -----------------------------------------------------------------------
chosen('onehanded', 4);
world.writes.length = 0;
let r = hit(1.0, 0.20, 10, 1.3);
ok('master takes 30% more health', r.health, 0.74);        // 0.80 - 0.20*0.3
ok('and reports the extra damage', r.extra, 3);            // 10 * (0.06/0.20)
ok('through exactly one percentages write', world.writes.length, 1);

r = hit(1.0, 0.20, 10, 1.1);
ok('journeyman takes 10% more', r.health, 0.78);

// no pending record (the attempt hook found no bonus): nothing happens
world.writes.length = 0;
r = hit(1.0, 0.20, 10, 1);
ok('no bonus means no write', world.writes.length, 0);
ok('and no extra damage', r.extra, 0);

// ---- 4. the guards -----------------------------------------------------------------------------
// the engine's hit already killed the target: leave it, or the kill credit is lost
world.writes.length = 0;
r = hit(0.15, 0.15, 10, 1.3);
ok('a target the engine killed is left alone', world.writes.length, 0);
ok('and pays no bonus', r.extra, 0);

// the bonus would kill: clamp to the sliver so the engine's next hit takes the kill
world.writes.length = 0;
r = hit(0.22, 0.20, 10, 1.3);
ok('the bonus never lands the killing blow', r.health, M.MASTERY_MIN_HEALTH);
ok('it is still applied down to the sliver', world.writes.length, 1);
ok('and only the part that landed is credited', r.extra, 10 * ((0.02 - M.MASTERY_MIN_HEALTH) / 0.20));

// a blocked or warded hit took no health: nothing to multiply
world.writes.length = 0;
r = hit(1.0, 0, 10, 1.3);
ok('a hit that took no health pays nothing', world.writes.length, 0);

// the pending record belongs to another pair
world.percentages.set(TGT, { health: 0.8, magicka: 1, stamina: 1 });
globalThis.__dboMasteryPending = { agg: 0xdead, tgt: TGT, mult: 1.3, health: 1.0 };
world.writes.length = 0;
ok('a pending record from another aggressor is ignored', M.masteryBonusDamage(AGG, TGT, 10), 0);
ok('and writes nothing', world.writes.length, 0);

// the pending record is consumed, so a second onHitDamage cannot double-dip
globalThis.__dboMasteryPending = { agg: AGG, tgt: TGT, mult: 1.3, health: 1.0 };
world.percentages.set(TGT, { health: 0.8, magicka: 1, stamina: 1 });
M.masteryBonusDamage(AGG, TGT, 10);
world.writes.length = 0;
ok('the bonus is not paid twice for one hit', M.masteryBonusDamage(AGG, TGT, 10), 0);
ok('and writes nothing the second time', world.writes.length, 0);

// zero damage (a reanimation or a banish) is not a hit to multiply
globalThis.__dboMasteryPending = { agg: AGG, tgt: TGT, mult: 1.3, health: 1.0 };
world.percentages.set(TGT, { health: 0.8, magicka: 1, stamina: 1 });
world.writes.length = 0;
ok('zero damage pays nothing', M.masteryBonusDamage(AGG, TGT, 0), 0);
ok('and writes nothing', world.writes.length, 0);

// ---- 5. the disabled switch --------------------------------------------------------------------
const disabled = new Function('mp', 'cfg', 'log', 'display', 'recordOf', 'masteryOf',
  block + '\nreturn { masteryDamageMult };')(
  mp, { mastery: { damage: { enabled: false } } }, () => { }, (id) => `a${id}`,
  (id) => mp.lookupEspmRecordById(id >>> 0), (id) => world.mastery.get(id) || null);
chosen('onehanded', 4);
ok('"enabled": false turns the bonus off', disabled.masteryDamageMult(AGG, IRON_SWORD), 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
