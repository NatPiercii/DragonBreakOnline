// DragonBreak Online: territories, land markers and official war (WAR_DESIGN.md sections 2, 4 and 6). Loaded by gamemode.js.
//
// Territories (territories.json) each have a land marker: a spot and a capture radius. Whoever holds the marker owns the
// territory (territory-owners.json); at first every territory belongs to its zone's hold faction. A point belongs to the
// nearest marker in its worldspace.
//
// Official war (Nate, 2026-09-26):
//   closed    war.enabled (off by default) opens it; until the holds and factions are set up in the alpha nobody declares
//             and no battle runs. The map, owners and treaties work either way.
//   muster    every online member of the declaring faction must stand at its seat: staff's (/war seat), else its capital
//             (the capital's marker within musterRadius, 3000, or inside one of its seatCells, e.g. Castle Bruma's rooms).
//   treaty    two leaders not at war may swear peace for 1 to 8 weeks; while it holds neither may declare on the other.
//   declare   a faction's leader, or a hold's ruler for the hold's faction, names a defending faction and the territories
//             it wants (the defender must own them). Both sides need minOnline (10) members online, the declarer pays
//             declareFee (10,000 gold) from its treasury, a faction younger than protectDays (7) cannot be declared on,
//             the same declarer waits redeclareDays (14) after its last war with that target, and a faction fights one
//             offensive war at a time. The declarer picks three battle windows from the staff's evening slots.
//   notice    noticeDays (7) before the first battle window. Announced to everyone online and in the audit log.
//   to death  the declarer may propose a war to the death; it is one only if the defending leader accepts before the
//             war starts. Then an enemy's killing blow on a downed fighter inside contested land during a battle window
//             ends that character (downed.js finish -> __dboWarFinish -> supernatural.js permaKill).
//   battle    only inside a battle window: attackers who stand at a contested land marker with no defender there for
//             captureSeconds (300) take it; defenders take a lost one back the same way.
//   capital   taking a hold's capital takes the hold: its officials lose their ranks, and the winning leader appoints new
//             ones (gamemode.js appointCap asks __dboConquerorLeads) and sees its treasury at the bank.
//   end       when every territory named is taken, after the last window, or by peace (a tribute from one treasury to
//             the other, accepted by the other leader) or surrender (the defender's hands the named land over).
//
// The leaders' controls are the war section of the faction panel (F3, next client package): dbo:war* events here.
// Staff see and manage wars with /war (admins only).
'use strict';

const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, system, audit, who, display, cfg, onUi, registerChatCommand, isAdmin, onlineActors, every,
    sendPacket, ranksOf, profileOf, zoneById, readOfficials, writeOfficials } = api;
  const C = Object.assign({
    minOnline: 10, declareFee: 10000, protectDays: 7, redeclareDays: 14, noticeDays: 7,
    windowsPerWar: 3, windowHours: 2,
    // Staff-set evening slots, UTC: { day: 0-6 (Sunday 0), hour, minute }. The defaults are 19:00 US Central (00:00 UTC).
    windowSlots: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, hour: 0, minute: 0 })),
    captureSeconds: 300, tickMs: 2000, defaultRadius: 1500, rulerRanks: ['jarl', 'count', 'chieftain'],
    deathWar: true,
    // Off until the holds and factions are set up during the alpha (Nate, 2026-09-26): no declarations, no battles
    enabled: false,
    // Where a faction musters to declare: a hold's capital (its marker's grounds within musterRadius, and its seatCells);
    // any other faction's seat is staff's: seats { factionId: { world, pos, radius, cells: [cell descs] } }
    musterRadius: 3000, seats: {},
    treatyMinWeeks: 1, treatyMaxWeeks: 8,
  }, cfg.war || {});
  const DAY = 86400000;
  const TERRITORIES = path.resolve('territories.json');
  const OWNERS = path.resolve('territory-owners.json');
  const WARS = path.resolve('wars.json');

  const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; } };
  // Written through a temporary file, so a crash mid-write never leaves half a file
  const writeJson = (file, value) => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(value, null, 1)); fs.renameSync(tmp, file); };

  // State kept across hot reloads; the files are read once per process
  const S = globalThis.__dboRealm || (globalThis.__dboRealm = { owners: null, wars: null, capture: new Map() });
  const territories = () => ((readJson(TERRITORIES, {}) || {}).territories || []).filter((t) => t && t.id && t.marker);
  const territory = (id) => territories().find((t) => t.id === id) || null;

  // ---- factions ------------------------------------------------------------------------------------------------------
  const info = (fid) => (typeof globalThis.__dboGuildInfo === 'function' ? globalThis.__dboGuildInfo(fid) : null);
  const guildsOf = (a) => (typeof globalThis.__dboGuildsOf === 'function' ? globalThis.__dboGuildsOf(a) || [] : []);
  const holdFactionOf = (zoneId) => (typeof globalThis.__dboHoldFactionOf === 'function' ? globalThis.__dboHoldFactionOf(zoneId) : null);
  const rulesZone = (a, zoneId) => { try { return (ranksOf(profileOf(a)) || []).some((m) => m.zone && m.zone.id === zoneId && C.rulerRanks.includes(m.rank)); } catch (e) { return false; } };
  // A member of a faction: on its roster, or (for a hold's faction) holding any rank in that hold
  const memberOf = (a, fid) => {
    if (guildsOf(a).some((g) => g.id === fid)) return true;
    const f = info(fid);
    if (f && f.kind === 'hold' && f.zone) { try { return (ranksOf(profileOf(a)) || []).some((m) => m.zone && m.zone.id === f.zone); } catch (e) { return false; } }
    return false;
  };
  // A leader: the leader rank on its roster, or (for a hold's faction) the hold's ruler
  const leads = (a, fid) => {
    if (guildsOf(a).some((g) => g.id === fid && g.role === 'leader')) return true;
    const f = info(fid);
    return !!(f && f.kind === 'hold' && f.zone && rulesZone(a, f.zone));
  };
  // Who sees a secret faction's places: its members, and (Nate, 2026-09-26) the members of any faction in its circle, so a
  // werewolf pack sees the other packs' grounds and a vampire clan the other clans'; cults see only their own
  const seesLayerOf = (a, fid) => {
    if (memberOf(a, fid)) return true;
    const circle = (info(fid) || {}).circle;
    return !!circle && guildsOf(a).some((g) => (info(g.id) || {}).circle === circle);
  };
  const factionsLedBy = (a) => {
    const out = new Set(guildsOf(a).filter((g) => g.role === 'leader').map((g) => g.id));
    try { for (const m of ranksOf(profileOf(a)) || []) if (m.zone && C.rulerRanks.includes(m.rank)) { const f = holdFactionOf(m.zone.id); if (f) out.add(f); } } catch (e) { /* none */ }
    return [...out];
  };
  const onlineOf = (fid) => onlineActors().filter((a) => memberOf(a, fid));
  const nameOfFaction = (fid) => (info(fid) || {}).name || fid;

  // ---- ownership -----------------------------------------------------------------------------------------------------
  const owners = () => {
    if (!S.owners) {
      const d = readJson(OWNERS, null);
      S.owners = d && typeof d.owners === 'object' ? d : { owners: {}, history: [] };
      if (!Array.isArray(S.owners.history)) S.owners.history = [];
    }
    return S.owners;
  };
  const ownerOf = (tid) => { const o = owners().owners[tid]; if (o && o.faction) return o.faction; const t = territory(tid); return t ? holdFactionOf(t.zone) : null; };
  const setOwner = (tid, fid, why) => {
    const prev = ownerOf(tid);
    owners().owners[tid] = { faction: fid, since: Date.now() };
    owners().history.push({ at: Date.now(), territory: tid, from: prev, to: fid, why });
    if (owners().history.length > 500) owners().history = owners().history.slice(-500);
    writeJson(OWNERS, owners());
    audit(`REALM ${territory(tid) ? territory(tid).name : tid} passes from ${nameOfFaction(prev)} to ${nameOfFaction(fid)} (${why})`);
    const t = territory(tid);
    if (t && t.kind === 'capital' && prev !== fid) onCapitalTaken(t, prev, fid);
  };
  const territoriesOf = (fid) => territories().filter((t) => ownerOf(t.id) === fid);
  const worldOf = (a) => { try { return String(mp.get(a, 'worldOrCellDesc') || ''); } catch (e) { return ''; } };
  const posOf = (a) => { try { return mp.get(a, 'pos'); } catch (e) { return null; } };
  const sameWorld = (w, desc) => { try { return (mp.getIdFromDesc(w) >>> 0) === (mp.getIdFromDesc(desc) >>> 0); } catch (e) { return w === desc; } };
  // The territory a point belongs to: the nearest land marker in that worldspace
  const territoryAt = (world, pos) => {
    if (!Array.isArray(pos)) return null;
    let best = null; let bestD = Infinity;
    for (const t of territories()) {
      if (!sameWorld(world, t.marker.world)) continue;
      const d = Math.hypot(pos[0] - t.marker.pos[0], pos[1] - t.marker.pos[1]);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  };
  const atMarker = (a, t) => {
    const p = posOf(a);
    if (!Array.isArray(p) || !sameWorld(worldOf(a), t.marker.world)) return false;
    return Math.hypot(p[0] - t.marker.pos[0], p[1] - t.marker.pos[1], p[2] - t.marker.pos[2]) <= (t.marker.radius || C.defaultRadius);
  };

  // Taking a capital takes the hold: its officials lose their ranks; the winner's leader appoints new ones
  const onCapitalTaken = (t, prev, fid) => {
    const zone = zoneById(t.zone);
    try {
      const o = readOfficials();
      if (o && o[t.zone]) { delete o[t.zone]; writeOfficials(o); }
    } catch (e) { log('realm: officials could not be cleared', e.message); }
    audit(`REALM ${nameOfFaction(fid)} took ${zone ? zone.name : t.zone}; its officials lost their ranks`);
    for (const a of onlineActors()) system(a, `${nameOfFaction(fid)} has taken ${t.name}. ${zone ? zone.name : 'The hold'} has fallen, and its officials are stripped of their ranks.`);
  };
  // A conqueror: the leader of a faction that holds a hold's capital and is not that hold's own faction
  globalThis.__dboConquerorLeads = (a, zoneId) => {
    const cap = territories().find((t) => t.zone === zoneId && t.kind === 'capital');
    if (!cap) return false;
    const fid = ownerOf(cap.id);
    return !!fid && fid !== holdFactionOf(zoneId) && leads(a, fid);
  };
  globalThis.__dboConqueredZonesLedBy = (a) => [...new Set(territories().filter((t) => t.kind === 'capital').map((t) => t.zone))].filter((z) => globalThis.__dboConquerorLeads(a, z));

  // ---- wars ----------------------------------------------------------------------------------------------------------
  const wars = () => {
    if (!S.wars) { const d = readJson(WARS, null); S.wars = d && Array.isArray(d.wars) ? d : { wars: [], nextId: 1 }; }
    return S.wars;
  };
  const saveWars = () => writeJson(WARS, wars());
  const live = () => wars().wars.filter((w) => w.status !== 'ended');
  const warOf = (fid) => live().filter((w) => w.attacker === fid || w.defender === fid);
  const inWindow = (w, now) => (w.windows || []).some((x) => now >= x.start && now < x.end);
  const lastEnd = (w) => Math.max(...(w.windows || []).map((x) => x.end), 0);

  // The next occurrences of the staff's slots from `from`, one per slot and day
  const slotsFrom = (from) => {
    const out = [];
    for (let d = 0; d < 14; d++) {
      const day = new Date(from + d * DAY);
      for (const s of C.windowSlots) {
        if (day.getUTCDay() !== s.day) continue;
        const start = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), s.hour || 0, s.minute || 0);
        if (start >= from) out.push(start);
      }
    }
    return [...new Set(out)].sort((x, y) => x - y);
  };
  const windowChoices = (declaredAt) => slotsFrom(declaredAt + C.noticeDays * DAY).slice(0, 7);

  // ---- mustering at the capital ----------------------------------------------------------------------------------------
  // A faction's seat: one staff set (/war seat, or config war.seats), else a hold's capital territory (its marker's grounds
  // and its seatCells), else a capital the faction has taken
  const seatOf = (fid) => {
    const s = (wars().seats || {})[fid] || (C.seats || {})[fid];
    if (s && s.world && Array.isArray(s.pos)) return { name: s.name || nameOfFaction(fid), world: s.world, pos: s.pos, radius: s.radius || C.musterRadius, cells: s.cells || [] };
    const f = info(fid);
    const cap = territories().find((t) => t.kind === 'capital' && (f && f.zone ? t.zone === f.zone : ownerOf(t.id) === fid));
    return cap ? { name: cap.name, world: cap.marker.world, pos: cap.marker.pos, radius: C.musterRadius, cells: cap.seatCells || [] } : null;
  };
  const atSeat = (a, seat) => {
    const w = worldOf(a);
    if ((seat.cells || []).some((c) => sameWorld(w, c))) return true;
    const p = posOf(a);
    return Array.isArray(p) && sameWorld(w, seat.world) && Math.hypot(p[0] - seat.pos[0], p[1] - seat.pos[1], p[2] - seat.pos[2]) <= seat.radius;
  };
  // Nate, 2026-09-26: every online member of the declaring side must be at its capital
  const musterRefusal = (fid) => {
    const seat = seatOf(fid);
    if (!seat) return `${nameOfFaction(fid)} has no seat to muster at; staff must set one before it can declare war.`;
    const away = onlineOf(fid).filter((x) => !atSeat(x, seat));
    return away.length ? `Every member of ${nameOfFaction(fid)} who is online must be at ${seat.name} to declare war (${away.length} ${away.length === 1 ? 'is' : 'are'} elsewhere).` : '';
  };

  // ---- peace treaties ------------------------------------------------------------------------------------------------------
  // Two factions not at war may bind themselves to peace for some weeks; while it holds, neither may declare on the other
  const treaties = () => { const d = wars(); if (!Array.isArray(d.treaties)) d.treaties = []; if (!Array.isArray(d.offers)) d.offers = []; d.treaties = d.treaties.filter((t) => Date.now() < t.until); return d.treaties; };
  const treatyBetween = (x, y) => treaties().find((t) => (t.a === x && t.b === y) || (t.a === y && t.b === x)) || null;
  const offerTreaty = (a, from, to, weeks) => {
    if (!leads(a, from)) return { ok: false, text: 'Only a faction\'s leader, or a hold\'s ruler, offers a treaty.' };
    if (!info(to) || to === from) return { ok: false, text: 'There is no such faction.' };
    weeks = Math.floor(Number(weeks) || 0);
    if (weeks < C.treatyMinWeeks || weeks > C.treatyMaxWeeks) return { ok: false, text: `A treaty runs from ${C.treatyMinWeeks} to ${C.treatyMaxWeeks} weeks.` };
    if (live().some((w) => (w.attacker === from && w.defender === to) || (w.attacker === to && w.defender === from))) return { ok: false, text: 'You are at war with them; offer peace in the war itself.' };
    treaties();
    const d = wars();
    d.offers = d.offers.filter((o) => !(o.from === from && o.to === to));
    d.offers.push({ id: (d.nextOffer = (d.nextOffer || 0) + 1), from, to, weeks, at: Date.now() });
    saveWars();
    for (const x of onlineActors().filter((q) => leads(q, to))) personal(x, `${nameOfFaction(from)} offers ${nameOfFaction(to)} a peace treaty for ${weeks} week${weeks > 1 ? 's' : ''}. Answer in the faction panel (F3).`);
    audit(`WAR ${who(a)} offers a ${weeks}-week peace treaty from ${nameOfFaction(from)} to ${nameOfFaction(to)}`);
    return { ok: true, text: 'Treaty offered.' };
  };
  const answerTreaty = (a, id, accept) => {
    treaties();
    const d = wars(); const o = d.offers.find((x) => x.id === Number(id));
    if (!o) return { ok: false, text: 'There is no such offer.' };
    if (!leads(a, o.to)) return { ok: false, text: 'Only the other side\'s leader answers.' };
    d.offers = d.offers.filter((x) => x !== o);
    if (accept) {
      d.treaties = d.treaties.filter((t) => !((t.a === o.from && t.b === o.to) || (t.a === o.to && t.b === o.from)));
      d.treaties.push({ a: o.from, b: o.to, since: Date.now(), until: Date.now() + o.weeks * 7 * DAY });
      announce(`${nameOfFaction(o.from)} and ${nameOfFaction(o.to)} have sworn peace for ${o.weeks} week${o.weeks > 1 ? 's' : ''}.`);
    }
    saveWars();
    audit(`WAR ${who(a)} ${accept ? 'accepted' : 'refused'} the treaty offered by ${nameOfFaction(o.from)}`);
    return { ok: true, text: accept ? 'Peace is sworn.' : 'You refuse the treaty.' };
  };

  // Why `a` may not declare this war now, or ''
  const declareRefusal = (a, attacker, defender, goal) => {
    if (!C.enabled) return 'War is closed during the alpha, until the holds and factions are set up.';
    if (!attacker || !leads(a, attacker)) return 'Only a faction\'s leader, or a hold\'s ruler, declares war.';
    if (!info(defender)) return 'There is no such faction.';
    if (defender === attacker) return 'A faction cannot declare war on itself.';
    if (live().some((w) => w.attacker === attacker)) return `${nameOfFaction(attacker)} already fights a war it declared.`;
    if (live().some((w) => (w.attacker === attacker && w.defender === defender) || (w.attacker === defender && w.defender === attacker))) return 'These two are already at war.';
    const pact = treatyBetween(attacker, defender);
    if (pact) return `${nameOfFaction(attacker)} is sworn to peace with ${nameOfFaction(defender)} until ${whenText(pact.until)}.`;
    const owned = territoriesOf(defender).map((t) => t.id);
    if (!goal.length) return 'Name the land you mean to take.';
    const bad = goal.filter((g) => !owned.includes(g));
    if (bad.length) return `${nameOfFaction(defender)} does not hold ${bad.map((g) => (territory(g) || { name: g }).name).join(', ')}.`;
    const since = typeof globalThis.__dboGuildFoundedAt === 'function' ? globalThis.__dboGuildFoundedAt(defender) : 0;
    if (since && Date.now() - since < C.protectDays * DAY) return `${nameOfFaction(defender)} is new and cannot be declared on for its first ${C.protectDays} days.`;
    const last = wars().wars.filter((w) => w.status === 'ended' && w.attacker === attacker && w.defender === defender).map((w) => w.endedAt || 0);
    if (last.length && Date.now() - Math.max(...last) < C.redeclareDays * DAY) return `${nameOfFaction(attacker)} fought ${nameOfFaction(defender)} too recently.`;
    const mine = onlineOf(attacker).length, theirs = onlineOf(defender).length;
    if (mine < C.minOnline) return `${C.minOnline} of ${nameOfFaction(attacker)} must be online to declare war (${mine} are).`;
    if (theirs < C.minOnline) return `${C.minOnline} of ${nameOfFaction(defender)} must be online to receive a declaration (${theirs} are).`;
    const muster = musterRefusal(attacker);
    if (muster) return muster;
    const treasury = globalThis.__dboTreasury;
    if (!treasury) return 'The treasuries are closed.';
    if (treasury.balance(attacker) < C.declareFee) return `Declaring war costs ${C.declareFee} gold from ${nameOfFaction(attacker)}'s treasury.`;
    return '';
  };

  const announce = (text) => { for (const a of onlineActors()) { system(a, text); try { sendPacket(a, { customPacketType: 'dboBanner', text, seconds: 6 }); } catch (e) { /* old client */ } } };
  const whenText = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  // Returns { ok, text, war }
  const declare = (a, attacker, defender, goal, picks, toDeath) => {
    goal = [...new Set((goal || []).map(String))];
    const why = declareRefusal(a, attacker, defender, goal);
    if (why) return { ok: false, text: why };
    const now = Date.now();
    const choices = windowChoices(now);
    const chosen = [...new Set((picks || []).map(Number))].filter((x) => choices.includes(x)).slice(0, C.windowsPerWar);
    for (const c of choices) { if (chosen.length >= C.windowsPerWar) break; if (!chosen.includes(c)) chosen.push(c); }
    chosen.sort((x, y) => x - y);
    if (chosen.length < C.windowsPerWar) return { ok: false, text: 'There are not enough battle windows after the notice; staff must set more evening slots.' };
    if (!globalThis.__dboTreasury.spend(attacker, C.declareFee, `war declared on ${defender}`)) return { ok: false, text: 'The treasury could not pay the declaration.' };
    const w = {
      id: wars().nextId++, attacker, defender, goal, declaredBy: profileOf(a), declaredAt: now, startsAt: chosen[0],
      windows: chosen.map((start) => ({ start, end: start + C.windowHours * 3600000 })),
      death: toDeath && C.deathWar ? 'proposed' : null, status: 'notice', captures: [], endedAt: 0, outcome: '',
    };
    wars().wars.push(w);
    saveWars();
    const land = goal.map((g) => territory(g).name).join(', ');
    audit(`WAR ${w.id} declared by ${who(a)}: ${nameOfFaction(attacker)} on ${nameOfFaction(defender)} for ${land}; windows ${w.windows.map((x) => whenText(x.start)).join(', ')}${w.death ? '; proposed to the death' : ''}`);
    announce(`${nameOfFaction(attacker)} declares war on ${nameOfFaction(defender)} for ${land}. The first battle is ${whenText(w.startsAt)}.`);
    if (w.death) for (const d of onlineActors().filter((x) => leads(x, defender))) personal(d, `${nameOfFaction(attacker)} proposes a war to the death. Accept or refuse it in the faction panel (F3) before the first battle.`);
    return { ok: true, text: `War declared. The first battle window opens ${whenText(w.startsAt)}.`, war: w };
  };

  const answerDeath = (a, id, accept) => {
    const w = live().find((x) => x.id === Number(id));
    if (!w || w.death !== 'proposed') return { ok: false, text: 'There is no proposal to answer.' };
    if (!leads(a, w.defender)) return { ok: false, text: 'Only the defending leader answers.' };
    if (Date.now() >= w.startsAt) return { ok: false, text: 'The war has begun; it is too late to answer.' };
    w.death = accept ? 'accepted' : 'refused';
    saveWars();
    audit(`WAR ${w.id}: ${who(a)} ${accept ? 'accepted' : 'refused'} a war to the death`);
    announce(accept ? `The war between ${nameOfFaction(w.attacker)} and ${nameOfFaction(w.defender)} will be fought to the death.` : `${nameOfFaction(w.defender)} refuses to fight ${nameOfFaction(w.attacker)} to the death.`);
    return { ok: true, text: accept ? 'You accept a war to the death.' : 'You refuse a war to the death.' };
  };

  const endWar = (w, outcome) => {
    w.status = 'ended'; w.endedAt = Date.now(); w.outcome = outcome;
    for (const k of [...S.capture.keys()]) if (k.startsWith(`${w.id}:`)) S.capture.delete(k);
    saveWars();
    audit(`WAR ${w.id} ended: ${outcome}`);
    announce(`The war between ${nameOfFaction(w.attacker)} and ${nameOfFaction(w.defender)} is over: ${outcome}.`);
  };

  // Peace: a tribute from the proposer's treasury (or the other's, when they ask for one), accepted by the other leader
  const proposePeace = (a, id, tribute, payer) => {
    const w = live().find((x) => x.id === Number(id));
    if (!w) return { ok: false, text: 'There is no such war.' };
    const side = leads(a, w.attacker) ? w.attacker : leads(a, w.defender) ? w.defender : null;
    if (!side) return { ok: false, text: 'Only the leaders of the two sides make peace.' };
    tribute = Math.max(0, Math.floor(Number(tribute) || 0));
    const from = payer === 'them' ? (side === w.attacker ? w.defender : w.attacker) : side;
    w.peace = { by: side, from, tribute, at: Date.now() };
    saveWars();
    const other = side === w.attacker ? w.defender : w.attacker;
    for (const d of onlineActors().filter((x) => leads(x, other))) personal(d, `${nameOfFaction(side)} offers peace${tribute ? `: ${tribute} gold paid by ${nameOfFaction(from)}` : ''}. Answer in the faction panel (F3).`);
    audit(`WAR ${w.id}: ${who(a)} offers peace (${tribute} gold from ${from})`);
    return { ok: true, text: 'Peace offered.' };
  };
  const answerPeace = (a, id, accept) => {
    const w = live().find((x) => x.id === Number(id));
    if (!w || !w.peace) return { ok: false, text: 'There is no offer to answer.' };
    const other = w.peace.by === w.attacker ? w.defender : w.attacker;
    if (!leads(a, other)) return { ok: false, text: 'Only the other side\'s leader answers.' };
    if (!accept) { w.peace = null; saveWars(); audit(`WAR ${w.id}: ${who(a)} refused peace`); return { ok: true, text: 'You refuse the peace.' }; }
    const { from, tribute } = w.peace;
    const to = from === w.attacker ? w.defender : w.attacker;
    if (tribute > 0) {
      if (!globalThis.__dboTreasury.spend(from, tribute, `peace tribute to ${to}`)) return { ok: false, text: `${nameOfFaction(from)}'s treasury cannot pay ${tribute} gold.` };
      globalThis.__dboTreasury.deposit(to, tribute, `peace tribute from ${from}`);
    }
    endWar(w, `peace${tribute ? `, ${nameOfFaction(from)} paying ${tribute} gold` : ''}`);
    return { ok: true, text: 'Peace is made.' };
  };
  const surrender = (a, id) => {
    const w = live().find((x) => x.id === Number(id));
    if (!w) return { ok: false, text: 'There is no such war.' };
    if (leads(a, w.defender)) {
      for (const g of w.goal) if (ownerOf(g) !== w.attacker) setOwner(g, w.attacker, `surrender in war ${w.id}`);
      endWar(w, `${nameOfFaction(w.defender)} surrendered and gave up ${w.goal.map((g) => territory(g).name).join(', ')}`);
      return { ok: true, text: 'You surrender.' };
    }
    if (leads(a, w.attacker)) { endWar(w, `${nameOfFaction(w.attacker)} withdrew`); return { ok: true, text: 'You withdraw from the war.' }; }
    return { ok: false, text: 'Only the leaders of the two sides can surrender.' };
  };

  // ---- battle: capture at the markers ------------------------------------------------------------------------------------
  const tick = () => {
    if (!C.enabled) return;
    const now = Date.now();
    for (const w of live()) {
      if (w.status === 'notice' && now >= w.startsAt) { w.status = 'active'; saveWars(); announce(`War: ${nameOfFaction(w.attacker)} against ${nameOfFaction(w.defender)}. The first battle window is open.`); }
      if (w.status !== 'active') continue;
      if (w.goal.every((g) => ownerOf(g) === w.attacker)) { endWar(w, `${nameOfFaction(w.attacker)} took everything it fought for`); continue; }
      if (now >= lastEnd(w)) { endWar(w, `the last battle window closed with ${w.captures.length} capture(s)`); continue; }
      if (!inWindow(w, now)) continue;
      for (const tid of w.goal) {
        const t = territory(tid); if (!t) continue;
        const holder = ownerOf(tid);
        const attackers = onlineOf(w.attacker).filter((x) => atMarker(x, t) && !isDownedOrDead(x));
        const defenders = onlineOf(w.defender).filter((x) => atMarker(x, t) && !isDownedOrDead(x));
        const taker = holder === w.defender ? w.attacker : holder === w.attacker ? w.defender : null;
        const takers = taker === w.attacker ? attackers : defenders;
        const holders = taker === w.attacker ? defenders : attackers;
        const key = `${w.id}:${tid}`;
        const c = S.capture.get(key) || { seconds: 0, taker, announced: false };
        if (c.taker !== taker) { c.seconds = 0; c.taker = taker; c.announced = false; }
        if (takers.length && !holders.length) {
          c.seconds += C.tickMs / 1000;
          if (!c.announced) { c.announced = true; for (const x of onlineOf(w.attacker).concat(onlineOf(w.defender))) personal(x, `${nameOfFaction(taker)} raises its standard at ${t.name}.`); }
          if (c.seconds >= C.captureSeconds) {
            S.capture.delete(key);
            w.captures.push({ territory: tid, by: taker, at: now });
            saveWars();
            setOwner(tid, taker, `captured in war ${w.id}`);
            announce(`${nameOfFaction(taker)} has taken ${t.name}.`);
            continue;
          }
        } else if (holders.length && c.seconds > 0) {
          c.seconds = 0; c.announced = false;
          for (const x of onlineOf(w.attacker).concat(onlineOf(w.defender))) personal(x, `The standard at ${t.name} is torn down.`);
        }
        S.capture.set(key, c);
      }
    }
  };
  const isDownedOrDead = (a) => { try { return mp.get(a, 'isDead') === true; } catch (e) { return true; } };

  // ---- war to the death ----------------------------------------------------------------------------------------------------
  // downed.js asks this when an enemy finishes a downed player; true means the character died for good
  globalThis.__dboWarFinish = (victim, killer) => {
    const now = Date.now();
    for (const w of live()) {
      if (w.death !== 'accepted' || w.status !== 'active' || !inWindow(w, now)) continue;
      const sides = [[w.attacker, w.defender], [w.defender, w.attacker]];
      const hit = sides.find(([v, k]) => memberOf(victim, v) && memberOf(killer, k));
      if (!hit) continue;
      const here = territoryAt(worldOf(victim), posOf(victim));
      if (!here || !w.goal.includes(here.id)) continue;
      if (typeof globalThis.__dboPermaKill !== 'function') { log('realm: a war-to-the-death kill, but permaKill is not loaded'); return false; }
      globalThis.__dboPermaKill(victim, `killed by ${display(killer)} in the war to the death between ${nameOfFaction(w.attacker)} and ${nameOfFaction(w.defender)}`);
      // Only a character that really went counts; otherwise downed.js wakes them at the temple as usual (Worker B)
      let gone = false; try { gone = mp.get(victim, 'private.permaDead') === true; } catch (e) { gone = false; }
      if (!gone) { log(`realm: war-to-the-death kill of ${display(victim)} did not take; waking at the temple instead`); return false; }
      audit(`WAR ${w.id}: ${who(killer)} killed ${who(victim)} in a war to the death`);
      return true;
    }
    return false;
  };

  // ---- the faction panel's war section (dbo:war* events), and what it shows ------------------------------------------------
  const warView = (w) => ({
    id: w.id, attacker: w.attacker, attackerName: nameOfFaction(w.attacker), defender: w.defender, defenderName: nameOfFaction(w.defender),
    goal: w.goal.map((g) => ({ id: g, name: (territory(g) || { name: g }).name, owner: nameOfFaction(ownerOf(g)) })),
    status: w.status, startsAt: w.startsAt, windows: w.windows, death: w.death, peace: w.peace || null, captures: w.captures.length,
  });
  const realmView = (a) => {
    const led = factionsLedBy(a);
    return {
      territories: territories().map((t) => ({ id: t.id, name: t.name, kind: t.kind, owner: ownerOf(t.id), ownerName: nameOfFaction(ownerOf(t.id)),
        world: t.marker.world, x: t.marker.pos[0], y: t.marker.pos[1], icon: Number.isFinite(t.icon) ? t.icon : null })),
      // Hidden layers: only members of a listed secret faction (and staff) are sent these
      secret: ((readJson(TERRITORIES, {}) || {}).secret || []).filter((t) => t && t.marker && Array.isArray(t.layer) && (isAdmin(a) || t.layer.some((f) => seesLayerOf(a, f))))
        .map((t) => ({ id: t.id, name: t.name, kind: t.kind || 'secret', layer: t.layer.filter((f) => isAdmin(a) || seesLayerOf(a, f)).map(nameOfFaction), x: t.marker.pos[0], y: t.marker.pos[1] })),
      // Map colours by faction: staff's lore table (config war.colours); a faction not in it shows grey until one is set
      colours: Object.assign({}, C.colours || {}),
      wars: live().filter((w) => memberOf(a, w.attacker) || memberOf(a, w.defender) || isAdmin(a)).map(warView),
      leads: led.map((fid) => { const seat = seatOf(fid); const on = onlineOf(fid); return { id: fid, name: nameOfFaction(fid), treasury: globalThis.__dboTreasury ? globalThis.__dboTreasury.balance(fid) : 0, online: on.length, seat: seat ? seat.name : '', atSeat: seat ? on.filter((x) => atSeat(x, seat)).length : 0 }; }),
      rules: { enabled: !!C.enabled, minOnline: C.minOnline, declareFee: C.declareFee, noticeDays: C.noticeDays, windowsPerWar: C.windowsPerWar, windowHours: C.windowHours, deathWar: C.deathWar, treatyMinWeeks: C.treatyMinWeeks, treatyMaxWeeks: C.treatyMaxWeeks },
      treaties: treaties().filter((t) => isAdmin(a) || memberOf(a, t.a) || memberOf(a, t.b)).map((t) => ({ a: t.a, aName: nameOfFaction(t.a), b: t.b, bName: nameOfFaction(t.b), until: t.until })),
      offers: (wars().offers || []).filter((o) => led.includes(o.to) || led.includes(o.from)).map((o) => ({ id: o.id, from: o.from, fromName: nameOfFaction(o.from), to: o.to, toName: nameOfFaction(o.to), weeks: o.weeks, mine: led.includes(o.to) })),
      // The factions a leader may offer a treaty to: every one that is not secret, and the land's owners
      factions: led.length ? [...new Set((typeof globalThis.__dboFactionList === 'function' ? globalThis.__dboFactionList() : []).concat(territories().map((t) => ownerOf(t.id)), led))].filter(Boolean).map((fid) => ({ id: fid, name: nameOfFaction(fid) })) : [],
      windowChoices: led.length ? windowChoices(Date.now()) : [],
      raids: typeof globalThis.__dboRaidView === 'function' ? globalThis.__dboRaidView() : null,
    };
  };
  globalThis.__dboRealmView = realmView;
  // For economy.js: whose land a point is on, and who leads a faction
  globalThis.__dboRealmTerritoryAt = (world, pos) => territoryAt(world, pos);
  globalThis.__dboRealmOwnerOf = (tid) => ownerOf(tid);
  globalThis.__dboRealmLeads = (a, fid) => leads(a, fid);
  globalThis.__dboRealmMemberOf = (a, fid) => memberOf(a, fid);
  globalThis.__dboRealmTerritoryName = (tid) => (territory(tid) || { name: tid }).name;
  globalThis.__dboRealmFactionsLedBy = (a) => factionsLedBy(a);
  globalThis.__dboRealmTerritoriesOf = (fid) => territoriesOf(fid).map((t) => t.id);
  const reply = (a, r) => { if (!(typeof globalThis.__dboFactionRefresh === 'function' && globalThis.__dboFactionRefresh(a, r.text, r.ok))) personal(a, r.text); };
  // Every war action comes from the faction panel with its nonce first, so a stale window cannot act
  const fromPanel = (a, args) => typeof globalThis.__dboFactionNonceOk === 'function' && globalThis.__dboFactionNonceOk(a, (args || [])[0]);
  onUi('warDeclare', (a, args) => { if (!fromPanel(a, args)) return; const [, attacker, defender, goal, picks, toDeath] = args; reply(a, declare(a, String(attacker || ''), String(defender || ''), Array.isArray(goal) ? goal : [], Array.isArray(picks) ? picks : [], !!toDeath)); });
  onUi('warDeath', (a, args) => { if (fromPanel(a, args)) reply(a, answerDeath(a, args[1], !!args[2])); });
  onUi('warPeace', (a, args) => { if (fromPanel(a, args)) reply(a, proposePeace(a, args[1], args[2], args[3])); });
  onUi('warPeaceAnswer', (a, args) => { if (fromPanel(a, args)) reply(a, answerPeace(a, args[1], !!args[2])); });
  onUi('warSurrender', (a, args) => { if (fromPanel(a, args)) reply(a, surrender(a, args[1])); });
  onUi('treatyOffer', (a, args) => { if (fromPanel(a, args)) reply(a, offerTreaty(a, String(args[1] || ''), String(args[2] || ''), args[3])); });
  onUi('treatyAnswer', (a, args) => { if (fromPanel(a, args)) reply(a, answerTreaty(a, args[1], !!args[2])); });

  // ---- staff ---------------------------------------------------------------------------------------------------------------
  registerChatCommand('war', (a, args) => {
    const [sub, x, y] = String(args || '').trim().split(/\s+/);
    if (sub === 'owner' && x && y) { if (!territory(x) || !info(y)) return personal(a, 'Usage: /war owner <territory> <faction id>'); setOwner(x, y, `set by ${display(a)}`); return personal(a, `${territory(x).name} now belongs to ${nameOfFaction(y)}.`); }
    if (sub === 'seat' && x) {
      if (!info(x)) return personal(a, 'Usage: /war seat <faction id> [clear], standing where it musters');
      const d = wars(); d.seats = d.seats || {};
      if (y === 'clear') { delete d.seats[x]; saveWars(); return personal(a, `${nameOfFaction(x)} has no seat of its own now.`); }
      const p = posOf(a); const w = worldOf(a);
      if (!Array.isArray(p) || !w) return personal(a, 'Your position is unknown.');
      d.seats[x] = { name: `${nameOfFaction(x)}'s seat`, world: w, pos: p.map((v) => Math.round(v)), radius: C.musterRadius, cells: [] };
      saveWars(); audit(`WAR seat of ${x} set by ${who(a)} at ${w} ${d.seats[x].pos.join(',')}`);
      return personal(a, `${nameOfFaction(x)} musters here now, within ${C.musterRadius} units.`);
    }
    if (sub === 'end' && x) { const w = live().find((q) => q.id === Number(x)); if (!w) return personal(a, 'No such war.'); endWar(w, `ended by staff (${display(a)})`); return personal(a, 'Ended.'); }
    personal(a, `Territories: ${territories().map((t) => `${t.name} (${nameOfFaction(ownerOf(t.id))})`).join(', ') || 'none'}`);
    const ws = live();
    personal(a, ws.length ? ws.map((w) => `#${w.id} ${nameOfFaction(w.attacker)} vs ${nameOfFaction(w.defender)} [${w.status}] for ${w.goal.join(', ')}; windows ${w.windows.map((q) => whenText(q.start)).join(', ')}${w.death ? `; death ${w.death}` : ''}`).join(' | ') : 'No wars.');
    const ts = treaties();
    if (ts.length) personal(a, `Treaties: ${ts.map((t) => `${nameOfFaction(t.a)} and ${nameOfFaction(t.b)} until ${whenText(t.until)}`).join(' | ')}`);
    personal(a, `War is ${C.enabled ? 'open' : 'closed (war.enabled is off)'}. Staff: /war owner <territory> <faction id>, /war end <war id>, /war seat <faction id> [clear]`);
  }, { admin: true, help: '[owner <territory> <faction> | end <id> | seat <faction> [clear]] territories, owners, wars and seats' });

  every('realm', C.tickMs, () => { try { tick(); } catch (e) { log('realm: tick failed', e.message); } });
  log(`realm loaded: ${territories().length} territories, ${live().length} war(s) under way, war ${C.enabled ? 'OPEN' : 'closed (war.enabled false)'}`);
  return { declare, answerDeath, proposePeace, answerPeace, surrender, tick, ownerOf, territoryAt, realmView, declareRefusal, windowChoices, setOwner, offerTreaty, answerTreaty, seatOf, musterRefusal };
};
