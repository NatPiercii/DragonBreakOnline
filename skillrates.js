// DragonBreak Online: how much a skill's metered work is worth, per skill and per activity (QoL feedback via Nate,
// 2026-10-04: mining x2-3, iron smithing x2-3, skinning +50%). Loaded by gamemode.js; config "skillRates".
//
// masterySystem (fork skymp5-server) meters every act through the repeat ring, the hourly bucket and the day's caps
// exactly as before, then multiplies what it kept by globalThis.__dboSkillRate(actorId, skillId, kind, detail), clamped
// to 0..5, the way the playtesters' boost (private.xpBoost) is applied. A rate therefore moves a skill further for the
// same hour of work and never lets more work through the bucket. A server without that hook ignores this file.
//
// rates.<skill> is a number (every activity), or { default, <kind>: n, craftByTier: [t1..t5] }. Kinds are the
// masterySystem event kinds: craft, mine, chop, skin, kill, hit, hurt, cast, read, lock, prayer, eat, activate, award.
// Anything done in beast form is worth beastRate (0), a staff award excepted: the beast trains no skill.
// firstCraft (Discord, 10 Oct: "bonus xp for new items crafted up to a certain number, then diminished"; Nate: build it):
// the first time a character makes an item it has never made in that skill, the craft is worth `rate` times as much, in
// full for the first `fullFor` different items, then less and less (1 + (rate - 1) x fullFor / (n + 1) for the n-th
// different item, never below 1). It multiplies after the meter like every rate here, so it speeds a skill along and
// never lets more work through the bucket or the day's caps. Tempering makes nothing new and earns none. The items made are
// kept on the character (private.dboCraftedKinds: { <skill>: [desc...] }), so a relog resets nothing. With masterySystem's
// credit report (__dboSkillRateCredited) an item is marked only when its craft credited something, so a craft at a spent
// hourly bucket or day's cap keeps the bonus for next time.
// craftByTier rates a craft by the recipe's tier: the recipe's own DBO_Skill_<skill>_T<n> gate when it carries one,
// otherwise the highest materialTiers entry among its ingredients (editor ids; anything not listed is tier 1: iron,
// copper, bronze, leather, hide, wood). salvageLoop rates a craft of a product the same character broke down at a
// station (salvage.js) in the last windowMinutes.
'use strict';

module.exports = (api) => {
  const { log, cfg, recordOf, fieldsOf, inBeastForm, mp, personal } = api;
  // beastRate: work done in werewolf or Vampire Lord form trains no skill (Nate, 5 Oct): claws arrive as fists (0x1f4)
  const C = Object.assign({ enabled: true, rates: {}, materialTiers: {}, salvageLoop: {}, beastRate: 0 }, cfg.skillRates || {});
  const LOOP = Object.assign({ enabled: false, windowMinutes: 60, rate: 0 }, C.salvageLoop || {});
  const FIRST = Object.assign({ enabled: false, rate: 3, fullFor: 25, skills: ['cook', 'blacksmith', 'alchemist', 'tailor'], maxKept: 3000,
    noBenches: ['CraftingSmithingArmorTable', 'CraftingSmithingSharpeningWheel'] }, C.firstCraft || {});
  const TIERS = {};
  for (const [k, v] of Object.entries(C.materialTiers || {})) if (!k.startsWith('_') && Number(v) >= 1) TIERS[k.toLowerCase()] = Math.min(5, Math.floor(Number(v)));

  // Survive a gamemode reload; a restart forgets them, which only forgives a loop in progress
  const S = globalThis.__dboSkillRates = globalThis.__dboSkillRates || { brokeDown: new Map(), told: new Map() };
  if (!(S.firstPending instanceof Map)) S.firstPending = new Map();   // actor|skill -> the first-time craft waiting for its credit
  const recipeCache = new Map();   // recipe id -> { product, tier }

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  const u32 = (f, off) => (f && f.data && f.data.byteLength >= off + 4 ? new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength).getUint32(off, true) : 0);
  const globalOf = (lr, local) => { try { return local ? lr.toGlobalRecordId(local) >>> 0 : 0; } catch (e) { return 0; } };

  // What the recipe makes, its tier by its ingredients, and the weapons and armour it takes apart (CNTO: the item's
  // record-local id at 0, the count at 4)
  const recipeOf = (recipeId) => {
    const id = Number(recipeId) >>> 0;
    if (recipeCache.has(id)) return recipeCache.get(id);
    const lr = id ? recordOf(id) : null;
    // An unreadable recipe has no tier, so it keeps the skill's default rate
    let tier = lr ? 1 : 0;
    const consumes = [];
    for (const f of fieldsOf(lr, 'CNTO')) {
      const item = globalOf(lr, u32(f, 0));
      const r = recordOf(item);
      const t = TIERS[String((r && r.record.editorId) || '').toLowerCase()];
      if (t > tier) tier = t;
      const type = String((r && r.record.type) || '');
      if (item && (type === 'WEAP' || type === 'ARMO')) consumes.push(item);
    }
    const benchId = globalOf(lr, u32(fieldsOf(lr, 'BNAM')[0], 0));
    const benchRec = benchId ? recordOf(benchId) : null;
    const out = { product: globalOf(lr, u32(fieldsOf(lr, 'CNAM')[0], 0)), tier, consumes, bench: String((benchRec && benchRec.record.editorId) || '') };
    recipeCache.set(id, out);
    return out;
  };

  const loopKey = (actorId, baseId) => `${actorId >>> 0}:${baseId >>> 0}`;
  const brokeDownRecently = (actorId, baseId, now) => {
    const at = S.brokeDown.get(loopKey(actorId, baseId));
    return at !== undefined && now - at < Math.max(0, Number(LOOP.windowMinutes) || 0) * 60000;
  };

  const rateFor = (actorId, skillId, kind, detail) => {
    if (kind !== 'award' && typeof inBeastForm === 'function' && inBeastForm(actorId >>> 0)) return num(C.beastRate) ?? 0;
    if (!C.enabled) return 1;
    const spec = (C.rates || {})[skillId];
    let rate = 1;
    if (num(spec) !== undefined) rate = spec;
    else if (spec && typeof spec === 'object') {
      rate = num(spec.default) !== undefined ? spec.default : 1;
      if (num(spec[kind]) !== undefined) rate = spec[kind];
      if (kind === 'craft' && Array.isArray(spec.craftByTier) && detail && detail.recipeId) {
        const marked = Number(detail[`tier:${skillId}`]) || 0;
        const tier = marked >= 1 ? Math.min(5, marked) : recipeOf(detail.recipeId).tier;
        if (tier >= 1 && num(spec.craftByTier[tier - 1]) !== undefined) rate = spec.craftByTier[tier - 1];
      }
    }
    // A product is matched, not a recipe: rotating through different items still works, and the bucket bounds that
    if (kind === 'craft' && LOOP.enabled && detail && detail.recipeId) {
      const now = Date.now();
      const { product, consumes } = recipeOf(detail.recipeId);
      if (product && brokeDownRecently(actorId, product, now)) {
        const k = loopKey(actorId, product);
        if (!(now - (S.told.get(k) || 0) < 60 * 60000)) { S.told.set(k, now); log(`skillRates: ${(actorId >>> 0).toString(16)} crafted ${product.toString(16)} after breaking one down; ${skillId} at x${num(LOOP.rate) ?? 0} for ${LOOP.windowMinutes} min`); }
        rate = num(LOOP.rate) !== undefined ? LOOP.rate : 0;
      }
      // A smelter recipe that takes a weapon or armour apart (Immersive Weapons' IWBreakdown*, Immersive Armors' IAB*) is a
      // breakdown too, as salvage.js's are
      for (const item of consumes) noteBreakdown(actorId, item);
    }
    // The race's one boosted skill (racial.js, the overhaul): after the rate above, never for a staff award
    if (typeof globalThis.__dboRaceSkillRate === 'function') {
      try { const r = Number(globalThis.__dboRaceSkillRate(actorId >>> 0, skillId, kind)); if (Number.isFinite(r) && r > 0) rate *= r; } catch (e) { /* no race boost */ }
    }
    if (kind === 'craft' && rate > 0) rate *= firstCraftRate(actorId, skillId, detail);
    return rate;
  };

  // The first-time bonus for this craft (1 when it is not one), noting the item as made
  const KINDS = 'private.dboCraftedKinds';
  const firstCraftRate = (actorId, skillId, detail) => {
    if (FIRST.enabled !== true || !detail || !detail.recipeId || !(FIRST.skills || []).includes(skillId) || !mp) return 1;
    const { product, bench } = recipeOf(detail.recipeId);
    if (!product || (FIRST.noBenches || []).includes(bench)) return 1;
    let desc = ''; try { desc = String(mp.getDescFromId(product >>> 0)).toLowerCase(); } catch (e) { return 1; }
    if (!desc) return 1;
    let all = null; try { all = mp.get(actorId >>> 0, KINDS); } catch (e) { return 1; }
    all = all && typeof all === 'object' ? all : {};
    const made = Array.isArray(all[skillId]) ? all[skillId] : [];
    if (made.includes(desc)) return 1;
    const n = made.length;   // different items made before this one
    const full = Math.max(1, Number(FIRST.fullFor) || 25), r = Math.max(1, Number(FIRST.rate) || 1);
    const mult = n < full ? r : 1 + (r - 1) * full / (n + 1);
    // A server whose masterySystem reports what it credited (globalThis.__dboMasteryCreditsHook) marks the item only when the
    // craft really earned something: at a spent bucket or cap the bonus waits for the next time. An older one marks it now
    if (globalThis.__dboMasteryCreditsHook) S.firstPending.set(`${actorId >>> 0}|${skillId}`, { desc, mult });
    else markMade(actorId, skillId, desc, mult);
    return mult;
  };
  const markMade = (actorId, skillId, desc, mult) => {
    let all = null; try { all = mp.get(actorId >>> 0, KINDS); } catch (e) { return; }
    all = all && typeof all === 'object' ? all : {};
    const made = Array.isArray(all[skillId]) ? all[skillId] : [];
    if (made.includes(desc)) return;
    if (made.length < (Number(FIRST.maxKept) || 3000)) {
      try { mp.set(actorId >>> 0, KINDS, Object.assign({}, all, { [skillId]: made.concat([desc]) })); } catch (e) { return; }
    }
    try { if (typeof personal === 'function') personal(actorId >>> 0, mult >= 1.5 ? 'Something new: you learn more making it the first time.' : 'Something new, though by now you learn little more from it.'); } catch (e) { /* the message is optional */ }
  };
  // masterySystem, after the meter: the units this act credited to this skill (fork mastery-credited-hook)
  const credited = (actorId, skillId, kind, detail, units) => {
    const key = `${actorId >>> 0}|${skillId}`;
    const p = S.firstPending.get(key);
    if (!p) return;
    S.firstPending.delete(key);
    if (kind === 'craft' && Number(units) > 0) markMade(actorId, skillId, p.desc, p.mult);
  };

  const noteBreakdown = (actorId, baseId) => {
    if (!LOOP.enabled || !baseId) return;
    const now = Date.now();
    S.brokeDown.set(loopKey(actorId, baseId), now);
    if (S.brokeDown.size > 5000) {
      const windowMs = Math.max(0, Number(LOOP.windowMinutes) || 0) * 60000;
      for (const [k, at] of S.brokeDown) if (now - at >= windowMs) { S.brokeDown.delete(k); S.told.delete(k); }
    }
  };

  globalThis.__dboSkillRate = rateFor;
  globalThis.__dboSkillRateCredited = credited;
  globalThis.__dboSkillRateBrokeDown = noteBreakdown;

  const plain = (v) => Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('_')));
  const shown = Object.entries(C.rates || {}).filter(([k]) => !k.startsWith('_')).map(([k, v]) => `${k} ${v && typeof v === 'object' ? JSON.stringify(plain(v)) : 'x' + v}`);
  log(`skillRates ${C.enabled ? 'on' : 'off'}: ${shown.join(', ') || 'every skill x1'}; ${Object.keys(TIERS).length} material tiers; salvage loop ${LOOP.enabled ? `x${LOOP.rate} for ${LOOP.windowMinutes} min` : 'off'}; beast form x${num(C.beastRate) ?? 0}`);
  return { rateFor, noteBreakdown, recipeOf };
};
