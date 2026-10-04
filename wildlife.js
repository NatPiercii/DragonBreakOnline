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
//   maxZones, campLootMinutes, campGold: [min, max], safeZones: [{ world, pos, radius, pick }] }
// A spot inside a safe zone uses that zone's pick (e.g. "low" near where new players arrive).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = (api) => {
  const { mp, log, personal, system, registerChatCommand, giveItem, profileOf, display, who, audit, isAdmin, cfg, onlineActors, sendPacket } = api;
  const C = Object.assign({ enabled: true, radius: 6000, despawnSeconds: 240, respawnSeconds: 1800, pick: 'mid', maxZones: 4000, campLootMinutes: 60, campGold: [8, 22], safeZones: [] }, cfg.wildlife || {});
  // The coin a camp chest hands over, a range in gold (config wildlife.campGold). A broken range falls back to 8-22, and
  // [0, 0] hands over no coin
  const CAMP_GOLD = (() => {
    const g = C.campGold;
    const lo = Array.isArray(g) ? Math.floor(Number(g[0])) : NaN, hi = Array.isArray(g) ? Math.floor(Number(g[1])) : NaN;
    return Number.isFinite(lo) && Number.isFinite(hi) && lo >= 0 && hi >= lo ? [lo, hi] : [8, 22];
  })();
  const SPAWNS_FILE = path.resolve('NPC-Spawns.json');
  const PREFIX = 'wild:';
  const GOLD_BASE = 0x0000000f;
  const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); } catch (e) { return fallback; } };
  const DATA = readJson('wildlife.json', { placements: [], giantCamps: [] });
  // Creatures the DragonBreak-owned plugins place Initially Disabled (tools/spawns/owned_spawns.py; Nate, 30 Sep: "those
  // living actors should be used as spawns for their respective npc", creatures only). Each becomes a wild zone of its
  // own base at its own spot and heading; groups with a chest of ours are camps like the giants'.
  const OWNED = readJson('owned-spawns.json', { spawns: [], camps: [] });
  // Named after the placing reference, not a running number, so a regenerated list never renames another zone
  const ownedZoneName = (sp) => { const [loc, plugin] = String(sp.src).split(':'); return `${PREFIX}${sp.kind}:p${loc}-${String(plugin || '').toLowerCase().replace(/\.es[mpl]$/, '').replace(/[^a-z0-9]/g, '')}`; };
  const LOOT = (readJson('loot.json', { pools: {} }).pools) || {};
  // Nate, 2026-09-29: artifacts are never loot (artifacts.json, as dungeons.js reads it); nor dragon bone and scales
  // (dragon-materials.json, Nate 2026-09-30: only a slain dragon gives them)
  const ARTIFACT = (() => {
    const list = (readJson('artifacts.json', { patterns: [] }).patterns || []).filter((p) => typeof p === 'string' && p)
      .concat((readJson('dragon-materials.json', { editorIds: [] }).editorIds || []).filter((e) => typeof e === 'string' && /^\w+$/.test(e)).map((e) => `^${e}$`));
    try { return list.length ? new RegExp(list.map((p) => `(?:${p})`).join('|'), 'i') : /$^/; } catch (e) { log('artifacts.json has a bad pattern', e.message); return /$^/; }
  })();
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

  // Creatures that crash nearby players' games never get a wild:* zone (crashycreatures.js); none is in the data (4 Oct)
  const CRASHY = (() => { try { const p = path.resolve('crashycreatures.js'); delete require.cache[p]; return require(p)(mp, cfg, log); } catch (e) { log('wildlife: crashycreatures.js failed to load', e.message); return null; } })();
  // Only the pick is looked up (a record lookup per option of 3,000 placements would hold the event loop for seconds); a
  // refused pick is made again from the options the guard keeps. null when nothing is left.
  const safePick = (options, pick) => {
    const id = pickOption(options, pick);
    if (!id || !CRASHY || !CRASHY.on || !CRASHY.check(id)) return { id, left: false };
    const again = pickOption(CRASHY.filterOptions(options), pick);
    return { id: again, left: !again };
  };

  // ---- zones --------------------------------------------------------------------------------
  const buildZones = () => {
    const out = [];
    let n = 0;
    for (const pl of DATA.placements || []) {
      if (out.length >= C.maxZones) break;
      if (!pl.ref || !Array.isArray(pl.pos)) continue;
      // No navmesh in the placement's cell (BSHeartland covers 524 of 2381 Cyrodiil cells): the creature cannot path
      // and sinks or slides. Skipped, but still counted, so every later wild:* zone keeps its name.
      if (pl.noNavmesh) { n++; continue; }
      const { id, left } = safePick(pl.options, pickFor(pl));
      // Left out by the guard: still counted, so every later wild:* zone keeps its name (as a no-navmesh one is)
      if (!id) { if (left) n++; continue; }
      out.push({ Name: `${PREFIX}${pl.kind}:${n++}`, ID: pl.world, POS: pl.pos, Size: C.radius, Anchor: pl.ref, NPC: [{ id, count: 1 }], Despawn: C.despawnSeconds, Respawn: C.respawnSeconds });
    }
    for (const sp of OWNED.spawns || []) {
      if (out.length >= C.maxZones) break;
      if (!sp || !sp.src || !sp.kind || !sp.ref || !sp.world || !Array.isArray(sp.pos)) continue;
      const { id } = safePick(sp.options, pickFor(sp));
      if (!id) continue;
      out.push({ Name: ownedZoneName(sp), ID: sp.world, POS: sp.pos, Size: C.radius, Anchor: sp.ref, Heading: Number(sp.heading) || 0, NPC: [{ id, count: 1 }], Despawn: C.despawnSeconds, Respawn: C.respawnSeconds });
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
    // The zones themselves are in the signature, so a moved spot reaches NPC-Spawns.json on a hot reload
    const signature = JSON.stringify([C.radius, C.despawnSeconds, C.respawnSeconds, C.pick, SAFE, mine.length, crypto.createHash('sha1').update(JSON.stringify(mine)).digest('hex')]);
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
  for (const camp of (DATA.giantCamps || []).concat(OWNED.camps || [])) for (const ch of camp.chests || []) { const id = idOf(ch.ref); if (id) campChests.set(id, { camp, chest: ch }); }
  const lootsOf = (a) => { try { const r = mp.get(a, 'private.campLoot'); return r && typeof r === 'object' ? r : {}; } catch (e) { return {}; } };
  // No Ebony, Daedric or Dragon gear either, nor the ebony ingot (dungeons.js BANNED_LOOT, shared through
  // globalThis.__dboBannedLoot); without that pattern the chest gives no weapon and no material at all. Weapons also pass
  // the dungeon loot's material check (globalThis.__dboLootable, loottiers.js: never-loot and hand-kept-out items, faction
  // uniforms, anything the map does not know); without it, no weapon. Both are looked up as the chest fills, so either
  // module may load first
  // Weapons are also of the camp's province (Nate: gear is region-locked; dungeons.js's own rule through
  // globalThis.__dboLootInProvince, the province from where the chest is opened); no province known, no weapon.
  // Ingots and ores above steel (gear-swap.json metals, the list the swap takes from players; never loot, the cap lifted
  // too; Nate, 4 Oct:
  // Eldacar had two Adamantium ingots from a camp chest at 02:05Z) leave the materials pool, through dungeons.js's own
  // check (globalThis.__dboLootAboveCap); without it, no material
  const pool = (name, province = '') => {
    const banned = globalThis.__dboBannedLoot instanceof RegExp ? globalThis.__dboBannedLoot : null;
    const lootable = typeof globalThis.__dboLootable === 'function' ? globalThis.__dboLootable : null;
    const inProvince = typeof globalThis.__dboLootInProvince === 'function' ? globalThis.__dboLootInProvince : null;
    const aboveCap = typeof globalThis.__dboLootAboveCap === 'function' ? globalThis.__dboLootAboveCap : null;
    if (!banned && (name === 'weapons' || name === 'materials')) return [];
    if (!aboveCap && name === 'materials') return [];
    if ((!lootable || !inProvince || !province) && name === 'weapons') return [];
    return (LOOT[name] || []).filter((it) => !ARTIFACT.test(String(it.name || '')) && !(banned && banned.test(String(it.name || '')))
      && !(aboveCap && aboveCap(it.id, name === 'materials' ? 'metal' : name === 'arrows' ? 'ammo' : '')) && (name !== 'weapons' || (lootable(it.id) && inProvince(it, province))));
  };
  const provinceOf = (a) => { try { const R = globalThis.__dboRegions; const p = R && typeof R.provinceAt === 'function' ? R.provinceAt(a) : null; return p && typeof p.province === 'string' && p.province !== 'none' ? p.province : ''; } catch (e) { return ''; } };
  const campLoot = (province = '') => {
    const out = [];
    const add = (item, count) => { if (!item) return; const id = idOf(item.id); if (id) out.push({ id, count, name: item.name }); };
    // Halved on 1 Oct with the dungeons' gold (was 15-45), and cut again on 4 Oct (gold-cut-1004, config wildlife.campGold)
    const coin = rnd(CAMP_GOLD[0], CAMP_GOLD[1]);
    if (coin > 0) out.push({ id: GOLD_BASE, count: coin, name: 'Gold' });
    if (Math.random() < 0.6) add(pickFrom(pool('ingredients')), rnd(1, 3));
    if (Math.random() < 0.5) add(pickFrom(pool('materials')), rnd(1, 2));
    if (Math.random() < 0.25) add(pickFrom(pool('gems').filter((g) => !/flawless/i.test(g.name))), 1);
    if (Math.random() < 0.15) add(pickFrom(pool('soulgems').filter((g) => /petty|lesser/i.test(g.name))), 1);
    if (Math.random() < 0.2) add(pickFrom(pool('weapons', province).filter((w) => Number(w.value) <= 300)), 1);
    return out;
  };
  // A camp chest glows for a player while it holds a roll for them and goes dark while theirs is spent, so a glow always
  // means something to take (GroundedPasta, #suggestions, 29 Sep: "no way to tell between a chest or barrel that is empty
  // and one that isn't"). Every other world container outside a dungeon is empty by design, and dungeon chests glow for
  // the claiming party (dungeons.js). The client keeps the set and lights each ref when it loads (dboGlowService); "on"
  // for a ref it already has is a no-op, so the whole state is sent again every tick, which also restores it after the
  // login and dungeon-entry clears (__dboGlowClear).
  const CAMP_GLOW_MS = 30000;
  const campGlow = (a) => {
    if (typeof sendPacket !== 'function' || !campChests.size) return;
    const loots = lootsOf(a), now = Date.now(), ready = [], spent = [];
    for (const id of campChests.keys()) (C.enabled && !(Number(loots[id.toString(16)]) > now) ? ready : spent).push(id);
    try {
      if (spent.length) sendPacket(a, { customPacketType: 'dboGlow', refs: spent, on: false, kind: 'loot' });
      if (ready.length) sendPacket(a, { customPacketType: 'dboGlow', refs: ready, on: true, kind: 'loot' });
    } catch (e) { /* offline */ }
  };
  globalThis.__dboCampGlow = campGlow;
  if (globalThis.__dboCampGlowTimer) clearInterval(globalThis.__dboCampGlowTimer);
  globalThis.__dboCampGlowTimer = setInterval(() => {
    let online = []; try { online = typeof onlineActors === 'function' ? onlineActors() : []; } catch (e) { return; }
    for (const a of online) { try { globalThis.__dboCampGlow(a); } catch (e) { log('camp glow failed', e.message); } }
  }, CAMP_GLOW_MS);
  // ---- camp-mates are allies ------------------------------------------------------------------------------------------
  // Onny at Dusk Thorn Camp (30 Sep 02:37): "the goblins were all fighting each other more than fighting me". The goblins
  // DragonBreak placed are Beyond Skyrim's bare BSKEncGoblin* templates, whose only faction is CreatureFaction (the
  // tribe faction comes from the CYRLvlGoblin* wrappers vanilla places); Beyond Skyrim makes them Very Aggressive, and
  // the client raises every hostile spawn to Aggression 2 besides, which attacks anyone merely neutral. CreatureFaction
  // members are neutral to each other, so the camp fought itself. Each owned-spawn creature whose kind is listed here
  // gets these factions in ff_factions, which the client applies (formView.applyFactions, as for dungeon placements):
  // camp-mates become allies and stop targeting each other, and stay hostile to players. Checked every 2 s against the
  // spawner's sidecar of live ids; gamemode-config.json "ownedSpawns": { "factions": { "<kind>": ["<desc>", ...] } }.
  const OWNED_FACTIONS = Object.assign({
    goblin: ['13:Skyrim.esm', '877f5:BSHeartland.esm'],   // CreatureFaction, CYRGoblinFaction (allied to itself)
  }, ((cfg.ownedSpawns || {}).factions) || {});
  // All or nothing per kind: CreatureFaction alone (a list that only partly resolves) would bring the infighting back
  const factionIds = {};
  for (const [kind, list] of Object.entries(OWNED_FACTIONS)) {
    const descs = Array.isArray(list) ? list.map(String) : [];
    const missing = descs.filter((d) => !idOf(d));
    if (descs.length && !missing.length) factionIds[kind] = descs.map(idOf);
    else log(`ownedSpawns.factions.${kind}: ${missing.length ? `${missing.join(', ')} not in the load order` : 'empty'}; the ${kind} spawns are left as the plugin made them`);
  }
  const SPAWNED_IDS_FILE = path.resolve('zone-spawns.json');
  const factioned = globalThis.__dboOwnedFactioned instanceof Map ? globalThis.__dboOwnedFactioned : (globalThis.__dboOwnedFactioned = new Map());
  // The sidecar is read again only when it changed, or when an apply failed and is waiting for its retry
  const factionState = globalThis.__dboOwnedFactionState || (globalThis.__dboOwnedFactionState = { mtime: 0, retry: false });
  const ownedFactionTick = () => {
    if (!Object.keys(factionIds).length) return;
    let mtime = 0; try { mtime = fs.statSync(SPAWNED_IDS_FILE).mtimeMs; } catch (e) { return; }
    if (mtime === factionState.mtime && !factionState.retry) return;
    let ids = null;
    try { ids = JSON.parse(fs.readFileSync(SPAWNED_IDS_FILE, 'utf8')); } catch (e) { return; }
    if (!Array.isArray(ids)) return;
    factionState.mtime = mtime;
    factionState.retry = false;
    const live = new Set(ids.map((x) => Number(x) >>> 0));
    for (const id of factioned.keys()) if (!live.has(id)) factioned.delete(id);   // a reused form id is looked at afresh
    for (const id of live) {
      if (factioned.has(id)) continue;
      let tag = ''; try { tag = String(mp.get(id, 'private.npcSpawner') || ''); } catch (e) { continue; }
      const m = /^wild:([^:]+):p/.exec(tag);
      const want = m && factionIds[m[1]];
      if (!want) { factioned.set(id, ''); continue; }
      // Recorded only once applied: a failed apply is tried again on the next tick
      try { mp.set(id, 'ff_factions', { f: want.map((f) => [f, 0]), c: 0 }); factioned.set(id, m[1]); }
      catch (e) { factionState.retry = true; log('owned-spawn factions failed, will retry', id.toString(16), e.message); }
    }
  };
  globalThis.__dboOwnedFactionTick = ownedFactionTick;
  if (globalThis.__dboOwnedFactionTimer) clearInterval(globalThis.__dboOwnedFactionTimer);
  globalThis.__dboOwnedFactionTimer = setInterval(() => { try { globalThis.__dboOwnedFactionTick(); } catch (e) { log('owned-spawn factions tick failed', e.message); } }, 2000);
  const denyAt = new Map();
  globalThis.__dboCampChest = (targetId, casterId) => {
    const hit = campChests.get(targetId);
    if (!hit || !C.enabled) return null;
    // Camp loot is for players: a goblin or giant whose AI opens its own chest is turned away as before, but takes nothing
    let pid = -1; try { pid = Number(profileOf(casterId >>> 0)); } catch (e) { pid = -1; }
    if (!(pid >= 0)) return false;
    const say = (t) => { if (Date.now() - (denyAt.get(casterId) || 0) > 1500) { denyAt.set(casterId, Date.now()); personal(casterId, t); } return false; };
    const loots = lootsOf(casterId);
    const until = Number(loots[targetId.toString(16)]) || 0;
    if (until > Date.now()) return say(`You have already picked through this chest. Come back in ${Math.ceil((until - Date.now()) / 60000)} minutes.`);
    for (const k of Object.keys(loots)) if (Number(loots[k]) < Date.now()) delete loots[k];
    loots[targetId.toString(16)] = Date.now() + C.campLootMinutes * 60000;
    try { mp.set(casterId, 'private.campLoot', loots); } catch (e) { log('campLoot save failed', e.message); }
    campGlow(casterId);
    const got = campLoot(provinceOf(casterId)).filter((it) => giveItem(casterId, it.id, it.count));
    // Imperial Luck (racial.js) on the camp's coin; the chest's own cooldown keeps it to once a visit
    for (const it of got) if (it.id === GOLD_BASE) { try { if (typeof globalThis.__dboRaceGold === 'function') globalThis.__dboRaceGold(casterId, it.count, 'a camp chest'); } catch (e) { log('racial gold failed', e.message); } }
    personal(casterId, `You rummage through the ${hit.camp.owners || 'giants'}' chest: ${got.map((it) => `${it.count} ${it.name.replace(/([a-z])([A-Z])/g, '$1 $2')}`).join(', ')}.`);
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
  log(`wildlife ${C.enabled ? 'on' : 'off'}: ${(DATA.placements || []).length} placements -> ${zones} zones (${(DATA.placements || []).filter((p) => p.noNavmesh).length} skipped, no navmesh), ${(OWNED.spawns || []).length} owned-plugin creature spots, ${campChests.size} camp chests, radius ${C.radius}, despawn ${C.despawnSeconds}s, respawn ${C.respawnSeconds}s${globalThis.__dboWildFactionAudit || ''}`);
};
