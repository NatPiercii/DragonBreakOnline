// DragonBreak Online: Martial Arts, fists and staves (Nate, 2026-09-28: the Unarmed rework). Loaded by gamemode.js;
// config "martialArts". The skill keeps the id 'unarmed' so nobody loses progress; skills.json labels it Martial Arts and
// lists its staves (counts.weaponIds).
//
// - Fists, as in Morrowind: every landed blow drains the target's stamina (drainByTier, by the attacker's Martial Arts
//   rank; x powerDrainMult for a power attack), and armour stops them more than it stops a weapon (armorExtra: the
//   target's armour counts that much more). A landed unarmed power attack knocks a player's weapons out of their
//   hands, through combat.js's Disarm path and its cooldown. Papyrus reaches player actors only, so NPCs keep theirs.
// - Staves (quarterstaves, battle staves) count as Martial Arts, never Blunt, and partly pass through armour
//   (armorPierce: that share of the armour's reduction is ignored). Nothing pierces armour on the server today,
//   warhammers included, so there is no warhammer figure to sit just below; armorPierce is the only such number.
// - A global rule: a melee blow (fists and weapons, not bows or spells) lands weaker the more tired its attacker is.
//   At or above staminaDamage.fullAt of their stamina it is full; below, it falls linearly to minMult at none.
//
// Everything here reads the hit flags the C++ passes to onHitDamageAttempt (power, blocked, targetMaxStamina) and returns
// a factor for the hook's post-hit multiplier; the stamina drain is written to the target's percentages at once, as
// combat.js does for a block's stamina.
'use strict';

module.exports = (api) => {
  const { mp, log, display, profileOf, masteryOf, wornOf, armorPieceOf, gmstFloat, weaponHandsOf, skills, combat, cfg } = api;
  const C = Object.assign({ enabled: true, log: true }, cfg.martialArts || {});
  const STAMINA = Object.assign({ enabled: true, minMult: 0.5, fullAt: 0.5 }, C.staminaDamage || {});
  const FISTS = Object.assign({ armorExtra: 0.5, drainByTier: [6, 8, 10, 13, 16], untrainedDrain: 4, powerDrainMult: 2, powerDisarm: true, powerDisarmMinRank: 0 }, C.fists || {});
  const STAVES = Object.assign({ armorPierce: 0.25 }, C.staves || {});
  const UNARMED = 0x1f4;

  // The staves, from skills.json (the skill's counts.weaponIds), by form id
  const staffIds = new Set();
  const skill = ((skills && skills.skills) || []).find((s) => s && s.id === 'unarmed');
  for (const d of ((skill && skill.counts) || {}).weaponIds || []) { try { const id = mp.getIdFromDesc(String(d)) >>> 0; if (id) staffIds.add(id); } catch (e) { /* not in this load order */ } }
  const isStaff = (src) => staffIds.has(src >>> 0);
  const isFist = (src) => (src >>> 0) === UNARMED;

  const isPlayer = (a) => profileOf(a) >= 0;
  const rankIn = (a) => {
    const rec = masteryOf(a);
    if (!rec || !Array.isArray(rec.order) || rec.order.indexOf('unarmed') === -1) return -1;
    return Math.max(0, Math.min(4, Number(((rec.skills || {}).unarmed || {}).rank) || 0));
  };
  const pct = (a) => { try { const p = mp.get(a, 'percentages'); return p && typeof p.stamina === 'number' ? p : null; } catch (e) { return null; } };

  // The share of a hit the target's worn armour takes off, as the engine computes it (rating x fArmorScalingFactor %,
  // capped at fMaxArmorRating; TES5DamageFormula CalcArmorDamagePenalty)
  const armorReduction = (tgt) => {
    let rating = 0;
    try { for (const w of wornOf(mp.get(tgt, 'equipment'))) { const p = armorPieceOf(w.baseId); if (p) rating += p.rating; } } catch (e) { return 0; }
    if (!(rating > 0)) return 0;
    return Math.min(rating * gmstFloat(0x21a72, 0.12), gmstFloat(0x37deb, 80)) / 100;
  };

  // The attacker's tiredness: full damage at fullAt of their stamina or more, down to minMult at none
  const staminaMult = (agg) => {
    if (!STAMINA.enabled) return 1;
    const p = pct(agg);
    if (!p) return 1;
    const full = Math.max(0.01, Number(STAMINA.fullAt) || 0.5), min = Math.max(0, Math.min(1, Number(STAMINA.minMult)));
    return min + (1 - min) * Math.min(1, Math.max(0, p.stamina) / full);
  };

  // Called from the hit hook for a landed or blocked blow; returns the factor for the hook's multiplier
  const onAttempt = (agg, tgt, src, dmg, flags) => {
    if (!C.enabled || agg === tgt || !(dmg > 0)) return 1;
    const f = flags && typeof flags === 'object' ? flags : {};
    if (f.spell) return 1;
    const fist = isFist(src), staff = isStaff(src);
    const melee = fist || weaponHandsOf(src) === 'one' || weaponHandsOf(src) === 'two';
    if (!melee) return 1;
    const events = [];
    let m = staminaMult(agg);
    if (m < 1) events.push(`tired x${m.toFixed(2)}`);
    if (fist || staff) {
      const red = armorReduction(tgt);
      if (red > 0) {
        const kept = 1 - red;
        if (fist) { const a = Math.max(0.05, 1 - red * (1 + (Number(FISTS.armorExtra) || 0))) / kept; m *= a; events.push(`fist into armour x${a.toFixed(2)}`); }
        else { const a = (1 - red * (1 - Math.max(0, Math.min(1, Number(STAVES.armorPierce) || 0)))) / kept; m *= a; events.push(`staff through armour x${a.toFixed(2)}`); }
      }
    }
    if (fist && !f.blocked) {
      const rank = rankIn(agg);
      // Stamina drain: points of the target's maximum, which the C++ sends with the hit
      const perHit = (rank >= 0 ? Number((FISTS.drainByTier || [])[rank]) : Number(FISTS.untrainedDrain)) || 0;
      const points = perHit * (f.power ? Number(FISTS.powerDrainMult) || 1 : 1);
      const max = Number(f.targetMaxStamina), p = pct(tgt);
      if (points > 0 && max > 0 && p) {
        const stamina = Math.max(0, p.stamina - points / max);
        try { mp.set(tgt, 'percentages', { health: p.health, magicka: p.magicka, stamina }); events.push(`drains ${points} stamina (${Math.round(stamina * 100)}% left)`); } catch (e) { /* not an actor */ }
      }
      // A landed unarmed power attack knocks a player's weapons out of their hands
      if (f.power && FISTS.powerDisarm && rank >= (Number(FISTS.powerDisarmMinRank) || 0) && isPlayer(tgt) && combat && typeof combat.disarmPlayer === 'function') {
        const n = combat.disarmPlayer(tgt, 'A blow knocks the weapon from your hands.');
        if (n > 0) events.push(`disarms ${n} weapon(s)`);
      }
    }
    if (C.log && events.length) log(`martial ${display(agg)} -> ${display(tgt)}: ${events.join(', ')}${fist ? ' [fist]' : staff ? ' [staff]' : ''}${f.power ? ' [power]' : ''}`);
    return m;
  };

  log(`martial arts ${C.enabled ? 'on' : 'off'}: ${staffIds.size} staves count as Martial Arts; tired blows down to x${STAMINA.minMult} below ${Math.round(STAMINA.fullAt * 100)}% stamina${STAMINA.enabled ? '' : ' (off)'}; fists drain ${JSON.stringify(FISTS.drainByTier)} stamina, armour counts x${1 + Number(FISTS.armorExtra)} against them; staves pass ${Math.round(STAVES.armorPierce * 100)}% of armour`);
  return { onAttempt, isStaff, isFist, staminaMult };
};
