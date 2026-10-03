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
  const { mp, log, profileOf, masteryOf, wornOf, recordOf, fieldsOf, weaponSkillOf, display, cfg, sendPacket } = api;
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
    // Shouts that knock back (Nate, 2026-09-28): the push is physics on the shouter's screen only, so the server tells
    // the victim's client to push its own player (client ShoutPushService, dboPush). Word spell editor id -> force,
    // 0 = a stagger. From anyone, a draugr's shout included; one push per target every pushCooldownSeconds.
    pushSpells: { VoiceUnrelentingForce1: 0, VoiceUnrelentingForce2: 4, VoiceUnrelentingForce3: 8 },
    pushCooldownSeconds: 2,
    // After a stagger or a push, the target shrugs off either for this long: the two had their own cooldowns, so two
    // attackers alternating blows and shouts kept a player staggered about every second (combat review, 2026-09-29)
    knockImmunitySeconds: 3,
    // Disarm and Dismay on a player (Nate, 2026-09-28: "make disarm and dismay work too"). Their magic effects run on the
    // shouter's copy of the victim only, so the server does it on the victim's own client: Disarm unequips the weapons in
    // their hands (drawn again at will), once per target every disarmCooldownSeconds; Dismay terrifies them as the
    // werewolf's howl does (dboStatus terror, dismaySpeedMult) for the word's seconds. The same gate as the push.
    disarmSpells: ['VoiceDisarm1', 'VoiceDisarm2', 'VoiceDisarm3'],
    disarmCooldownSeconds: 10,
    dismaySpells: { VoiceDismayingShout1: 5, VoiceDismayingShout2: 8, VoiceDismayingShout3: 12 },
    dismaySpeedMult: -50,
    // A player's shout counts only if they were given shouts (Give all Shouts, shoutGrantProp) and the word is one of
    // the Dragonborn's shouts in admin-powers.json: the server accepts any shout word from a player (it cannot see the
    // equipped shout), so a modified client could otherwise land a dragon's breath (release review, 2026-09-28).
    // Werewolf howls (shoutExempt) are beast-form powers run by beastform.js. NPCs are not gated.
    shoutGate: true, shoutGrantProp: 'private.dboAllShouts', shoutExempt: ['cf791:Skyrim.esm', 'ce217:Skyrim.esm'],
    // A spell's damaging hits: one per caster, target and spell every spellHitMinMs. The C++ takes a spell hit with no
    // cast behind it, no magicka and no rate (combat review, 2026-09-29: five Icy Spears in a second from a modified
    // client), and the fastest fire-and-forget cast cycle is about a second. Concentration spells keep their own
    // one-a-second limit in gamemode.js; scrolls (SCRL) are not spells here.
    spellHitMinMs: 600,
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
    if (now - Math.max(s.staggerAt, s.pushedAt || 0) < Math.max(C.staggerCooldownSeconds, Number(C.knockImmunitySeconds) || 0) * 1000) return false;
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
  const pushForceCache = new Map(); // spell -> force, or -1 when it does not push
  const pushForceOf = (spellId) => {
    if (!pushForceCache.has(spellId)) {
      const r = recordOf(spellId); const f = r ? (C.pushSpells || {})[String(r.record.editorId || '')] : undefined;
      pushForceCache.set(spellId, Number.isFinite(Number(f)) ? Number(f) : -1);
    }
    return pushForceCache.get(spellId);
  };
  // Disarm (true) and Dismay (seconds, or 0 when it is not one), by the word spell's editor id
  const disarmCache = new Map(), dismayCache = new Map();
  const editorIdOf = (id) => { const r = recordOf(id); return r ? String(r.record.editorId || '') : ''; };
  const isDisarm = (spellId) => {
    if (!disarmCache.has(spellId)) disarmCache.set(spellId, (C.disarmSpells || []).includes(editorIdOf(spellId)));
    return disarmCache.get(spellId);
  };
  const dismaySecondsOf = (spellId) => {
    if (!dismayCache.has(spellId)) { const n = Number((C.dismaySpells || {})[editorIdOf(spellId)]); dismayCache.set(spellId, n > 0 ? n : 0); }
    return dismayCache.get(spellId);
  };
  // The weapons (WEAP) in the victim's hands, unequipped on their own client; returns how many
  const disarm = (tgt) => {
    let n = 0;
    let worn = []; try { worn = wornOf(mp.get(tgt, 'equipment')); } catch (e) { return 0; }
    for (const w of worn) {
      const r = recordOf(w.baseId);
      if (!r || String(r.record.type) !== 'WEAP') continue;
      try {
        mp.callPapyrusFunction('method', 'Actor', 'UnequipItem', { type: 'form', desc: mp.getDescFromId(tgt) }, [{ type: 'espm', desc: mp.getDescFromId(w.baseId) }, false, true]);
        n++;
      } catch (e) { log('combat: disarm failed', e.message); }
    }
    return n;
  };
  // Disarms a player on their own client, once per target every disarmCooldownSeconds whatever did it (the Disarm shout,
  // an unarmed power attack in martial.js), and tells them why. Returns the weapons unequipped, or -1 inside the cooldown.
  const disarmPlayer = (tgt, text) => {
    const s = st(tgt), now = Date.now();
    if (now - (s.disarmedAt || 0) < C.disarmCooldownSeconds * 1000) return -1;
    s.disarmedAt = now;
    const n = disarm(tgt);
    if (n && text && typeof sendPacket === 'function') { try { sendPacket(tgt, { customPacketType: 'dboStatus', kind: 'notice', seconds: 1, speedMult: 0, text }); } catch (e) { /* offline */ } }
    return n;
  };
  // ---- the shout gate ------------------------------------------------------------------------------------
  const fs = require('fs'); const path = require('path');
  const idOfDesc = (d) => { try { return mp.getIdFromDesc(String(d)) >>> 0; } catch (e) { return 0; } };
  const u32 = (f, off) => (f && f.data.byteLength >= off + 4 ? new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength).getUint32(off, true) : 0);
  // SPEL SPIT: the spell type is the u32 at 8, 11 = a voice power (a shout's word, a howl); checked on Skyrim.esm
  const voiceCache = new Map();
  const isVoiceSpell = (spellId) => {
    if (!voiceCache.has(spellId)) { const r = recordOf(spellId); voiceCache.set(spellId, !!r && String(r.record.type) === 'SPEL' && u32(fieldsOf(r, 'SPIT')[0], 8) === 11); }
    return voiceCache.get(spellId);
  };
  // The word spells (SHOU SNAM, spell at 4) of the shouts in admin-powers.json, read once per load
  let allowedWords = null;
  const allowedShoutWords = () => {
    if (allowedWords) return allowedWords;
    allowedWords = new Set();
    let list = [];
    try { list = JSON.parse(fs.readFileSync(path.resolve('admin-powers.json'), 'utf8')).shouts || []; } catch (e) { log('combat: admin-powers.json unreadable, no shout is allowed', e.message); }
    for (const sh of list) {
      const r = recordOf(idOfDesc(sh.shout));
      if (!r || String(r.record.type) !== 'SHOU') continue;
      for (const f of fieldsOf(r, 'SNAM')) { const w = u32(f, 4); try { if (w) allowedWords.add(r.toGlobalRecordId(w) >>> 0); } catch (e) { /* unmapped */ } }
    }
    log(`combat: ${allowedWords.size} shout words allowed to players (${list.length} shouts in admin-powers.json)`);
    return allowedWords;
  };
  const exemptShouts = new Set((C.shoutExempt || []).map(idOfDesc).filter(Boolean));
  // True unless a player casts or hits with a shout word they may not use
  const shoutAllowed = (a, spellId) => {
    if (!C.shoutGate || !isPlayer(a) || !isVoiceSpell(spellId) || exemptShouts.has(spellId >>> 0)) return true;
    let granted = false; try { granted = mp.get(a, C.shoutGrantProp) === true; } catch (e) { granted = false; }
    return granted && allowedShoutWords().has(spellId >>> 0);
  };

  // A player's shout to show the players around (Nate, 2026-09-29: "the animation from the shouts happen but that's it").
  // The server stopped taking a player's shout word as a cast (review A4-1), so the cast is never relayed; the client
  // sends it here instead (dboShoutCast) and the gamemode forwards what this returns as dboShoutFx. Only a shout word
  // this player may use (the gate above; never a werewolf howl), one per shoutRelayMinMs, a single cast (no
  // keep-alive, no stop), with the caster forced to the sender and every field reduced to a checked number.
  const relayedAt = new Map();
  const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : 0; };
  const bytes = (v) => (Array.isArray(v) ? v.slice(0, 2048).map((x) => (Number(x) & 0xff) >>> 0) : []);
  const shoutRelay = (a, raw) => {
    const d = raw && typeof raw === 'object' ? raw : null;
    const spellId = d ? Number(d.spell) >>> 0 : 0;
    if (!d || !spellId || !isPlayer(a)) return { refused: 'not a player cast' };
    if (!isVoiceSpell(spellId) || exemptShouts.has(spellId)) return { refused: 'not a shout word' };
    if (C.shoutGate && !shoutAllowed(a, spellId)) return { refused: 'a shout this player may not use' };
    if (d.keepAlive || d.interruptCast) return { refused: 'not a single cast' };
    const now = Date.now();
    if (now - (relayedAt.get(a) || 0) < (Number(C.shoutRelayMinMs) || 500)) return { refused: 'too soon after the last' };
    relayedAt.set(a, now);
    if (relayedAt.size > 512) for (const [k, t] of relayedAt) if (now - t > 60000) relayedAt.delete(k);
    const vars = d.actorAnimationVariables && typeof d.actorAnimationVariables === 'object' ? d.actorAnimationVariables : {};
    return {
      data: {
        caster: a >>> 0, target: Number(d.target) >>> 0, spell: spellId, isDualCasting: false, interruptCast: false, keepAlive: false,
        castingSource: num(d.castingSource, 0, 3) | 0, aimAngle: num(d.aimAngle, -10, 10), aimHeading: num(d.aimHeading, -10, 10),
        actorAnimationVariables: { booleans: bytes(vars.booleans), floats: bytes(vars.floats), integers: bytes(vars.integers) },
      },
    };
  };

  const onSpellHit = (agg, tgt, spellId) => {
    if (!C.enabled || agg === tgt || !isPlayer(tgt)) return;
    const force = pushForceOf(spellId);
    const disarms = isDisarm(spellId), dismay = dismaySecondsOf(spellId);
    if ((force >= 0 || disarms || dismay) && !shoutAllowed(agg, spellId)) return;
    if (disarms) {
      const n = disarmPlayer(tgt, 'A shout tears the weapon from your grip.');
      if (C.log && n >= 0) log(`combat ${display(agg)} -> ${display(tgt)}: shout disarm, ${n} weapon(s) (spell ${spellId.toString(16)})`);
      return;
    }
    if (dismay) {
      if (typeof sendPacket !== 'function') return;
      const speedMult = Math.max(-90, Math.min(0, Number(C.dismaySpeedMult) || 0));
      try { sendPacket(tgt, { customPacketType: 'dboStatus', kind: 'terror', seconds: dismay, speedMult, text: `A shout breaks your nerve. You are terrified for ${dismay} seconds.` }); } catch (e) { /* offline */ }
      if (C.log) log(`combat ${display(agg)} -> ${display(tgt)}: shout dismay ${dismay} s (spell ${spellId.toString(16)})`);
      return;
    }
    if (force >= 0 && typeof sendPacket === 'function') {
      const s = st(tgt), now = Date.now();
      if (now - Math.max(s.pushedAt || 0, s.staggerAt) < Math.max(C.pushCooldownSeconds, Number(C.knockImmunitySeconds) || 0) * 1000) return;
      s.pushedAt = now;
      try { sendPacket(tgt, { customPacketType: 'dboPush', from: agg >>> 0, force }); } catch (e) { /* offline */ }
      if (C.log) log(`combat ${display(agg)} -> ${display(tgt)}: shout ${force ? `push ${force}` : 'stagger'} (spell ${spellId.toString(16)})`);
      return;
    }
    if (C.playersOnly && !isPlayer(agg)) return;
    if (!staggerSpellCache.has(spellId)) { const r = recordOf(spellId); staggerSpellCache.set(spellId, !!r && (C.staggerSpells || []).includes(String(r.record.editorId || ''))); }
    if (!staggerSpellCache.get(spellId)) return;
    const done = stagger(tgt, agg);
    if (C.log) log(`combat ${display(agg)} -> ${display(tgt)}: ${done ? 'rune stagger' : 'rune stagger skipped (cooldown)'} (spell ${spellId.toString(16)})`);
  };

  // gamemode.js hitDamageAttemptHook asks before a damaging hit counts: false = refuse it
  const spellCache = new Map();
  const isSpell = (id) => {
    // A staff's hit names its enchantment (ENCH) and is paced like a spell
    if (!spellCache.has(id)) { const r = recordOf(id); spellCache.set(id, !!r && (String(r.record.type) === 'SPEL' || String(r.record.type) === 'ENCH')); }
    return spellCache.get(id);
  };
  const spellHitAt = globalThis.__dboSpellHitAt instanceof Map ? globalThis.__dboSpellHitAt : (globalThis.__dboSpellHitAt = new Map());
  const spellHitAllowed = (agg, tgt, spellId, now = Date.now()) => {
    if (!(Number(C.spellHitMinMs) > 0) || agg === tgt || !isSpell(spellId)) return true;
    const key = `${agg}:${tgt}:${spellId}`;
    if (now - (spellHitAt.get(key) || 0) < Number(C.spellHitMinMs)) return false;
    spellHitAt.set(key, now);
    if (spellHitAt.size > 1024) for (const [k, t] of spellHitAt) if (now - t > 10000) spellHitAt.delete(k);
    return true;
  };

  const forget = (a) => S.delete(a);
  return { onAttempt, onSpellHit, forget, isShield, shoutAllowed, disarmPlayer, shoutRelay, spellHitAllowed };
};
