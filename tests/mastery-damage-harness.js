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
const IRON_WAR_AXE = 0x13790, IRON_MACE = 0x13982, IRON_BATTLEAXE = 0x13980;
const ANIM = { [IRON_SWORD]: 1, [GREATSWORD]: 5, [LONGBOW]: 7, [IRON_WAR_AXE]: 3, [IRON_MACE]: 4, [IRON_BATTLEAXE]: 6 }; // Sword, Greatsword, Bow, WarAxe, Mace, Battleaxe
// Armor: Daedric cuirass (heavy, 49) and Glass boots (light, 11), vanilla ratings
const DAEDRIC_CUIRASS = 0x1396b, GLASS_BOOTS = 0x13939;
const u32 = (...v) => { const b = new Uint8Array(v.length * 4); const d = new DataView(b.buffer); v.forEach((x, i) => d.setUint32(i * 4, x, true)); return b; };
const armo = (rating, type) => ({ record: { type: 'ARMO', editorId: 'x', fields: [{ type: 'BOD2', data: u32(4, type) }, { type: 'DNAM', data: u32(rating * 100) }] } });
const ARMOR = { [DAEDRIC_CUIRASS]: armo(49, 1), [GLASS_BOOTS]: armo(11, 0) };
// DATA: value u32, weight f32, damage u16 at 8 (the base damage the server reads)
const DMG = { [IRON_SWORD]: 7, [GREATSWORD]: 17, [LONGBOW]: 6, [IRON_WAR_AXE]: 8, [IRON_MACE]: 9, [IRON_BATTLEAXE]: 16 };
const weapData = (id) => { const b = new Uint8Array(10); new DataView(b.buffer).setUint16(8, DMG[id] || 0, true); return b; };
const weap = (id) => ({ record: { type: 'WEAP', editorId: 'x', fields: [{ type: 'DNAM', data: Uint8Array.from([ANIM[id], 0, 0]) }, { type: 'DATA', data: weapData(id) }] } });
// Boots on the feet slot (37, bit 7), not the body, so tempering counts half on them
const IRON_BOOTS = 0x12e4b;
ARMOR[IRON_BOOTS] = { record: { type: 'ARMO', editorId: 'x', fields: [{ type: 'BOD2', data: u32(0x80, 1) }, { type: 'DNAM', data: u32(10 * 100) }] } };

const world = {
  mastery: new Map(),      // actorId -> record
  percentages: new Map(),  // actorId -> {health, magicka, stamina}
  writes: [],              // every mp.set(id, 'percentages', ...)
  worn: new Map(),         // actorId -> [armor baseId | { baseId, health }]
  inv: new Map(),          // actorId -> inventory entries
};
const mp = {
  lookupEspmRecordById: (id) => ARMOR[id] || (ANIM[id] ? weap(id) : (id === GOLD ? { record: { type: 'MISC', fields: [] } } : null)),
  get: (id, prop) => {
    if (prop === 'private.mastery') return world.mastery.get(id) || null;
    if (prop === 'equipment') return { inv: { entries: (world.worn.get(id) || []).map((b) => (typeof b === 'object' ? { baseId: b.baseId, count: 1, worn: true, health: b.health } : { baseId: b, count: 1, worn: true })) } };
    if (prop === 'inventory') return { entries: world.inv.get(id) || [] };
    if (prop === 'percentages') { const p = world.percentages.get(id); if (!p) throw new Error('not an actor'); return Object.assign({}, p); }
    throw new Error(`unexpected get ${prop}`);
  },
  set: (id, prop, v) => {
    if (prop !== 'percentages') throw new Error(`unexpected set ${prop}`);
    world.writes.push({ id, v });
    world.percentages.set(id, Object.assign({}, v));
  },
};

// Copies of gamemode.js's own helpers, which sit outside the lifted block
const fieldsOf = (lr, type) => ((lr && lr.record && lr.record.fields) || []).filter((f) => f.type === type && f.data instanceof Uint8Array);
const wornOf = (equipment) => { const entries = equipment && equipment.inv && Array.isArray(equipment.inv.entries) ? equipment.inv.entries : []; return entries.filter((e) => e && (e.worn || e.wornLeft)).map((e) => ({ baseId: Number(e.baseId) >>> 0, left: !!e.wornLeft })); };
const logs = [];
const M = new Function('mp', 'cfg', 'log', 'display', 'recordOf', 'masteryOf', 'fieldsOf', 'wornOf',
  block + '\nreturn { masteryDamageMult, masteryBonusDamage, weaponSkillOf, defenseDamageMult, MASTERY_DMG, MASTERY_MIN_HEALTH };')(
  mp, {}, (...a) => logs.push(a.join(' ')), (id) => `a${id.toString(16)}`,
  (id) => { try { const r = mp.lookupEspmRecordById(id >>> 0); return r && r.record ? r : null; } catch (e) { return null; } },
  (id) => { try { const r = mp.get(id, 'private.mastery'); return r && typeof r === 'object' ? r : null; } catch (e) { return null; } },
  fieldsOf, wornOf);

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
ok('sword is Blade', M.weaponSkillOf(IRON_SWORD) === 'blade', true);
ok('greatsword is Blade', M.weaponSkillOf(GREATSWORD) === 'blade', true);
ok('war axe is Blunt', M.weaponSkillOf(IRON_WAR_AXE) === 'blunt', true);
ok('mace is Blunt', M.weaponSkillOf(IRON_MACE) === 'blunt', true);
ok('battleaxe and warhammer are Blunt', M.weaponSkillOf(IRON_BATTLEAXE) === 'blunt', true);
ok('bow is archery', M.weaponSkillOf(LONGBOW) === 'archery', true);
ok('a non-weapon source has no skill', M.weaponSkillOf(GOLD) === '', true);
ok('the unarmed source 0x1f4 is Unarmed', M.weaponSkillOf(0x1f4) === 'unarmed', true);
ok('an unknown source has no skill', M.weaponSkillOf(0x999999) === '', true);

// ---- 2. the tier table -------------------------------------------------------------------------
for (const [rank, want] of [[0, 1], [1, 1], [2, 1.35], [3, 1.65], [4, 2]]) {
  chosen('blade', rank);
  ok(`one-handed rank ${rank}`, M.masteryDamageMult(AGG, IRON_SWORD), want);
}
chosen('blade', 4);
ok('a greatsword uses the Blade tier, one hand or two', M.masteryDamageMult(AGG, GREATSWORD), 2);
ok('a mace does not use the Blade tier', M.masteryDamageMult(AGG, IRON_MACE), 1);
ok('gold is not a weapon', M.masteryDamageMult(AGG, GOLD), 1);
world.mastery.set(AGG, { order: [], skills: {} });
ok('an unchosen skill gives nothing', M.masteryDamageMult(AGG, IRON_SWORD), 1);
world.mastery.delete(AGG);
ok('an actor with no mastery record (an NPC) gives nothing', M.masteryDamageMult(AGG, IRON_SWORD), 1);

// ---- 3. the bonus itself -----------------------------------------------------------------------
chosen('blade', 4);
world.writes.length = 0;
let r = hit(1.0, 0.20, 10, 1.3);
ok('x1.3 takes 30% more health', r.health, 0.74);          // 0.80 - 0.20*0.3
ok('and reports the extra damage', r.extra, 3);            // 10 * (0.06/0.20)
ok('through exactly one percentages write', world.writes.length, 1);

r = hit(1.0, 0.20, 10, 1.1);
ok('x1.1 takes 10% more', r.health, 0.78);

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

// ---- 4b. Defense: armor worn at a Defense tier counts for more than the engine's bare rating ------
const defends = (rank) => world.mastery.set(TGT, { order: ['defense'], skills: { defense: { rank, points: 999 } } });
const kept = (rating) => 1 - Math.min(rating * 0.12, 80) / 100;
world.worn.set(TGT, [DAEDRIC_CUIRASS]);
defends(4);
ok('master defense: a heavy cuirass counts x3.5', M.defenseDamageMult(TGT), kept(49 * 3.5) / kept(49));
defends(0);
ok('novice defense changes nothing', M.defenseDamageMult(TGT), 1);
defends(4); world.worn.set(TGT, []);
ok('no armor worn changes nothing', M.defenseDamageMult(TGT), 1);
world.worn.set(TGT, [DAEDRIC_CUIRASS, GLASS_BOOTS]);
ok('light armor counts too with lightShare 1', M.defenseDamageMult(TGT), kept(60 * 3.5) / kept(60));
world.worn.set(TGT, [DAEDRIC_CUIRASS, DAEDRIC_CUIRASS, DAEDRIC_CUIRASS, DAEDRIC_CUIRASS, DAEDRIC_CUIRASS]);
ok('the 80% cap holds', M.defenseDamageMult(TGT), kept(9999) / kept(245));
world.mastery.set(TGT, { order: [], skills: {} });
ok('an unchosen Defense changes nothing', M.defenseDamageMult(TGT), 1);
world.mastery.delete(TGT); world.worn.delete(TGT);
// a multiplier under 1 gives part of the hit back, never more than the hit took
r = hit(1.0, 0.20, 10, 0.75);
ok('a 0.75 hit gives a quarter back', r.health, 0.85);
ok('and credits the smaller hit', r.extra, -2.5);
r = hit(1.0, 0.20, 10, 1.5);
ok('attack and defense multiply (2 x 0.75)', r.health, 0.70);

// ---- 5. the disabled switch --------------------------------------------------------------------
const disabled = new Function('mp', 'cfg', 'log', 'display', 'recordOf', 'masteryOf', 'fieldsOf', 'wornOf',
  block + '\nreturn { masteryDamageMult };')(
  mp, { mastery: { damage: { enabled: false } } }, () => { }, (id) => `a${id}`,
  (id) => mp.lookupEspmRecordById(id >>> 0), (id) => world.mastery.get(id) || null, fieldsOf, wornOf);
chosen('blade', 4);
ok('"enabled": false turns the bonus off', disabled.masteryDamageMult(AGG, IRON_SWORD), 1);

// Fists have their own tier table (Martial Arts, 2026-09-28): fistByTier for 0x1f4, byTier for every weapon
const fistCfg = { mastery: { damage: { byTier: [0, 0, 0.35, 0.65, 1.0], fistByTier: [0, 0, 0.2, 0.35, 0.5] } } };
const withFists = new Function('mp', 'cfg', 'log', 'display', 'recordOf', 'masteryOf', 'fieldsOf', 'wornOf',
  block + '\nreturn { masteryDamageMult };')(
  mp, fistCfg, () => {}, (id) => `a${id.toString(16)}`,
  (id) => { try { const r = mp.lookupEspmRecordById(id >>> 0); return r && r.record ? r : null; } catch (e) { return null; } },
  (id) => { try { const r = mp.get(id, 'private.mastery'); return r && typeof r === 'object' ? r : null; } catch (e) { return null; } },
  fieldsOf, wornOf);
world.mastery.set(AGG, { order: ['unarmed', 'blade'], skills: { unarmed: { rank: 4 }, blade: { rank: 4 } } });
ok('a Master fist gets fistByTier (+50%)', withFists.masteryDamageMult(AGG, 0x1f4), 1.5);
ok('...while a Master sword keeps byTier (+100%)', withFists.masteryDamageMult(AGG, IRON_SWORD), 2);

// ---- tempering counts as the game shows it, and the inventory's numbers (Nate, 2026-09-29) ------------------------
{
  const tb = new Function('mp', 'cfg', 'log', 'display', 'recordOf', 'masteryOf', 'fieldsOf', 'wornOf',
    block + '\nreturn { temperBonus, temperDamageMult, defenseDamageMult };')(
    mp, {}, () => {}, String, (id) => { const r = mp.lookupEspmRecordById(id >>> 0); return r && r.record ? r : null; },
    (id) => { try { const r = mp.get(id, 'private.mastery'); return r && typeof r === 'object' ? r : null; } catch (e) { return null; } }, fieldsOf, wornOf);
  ok('Fine on a chest piece: +2', tb.temperBonus(1.1, true), 2);
  ok('Fine anywhere else: +1', tb.temperBonus(1.1, false), 1);
  ok('Legendary on a chest piece: +20', tb.temperBonus(1.6, true), 20);
  ok('Legendary on a weapon: +10', tb.temperBonus(1.6, false), 10);
  ok('untempered: nothing', tb.temperBonus(1, false), 0);
  world.worn.set(AGG, [{ baseId: IRON_SWORD, health: 1.6 }]);
  ok('a Legendary iron sword (7) hits as 17', tb.temperDamageMult(AGG, IRON_SWORD), 17 / 7);
  world.worn.set(AGG, [IRON_SWORD]);
  ok('an untempered one as 7', tb.temperDamageMult(AGG, IRON_SWORD), 1);
  ok('a weapon not in hand is not counted', tb.temperDamageMult(AGG, GREATSWORD), 1);
  world.worn.delete(AGG);
  const kept2 = (r) => 1 - Math.min(r * 0.12, 80) / 100;
  world.mastery.delete(TGT);
  world.worn.set(TGT, [{ baseId: DAEDRIC_CUIRASS, health: 1.6 }]);
  ok('a Legendary Daedric cuirass counts 69 without Defense', tb.defenseDamageMult(TGT), kept2(69) / kept2(49));
  world.worn.set(TGT, [{ baseId: DAEDRIC_CUIRASS, health: 1.6 }, { baseId: IRON_BOOTS, health: 1.6 }]);
  world.mastery.set(TGT, { order: ['defense'], skills: { defense: { rank: 4 } } });
  ok('...and with Master Defense (69 + 20) x 3.5 against the bare 59', tb.defenseDamageMult(TGT), kept2((69 + 20) * 3.5) / kept2(59));
  world.mastery.delete(TGT); world.worn.delete(TGT);

  // The inventory's numbers: lifted from gamemode.js the same way
  const SSTART = '// ---- the numbers the inventory shows are the ones the server uses';
  const SEND = 'globalThis.__dboStatItemsFor = statItemsFor;';
  const sf = src.indexOf(SSTART), se = src.indexOf(SEND);
  ok('the inventory-numbers block is found', sf > 0 && se > sf, true);
  const sent = [];
  const S = new Function('mp', 'cfg', 'log', 'display', 'recordOf', 'masteryOf', 'fieldsOf', 'wornOf', 'profileOf', 'every', 'onlineActors', 'sendPacket',
    block + '\n' + src.slice(sf, se) + '\nreturn { statItemsFor, pushStats, slices: typeof STAT_SLICES === "number" ? STAT_SLICES : 1 };')(
    mp, { weaponMaterials: { enabled: true, playersOnly: true, byKeyword: {} } }, () => {}, String,
    (id) => { const r = mp.lookupEspmRecordById(id >>> 0); return r && r.record ? r : null; },
    (id) => { try { const r = mp.get(id, 'private.mastery'); return r && typeof r === 'object' ? r : null; } catch (e) { return null; } },
    fieldsOf, wornOf, (a) => (a === AGG ? 1 : -1), () => {}, () => [AGG], (a, p) => sent.push([a, p]));
  world.mastery.set(AGG, { order: ['blade', 'defense'], skills: { blade: { rank: 4 }, defense: { rank: 4 } } });
  world.inv.set(AGG, [{ baseId: IRON_SWORD, count: 1, worn: true, health: 1.6 }, { baseId: GREATSWORD, count: 2 }, { baseId: DAEDRIC_CUIRASS, count: 1, worn: true, health: 1.1 },
    { baseId: GLASS_BOOTS, count: 1 }, { baseId: GOLD, count: 50 }]);
  const items = S.statItemsFor(AGG);
  const at = (id) => items.find((x) => x.id === id) || {};
  ok('a Master Blade with a Legendary iron sword: (7 + 10) x 2 = 34, read against One-Handed', at(IRON_SWORD).value === 34 && at(IRON_SWORD).temper === 10 && at(IRON_SWORD).skill === 'OneHanded', true);
  ok('an untempered greatsword: 17 x 2 = 34, against Two-Handed', at(GREATSWORD).value === 34 && at(GREATSWORD).temper === 0 && at(GREATSWORD).skill === 'TwoHanded', true);
  ok('a Fine Daedric cuirass at Master Defense: (49 + 2) x 3.5 = 178.5, Heavy Armor', at(DAEDRIC_CUIRASS).value === 178.5 && at(DAEDRIC_CUIRASS).skill === 'HeavyArmor', true);
  ok('glass boots: 11 x 3.5 = 38.5, Light Armor', at(GLASS_BOOTS).value === 38.5 && at(GLASS_BOOTS).skill === 'LightArmor', true);
  ok('gold is not an item with a number', items.length === 4, true);
  // statDisplay is sliced (gamemode.js STAT_SLICES): one full cycle reaches every player once
  const cycle = () => { for (let i = 0; i < S.slices; i++) S.pushStats(); };
  cycle(); cycle();
  ok('sent once, and not again while nothing changed', sent.length === 1 && sent[0][1].customPacketType === 'dboStatDisplay' && sent[0][1].items.length === 4, true);
  world.mastery.set(AGG, { order: ['blade'], skills: { blade: { rank: 2 } } });
  cycle();
  ok('a tier change sends the new numbers', sent.length === 2 && sent[1][1].items.find((x) => x.id === IRON_SWORD).value === Math.round(17 * 1.35 * 100) / 100, true);
  world.mastery.delete(AGG); world.inv.delete(AGG);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
