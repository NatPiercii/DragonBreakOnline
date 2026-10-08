// Hunting contracts: the hold pays for dangerous work, out of its own treasury. Standing contracts
// are drawn from the creatures that actually spawn in the zone, so a Bruma notice never asks for a
// horker. Officials post their own with /contract post. Loaded by gamemode.js like champions.js.
// Players find, take and give up work on the Contracts tab of the expedition board (Nate, 2026-09-30); /contract stays.
'use strict';

module.exports = (api) => {
  const { mp, log, personal, audit, display, who, cfg, giveItem, registerChatCommand, zones, ranksOf, profileOf, saveSoon, discordOf, onUi, zoneOfActor } = api;
  const fs = require('fs');
  const path = require('path');

  const CFG = Object.assign({
    enabled: true,
    // Nate, 5 Oct: "Contracts need to be per player. Add more contracts." 3 -> 6 notices per hold, and 24 -> 12 hours, so
    // the board turns over twice as fast now that a finished notice stays up for the other hunters
    perZone: 6,
    // Kills asked for, by how dangerous the quarry is
    countRange: [4, 10],
    // Gold per kill by danger tier, before the count
    rewardPerKill: { 1: 12, 2: 25, 3: 60 },
    expiryHours: 12,
    // Nate, 5 Oct: a hunter may hold up to this many contracts at once, each notice once
    maxActive: 3,
    // Nate, 5 Oct: "make sure treasuries don't get bled dry". No take or new notice may leave a hold's treasury under
    // max(gold, share x its balance): boards shrink instead of draining it
    treasuryFloor: { gold: 200, share: 0.25 },
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

  const OFF_TEXT = 'Hunting contracts are closed for now. The expedition boards post no hunting work.';

  const plural = (kind) => PLURAL[kind] || `${kind}s`;
  const zoneList = () => [].concat(zones.holds || [], zones.strongholds || [], zones.regions || []);
  const zoneById = (id) => zoneList().find((z) => z.id === String(id).toLowerCase()) || null;

  const state = (() => {
    try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return { contracts: [], taken: {} }; }
  })();
  if (!Array.isArray(state.contracts)) state.contracts = [];
  if (!state.taken || typeof state.taken !== 'object') state.taken = {};
  // A kill would otherwise write the file on every hit of progress, per player
  const save = () => saveSoon(FILE, () => JSON.stringify(state, null, 2));
  // Whenever gold moves: the file must already say so, or a crash inside the debounce brings the notice back to pay twice
  const saveNow = () => (typeof api.saveNow === 'function' ? api.saveNow : saveSoon)(FILE, () => JSON.stringify(state, null, 2));

  // Notices from before the reward was set aside hold nothing, so they would pay nothing and could still be the
  // exploit's own (nobody recorded who posted them). They are dropped; no gold was ever taken for them, and refresh()
  // puts fresh work up. Anyone holding one is released.
  {
    const legacy = state.contracts.filter((c) => c.held === undefined);
    if (legacy.length) {
      const ids = new Set(legacy.map((c) => c.id));
      state.contracts = state.contracts.filter((c) => !ids.has(c.id));
      for (const key of Object.keys(state.taken)) {
        const left = [].concat(state.taken[key] || []).filter((w) => w && !ids.has(w.id));
        if (left.length) state.taken[key] = left; else delete state.taken[key];
      }
      save();
      log(`contracts: dropped ${legacy.length} notice(s) posted before rewards were set aside`);
    }
  }

  // What a creature is, by its own record. A wild:<kind> spot is named after the first creature of its leveled list, but
  // wildlife.js places one entry of that list picked by level: a Bruma "wolf" spot puts down a rat where the pick is
  // "low" and an ogre or a troll elsewhere, and most Skyrim "skeever" spots a bear or a sabre cat. So the tag let a rat
  // count for a wolf contract (#bugs, 1 Oct 2026). The kind is the first creature word in the editor id
  // (EncFrostbiteSpiderGiant is a spider, EncMudcrabGiant a mudcrab, dunPOITrappedWolf a wolf); BSKEncRat, CYREncOgre01
  // and EncIceWraith name no kind at all.
  const CREATURE_WORD = /(Werewolf|Werebear|FrostbiteSpider|SabreCat|Slaughterfish|Skeever|Mudcrab|Crab|Horker|Mammoth|Giant|Troll|Riekling|Netch|Lurker|Wolf|Bear|Chicken|Cow|Hare|Dog|Deer|Elk|Goat|Fox)/i;
  const kindOfEdid = (edid) => { const m = CREATURE_WORD.exec(String(edid || '')); if (!m) return ''; const k = m[1].toLowerCase(); return k === 'crab' ? 'mudcrab' : k; };
  // undefined when the record cannot be read: the caller then goes by the spawn tag, as before
  const kindOfBase = (desc) => {
    if (!desc) return undefined;
    try { const r = mp.lookupEspmRecordById(mp.getIdFromDesc(String(desc)) >>> 0); return r && r.record ? kindOfEdid(r.record.editorId) : undefined; } catch (e) { return undefined; }
  };

  // Which creature kinds the spawner actually places in a zone's worldspaces: the NPC each spot puts down, not its name
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
      const npcs = entry.NPC || entry.npc;
      const own = kindOfBase(Array.isArray(npcs) && npcs[0] ? npcs[0].id : '');
      const kind = own === undefined ? m[1] : own;
      if (!kind) continue;
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
      (out[zoneId] = out[zoneId] || {})[kind] = (out[zoneId][kind] || 0) + 1;
    }
    return out;
  })();

  // A hold's treasury is its balance in the bank (bank.js __dboTreasuryZone); the chest is only the fallback without it
  const bankTreasury = () => (globalThis.__dboTreasuryZone && typeof globalThis.__dboTreasuryZone.spend === 'function' ? globalThis.__dboTreasuryZone : null);
  const treasuryGold = (zone) => {
    if (!zone || !zone.treasury) return 0;
    if (bankTreasury()) return bankTreasury().balance(zone.id);
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
    if (bankTreasury()) { const paid = Math.min(bankTreasury().balance(zone.id), amount); return paid > 0 && bankTreasury().spend(zone.id, paid) ? paid : 0; }
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

  // The mirror of payFromTreasury: what a contract held and no longer needs goes back to the hold
  const refundToTreasury = (zone, amount) => {
    if (amount <= 0 || !zone || !zone.treasury) return false;
    if (bankTreasury()) return !!bankTreasury().deposit(zone.id, amount);
    try {
      const chestId = mp.getIdFromDesc(zone.treasury) >>> 0;
      const inv = mp.get(chestId, 'inventory');
      const entries = inv && Array.isArray(inv.entries) ? inv.entries.map((e) => Object.assign({}, e)) : [];
      const gold = entries.find((e) => (Number(e.baseId) >>> 0) === GOLD_BASE);
      if (gold) gold.count = (Number(gold.count) || 0) + amount; else entries.push({ baseId: GOLD_BASE, count: amount });
      mp.set(chestId, 'inventory', { entries });
      return true;
    } catch (e) { log('treasury refund failed', e.message); return false; }
  };

  // A contract holds its reward from the moment it is posted, so it can never pay out what the hold no longer has.
  // All or nothing: a treasury that covers only part of it keeps what it had and the notice does not go up.
  const escrow = (zone, amount) => {
    const paid = payFromTreasury(zone, amount);
    if (paid >= amount) return true;
    if (paid > 0) refundToTreasury(zone, paid);
    return false;
  };

  // The floor no take or new notice may push a treasury under (CFG.treasuryFloor)
  const floorOf = (zone) => {
    const f = CFG.treasuryFloor || {};
    const gold = Number.isFinite(Number(f.gold)) ? Math.max(0, Number(f.gold)) : 200;
    const share = Number.isFinite(Number(f.share)) ? Math.max(0, Math.min(1, Number(f.share))) : 0.25;
    return Math.max(gold, Math.ceil(share * treasuryGold(zone)));
  };
  const canSpare = (zone, amount) => !!zone && amount > 0 && treasuryGold(zone) - amount >= floorOf(zone);
  const TREASURY_TEXT = "The hold's treasury cannot spare more bounties right now.";

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
    if (!canSpare(zone, reward)) return null;
    return {
      id: nextId(), zone: zone.id, kind, count, reward,
      postedAt: Date.now(), expiresAt: Date.now() + (Number(CFG.expiryHours) || 12) * 3600000,
    };
  };

  const zoneContracts = (zoneId) => state.contracts.filter((c) => c.zone === zoneId && c.expiresAt > Date.now());

  // Number(x) || 3 would turn a deliberate 0 into 3, so perZone 0 could never mean "no standing work"
  const perZone = Number.isFinite(Number(CFG.perZone)) ? Math.max(0, Number(CFG.perZone)) : 6;

  const refresh = () => {
    const before = state.contracts.length;
    const kept = [];
    const expired = [];
    for (const c of state.contracts) (c.expiresAt > Date.now() ? kept : expired).push(c);
    state.contracts = kept;
    // A hunter's own copy that ran out gives its share back to the hold; the hunter is told when next they look (closeIfOver)
    for (const key of Object.keys(state.taken)) {
      for (const w of [].concat(state.taken[key] || [])) {
        if (w && w.kind && !w.expired && !(Number(w.expiresAt) > Date.now())) {
          expired.push({ label: `${key}'s contract`, zone: w.zone, held: Number(w.held) || 0 });
          w.held = 0; w.expired = true;
        }
      }
    }
    // An expired notice or copy hands its reward back rather than leaving the gold nowhere, once it is written off on disk
    if (expired.length) {
      saveNow();
      for (const c of expired) if (Number(c.held) > 0 && !refundToTreasury(zoneById(c.zone), Number(c.held))) log(`contracts: ${c.held} gold of expired ${c.label || `notice ${c.id}`} could not go back to ${c.zone}`);
    }
    // Off: what is already posted stays listed so nobody loses work in hand, but no new notice goes up
    if (!CFG.enabled) { if (state.contracts.length !== before) save(); return; }
    for (const zone of zoneList()) {
      if (!zone.treasury) continue;
      let have = zoneContracts(zone.id).length;
      for (let i = have; i < perZone; i++) {
        const c = makeContract(zone);
        if (!c) break;
        if (!escrow(zone, c.reward)) break;
        c.held = c.reward;
        state.contracts.push(c);
      }
    }
    if (state.contracts.length !== before) saveNow();
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

  // A player's zone is the gamemode's (indoors by the owning plugin, else where they last stood outside), so the boards
  // in Bruma's halls and /contract indoors know their hold; beasts are placed by their worldspace (zoneOf) as before
  const playerZone = (a) => {
    let id = null; try { id = typeof zoneOfActor === 'function' ? zoneOfActor(a) : null; } catch (e) { id = null; }
    return (id && zoneById(id)) || zoneOf(a);
  };

  const keyOf = (a) => String(profileOf(a));
  // A hunter's contracts: an array of copies. Older files hold one object (a copy, or { id, progress } from before)
  const rawList = (key) => { const v = state.taken[key]; return v ? [].concat(v).filter(Boolean) : []; };
  const putList = (key, list) => { if (list.length) state.taken[key] = list; else delete state.taken[key]; };
  const takenBy = (a) => rawList(keyOf(a)).length > 0;
  const contractById = (id) => state.contracts.find((c) => c.id === id) || null;
  const maxActive = () => (Number.isFinite(Number(CFG.maxActive)) ? Math.max(1, Math.floor(Number(CFG.maxActive))) : 3);
  // Contracts are per hunter (Nate, 5 Oct; three hunters had taken the same 2 trolls and only the first was paid): taking
  // a notice gives the hunter a copy of their own, with its own count, its own share of the reward set aside from the
  // treasury and its own time limit, and leaves the notice up for everyone else. A notice is done once per hunter, and a
  // hunter holds up to maxActive at once.
  // state.taken[profile] = [{ id, kind, count, reward, zone, held, progress, counted, takenAt, expiresAt[, expired] }]
  const copyHours = () => (Number(CFG.expiryHours) || 12) * 3600000;
  // The share for one more hunter: what the notice still holds (the first taker's), else set aside now, all or nothing,
  // and only above the treasury's floor. 0 when the hold cannot spare it: nobody is sent out for pay that is not there
  const shareFor = (c) => {
    const reward = Number(c.reward) || 0;
    if (Number(c.held) >= reward && reward > 0) { c.held = Number(c.held) - reward; return reward; }
    const zone = zoneById(c.zone);
    return canSpare(zone, reward) && escrow(zone, reward) ? reward : 0;
  };
  const copyFor = (c, progress = 0) => ({ id: c.id, kind: c.kind, count: c.count, reward: c.reward, zone: c.zone, held: 0, progress,
    counted: [], takenAt: Date.now(), expiresAt: Date.now() + copyHours() });
  // A contract taken under the one-notice rule ({ id, progress }) becomes a copy of its notice, keeping its progress; null
  // when its notice is gone
  const migrate = (key, old) => {
    const c = contractById(old.id);
    if (!c) return null;
    const w = copyFor(c, Number(old.progress) || 0);
    w.held = shareFor(c);
    log(`contracts: profile ${key}'s contract ${c.id} (${c.count} ${c.kind}) is its own copy now, ${w.progress} done, ${w.held} gold set aside`);
    return w;
  };
  const GONE_TEXT = 'Your contract is closed: its notice is no longer posted. Take new work at the board.';
  const ranOutText = (w) => `Your contract for ${w.count} ${plural(w.kind)} ran out before the last beast fell, and its reward went back to the hold.`;
  // The hunter's live contracts. One that is over (its notice gone before it became a copy, or run out) is closed with
  // word of it wherever they next look: a kill, the board, /contract
  const copiesOf = (a, tell = true) => {
    const key = keyOf(a);
    const raw = rawList(key);
    if (!raw.length) return [];
    const live = [], refunds = [];
    let changed = !Array.isArray(state.taken[key]);
    for (const old of raw) {
      const w = old.kind ? old : migrate(key, old);
      if (w !== old) changed = true;
      if (!w) { if (tell) personal(a, GONE_TEXT); continue; }
      if (w.expired || !(Number(w.expiresAt) > Date.now())) {
        if (Number(w.held) > 0) refunds.push(w);
        changed = true;
        if (tell) personal(a, ranOutText(w));
        continue;
      }
      live.push(w);
    }
    if (changed) { putList(key, live); saveNow(); }
    // Written off on disk first, then the share goes back to the hold
    for (const w of refunds) if (!refundToTreasury(zoneById(w.zone), Number(w.held))) log(`contracts: ${w.held} gold of run-out ${key}'s contract could not go back to ${w.zone}`);
    return live;
  };
  const doneBy = (c, a) => (c.doneBy || []).indexOf(keyOf(a)) !== -1;

  const describe = (c, progress) => {
    const zone = zoneById(c.zone);
    const done = progress === undefined ? '' : ` [${progress}/${c.count}]`;
    return `${c.count} ${plural(c.kind)} in ${zone ? zone.name : c.zone} for ${c.reward} gold${done}`;
  };

  // The account behind a character, so a poster cannot take his own notice on a second character of his
  const accountOf = (a) => { try { return String((typeof discordOf === 'function' && discordOf(a)) || ''); } catch (e) { return ''; } };
  const postedBy = (c, a) => {
    if (c.by !== undefined && Number(c.by) === Number(profileOf(a))) return true;
    const acc = accountOf(a);
    return !!acc && String(c.byAccount || '') === acc;
  };

  const isOfficial = (a, zoneId) => {
    try { return ranksOf(profileOf(a)).some((r) => r.zone && r.zone.id === zoneId); } catch (e) { return false; }
  };

  // Death of a spawned creature: every one of the killer's contracts it matches moves on, each at most once per body
  globalThis.__dboContractKill = (npcId, killerId) => {
    if (!CFG.enabled) return;
    if (!takenBy(killerId)) return;
    const work = copiesOf(killerId);
    if (!work.length) return;
    let tag = ''; try { tag = String(mp.get(npcId, 'private.npcSpawner') || ''); } catch (e) { return; }
    const m = /^wild:([^:]+):/.exec(tag);
    if (!m) return;
    // The body's own record says what fell; the spot's name only when that cannot be read (kindOfBase above)
    let base = ''; try { base = String(mp.get(npcId, 'baseDesc') || ''); } catch (e) { base = ''; }
    const own = kindOfBase(base);
    const kind = own === undefined ? m[1] : own;
    const where = zoneOf(npcId);
    const body = (Number(npcId) >>> 0).toString(16);
    let worth = 1;
    try { if (mp.get(npcId, 'private.dboChampion') === true) worth = Math.max(1, Number(CFG.championWorth) || 1); } catch (e) { /* plain beast */ }
    const key = keyOf(killerId);
    const sameKind = work.filter((w) => w.kind === kind);
    if (!sameKind.length) {
      // A spot named for the quarry that put down something else (a rat at a "wolf" spot) is said, not silently skipped
      const named = work.find((w) => w.kind === m[1]);
      if (named) personal(killerId, `That was ${own ? `a ${own}` : 'some other creature'}, not one of your ${plural(named.kind)}: it does not count for the contract.`);
      return;
    }
    let counted = 0;
    for (const w of sameKind) {
      // The hold pays for its own ground: a wolf felled in another hold is not this notice's work
      if (!where || where.id !== w.zone) continue;
      w.counted = Array.isArray(w.counted) ? w.counted : [];
      if (w.counted.indexOf(body) !== -1) continue;
      w.counted.push(body);
      if (w.counted.length > 60) w.counted.splice(0, w.counted.length - 60);
      counted++;
      w.progress = (Number(w.progress) || 0) + worth;
      if (w.progress < w.count) { personal(killerId, `Contract: ${w.progress}/${w.count} ${plural(w.kind)}.`); continue; }
      const zone = zoneById(w.zone);
      // The hunter's share was set aside when they took the notice; a copy that holds none (one migrated while the
      // treasury was short) is paid now if the hold can, else it waits
      if (!(Number(w.held) > 0)) w.held = payFromTreasury(zone, Number(w.reward) || 0);
      const paid = Number(w.held) || 0;
      if (paid <= 0) {
        personal(killerId, `The work is done, but the ${zone ? zone.name : w.zone} treasury is empty. Speak to its officials.`);
        continue;
      }
      // Closed and written before the gold changes hands, so no crash can pay it twice. The notice stays up for the
      // other hunters; this one has done it
      putList(key, rawList(key).filter((x) => x !== w));
      const notice = contractById(w.id);
      if (notice) notice.doneBy = (notice.doneBy || []).concat(key);
      saveNow();
      giveItem(killerId, GOLD_BASE, paid);
      personal(killerId, `Contract complete: ${w.count} ${plural(w.kind)}. ${paid} gold from the ${zone ? zone.name : w.zone} treasury.`);
      // Imperial Luck (racial.js): new coin on top of the pay, never out of the treasury
      try { if (typeof globalThis.__dboRaceGold === 'function') globalThis.__dboRaceGold(killerId, paid, 'contract pay'); } catch (e) { /* the pay itself is done */ }
      audit(`CONTRACT ${who(killerId)} completed ${w.count} ${plural(w.kind)} for ${zone ? zone.name : w.zone} (${paid} gold)`);
    }
    if (!counted && sameKind.some((w) => !where || where.id !== w.zone)) {
      const z = zoneById(sameKind[0].zone);
      personal(killerId, `Only ${plural(sameKind[0].kind)} felled in ${z ? z.name : sameKind[0].zone}'s wilds count for your contract.`);
    }
    save();
    refresh();
  };

  // Take and give up, shared by /contract and the board's Contracts tab; each returns what the player is told
  const takeContract = (a, c, zone) => {
    if (!CFG.enabled) return OFF_TEXT;
    const work = copiesOf(a);
    if (work.length >= maxActive()) return `You already hold ${maxActive()} contracts. Finish or give one up first.`;
    if (!c || c.zone !== zone.id || !(c.expiresAt > Date.now())) return 'That contract is no longer posted here.';
    if (work.some((w) => w.id === c.id)) return 'You already hold that contract.';
    if (postedBy(c, a)) return 'You posted that notice yourself. Someone else does the hunting.';
    if (doneBy(c, a)) return 'You have already done the work on that notice. Take another.';
    const w = copyFor(c);
    w.held = shareFor(c);
    if (!(w.held > 0)) return TREASURY_TEXT;
    putList(keyOf(a), work.concat([w]));
    saveNow();
    audit(`CONTRACT ${who(a)} took ${c.count} ${plural(c.kind)} for ${zone.name}`);
    return `Taken: ${describe(c, 0)}. Kills count anywhere in ${zone.name}'s wilds, and you are paid when the last one falls.`;
  };
  // which: a number from /contract's list of what you hold, or a notice id; none is fine only while one is held
  const abandonContract = (a, which) => {
    const work = copiesOf(a, false);
    if (!work.length) return 'You hold no contract.';
    let w = null;
    if (which === undefined || which === null || which === '') {
      if (work.length > 1) return `You hold ${work.length} contracts. Give one up with /contract abandon <number>; /contract lists them.`;
      w = work[0];
    } else {
      const n = Number(which);
      w = Number.isInteger(n) && n >= 1 && n <= work.length ? work[n - 1] : work.find((x) => x.id === String(which)) || null;
    }
    if (!w) return 'No such contract. /contract lists the ones you hold.';
    putList(keyOf(a), work.filter((x) => x !== w));
    saveNow();
    // The share set aside for this hunter goes back to the hold, once the contract is gone on disk
    if (Number(w.held) > 0 && !refundToTreasury(zoneById(w.zone), Number(w.held))) log(`contracts: ${w.held} gold of given-up ${keyOf(a)}'s contract could not go back to ${w.zone}`);
    return `Contract for ${w.count} ${plural(w.kind)} given up. Its reward goes back to the hold.`;
  };

  // What the Contracts tab of the expedition board shows (dungeons.js puts it in the board's payload)
  const boardView = (a) => {
    refresh();
    const zone = playerZone(a);
    const work = copiesOf(a);
    // The board of client 0.3.77 takes nothing more while it shows a contract held, so it is shown only at the cap; every
    // held notice is stamped as yours either way, and heldAll carries them all for a board that lists several
    const held = work.length >= maxActive() ? work[0] : null;
    const hc = held;
    // A notice this hunter has done is off their board; the others still see it
    const list = zone ? zoneContracts(zone.id).filter((c) => !doneBy(c, a)) : [];
    const hours = (c) => Math.max(0, Math.ceil((c.expiresAt - Date.now()) / 3600000));
    const zoneName = (id) => { const z = zoneById(id); return z ? z.name : id; };
    return {
      enabled: !!CFG.enabled,
      zone: zone ? zone.name : '',
      treasury: zone ? treasuryGold(zone) : 0,
      note: !CFG.enabled ? OFF_TEXT : !zone ? 'No hold claims this ground, so there is no hunting work posted here.'
        : list.length ? '' : `${zone.name} has no hunting work posted. Its coffers may be empty.`,
      heldAll: work.map((w) => ({ id: w.id, what: `${w.count} ${plural(w.kind)}`, zone: zoneName(w.zone), progress: Math.min(w.count, Number(w.progress) || 0), count: w.count, reward: w.reward, hoursLeft: hours(w) })),
      maxActive: maxActive(),
      held: hc ? { id: hc.id, what: `${hc.count} ${plural(hc.kind)}`, zone: zoneName(hc.zone), progress: Math.min(hc.count, Number(held.progress) || 0), count: hc.count, reward: hc.reward, hoursLeft: hours(hc) } : null,
      list: list.map((c) => ({ id: c.id, what: `${c.count} ${plural(c.kind)}`, count: c.count, reward: c.reward, danger: DANGER[c.kind] || 1, hoursLeft: hours(c),
        state: work.some((w) => w.id === c.id) ? 'yours' : postedBy(c, a) ? 'posted' : 'open' })),
      canPost: !!(zone && isOfficial(a, zone.id)),
    };
  };
  globalThis.__dboContractsBoard = { view: boardView };
  // The tab's buttons, honoured only while that player's board is open (dungeons.js keeps the open set)
  const boardOpen = (a) => { const m = globalThis.__dboExpeditionPending; return m instanceof Map && m.has(a); };
  const reopen = (a) => { try { if (typeof globalThis.__dboExpeditionBoardRefresh === 'function') globalThis.__dboExpeditionBoardRefresh(a, 'contracts'); } catch (e) { log('contracts: board refresh failed', e.message); } };
  if (typeof onUi === 'function') {
    onUi('contractTake', (a, args) => {
      if (!boardOpen(a)) return;
      const zone = playerZone(a);
      personal(a, zone ? takeContract(a, contractById(String((args || [])[0] || '')), zone) : 'There is no work posted on this ground.');
      reopen(a);
    });
    onUi('contractAbandon', (a, args) => { if (!boardOpen(a)) return; personal(a, abandonContract(a, (args || [])[0])); reopen(a); });
  }

  // The list is its own function so /contract with no words can show it, and /contracts survives as an alias
  const listContracts = (a) => {
    refresh();
    const zone = playerZone(a);
    if (!zone) return personal(a, 'No hold claims this ground, so there is no work posted here.');
    const list = zoneContracts(zone.id);
    if (!list.length) return personal(a, `${zone.name} has no work posted. Its coffers may be empty.`);
    personal(a, `Work posted in ${zone.name} (treasury ${treasuryGold(zone)} gold):`);
    list.forEach((c, i) => personal(a, `  ${i + 1}. ${describe(c)}`));
    personal(a, CFG.enabled ? 'Take one on the Contracts tab of the expedition board, or with /contract take <number>.' : OFF_TEXT);
  };

  registerChatCommand('contracts', listContracts, { hidden: true, help: 'the work posted here; /contract shows it too' });
  registerChatCommand('contract', (a, args) => {
    const parts = String(args || '').trim().split(/\s+/).filter(Boolean);
    const verb = (parts[0] || '').toLowerCase();
    const work = takenBy(a) ? copiesOf(a) : [];

    // No words: what you hold, then what is posted here. Two commands' worth in one answer.
    if (!verb) {
      if (work.length) {
        personal(a, `You hold ${work.length} of ${maxActive()} contracts:`);
        work.forEach((w, i) => personal(a, `  ${i + 1}. ${describe(w, Number(w.progress) || 0)}`));
      }
      return listContracts(a);
    }

    if (verb === 'take') {
      if (!CFG.enabled) return personal(a, OFF_TEXT);
      const zone = playerZone(a);
      if (!zone) return personal(a, 'There is no work posted on this ground.');
      const c = zoneContracts(zone.id)[Math.max(1, Number(parts[1]) || 1) - 1];
      if (!c) return personal(a, 'No such contract. /contracts lists them.');
      return personal(a, takeContract(a, c, zone));
    }

    if (verb === 'abandon') return personal(a, abandonContract(a, parts[1]));

    if (verb === 'post') {
      if (!CFG.enabled) return personal(a, OFF_TEXT);
      const zone = playerZone(a);
      if (!zone) return personal(a, 'You stand outside any hold.');
      if (!isOfficial(a, zone.id)) return personal(a, `Only an official of ${zone.name} posts work in its name.`);
      const kind = String(parts[1] || '').toLowerCase();
      const count = Math.max(1, Math.min(50, Number(parts[2]) || 0));
      const reward = Math.max(1, Math.min(10000, Number(parts[3]) || 0));
      if (!kind || !count || !reward) return personal(a, 'Use: /contract post <creature> <count> <reward>');
      if (!(kindsByZone[zone.id] || {})[kind]) return personal(a, `No ${plural(kind)} are known to roam ${zone.name}.`);
      // A hold pays for danger. Harmless quarry is not work, and no reward may run past what the risk is worth:
      // without this an official could post one chicken at 10,000 gold and empty the treasury into his own purse.
      const danger = DANGER[kind] || 0;
      if (danger <= 0) return personal(a, `${plural(kind)[0].toUpperCase()}${plural(kind).slice(1)} are no danger to anyone. ${zone.name} pays for dangerous work.`);
      const most = count * (Number(CFG.rewardPerKill[danger]) || 12);
      if (reward > most) return personal(a, `${count} ${plural(kind)} is worth at most ${most} gold. Post it for that or less.`);
      if (!escrow(zone, reward)) return personal(a, `The ${zone.name} treasury holds ${treasuryGold(zone)} gold, less than the reward.`);
      const c = { id: nextId(), zone: zone.id, kind, count, reward, held: reward, by: profileOf(a), byAccount: accountOf(a),
        postedAt: Date.now(), expiresAt: Date.now() + (Number(CFG.expiryHours) || 12) * 3600000 };
      state.contracts.push(c);
      saveNow();
      personal(a, `Posted: ${describe(c)}. The reward is set aside from the treasury until it is claimed.`);
      return audit(`CONTRACT ${who(a)} posted ${c.count} ${plural(c.kind)} for ${zone.name} at ${c.reward} gold`);
    }

    return personal(a, 'Use: /contract, /contract take <n>, /contract abandon [n], /contract post <creature> <count> <reward>.');
  }, { help: 'take or post hunting work' });

  // Contracts taken under the one-notice rule keep working, as copies with their progress
  {
    let moved = 0;
    for (const key of Object.keys(state.taken)) {
      const raw = rawList(key);
      if (!raw.some((w) => !w.kind && contractById(w.id)) && Array.isArray(state.taken[key])) continue;
      putList(key, raw.map((w) => (w.kind ? w : migrate(key, w) || w)));
      moved++;
    }
    if (moved) saveNow();
  }
  refresh();
  const posted = state.contracts.length;
  log(`contracts ${CFG.enabled ? 'on' : 'off'}: ${posted} posted across ${Object.keys(kindsByZone).length} zone(s) with known fauna, ${perZone} per zone, rewards held from the zone treasury`);
};
