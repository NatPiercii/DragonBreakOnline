// DragonBreak Online: wildlife and giant camps. Loaded by gamemode.js on every hot reload.
//
// wildlife.json (ck-mcp/wildlife.py) lists every vanilla creature placement outdoors with a
// server-loadable anchor ref. This writes them once as permanent wild:* zones for Alduinak's
// NpcSpawnSystem: the animal appears on its own spot when a player comes within `radius` and
// goes away again when nobody has been near for `despawnSeconds`; a killed one returns after
// `respawnSeconds`. Giants and mammoths are placements like any other, so the camps fill on
// approach. Giant camp chests are open-dungeon loot nodes: using one hands the player a roll of
// loot straight into the pack (the container never opens), once per player per chest per hour.
//
// gamemode-config.json "wildlife": { enabled, radius, despawnSeconds, respawnSeconds, pick,
//   maxZones, campLootMinutes, safeZones: [{ world, pos, radius, pick }] }
// A spot inside a safe zone uses that zone's pick (e.g. "low" near where new players arrive).
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, system, registerChatCommand, giveItem, profileOf, display, who, audit, isAdmin, cfg } = api;
  const C = Object.assign({ enabled: true, radius: 6000, despawnSeconds: 240, respawnSeconds: 1800, pick: 'mid', maxZones: 4000, campLootMinutes: 60, safeZones: [] }, cfg.wildlife || {});
  const SPAWNS_FILE = path.resolve('NPC-Spawns.json');
  const PREFIX = 'wild:';
  const GOLD_BASE = 0x0000000f;
  const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); } catch (e) { return fallback; } };
  const DATA = readJson('wildlife.json', { placements: [], giantCamps: [] });
  const LOOT = (readJson('loot.json', { pools: {} }).pools) || {};
  const idOf = (desc) => { try { return mp.getIdFromDesc(desc) >>> 0; } catch (e) { return 0; } };
  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const pickFrom = (list) => list.length ? list[Math.floor(Math.random() * list.length)] : null;
  const normWorld = (d) => { const s = String(d || ''); const i = s.indexOf(':'); if (i < 0) return s.toLowerCase(); const n = parseInt(s.slice(0, i), 16); return (Number.isFinite(n) ? n.toString(16) : s.slice(0, i).toLowerCase()) + ':' + s.slice(i + 1).toLowerCase(); };
  const SAFE = (Array.isArray(C.safeZones) ? C.safeZones : []).filter((z) => z && z.world && Array.isArray(z.pos) && Number(z.radius) > 0);
  const pickFor = (pl) => {
    const zone = SAFE.find((z) => normWorld(z.world) === normWorld(pl.world) && Math.hypot(pl.pos[0] - z.pos[0], pl.pos[1] - z.pos[1]) <= Number(z.radius));
    return zone && zone.pick ? zone.pick : C.pick;
  };
  const pickOption = (options, pick) => {
    const sorted = (options || []).slice().sort((x, y) => x[0] - y[0]);
    if (!sorted.length) return null;
    if (pick === 'low') return sorted[0][1];
    if (pick === 'high') return sorted[sorted.length - 1][1];
    return sorted[Math.floor(sorted.length / 2)][1];
  };

  // ---- zones --------------------------------------------------------------------------------
  const buildZones = () => {
    const out = [];
    let n = 0;
    for (const pl of DATA.placements || []) {
      if (out.length >= C.maxZones) break;
      if (!pl.ref || !Array.isArray(pl.pos)) continue;
      const id = pickOption(pl.options, pickFor(pl));
      if (!id) continue;
      out.push({ Name: `${PREFIX}${pl.kind}:${n++}`, ID: pl.world, POS: pl.pos, Size: C.radius, Anchor: pl.ref, NPC: [{ id, count: 1 }], Despawn: C.despawnSeconds, Respawn: C.respawnSeconds });
    }
    return out;
  };
  const writeZones = () => {
    let root = null, list = [], key = 'zones';
    try {
      const parsed = JSON.parse(fs.readFileSync(SPAWNS_FILE, 'utf8'));
      if (Array.isArray(parsed)) list = parsed; else if (parsed && typeof parsed === 'object') { root = parsed; key = Object.keys(parsed).find((k) => k.toLowerCase() === 'zones') || 'zones'; list = Array.isArray(parsed[key]) ? parsed[key] : []; }
    } catch (e) { /* no file yet */ }
    const kept = list.filter((z) => !String((z && (z.Name || z.name)) || '').startsWith(PREFIX));
    const mine = C.enabled ? buildZones() : [];
    const signature = JSON.stringify([C.radius, C.despawnSeconds, C.respawnSeconds, C.pick, SAFE, mine.length]);
    const before = list.filter((z) => String((z && (z.Name || z.name)) || '').startsWith(PREFIX)).length;
    if (before === mine.length && globalThis.__dboWildSig === signature) return mine.length;
    globalThis.__dboWildSig = signature;
    const payload = root ? Object.assign({}, root, { [key]: kept.concat(mine) }) : { _comment: 'NPC spawn zones. dungeon:* entries belong to dungeons.js, wild:* entries to wildlife.js; both are rewritten by the server. Other entries are kept.', zones: kept.concat(mine) };
    try { fs.writeFileSync(SPAWNS_FILE + '.tmp', JSON.stringify(payload, null, 1)); fs.renameSync(SPAWNS_FILE + '.tmp', SPAWNS_FILE); }
    catch (e) { log('NPC-Spawns.json write failed (wildlife)', e.message); }
    return mine.length;
  };

  // ---- giant camp chests: loot nodes ----------------------------------------------------------
  const campChests = new Map(); // refId -> { camp, chest }
  for (const camp of DATA.giantCamps || []) for (const ch of camp.chests || []) { const id = idOf(ch.ref); if (id) campChests.set(id, { camp, chest: ch }); }
  const lootsOf = (a) => { try { const r = mp.get(a, 'private.campLoot'); return r && typeof r === 'object' ? r : {}; } catch (e) { return {}; } };
  const pool = (name) => LOOT[name] || [];
  const campLoot = () => {
    const out = [];
    const add = (item, count) => { if (!item) return; const id = idOf(item.id); if (id) out.push({ id, count, name: item.name }); };
    out.push({ id: GOLD_BASE, count: rnd(15, 45), name: 'Gold' });
    if (Math.random() < 0.6) add(pickFrom(pool('ingredients')), rnd(1, 3));
    if (Math.random() < 0.5) add(pickFrom(pool('materials')), rnd(1, 2));
    if (Math.random() < 0.25) add(pickFrom(pool('gems').filter((g) => !/flawless/i.test(g.name))), 1);
    if (Math.random() < 0.15) add(pickFrom(pool('soulgems').filter((g) => /petty|lesser/i.test(g.name))), 1);
    if (Math.random() < 0.2) add(pickFrom(pool('weapons').filter((w) => Number(w.value) <= 300)), 1);
    return out;
  };
  const denyAt = new Map();
  globalThis.__dboCampChest = (targetId, casterId) => {
    const hit = campChests.get(targetId);
    if (!hit || !C.enabled) return null;
    const say = (t) => { if (Date.now() - (denyAt.get(casterId) || 0) > 1500) { denyAt.set(casterId, Date.now()); personal(casterId, t); } return false; };
    const loots = lootsOf(casterId);
    const until = Number(loots[targetId.toString(16)]) || 0;
    if (until > Date.now()) return say(`You have already picked through this chest. Come back in ${Math.ceil((until - Date.now()) / 60000)} minutes.`);
    for (const k of Object.keys(loots)) if (Number(loots[k]) < Date.now()) delete loots[k];
    loots[targetId.toString(16)] = Date.now() + C.campLootMinutes * 60000;
    try { mp.set(casterId, 'private.campLoot', loots); } catch (e) { log('campLoot save failed', e.message); }
    const got = campLoot().filter((it) => giveItem(casterId, it.id, it.count));
    personal(casterId, `You rummage through the giants' chest: ${got.map((it) => `${it.count} ${it.name.replace(/([a-z])([A-Z])/g, '$1 $2')}`).join(', ')}.`);
    audit(`CAMP ${who(casterId)} looted ${hit.camp.name}: ${got.map((it) => `${it.count}x ${it.name}`).join(', ')}`);
    return false;
  };

  registerChatCommand('wildlife', (a) => {
    personal(a, `${(DATA.placements || []).length} creature spots outdoors, ${campChests.size} giant camp chests, spawn within ${Math.round(C.radius / 70)} m, back ${Math.round(C.respawnSeconds / 60)} min after a kill.${isAdmin(a) ? ' Config: gamemode-config.json "wildlife".' : ''}`);
  }, { help: 'what roams the wilds' });

  // ---- placement factions -----------------------------------------------------------------------
  // pickOption resolves the placement's Lvl* wrapper down to a concrete NPC_, which in dungeons.js
  // loses the factions of any wrapper that owns them ("Use Factions" unset) - 390 of 3,500 there.
  // Measured 2026-09-20: it costs wildlife NOTHING. All 3,185 wrappers have "Use Factions" SET and
  // template down to an LVLN, so they never had factions of their own to lose, and no ff_factions
  // repair is needed here. This audit stays so that the day someone adds a placement whose template
  // does own its factions, the boot line says so instead of it going quietly wrong.
  // Once per process: it walks a few thousand espm chains and a hot reload must not pay for it again.
  // Cache-busted like gamemode.js busts its own modules: this file is evaluated outside the bundle's
  // module tree, so a hot reload re-requires wildlife.js but would otherwise keep a stale factions.js.
  const FACTIONS = (() => { try { const p = path.resolve('factions.js'); delete require.cache[p]; return require(p)(mp); } catch (e) { log('factions.js failed to load:', e.message); return null; } })();
  // The verdict is kept on globalThis so the summary line still carries it after a hot reload, when
  // the audit itself is skipped.
  if (FACTIONS && !globalThis.__dboWildFactionAudit) {
    const t0 = Date.now();
    // Audit the option actually picked, not options[0]: the pick is what gets spawned.
    const slots = (DATA.placements || []).map((pl) => ({ ref: pl.ref, base: idOf(pickOption(pl.options, pickFor(pl))), edid: pl.edid }));
    const a = FACTIONS.audit(slots);
    globalThis.__dboWildFactionAudit = `, ${a.lost} of ${a.counted} lose their template's factions`;
    log(`wildlife faction audit: ${a.lost} of ${a.counted} placements spawn without their template's factions, ${a.deferred} defer to the leveled pick (${a.kinds} kinds, ${Date.now() - t0} ms)${a.top.length ? '; top: ' + a.top.slice(0, 6).map(([k, n]) => `${n}x ${k}`).join(' | ') : ''}`);
  }

  const zones = writeZones();
  log(`wildlife ${C.enabled ? 'on' : 'off'}: ${(DATA.placements || []).length} placements -> ${zones} zones, ${campChests.size} giant camp chests, radius ${C.radius}, despawn ${C.despawnSeconds}s, respawn ${C.respawnSeconds}s${globalThis.__dboWildFactionAudit || ''}`);
};
