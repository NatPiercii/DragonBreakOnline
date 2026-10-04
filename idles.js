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
  const { mp, log, sendPacket, cfg, hasCap } = api;
  const DEFAULTS = {
    // Reading the board: the hand-on-chin gesture (Dawnguard.esm, proven on the emote wheel)
    board: { anim: 'IdleDialogueHandOnChinGesture', seconds: 4, endsItself: true },
    // Introducing yourself: the salute (proven on the emote wheel; Nate to confirm it reads as a fist to the chest)
    introduce: { anim: 'IdleSalute', seconds: 3, endsItself: true },
    // A guard's cuffs (captureSystem -> struggle.js __dboOnRestrained, on the captor): Helgen's bind-cutting motion
    // (MQ101, hands working at the other's wrists), the same one rope.js uses for tying; there is no vanilla cuffing
    // idle. Unproven until the console check (row 14); IdleLockPick is the fallback
    cuff: { anim: 'BoundStandingCutNPC', seconds: 3, endsItself: true },
    // The Character Journal on F3 (journal.js): the wheel's Read Book, IdleBook_TurnManyPages' event; held until the
    // journal's dboIdleStop by a client that knows hold (client-journal-client), 10 s by an older one
    journal: { anim: 'IdleBook_PageTurn', seconds: 10, endsItself: false, hold: true },
    // Skinning a kill (Nate, 4 Oct: the character works while the panel is open): the warm-hands crouch, proven on the
    // emote wheel and the chest hold's crouch; held until gamemode.js sends dboIdleStop when the attempt ends. Mining
    // and chopping have no proven standalone idle (their swings come from furniture markers), so they play none
    skin: { anim: 'IdleWarmHandsCrouched', seconds: 10, endsItself: false, hold: true },
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
      sendPacket(id, Object.assign({ customPacketType: 'dboIdle', anim: def.anim, seconds: Number(def.seconds) || 3, endsItself: def.endsItself !== false }, def.hold === true ? { hold: true } : {}));
      return true;
    } catch (e) { log(`interaction idle ${key} failed for ${id.toString(16)}: ${e.message}`); return false; }
  };
  globalThis.__dboInteractionIdle = play;
  // A copy of one interaction's definition (journal.js names its idle in the stop it sends)
  globalThis.__dboInteractionIdleDef = (key) => (IDLES[key] ? Object.assign({}, IDLES[key]) : null);

  // ---- the chest hold (Nate 2026-09-30: about a second is fine) ------------------------------------------------------
  // The last gate of gamemode.js's activate chain, so every other gate (dungeon and camp chests, treasuries, raids...)
  // has had its say first. A plain container is not opened at once: the player crouches over it (chestHold.anim), and
  // holdMs later the server activates it for them (Papyrus ObjectReference.Activate: MpObjectReference::Activate checks
  // their reach and cell, re-runs this chain and sends OpenContainer, which the client opens exactly as its own). That
  // re-entry carries a one-shot pass. A player who walked more than moveUnits away, changed cell or left in the
  // meantime gets nothing. Only for a client that plays the idle (uiCaps 'dboIdle'); an older one opens at once.
  // Off by default until one live check (the menu opens promptly): gamemode-config "interactionIdles": { "chestHold":
  // { "enabled": true } }.
  const H = Object.assign({ enabled: false, holdMs: 1000, passMs: 3000, moveUnits: 150, anim: 'IdleWarmHandsCrouched', seconds: 2 }, C.chestHold || {});
  const passes = globalThis.__dboChestPasses instanceof Map ? globalThis.__dboChestPasses : (globalThis.__dboChestPasses = new Map()); // 'caster:target' -> until
  const holding = globalThis.__dboChestHolding instanceof Map ? globalThis.__dboChestHolding : (globalThis.__dboChestHolding = new Map()); // caster -> target
  const kinds = new Map(); // base id -> is a CONT
  const isContainer = (target) => {
    let baseId = 0;
    try { baseId = mp.getIdFromDesc(String(mp.get(target, 'baseDesc'))) >>> 0; } catch (e) { return false; }
    if (!baseId) return false;
    if (!kinds.has(baseId)) { let t = ''; try { const r = mp.lookupEspmRecordById(baseId); t = String(r && r.record && r.record.type || ''); } catch (e) { /* unknown */ } kinds.set(baseId, t === 'CONT'); }
    return kinds.get(baseId);
  };
  const where = (a) => { try { const l = mp.get(a, 'locationalData'); return l && Array.isArray(l.pos) ? { cell: String(l.cellOrWorldDesc), pos: l.pos } : null; } catch (e) { return null; } };
  const online = (a) => { try { return (mp.get(0, 'onlinePlayers') || []).map((x) => Number(x) >>> 0).includes(a); } catch (e) { return false; } };
  // true: the hold took this activation (the chain denies it); false: let it through
  // WARNING for any gate earlier in the chain: the first E on a held chest is denied HERE, after every earlier gate has
  // already run, and the real open is a second pass through the whole chain a moment later. A gate that spends a one-shot
  // token and lets the activation through (a pass, a nonce, "use it again to open it") spends it on the denied first E
  // and finds nothing on the re-entry. Keep such a token until it expires instead (business.js's rented-chest pass does,
  // since Worker A's review). Checked 2026-09-30: salvage.js spends its pass the same way, but only for furniture
  // stations, which are never held; dungeons.js returns true for its chests and short-circuits before this gate. The
  // fork's own gates (__dboPrevActivate: housing, mastery) run after this one, so a chest they refuse shows the crouch
  // before the refusal.
  const chestHold = (targetId, casterId) => {
    if (H.enabled !== true || C.enabled === false) return false;
    const target = Number(targetId) >>> 0, caster = Number(casterId) >>> 0;
    const key = `${caster}:${target}`;
    const pass = passes.get(key);
    if (pass !== undefined) { passes.delete(key); if (pass > Date.now()) return false; }
    if (!caster || !target || !(typeof hasCap === 'function' && hasCap(caster, 'dboIdle'))) return false;
    if (!isContainer(target)) return false;
    let open = false; try { open = mp.get(target, 'isOpen') === true; } catch (e) { /* not a ref */ }
    if (open) return false; // someone has it open: the server answers that as it always has
    if (holding.has(caster)) return true; // a second E while crouching: the one open is coming
    const from = where(caster);
    if (!from) return false;
    holding.set(caster, target);
    try { sendPacket(caster, { customPacketType: 'dboIdle', anim: H.anim, seconds: Number(H.seconds) || 2, endsItself: false }); } catch (e) { /* the open still follows */ }
    setTimeout(() => {
      holding.delete(caster);
      const now = where(caster);
      if (!online(caster) || !now || now.cell !== from.cell || Math.hypot(now.pos[0] - from.pos[0], now.pos[1] - from.pos[1], now.pos[2] - from.pos[2]) > Number(H.moveUnits)) return;
      const at = Date.now();
      for (const [k, until] of passes) if (until <= at) passes.delete(k);
      passes.set(key, at + Number(H.passMs));
      try {
        mp.callPapyrusFunction('method', 'ObjectReference', 'Activate', { type: 'form', desc: mp.getDescFromId(target) }, [{ type: 'form', desc: mp.getDescFromId(caster) }, false]);
      } catch (e) {
        passes.delete(key);
        log(`chest hold: opening ${target.toString(16)} for ${caster.toString(16)} failed: ${e.message}`);
      }
    }, Math.max(0, Number(H.holdMs) || 0));
    return true;
  };
  globalThis.__dboChestHold = chestHold;
  return { play, IDLES, chestHold, H };
};
