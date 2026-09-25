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
    // Death's Chill after waking at the temple: caps and the share of recovery that is kept, 1 = unchanged
    chill: true, chillMinutes: 20, chillCureTier: 2,
    // The ability shown under Magic > Active Effects while the chill lasts ('<local id>:<plugin>'); empty until the
    // record exists in a DragonBreak plugin (Nate, 2026-09-25: players could not tell why stamina crawled back)
    chillMarkerSpell: '',
    chillStaminaCap: 0.7, chillStaminaRegen: 0.4, chillMagickaCap: 0.2, chillMagickaRegen: 0.7, chillHealthRegen: 0.5,
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
        // The gamemode's hit bonuses are noted by the inner handler; a stale one would land on the respawned body
        globalThis.__dboMasteryPending = null;
        globalThis.__dboSuperPending = null;
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

  // ---- Death's Chill ---------------------------------------------------------------------------------------
  // Waking at the temple instead of being raised in the field leaves the chill of the grave (suggestions forum,
  // "non-PK Death Debuff"): stamina and magicka stay low and come back slowly, and every heal, potions included, is
  // weaker, for chillMinutes of time online. A Priest's healing lifts it. The server owns these values, so the caps
  // and the slower recovery are enforced by taking back part of whatever came back since the last look.
  const CHILL = 'private.dboDeathChill';
  const chilled = S.chilled = S.chilled || new Map(); // actor -> { leftMs, at, p, savedAt }
  const chillLeft = (a) => {
    if (chilled.has(a)) return chilled.get(a).leftMs;
    try { const c = mp.get(a, CHILL); return c && c.leftMs > 0 ? c.leftMs : 0; } catch (e) { return 0; }
  };
  // The Active Effects entry: added when the chill starts or a chilled player comes back online, taken when it lifts
  const markChill = (a, on) => {
    if (!C.chillMarkerSpell) return;
    try {
      const spell = mp.getDescFromId(mp.getIdFromDesc(String(C.chillMarkerSpell)) >>> 0);
      mp.callPapyrusFunction('method', 'Actor', on ? 'AddSpell' : 'RemoveSpell', { type: 'form', desc: mp.getDescFromId(a >>> 0) },
        on ? [{ type: 'espm', desc: spell }, false] : [{ type: 'espm', desc: spell }]);
    } catch (e) { log(`downed: chill marker ${on ? 'add' : 'remove'} failed: ${e.message}`); }
  };
  const saveChill = (a, leftMs) => { try { mp.set(a, CHILL, { leftMs: Math.max(0, Math.round(leftMs)) }); } catch (e) { /* not an actor */ } };
  const chill = (a) => {
    if (!C.chill || !isPlayer(a) || mp.get(a, 'private.permaDead') === true) return;
    const leftMs = C.chillMinutes * 60000;
    chilled.set(a, { leftMs, at: Date.now(), p: null, savedAt: Date.now() });
    saveChill(a, leftMs);
    markChill(a, true);
    banner(a, `You wake at the temple with the chill of the grave in your bones. Your breath and your magic come back slowly and wounds knit poorly. A Priest's healing can lift it; otherwise it passes in ${C.chillMinutes} minutes.`, 10);
    audit(`CHILL ${who(a)} woke at the temple with Death's Chill (${C.chillMinutes} min)`);
  };
  const liftChill = (a, by) => {
    chilled.delete(a);
    saveChill(a, 0);
    markChill(a, false);
    if (by) {
      banner(a, `${nameOf(by)}'s healing drives the chill of the grave from you.`, 5);
      banner(by, `You lift the chill of the grave from ${nameOf(a)}.`, 3);
      audit(`CHILL ${who(a)} lifted by ${who(by)}`);
    } else {
      banner(a, 'The chill of the grave leaves you.', 5);
    }
  };
  const canLift = (caster, t) => {
    if (caster === t || !isPlayer(t) || isDead(t) || !chillLeft(t)) return false;
    if (priestTier(caster) >= C.chillCureTier) return true;
    banner(caster, `Lifting the chill of the grave takes a Priest of tier ${C.chillCureTier}.`);
    return false;
  };
  const slower = (was, now, keep, cap) => Math.min(cap, now > was ? was + (now - was) * keep : now);
  every('deathChill', 1000, () => {
    const now = Date.now();
    for (const a of onlineActors()) {
      if (!chilled.has(a)) {
        const leftMs = chillLeft(a);
        if (!leftMs) continue;
        chilled.set(a, { leftMs, at: now, p: null, savedAt: now });
        markChill(a, true);
      }
      const c = chilled.get(a);
      const p = health(a);
      if (!p || isDead(a)) { c.at = now; c.p = null; continue; }
      let next = p;
      if (c.p) {
        next = {
          health: slower(c.p.health, p.health, C.chillHealthRegen, 1),
          stamina: slower(c.p.stamina, p.stamina, C.chillStaminaRegen, C.chillStaminaCap),
          magicka: slower(c.p.magicka, p.magicka, C.chillMagickaRegen, C.chillMagickaCap),
        };
        if (Math.abs(next.health - p.health) + Math.abs(next.stamina - p.stamina) + Math.abs(next.magicka - p.magicka) > 0.002) {
          try { mp.set(a, 'percentages', next); } catch (e) { /* not an actor */ }
        }
        // Online time only, and a long gap (a stall, a reload) never burns more than a few seconds
        c.leftMs -= Math.min(now - c.at, 5000);
      } else {
        next = { health: p.health, stamina: Math.min(p.stamina, C.chillStaminaCap), magicka: Math.min(p.magicka, C.chillMagickaCap) };
        if (next.stamina !== p.stamina || next.magicka !== p.magicka) { try { mp.set(a, 'percentages', next); } catch (e) { /* not an actor */ } }
      }
      c.at = now;
      c.p = next;
      if (c.leftMs <= 0) liftChill(a, 0);
      else if (now - c.savedAt > 15000) { c.savedAt = now; saveChill(a, c.leftMs); }
    }
    for (const a of [...chilled.keys()]) if (!onlineActors().includes(a)) { saveChill(a, chilled.get(a).leftMs); chilled.delete(a); }
  });
  registerChatCommand('chill', (a) => {
    const left = chillLeft(a);
    personal(a, left ? `The chill of the grave is on you for ${Math.ceil(left / 60000)} more minute(s) of play. A Priest of tier ${C.chillCureTier} or higher can lift it with a healing spell.` : 'You are free of the chill of the grave.');
  }, { help: "how long Death's Chill lasts" });
  globalThis.__dboDeathChillLeft = (a) => chillLeft(Number(a) >>> 0);

  // ---- the down state ------------------------------------------------------------------------------------
  // The engine starts its respawn timer at death with the actor's spawnDelay, so it must be set before anyone falls
  every('downedDelay', 10000, () => {
    for (const a of onlineActors()) {
      try { if (Number(mp.get(a, 'spawnDelay')) !== C.bleedoutSeconds) mp.set(a, 'spawnDelay', C.bleedoutSeconds); } catch (e) { /* not an actor */ }
    }
    const now = Date.now();
    for (const [a, d] of S.downed) {
      if (!isDead(a)) { S.downed.delete(a); chill(a); }
      else if (now - d.at > (C.bleedoutSeconds + 30) * 1000) S.downed.delete(a);
    }
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
            banner(a, `You are down. A Priest's healing or a Draught of Revival can bring you back. You wake at the temple in ${C.bleedoutSeconds} seconds, or say /respawn to go now.`, 8);
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
    chill(t);
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
  const chilledNear = (caster, range) => {
    let cp = null, here = null;
    try { cp = mp.get(caster, 'pos'); here = mp.get(caster, 'worldOrCellDesc'); } catch (e) { return []; }
    return onlineActors().filter((t) => {
      if (t === caster || !chillLeft(t)) return false;
      try { const p = mp.get(t, 'pos'); return mp.get(t, 'worldOrCellDesc') === here && Math.hypot(p[0] - cp[0], p[1] - cp[1], p[2] - cp[2]) <= range; } catch (e) { return false; }
    });
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
          } else if (AIMED.has(spell) && canLift(caster, t)) {
            liftChill(t, caster);
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
          if (AREA.has(spell)) {
            for (const t of chilledNear(caster, C.groupReviveRange)) if (canLift(caster, t)) liftChill(t, caster);
          }
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

  // ---- the Draught of Revival --------------------------------------------------------------------------------
  // Learned from its recipe book, brewed at any alchemy lab from one config recipe by an Alchemist of P.tier (see alchemy.js)
  const P = Object.assign({
    tier: 4,
    recipes: [[{ id: '3ad72:Skyrim.esm', name: 'troll fat' }, { id: '4da00:Skyrim.esm', name: 'fly amanita' }, { id: '6018c7:BSAssets.esm', name: 'yellow cinnabar polypore' }]],
  }, C.potion || {});
  const POTION = idOf('12ae16:DragonBreak Online Edits.esp'), RECIPE = idOf('12ae17:DragonBreak Online Edits.esp');
  const LABS = new Set([idOf('bad0c:Skyrim.esm'), idOf('d54ff:Skyrim.esm'), idOf('bf4fa:Journey to Baan Malur.esp')].filter(Boolean));
  // A lab takes two or three distinct ingredients, so a recipe outside that or with an unresolved id can never match
  const RECIPES = (Array.isArray(P.recipes) ? P.recipes : []).map((r) => {
    const items = Array.isArray(r) ? r : [];
    const ids = items.map((i) => (i && i.id ? idOf(String(i.id)) : 0));
    const set = new Set(ids);
    return ids.length >= 2 && ids.length <= 3 && set.size === ids.length && !set.has(0) ? { ids: set, names: items.map((i) => String(i.name || i.id)) } : null;
  }).filter(Boolean);
  const listOf = (names) => names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  const recipeFor = (used) => RECIPES.find((r) => r.ids.size === used.length && used.every((id) => r.ids.has(id)));
  const invOf = (a) => { try { const inv = mp.get(a, 'inventory'); return inv && Array.isArray(inv.entries) ? inv.entries : []; } catch (e) { return []; } };
  const countOf = (a, id) => invOf(a).filter((e) => (Number(e.baseId) >>> 0) === id).reduce((n, e) => n + (Number(e.count) || 0), 0);
  const addItem = (a, id, n) => {
    const entries = invOf(a).map((e) => Object.assign({}, e));
    const hit = entries.find((e) => (Number(e.baseId) >>> 0) === id && !e.worn);
    if (hit) hit.count = (Number(hit.count) || 0) + n; else entries.push({ baseId: id, count: n });
    mp.set(a, 'inventory', { entries: entries.filter((e) => Number(e.count) > 0) });
  };
  const alchemistTier = (a) => {
    try {
      const r = mp.get(a, 'private.mastery');
      if (!r || !Array.isArray(r.order) || !r.order.includes('alchemist')) return 0;
      const p = r.skills && r.skills.alchemist;
      return (p ? Math.max(0, Number(p.rank) || 0) : 0) + 1;
    } catch (e) { return 0; }
  };
  const knows = (a) => { try { const r = mp.get(a, 'private.dboRecipes'); return !!(r && r.revive); } catch (e) { return false; } };
  delete S.lastLab;

  if (LABS.size && POTION && RECIPES.length) {
    const inner = mp.onActivate;
    if (typeof inner === 'function') {
      mp.onActivate = function (targetId, casterId, ...rest) {
        try {
          const t = Number(targetId) >>> 0, a = Number(casterId) >>> 0;
          if (isPlayer(a) && knows(a) && LABS.has(mp.getIdFromDesc(String(mp.get(t, 'baseDesc'))) >>> 0)) {
            personal(a, `You know the Draught of Revival: mix ${listOf(RECIPES[0].names)} here.${alchemistTier(a) >= P.tier ? '' : ` Brewing it takes an Alchemist of tier ${P.tier}.`}`);
          }
        } catch (e) { /* not a lab */ }
        return inner.call(this, targetId, casterId, ...rest);
      };
    }
  }
  // The gamemode never sets onReadBook, so a reload would wrap this wrapper again: the original is kept once
  if (!('__dboPrevReadBook' in globalThis)) globalThis.__dboPrevReadBook = typeof mp.onReadBook === 'function' && !mp.onReadBook.__dboDowned ? mp.onReadBook : null;
  if (RECIPE) {
    const inner = globalThis.__dboPrevReadBook;
    const readHook = function (actorId, baseId, ...rest) {
      const a = Number(actorId) >>> 0;
      try {
        if ((Number(baseId) >>> 0) === RECIPE && isPlayer(a)) {
          // The book's own text is out of date, so every read shows the recipe; learning is recorded once
          const first = !knows(a);
          if (first) {
            mp.set(a, 'private.dboRecipes', Object.assign({}, mp.get(a, 'private.dboRecipes') || {}, { revive: true }));
            audit(`RECIPE ${who(a)} learned the Draught of Revival`);
          }
          const mix = RECIPES.length ? `: mix ${listOf(RECIPES[0].names)} at an alchemy lab.` : '.';
          banner(a, `You ${first ? 'learned' : 'know'} the Draught of Revival${mix}${alchemistTier(a) >= P.tier ? '' : ` Brewing it takes an Alchemist of tier ${P.tier}.`}`, 6);
        }
      } catch (e) { log(`downed: recipe read failed: ${e.message}`); }
      return inner ? inner.call(this, actorId, baseId, ...rest) : undefined;
    };
    readHook.__dboDowned = true;
    mp.onReadBook = readHook;
  }
  if (POTION) {
    const inner = mp.onEatItem;
    if (typeof inner === 'function') {
      mp.onEatItem = function (actorId, baseId, ...rest) {
        const out = inner.call(this, actorId, baseId, ...rest);
        const a = Number(actorId) >>> 0;
        try {
          if ((Number(baseId) >>> 0) === POTION && out !== false) {
            const t = downedNear(a, 1000, 35)[0];
            if (!t || !revive(t, a, 'a Draught of Revival')) {
              addItem(a, POTION, 1);
              if (!t) banner(a, 'No fallen ally lies before you. You keep the draught.');
            }
          }
        } catch (e) { log(`downed: revive potion failed: ${e.message}`); }
        return out;
      };
    }
  }

  // Nat: the Draught is used on the fallen, not drunk. E on a downed player while carrying one pours it into them.
  // The gamemode re-installs its activate hook on every reload before this module loads, so this never stacks.
  if (POTION) {
    const innerActivate = mp.onActivate;
    if (typeof innerActivate === 'function') {
      mp.onActivate = function (targetId, casterId, ...rest) {
        const t = Number(targetId) >>> 0, a = Number(casterId) >>> 0;
        try {
          if (t !== a && S.downed.has(t) && isDead(t) && countOf(a, POTION) > 0) {
            if (revive(t, a, 'a Draught of Revival')) { addItem(a, POTION, -1); return false; }
          }
        } catch (e) { log(`downed: revive by hand failed: ${e.message}`); }
        return innerActivate.call(this, targetId, casterId, ...rest);
      };
    }
  }

  // The revive potion (alchemy) calls this when it is used on a fallen player
  globalThis.__dboReviveWith = (target, by, how) => revive(Number(target) >>> 0, Number(by) >>> 0, how);
  globalThis.__dboIsDowned = (a) => S.downed.has(Number(a) >>> 0) && isDead(Number(a) >>> 0);
  // alchemy.js asks this before an ordinary brew: the Draught for a known recipe at tier, a hint below it, else null
  globalThis.__dboLabDraught = (a, used) => {
    if (!POTION) return null;
    const r = recipeFor(used); if (!r || !knows(a)) return null;
    if (alchemistTier(a) < P.tier) return { hint: `You know the Draught of Revival, but brewing it takes an Alchemist of tier ${P.tier}. This mix made an ordinary potion.` };
    return { potion: POTION, name: 'Draught of Revival', brewed: () => {
      banner(a, 'You brewed a Draught of Revival. It reaches your pack as you leave the lab. Press E on a fallen ally while carrying it to raise them.', 6);
      audit(`BREW ${who(a)} brewed a Draught of Revival at a lab`);
    } };
  };

  log(`downed on: friendly damage ${Math.round(C.friendlyDamage * 100)}%, bleed-out ${C.bleedoutSeconds} s, revive at ${Math.round(C.reviveHealth * 100)}%, Priest tier ${C.priestTier}, ${AIMED.size} aimed + ${AREA.size} area revive spells; Draught of Revival ${POTION && RECIPE ? `on (Alchemist tier ${P.tier}, ${LABS.size} lab bases, ${RECIPES.length} recipes)` : 'off: its records are not in the load order'}`);
};
