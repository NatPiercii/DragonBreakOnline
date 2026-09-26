// DragonBreak Online: raids and pillage (WAR_DESIGN.md section 5). Loaded by gamemode.js.
//
// Nate, 2026-09-26: a raid needs 5 of the defending side online; the same land cannot be raided again for 3 days; during
// a raid, homes and containers can be broken into, and each gives up 3 random things and 15% of its gold. No land changes
// hands. Gold in the bank is safe.
//
// A faction's leader (or a hold's ruler) starts a raid on a territory another faction owns, from the War tab of the
// faction panel (dbo:raidStart). It lasts raidMinutes. The owner's members online are warned at once. While it lasts, a
// raider (a member of the raiding faction) who uses the door of a claimed home on that land, or one of the home's
// containers, breaks in: the take comes straight out, no lock is opened, once per home and once per container per raid.
// A home's take is 3 things across its containers plus 15% of their gold; a container's is 3 things and 15% of its gold.
// Never worn things (a container has none), never keys (keys go only to robbery's rare roll). The owner is told if online;
// every break-in and the raid itself are in the audit log for the hold's officials and staff.
'use strict';

module.exports = (api) => {
  const { mp, log, personal, system, audit, who, display, cfg, onUi, onlineActors, every, recordOf, adminItemName, sendPacket } = api;
  const C = Object.assign({ minDefendersOnline: 5, cooldownDays: 3, raidMinutes: 30, itemsPerBreakIn: 3, goldShare: 0.15 }, cfg.raids || {});
  const GOLD = 0x0000000f;
  const STEALABLE = new Set(['WEAP', 'ARMO', 'AMMO', 'MISC', 'ALCH', 'INGR', 'BOOK', 'SLGM', 'SCRL', 'LIGH']);
  const S = globalThis.__dboRaids || (globalThis.__dboRaids = { raids: [], lastRaided: {} });

  const fn = (name) => (typeof globalThis[name] === 'function' ? globalThis[name] : null);
  const info = (fid) => (fn('__dboGuildInfo') ? fn('__dboGuildInfo')(fid) : null);
  const nameOfFaction = (fid) => (info(fid) || {}).name || fid;
  const leads = (a, fid) => (fn('__dboRealmLeads') ? !!fn('__dboRealmLeads')(a, fid) : false);
  const ownerOf = (tid) => (fn('__dboRealmOwnerOf') ? fn('__dboRealmOwnerOf')(tid) : null);
  const territoryAt = (w, p) => (fn('__dboRealmTerritoryAt') ? fn('__dboRealmTerritoryAt')(w, p) : null);
  const guildsOf = (a) => (fn('__dboGuildsOf') ? fn('__dboGuildsOf')(a) || [] : []);
  // A member of a faction, as realm.js counts one (its roster, or any rank in a hold for a hold's faction)
  const memberOf = (a, fid) => (fn('__dboRealmMemberOf') ? !!fn('__dboRealmMemberOf')(a, fid) : guildsOf(a).some((g) => g.id === fid));
  const onlineOf = (fid) => onlineActors().filter((a) => memberOf(a, fid));
  const placeName = (tid) => (fn('__dboRealmTerritoryName') ? fn('__dboRealmTerritoryName')(tid) : tid);
  const get = (a, prop, fallback) => { try { const v = mp.get(a, prop); return v === undefined || v === null ? fallback : v; } catch (e) { return fallback; } };
  const typeOf = (id) => { try { const r = recordOf(id >>> 0); return r && r.record ? String(r.record.type) : ''; } catch (e) { return ''; } };
  const label = (id) => {
    try { const n = adminItemName(mp.getDescFromId(id >>> 0)); if (n) return String(n); } catch (e) { /* not in the catalog */ }
    const r = recordOf(id >>> 0);
    return String((r && r.record && r.record.editorId) || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\d+$/, '').trim() || 'something';
  };
  const active = () => { const now = Date.now(); S.raids = S.raids.filter((r) => now < r.until); return S.raids; };

  // ---- starting a raid -----------------------------------------------------------------------------------------------
  const start = (a, raider, tid) => {
    if (!leads(a, raider)) return { ok: false, text: 'Only a faction\'s leader, or a hold\'s ruler, sends a raid.' };
    const owner = ownerOf(tid);
    if (!owner) return { ok: false, text: 'There is no such land.' };
    if (owner === raider) return { ok: false, text: 'That land is your own.' };
    if (active().some((r) => r.raider === raider)) return { ok: false, text: `${nameOfFaction(raider)} is already raiding.` };
    if (active().some((r) => r.territory === tid)) return { ok: false, text: 'That land is already being raided.' };
    const last = Number(S.lastRaided[tid]) || 0;
    if (Date.now() - last < C.cooldownDays * 86400000) return { ok: false, text: `That land was raided too recently; it can be raided again in ${Math.ceil((last + C.cooldownDays * 86400000 - Date.now()) / 3600000)} hours.` };
    const defenders = onlineOf(owner).length;
    if (defenders < C.minDefendersOnline) return { ok: false, text: `A raid needs ${C.minDefendersOnline} of ${nameOfFaction(owner)} online to defend (${defenders} are).` };
    const r = { raider, owner, territory: tid, by: a >>> 0, at: Date.now(), until: Date.now() + C.raidMinutes * 60000, broken: [] };
    S.raids.push(r); S.lastRaided[tid] = r.at;
    audit(`RAID ${who(a)}: ${nameOfFaction(raider)} raids ${placeName(tid)} (${nameOfFaction(owner)}) for ${C.raidMinutes} min`);
    for (const x of onlineOf(owner)) { personal(x, `Raiders of ${nameOfFaction(raider)} are loose in ${placeName(tid)}! Homes there can be broken into for the next ${C.raidMinutes} minutes.`); try { sendPacket(x, { customPacketType: 'dboBanner', text: `Raid! ${nameOfFaction(raider)} is raiding your land`, seconds: 6 }); } catch (e) { /* old client */ } }
    for (const x of onlineOf(raider)) personal(x, `The raid is on: break into homes and containers in ${placeName(tid)} for the next ${C.raidMinutes} minutes.`);
    return { ok: true, text: `Raid under way for ${C.raidMinutes} minutes.` };
  };

  // ---- breaking in -------------------------------------------------------------------------------------------------------
  // Up to itemsPerBreakIn random things (one each) and goldShare of the gold from these containers, moved into the raider's
  // inventory: each container is written before the raider, and put back if the raider's write fails
  const loot = (raider, containers) => {
    const invs = containers.map((c) => ({ c, inv: get(c, 'inventory', null) })).filter((x) => x.inv && Array.isArray(x.inv.entries));
    if (!invs.length) return { gold: 0, items: [] };
    const before = invs.map((x) => ({ c: x.c, entries: x.inv.entries.map((e) => Object.assign({}, e)) }));
    const work = invs.map((x) => ({ c: x.c, entries: x.inv.entries.map((e) => Object.assign({}, e)) }));
    const mineInv = get(raider, 'inventory', { entries: [] });
    const mine = (Array.isArray(mineInv.entries) ? mineInv.entries : []).map((e) => Object.assign({}, e));
    const give = (entry, count) => {
      const id = Number(entry.baseId) >>> 0;
      const plainEntry = Object.keys(entry).every((k) => k === 'baseId' || k === 'count');
      const into = plainEntry ? mine.find((m) => (Number(m.baseId) >>> 0) === id && Object.keys(m).every((k) => k === 'baseId' || k === 'count')) : null;
      if (into) into.count = (Number(into.count) || 0) + count; else mine.push(Object.assign({}, entry, { count }));
    };
    let gold = 0;
    for (const w of work) {
      const have = w.entries.filter((e) => (Number(e.baseId) >>> 0) === GOLD).reduce((s, e) => s + (Number(e.count) || 0), 0);
      let take = Math.floor(have * C.goldShare); gold += take;
      for (const e of w.entries) { if ((Number(e.baseId) >>> 0) !== GOLD || take <= 0) continue; const off = Math.min(Number(e.count) || 0, take); e.count -= off; take -= off; }
    }
    if (gold > 0) give({ baseId: GOLD }, gold);
    const pool = [];
    for (const w of work) for (const e of w.entries) { const id = Number(e.baseId) >>> 0; if (id !== GOLD && (Number(e.count) || 0) > 0 && STEALABLE.has(typeOf(id))) pool.push(e); }
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const items = [];
    for (const e of pool.slice(0, C.itemsPerBreakIn)) { e.count -= 1; give(e, 1); items.push(label(Number(e.baseId) >>> 0)); }
    if (!gold && !items.length) return { gold: 0, items: [] };
    for (const w of work) { try { mp.set(w.c, 'inventory', { entries: w.entries.filter((e) => (Number(e.count) || 0) > 0) }); } catch (e) { return { error: e.message } } }
    try { mp.set(raider, 'inventory', { entries: mine }); } catch (e) {
      for (const b of before) { try { mp.set(b.c, 'inventory', { entries: b.entries }); } catch (x) { log('raids: could not put a container back', x.message); } }
      return { error: e.message };
    }
    return { gold, items };
  };

  // gamemode.js asks this first on every activation: true means a break-in happened (or was refused) and the activation ends here
  globalThis.__dboRaidActivate = (target, caster) => {
    const raids = active(); if (!raids.length) return false;
    const H = globalThis.__dboHousing; if (!H) return false;
    target >>>= 0; caster >>>= 0;
    const primary = H.primaryOf(target);
    let home = primary ? { ref: primary, rec: H.recordOf(primary) } : null;
    let container = 0;
    if (!home || !home.rec || !home.rec.owner) {
      // A container granted with a home: find the home through the registry
      home = null;
      try {
        const claimed = JSON.parse(require('fs').readFileSync(require('path').resolve('housing.json'), 'utf8'));
        for (const ref of Array.isArray(claimed) ? claimed : []) { const rec = H.recordOf(ref); if (rec && rec.owner && (rec.containers || []).map((x) => Number(x) >>> 0).includes(target)) { home = { ref: Number(ref) >>> 0, rec }; container = target; break; } }
      } catch (e) { /* no registry */ }
    }
    if (!home) return false;
    let where = null;
    for (const r of [home.ref, home.rec.partner].filter(Boolean)) { try { where = territoryAt(String(mp.get(r, 'worldOrCellDesc') || ''), mp.get(r, 'pos')); } catch (e) { /* unloaded */ } if (where) break; }
    if (!where) return false;
    const raid = raids.find((r) => r.territory === where.id && memberOf(caster, r.raider));
    if (!raid) return false;
    // A home's break-in takes from its containers not yet broken into, and counts them all as broken: no second take
    const key = container ? `c${container}` : `h${home.ref}`;
    const from = (container ? [container] : (home.rec.containers || []).map((x) => Number(x) >>> 0)).filter((c) => !raid.broken.includes(`c${c}`));
    if (raid.broken.includes(key) || !from.length) { personal(caster, 'You have already broken in here.'); return true; }
    const r = loot(caster, from);
    raid.broken.push(key, ...from.map((c) => `c${c}`));
    if (r.error) { log(`raids: break-in by ${display(caster)} failed: ${r.error}`); personal(caster, 'You force your way in, but come away with nothing.'); return true; }
    const parts = []; if (r.gold) parts.push(`${r.gold} gold`); parts.push(...r.items);
    const what = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
    personal(caster, what ? `You break in and take ${what}.` : 'You break in, but there is nothing worth taking.');
    const ownerChars = (() => { try { return (mp.getActorsByProfileId(home.rec.owner) || []).map((x) => Number(x) >>> 0); } catch (e) { return []; } })();
    for (const o of ownerChars) if (onlineActors().includes(o)) system(o, `Raiders have broken into ${home.rec.name || 'your home'}${what ? ` and taken ${what}` : ''}.`);
    audit(`RAID break-in by ${who(caster)} (${nameOfFaction(raid.raider)}) at ${container ? `container ${container.toString(16)} of ` : ''}home ${home.ref.toString(16)} (${home.rec.ownerName || home.rec.owner}): ${what || 'nothing'}`);
    return true;
  };

  every('raids', 10000, () => {
    const before = S.raids.length;
    const ended = S.raids.filter((r) => Date.now() >= r.until);
    active();
    for (const r of ended) { audit(`RAID on ${placeName(r.territory)} by ${nameOfFaction(r.raider)} ended: ${r.broken.filter((k) => k.startsWith('h')).length} home(s) broken into`); for (const x of onlineOf(r.owner).concat(onlineOf(r.raider))) personal(x, `The raid on ${placeName(r.territory)} is over.`); }
    return before;
  });

  const fromPanel = (a, args) => fn('__dboFactionNonceOk') ? fn('__dboFactionNonceOk')(a, (args || [])[0]) : false;
  const reply = (a, r) => { if (!(fn('__dboFactionRefresh') && fn('__dboFactionRefresh')(a, r.text, r.ok))) personal(a, r.text); };
  onUi('raidStart', (a, args) => { if (fromPanel(a, args)) reply(a, start(a, String(args[1] || ''), String(args[2] || ''))); });
  globalThis.__dboRaidView = () => ({ rules: { minDefendersOnline: C.minDefendersOnline, cooldownDays: C.cooldownDays, raidMinutes: C.raidMinutes },
    raids: active().map((r) => ({ raider: r.raider, raiderName: nameOfFaction(r.raider), owner: r.owner, territory: r.territory, territoryName: placeName(r.territory), until: r.until, breakIns: r.broken.filter((k) => k.startsWith('h')).length })),
    lastRaided: Object.assign({}, S.lastRaided) });

  log(`raids loaded: ${active().length} raid(s) under way`);
  return { start, loot, active };
};
