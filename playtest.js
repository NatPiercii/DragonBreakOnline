// DragonBreak Online: region lock for a playtest (Bruma first). Loaded by gamemode.js on every hot reload.
//
// While `playtest.enabled` is on in gamemode-config.json:
//  - every hub gate sends the player to the playtest arrival spot instead of a Skyrim hold;
//  - load doors listed in `blockedDoors` (the border crossings) refuse with a message;
//  - a player who is anywhere outside the allowed places is sent back to the arrival spot. Allowed:
//    the hub worldspace, the worldspaces in `allowedWorlds`, and interior cells whose form comes from a
//    plugin in `allowedPlugins` (or is listed in `allowedCells`). The Skyrim landing point is allowed
//    for `graceSeconds` after connect, so character creation and the move into the hub still work.
//  - border doors refuse everyone; admins are never bounced (they can /tp anywhere to test).
//
// gamemode-config.json "playtest": { enabled, name, arrival: { world, pos, rotZ }, allowedWorlds: [desc],
//   allowedPlugins: [name], allowedCells: [desc], blockedDoors: [desc], graceSeconds, checkSeconds }
'use strict';

module.exports = (api) => {
  const { mp, log, personal, system, registerChatCommand, display, who, audit, onlineActors, isAdmin, sendPacket, cfg, hubDesc, connectedAt, every } = api;
  const C = Object.assign({ enabled: false, name: 'the playtest region', arrival: null, allowedWorlds: [], allowedPlugins: [], allowedCells: [], blockedDoors: [], graceSeconds: 60, checkSeconds: 5 }, cfg.playtest || {});

  const normDesc = (d) => { const s = String(d || ''); const i = s.indexOf(':'); if (i < 0) return s.toLowerCase(); const n = parseInt(s.slice(0, i), 16); return (Number.isFinite(n) ? n.toString(16) : s.slice(0, i).toLowerCase()) + ':' + s.slice(i + 1).toLowerCase(); };
  const idOf = (desc) => { try { return mp.getIdFromDesc(desc) >>> 0; } catch (e) { return 0; } };
  const allowedWorlds = new Set([hubDesc, ...C.allowedWorlds].map(normDesc));
  const allowedCells = new Set((C.allowedCells || []).map(normDesc));
  const allowedPlugins = new Set((C.allowedPlugins || []).map((p) => String(p).toLowerCase()));
  const blockedDoors = new Set((C.blockedDoors || []).map(idOf).filter(Boolean));
  // blockedDoors that are automatic load doors (walked into, not activated): refused ones send the player back
  const autoDoors = new Set((C.autoDoors || ['877c2:BSHeartland.esm']).map(idOf).filter(Boolean));
  const arrival = C.arrival && C.arrival.world && Array.isArray(C.arrival.pos) ? { cellOrWorldDesc: C.arrival.world, pos: C.arrival.pos, rot: [0, 0, Number(C.arrival.rotZ) || 0] } : null;
  const active = () => C.enabled && !!arrival;

  // The client blocks these doors itself: a server refusal stops the teleport, but the engine still opens
  // the door and loads the cell behind it, which is a long load into Skyrim and has hung the game.
  const doorRefs = active() ? [...blockedDoors] : [];
  const doorKey = JSON.stringify(doorRefs.slice().sort());
  if (globalThis.__dboPlaytestDoorKey !== doorKey) { globalThis.__dboPlaytestDoorKey = doorKey; globalThis.__dboPlaytestToldDoors = new Set(); }
  const toldDoors = globalThis.__dboPlaytestToldDoors = globalThis.__dboPlaytestToldDoors || new Set();
  const tellDoors = (a) => {
    if (toldDoors.has(a) || typeof sendPacket !== 'function') return;
    toldDoors.add(a);
    try { sendPacket(a, { customPacketType: 'dboBlockedDoors', refs: doorRefs }); } catch (e) { log('blocked doors packet failed', e.message); }
  };

  const placeOf = (a) => { try { return normDesc(mp.get(a, 'worldOrCellDesc')); } catch (e) { return ''; } };
  const isAllowedPlace = (desc) => {
    if (!desc) return true; // unknown: never bounce on a failed read
    if (allowedWorlds.has(desc) || allowedCells.has(desc)) return true;
    const plugin = desc.slice(desc.indexOf(':') + 1);
    return allowedPlugins.has(plugin);
  };
  const sendToArrival = (a, why) => {
    try { mp.set(a, 'locationalData', arrival); return true; } catch (e) { log('playtest move failed', e.message); return false; }
  };

  // Hub gates: gamemode.js asks before its own hold teleport. Returns true when it handled the gate.
  globalThis.__dboPlaytestGate = (casterId) => {
    if (!active()) return false;
    if (sendToArrival(casterId, 'gate')) system(casterId, `You step through the gate to ${C.name}.`);
    return true;
  };

  // Border doors: false blocks, null means not ours.
  const denyAt = new Map();
  globalThis.__dboPlaytestActivate = (targetId, casterId) => {
    if (!active() || !blockedDoors.has(targetId)) return null;
    if (Date.now() - (denyAt.get(casterId) || 0) > 1500) {
      denyAt.set(casterId, Date.now());
      // A refused automatic door (FNAM 0x02) leaves its half-started load open and the player frozen until a relog
      // (Serpents Trail, 7 Oct), so the player is taken back to the arrival point instead
      if (autoDoors.has(targetId)) {
        personal(casterId, `The road to Skyrim is closed for now. You find your way back to ${C.name}.`);
        setTimeout(() => { try { sendToArrival(casterId, 'border'); } catch (e) { log('playtest: border return failed', e.message); } }, 300);
      } else personal(casterId, `The road to Skyrim is closed for now. The alpha begins in ${C.name}.`);
    }
    return false;
  };

  // The border outline (Nate, 8 Oct: the plugin's border region alone let players walk out): border.points are cell
  // coordinates (1 cell = 4096 units) of CYRBrumaReleaseBorderRegion in border.world; outside it, a player is put back where
  // they last stood inside
  const B = C.border && Array.isArray(C.border.points) && C.border.points.length >= 3 ? C.border : null;
  const borderWorld = B ? normDesc(B.world) : '';
  const inPolygon = (x, y, P) => {
    let c = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const [x1, y1] = P[i], [x2, y2] = P[j];
      if ((y1 > y) !== (y2 > y) && x < (x2 - x1) * (y - y1) / (y2 - y1) + x1) c = !c;
    }
    return c;
  };
  const posOf = (a) => { try { const p = mp.get(a, 'pos'); return Array.isArray(p) ? p : null; } catch (e) { return null; } };
  const outsideBorder = (a, place) => {
    if (!B || place !== borderWorld) return false;
    const p = posOf(a);
    return !!p && !inPolygon(p[0] / 4096, p[1] / 4096, B.points);
  };
  const lastInside = new Map();
  // Only a spot at least border.marginCells inside counts: one on the line recrossed it on settling, and the player was
  // bounced again and again (Old Grimbo x6, 8 Oct)
  const MARGIN = Math.max(0, Number(B && B.marginCells) || 0.15);
  const edgeDistance = (x, y, P) => {
    let best = Infinity;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const [x1, y1] = P[j], [x2, y2] = P[i];
      const dx = x2 - x1, dy = y2 - y1, len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len)) : 0;
      best = Math.min(best, Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)));
    }
    return best;
  };
  const rememberInside = (a, place) => {
    if (!B || place !== borderWorld) return;
    try {
      const l = mp.get(a, 'locationalData');
      if (l && Array.isArray(l.pos) && edgeDistance(l.pos[0] / 4096, l.pos[1] / 4096, B.points) >= MARGIN) lastInside.set(a, l);
    } catch (e) { /* next tick */ }
  };

  // Anyone who ends up outside the region is brought back (after the connect grace).
  const bounced = new Map();
  const check = () => {
    for (const a of onlineActors()) tellDoors(a);
    if (!active()) return;
    const now = Date.now();
    for (const a of onlineActors()) {
      try {
        if (isAdmin(a)) continue;
        if (now - (connectedAt.get(a) || 0) < C.graceSeconds * 1000) continue;
        if (mp.get(a, 'private.creationPending') === true) continue;
        const place = placeOf(a);
        if (isAllowedPlace(place) && !outsideBorder(a, place)) { rememberInside(a, place); continue; }
        if (isAllowedPlace(place)) {
          if (now - (bounced.get(a) || 0) < 3000) continue;
          bounced.set(a, now);
          const back = lastInside.get(a);
          let moved = false;
          try { if (back) { mp.set(a, 'locationalData', back); moved = true; } } catch (e) { log('playtest border move failed', e.message); }
          if (!moved) moved = sendToArrival(a, 'border');
          if (moved) {
            system(a, `That is the edge of the alpha region: ${C.name} ends here for now. You have been brought back.`);
            audit(`PLAYTEST ${who(a)} crossed the ${C.name} border (${place}) and was returned ${back ? 'to where they last stood inside' : 'to the arrival spot'}`);
          }
          continue;
        }
        if (now - (bounced.get(a) || 0) < 10000) continue;
        bounced.set(a, now);
        if (sendToArrival(a, 'bounce')) {
          system(a, `Skyrim is closed for now: the alpha begins in ${C.name}. You have been brought back.`);
          audit(`PLAYTEST ${who(a)} was outside the region (${place}) and was returned to ${C.name}`);
        }
      } catch (e) { log('playtest check failed', e.message); }
    }
  };
  every('playtest', Math.max(2, Number(C.checkSeconds) || 5) * 1000, check);

  registerChatCommand('playtest', (a) => {
    if (!active()) return personal(a, 'No region lock is active; the whole world is open.');
    personal(a, `The alpha is in ${C.name}. Hub gates lead there, ${blockedDoors.size} border door(s) are closed, and anyone outside is brought back.${isAdmin(a) ? ' Admins are exempt. Config: gamemode-config.json "playtest".' : ''}`);
  }, { help: 'what part of the world is open' });

  log(`playtest lock ${active() ? 'ON' : 'off'}: ${C.name}, ${allowedWorlds.size} world(s), ${allowedPlugins.size} plugin(s) for interiors, ${blockedDoors.size} border door(s)${C.enabled && !arrival ? ' (enabled but no arrival spot set, so inactive)' : ''}`);
};
