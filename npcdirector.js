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
// Left alone: companions and summons (companionSystem gives them to their owner), dead NPCs, player characters.
// Config "npcDirector": { mode: "on" | "shadow" | "off" }. shadow logs the decisions without applying them.

module.exports = (api) => {
  const { mp, log, every, onUi, onlineActors, display, profileOf, cfg } = api;
  const C = Object.assign({ mode: 'on', freshMs: 3000, holdFactor: 1.5, holdUnits: 512, changeEveryMs: 3000, logEveryMs: 60000 },
    cfg.npcDirector || {});
  // sight: player actorId -> { at, dist: Map<npcId, distance> }; changedAt: npcId -> ms; told: rate-limited logs
  const S = globalThis.__dboNpcDirector || (globalThis.__dboNpcDirector = { sight: new Map(), changedAt: new Map(), told: new Map() });

  const fresh = (p, now) => { const s = S.sight.get(p); return s && now - s.at <= C.freshMs ? s : null; };
  const reports = (p) => !!fresh(p, Date.now());

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

  const managed = (npc) => {
    try {
      if (profileOf(npc) >= 0) return false;
      if (mp.get(npc, 'isDead') === true) return false;
      const owner = mp.get(npc, 'ff_companionOf');
      if (owner && Number(owner) !== 0) return false;
      if (mp.get(npc, 'private.dboCompanion')) return false;
      return true;
    } catch (e) { return false; }
  };

  const say = (key, text, now) => {
    if (now - (S.told.get(key) || 0) < C.logEveryMs) return;
    S.told.set(key, now);
    log(`npcDirector ${text}`);
  };

  // One decision pass; returns the assignments made (or that shadow mode would make)
  const decide = (now) => {
    const out = [];
    if (C.mode === 'off') return out;
    const online = new Set(onlineActors().map((x) => x >>> 0));
    for (const p of S.sight.keys()) if (!online.has(p)) S.sight.delete(p);
    // NPC -> [[player, distance]] from every fresh report
    const seenBy = new Map();
    for (const [p, s] of S.sight) {
      if (now - s.at > C.freshMs) continue;
      for (const [npc, d] of s.dist) { let l = seenBy.get(npc); if (!l) seenBy.set(npc, l = []); l.push([p, d]); }
    }
    for (const [npc, seers] of seenBy) {
      if (now - (S.changedAt.get(npc) || 0) < C.changeEveryMs) continue;
      if (!managed(npc)) continue;
      let current = 0; try { current = mp.getHoster(npc) >>> 0; } catch (e) { continue; }
      seers.sort((x, y) => x[1] - y[1]);
      const [best, bestD] = seers[0];
      if (current === best) continue;
      if (current && online.has(current)) {
        if (!reports(current)) continue;                       // an older client keeps what it hosts
        const mine = seers.find(([p]) => p === current);
        if (mine && mine[1] <= bestD * C.holdFactor + C.holdUnits) continue;   // still has it, nobody clearly nearer
      }
      out.push({ npc, from: current, to: best, dist: bestD });
      if (C.mode === 'on') {
        try { mp.setHoster(npc, best); S.changedAt.set(npc, now); }
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
  globalThis.__dboNpcDirectorRefuses = (requester, npc) => C.mode === 'on' && reports(requester >>> 0) && managed(npc >>> 0);

  log(`npcDirector ${C.mode}: hosts chosen from sight reports (fresh ${C.freshMs} ms, hold x${C.holdFactor} + ${C.holdUnits})`);
  return { decide };
};
