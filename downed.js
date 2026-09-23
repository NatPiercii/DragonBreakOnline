// DragonBreak Online: friendly fire and the down state. Loaded by gamemode.js on every hot reload.
//
// Friendly fire (Nat, 2026-09-23): a hit between members of one party, their summons and companions included, deals
// 20% of its damage. The engine applies the full hit before onHitDamage runs, so 80% of the drop is handed back there;
// a hit that would kill at full strength is refused instead and the 20% applied here, using the target's maximum
// health learned from earlier hits (damage / drop), since base actor values have no binding server-side.
//
// Down state: a fallen player lies bleeding out for 60 s (the engine's spawnDelay) before waking at the temple.
// Only a revive raises them: a Restoration heal-other spell cast by a Priest of tier 4 or higher, or a revive potion.
// The reviver must not be fighting the fallen player. A hostile player may finish them, NPCs leave them alone.
// /respawn gives up and wakes at the temple at once.
'use strict';

module.exports = (api) => {
  const { mp, log, personal, sendPacket, audit, who, display, profileOf, nameOf, onlineActors, every, registerChatCommand, cfg } = api;

  const C = Object.assign({
    friendlyDamage: 0.2,
    bleedoutSeconds: 60,
    reviveHealth: 0.25,
    priestTier: 4,
    hostileMs: 60000,
    reviveRange: 1500, reviveConeDeg: 25, reviveFallbackMs: 1200, groupReviveRange: 400,
  }, cfg.downed || {});

  const idOf = (desc) => { try { return mp.getIdFromDesc(desc) >>> 0; } catch (e) { log(`downed: ${desc} not in the load order`); return 0; } };
  // Restoration spells that heal another: aimed ones revive what they hit, Grand Healing everyone close by
  const AIMED = new Set([idOf('12fd2:Skyrim.esm'), idOf('4d3f2:Skyrim.esm')].filter(Boolean));   // HealOther, HealingHands
  const AREA = new Set([idOf('b62ee:Skyrim.esm'), idOf('101064:Skyrim.esm')].filter(Boolean));   // GrandHealing, left hand

  const isPlayer = (a) => { try { return Number(mp.get(a, 'profileId')) >= 0; } catch (e) { return false; } };
  const isDead = (a) => { try { return mp.get(a, 'isDead') === true; } catch (e) { return false; } };
  const health = (a) => { try { const p = mp.get(a, 'percentages'); return p && typeof p.health === 'number' ? p : null; } catch (e) { return null; } };
  const setHealth = (a, h) => { const p = health(a); if (p) mp.set(a, 'percentages', { health: Math.max(0, Math.min(1, h)), magicka: p.magicka, stamina: p.stamina }); };
  const banner = (a, text, seconds) => {
    sendPacket(a, { customPacketType: 'dboBanner', text, seconds: seconds || 4 });
    sendPacket(a, { customPacketType: 'dboStatus', kind: 'notice', seconds: 1, speedMult: 0, text });
    personal(a, text);
  };
  const priestTier = (a) => {
    try {
      const r = mp.get(a, 'private.mastery');
      if (!r || !Array.isArray(r.order) || !r.order.includes('priest')) return 0;
      const p = r.skills && r.skills.priest;
      return (p ? Math.max(0, Number(p.rank) || 0) : 0) + 1;
    } catch (e) { return 0; }
  };

  // ---- friendly fire -----------------------------------------------------------------------------------
  // A companion fights for its owner; everyone else for themselves
  const sideOf = (a) => { try { const o = Number(mp.get(a, 'ff_companionOf')) >>> 0; return o || a; } catch (e) { return a; } };
  const partyOf = (a) => { try { return typeof globalThis.__dboPartyLeaderOf === 'function' ? globalThis.__dboPartyLeaderOf(a) : null; } catch (e) { return null; } };
  const friendly = (agg, tgt) => {
    if (agg === tgt) return false;
    const sa = sideOf(agg), st = sideOf(tgt);
    if (!isPlayer(sa) || !isPlayer(st)) return false;
    if (sa === st) return true;
    const pa = partyOf(sa);
    return pa !== null && pa !== undefined && pa === partyOf(st);
  };

  const S = globalThis.__dboDownedState = globalThis.__dboDownedState || { maxHp: new Map(), downed: new Map(), fought: new Map(), pending: null };
  const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const hostile = (a, b) => Date.now() - (S.fought.get(pairKey(a, b)) || 0) < C.hostileMs;

  {
    const inner = mp.onHitDamageAttempt;
    if (typeof inner === 'function') {
      const downedAttempt = function (aggressorId, targetId, sourceId, damage, ...rest) {
        const agg = Number(aggressorId) >>> 0, tgt = Number(targetId) >>> 0, dmg = Number(damage) || 0;
        S.pending = null;
        // A hostile player finishes a fallen one: the temple, now
        if (dmg > 0 && S.downed.has(tgt) && isDead(tgt) && isPlayer(agg) && !friendly(agg, tgt)) {
          finish(tgt, agg);
          return false;
        }
        if (inner.call(this, aggressorId, targetId, sourceId, damage, ...rest) === false) return false;
        if (dmg <= 0 || agg === tgt) return true;
        const p = health(tgt);
        if (!p || p.health <= 0) return true;
        const isFriendly = friendly(agg, tgt);
        if (!isFriendly && isPlayer(sideOf(agg)) && isPlayer(tgt)) S.fought.set(pairKey(sideOf(agg), tgt), Date.now());
        if (isFriendly) {
          const max = S.maxHp.get(tgt);
          if (max > 0 && p.health - dmg / max <= 0.001) {
            // Lethal at full strength: refuse it and take off the friendly share here, unless even that kills
            const reduced = p.health - C.friendlyDamage * dmg / max;
            if (reduced > 0.001) {
              setHealth(tgt, reduced);
              log(`downed: friendly hit ${display(agg)} -> ${display(tgt)} ${dmg.toFixed(1)} of ${Math.round(max)} max, applied ${Math.round(C.friendlyDamage * 100)}% (refused the lethal full hit)`);
              return false;
            }
          }
        }
        S.pending = { agg, tgt, dmg, before: p.health, friendly: isFriendly };
        return true;
      };
      downedAttempt.__dboDowned = true;
      mp.onHitDamageAttempt = downedAttempt;
    }
  }
  {
    const inner = mp.onHitDamage;
    if (typeof inner === 'function') {
      mp.onHitDamage = function (aggressorId, targetId, sourceId, damage, ...rest) {
        const agg = Number(aggressorId) >>> 0, tgt = Number(targetId) >>> 0;
        const pend = S.pending && S.pending.agg === agg && S.pending.tgt === tgt ? S.pending : null;
        S.pending = null;
        if (pend) {
          // The engine's own drop, before the gamemode adds mastery or supernatural damage, teaches the target's maximum health
          const p = health(tgt);
          const drop = p ? pend.before - p.health : 0;
          if (p && p.health > 0 && drop > 0.0005) S.maxHp.set(tgt, pend.dmg / drop);
        }
        const out = inner.call(this, aggressorId, targetId, sourceId, damage, ...rest);
        if (pend && pend.friendly && !isDead(tgt)) {
          const p = health(tgt);
          if (p) {
            const lost = pend.before - p.health;
            if (lost > 0) setHealth(tgt, p.health + lost * (1 - C.friendlyDamage));
          }
        }
        return out;
      };
    }
  }

  // ---- the down state ------------------------------------------------------------------------------------
  // The engine starts its respawn timer at death with the actor's spawnDelay, so it must be set before anyone falls
  every('downedDelay', 10000, () => {
    for (const a of onlineActors()) {
      try { if (Number(mp.get(a, 'spawnDelay')) !== C.bleedoutSeconds) mp.set(a, 'spawnDelay', C.bleedoutSeconds); } catch (e) { /* not an actor */ }
    }
    const now = Date.now();
    for (const [a, d] of S.downed) if (!isDead(a) || now - d.at > (C.bleedoutSeconds + 30) * 1000) S.downed.delete(a);
    for (const [k, t] of S.fought) if (now - t > C.hostileMs) S.fought.delete(k);
    if (S.maxHp.size > 4096) S.maxHp.clear();
  });

  {
    const inner = mp.onDeath;
    if (typeof inner === 'function') {
      mp.onDeath = function (actorId, killerId, ...rest) {
        const out = inner.call(this, actorId, killerId, ...rest);
        const a = Number(actorId) >>> 0;
        try {
          if (isPlayer(a) && mp.get(a, 'private.permaDead') !== true) {
            S.downed.set(a, { at: Date.now(), by: Number(killerId) >>> 0 });
            banner(a, `You are down. A Priest's healing or a revive potion can raise you. You wake at the temple in ${C.bleedoutSeconds} seconds, or say /respawn to go now.`, 8);
            log(`downed: ${display(a)} is down${killerId ? ` (by ${display(Number(killerId) >>> 0)})` : ''}`);
          }
        } catch (e) { log(`downed: death handling failed: ${e.message}`); }
        return out;
      };
    }
  }

  const revive = (t, by, how) => {
    const d = S.downed.get(t);
    if (!d || !isDead(t) || mp.get(t, 'private.permaDead') === true) return false;
    if (by && hostile(sideOf(by), t)) { banner(by, `${nameOf(t)} fought you moments ago and will not take your help.`); return false; }
    S.downed.delete(t);
    mp.set(t, 'isDead', false);
    setHealth(t, C.reviveHealth);
    banner(t, `${by ? nameOf(by) : 'Someone'} raised you with ${how}.`, 5);
    if (by) banner(by, `You raised ${nameOf(t)}.`, 3);
    audit(`REVIVE ${who(t)} by ${by ? who(by) : 'nobody'} (${how})`);
    return true;
  };
  // Wakes at the spawn point (the temple of the area, set on death) the way the engine's own respawn does
  const toTemple = (t) => {
    S.downed.delete(t);
    try { const sp = mp.get(t, 'spawnPoint'); if (sp && sp.cellOrWorldDesc) mp.set(t, 'locationalData', sp); } catch (e) { log(`downed: temple move failed for ${display(t)}: ${e.message}`); }
    mp.set(t, 'isDead', false);
  };
  const finish = (t, by) => {
    audit(`FINISHED ${who(t)} by ${who(by)}`);
    banner(t, `${nameOf(by)} finished you. You wake at the temple.`, 5);
    toTemple(t);
  };
  registerChatCommand('respawn', (a) => {
    if (!S.downed.has(a) || !isDead(a)) return personal(a, 'You are not down.');
    log(`downed: ${display(a)} gave up`);
    toTemple(a);
  }, { help: 'while down: stop waiting for help and wake at the temple' });

  // ---- revive by spell -------------------------------------------------------------------------------------
  const canRaise = (caster) => {
    if (priestTier(caster) >= C.priestTier) return true;
    banner(caster, `Raising the fallen takes a Priest of tier ${C.priestTier}.`);
    return false;
  };
  const downedNear = (caster, range, coneDeg) => {
    let cp = null, ang = 0, here = null;
    try { cp = mp.get(caster, 'pos'); ang = Number(mp.get(caster, 'angle')[2]) || 0; here = mp.get(caster, 'worldOrCellDesc'); } catch (e) { return []; }
    const out = [];
    for (const [t] of S.downed) {
      try {
        if (!isDead(t) || mp.get(t, 'worldOrCellDesc') !== here) continue;
        const p = mp.get(t, 'pos'); const dx = p[0] - cp[0], dy = p[1] - cp[1]; const dist = Math.hypot(dx, dy, p[2] - cp[2]);
        if (dist > range) continue;
        if (coneDeg) { const bearing = Math.atan2(dx, dy) * 180 / Math.PI; const off = Math.abs(((bearing - ang + 540) % 360) - 180); if (off > coneDeg) continue; }
        out.push([t, dist]);
      } catch (e) { /* gone */ }
    }
    return out.sort((x, y) => x[1] - y[1]).map((x) => x[0]);
  };
  const pendingCast = S.pendingCast = S.pendingCast || new Map();
  {
    const inner = mp.onSpellHit;
    if (typeof inner === 'function') {
      mp.onSpellHit = function (aggressorId, targetId, spellId, ...rest) {
        const caster = Number(aggressorId) >>> 0, t = Number(targetId) >>> 0, spell = Number(spellId) >>> 0;
        try {
          if (AIMED.has(spell) && S.downed.has(t) && isDead(t)) {
            const pc = pendingCast.get(caster); if (pc) { clearTimeout(pc); pendingCast.delete(caster); }
            if (canRaise(caster)) revive(t, caster, 'healing');
          }
        } catch (e) { log(`downed: spell revive failed: ${e.message}`); }
        return inner.call(this, aggressorId, targetId, spellId, ...rest);
      };
    }
  }
  {
    const inner = mp.onSpellCast;
    if (typeof inner === 'function') {
      mp.onSpellCast = function (casterId, spellId, ...rest) {
        const caster = Number(casterId) >>> 0, spell = Number(spellId) >>> 0;
        try {
          if (S.downed.size && AREA.has(spell)) {
            const near = downedNear(caster, C.groupReviveRange, 0);
            if (near.length && canRaise(caster)) for (const t of near) revive(t, caster, 'Grand Healing');
          } else if (S.downed.size && AIMED.has(spell)) {
            // A hit on a body does not always arrive (the same as Reanimate): the nearest fallen in front of the caster
            const old = pendingCast.get(caster); if (old) clearTimeout(old);
            pendingCast.set(caster, setTimeout(() => {
              pendingCast.delete(caster);
              const t = downedNear(caster, C.reviveRange, C.reviveConeDeg)[0];
              if (t && canRaise(caster)) { log(`downed: ${display(caster)} healing reached ${display(t)} without a hit, by aim`); revive(t, caster, 'healing'); }
            }, C.reviveFallbackMs));
          }
        } catch (e) { log(`downed: spell cast revive failed: ${e.message}`); }
        return inner.call(this, casterId, spellId, ...rest);
      };
    }
  }

  // The revive potion (alchemy) calls this when it is used on a fallen player
  globalThis.__dboReviveWith = (target, by, how) => revive(Number(target) >>> 0, Number(by) >>> 0, how);
  globalThis.__dboIsDowned = (a) => S.downed.has(Number(a) >>> 0) && isDead(Number(a) >>> 0);

  log(`downed on: friendly damage ${Math.round(C.friendlyDamage * 100)}%, bleed-out ${C.bleedoutSeconds} s, revive at ${Math.round(C.reviveHealth * 100)}%, Priest tier ${C.priestTier}, ${AIMED.size} aimed + ${AREA.size} area revive spells`);
};
