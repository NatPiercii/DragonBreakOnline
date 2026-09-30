'use strict';
// Interaction animations (swag's spec, Nate 2026-09-30): an interaction plays a fitting vanilla idle on the player who
// makes it. The client plays it (client 0.3.72, EmoteService dboIdle): only idles on its allowlist, not with a weapon
// drawn, seated, swimming, mounted, restrained or under a game menu, and movement ends it. Other players see it through
// the ordinary animation sync. An older client ignores the packet, so this is safe before 0.3.72 is out.
//
// Every idle is an IDLE record in Skyrim.esm or Dawnguard.esm; which ones the player's graph plays is checked by hand
// (docs/alpha/anim-console-check.md). gamemode-config.json "interactionIdles":
//   { "enabled": true, "idles": { "<interaction>": { "anim": "<event>", "seconds": 4, "endsItself": true } | null } }
// null (or enabled false) turns one off. Potions and draughts never animate (the client's own rule).
//
// The hooks: gamemode.js __dboBoardOpened (a notice board opens), playermenu.js introduce (after it succeeds),
// struggle.js __dboOnRestrained (a guard's cuffs go on), and globalThis.__dboInteractionIdle(actorId, key) for any other
// module. Rope plays its own (rope.js, Worker A).
module.exports = (api) => {
  const { log, sendPacket, cfg } = api;
  const DEFAULTS = {
    // Reading the board: the hand-on-chin gesture (Dawnguard.esm, proven on the emote wheel)
    board: { anim: 'IdleDialogueHandOnChinGesture', seconds: 4, endsItself: true },
    // Introducing yourself: the salute (proven on the emote wheel; Nate to confirm it reads as a fist to the chest)
    introduce: { anim: 'IdleSalute', seconds: 3, endsItself: true },
    // A guard's cuffs (captureSystem -> struggle.js __dboOnRestrained, on the captor): Helgen's bind-cutting motion
    // (MQ101, hands working at the other's wrists), the same one rope.js uses for tying; there is no vanilla cuffing
    // idle. Unproven until the console check (row 14); IdleLockPick is the fallback
    cuff: { anim: 'BoundStandingCutNPC', seconds: 3, endsItself: true },
  };
  const C = Object.assign({ enabled: true }, (cfg && cfg.interactionIdles) || {});
  const IDLES = Object.assign({}, DEFAULTS, C.idles || {});
  const last = globalThis.__dboInteractionIdleAt instanceof Map ? globalThis.__dboInteractionIdleAt : (globalThis.__dboInteractionIdleAt = new Map());
  // One idle per player per 2 s: a double click or a board reopened at once does not restart the clip
  const REPEAT_MS = 2000;

  // Plays the idle for one interaction on one player; true when the packet went out
  const play = (a, key) => {
    if (C.enabled === false) return false;
    const def = IDLES[key];
    if (!def || typeof def.anim !== 'string' || !def.anim) return false;
    const id = Number(a) >>> 0;
    if (!id) return false;
    const now = Date.now();
    if (now - (last.get(id) || 0) < REPEAT_MS) return false;
    last.set(id, now);
    if (last.size > 2000) for (const [k, at] of last) if (now - at > REPEAT_MS) last.delete(k);
    try {
      sendPacket(id, { customPacketType: 'dboIdle', anim: def.anim, seconds: Number(def.seconds) || 3, endsItself: def.endsItself !== false });
      return true;
    } catch (e) { log(`interaction idle ${key} failed for ${id.toString(16)}: ${e.message}`); return false; }
  };
  globalThis.__dboInteractionIdle = play;
  return { play, IDLES };
};
