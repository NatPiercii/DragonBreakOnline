// DragonBreak Online: skill-based fights (Nat, 2026-09-25: "i want fights to be skill based yanno, with staggering, shield
// bash, damage etc"). Loaded by gamemode.js; design and numbers in COMBAT_DESIGN.md.
//
// The triangle: a power attack beats an open guard, a block beats attacks, a bash beats a block.
// - A blocked blow lets some through (chip) and the blocker pays the rest in stamina. At 0 stamina the guard breaks: a
//   stagger, and for guardBreakSeconds every blocked blow lands in full.
// - An unblocked power attack staggers. A shield stops that stagger but pays double stamina. A Master of the weapon's
//   skill staggers through a weapon block.
// - A bash deals a quarter of the weapon, always staggers, and breaks a guard it hits.
// - Defense Expert and Master shrug off a bash's stagger. One stagger per target every staggerCooldownSeconds.
//
// Everything here reads the hit flags the C++ passes as the fifth argument of onHitDamageAttempt (fork 71014c24:
// { spell, blocked, power, bash, sneak, unblockedDamage, targetMaxHealth?, targetMaxStamina? }). Without them nothing
// changes. Blocked blows reach the gamemode with 0 damage and no onHitDamage, so chip and stamina are applied here, as
// percentages of the maxima the C++ sends; without the maxima they are skipped and only the staggers work.
// Rules apply between players only (playersOnly): a stagger is a Papyrus call, which reaches player actors, not
// server-spawned NPCs, and NPC attackers staggering players locked them in place in PvE.

module.exports = (api) => {
  const { mp, log, profileOf, masteryOf, wornOf, recordOf, fieldsOf, weaponSkillOf, display, cfg } = api;
  const C = Object.assign({
    enabled: true, log: true, playersOnly: true,
    weaponChip: 0.30, shieldChip: 0.15, chipPerDefenseTier: 0.05,
    blockStaminaMult: 1, shieldStaminaMult: 0.5, powerIntoShieldStaminaMult: 2,
    guardBreakSeconds: 2,
    bashDamageMult: 0.25, bashStaggerResistRank: 3,
    powerStaggerThroughWeaponBlockRank: 4,
    staggerCooldownSeconds: 1.5, attackerStaggerCooldownSeconds: 3, staggerEvent: 'staggerStart',
    // Spells whose hit staggers a player instead of the explosion's ragdoll push, which only plays on the caster's
    // screen (athny, #bugs, 2026-09-26: Force Rune). Matched by editor id.
    staggerSpells: ['CYRForceRune'],
  }, cfg.combat || {});

  // actorId -> { guardBrokenUntil, staggerAt }
  const S = globalThis.__dboCombat instanceof Map ? globalThis.__dboCombat : (globalThis.__dboCombat = new Map());
  const st = (a) => { let s = S.get(a); if (!s) { s = { guardBrokenUntil: 0, staggerAt: 0, causedStaggerAt: 0 }; S.set(a, s); } return s; };

  const isPlayer = (a) => profileOf(a) >= 0;
  const rankIn = (a, skill) => {
    const rec = masteryOf(a);
    if (!skill || !rec || !Array.isArray(rec.order) || rec.order.indexOf(skill) === -1) return -1;
    return Math.max(0, Number(((rec.skills || {})[skill] || {}).rank) || 0);
  };

  // A worn shield: an ARMO whose BOD2 slot mask has bit 9 (slot 39), as armourswap.js reads it
  const shieldCache = new Map();
  const isShield = (baseId) => {
    if (shieldCache.has(baseId)) return shieldCache.get(baseId);
    let yes = false;
    const r = recordOf(baseId);
    const bod2 = r && String(r.record.type) === 'ARMO' ? fieldsOf(r, 'BOD2')[0] : null;
    if (bod2 && bod2.data.byteLength >= 4) yes = (new DataView(bod2.data.buffer, bod2.data.byteOffset, bod2.data.byteLength).getUint32(0, true) & (1 << 9)) !== 0;
    shieldCache.set(baseId, yes);
    return yes;
  };
  const hasShield = (a) => { try { return wornOf(mp.get(a, 'equipment')).some((w) => isShield(w.baseId)); } catch (e) { return false; } };

  // One stagger per target every staggerCooldownSeconds, and one caused by each attacker every
  // attackerStaggerCooldownSeconds: the power and bash flags come from the attacker's client, so a modified client
  // could otherwise stagger-lock a player (claude-jake's review SCH-2, 2026-09-26)
  const stagger = (tgt, agg) => {
    const s = st(tgt), now = Date.now();
    if (now - s.staggerAt < C.staggerCooldownSeconds * 1000) return false;
    const by = agg ? st(agg) : null;
    if (by && now - (by.causedStaggerAt || 0) < C.attackerStaggerCooldownSeconds * 1000) return false;
    s.staggerAt = now;
    if (by) by.causedStaggerAt = now;
    try {
      mp.callPapyrusFunction('global', 'Debug', 'SendAnimationEvent', null, [{ type: 'form', desc: mp.getDescFromId(tgt) }, C.staggerEvent]);
    } catch (e) { log('combat: stagger failed', e.message); return false; }
    return true;
  };

  // Takes points off one vital, given its maximum; returns the new fraction, or null when it cannot
  const drain = (a, key, points, max) => {
    if (!(points > 0) || !(max > 0)) return null;
    try {
      const p = mp.get(a, 'percentages');
      if (!p || typeof p[key] !== 'number') return null;
      const next = Object.assign({ health: p.health, magicka: p.magicka, stamina: p.stamina }, { [key]: Math.max(key === 'health' ? 0.01 : 0, p[key] - points / max) });
      mp.set(a, 'percentages', next);
      return next[key];
    } catch (e) { return null; }
  };

  // Called from the hit hook after the other checks passed. `mult` is what the hook already applies to an unblocked blow
  // (skills, materials, PvP). Returns the extra factor for the unblocked blow (a bash's quarter), or 1.
  const onAttempt = (agg, tgt, src, dmg, flags, mult) => {
    // Player against player only: NPC power attacks staggered players over and over in PvE (Da'Di, 2026-09-26)
    if (!C.enabled || !flags || typeof flags !== 'object' || flags.spell || agg === tgt || !isPlayer(tgt) || (C.playersOnly && !isPlayer(agg))) return 1;
    const now = Date.now();
    const events = [];
    let out = 1;

    if (flags.blocked) {
      const raw = Math.max(0, Number(flags.unblockedDamage) || 0) * (flags.bash ? C.bashDamageMult : 1) * (Number(mult) || 1);
      if (!(raw > 0)) return 1;
      const shield = hasShield(tgt);
      const broken = st(tgt).guardBrokenUntil > now;
      const share = broken ? 1 : Math.max(0, (shield ? C.shieldChip : C.weaponChip) - C.chipPerDefenseTier * Math.max(0, rankIn(tgt, 'defense')));
      const through = raw * share;
      if (through > 0 && drain(tgt, 'health', through, Number(flags.targetMaxHealth)) !== null) events.push(`chip ${through.toFixed(1)}${broken ? ' (guard broken)' : ''}`);
      let breakGuard = !broken && !!flags.bash;
      if (!broken) {
        const cost = (raw - through) * (shield ? C.shieldStaminaMult : C.blockStaminaMult) * (flags.power && shield ? C.powerIntoShieldStaminaMult : 1);
        const left = drain(tgt, 'stamina', cost, Number(flags.targetMaxStamina));
        if (left !== null) { events.push(`block stamina ${cost.toFixed(1)}`); if (left <= 0) breakGuard = true; }
      }
      if (breakGuard) {
        st(tgt).guardBrokenUntil = now + C.guardBreakSeconds * 1000;
        const resisted = flags.bash && rankIn(tgt, 'defense') >= C.bashStaggerResistRank;
        events.push(`guard broken${flags.bash ? ' by a bash' : ''}`);
        if (!resisted && stagger(tgt, agg)) events.push('stagger');
      } else if (!broken && flags.power && !shield && rankIn(agg, weaponSkillOf(src)) >= C.powerStaggerThroughWeaponBlockRank) {
        if (stagger(tgt, agg)) events.push('stagger through the block');
      }
    } else if (dmg > 0) {
      if (flags.bash) {
        out = C.bashDamageMult;
        if (rankIn(tgt, 'defense') >= C.bashStaggerResistRank) events.push('bash, stagger resisted');
        else if (stagger(tgt, agg)) events.push('bash stagger');
      } else if (flags.power) {
        if (stagger(tgt, agg)) events.push('power stagger');
      }
    }
    if (C.log && events.length) log(`combat ${display(agg)} -> ${display(tgt)}: ${events.join(', ')}${flags.power ? ' [power]' : ''}${flags.bash ? ' [bash]' : ''}${flags.blocked ? ' [blocked]' : ''}`);
    return out;
  };

  // From the gamemode's onSpellHit, which fires for 0-damage hits too (a ward's block excepted)
  const staggerSpellCache = new Map();
  const onSpellHit = (agg, tgt, spellId) => {
    if (!C.enabled || agg === tgt || !isPlayer(tgt) || (C.playersOnly && !isPlayer(agg))) return;
    if (!staggerSpellCache.has(spellId)) { const r = recordOf(spellId); staggerSpellCache.set(spellId, !!r && (C.staggerSpells || []).includes(String(r.record.editorId || ''))); }
    if (!staggerSpellCache.get(spellId)) return;
    const done = stagger(tgt, agg);
    if (C.log) log(`combat ${display(agg)} -> ${display(tgt)}: ${done ? 'rune stagger' : 'rune stagger skipped (cooldown)'} (spell ${spellId.toString(16)})`);
  };

  const forget = (a) => S.delete(a);
  return { onAttempt, onSpellHit, forget, isShield };
};
