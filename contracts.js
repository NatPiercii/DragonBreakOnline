// Hunting contracts: the hold pays for dangerous work, out of its own treasury. Standing contracts
// are drawn from the creatures that actually spawn in the zone, so a Bruma notice never asks for a
// horker. Officials post their own with /contract post. Loaded by gamemode.js like champions.js.
'use strict';

module.exports = (api) => {
  const { mp, log, personal, audit, display, who, cfg, giveItem, registerChatCommand, zones, ranksOf, profileOf } = api;
  const fs = require('fs');
  const path = require('path');

  const CFG = Object.assign({
    enabled: true,
    perZone: 3,
    // Kills asked for, by how dangerous the quarry is
    countRange: [4, 10],
    // Gold per kill by danger tier, before the count
    rewardPerKill: { 1: 12, 2: 25, 3: 60 },
    expiryHours: 24,
    // A champion kill counts for this many
    championWorth: 2,
  }, cfg.contracts || {});

  // How dangerous each creature kind is: tier 3 is worth real money and real risk
  const DANGER = {
    chicken: 0, cow: 0, hare: 0, dog: 0, deer: 0, elk: 0, goat: 0, fox: 0,
    mudcrab: 1, skeever: 1, slaughterfish: 1, horker: 1,
    wolf: 1, frostbitespider: 2, sabrecat: 2, bear: 2, riekling: 2, netch: 2, werebear: 3,
    troll: 3, giant: 3, mammoth: 3, lurker: 3,
  };
  const PLURAL = { wolf: 'wolves', fox: 'foxes', sabrecat: 'sabre cats', frostbitespider: 'frostbite spiders', mudcrab: 'mudcrabs', skeever: 'skeevers', troll: 'trolls', bear: 'bears', giant: 'giants', mammoth: 'mammoths', riekling: 'rieklings', netch: 'netches', horker: 'horkers', slaughterfish: 'slaughterfish', lurker: 'lurkers', werebear: 'werebears' };
  const GOLD_BASE = 0x0000000f;
  const FILE = path.resolve('contracts.json');
  const SPAWNS = path.resolve('NPC-Spawns.json');
  // A hold's fauna is drawn from this far around its capital, roughly a hold's worth of ground
  const CAPITAL_REACH = 45000;

  const plural = (kind) => PLURAL[kind] || `${kind}s`;
  const zoneList = () => [].concat(zones.holds || [], zones.strongholds || [], zones.regions || []);
  const zoneById = (id) => zoneList().find((z) => z.id === String(id).toLowerCase()) || null;

  const state = (() => {
    try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return { contracts: [], taken: {} }; }
  })();
  if (!Array.isArray(state.contracts)) state.contracts = [];
  if (!state.taken || typeof state.taken !== 'object') state.taken = {};
  const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(state, null, 2)); } catch (e) { log('contracts save failed', e.message); } };

  // Which creature kinds the spawner actually places in a zone's worldspaces
  const kindsByZone = (() => {
    const out = {};
    let list = [];
    try { const raw = JSON.parse(fs.readFileSync(SPAWNS, 'utf8')); list = Array.isArray(raw) ? raw : (raw.zones || []); } catch (e) { return out; }
    const worldOf = {};
    for (const z of zoneList()) for (const w of (z.worldspaces || [])) worldOf[String(w).toLowerCase()] = z.id;
    // A hold owns no worldspace of its own, so its fauna is whatever roams within reach of its capital
    const capitals = zoneList().filter((z) => Array.isArray(z.capital) && !(z.worldspaces || []).length);
    for (const entry of list) {
      const m = /^wild:([^:]+):/.exec(String(entry.Name || entry.name || ''));
      if (!m) continue;
      let zoneId = worldOf[String(entry.ID || entry.id || '').toLowerCase()];
      if (!zoneId && Array.isArray(entry.POS)) {
        let best = null; let bestD = CAPITAL_REACH;
        for (const z of capitals) {
          const d = Math.hypot(entry.POS[0] - z.capital[0], entry.POS[1] - z.capital[1]);
          if (d < bestD) { bestD = d; best = z.id; }
        }
        zoneId = best;
      }
      if (!zoneId) continue;
      (out[zoneId] = out[zoneId] || {})[m[1]] = (out[zoneId][m[1]] || 0) + 1;
    }
    return out;
  })();

  const treasuryGold = (zone) => {
    if (!zone || !zone.treasury) return 0;
    try {
      const inv = mp.get(mp.getIdFromDesc(zone.treasury) >>> 0, 'inventory');
      const entries = inv && Array.isArray(inv.entries) ? inv.entries : [];
      const gold = entries.find((e) => (Number(e && e.baseId) >>> 0) === GOLD_BASE);
      return gold ? Number(gold.count) || 0 : 0;
    } catch (e) { return 0; }
  };

  // Returns what was actually paid; the hold cannot pay what it does not have
  const payFromTreasury = (zone, amount) => {
    if (amount <= 0 || !zone || !zone.treasury) return 0;
    try {
      const chestId = mp.getIdFromDesc(zone.treasury) >>> 0;
      const inv = mp.get(chestId, 'inventory');
      const entries = inv && Array.isArray(inv.entries) ? inv.entries.map((e) => Object.assign({}, e)) : [];
      const gold = entries.find((e) => (Number(e.baseId) >>> 0) === GOLD_BASE);
      const have = gold ? Number(gold.count) || 0 : 0;
      const paid = Math.min(have, amount);
      if (paid <= 0) return 0;
      gold.count = have - paid;
      mp.set(chestId, 'inventory', { entries: entries.filter((e) => (Number(e.count) || 0) > 0 || (Number(e.baseId) >>> 0) !== GOLD_BASE) });
      return paid;
    } catch (e) { log('treasury payout failed', e.message); return 0; }
  };

  const nextId = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

  const makeContract = (zone) => {
    const posted = zoneContracts(zone.id).map((c) => c.kind);
    const kinds = Object.keys(kindsByZone[zone.id] || {}).filter((k) => (DANGER[k] || 0) > 0 && posted.indexOf(k) === -1);
    if (!kinds.length) return null;
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    const danger = DANGER[kind] || 1;
    const [lo, hi] = CFG.countRange;
    // Fewer of the dangerous things
    const count = Math.max(2, Math.round((lo + Math.random() * (hi - lo)) / danger));
    const reward = count * (Number(CFG.rewardPerKill[danger]) || 12);
    if (treasuryGold(zone) < reward) return null;
    return {
      id: nextId(), zone: zone.id, kind, count, reward,
      postedAt: Date.now(), expiresAt: Date.now() + (Number(CFG.expiryHours) || 24) * 3600000,
    };
  };

  const zoneContracts = (zoneId) => state.contracts.filter((c) => c.zone === zoneId && c.expiresAt > Date.now());

  const refresh = () => {
    const before = state.contracts.length;
    state.contracts = state.contracts.filter((c) => c.expiresAt > Date.now());
    for (const zone of zoneList()) {
      if (!zone.treasury) continue;
      let have = zoneContracts(zone.id).length;
      for (let i = have; i < (Number(CFG.perZone) || 3); i++) {
        const c = makeContract(zone);
        if (!c) break;
        state.contracts.push(c);
      }
    }
    if (state.contracts.length !== before) save();
  };

  // The zone a player stands in, by worldspace first and the hold capital as the fallback
  const zoneOf = (a) => {
    let world = ''; try { world = String(mp.get(a, 'worldOrCellDesc') || '').toLowerCase(); } catch (e) { return null; }
    for (const z of zoneList()) if ((z.worldspaces || []).some((w) => String(w).toLowerCase() === world)) return z;
    let pos = null; try { pos = mp.get(a, 'pos'); } catch (e) { pos = null; }
    if (!Array.isArray(pos)) return null;
    let best = null; let bestD = Infinity;
    for (const z of zoneList()) {
      if (!Array.isArray(z.capital)) continue;
      const d = Math.hypot(pos[0] - z.capital[0], pos[1] - z.capital[1]);
      if (d < bestD) { bestD = d; best = z; }
    }
    return bestD < 60000 ? best : null;
  };

  const takenBy = (a) => { const key = String(profileOf(a)); return state.taken[key] || null; };
  const setTaken = (a, value) => {
    const key = String(profileOf(a));
    if (value) state.taken[key] = value; else delete state.taken[key];
    save();
  };
  const contractById = (id) => state.contracts.find((c) => c.id === id) || null;

  const describe = (c, progress) => {
    const zone = zoneById(c.zone);
    const done = progress === undefined ? '' : ` [${progress}/${c.count}]`;
    return `${c.count} ${plural(c.kind)} in ${zone ? zone.name : c.zone} for ${c.reward} gold${done}`;
  };

  const isOfficial = (a, zoneId) => {
    try { return ranksOf(profileOf(a)).some((r) => r.zone && r.zone.id === zoneId); } catch (e) { return false; }
  };

  // Death of a spawned creature: the killer's contract, if it matches, moves on
  globalThis.__dboContractKill = (npcId, killerId) => {
    const held = takenBy(killerId);
    if (!held) return;
    const c = contractById(held.id);
    if (!c) { setTaken(killerId, null); return; }
    let tag = ''; try { tag = String(mp.get(npcId, 'private.npcSpawner') || ''); } catch (e) { return; }
    const m = /^wild:([^:]+):/.exec(tag);
    if (!m || m[1] !== c.kind) return;
    let worth = 1;
    try { if (mp.get(npcId, 'private.dboChampion') === true) worth = Math.max(1, Number(CFG.championWorth) || 1); } catch (e) { /* plain beast */ }
    held.progress = (Number(held.progress) || 0) + worth;
    if (held.progress < c.count) {
      setTaken(killerId, held);
      personal(killerId, `Contract: ${held.progress}/${c.count} ${plural(c.kind)}.`);
      return;
    }
    const zone = zoneById(c.zone);
    const paid = payFromTreasury(zone, c.reward);
    if (paid <= 0) {
      setTaken(killerId, held);
      personal(killerId, `The work is done, but the ${zone ? zone.name : c.zone} treasury is empty. Speak to its officials.`);
      return;
    }
    giveItem(killerId, GOLD_BASE, paid);
    setTaken(killerId, null);
    state.contracts = state.contracts.filter((x) => x.id !== c.id);
    save();
    personal(killerId, `Contract complete: ${c.count} ${plural(c.kind)}. ${paid} gold from the ${zone ? zone.name : c.zone} treasury.`);
    audit(`CONTRACT ${who(killerId)} completed ${c.count} ${plural(c.kind)} for ${zone ? zone.name : c.zone} (${paid} gold)`);
    refresh();
  };

  registerChatCommand('contracts', (a) => {
    refresh();
    const zone = zoneOf(a);
    if (!zone) return personal(a, 'No hold claims this ground, so there is no work posted here.');
    const list = zoneContracts(zone.id);
    if (!list.length) return personal(a, `${zone.name} has no work posted. Its coffers may be empty.`);
    personal(a, `Work posted in ${zone.name} (treasury ${treasuryGold(zone)} gold):`);
    list.forEach((c, i) => personal(a, `  ${i + 1}. ${describe(c)}`));
    personal(a, 'Take one with /contract take <number>.');
  }, { help: 'hunting work posted by the hold you stand in' });

  registerChatCommand('contract', (a, args) => {
    const parts = String(args || '').trim().split(/\s+/).filter(Boolean);
    const verb = (parts[0] || '').toLowerCase();
    const held = takenBy(a);

    if (!verb) {
      if (!held) return personal(a, 'You hold no contract. /contracts lists the work here.');
      const c = contractById(held.id);
      if (!c) { setTaken(a, null); return personal(a, 'That contract has expired.'); }
      return personal(a, `You hold: ${describe(c, Number(held.progress) || 0)}.`);
    }

    if (verb === 'take') {
      const zone = zoneOf(a);
      if (!zone) return personal(a, 'There is no work posted on this ground.');
      if (held) return personal(a, 'You already hold a contract. /contract abandon to give it up.');
      const list = zoneContracts(zone.id);
      const c = list[Math.max(1, Number(parts[1]) || 1) - 1];
      if (!c) return personal(a, 'No such contract. /contracts lists them.');
      setTaken(a, { id: c.id, progress: 0 });
      personal(a, `Taken: ${describe(c, 0)}. Kills count anywhere in ${zone.name}.`);
      return audit(`CONTRACT ${who(a)} took ${c.count} ${plural(c.kind)} for ${zone.name}`);
    }

    if (verb === 'abandon') {
      if (!held) return personal(a, 'You hold no contract.');
      setTaken(a, null);
      return personal(a, 'Contract abandoned. The notice goes back on the board.');
    }

    if (verb === 'post') {
      const zone = zoneOf(a);
      if (!zone) return personal(a, 'You stand outside any hold.');
      if (!isOfficial(a, zone.id)) return personal(a, `Only an official of ${zone.name} posts work in its name.`);
      const kind = String(parts[1] || '').toLowerCase();
      const count = Math.max(1, Math.min(50, Number(parts[2]) || 0));
      const reward = Math.max(1, Math.min(10000, Number(parts[3]) || 0));
      if (!kind || !count || !reward) return personal(a, 'Use: /contract post <creature> <count> <reward>');
      if (!(kindsByZone[zone.id] || {})[kind]) return personal(a, `No ${plural(kind)} are known to roam ${zone.name}.`);
      if (treasuryGold(zone) < reward) return personal(a, `The ${zone.name} treasury holds ${treasuryGold(zone)} gold, less than the reward.`);
      const c = { id: nextId(), zone: zone.id, kind, count, reward, postedAt: Date.now(), expiresAt: Date.now() + (Number(CFG.expiryHours) || 24) * 3600000 };
      state.contracts.push(c);
      save();
      personal(a, `Posted: ${describe(c)}.`);
      return audit(`CONTRACT ${who(a)} posted ${c.count} ${plural(c.kind)} for ${zone.name} at ${c.reward} gold`);
    }

    return personal(a, 'Use: /contract, /contract take <n>, /contract abandon, /contract post <creature> <count> <reward>.');
  }, { help: 'take or post hunting work' });

  refresh();
  const posted = state.contracts.length;
  log(`contracts ${CFG.enabled ? 'on' : 'off'}: ${posted} posted across ${Object.keys(kindsByZone).length} zone(s) with known fauna, ${CFG.perZone} per zone, paid from the zone treasury`);
};
