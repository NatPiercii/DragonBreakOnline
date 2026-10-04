// Per-skill, per-activity skill rates (skillrates.js, config "skillRates") against stub records and a stub clock.
// Run from server/: node tests/skill-rates-harness.js
// masterySystem's side (the rate applied after the bucket and the day's caps) is tests/mastery-rate-harness.js.
'use strict';
const fs = require('fs');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(SERVER, 'gamemode-config.json'), 'utf8'));
const GAMEMODE = fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8');
const SALVAGE = fs.readFileSync(path.join(SERVER, 'salvage.js'), 'utf8');
const MODULE = path.join(SERVER, 'skillrates.js');

let fails = 0, checks = 0;
const ok = (label, cond, got) => { checks++; if (!cond) { fails++; console.log(`  FAIL ${label}${got !== undefined ? `: got ${JSON.stringify(got)}` : ''}`); } else console.log(`  ok   ${label}`); };

// ---- what ships: Nate's rates (4 Oct), the loop guard on --------------------------------------------------------------
const R = CONFIG.skillRates || {};
const NOTES = JSON.parse(fs.readFileSync(path.join(SERVER, 'patch-notes.json'), 'utf8'));
ok('config: skillRates is on', R.enabled === true, R.enabled);
ok('config: miner x2, skinner x1.5', R.rates.miner === 2 && R.rates.skinner === 1.5, R.rates);
ok('config: blacksmith x2.5 at tier 1 (iron), x1 above', R.rates.blacksmith.default === 1 && JSON.stringify(R.rates.blacksmith.craftByTier) === '[2.5,1,1,1,1]', R.rates.blacksmith);
ok('config: the salvage loop guard is on, x0 for 60 min', R.salvageLoop && R.salvageLoop.enabled === true && R.salvageLoop.rate === 0 && R.salvageLoop.windowMinutes === 60, R.salvageLoop);
const NOTE = NOTES.find((n) => n.title === 'Faster Mining, Smithing and Skinning');
const NOTE_TEXT = JSON.stringify(NOTE || {});
ok('patch note in patch-notes.json, dated SHIP_DATE or a date', !!NOTE && (NOTE.date === 'SHIP_DATE' || /^\d{4}-\d{2}-\d{2}$/.test(NOTE.date)), NOTE && NOTE.date);
ok('...naming the rates as shipped', /twice as much toward your Miner/.test(NOTE_TEXT) && /Iron-tier smithing and smelting [^"]*smelting iron, copper, corundum and tin ore\) now counts two and a half times as much toward Blacksmith/.test(NOTE_TEXT) && /higher ores counts as before/.test(NOTE_TEXT) && /half as much again toward Skinner/.test(NOTE_TEXT), NOTE_TEXT);
ok('...and the loop guard', /broke down in the last hour no longer counts/.test(NOTE_TEXT), NOTE_TEXT);
ok('...no longer parked in patch-notes-pending', !fs.existsSync(path.join(SERVER, 'docs', 'patch-notes-pending', 'skill-rates.json')));
ok('config: material tiers are 2..5 (tier 1 is everything unlisted)', Object.entries(R.materialTiers).filter(([k]) => !k.startsWith('_')).every(([, t]) => t >= 2 && t <= 5), R.materialTiers);
// Ores follow the Miner's ladder (skills.json miner.oreByTier): tier = index + 1, the first band unlisted
const SKILLS = JSON.parse(fs.readFileSync(path.join(SERVER, 'skills.json'), 'utf8'));
const ORE_BY_TIER = SKILLS.skills.find((k) => k.id === 'miner').oreByTier;
const ORE_EDID = { copper: 'BSKOreCopper', iron: 'OreIron', corundum: 'OreCorundum', silver: 'OreSilver', quicksilver: 'OreQuicksilver', orichalcum: 'OreOrichalcum', moonstone: 'OreMoonstone', gold: 'OreGold', meteoriciron: 'BSKOreMeteoricIron', malachite: 'OreMalachite', ebony: 'OreEbony' };
ORE_BY_TIER.forEach((ores, i) => ores.forEach((ore) => {
  const edid = ORE_EDID[ore.toLowerCase()];
  ok(`config: ${ore} ore is tier ${i + 1}, as the Miner ladder has it`, !!edid && (i === 0 ? R.materialTiers[edid] === undefined : R.materialTiers[edid] === i + 1), [edid, R.materialTiers[edid]]);
}));
ok('gamemode loads skillrates.js with recordOf and fieldsOf', /require\(SKILLRATES_JS\)\(\{[^}]*recordOf, fieldsOf[^}]*\}\)/.test(GAMEMODE));
ok('gamemode clears the hooks when it fails to load', /skillrates\.js failed to load[^\n]*__dboSkillRate = null/.test(GAMEMODE));
ok('salvage.js tells it about each breakdown', /broke down \$\{name\}[^\n]*\n\s*try \{ if \(typeof globalThis\.__dboSkillRateBrokeDown === 'function'\) globalThis\.__dboSkillRateBrokeDown\(a, baseId\)/.test(SALVAGE));

// ---- stub records: ingredients by editor id, recipes with CNTO/CNAM -------------------------------------------------
const world = new Map();
const u8 = (n, fill) => { const b = new Uint8Array(n); fill(new DataView(b.buffer)); return b; };
const ITEM = { OreEbony: 0x5acdc, OreOrichalcum: 0x5acdd, OreCorundum: 0x5acdb, BSKOreCopper: 0x7601c50, IngotOrichalcum: 0x5ad99, IngotCorundum: 0x5ad93, BSKIngotCopper: 0x7601c5a, IngotIron: 0x5ace4, LeatherStrips: 0x800e4, IngotSteel: 0x5ace5, OreIron: 0x71cf3, IngotEbony: 0x5ad9d, DaedraHeart: 0x3ad5b, IronDagger: 0x1397e, SteelSword: 0x13989, Horseshoe: 0x0cc2a1 };
const WEAPONS = new Set(['IronDagger', 'SteelSword', 'IronTanto']);
ITEM.IronTanto = 0x2701f2;
for (const [edid, id] of Object.entries(ITEM)) world.set(id, { record: { type: WEAPONS.has(edid) ? 'WEAP' : 'MISC', editorId: edid, fields: [] } });
// a recipe's local ids are the global ids here, its toGlobalRecordId the identity
const recipe = (id, product, parts) => world.set(id, {
  record: { type: 'COBJ', editorId: `R${id.toString(16)}`, fields: parts.map((p) => ({ type: 'CNTO', data: u8(8, (v) => { v.setUint32(0, ITEM[p], true); v.setInt32(4, 1, true); }) }))
    .concat([{ type: 'CNAM', data: u8(4, (v) => v.setUint32(0, ITEM[product], true)) }]) },
  toGlobalRecordId: (local) => local,
});
const DAGGER = 0x100, SWORD = 0x101, SMELT = 0x102, DAEDRIC = 0x103, SHOE = 0x104, TANTO = 0x105, TANTO_APART = 0x106;
const SMELT_EBONY = 0x107, SMELT_ORICHALCUM = 0x108, SMELT_CORUNDUM = 0x109, SMELT_COPPER = 0x10a, SMELT_STEEL = 0x10b;
recipe(DAGGER, 'IronDagger', ['IngotIron', 'LeatherStrips']);
recipe(SWORD, 'SteelSword', ['IngotSteel', 'IngotIron', 'LeatherStrips']);
recipe(SMELT, 'IngotIron', ['OreIron']);
recipe(DAEDRIC, 'IronDagger', ['IngotEbony', 'DaedraHeart']);
recipe(SHOE, 'Horseshoe', ['IngotIron']);
recipe(SMELT_EBONY, 'IngotEbony', ['OreEbony']);
recipe(SMELT_ORICHALCUM, 'IngotOrichalcum', ['OreOrichalcum']);
recipe(SMELT_CORUNDUM, 'IngotCorundum', ['OreCorundum']);
recipe(SMELT_COPPER, 'BSKIngotCopper', ['BSKOreCopper']);
recipe(SMELT_STEEL, 'IngotSteel', ['OreIron', 'OreCorundum']);
recipe(TANTO, 'IronTanto', ['IngotIron', 'LeatherStrips']);          // IWRecipeIronTanto at the forge
recipe(TANTO_APART, 'IngotIron', ['IronTanto']);                    // IWBreakdownIronTanto at the smelter
const recordOf = (id) => world.get(id >>> 0) || null;
const fieldsOf = (lr, type) => ((lr && lr.record && lr.record.fields) || []).filter((f) => f.type === type && f.data instanceof Uint8Array);

const realNow = Date.now;
let clock = Date.parse('2026-10-04T10:00:00Z');
Date.now = () => clock;
const logs = [];
const load = (skillRates) => {
  delete require.cache[MODULE];
  return require(MODULE)({ log: (...a) => logs.push(a.join(' ')), cfg: { skillRates }, recordOf, fieldsOf });
};
const A = 0xff001ed0, B = 0xff0004cb;
const craft = (r, recipeId, extra) => r.rateFor(A, 'blacksmith', 'craft', Object.assign({ recipeId, held: 1, value: 10, parts: 2 }, extra || {}));

// ---- the shipped config, and an all-x1 config that changes nothing -----------------------------------------------------
let r = load(R);
ok('shipped: a mined vein x2', r.rateFor(A, 'miner', 'mine', { refrId: 1, value: 0 }) === 2);
ok('shipped: an iron dagger x2.5', craft(r, DAGGER) === 2.5);
ok('shipped: a steel sword x1', craft(r, SWORD) === 1);
ok('shipped: smelting iron ore x2.5', craft(r, SMELT) === 2.5);
ok('shipped: smelting copper or corundum ore x2.5, and steel from iron and corundum ore', craft(r, SMELT_COPPER) === 2.5 && craft(r, SMELT_CORUNDUM) === 2.5 && craft(r, SMELT_STEEL) === 2.5);
ok('shipped: smelting ebony ore x1 (Miner tier 5)', craft(r, SMELT_EBONY) === 1 && r.recipeOf(SMELT_EBONY).tier === 5);
ok('shipped: smelting orichalcum ore x1 (Miner tier 3)', craft(r, SMELT_ORICHALCUM) === 1 && r.recipeOf(SMELT_ORICHALCUM).tier === 3);
ok('shipped: a skinned wolf x1.5', r.rateFor(A, 'skinner', 'skin', { refrId: 2, value: 10 }) === 1.5);
ok('shipped: a skill with no entry x1', r.rateFor(A, 'blade', 'hit', { targetId: 3 }) === 1);
ok('shipped: the hook is published', globalThis.__dboSkillRate === r.rateFor && globalThis.__dboSkillRateBrokeDown === r.noteBreakdown);
ok('shipped: one load line with the rates and the guard', /skillRates on: miner x2, skinner x1.5, blacksmith .*; 28 material tiers; salvage loop x0 for 60 min/.test(logs[logs.length - 1]), logs[logs.length - 1]);
r.noteBreakdown(A, ITEM.IronDagger);
ok('shipped: a breakdown then the same craft is worth nothing', craft(r, DAGGER) === 0);
globalThis.__dboSkillRates = undefined;
const FLAT = Object.assign({}, R, { rates: { miner: 1, skinner: 1, blacksmith: { default: 1, craftByTier: [1, 1, 1, 1, 1] } }, salvageLoop: { enabled: false, windowMinutes: 60, rate: 0 } });
r = load(FLAT);
ok('all x1: a vein, a dagger, a pelt x1', r.rateFor(A, 'miner', 'mine', {}) === 1 && craft(r, DAGGER) === 1 && r.rateFor(A, 'skinner', 'skin', {}) === 1);
r.noteBreakdown(A, ITEM.IronDagger);
ok('all x1, guard off: a breakdown then the same craft is still x1', craft(r, DAGGER) === 1);

// ---- rates by skill, kind and tier (guard off) -------------------------------------------------------------------------------------------------------
const PROPOSAL = Object.assign({}, R, {
  rates: { miner: 2, skinner: 1.5, blacksmith: { default: 1, craftByTier: [2.5, 1, 1, 1, 1] }, cook: { default: 1, craft: 1.2 }, harvesting: { default: 0.5, activate: -1, eat: 'x2' } },
  salvageLoop: { enabled: false, windowMinutes: 60, rate: 0 },
});
r = load(PROPOSAL);
ok('miner x2 on a vein', r.rateFor(A, 'miner', 'mine', { refrId: 1 }) === 2);
ok('miner x2 on a skill book award too (a number is every activity)', r.rateFor(A, 'miner', 'award', { key: 9 }) === 2);
ok('skinner x1.5 on a pelt', r.rateFor(A, 'skinner', 'skin', { refrId: 2 }) === 1.5);
ok('skinner x1.5 on an animal kill', r.rateFor(A, 'skinner', 'kill', { victimId: 4 }) === 1.5);
ok('iron dagger (iron ingot + strips): tier 1, x2.5', craft(r, DAGGER) === 2.5);
ok('horseshoe (iron ingot): tier 1, x2.5', craft(r, SHOE) === 2.5);
ok('smelting iron ore: tier 1, x2.5', craft(r, SMELT) === 2.5);
ok('steel sword (steel ingot): tier 2, x1', craft(r, SWORD) === 1);
ok('ebony + daedra heart: tier 5, x1', craft(r, DAEDRIC) === 1);
ok('tiers are read once per recipe', r.recipeOf(SWORD).tier === 2 && r.recipeOf(DAEDRIC).tier === 5 && r.recipeOf(DAGGER).product === ITEM.IronDagger);
ok('a recipe\'s own Blacksmith tier gate wins over its materials', craft(r, DAGGER, { 'tier:blacksmith': 3 }) === 1 && craft(r, SWORD, { 'tier:blacksmith': 1 }) === 2.5);
ok('another skill\'s tier gate is not read', craft(r, DAGGER, { 'tier:cook': 3 }) === 2.5);
ok('an unreadable recipe keeps the default', craft(r, 0x999) === 1);
ok('a craft with no recipe id keeps the default', r.rateFor(A, 'blacksmith', 'craft', {}) === 1);
ok('a blacksmith award (a skill book) is the default', r.rateFor(A, 'blacksmith', 'award', { key: 5 }) === 1);
ok('a kind rate: cook craft x1.2, cook eat x1', r.rateFor(A, 'cook', 'craft', { recipeId: DAGGER }) === 1.2 && r.rateFor(A, 'cook', 'eat', {}) === 1);
ok('odd rates are ignored: a negative kind rate and a string fall back to the default', r.rateFor(A, 'harvesting', 'activate', {}) === 0.5 && r.rateFor(A, 'harvesting', 'eat', {}) === 0.5);
r = load(Object.assign({}, PROPOSAL, { enabled: false }));
ok('enabled false: x1 everywhere', r.rateFor(A, 'miner', 'mine', {}) === 1 && craft(r, DAGGER) === 1);

// ---- the salvage loop guard -------------------------------------------------------------------------------------------
globalThis.__dboSkillRates = undefined;
const GUARD = Object.assign({}, PROPOSAL, { salvageLoop: { enabled: true, windowMinutes: 60, rate: 0 } });
r = load(GUARD);
ok('guard: a dagger nobody broke down is x2.5', craft(r, DAGGER) === 2.5);
logs.length = 0;
r.noteBreakdown(A, ITEM.IronDagger);
ok('guard: crafting the dagger just broken down is worth nothing', craft(r, DAGGER) === 0);
ok('guard: ...and says so once', logs.length === 1 && /crafted 1397e after breaking one down; blacksmith at x0 for 60 min/.test(logs[0]), logs);
craft(r, DAGGER); craft(r, DAGGER);
ok('guard: ...not once per craft', logs.length === 1, logs);
ok('guard: a different product is untouched', craft(r, SHOE) === 2.5 && craft(r, SWORD) === 1);
ok('guard: another character is untouched', r.rateFor(B, 'blacksmith', 'craft', { recipeId: DAGGER }) === 2.5);
ok('guard: any recipe making that product counts', craft(r, DAEDRIC) === 0);
ok('guard: a non-craft act is untouched', r.rateFor(A, 'miner', 'mine', {}) === 2);
// The smelter's own breakdown recipes (IWBreakdown*, IAB*) take an item apart without salvage.js
ok('guard: forging an iron tanto is x2.5', craft(r, TANTO) === 2.5);
ok('guard: smelting it back (IWBreakdownIronTanto) is a tier 1 craft, x2.5', craft(r, TANTO_APART) === 2.5);
ok('guard: ...and remaking the tanto within the hour is worth nothing', craft(r, TANTO) === 0);
ok('guard: ...for that character only', r.rateFor(B, 'blacksmith', 'craft', { recipeId: TANTO }) === 2.5);
ok('guard: the breakdown recipe lists what it takes apart', JSON.stringify(r.recipeOf(TANTO_APART).consumes) === JSON.stringify([ITEM.IronTanto]) && r.recipeOf(TANTO).consumes.length === 0);
clock += 59 * 60000;
ok('guard: still within the hour', craft(r, DAGGER) === 0);
const kept = load(GUARD);
ok('guard: a gamemode reload keeps what was broken down', craft(kept, DAGGER) === 0);
clock += 2 * 60000;
ok('guard: after the window the dagger is worth x2.5 again', craft(kept, DAGGER) === 2.5);
r = load(Object.assign({}, GUARD, { salvageLoop: { enabled: true, windowMinutes: 30, rate: 0.25 } }));
r.noteBreakdown(B, ITEM.Horseshoe);
ok('guard: a configured rate applies (x0.25)', r.rateFor(B, 'blacksmith', 'craft', { recipeId: SHOE }) === 0.25);
clock += 31 * 60000;
ok('guard: ...for its own window (30 min)', r.rateFor(B, 'blacksmith', 'craft', { recipeId: SHOE }) === 2.5);
globalThis.__dboSkillRates = undefined;
r = load(PROPOSAL);
r.noteBreakdown(B, ITEM.Horseshoe);
r.rateFor(B, 'blacksmith', 'craft', { recipeId: TANTO_APART });
ok('guard off: a smelter breakdown is not recorded either', !globalThis.__dboSkillRates.brokeDown.has(`${B >>> 0}:${ITEM.IronTanto}`));
ok('guard off: a breakdown is not even recorded', !globalThis.__dboSkillRates.brokeDown.has(`${B >>> 0}:${ITEM.Horseshoe}`));

// ---- a config that is missing or broken -------------------------------------------------------------------------------
r = load(undefined);
ok('no config: x1, guard off', r.rateFor(A, 'miner', 'mine', {}) === 1 && craft(r, DAGGER) === 1);
r = load({ enabled: true, rates: { blacksmith: { craftByTier: 'fast' } }, materialTiers: { IngotSteel: 'two' } });
ok('a broken craftByTier or tier table: x1, no throw', craft(r, SWORD) === 1);

Date.now = realNow;
console.log(`${checks - fails}/${checks} checks passed`);
process.exit(fails ? 1 : 0);
