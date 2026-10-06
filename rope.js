// Rope: tying someone up without a guard's authority, loaded by gamemode.js like struggle.js (Nate, 2026-09-30).
//
// captureSystem.ts (fork) owns the binding itself. A player without authority who carries a rope may tie a DOWNED
// player at once, or a conscious one who says yes to the prompt, never on sight; it asks this module whether the
// captor carries a rope (__dboRopeHeld) and takes one when the knot is tied (__dboRopeTake). One binding uses one
// rope. A rope captive is marked private.restrained.rope, wears no shackles and is led on the tether like an arrest.
// A refused or unanswered prompt holds 2 minutes for that pair, and a rope captive who gets free has a 60 s grace
// before anyone can tie them again (captureSystem, ropeRefusalHoldMs and ropeEscapeGraceMs in server-settings.json).
//
// This module:
//   - the X-menu entries (asked by playermenu.js through __dboRopeMenuEntries and __dboRopeMenuAction):
//       Tie Up (id capture, straight to captureSystem) for someone carrying a rope, on anyone not bound;
//       Untie (id release, captureSystem) and Leave Tied Here / Lead (captureSystem's __dboLeash) for the captor;
//       Cut Free for anyone else next to a rope captive, while rope.cutFree is on. Guard shackles never cut.
//   - the unattended clock: a rope captive whose captor is more than unattendedMeters away, in another cell or down,
//     for unattendedAfterSeconds in a row is left unattended. struggle.js asks __dboRopeUnattended for its easier
//     round. Unattended time adds up, pausing (not resetting) while the captor is back within reach, so dropping by
//     now and then cannot keep someone tied for good; at warnMinutes the captive is told the knots are nearly loose,
//     at slipMinutes the rope slips off (captureSystem's __dboBreakFree 'slip'). A captor who logs out frees their
//     captive at once, as with an arrest.
//   - Cut Free: cutSeconds standing next to the captive; either moving more than cutMoveUnits breaks it.
//
// Animations: Helgen's, where Hadvar or Ralof cuts the player's binds in MQ101 (Nate, 2026-09-30; Worker D read them
// from Skyrim.esm: the keep-intro lines INFO 20121 and 4e1a2 give the speaker BoundStandingCutNPC, their fragments and
// the MQ101 script hold BoundStandingCut for the player). Each is sent through Papyrus Debug.SendAnimationEvent on that
// player's own client (as downed.js does) and seen by others through the animation sync; '' plays nothing. The event
// names are proven by the records, not yet by the player's graph (docs/alpha/anim-console-check.md rows 14-16); an event
// the graph lacks is ignored. If they do not play, IdleLockPick (bb051) or IdleSearchingTable (6ff0f) will do for the
// hands. Never the paired pa_OffsetBoundStandingCut (4c291): SkyMP does not sync a paired clip between two players.
//   cutFreeIdle: the rescuer as the cut starts (BoundStandingCutNPC, 109b69; it ends by itself)
//   cutFreeStop: the rescuer when a cut breaks (IdleForceDefaultState, 86840)
//   cutFreeCaptiveIdle: the captive at the end of the cut, still in the bound pose (BoundStandingCut, 109b6a); the
//     release follows cutFreeReleaseMs later, and the captive's client leaves the pose with OffsetStop on its own
//   tieIdle: the captor as the knot is tied (BoundStandingCutNPC again: no vanilla tying idle exists)
//
// gamemode-config.json "rope": { enabled, item, unattendedMeters, unattendedAfterSeconds, warnMinutes, slipMinutes,
//   cutFree, cutSeconds, cutReach, cutMoveUnits, cutFreeIdle, cutFreeStop, cutFreeCaptiveIdle, cutFreeReleaseMs, tieIdle,
//   tickMs }
'use strict';

module.exports = (api) => {
  const { mp, log, personal, audit, display, nameOf, cfg, onlineActors, every, sendPacket, distanceMeters } = api;

  const CFG = Object.assign({
    poseRefreshSeconds: 4,
    enabled: true,
    // CrownfallRope, "Rope" (DragonBreak.esp, in ccBGSSSE001-Fish.esm's id space)
    item: '90081a:ccBGSSSE001-Fish.esm',
    unattendedMeters: 10,
    unattendedAfterSeconds: 30,
    warnMinutes: 4,
    slipMinutes: 5,
    cutFree: true,
    cutSeconds: 5,
    // Game units: how close a rescuer must stand to start, and how far either may drift before the cut breaks
    cutReach: 250,
    cutMoveUnits: 64,
    cutFreeIdle: 'BoundStandingCutNPC',
    cutFreeStop: 'IdleForceDefaultState',
    cutFreeCaptiveIdle: 'BoundStandingCut',
    cutFreeReleaseMs: 2000,
    tieIdle: 'BoundStandingCutNPC',
    tickMs: 1000,
  }, cfg.rope || {});

  const RESTRAINED_PROP = 'private.restrained';
  const LAWFUL_PROP = 'private.dboLawful';
  const get = (id, prop, dflt) => { try { const v = mp.get(id, prop); return v === undefined || v === null ? dflt : v; } catch (e) { return dflt; } };
  const idOf = (desc) => { try { return mp.getIdFromDesc(desc) >>> 0; } catch (e) { return 0; } };
  const ROPE_ID = idOf(CFG.item);
  const nameFor = (viewer, a) => (typeof globalThis.__dboNameFor === 'function' ? globalThis.__dboNameFor(viewer, a) : nameOf(a));
  const isOnline = (a) => onlineActors().includes(a);
  const isDown = (a) => get(a, 'isDead', false) === true;
  const restraintOf = (a) => { const r = get(a, RESTRAINED_PROP, null); return r && (r.boundHands || r.carried) ? r : null; };
  const ropeCaptive = (a) => { const r = get(a, RESTRAINED_PROP, null); return r && r.boundHands && r.rope === true ? r : null; };
  const posOf = (a) => { const l = get(a, 'locationalData', null); return l && Array.isArray(l.pos) ? { cell: l.cellOrWorldDesc, pos: l.pos.slice(0, 3) } : null; };
  const units = (p, q) => (!p || !q || p.cell !== q.cell ? Infinity : Math.hypot(p.pos[0] - q.pos[0], p.pos[1] - q.pos[1], p.pos[2] - q.pos[2]));
  const banner = (a, text, seconds) => { try { sendPacket(a, { customPacketType: 'dboBanner', text, seconds }); } catch (e) { /* old client */ } };
  // Only while captureSystem ties with rope (it sets __dboRopeCapture at init): an older build would answer Tie Up with
  // "Only guards", so the gameplay half can go live before the fork half
  const ropeCapture = () => globalThis.__dboRopeCapture === true;
  const anim = (a, ev) => {
    if (!ev) return;
    try { mp.callPapyrusFunction('global', 'Debug', 'SendAnimationEvent', null, [{ type: 'form', desc: mp.getDescFromId(a) }, String(ev)]); } catch (e) { log(`rope: ${ev} failed for ${display(a)}: ${e.message}`); }
  };

  // ---- the rope itself ---------------------------------------------------------------------------------
  const ropeCount = (a) => {
    const inv = get(a, 'inventory', { entries: [] });
    return (Array.isArray(inv.entries) ? inv.entries : []).reduce((n, e) => ((Number(e.baseId) >>> 0) === ROPE_ID ? n + (Number(e.count) || 0) : n), 0);
  };
  const takeOne = (a) => {
    try {
      const inv = get(a, 'inventory', { entries: [] });
      const entries = (Array.isArray(inv.entries) ? inv.entries : []).map((e) => Object.assign({}, e));
      const hit = entries.find((e) => (Number(e.baseId) >>> 0) === ROPE_ID && (Number(e.count) || 0) > 0);
      if (!hit) return false;
      hit.count = (Number(hit.count) || 0) - 1;
      mp.set(a, 'inventory', { entries: entries.filter((e) => (Number(e.count) || 0) > 0) });
      return true;
    } catch (e) { log('rope: taking a rope failed', e.message); return false; }
  };

  // Per rope captive, kept across hot reloads (a restart ends every binding anyway):
  //   awaySince: when the captor was last seen going out of reach (0 while they are near)
  //   alone: unattended ms so far; lastTick; warned; unattended (past unattendedAfterSeconds)
  const clocks = globalThis.__dboRopeClocks || (globalThis.__dboRopeClocks = new Map());
  // rescuer actorId -> { t, until, from, fromT, releaseAt (set once the rope is cut through: the captive's animation plays) }
  const cuts = globalThis.__dboRopeCuts || (globalThis.__dboRopeCuts = new Map());

  // captureSystem asks these; null switches rope binding off (guards and admins only, as before)
  globalThis.__dboRopeHeld = CFG.enabled && ROPE_ID ? (a) => ropeCount(a >>> 0) > 0 : null;
  globalThis.__dboRopeTake = CFG.enabled && ROPE_ID ? (a, t) => {
    if (!takeOne(a >>> 0)) return false;
    // A fresh knot starts the unattended clock again
    if (t) clocks.delete(t >>> 0);
    anim(a >>> 0, CFG.tieIdle);
    log(`rope: ${display(a)} used a rope${t ? ` on ${display(t)}` : ''}`);
    return true;
  } : null;
  globalThis.__dboRopeUnattended = (a) => { const c = clocks.get(a >>> 0); return !!(c && c.unattended && ropeCaptive(a >>> 0)); };

  // ---- the unattended clock ---------------------------------------------------------------------------
  const tick = () => {
    const now = Date.now();
    for (const a of [...clocks.keys()]) if (!ropeCaptive(a)) clocks.delete(a);
    for (const a of onlineActors()) {
      const r = ropeCaptive(a);
      if (!r || isDown(a)) continue;
      const captor = Number(r.captorActorId) >>> 0;
      let c = clocks.get(a);
      if (!c) { c = { awaySince: 0, alone: 0, lastTick: now, warned: false, unattended: false }; clocks.set(a, c); }
      const step = Math.min(Math.max(0, now - c.lastTick), 5000);
      c.lastTick = now;
      const away = !captor || !isOnline(captor) || isDown(captor) || distanceMeters(a, captor) > Number(CFG.unattendedMeters);
      if (!away) {
        if (c.unattended) log(`rope: ${display(a)} attended again (${Math.round(c.alone / 1000)} s alone so far)`);
        c.awaySince = 0; c.unattended = false;
        continue;
      }
      if (!c.awaySince) c.awaySince = now;
      if (!c.unattended) {
        if (now - c.awaySince < Number(CFG.unattendedAfterSeconds) * 1000) continue;
        c.unattended = true;
        personal(a, 'Nobody is watching you. The knots are loosening: struggling is easier now, and left long enough the rope slips off.');
        log(`rope: ${display(a)} left unattended by ${display(captor)} (${Math.round(c.alone / 1000)} s alone so far)`);
        continue;
      }
      c.alone += step;
      if (!c.warned && c.alone >= Number(CFG.warnMinutes) * 60000) {
        c.warned = true;
        personal(a, 'The rope is nearly loose.');
      }
      if (c.alone >= Number(CFG.slipMinutes) * 60000) {
        clocks.delete(a);
        if (typeof globalThis.__dboBreakFree === 'function' && globalThis.__dboBreakFree(a, 'slip') === true) {
          personal(a, 'The knots slip loose. Your hands are free.');
          banner(a, 'Your hands are free', 4);
          audit(`ROPE ${display(a)} slipped out of ${display(captor)}'s rope after ${CFG.slipMinutes} min unattended`);
        } else {
          log(`rope: ${display(a)} should have slipped free but captureSystem refused`);
        }
      }
    }
  };

  // ---- Cut Free -----------------------------------------------------------------------------------
  const cutting = (t) => { for (const c of cuts.values()) if (c.t === (t >>> 0)) return true; return false; };
  const release = (a, c) => {
    const captor = Number((ropeCaptive(c.t) || {}).captorActorId) >>> 0;
    if (typeof globalThis.__dboBreakFree === 'function' && globalThis.__dboBreakFree(c.t, 'cut') === true) {
      clocks.delete(c.t);
      personal(a, `You cut ${nameFor(a, c.t)} free.`);
      personal(c.t, `${nameFor(c.t, a)} cuts you free.`);
      banner(c.t, 'Your hands are free', 4);
      audit(`ROPE ${display(a)} cut ${display(c.t)} free of ${captor ? display(captor) : 'nobody'}`);
    } else if (ropeCaptive(c.t)) {
      personal(a, 'The rope would not give.');
      log(`rope: ${display(a)} finished cutting ${display(c.t)} but captureSystem refused`);
    }
  };
  const startCut = (a, t) => {
    if (!CFG.enabled || !CFG.cutFree || !ropeCapture()) return personal(a, 'That cannot be done.');
    const r = ropeCaptive(t);
    if (!r) return personal(a, 'Only rope can be cut. A guard\'s shackles need the guard, or a jail.');
    if ((Number(r.captorActorId) >>> 0) === (a >>> 0)) return personal(a, 'Untie them instead.');
    if (restraintOf(a)) return personal(a, 'Not while you are restrained.');
    if (isDown(a) || isDown(t)) return personal(a, 'Not now.');
    if (cuts.has(a)) return personal(a, 'You are already cutting a rope.');
    if (cutting(t)) return personal(a, 'Someone is already cutting that rope.');
    const from = posOf(a), fromT = posOf(t);
    if (units(from, fromT) > Number(CFG.cutReach)) return personal(a, 'Get right next to them first.');
    const seconds = Math.max(1, Number(CFG.cutSeconds) || 5);
    cuts.set(a, { t: t >>> 0, until: Date.now() + seconds * 1000, from, fromT });
    anim(a, CFG.cutFreeIdle);
    banner(a, 'Cutting the rope...', Math.ceil(seconds));
    personal(a, `You start cutting ${nameFor(a, t)}'s rope. Hold still.`);
    personal(t, `${nameFor(t, a)} is cutting your rope. Hold still.`);
    log(`rope: ${display(a)} started cutting ${display(t)} free (${seconds} s)`);
    return true;
  };
  const cutBroken = (a, c) => {
    if (!isOnline(a)) return 'gone';
    if (!isOnline(c.t)) return 'they are gone';
    if (!ropeCaptive(c.t)) return 'the rope is off already';
    if (restraintOf(a)) return 'you were restrained';
    if (isDown(a)) return 'you fell';
    if (isDown(c.t)) return 'they fell';
    const move = Number(CFG.cutMoveUnits);
    if (units(c.from, posOf(a)) > move) return 'you moved';
    if (units(c.fromT, posOf(c.t)) > move) return 'they moved';
    return '';
  };
  const cutTick = () => {
    for (const [a, c] of [...cuts]) {
      // Cut through: the captive's own animation is playing, then the release, whatever either does meanwhile
      if (c.releaseAt) {
        if (Date.now() < c.releaseAt) continue;
        cuts.delete(a);
        release(a, c);
        continue;
      }
      const why = cutBroken(a, c);
      if (why) {
        cuts.delete(a);
        if (why !== 'gone') anim(a, CFG.cutFreeStop);
        if (why !== 'the rope is off already') {
          personal(a, `You stop cutting: ${why}.`);
          if (isOnline(c.t)) personal(c.t, 'The cutting stops.');
        }
        log(`rope: ${display(a)} stopped cutting ${display(c.t)}: ${why}`);
        continue;
      }
      if (Date.now() < c.until) continue;
      // Played from the bound pose, before the release (the captive's client sends OffsetStop when it is freed)
      const wait = CFG.cutFreeCaptiveIdle ? Math.max(0, Number(CFG.cutFreeReleaseMs) || 0) : 0;
      if (wait > 0) {
        anim(c.t, CFG.cutFreeCaptiveIdle);
        c.releaseAt = Date.now() + wait;
        continue;
      }
      cuts.delete(a);
      release(a, c);
    }
  };

  // ---- the X menu (playermenu.js) ---------------------------------------------------------------------
  globalThis.__dboRopeMenuEntries = (a, t) => {
    if (!CFG.enabled || !ropeCapture()) return [];
    a = a >>> 0; t = t >>> 0;
    if (restraintOf(a)) return [];
    const lawful = get(a, LAWFUL_PROP, false) === true;
    const r = get(t, RESTRAINED_PROP, null) || {};
    // A guard ties with shackles through Restrain (playermenu.js); anyone else needs a rope
    if (!r.boundHands) return !lawful && ROPE_ID && ropeCount(a) > 0 ? [{ id: 'capture', label: 'Tie Up' }] : [];
    if (r.rope !== true) return [];
    if ((Number(r.captorActorId) >>> 0) === a) {
      const out = [];
      // A guard already has Untie from playermenu.js; one id twice would draw two buttons
      if (!lawful) out.push({ id: 'release', label: 'Untie' });
      if (!r.carried) out.push(r.untethered ? { id: 'ropelead', label: 'Lead' } : { id: 'ropeleave', label: 'Leave Tied Here' });
      return out;
    }
    return CFG.cutFree && !lawful ? [{ id: 'ropecut', label: 'Cut Free' }] : [];
  };
  globalThis.__dboRopeMenuAction = (a, id, t) => {
    if (id !== 'ropeleave' && id !== 'ropelead' && id !== 'ropecut') return false;
    a = a >>> 0; t = t >>> 0;
    if (id === 'ropecut') { startCut(a, t); return true; }
    const r = ropeCaptive(t);
    if (!r || (Number(r.captorActorId) >>> 0) !== a) { personal(a, 'They are not yours to lead.'); return true; }
    const on = id === 'ropelead';
    if (typeof globalThis.__dboLeash !== 'function' || globalThis.__dboLeash(t, on) !== true) {
      personal(a, on ? 'You are leading them already.' : 'They are tied here already.');
      return true;
    }
    if (on) {
      personal(a, `You take ${nameFor(a, t)}'s rope in hand again.`);
      personal(t, `${nameFor(t, a)} takes your rope in hand again.`);
    } else {
      personal(a, `You leave ${nameFor(a, t)} tied up here.`);
      personal(t, `${nameFor(t, a)} leaves you tied up here.`);
    }
    log(`rope: ${display(a)} ${on ? 'leads' : 'left tied'} ${display(t)}`);
    return true;
  };

  // Bound hands stay bound (Nate, 6 Oct): the client (restraintService.ts) puts the captive pose back only after a jump
  // or a reload, so a hit, a load door, water or a seat left the hands free for the rest of the binding. Every
  // poseRefreshSeconds each bound captive who is not carried is sent the pose again on their own client (Papyrus
  // Debug.SendAnimationEvent, as downed.js does), shackles and rope alike. 0 turns it off. The event is captureSystem's
  // (server-settings captiveAnimEvent), read from the live settings, else the default.
  const POSE_EVENT = (() => { try { const s = JSON.parse(require('fs').readFileSync(require('path').resolve('server-settings.json'), 'utf8')); return typeof s.captiveAnimEvent === 'string' && s.captiveAnimEvent ? s.captiveAnimEvent : 'OffsetBoundStandingStart'; } catch (e) { return 'OffsetBoundStandingStart'; } })();
  const poseRefresh = () => {
    for (const a of onlineActors()) {
      let r = null; try { r = mp.get(a, 'private.restrained'); } catch (e) { continue; }
      if (!r || !r.boundHands || r.carried) continue;
      try { if (mp.get(a, 'isDead')) continue; } catch (e) { continue; }
      try { mp.callPapyrusFunction('global', 'Debug', 'SendAnimationEvent', null, [{ type: 'form', desc: mp.getDescFromId(a) }, POSE_EVENT]); } catch (e) { log(`rope: bound pose for ${display(a)} failed: ${e.message}`); }
    }
  };
  if (Number(CFG.poseRefreshSeconds) > 0) every('ropePose', Math.max(1000, Number(CFG.poseRefreshSeconds) * 1000), poseRefresh);
  every('ropeClock', Math.max(250, Number(CFG.tickMs) || 1000), tick);
  every('ropeCut', 250, cutTick);

  log(`rope ${CFG.enabled && ROPE_ID ? 'on' : 'off'}: ${CFG.item} (${ROPE_ID ? '0x' + ROPE_ID.toString(16) : 'not found'}), unattended past ${CFG.unattendedMeters} m for ${CFG.unattendedAfterSeconds} s, warns at ${CFG.warnMinutes} min, slips at ${CFG.slipMinutes} min alone, cut free ${CFG.cutFree ? `on (${CFG.cutSeconds} s)` : 'off'}`);
};
