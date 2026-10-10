// DragonBreak Online: the NPC director, phase 2 of NPC system v2 (server NPC_SYSTEM_V2.md). Loaded by gamemode.js.
//
// The server chooses which client drives each NPC. Clients from 0.3.40 send a sight report once a second
// (fork skymp5-client npcSightService: dbo npcSight [[remoteIdHex, distance], ...], nearest first). From the fresh
// reports the director gives each NPC to the nearest player who has it loaded, through mp.setHoster
// (PartOne::AssignHoster). The current hoster keeps it while it still has it loaded and nobody is clearly nearer
// (HOLD_FACTOR x + HOLD_UNITS), so hosts do not flap; an NPC changes host at most once per CHANGE_EVERY_MS. A client
// that reports is refused when it asks to host by itself (the director decides for it); an older client that does
// not report keeps the old ask-to-host behaviour, and an NPC it hosts is left with it.
//
// A report only says "I have it loaded": every candidate must pass the gamemode's own host policy (online, same world,
// not bound, SERVER-measured distance within reach; globalThis.__dboHostPolicy), and candidates are ranked by that
// server distance, so a modified client cannot claim NPCs from afar (review 2026-09-25). Without mp.setHoster (an
// older build) the director does nothing and refuses nothing.
//
// Left alone: companions and summons (companionSystem gives them to their owner), dead NPCs, player characters. A GM's
// unleashed warband raider is the exception: it is driven by the player nearest it other than its GM (warband.js
// __dboWarbandAvoidHost). While its GM is the only one near it, a GM who drives it keeps it and is not given it anew.
// Config "npcDirector": { mode: "on" | "shadow" | "off" }. shadow logs the decisions without applying them.

module.exports = (api) => {
  const { mp, log, every, onUi, onlineActors, display, profileOf, cfg } = api;
  // releaseDead / releaseUnits: a host gives up a dead NPC, or one farther than releaseUnits from it (0 keeps it). A player's
  // game kept hosting dungeon dead and far-off enemies, which it then fought the server over (Red Ruby, 9 Oct /bug)
  const C = Object.assign({ mode: 'on', freshMs: 3000, holdFactor: 1.5, holdUnits: 512, changeEveryMs: 3000, logEveryMs: 60000,
    releaseDead: true, releaseUnits: 4000 },
    cfg.npcDirector || {});
  // sight: player actorId -> { at, dist: Map<npcId, distance> }; changedAt: npcId -> ms; told: rate-limited logs
  const S = globalThis.__dboNpcDirector || (globalThis.__dboNpcDirector = { sight: new Map(), changedAt: new Map(), told: new Map() });

  const fresh = (p, now) => { const s = S.sight.get(p); return s && now - s.at <= C.freshMs ? s : null; };
  const reports = (p) => !!fresh(p, Date.now());
  const reported = (p, npc) => { const s = fresh(p, Date.now()); return !!s && s.dist.has(npc >>> 0); };
  const built = () => typeof mp.setHoster === 'function' && typeof mp.getHoster === 'function';
  // The server's verdict on player p driving npc: { ok, dist } from gamemode.js's host policy
  const policy = (p, npc) => {
    try { return typeof globalThis.__dboHostPolicy === 'function' ? globalThis.__dboHostPolicy(p, npc) : { ok: false }; } catch (e) { return { ok: false }; }
  };

  onUi('npcSight', (a, args) => {
    const list = Array.isArray(args[0]) ? args[0] : [];
    const dist = new Map();
    for (const e of list.slice(0, 96)) {
      if (!Array.isArray(e)) continue;
      const id = parseInt(String(e[0]), 16) >>> 0;
      const d = Number(e[1]);
      if (id && Number.isFinite(d) && d >= 0) dist.set(id, d);
    }
    S.sight.set(a >>> 0, { at: Date.now(), dist });
  });

  // warband.js: the GM who unleashed this raider, never chosen to drive it while anyone else near it can; 0 for any other NPC
  const avoidOf = (npc) => { try { return typeof globalThis.__dboWarbandAvoidHost === 'function' ? Number(globalThis.__dboWarbandAvoidHost(npc)) >>> 0 : 0; } catch (e) { return 0; } };

  const managed = (npc) => {
    try {
      // A form the server destroyed that a client still reports (gamemode.js formExists): the director steps aside,
      // so a client asking to host the same id, handed on to a new NPC, is not refused by it
      if (typeof globalThis.__dboFormExists === 'function' && !globalThis.__dboFormExists(npc)) return false;
      if (profileOf(npc) >= 0) return false;
      if (mp.get(npc, 'isDead') === true) return false;
      const owner = mp.get(npc, 'ff_companionOf');
      if (owner && Number(owner) !== 0) return false;
      // An unleashed warband raider is the one tagged NPC driven from here, so it goes to a player other than its GM
      if (mp.get(npc, 'private.dboCompanion')) return !!avoidOf(npc);
      return true;
    } catch (e) { return false; }
  };

  const say = (key, text, now) => {
    if (now - (S.told.get(key) || 0) < C.logEveryMs) return;
    S.told.set(key, now);
    log(`npcDirector ${text}`);
  };

  const isDead = (npc) => { try { return mp.get(npc, 'isDead') === true; } catch (e) { return false; } };
  // Server distance from a player to an NPC, Infinity when they are in different worlds or cells
  const apart = (p, npc) => {
    try {
      if (String(mp.get(p, 'worldOrCellDesc')) !== String(mp.get(npc, 'worldOrCellDesc'))) return Infinity;
      const a = mp.get(p, 'pos'), b = mp.get(npc, 'pos');
      return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    } catch (e) { return 0; }
  };
  // A host's dead or far-off NPCs (from its own sight report) go back to nobody; a fight or a fresh hand-over keeps them
  const release = (now, out) => {
    if (!C.releaseDead && !(C.releaseUnits > 0)) return;
    const hc = globalThis.__dboHostCooldown;
    for (const [p, s] of S.sight) {
      if (now - s.at > C.freshMs) continue;
      for (const npc of s.dist.keys()) {
        if (typeof globalThis.__dboFormExists === 'function' && !globalThis.__dboFormExists(npc)) continue;
        if (now - (S.changedAt.get(npc) || 0) < C.changeEveryMs) continue;
        let host = 0; try { host = mp.getHoster(npc) >>> 0; } catch (e) { continue; }
        if (host !== p) continue;
        const dead = C.releaseDead && isDead(npc);
        if (!dead && !(C.releaseUnits > 0 && apart(p, npc) > C.releaseUnits)) continue;
        if (!dead && !managed(npc)) continue;                  // companions, summons and raiders keep their own rules
        if (!dead && hc && hc.holds(p, npc)) continue;
        out.push({ npc, from: p, to: 0, why: dead ? 'dead' : 'far' });
        if (C.mode !== 'on') continue;
        try { mp.setHoster(npc, 0); S.changedAt.set(npc, now); }
        catch (e) { say('rel:' + npc, `could not release ${npc.toString(16)} from ${display(p)}: ${e.message}`, now); }
      }
    }
  };

  // One decision pass; returns the assignments made (or that shadow mode would make)
  const decide = (now) => {
    const out = [];
    if (C.mode === 'off' || !built()) return out;
    release(now, out);
    const online = new Set(onlineActors().map((x) => x >>> 0));
    for (const p of S.sight.keys()) if (!online.has(p)) S.sight.delete(p);
    // NPC -> [[player, SERVER distance]] for every fresh report the host policy accepts
    const seenBy = new Map();
    for (const [p, s] of S.sight) {
      if (now - s.at > C.freshMs) continue;
      for (const npc of s.dist.keys()) {
        // A form the server destroyed that this client still reports: skipped without reading it (gamemode.js formExists)
        if (typeof globalThis.__dboFormExists === 'function' && !globalThis.__dboFormExists(npc)) continue;
        const v = policy(p, npc);
        if (!v.ok) continue;
        let l = seenBy.get(npc); if (!l) seenBy.set(npc, l = []); l.push([p, Number(v.dist) || 0]);
      }
    }
    for (const [npc, seen] of seenBy) {
      if (now - (S.changedAt.get(npc) || 0) < C.changeEveryMs) continue;
      if (!managed(npc)) continue;
      const avoid = avoidOf(npc);
      const seers = avoid ? seen.filter(([p]) => p !== avoid) : seen;
      if (!seers.length) continue;
      let current = 0; try { current = mp.getHoster(npc) >>> 0; } catch (e) { continue; }
      seers.sort((x, y) => x[1] - y[1]);
      const [best, bestD] = seers[0];
      if (current === best) continue;
      // The raider's own GM gives it up to anyone near it, however near the GM is
      if (current && online.has(current) && current !== avoid) {
        if (!reports(current)) continue;                       // an older client keeps what it hosts
        const mine = seers.find(([p]) => p === current);
        if (mine && mine[1] <= bestD * C.holdFactor + C.holdUnits) continue;   // still has it, nobody clearly nearer
      }
      // A live host keeps an NPC that just changed hands or is fighting (gamemode.js hostcooldown)
      const hc = globalThis.__dboHostCooldown;
      if (hc && hc.holds(best, npc)) continue;
      out.push({ npc, from: current, to: best, dist: bestD });
      if (C.mode === 'on') {
        try { mp.setHoster(npc, best); S.changedAt.set(npc, now); if (hc) hc.noteHandover(npc); }
        catch (e) { say('err:' + npc, `could not give ${npc.toString(16)} to ${display(best)}: ${e.message}`, now); }
      } else {
        S.changedAt.set(npc, now);
        say('shadow:' + npc, `(shadow) would give ${npc.toString(16)} to ${display(best)} at ${Math.round(bestD)} (now ${current ? current.toString(16) : 'nobody'})`, now);
      }
    }
    for (const [npc, at] of S.changedAt) if (now - at > 60000) S.changedAt.delete(npc);
    return out;
  };

  every('npcDirector', 1000, () => { try { decide(Date.now()); } catch (e) { log('npcDirector: pass failed', e.message); } });

  // gamemode.js hostAttemptHook asks this first: a reporting client does not pick its own NPCs, the director does.
  // Companions are exempt (their owner hosts them through companionSystem).
  // Only NPCs the requester itself reported, that the director manages, and only when it can assign them
  // A dead NPC is hosted by nobody once released, so a request to drive one is refused too
  globalThis.__dboNpcDirectorRefuses = (requester, npc) => C.mode === 'on' && built() && reported(requester >>> 0, npc)
    && (managed(npc >>> 0) || (C.releaseDead && isDead(npc >>> 0)));

  if (C.mode !== 'off' && !built()) log('npcDirector: mp.setHoster missing, director inactive (the server build predates it); clients keep asking to host');
  else log(`npcDirector ${C.mode}: hosts chosen from sight reports (fresh ${C.freshMs} ms, hold x${C.holdFactor} + ${C.holdUnits})`);
  return { decide };
};
