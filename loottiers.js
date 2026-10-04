// DragonBreak Online: dungeon loot by material tier (Nate, 1 Oct 2026; ~/claude-nate-release/specs/loot-tiers-final-2026-10-01.md).
// Required by dungeons.js on every load (it clears this file's require cache first). Pure: no state of its own.
//
// Every weapon and armour has a material family (loot-materials.json, tools/loot/loot_materials.py: keyword, then template
// chain, then editor id). A family belongs to a tier, or is never loot (Ebony, Daedric, Dragon, Stalhrim, Orcish, Golden
// Saint, Aetherium), or is a trinket (clothing, jewellery, staves: their own roll), or is a faction uniform (never loot,
// with every item faction-gear.json names). An item the map does not know is not loot. loot-overrides.json names items
// that are never loot whatever their material (an untextured model, say), and is read before the map.
// A difficulty rolls a tier from its row (a chest, a boss, a raid boss, a locked chest by its lock); a tier with nothing
// there for the dungeon falls to the next one down. Enchanted gear rolls the same tiers under a cap on its rank.
// Config dungeons.lootTiers overrides any table below.
// A ceiling over all of it (Jake and Nate, 1 Oct, a stopgap until rarity is designed): `cap` names the families that may
// drop as weapons and armour at all, whatever a row rolls. Gear of any other family is 'capped' and never loot, at every
// path that asks this module (chests, bosses, enemy arms, bodies, camps, the Ayleid table, enchanted gear).
// Ingots, ores and ammunition (Nate, 4 Oct), from the lists gearswap.js swaps away from what players own, so what the
// swap takes away no loot path hands back; aboveCap says so, with the swap's own entry:
//   - Every ingot and ore above steel is NEVER loot, at any cap, 'none' too: "people should have to craft higher tiers
//     and grind for it" (Nate, 4 Oct): mine and craft, never loot. Lifting the cap brings back the higher gear and
//     arrows, never these. Two lists hold them:
//   - gear-swap.json `metals`: those with no ore a player can mine (Dwarven from scrap, Adamantium and Stalhrim, which
//     skills.json oreByTier does not list). The swap takes these from packs and containers. Dragon bone and scales are
//     on neither list: a slain dragon's body is their one source, and dungeons.js DRAGON_LOOT keeps them out of loot.
//   - LOOT_ONLY_METALS: the ores players mine (oreByTier above steel: quicksilver, orichalcum, moonstone, malachite,
//     ebony; Meteoric Iron, the Bleak-Frost Mine) and the ingots they smelt to (2 ore to 1 at the smelter). Never swapped
//     (Nate, 4 Oct: "Keep mined ores, swap only gear"): they stay off gear-swap.json, or the login and container sweeps
//     would turn a miner's ore into steel. `to` is what salvage gives in their place (salvage.js), as the swap's list
//     does for the others. More via config lootTiers.lootOnlyMetals (descs). tests/loot-tiers-harness.js checks both
//     lists against oreByTier and labour.js.
//   - `ammo` follows the cap, as gear does: above it under 'steel' or 'iron', loot again under 'none'.
// Without the file (`swap` not given or unreadable) every ingot and ore counts as above, and every arrow under a cap,
// as an unknown weapon is not loot.
'use strict';

const TIER_OF = {
  iron: 1, hide: 1, leather: 1, studded: 1, wood: 1, goblin: 1, ancient_nord: 1, falmer: 1, forsworn: 1,
  steel: 2, imperial: 2, dwarven: 2, elven: 2, bonemold: 2, chitin: 2, mithril: 2, silver: 2, vampire: 2,
  ancient_nord_honed: 2, falmer_honed: 2, ancient_imperial: 2, ayleid: 2,
  steelplate: 3, scaled: 3, elven_gilded: 3, nordic: 3,
  glass: 4,
};
const NEVER = new Set(['DRAGON', 'DAEDRIC', 'EBONY', 'stalhrim', 'orcish', 'golden', 'aetherium']);
const UNIFORM = new Set(['stormcloak', 'guard', 'penitus', 'thievesguild', 'dawnguard', 'blades']);
const TRINKET = new Set(['clothing', 'staff']);
// Kept out of loot, never swapped: the metals players mine and their ingots (Skyrim.esm's five, from the Recipe<Ingot>
// smelter records; Beyond Skyrim's Meteoric Iron, BSAssets.esm, which tempers the Ayleid gear)
const STEEL = '5ace5:Skyrim.esm', IRON_ORE = '71cf3:Skyrim.esm';
const LOOT_ONLY_METALS = {
  '5ace2:skyrim.esm': { edid: 'OreQuicksilver', to: IRON_ORE }, '5ada0:skyrim.esm': { edid: 'IngotQuicksilver', to: STEEL },
  '5acdd:skyrim.esm': { edid: 'OreOrichalcum', to: IRON_ORE }, '5ad99:skyrim.esm': { edid: 'IngotOrichalcum', to: STEEL },
  '5ace0:skyrim.esm': { edid: 'OreMoonstone', to: IRON_ORE }, '5ad9f:skyrim.esm': { edid: 'IngotIMoonstone', to: STEEL },
  '5ace1:skyrim.esm': { edid: 'OreMalachite', to: IRON_ORE }, '5ada1:skyrim.esm': { edid: 'IngotMalachite', to: STEEL },
  '5acdc:skyrim.esm': { edid: 'OreEbony', to: IRON_ORE }, '5ad9d:skyrim.esm': { edid: 'IngotEbony', to: STEEL },
  '601c92:bsassets.esm': { edid: 'BSKOreMeteoricIron', to: IRON_ORE }, '601c91:bsassets.esm': { edid: 'BSKIngotMeteoricIron', to: STEEL },
};
// Nate, 1 Oct ("you can allow it"): vanilla Steel plate, Scaled and Elven gilded drop in Cyrodiil too, filling its tier 3
const ANY_PROVINCE = new Set(['steelplate', 'scaled', 'elven_gilded']);
// Cyrodiil has no tier 3 weapon: the high Elven weapons stand in (Nate's (c))
const T3_WEAPON_STANDIN = /^(?:CYR)?Elven(?:Greatsword|Battleaxe|Warhammer|Bow)$/;
// The ceilings. 'steel' (the default): tier 1 and the steel of each province (steel, Imperial, silver; Cyrodiil's
// Colovian, Nibenese and Akaviri steel are steel). Honed Ancient Nord and Falmer hit like Elven, Mithril armours like it,
// so they stay out. 'iron': tier 1 only. 'none': no ceiling, the tiers alone.
const TIER1 = Object.keys(TIER_OF).filter((f) => TIER_OF[f] === 1);
const CAPS = { iron: TIER1, steel: TIER1.concat(['steel', 'imperial', 'silver']) };

// Shares by tier, per difficulty (story Novice, normal Adept, hard Expert, nightmare Master)
const ROWS = {
  chest: { story: { 1: 85, 2: 15 }, normal: { 1: 30, 2: 60, 3: 10 }, hard: { 2: 35, 3: 50, 4: 15 }, nightmare: { 2: 15, 3: 45, 4: 40 } },
  boss: { story: { 1: 50, 2: 50 }, normal: { 2: 60, 3: 35, 4: 5 }, hard: { 2: 10, 3: 50, 4: 40 }, nightmare: { 3: 35, 4: 65 } },
  // a raid boss rolls the boss row of the difficulty above; at Master its own
  raidBoss: { story: { 2: 60, 3: 35, 4: 5 }, normal: { 2: 10, 3: 50, 4: 40 }, hard: { 3: 35, 4: 65 }, nightmare: { 3: 20, 4: 80 } },
};
// The enemies' own arms (and so what their bodies hand over): the tiers they may carry
const ENEMY = {
  ordinary: { story: [1], normal: [1, 2], hard: [2, 3], nightmare: [2, 3, 4] },
  boss: { story: [1], normal: [1, 2], hard: [2, 3, 4], nightmare: [2, 3, 4] },
};
// The highest enchantment rank (vanilla 01-06; Beyond Skyrim's 01-03 count double); a boss one more
const ENCH_CAP = { story: 2, normal: 3, hard: 4, nightmare: 6 };

const normDesc = (d) => { const s = String(d || ''); const i = s.indexOf(':'); if (i < 0) return s.toLowerCase(); const n = parseInt(s.slice(0, i), 16); return (Number.isFinite(n) ? n.toString(16) : s.slice(0, i).toLowerCase()) + ':' + s.slice(i + 1).toLowerCase(); };

module.exports = ({ materials, factionGear, overrides, cfg, swap }) => {
  const C = cfg || {};
  const tierOf = Object.assign({}, TIER_OF, C.tierOf || {});
  const rows = { chest: Object.assign({}, ROWS.chest, (C.rows || {}).chest || {}), boss: Object.assign({}, ROWS.boss, (C.rows || {}).boss || {}), raidBoss: Object.assign({}, ROWS.raidBoss, (C.rows || {}).raidBoss || {}) };
  const enemy = { ordinary: Object.assign({}, ENEMY.ordinary, (C.enemy || {}).ordinary || {}), boss: Object.assign({}, ENEMY.boss, (C.enemy || {}).boss || {}) };
  const enchCap = Object.assign({}, ENCH_CAP, C.enchCap || {});
  const capName = C.cap === undefined ? 'steel' : String(C.cap || 'none');
  const capSet = CAPS[capName] ? new Set(CAPS[capName]) : null;
  const fam = new Map(Object.entries((materials && materials.items) || {}).map(([k, v]) => [normDesc(k), String(v)]));
  const faction = new Set(Object.keys((factionGear && factionGear.items) || {}).map(normDesc));
  const handNever = new Map(Object.entries((overrides && overrides.never) || {}).filter(([k]) => k[0] !== '_').map(([k, why]) => [normDesc(k), String(why)]));

  // { kind: 'gear' | 'trinket' | 'never' | 'uniform' | 'capped' | 'unknown', family, tier }
  const classOf = (desc) => {
    const d = normDesc(desc);
    if (handNever.has(d)) return { kind: 'never', family: fam.get(d) || '', tier: 0, why: handNever.get(d) };
    const f = fam.get(d);
    if (!f) return { kind: 'unknown', family: '', tier: 0 };
    if (NEVER.has(f)) return { kind: 'never', family: f, tier: 0 };
    if (UNIFORM.has(f) || faction.has(d)) return { kind: 'uniform', family: f, tier: 0 };
    if (TRINKET.has(f)) return { kind: 'trinket', family: f, tier: 0 };
    const t = Number(tierOf[f]) || 0;
    if (!t) return { kind: 'unknown', family: f, tier: 0 };
    return capSet && !capSet.has(f) ? { kind: 'capped', family: f, tier: t } : { kind: 'gear', family: f, tier: t };
  };
  const lootable = (desc) => { const c = classOf(desc); return c.kind === 'gear' || c.kind === 'trinket'; };
  // Ingots, ores and arrows above the ceiling: gear-swap.json's metals and ammo, by the same normalised desc
  const swapMap = (name) => new Map(Object.entries((swap && swap[name]) || {}).filter(([k]) => k[0] !== '_').map(([k, v]) => [normDesc(k), v]));
  const METALS = swapMap('metals'), AMMO = swapMap('ammo');
  const LOOT_ONLY = new Map(Object.entries(Object.assign({}, LOOT_ONLY_METALS, Object.fromEntries((Array.isArray(C.lootOnlyMetals) ? C.lootOnlyMetals : []).map((x) => [String(x), { edid: String(x) }]))))
    .map(([k, v]) => [normDesc(k), v]));
  const swapKnown = !!(swap && swap.metals && swap.ammo);
  // -> null (may drop), else { kind: 'metal' | 'ammo' | 'unknown', to, edid, toEdid }. Metals at any cap; ammo under one
  const aboveCap = (desc, type) => {
    const d = normDesc(desc);
    const m = METALS.get(d); if (m) return Object.assign({ kind: 'metal' }, m);
    if (LOOT_ONLY.has(d)) return Object.assign({ kind: 'metal', lootOnly: true }, LOOT_ONLY.get(d));
    // Without the lists nothing of these kinds can be told apart, so none of it is loot (fail closed)
    if (!swapKnown && type === 'metal') return { kind: 'unknown' };
    if (!capSet) return null;
    const a = AMMO.get(d); if (a) return Object.assign({ kind: 'ammo' }, a);
    return !swapKnown && type === 'ammo' ? { kind: 'unknown' } : null;
  };
  // The row a roll uses: a chest, a boss, a raid boss, or a locked chest by its lock (Novice/Apprentice the chest row,
  // Adept halfway to the boss row, Expert and Master the boss row)
  const rowFor = (diffId, kind, lockLevel) => {
    const chest = rows.chest[diffId] || rows.chest.normal;
    const boss = rows.boss[diffId] || rows.boss.normal;
    if (kind === 'boss') return boss;
    if (kind === 'raidBoss') return rows.raidBoss[diffId] || boss;
    if (kind === 'lock') {
      const lv = Number(lockLevel) || 0;
      if (lv >= 3) return boss;
      if (lv === 2) { const out = {}; for (const t of [1, 2, 3, 4]) { const v = ((Number(chest[t]) || 0) + (Number(boss[t]) || 0)) / 2; if (v > 0) out[t] = v; } return out; }
    }
    return chest;
  };
  const rollTier = (row, rnd = Math.random) => {
    const total = [1, 2, 3, 4].reduce((n, t) => n + (Number(row[t]) || 0), 0);
    if (!(total > 0)) return 1;
    let r = rnd() * total;
    for (const t of [1, 2, 3, 4]) { r -= Number(row[t]) || 0; if (r < 0) return t; }
    return 4;
  };
  // The rank of an enchanted item from its editor id (EnchIronSwordFire03 is 3; Beyond Skyrim's 01-03 count double)
  const enchRank = (name) => {
    const m = /(\d{2})$/.exec(String(name || '')); if (!m) return 0;
    const n = Number(m[1]);
    return /^(?:CYR|BSK)/.test(String(name)) && n <= 3 ? n * 2 : n;
  };
  const enchOk = (name, diffId, boss) => { const r = enchRank(name); return !r || r <= (Number(enchCap[diffId]) || 3) + (boss ? 1 : 0); };
  const enemyTiers = (diffId, boss) => (boss ? enemy.boss : enemy.ordinary)[diffId] || [1, 2];
  // Picks one item of the rolled tier from a pool (already province- and ban-filtered), falling a tier at a time; null if none
  const pickTier = (list, row, opts = {}) => {
    const rnd = opts.rnd || Math.random;
    const want = rollTier(row, rnd);
    for (let t = want; t >= 1; t--) {
      let c = list.filter((it) => { const k = classOf(it.id); return k.kind === 'gear' && k.tier === t && (!opts.enchanted || enchOk(it.name, opts.diffId, opts.boss)); });
      if (!c.length && t === 3 && opts.weapons) c = list.filter((it) => T3_WEAPON_STANDIN.test(String(it.name || '')) && classOf(it.id).kind === 'gear');
      if (c.length) return c[Math.floor(rnd() * c.length)];
    }
    return null;
  };
  return { cap: capSet ? capName : 'none', classOf, lootable, aboveCap, swapKnown, LOOT_ONLY_METALS, rowFor, rollTier, enchRank, enchOk, enemyTiers, pickTier, anyProvince: (desc) => ANY_PROVINCE.has(classOf(desc).family), T3_WEAPON_STANDIN, ROWS: rows };
};
module.exports.normDesc = normDesc;
module.exports.LOOT_ONLY_METALS = LOOT_ONLY_METALS;
