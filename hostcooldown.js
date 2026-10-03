// DragonBreak Online: an NPC stays with its client host for a few seconds after it changes hands or fights.
// Moving a fighting NPC between two live hosts, or back and forth, left a copy being driven by two clients at once
// (crash map 1-3 Oct: crash-wave ANALYSIS.md section 7, server half). Pure: gamemode.js hostAttemptHook and
// npcdirector.js ask it, and the harness drives it with its own clock.
// A hand-over is held back only while the current host can still drive the NPC (online, same world, in reach, by the
// caller's own host policy); an NPC without a host, or whose host left or is out of reach, is never held.
// Config "hostCooldown": { enabled, handoverMs, fightMs }.
'use strict';

// state: kept by the caller across a hot reload ({ handedAt, foughtAt })
module.exports = (cfg, now = () => Date.now(), state = {}) => {
  const C = Object.assign({ enabled: true, handoverMs: 5000, fightMs: 5000 }, cfg || {});
  const S = state;
  if (!(S.handedAt instanceof Map)) S.handedAt = new Map();
  if (!(S.foughtAt instanceof Map)) S.foughtAt = new Map();
  const prune = (m, ms) => { if (m.size > 4096) { const t = now(); for (const [k, v] of m) if (t - v > ms) m.delete(k); } };
  return {
    config: C,
    noteHandover: (npc) => { S.handedAt.set(npc >>> 0, now()); prune(S.handedAt, C.handoverMs); },
    noteFight: (npc) => { S.foughtAt.set(npc >>> 0, now()); prune(S.foughtAt, C.fightMs); },
    // null when the hand-over may go ahead, else the reason it waits
    //   current: the NPC's host now (0 = none); requester: who would take it; hostCanDrive: current is online and in reach
    holds: (npc, requester, current, hostCanDrive) => {
      if (!C.enabled) return null;
      current = current >>> 0; requester = requester >>> 0; npc = npc >>> 0;
      if (!current || current === requester || !hostCanDrive) return null;
      const t = now();
      if (t - (S.handedAt.get(npc) || -Infinity) < C.handoverMs) return 'changed hands';
      if (t - (S.foughtAt.get(npc) || -Infinity) < C.fightMs) return 'in a fight';
      return null;
    },
  };
};
