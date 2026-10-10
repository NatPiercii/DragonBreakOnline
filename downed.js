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
//
// A crash before the fall costs nothing (Jake, 2026-10-01): a down that began after the player's game crashed wakes
// where they fell, at full health, without the temple or Death's Chill (see crashBefore below).
'use strict';

const fs = require('fs');

module.exports = (api) => {
  const { mp, log, personal, sendPacket, audit, who, display, profileOf, nameOf, onlineActors, every, registerChatCommand, cfg, openWidget, closeWidget, onUi, redress } = api;
  // The name a player sees for another: their name once introduced, else Stranger, or Masked Person (playermenu.js).
  // NPCs keep their own names. A /bug of 2026-09-26: a stranger who raised a player was named on the banner.
  const nameTo = (viewer, x) => {
    try {
      if (!(profileOf(x) >= 0) || typeof globalThis.__dboNameFor !== 'function') return nameOf(x);
      return globalThis.__dboNameFor(Number(viewer) >>> 0, Number(x) >>> 0);
    } catch (e) { return nameOf(x); }
  };

  // How far the one who downed a player stood, by the server's positions: the player's own and the killer's host's
  // (Licks-His-Fur #KBX7, 10 Oct: "died from literally nothing after running away from trolls"; every one of the three
  // downs was a troll's logged blow, so this measures whether the blow came from a copy far behind on the host's screen)
  const killerGap = (a, k) => {
    try {
      if (!k || k === a) return '';
      if (mp.get(a, 'worldOrCellDesc') !== mp.get(k, 'worldOrCellDesc')) return ', in another cell';
      const p = mp.get(a, 'pos'), q = mp.get(k, 'pos');
      const m = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) / 70;
      return Number.isFinite(m) ? `, ${m.toFixed(1)} m away` : '';
    } catch (e) { return ''; }
  };

  const C = Object.assign({
    friendlyDamage: 0.2,
    // Every character has at least 150 health (150/150/100 plus the race's own). Until a hit has taught a target's real
    // maximum a party hit is judged against this, so the first lethal-sized one after a restart (S.maxHp starts empty and
    // is cleared at 4096 entries) is cut to the friendly share too instead of landing whole (2026-09-29 review)
    minMaxHealth: 150,
    bleedoutSeconds: 60,
    reviveHealth: 0.25,
    // After a revive the player kneels (the essential bleed-out pose), cannot move, attack or be hurt, and their health
    // climbs from recoverFrom to reviveHealth over recoverSeconds; then they stand (Nate, 2026-09-27). 0 = stand at once.
    recoverSeconds: 15, recoverFrom: 0.01,
    priestTier: 4,
    hostileMs: 60000,
    reviveRange: 1500, reviveConeDeg: 25, reviveFallbackMs: 1200, groupReviveRange: 400,
    // The Draught is poured by hand from as far as the gamemode lets anyone activate an actor: 6.5 m, 70 units each
    pourReach: 455,
    // A player who falls in beast form gets the panel again this long after, once their client has turned them back:
    // the first one lost the keyboard to that change (Purr, 2026-10-01: no cursor, no Give up, the whole bleed-out)
    beastPanelRetryMs: 2000,
    // A crash before the fall: the launcher's notes as the backend keeps them (sources/sessionEnds.js); the down must
    // begin within crashWithinMinutes of the crash, with nothing from the client after it (crashQuietSeconds' grace),
    // at most crashForgivePerDay times a day per character; a note landing within crashLateMinutes of the wake lifts
    // the Chill then
    crashForgive: true, crashNotesFile: '/opt/alduinak/skymp5-backend/data/session-ends.jsonl',
    crashWithinMinutes: 10, crashQuietSeconds: 5, crashForgivePerDay: 2, crashLateMinutes: 30,
    // A client that answered the down within crashSilenceSeconds was not crashed; a note must arrive within
    // crashNoteDelaySeconds of the crash it reports
    crashSilenceSeconds: 10, crashNoteDelaySeconds: 120,
    // ...and from the moment that note lands the body cannot be harmed (gamemode.js offlineBodyProtected asks), once
    // the client has stayed silent crashProbeSeconds after being asked to answer, while it neither moves nor strikes
    crashShield: true, crashProbeSeconds: 3, crashStillUnits: 64,
    // Finishing is deliberate (Nate, 2026-09-28, after swag was finished 0.3 s after falling by a spell already hitting
    // him): nothing finishes a fallen player in their first finishGraceSeconds, and then only a weapon or bare hands
    finishGraceSeconds: 3, finishWeaponOnly: true,
    // Give up (the panel and /respawn) opens this long after the fall, so a friend has time to come (Dar, 2026-09-28;
    // Nate made it 15 the same day)
    giveUpAfterSeconds: 15,
    // Death's Chill after waking at the temple: caps and the share of recovery that is kept, 1 = unchanged
    chill: true, chillMinutes: 20, chillCureTier: 2,
    // The ability shown under Magic > Active Effects while the chill lasts ('<local id>:<plugin>'); empty until the
    // record exists in a DragonBreak plugin (Nate, 2026-09-25: players could not tell why stamina crawled back)
    chillMarkerSpell: '',
    chillStaminaCap: 0.7, chillStaminaRegen: 0.4, chillMagickaCap: 0.2, chillMagickaRegen: 0.7, chillHealthRegen: 0.5,
    // A rise bigger than this in one second is a potion or a heal, not regeneration: only such jumps are taken back
    chillJumpTake: 0.05,
    // Seconds of the client's input diagnostic (npcDrift kind "input", reason "down") from the fall on: whether a
    // movement key held at death stays "down" after the panel has had the keyboard, the suspected cause of auto-run
    // after dying (Purr, /bug 30 Sep 16:24). 180 covers the bleed-out and two minutes after; 0 = off. Client 0.3.73+.
    inputDiagSeconds: 180,
  }, cfg.downed || {});

  // The engine's unarmed source is 0x1f4 (TES5DamageFormula IsUnarmedAttack); a bow's hit comes as the bow (WEAP)
  const isWeaponHit = (src) => {
    const id = Number(src) >>> 0;
    if (id === 0x1f4) return true;
    try { const r = mp.lookupEspmRecordById(id); return !!(r && r.record && String(r.record.type) === 'WEAP'); } catch (e) { return false; }
  };
  const idOf = (desc) => { try { return mp.getIdFromDesc(desc) >>> 0; } catch (e) { log(`downed: ${desc} not in the load order`); return 0; } };
  // Restoration spells that heal another: aimed ones revive what they hit, Grand Healing everyone close by
  const AIMED = new Set([idOf('12fd2:Skyrim.esm'), idOf('4d3f2:Skyrim.esm')].filter(Boolean));   // HealOther, HealingHands
  const AREA = new Set([idOf('b62ee:Skyrim.esm'), idOf('101064:Skyrim.esm')].filter(Boolean));   // GrandHealing, left hand

  const isPlayer = (a) => { try { return Number(mp.get(a, 'profileId')) >= 0; } catch (e) { return false; } };
  const isDead = (a) => { try { return mp.get(a, 'isDead') === true; } catch (e) { return false; } };
  const health = (a) => { try { const p = mp.get(a, 'percentages'); return p && typeof p.health === 'number' ? p : null; } catch (e) { return null; } };
  const setHealth = (a, h) => { const p = health(a); if (p) mp.set(a, 'percentages', { health: Math.max(0, Math.min(1, h)), magicka: p.magicka, stamina: p.stamina }); };
  // Only the short line goes on screen; detail belongs in chat, where it can be read back
  const banner = (a, text, seconds, detail) => {
    sendPacket(a, { customPacketType: 'dboBanner', text, seconds: seconds || 4 });
    sendPacket(a, { customPacketType: 'dboStatus', kind: 'notice', seconds: 1, speedMult: 0, text });
    personal(a, detail ? `${text} ${detail}` : text);
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
        if (agg !== tgt) { try { if (globalThis.__dboCrashStruck) globalThis.__dboCrashStruck(agg); } catch (e) { /* not loaded */ } }
        // A logged-out body cannot be finished or harmed (gamemode.js offlineBodyProtected); this wrapper runs first
        try { if (agg !== tgt && typeof globalThis.__dboOfflineBodyProtected === 'function' && globalThis.__dboOfflineBodyProtected(tgt)) return inner.call(this, aggressorId, targetId, sourceId, damage, ...rest) && false; } catch (e) { /* gamemode older than the gate */ }
        // The gamemode's hit bonuses are noted by the inner handler; a stale one would land on the respawned body
        globalThis.__dboMasteryPending = null;
        globalThis.__dboSuperPending = null;
        // Recovering after a revive: kneeling, out of the fight both ways
        if (S.recovering && (S.recovering.has(tgt) || S.recovering.has(agg)) && agg !== tgt) return false;
        // A hostile player finishes a fallen one with a weapon or bare hands once the grace is over: the temple, now.
        // Any other hit on a fallen player (in the grace, a spell, a lingering effect) does nothing.
        if (dmg > 0 && S.downed.has(tgt) && isDead(tgt) && isPlayer(agg) && !friendly(agg, tgt)) {
          const since = Date.now() - S.downed.get(tgt).at;
          if (since >= C.finishGraceSeconds * 1000 && (!C.finishWeaponOnly || isWeaponHit(sourceId))) finish(tgt, agg);
          return false;
        }
        if (inner.call(this, aggressorId, targetId, sourceId, damage, ...rest) === false) return false;
        if (dmg <= 0 || agg === tgt) return true;
        const p = health(tgt);
        if (!p || p.health <= 0) return true;
        const isFriendly = friendly(agg, tgt);
        if (!isFriendly && isPlayer(sideOf(agg)) && isPlayer(tgt)) S.fought.set(pairKey(sideOf(agg), tgt), Date.now());
        if (isFriendly) {
          const known = S.maxHp.get(tgt) > 0;
          const max = known ? S.maxHp.get(tgt) : C.minMaxHealth;
          if (max > 0 && p.health - dmg / max <= 0.001) {
            // Lethal at full strength: refuse it and take off the friendly share here, unless even that kills
            const reduced = p.health - C.friendlyDamage * dmg / max;
            if (reduced > 0.001) {
              setHealth(tgt, reduced);
              log(`downed: friendly hit ${display(agg)} -> ${display(tgt)} ${dmg.toFixed(1)} of ${Math.round(max)} max${known ? '' : ' (assumed)'}, applied ${Math.round(C.friendlyDamage * 100)}% (refused the lethal full hit)`);
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
  // The chill slows recovery on the player's own client, through the regeneration rates (StaminaRateMult and
  // HealRateMult through the needs system, combined with hunger; MagickaRateMult here). Taking regeneration back on
  // the server every second fought the client's once-a-second report: bars filled and snapped back, and stamina
  // came back at 10-31% instead of 40% (vitals review 2026-09-25). At or above a cap a bar's rate is 0.
  S.chillRates = S.chillRates || new Map(); // actor -> { key, f: { StaminaRateMult, HealRateMult, MagickaRateMult } }
  const rateFactors = (a, p) => {
    const old = (S.chillRates.get(a) || {}).f || {};
    // Hysteresis: a bar stops at its cap and starts again 3 points under it, so the rate does not flip every second
    const atCap = (v, cap, prev) => v >= cap - 1e-6 || (prev === 0 && v >= cap - 0.03);
    return {
      StaminaRateMult: atCap(p.stamina, C.chillStaminaCap, old.StaminaRateMult) ? 0 : C.chillStaminaRegen,
      HealRateMult: C.chillHealthRegen,
      MagickaRateMult: atCap(p.magicka, C.chillMagickaCap, old.MagickaRateMult) ? 0 : C.chillMagickaRegen,
    };
  };
  const setChillRates = (a, p) => {
    const f = p ? rateFactors(a, p) : null;
    const key = JSON.stringify(f);
    const old = S.chillRates.get(a);
    if ((old ? old.key : 'null') === key) return;
    if (f) S.chillRates.set(a, { key, f }); else S.chillRates.delete(a);
    try { if (typeof globalThis.__dboNeedsRefresh === 'function') globalThis.__dboNeedsRefresh(a); } catch (e) { /* no needs system */ }
    try { if (typeof globalThis.__dboSetActorValue === 'function') globalThis.__dboSetActorValue(a, 'MagickaRateMult', Math.round(100 * (f ? f.MagickaRateMult : 1))); } catch (e) { /* not an actor */ }
  };
  globalThis.__dboChillRateMult = (a, av) => { const r = S.chillRates.get(Number(a) >>> 0); return r && r.f[av] !== undefined ? r.f[av] : 1; };

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
  // Waking at the temple puts the outfit back the way a login does (Onny, 2026-09-29: "every time i die, i spawn in
  // naked"). redress() does nothing to a player already dressed; one who is logged out is dressed at the next login.
  const dressAfterWake = (a) => {
    if (typeof redress !== 'function') return;
    setTimeout(() => { try { if (onlineActors().includes(a) && !isDead(a)) redress(a); } catch (e) { log(`downed: re-dress after the temple failed: ${e.message}`); } }, 1500);
  };
  const chill = (a) => {
    if (!C.chill || !isPlayer(a) || mp.get(a, 'private.permaDead') === true) return;
    const leftMs = C.chillMinutes * 60000;
    chilled.set(a, { leftMs, at: Date.now(), p: null, savedAt: Date.now() });
    saveChill(a, leftMs);
    markChill(a, true);
    banner(a, `The chill of the grave is in your bones. It passes in ${C.chillMinutes} minutes.`, 6,
      "Your breath and your magic come back slowly and wounds knit poorly. A Priest's healing can lift it sooner.");
    audit(`CHILL ${who(a)} woke at the temple with Death's Chill (${C.chillMinutes} min)`);
  };
  const liftChill = (a, by) => {
    chilled.delete(a);
    saveChill(a, 0);
    markChill(a, false);
    setChillRates(a, null);
    if (by) {
      banner(a, `${nameTo(a, by)}'s healing drives the chill of the grave from you.`, 5);
      banner(by, `You lift the chill of the grave from ${nameTo(by, a)}.`, 3);
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
  // Only a jump (a potion, a heal) is slowed here; natural regeneration already runs at the chill's rate on the client
  const tame = (was, now, keep, cap) => Math.min(cap, was !== null && now - was > C.chillJumpTake ? was + (now - was) * keep : now);
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
      const was = c.p;
      const next = {
        health: tame(was ? was.health : null, p.health, C.chillHealthRegen, 1),
        stamina: tame(was ? was.stamina : null, p.stamina, C.chillStaminaRegen, C.chillStaminaCap),
        magicka: tame(was ? was.magicka : null, p.magicka, C.chillMagickaRegen, C.chillMagickaCap),
      };
      if (Math.abs(next.health - p.health) + Math.abs(next.stamina - p.stamina) + Math.abs(next.magicka - p.magicka) > 0.002) {
        try { mp.set(a, 'percentages', next); } catch (e) { /* not an actor */ }
      }
      setChillRates(a, next);
      // Online time only, and a long gap (a stall, a reload) never burns more than a few seconds
      if (was) c.leftMs -= Math.min(now - c.at, 5000);
      c.at = now;
      c.p = next;
      if (c.leftMs <= 0) liftChill(a, 0);
      else if (now - c.savedAt > 15000) { c.savedAt = now; saveChill(a, c.leftMs); }
    }
    for (const a of [...chilled.keys()]) if (!onlineActors().includes(a)) { saveChill(a, chilled.get(a).leftMs); chilled.delete(a); S.chillRates.delete(a); }
  });
  const addStatus = (key, order, fn) => { try { if (typeof globalThis.__dboRegisterStatus === 'function') globalThis.__dboRegisterStatus(key, order, fn); } catch (e) { /* gamemode older than /status */ } };
  addStatus('chill', 30, (a) => { const l = chillLeft(a); return l ? `Death's Chill ${Math.ceil(l / 60000)} min` : null; });
  registerChatCommand('chill', (a) => {
    const left = chillLeft(a);
    personal(a, left ? `The chill of the grave is on you for ${Math.ceil(left / 60000)} more minute(s) of play. A Priest of tier ${C.chillCureTier} or higher can lift it with a healing spell.` : 'You are free of the chill of the grave.');
  }, { help: "how long Death's Chill lasts" });
  globalThis.__dboDeathChillLeft = (a) => chillLeft(Number(a) >>> 0);
  globalThis.__dboChillCureTier = () => C.chillCureTier;

  // ---- the panel and the timers others see ---------------------------------------------------------------
  // Nate, 2026-09-27 (players missed the banner and did not know why they were not sent to the temple): a panel in the
  // middle of the downed player's screen, "You're down!", who can raise them, a live countdown and Give up; and a
  // countdown over the downed player for everyone near them (client downedTimerService, packet dboDowned).
  const PANEL_ID = 62;
  const TIMER_RANGE = 6000; // units: about 85 m, the distance a downed body can be told apart
  const secondsLeft = (d) => Math.max(0, Math.ceil((d.at + C.bleedoutSeconds * 1000 - Date.now()) / 1000));
  // Only a client whose UI said it draws the panel (dbo:uiCaps 'downed') gets it: an unknown widget opened with the
  // keyboard would leave an invisible panel holding the keys. Anyone else keeps the banner.
  const caps = globalThis.__dboDownedCaps instanceof Map ? globalThis.__dboDownedCaps : (globalThis.__dboDownedCaps = new Map());
  if (typeof onUi === 'function') onUi('uiCaps', (a, args) => { caps.set(a >>> 0, new Set((args || []).map(String))); });
  const giveUpLeft = (d) => Math.max(0, Math.ceil((Number(d.at) + C.giveUpAfterSeconds * 1000 - Date.now()) / 1000));
  const openPanel = (a, d) => {
    if (typeof openWidget !== 'function' || !(caps.get(a >>> 0) || new Set()).has('downed')) {
      banner(a, `You are down. You wake at the temple in ${C.bleedoutSeconds} seconds, or say /respawn to go now.`, 8,
        "A Priest's healing or a Draught of Revival can bring you back where you fell.");
      return;
    }
    openWidget(a, { type: 'downed', id: PANEL_ID, nonce: d.nonce, seconds: secondsLeft(d), giveUpIn: giveUpLeft(d),
      title: "You're down!", text: 'You can be brought back to your feet by someone with healing magic or a Draught of Revival.' }, true);
  };
  // Every way out of the down state goes through here, so the panel never outlives it (it holds the keyboard)
  const endDown = (a) => {
    const had = S.downed.delete(a);
    if (had && typeof closeWidget === 'function') { try { closeWidget(a, PANEL_ID); } catch (e) { /* offline */ } }
    if (had) pushTimers(true);
    return had;
  };
  const sentTimers = globalThis.__dboDownedTimersSent instanceof Map ? globalThis.__dboDownedTimersSent : (globalThis.__dboDownedTimersSent = new Map()); // viewer -> ids key
  let lastFullPush = 0;
  // Sends each player the downed players near them: when that set changes, and every 10 s to keep the clocks true
  const pushTimers = (force) => {
    const now = Date.now();
    const full = force || now - lastFullPush > 10000;
    if (full) lastFullPush = now;
    const downed = [];
    for (const [t, d] of S.downed) {
      try { if (isDead(t)) downed.push({ t, d, cell: mp.get(t, 'worldOrCellDesc'), pos: mp.get(t, 'pos') }); } catch (e) { /* gone */ }
    }
    for (const p of onlineActors()) {
      let list = [];
      try {
        if (downed.length) {
          const cell = mp.get(p, 'worldOrCellDesc'), pos = mp.get(p, 'pos');
          list = downed.filter((x) => x.t !== p && x.cell === cell && Math.hypot(x.pos[0] - pos[0], x.pos[1] - pos[1], x.pos[2] - pos[2]) <= TIMER_RANGE)
            .map((x) => ({ id: x.t, seconds: secondsLeft(x.d) }));
        }
      } catch (e) { list = []; }
      const key = list.map((x) => x.id).join(',');
      if (!full && sentTimers.get(p) === key) continue;
      if (!list.length && !sentTimers.get(p)) { sentTimers.delete(p); continue; }
      try { sendPacket(p, { customPacketType: 'dboDowned', list }); } catch (e) { /* offline */ }
      if (list.length) sentTimers.set(p, key); else sentTimers.delete(p);
    }
    for (const p of [...sentTimers.keys()]) if (!onlineActors().includes(p)) sentTimers.delete(p);
  };
  if (typeof onUi === 'function') {
    onUi('downedGiveUp', (a, args) => {
      const d = S.downed.get(a);
      if (!d || String(args[0] || '') !== d.nonce || !isDead(a)) return;
      if (giveUpLeft(d) > 0) return banner(a, `You can give up in ${giveUpLeft(d)} seconds.`, 3);
      log(`downed: ${display(a)} gave up (panel)`);
      toTemple(a);
    });
  }
  // The engine's own respawn at the end of the bleed-out gives no event: watch the downed every second
  every('downedPanel', 1000, () => {
    for (const [a, d] of S.downed) { let dead = true; try { dead = isDead(a); } catch (e) { dead = false; } if (!dead) { endDown(a); wakeAfter(a, d); dressAfterWake(a); } }
    if (S.downed.size || sentTimers.size) pushTimers(false);
  });

  // ---- the down state ------------------------------------------------------------------------------------
  // The engine starts its respawn timer at death with the actor's spawnDelay, so it must be set before anyone falls
  every('downedDelay', 10000, () => {
    for (const a of onlineActors()) {
      try { if (Number(mp.get(a, 'spawnDelay')) !== C.bleedoutSeconds) mp.set(a, 'spawnDelay', C.bleedoutSeconds); } catch (e) { /* not an actor */ }
    }
    const now = Date.now();
    for (const [a, d] of S.downed) {
      if (!isDead(a)) { endDown(a); wakeAfter(a, d); dressAfterWake(a); }
      else if (now - d.at > (C.bleedoutSeconds + 30) * 1000) endDown(a);
    }
    for (const [k, t] of S.fought) if (now - t > C.hostileMs) S.fought.delete(k);
    if (S.maxHp.size > 4096) S.maxHp.clear();
  });

  {
    const inner = mp.onDeath;
    if (typeof inner === 'function') {
      mp.onDeath = function (actorId, killerId, ...rest) {
        const a = Number(actorId) >>> 0;
        // Read before the inner chain, whose deathHook turns the beast back
        let wasBeast = false;
        try { wasBeast = typeof globalThis.__dboBeastOriginalRace === 'function' && globalThis.__dboBeastOriginalRace(a) > 0; } catch (e) { wasBeast = false; }
        const out = inner.call(this, actorId, killerId, ...rest);
        try {
          if (isPlayer(a) && mp.get(a, 'private.permaDead') !== true) {
            const d = { at: Date.now(), by: Number(killerId) >>> 0, nonce: `${a.toString(16)}-${Date.now().toString(36)}`, fell: placeOf(a), lastPacket: lastPacketOf(a) };
            S.downed.set(a, d);
            // The panel says it all; chat keeps a line for anyone who closes it
            personal(a, `You are down. You wake at the temple in ${C.bleedoutSeconds} seconds, or choose Give up (or say /respawn). A Priest's healing or a Draught of Revival can bring you back where you fell.`);
            openPanel(a, d);
            noteAnswer(a, d);
            if (wasBeast && C.beastPanelRetryMs > 0) {
              setTimeout(() => { try { if (S.downed.get(a) === d && isDead(a)) openPanel(a, d); } catch (e) { /* gone */ } }, C.beastPanelRetryMs);
            }
            pushTimers(true);
            if (Number(C.inputDiagSeconds) > 0) sendPacket(a, { customPacketType: 'dboInputDiag', seconds: Number(C.inputDiagSeconds), reason: 'down' });
            log(`downed: ${display(a)} is down${killerId ? ` (by ${display(Number(killerId) >>> 0)}${killerGap(a, Number(killerId) >>> 0)})` : ''}`);
            // Journal stats (journalstats.js): the down, and who put them down if it was a player
            try { if (globalThis.__dboStatsAdd) { globalThis.__dboStatsAdd(a, 'downs'); if (d.by && d.by !== a && isPlayer(d.by)) globalThis.__dboStatsAdd(d.by, 'playersDowned'); } } catch (e) { /* stats only */ }
          }
        } catch (e) { log(`downed: death handling failed: ${e.message}`); }
        return out;
      };
    }
  }

  const revive = (t, by, how) => {
    const d = S.downed.get(t);
    if (!d || !isDead(t) || mp.get(t, 'private.permaDead') === true) return false;
    if (by && hostile(sideOf(by), t)) { banner(by, `${nameTo(by, t)} fought you moments ago and will not take your help.`); return false; }
    endDown(t);
    mp.set(t, 'isDead', false);
    if (C.recoverSeconds > 0) startRecovery(t); else setHealth(t, C.reviveHealth);
    banner(t, `${by ? nameTo(t, by) : 'Someone'} raised you with ${how}.${C.recoverSeconds > 0 ? ' Catch your breath before you stand.' : ''}`, 5);
    if (by) banner(by, `You raised ${nameTo(by, t)}.`, 3);
    audit(`REVIVE ${who(t)} by ${by ? who(by) : 'nobody'} (${how})`);
    return true;
  };
  // ---- recovery after a revive: kneel, heal slowly, stand ----------------------------------------------------
  // BleedOutStart / BleedOutStop are the vanilla essential bleed-out events, sent on the player's own client through
  // Papyrus Debug.SendAnimationEvent (as gatheringSystem.ts does for its exit idle). That is only a pose, so the rest is
  // held here: the client holds the controls (dboParalyse, quiet), and the hit hook above refuses hits both ways.
  S.recovering = S.recovering instanceof Map ? S.recovering : new Map(); // actor -> { at, until }
  const anim = (a, ev) => { try { mp.callPapyrusFunction('global', 'Debug', 'SendAnimationEvent', null, [{ type: 'form', desc: mp.getDescFromId(a) }, ev]); } catch (e) { log(`downed: ${ev} failed for ${display(a)}: ${e.message}`); } };
  const startRecovery = (t) => {
    const now = Date.now();
    S.recovering.set(t, { at: now, until: now + C.recoverSeconds * 1000 });
    setHealth(t, C.recoverFrom);
    try { sendPacket(t, { customPacketType: 'dboParalyse', seconds: C.recoverSeconds, quiet: true }); } catch (e) { /* offline */ }
    // The engine's own get-up plays as the body is raised; the kneel goes on after it
    setTimeout(() => { if (S.recovering.has(t)) anim(t, 'BleedOutStart'); }, 1200);
    log(`downed: ${display(t)} recovering for ${C.recoverSeconds} s`);
  };
  const endRecovery = (t, why) => {
    if (!S.recovering.delete(t)) return;
    anim(t, 'BleedOutStop');
    if (why === 'done') { setHealth(t, C.reviveHealth); banner(t, 'You are back on your feet.', 3); }
    log(`downed: ${display(t)} recovery ended (${why})`);
  };
  every('downedRecovery', 1000, () => {
    const now = Date.now();
    for (const [t, r] of S.recovering) {
      let dead = false, online = true;
      try { dead = isDead(t); online = onlineActors().includes(t); } catch (e) { online = false; }
      if (dead) { S.recovering.delete(t); continue; }
      // Raised while away (a body in its logout grace) or gone mid-recovery: nothing climbs while offline, so the health the
      // recovery ends on is given now (2026-09-29 review: such a body kept the 1% it knelt at)
      if (!online) { S.recovering.delete(t); try { setHealth(t, C.reviveHealth); } catch (e) { /* gone */ } log(`downed: ${display(t)} recovery ended (offline)`); continue; }
      if (now >= r.until) { endRecovery(t, 'done'); continue; }
      const f = (now - r.at) / (r.until - r.at);
      setHealth(t, C.recoverFrom + (C.reviveHealth - C.recoverFrom) * f);
    }
  });

  // ---- a crash before the fall ------------------------------------------------------------------------------------
  // The launcher reports how the game closed (POST /api/files/session-end) and the backend keeps every note in
  // data/session-ends.jsonl. Only its 'crash' counts (a crash log, or an error exit code): a quit, Alt-F4 or a kill from
  // Task Manager still costs the temple and the Chill, so a fight cannot be left by quitting. The down must begin after
  // the crash and soon after it, with nothing from that client since; a client that answered the down was not crashed.
  // At most crashForgivePerDay times a day.
  S.crashes = S.crashes instanceof Map ? S.crashes : new Map();         // profileId -> [{ endedAt, at, exitCode, crashLog }]
  S.recentWakes = S.recentWakes instanceof Map ? S.recentWakes : new Map(); // actor -> { d, wokeAt }, chilled wakes a late note may forgive
  S.shielded = S.shielded instanceof Map ? S.shielded : new Map();       // actor -> endedAt of the crash note shielding the body
  S.unshielded = S.unshielded instanceof Map ? S.unshielded : new Map(); // actor -> endedAt of a note that shields nothing
  S.probes = S.probes instanceof Map ? S.probes : new Map();             // actor -> { note, sentAt, pos, world }, a client asked to answer
  S.struckAt = S.struckAt instanceof Map ? S.struckAt : new Map();       // player -> their last blow, by any hit attempt
  const FORGIVEN = 'private.dboCrashForgiven';
  const DAY = 24 * 3600000;
  const iso = (t) => new Date(t).toISOString().slice(11, 19) + 'Z';
  const placeOf = (a) => {
    try {
      const pos = mp.get(a, 'pos'), cell = mp.get(a, 'worldOrCellDesc'), ang = mp.get(a, 'angle');
      return Array.isArray(pos) && cell ? { cellOrWorldDesc: cell, pos: pos.slice(), rot: [0, 0, Number(Array.isArray(ang) ? ang[2] : 0) || 0] } : null;
    } catch (e) { return null; }
  };
  const lastPacketOf = (a) => { const m = globalThis.__dboLastPacketAt; return m instanceof Map && m.has(a) ? m.get(a) : 0; };
  // Each profile's newest note of any outcome (crash, closed, ended), by the server's time of arrival: dungeons.js asks
  S.lastNotes = S.lastNotes instanceof Map ? S.lastNotes : new Map();
  const readCrashNotes = async () => {
    let st = null; try { st = await fs.promises.stat(C.crashNotesFile); } catch (e) { return 0; }
    if (st.mtimeMs === S.crashMtime) return 0;
    let text = ''; try { text = await fs.promises.readFile(C.crashNotesFile, 'utf8'); } catch (e) { return 0; }
    S.crashMtime = st.mtimeMs;
    const since = Date.now() - DAY;
    const byProfile = new Map(), latest = new Map();
    for (const line of text.split('\n')) {
      if (line.indexOf('"outcome"') < 0) continue;
      let n = null; try { n = JSON.parse(line); } catch (e) { continue; }
      if (!n || !(Number(n.endedAt) > since) || !(Number(n.profileId) >= 0)) continue;
      const p = Number(n.profileId);
      const note = { endedAt: Number(n.endedAt), at: Number(n.at) || 0, outcome: String(n.outcome || ''), exitCode: n.exitCode, crashLog: n.crashLog === true };
      const prev = latest.get(p);
      if (!prev || (note.at || note.endedAt) >= (prev.at || prev.endedAt)) latest.set(p, note);
      if (note.outcome !== 'crash') continue;
      if (!byProfile.has(p)) byProfile.set(p, []);
      byProfile.get(p).push({ endedAt: note.endedAt, at: note.at, exitCode: note.exitCode, crashLog: note.crashLog });
    }
    S.lastNotes = latest;
    if (!C.crashForgive) return 0;
    S.crashes = byProfile;
    for (const m of [S.shielded, S.unshielded]) for (const [a, t] of m) if (Date.now() - t > DAY) m.delete(a);
    for (const [a, pr] of S.probes) if (Date.now() - pr.note.endedAt > DAY) S.probes.delete(a);
    askToAnswer();
    return lateForgive();
  };
  every('downedCrashNotes', 2000, () => readCrashNotes().catch((e) => log(`downed: crash notes unreadable: ${e.message}`)));
  // The launcher's crash note that forgives this down, or null
  const landedInTime = (n) => !(n.at - n.endedAt > C.crashNoteDelaySeconds * 1000);
  const crashBefore = (a, d) => {
    if (!C.crashForgive || !d || !Number.isFinite(d.at)) return null;
    // A down from before this check has no answer noted: judged by what came from the client since it began
    const answered = d.answered !== undefined ? d.answered : Number(lastPacketOf(a)) > d.at;
    if (answered) return null;
    const grace = C.crashQuietSeconds * 1000;
    const quiet = (t) => !(Number(d.lastPacket) > t + grace) && !(Number(S.struckAt.get(a)) > t + grace);
    return (S.crashes.get(Number(profileOf(a))) || [])
      .find((n) => n.endedAt <= d.at && d.at - n.endedAt <= C.crashWithinMinutes * 60000 && landedInTime(n) && quiet(n.endedAt)) || null;
  };
  // Whether the client answered the down, noted once the silence has had time to show. The down's diagnostic asks it;
  // with that diagnostic off the client is still asked once, briefly (reason crash-check), as the crash check needs it.
  const noteAnswer = (a, d) => {
    if (!C.crashForgive) return;
    if (!(Number(C.inputDiagSeconds) > 0)) sendPacket(a, { customPacketType: 'dboInputDiag', seconds: 5, reason: 'crash-check' });
    setTimeout(() => { try { if (S.downed.get(a) === d) d.answered = Number(lastPacketOf(a)) > d.at; } catch (e) { /* gone */ } }, C.crashSilenceSeconds * 1000);
  };
  const crashWords = (note) => `the game crashed at ${iso(note.endedAt)} (launcher: exit ${note.exitCode === null || note.exitCode === undefined ? 'none' : '0x' + (Number(note.exitCode) >>> 0).toString(16)}${note.crashLog ? ', crash log' : ''})`;
  // One crash counts once a day, whether it shielded the body or forgave a down; false when the day's limit is reached
  const countCrash = (a, note, what) => {
    if (S.shielded.get(a) === note.endedAt) return true;
    let times = [];
    try { const v = mp.get(a, FORGIVEN); times = Array.isArray(v) ? v.filter((t) => Date.now() - t < DAY) : []; } catch (e) { times = []; }
    if (times.length >= C.crashForgivePerDay) { audit(`CRASH-DOWN not forgiven ${who(a)}: ${crashWords(note)}${what}; already ${times.length} today`); return false; }
    try { mp.set(a, FORGIVEN, times.concat([Date.now()])); } catch (e) { /* not an actor */ }
    return true;
  };
  // late: the wake already happened and chilled them; the Chill goes, and the place and health only while they are away
  const forgive = (a, d, note, late) => {
    const crash = `${crashWords(note)}, the down began at ${iso(d.at)}`;
    if (!countCrash(a, note, `, the down began at ${iso(d.at)}`)) return false;
    const away = !onlineActors().includes(a);
    if (late) liftChill(a, 0);
    if (!late || away) {
      if (d.fell) { try { mp.set(a, 'locationalData', d.fell); } catch (e) { log(`downed: crash-down move failed for ${display(a)}: ${e.message}`); } }
      setHealth(a, 1);
    }
    if (!away) banner(a, late ? 'Your game had crashed before you fell: the chill of the grave is lifted.' : 'Your game had crashed before you fell: you wake where you were, unharmed.', 6);
    audit(`CRASH-DOWN forgiven ${who(a)}: ${crash}${late ? '; the Chill lifted after the wake' : '; woke where they fell, no Chill'}`);
    return true;
  };
  // The way out of a down at the temple: forgiven after a crash, else the Chill
  const wakeAfter = (a, d) => {
    const note = crashBefore(a, d);
    if (note && forgive(a, d, note, false)) return;
    chill(a);
    if (C.crashForgive && d) S.recentWakes.set(a, { d, wokeAt: Date.now() });
  };
  const lateForgive = () => {
    let n = 0;
    for (const [a, w] of S.recentWakes) {
      if (Date.now() - w.wokeAt > C.crashLateMinutes * 60000) { S.recentWakes.delete(a); continue; }
      const note = crashBefore(a, w.d);
      if (!note) continue;
      S.recentWakes.delete(a);
      if (forgive(a, w.d, note, true)) n++;
    }
    return n;
  };
  // While the server still holds a crashed player's connection their body cannot be harmed, so no down begins at all.
  // When the note lands the client is asked to answer; only silence, a body that stays put and strikes no one, shields.
  const placeNow = (a) => { try { return { pos: mp.get(a, 'pos'), world: mp.get(a, 'worldOrCellDesc') }; } catch (e) { return null; } };
  const stillAt = (a, pr) => {
    const p = placeNow(a);
    return !!(p && Array.isArray(p.pos) && Array.isArray(pr.pos) && p.world === pr.world && Math.hypot(p.pos[0] - pr.pos[0], p.pos[1] - pr.pos[1], p.pos[2] - pr.pos[2]) <= C.crashStillUnits);
  };
  const askToAnswer = () => {
    if (!C.crashShield || !C.crashForgive) return;
    const now = Date.now();
    for (const a of onlineActors()) {
      if (S.downed.has(a)) continue;
      const n = (S.crashes.get(Number(profileOf(a))) || []).find((x) => x.endedAt <= now && now - x.endedAt <= C.crashWithinMinutes * 60000 && landedInTime(x));
      if (!n || (S.probes.get(a) || {}).note === n || S.unshielded.get(a) === n.endedAt) continue;
      if (Number(lastPacketOf(a)) > n.endedAt + C.crashQuietSeconds * 1000) { S.unshielded.set(a, n.endedAt); continue; }
      const p = placeNow(a);
      if (!p) continue;
      S.probes.set(a, { note: n, sentAt: now, pos: p.pos, world: p.world });
      sendPacket(a, { customPacketType: 'dboInputDiag', seconds: 5, reason: 'crash-check' });
    }
  };
  const dropShield = (a, endedAt, why) => {
    if (S.shielded.get(a) === endedAt) audit(`CRASH-DOWN shield dropped ${who(a)}: ${why}`);
    S.shielded.delete(a);
    S.unshielded.set(a, endedAt);
    return false;
  };
  const crashShield = (a) => {
    if (!C.crashShield || !C.crashForgive) return false;
    a = Number(a) >>> 0;
    const pr = S.probes.get(a);
    if (!pr || S.downed.has(a) || S.unshielded.get(a) === pr.note.endedAt) return false;
    const now = Date.now(), n = pr.note;
    if (now - n.endedAt > C.crashWithinMinutes * 60000 || now - pr.sentAt < C.crashProbeSeconds * 1000) return false;
    const last = Number(lastPacketOf(a));
    if (last > pr.sentAt || last > n.endedAt + C.crashQuietSeconds * 1000) return dropShield(a, n.endedAt, 'the client answered');
    if (Number(S.struckAt.get(a)) > n.endedAt + C.crashQuietSeconds * 1000) return dropShield(a, n.endedAt, 'they struck a blow');
    if (!stillAt(a, pr)) return dropShield(a, n.endedAt, 'the body moved');
    if (S.shielded.get(a) === n.endedAt) return true;
    if (!countCrash(a, n, '; the body was left open')) { S.unshielded.set(a, n.endedAt); return false; }
    S.shielded.set(a, n.endedAt);
    audit(`CRASH-DOWN shielded ${who(a)}: ${crashWords(n)}; the body cannot be harmed until they are back`);
    return true;
  };
  // A player who strikes is still playing: no crash before it counts, and a shield drops
  globalThis.__dboCrashStruck = (agg) => {
    agg = Number(agg) >>> 0;
    if (!isPlayer(agg)) return;
    S.struckAt.set(agg, Date.now());
    const t = S.shielded.get(agg);
    if (t !== undefined) dropShield(agg, t, 'they struck a blow');
  };
  globalThis.__dboCrashShield = crashShield;
  globalThis.__dboCrashNotesRead = readCrashNotes;
  globalThis.__dboLastSessionNote = (pid) => S.lastNotes.get(Number(pid)) || null;

  // Wakes at the spawn point (the temple of the area, set on death) the way the engine's own respawn does
  const toTemple = (t) => {
    const d = S.downed.get(t);
    endDown(t);
    try { const sp = mp.get(t, 'spawnPoint'); if (sp && sp.cellOrWorldDesc) mp.set(t, 'locationalData', sp); } catch (e) { log(`downed: temple move failed for ${display(t)}: ${e.message}`); }
    mp.set(t, 'isDead', false);
    wakeAfter(t, d);
    dressAfterWake(t);
  };
  const finish = (t, by) => {
    // Journal stats: the finishing blow is the kill (Nate, 2026-09-30), in a war to the death too
    try { if (globalThis.__dboStatsAdd && by && by !== t && isPlayer(by)) { globalThis.__dboStatsAdd(t, 'killedByPlayers'); globalThis.__dboStatsAdd(by, 'playerKills'); } } catch (e) { /* stats only */ }
    // In a war to the death an enemy's killing blow on contested land ends the character (realm.js)
    try { if (typeof globalThis.__dboWarFinish === 'function' && globalThis.__dboWarFinish(t, by)) { endDown(t); return; } } catch (e) { log('downed: war check failed', e.message); }
    audit(`FINISHED ${who(t)} by ${who(by)}`);
    banner(t, `${nameTo(t, by)} finished you. You wake at the temple.`, 5);
    toTemple(t);
  };
  registerChatCommand('respawn', (a) => {
    if (!S.downed.has(a) || !isDead(a)) return personal(a, 'You are not down.');
    if (giveUpLeft(S.downed.get(a)) > 0) return personal(a, `You can give up in ${giveUpLeft(S.downed.get(a))} seconds. Someone may yet come for you.`);
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
  const castStop = S.castStop = S.castStop || new Map(); // caster -> distance to the living actor their pending aimed heal hit
  const distanceTo = (a, b) => {
    try {
      if (mp.get(a, 'worldOrCellDesc') !== mp.get(b, 'worldOrCellDesc')) return Infinity;
      const p = mp.get(a, 'pos'), q = mp.get(b, 'pos');
      return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    } catch (e) { return Infinity; }
  };
  {
    const inner = mp.onSpellHit;
    if (typeof inner === 'function') {
      mp.onSpellHit = function (aggressorId, targetId, spellId, ...rest) {
        const caster = Number(aggressorId) >>> 0, t = Number(targetId) >>> 0, spell = Number(spellId) >>> 0;
        try {
          // An aimed heal that landed on someone alive stopped there (2026-09-29 review: a Priest healing a friend also raised,
          // by aim, anyone lying fallen behind them). The fallback below may still raise a body nearer than them, which the heal
          // can pass through, never one beyond.
          if (AIMED.has(spell) && pendingCast.has(caster) && !isDead(t)) {
            const d = distanceTo(caster, t);
            if (d < (castStop.has(caster) ? castStop.get(caster) : Infinity)) castStop.set(caster, d);
          }
          if (AIMED.has(spell) && S.downed.has(t) && isDead(t)) {
            const pc = pendingCast.get(caster); if (pc) { clearTimeout(pc); pendingCast.delete(caster); castStop.delete(caster); }
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
            castStop.delete(caster);
            pendingCast.set(caster, setTimeout(() => {
              pendingCast.delete(caster);
              const stop = castStop.has(caster) ? castStop.get(caster) : Infinity;
              castStop.delete(caster);
              const t = downedNear(caster, Math.min(C.reviveRange, stop), C.reviveConeDeg)[0];
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
  // This hook runs before the gamemode's own, so it keeps that one's two refusals itself (2026-09-29 review: a Draught
  // could be poured from any distance and with bound hands): hands bound, or the fallen out of its reach.
  const canPour = (a, t) => {
    try { const r = mp.get(a, 'private.restrained'); if (r && r.boundHands) return false; } catch (e) { /* free */ }
    return distanceTo(a, t) <= C.pourReach;
  };
  if (POTION) {
    const innerActivate = mp.onActivate;
    if (typeof innerActivate === 'function') {
      mp.onActivate = function (targetId, casterId, ...rest) {
        const t = Number(targetId) >>> 0, a = Number(casterId) >>> 0;
        try {
          if (t !== a && S.downed.has(t) && isDead(t) && countOf(a, POTION) > 0 && canPour(a, t)) {
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
  // A player's companion (a summon, a raised corpse) fights another player only under the PvP rules (Nate, 5 Oct: "yes in
  // pvp"). The fork's companionSystem asks this before every order, defence and blow on a player or on what fights for one,
  // after its own part: the two players struck each other (or each other's companion) within 60 s, the target is online
  // and standing. This is the gameplay's part; anything it cannot read refuses.
  globalThis.__dboCompanionMayFight = (ownerId, targetId) => {
    try {
      const o = Number(ownerId) >>> 0, t = Number(targetId) >>> 0;
      if (!o || !t || o === t || !isPlayer(o) || !isPlayer(t)) return false;
      // gamemode-config pvp.companions: false keeps every companion out of PvP
      if ((cfg.pvp || {}).companions === false) return false;
      // One side or one party: friendly fire is for the players' own blows, never a companion's
      if (friendly(o, t)) return false;
      // A downed player is never attacked; neither side fights while down or kneeling after a revive
      if (S.downed.has(t) || S.downed.has(o) || isDead(t) || isDead(o)) return false;
      if (S.recovering instanceof Map && (S.recovering.has(t) || S.recovering.has(o))) return false;
      for (const a of [o, t]) {
        // A jail sentence still to serve (jail.js), bound, carried or held (captureSystem, rope.js)
        let s = null; try { s = mp.get(a, 'private.dboSentence'); } catch (e) { s = null; }
        if (s && Number(s.totalMs) > 0) return false;
        let r = null; try { r = mp.get(a, 'private.restrained'); } catch (e) { r = null; }
        if (r && (r.boundHands || r.carried || r.captorActorId)) return false;
      }
      // A logged-out body (gamemode.js), an ethereal beast form (beastform.js)
      if (typeof globalThis.__dboOfflineBodyProtected === 'function' && globalThis.__dboOfflineBodyProtected(t)) return false;
      if (typeof globalThis.__dboBeastEthereal === 'function' && globalThis.__dboBeastEthereal(t)) return false;
      // Safe ground: no PvP-free area exists in the gameplay yet; a module that adds one provides this
      if (typeof globalThis.__dboPvpSafeGround === 'function' && globalThis.__dboPvpSafeGround(o, t)) return false;
      return true;
    } catch (e) { return false; }
  };
  // Who brought a downed player down (robbery.js: only the robber who did it takes the goods), or 0
  globalThis.__dboDownedBy = (a) => { const d = S.downed.get(Number(a) >>> 0); return d && isDead(Number(a) >>> 0) ? Number(d.by) >>> 0 : 0; };
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
