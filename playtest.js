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
  const { mp, log, personal, system, registerChatCommand, display, who, audit, onlineActors, isAdmin, sendPacket, cfg, hubDesc, connectedAt } = api;
  const C = Object.assign({ enabled: false, name: 'the playtest region', arrival: null, allowedWorlds: [], allowedPlugins: [], allowedCells: [], blockedDoors: [], graceSeconds: 60, checkSeconds: 5 }, cfg.playtest || {});

  const normDesc = (d) => { const s = String(d || ''); const i = s.indexOf(':'); if (i < 0) return s.toLowerCase(); const n = parseInt(s.slice(0, i), 16); return (Number.isFinite(n) ? n.toString(16) : s.slice(0, i).toLowerCase()) + ':' + s.slice(i + 1).toLowerCase(); };
  const idOf = (desc) => { try { return mp.getIdFromDesc(desc) >>> 0; } catch (e) { return 0; } };
  const allowedWorlds = new Set([hubDesc, ...C.allowedWorlds].map(normDesc));
  const allowedCells = new Set((C.allowedCells || []).map(normDesc));
  const allowedPlugins = new Set((C.allowedPlugins || []).map((p) => String(p).toLowerCase()));
  const blockedDoors = new Set((C.blockedDoors || []).map(idOf).filter(Boolean));
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
    if (Date.now() - (denyAt.get(casterId) || 0) > 1500) { denyAt.set(casterId, Date.now()); personal(casterId, `The road to Skyrim is closed for now. The playtest stays in ${C.name}.`); }
    return false;
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
        if (isAllowedPlace(place)) continue;
        if (now - (bounced.get(a) || 0) < 10000) continue;
        bounced.set(a, now);
        if (sendToArrival(a, 'bounce')) {
          system(a, `Skyrim is closed while we playtest ${C.name}. You have been brought back.`);
          audit(`PLAYTEST ${who(a)} was outside the region (${place}) and was returned to ${C.name}`);
        }
      } catch (e) { log('playtest check failed', e.message); }
    }
  };
  if (globalThis.__dboPlaytestTimer) clearInterval(globalThis.__dboPlaytestTimer);
  globalThis.__dboPlaytestTimer = setInterval(check, Math.max(2, Number(C.checkSeconds) || 5) * 1000);

  registerChatCommand('playtest', (a) => {
    if (!active()) return personal(a, 'No region lock is active; the whole world is open.');
    personal(a, `Playtest lock: ${C.name}. Hub gates lead there, ${blockedDoors.size} border door(s) are closed, and anyone outside is brought back.${isAdmin(a) ? ' Admins are exempt. Config: gamemode-config.json "playtest".' : ''}`);
  }, { help: 'what part of the world is open' });

  log(`playtest lock ${active() ? 'ON' : 'off'}: ${C.name}, ${allowedWorlds.size} world(s), ${allowedPlugins.size} plugin(s) for interiors, ${blockedDoors.size} border door(s)${C.enabled && !arrival ? ' (enabled but no arrival spot set, so inactive)' : ''}`);
};
