// DragonBreak Online: dungeon loot by material tier (Nate, 1 Oct 2026; ~/claude-nate-release/specs/loot-tiers-final-2026-10-01.md).
// Required by dungeons.js on every load (it clears this file's require cache first). Pure: no state of its own.
//
// Every weapon and armour has a material family (loot-materials.json, tools/loot/loot_materials.py: keyword, then template
// chain, then editor id). A family belongs to a tier, or is never loot (Ebony, Daedric, Dragon, Stalhrim, Orcish, Golden
// Saint, Aetherium), or is a trinket (clothing, jewellery, staves: their own roll), or is a faction uniform (never loot,
// with every item faction-gear.json names). An item the map does not know is not loot.
// A difficulty rolls a tier from its row (a chest, a boss, a raid boss, a locked chest by its lock); a tier with nothing
// there for the dungeon falls to the next one down. Enchanted gear rolls the same tiers under a cap on its rank.
// Config dungeons.lootTiers overrides any table below.
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
// Nate, 1 Oct ("you can allow it"): vanilla Steel plate, Scaled and Elven gilded drop in Cyrodiil too, filling its tier 3
const ANY_PROVINCE = new Set(['steelplate', 'scaled', 'elven_gilded']);
// Cyrodiil has no tier 3 weapon: the high Elven weapons stand in (Nate's (c))
const T3_WEAPON_STANDIN = /^(?:CYR)?Elven(?:Greatsword|Battleaxe|Warhammer|Bow)$/;

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

module.exports = ({ materials, factionGear, cfg }) => {
  const C = cfg || {};
  const tierOf = Object.assign({}, TIER_OF, C.tierOf || {});
  const rows = { chest: Object.assign({}, ROWS.chest, (C.rows || {}).chest || {}), boss: Object.assign({}, ROWS.boss, (C.rows || {}).boss || {}), raidBoss: Object.assign({}, ROWS.raidBoss, (C.rows || {}).raidBoss || {}) };
  const enemy = { ordinary: Object.assign({}, ENEMY.ordinary, (C.enemy || {}).ordinary || {}), boss: Object.assign({}, ENEMY.boss, (C.enemy || {}).boss || {}) };
  const enchCap = Object.assign({}, ENCH_CAP, C.enchCap || {});
  const fam = new Map(Object.entries((materials && materials.items) || {}).map(([k, v]) => [normDesc(k), String(v)]));
  const faction = new Set(Object.keys((factionGear && factionGear.items) || {}).map(normDesc));

  // { kind: 'gear' | 'trinket' | 'never' | 'uniform' | 'unknown', family, tier }
  const classOf = (desc) => {
    const d = normDesc(desc);
    const f = fam.get(d);
    if (!f) return { kind: 'unknown', family: '', tier: 0 };
    if (NEVER.has(f)) return { kind: 'never', family: f, tier: 0 };
    if (UNIFORM.has(f) || faction.has(d)) return { kind: 'uniform', family: f, tier: 0 };
    if (TRINKET.has(f)) return { kind: 'trinket', family: f, tier: 0 };
    const t = Number(tierOf[f]) || 0;
    return t ? { kind: 'gear', family: f, tier: t } : { kind: 'unknown', family: f, tier: 0 };
  };
  const lootable = (desc) => { const c = classOf(desc); return c.kind === 'gear' || c.kind === 'trinket'; };
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
  return { classOf, lootable, rowFor, rollTier, enchRank, enchOk, enemyTiers, pickTier, anyProvince: (desc) => ANY_PROVINCE.has(classOf(desc).family), T3_WEAPON_STANDIN, ROWS: rows };
};
module.exports.normDesc = normDesc;
