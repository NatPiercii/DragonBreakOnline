// Champions: the lite MMO layer over the spawn system. A small share of the hostile NPCs the
// spawner places are promoted to named, oversized, tougher versions that reward everyone who
// fought them. Loaded by gamemode.js like labour.js; everything here is server side, so tuning
// needs no client build.
'use strict';

module.exports = (api) => {
  const { mp, log, personal, audit, display, cfg, giveItem, loot, registerChatCommand, sendPacket, onlineActors } = api;
  const fs = require('fs');
  const path = require('path');

  const CFG = Object.assign({
    enabled: true,
    wildChance: 0.05,
    dungeonChance: 0.08,
    // Share of each hit given back to the champion, so 0.5 is roughly double health
    toughness: 0.5,
    goldReward: [25, 120],
    gemChance: 0.35,
    // A player needs this share of the damage to count as a fighter
    creditShare: 0.1,
    pollSeconds: 4,
  }, cfg.champions || {});

  // Creatures worth promoting; the zone name carries the kind, so nothing has to be read off the actor
  const WORTHY = new Set([
    'mudcrab', 'skeever', 'slaughterfish', 'horker', 'wolf', 'frostbitespider', 'sabrecat',
    'bear', 'riekling', 'netch', 'werebear', 'troll', 'giant', 'mammoth', 'lurker',
  ]);

  const EPITHETS = [
    'Ravening', 'Scarred', 'Elder', 'Dire', 'Grim', 'Ancient', 'Blighted', 'Hollow',
    'Iron-Hide', 'Storm-Born', 'Frost-Touched', 'Black-Maned', 'Gore-Fed', 'Wretched',
    'Old', 'Slaughter-Born', 'Ash-Marked', 'Night-Fed', 'Broken-Tusk', 'Red-Eyed',
  ];

  const SPAWNS_FILE = path.resolve('zone-spawns.json');
  const GOLD_BASE = 0x0000000f;
  const champions = new Map(); // npc actorId -> { name, zone, health, damage: Map(playerId -> total) }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const propOf = (id, key) => { try { return mp.get(id, key); } catch (e) { return undefined; } };
  const healthOf = (id) => { const p = propOf(id, 'percentages'); return p && typeof p.health === 'number' ? p.health : null; };
  const setHealth = (id, health) => {
    const p = propOf(id, 'percentages');
    if (!p) return;
    try { mp.set(id, 'percentages', { health: clamp(health, 0, 1), magicka: p.magicka, stamina: p.stamina }); }
    catch (e) { log('champion heal failed', e.message); }
  };
  const isPlayer = (id) => { try { return mp.get(id, 'isOnline') === true; } catch (e) { return false; } };

  const pool = (name) => (loot && loot.pools && Array.isArray(loot.pools[name])) ? loot.pools[name] : [];
  const idOf = (desc) => { try { return mp.getIdFromDesc(String(desc)) >>> 0; } catch (e) { return 0; } };
  const pick = (list) => (list.length ? list[Math.floor(Math.random() * list.length)] : null);

  // The server's SetScale is a stub, so a champion is marked with the enemy rim shader instead.
  // A broadcast to everyone would cost a packet per player per sweep, so marks go to the champion's
  // own worldspace and only when that player's view of it changed.
  const worldOf = (id) => { try { return String(mp.get(id, 'worldOrCellDesc') || ''); } catch (e) { return ''; } };
  const sentTo = new Map();

  const glow = (ids, on, world) => {
    if (!ids.length) return;
    for (const a of onlineActors()) {
      if (world && worldOf(a) !== world) continue;
      try { sendPacket(a, { customPacketType: 'dboGlow', refs: ids, on, kind: 'champion' }); } catch (e) { /* offline */ }
    }
  };

  // Catches logins, which clear every glow, and players walking into a world where one is abroad
  const syncGlow = () => {
    const byWorld = new Map();
    for (const id of champions.keys()) {
      const w = worldOf(id);
      if (!w) continue;
      const list = byWorld.get(w);
      if (list) list.push(id); else byWorld.set(w, [id]);
    }
    const seenNow = new Set();
    for (const a of onlineActors()) {
      seenNow.add(a);
      const ids = byWorld.get(worldOf(a)) || [];
      const signature = ids.join(',');
      if (sentTo.get(a) === signature) continue;
      sentTo.set(a, signature);
      if (ids.length) { try { sendPacket(a, { customPacketType: 'dboGlow', refs: ids, on: true, kind: 'champion' }); } catch (e) { /* offline */ } }
    }
    for (const a of [...sentTo.keys()]) if (!seenNow.has(a)) sentTo.delete(a);
  };

  const promote = (id, zone) => {
    const epithet = pick(EPITHETS);
    // The client turns %original_name% into the base object's own name, so one string fits every creature
    const name = `${epithet} %original_name%`;
    try {
      const self = { type: 'form', desc: mp.getDescFromId(id) };
      mp.callPapyrusFunction('method', 'ObjectReference', 'SetDisplayName', self, [name, true]);
    } catch (e) { log('champion promote failed', id.toString(16), e.message); return false; }
    try { mp.set(id, 'private.dboChampion', true); } catch (e) { /* not persisted, memory is enough */ }
    champions.set(id, { name: epithet, zone, health: healthOf(id) ?? 1, damage: new Map() });
    glow([id], true, worldOf(id));
    log(`champion: ${epithet} (${id.toString(16)}) in ${zone}`);
    return true;
  };

  // New ids in zone-spawns.json are the spawner's work; hostile ones roll for promotion
  const seen = new Set();
  const sweep = () => {
    let ids = [];
    try { ids = JSON.parse(fs.readFileSync(SPAWNS_FILE, 'utf8')); } catch (e) { return; }
    if (!Array.isArray(ids)) return;
    const live = new Set(ids.map((x) => x >>> 0));
    for (const id of [...champions.keys()]) { if (live.has(id)) continue; const w = worldOf(id); champions.delete(id); glow([id], false, w); }
    for (const id of seen) if (!live.has(id)) seen.delete(id);

    for (const id of live) {
      if (seen.has(id)) continue;
      seen.add(id);
      const zone = String(propOf(id, 'private.npcSpawner') || '');
      if (!zone) continue;
      const kind = /^wild:([^:]+):/.exec(zone);
      if (kind && !WORTHY.has(kind[1])) continue;
      if (!kind && !zone.startsWith('dungeon:')) continue;
      const chance = zone.startsWith('dungeon:') ? Number(CFG.dungeonChance) : Number(CFG.wildChance);
      if (!(Math.random() < (chance || 0))) continue;
      promote(id, zone);
    }
    syncGlow();
  };

  if (globalThis.__dboChampionTimer) clearInterval(globalThis.__dboChampionTimer);
  globalThis.__dboChampionTimer = CFG.enabled
    ? setInterval(() => { try { sweep(); } catch (e) { log('champion sweep failed', e.message); } }, Math.max(1, Number(CFG.pollSeconds) || 4) * 1000)
    : null;

  // Damage on a champion is credited to the attacker and partly given back, so it lives twice as long
  globalThis.__dboChampionHit = (aggressorId, targetId, damage) => {
    const champ = champions.get(targetId >>> 0);
    if (!champ) return;
    if (isPlayer(aggressorId)) champ.damage.set(aggressorId, (champ.damage.get(aggressorId) || 0) + Math.max(0, Number(damage) || 0));
    const now = healthOf(targetId);
    if (now === null || now <= 0) { champ.health = 0; return; }
    const lost = champ.health - now;
    if (lost > 0) {
      const restored = clamp(now + lost * clamp(Number(CFG.toughness) || 0, 0, 0.8), 0, 1);
      setHealth(targetId, restored);
      champ.health = restored;
    } else {
      champ.health = now;
    }
  };

  // Everyone who did a real share of the damage is paid, so there is no race for the corpse
  globalThis.__dboChampionDeath = (actorId, killerId) => {
    const id = actorId >>> 0;
    const champ = champions.get(id);
    if (!champ) return;
    const world = worldOf(id);
    champions.delete(id);
    glow([id], false, world);

    let total = 0;
    for (const dmg of champ.damage.values()) total += dmg;
    const share = clamp(Number(CFG.creditShare) || 0.1, 0, 1);
    const fighters = [];
    for (const [playerId, dmg] of champ.damage) if (total <= 0 || dmg / total >= share) fighters.push(playerId);
    if (killerId && isPlayer(killerId) && fighters.indexOf(killerId >>> 0) === -1) fighters.push(killerId >>> 0);
    if (!fighters.length) return;

    const [lo, hi] = Array.isArray(CFG.goldReward) ? CFG.goldReward : [25, 120];
    const gems = pool('gems');
    const names = [];
    for (const playerId of fighters) {
      if (!isPlayer(playerId)) continue;
      const gold = Math.max(1, Math.floor(lo + Math.random() * Math.max(1, hi - lo)));
      giveItem(playerId, GOLD_BASE, gold);
      let extra = '';
      if (Math.random() < (Number(CFG.gemChance) || 0)) {
        const gem = pick(gems);
        if (gem && giveItem(playerId, idOf(gem.id), 1)) extra = ' and something bright out of the hide';
      }
      personal(playerId, `The ${champ.name.toLowerCase()} beast falls. ${gold} gold${extra}.`);
      names.push(display(playerId));
    }
    audit(`CHAMPION ${champ.name} in ${champ.zone} killed by ${names.join(', ')}`);
  };

  registerChatCommand('champions', (a) => {
    personal(a, champions.size
      ? `${champions.size} champion(s) abroad: ${[...champions.values()].map((c) => c.name).join(', ')}.`
      : 'No champions are abroad right now. They rise among the beasts and the dead, now and then.');
  }, { help: 'named beasts currently abroad' });

  log(`champions ${CFG.enabled ? 'on' : 'off'}: wild ${Math.round((CFG.wildChance || 0) * 100)}%, dungeon ${Math.round((CFG.dungeonChance || 0) * 100)}%, toughness ${CFG.toughness}`);
};
