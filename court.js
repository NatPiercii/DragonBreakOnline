// DragonBreak Online: the Court tab of the F3 journal (design ~/claude-nate-release/specs/f3-hub-design.md 3.6, piece H9;
// Nate accepted the recommendations on 3 Oct 2026). Loaded by gamemode.js after guilds.js and journal.js.
//
// A court is a zone of zones.json (a hold, a stronghold or a region; Bruma is the region ruled by a Count). The tab shows
// its offices (officials.json, seats per profile id) and its household (the zone's hold or stronghold faction in
// guild-defs.json, ranks per character). The office is the source of truth: seating someone sets their household rank to
// the office's (config court.factionRanks), and unseating drops it to the lowest rank (gamemode.js seatOfficial and
// unseatOfficial call __dboCourtOfficeSync). The rules of /appoint exist once, in gamemode.js (appointCheck): the tab
// and the chat commands both call them.
// A ruler's appointment is an offer the target accepts here; staff appoint outright (Nate, Q4). Offers live 24 hours in
// court-offers.json (runtime, gitignored) and the target is told in chat, never by a pushed widget.
//
// Journal contract (H1 shell, journal.js): __dboJournalSections.court = { visible(a), view(a, opts) } puts the section at
// payload.court; the events below carry the journal nonce first (__dboJournalFresh) and answer through __dboJournalLimited
// (the 3 s rule), which redraws the tab with the result line.
//   courtAppoint [nonce, zoneId, nameOrTag, rank]   staff seat outright, anyone else offers
//   courtOffer   [nonce, zoneId, nameOrTag, rank]   always an offer
//   courtDismiss [nonce, zoneId, profileId]
//   courtMove    [nonce, zoneId, profileId, rank]   a serving official moves to another office of the same court
//   courtAnswer  [nonce, offerId, 'accept'|'decline']
//   courtWithdraw [nonce, offerId]                  the one who offered, or staff
//   courtRank    [nonce, zoneId, actorId, rank]     the household's ranks (guilds.js rules)
//   courtKick    [nonce, zoneId, actorId]
//   courtInvite  [nonce, zoneId, nameOrTag]
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, system, audit, who, display, nameOf, tagOf, onUi, onlineActors, isAdmin, profileOf, cfg,
    zoneList, zoneById, readOfficials, rankTitle, appointCap, appointCheck, appointFrom, seatOfficial, unseatOfficial,
    officialTarget, officialName, accountActors, ranksOf, APPOINT_RULES, findByName } = api;
  const personal = typeof api.personal === 'function' ? api.personal : () => {};
  const C = Object.assign({
    enabled: true, offerHours: 24,
    // office -> the household rank titles it maps to, the first the faction has ('@leader': the faction's leader rank).
    // An office with none (Bane) only makes sure its holder is in the household.
    factionRanks: {
      jarl: ['@leader'], count: ['@leader'], baron: ['@leader'], chieftain: ['@leader'], steward: ['Steward'],
      guardcaptain: ['Guard Captain'], captain: ['Guard Captain'], commander: ['Guard Captain'],
      strongholdcommander: ['Stronghold Guard Commander'],
      courtmage: ['Court Wizard', 'Battlemage'], shaman: ['Clan Mystic'], wisewoman: ['Clan Mystic'],
      guard: ['Guard', 'Stronghold Guard'], strongholdguard: ['Stronghold Guard'],
    },
  }, (cfg && cfg.court) || {});
  const OFFERS_PATH = path.resolve('court-offers.json');
  const readJson = (p, dflt) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return dflt; } };
  const S = globalThis.__dboCourt || (globalThis.__dboCourt = { offers: readJson(OFFERS_PATH, []), seq: 0 });
  if (!Array.isArray(S.offers)) S.offers = [];
  // actor -> the court last acted in, so the redraw after an action shows it
  if (!(S.lastZone instanceof Map)) S.lastZone = new Map();
  const OFFER_MS = Math.max(1, Number(C.offerHours) || 24) * 3600000;
  const live = () => S.offers.filter((o) => o && Date.now() - Number(o.at) < OFFER_MS);
  const saveOffers = () => {
    S.offers = live();
    try { fs.writeFileSync(OFFERS_PATH + '.tmp', JSON.stringify(S.offers, null, 1)); fs.renameSync(OFFERS_PATH + '.tmp', OFFERS_PATH); }
    catch (e) { log('court-offers.json write failed', e.message); }
  };
  const isOnline = (a) => onlineActors().includes(a >>> 0);
  // An open journal on the Court tab shows a new offer at once (no redraw on another tab: it would take the caret)
  const redrawCourt = (t) => {
    try { if (t && typeof globalThis.__dboJournalTabOf === 'function' && globalThis.__dboJournalTabOf(t) === 'court' && typeof globalThis.__dboJournalRedraw === 'function') globalThis.__dboJournalRedraw(t, 'court'); }
    catch (e) { log('court: redraw failed', e.message); }
  };
  const onlineOf = (pid) => onlineActors().find((x) => profileOf(x) === Number(pid)) || 0;

  // guilds.js: the household rank titles an office sets keep their title and cannot be removed
  globalThis.__dboCourtTiedTitles = () => Array.from(new Set([].concat(...Object.values(C.factionRanks || {})).filter((t) => t && t !== '@leader').map((t) => String(t).toLowerCase())));
  // ---- the office keeps the household in step (gamemode.js seatOfficial / unseatOfficial) ---------------------------
  globalThis.__dboCourtOfficeSync = (z, tg, rank, seated) => {
    if (typeof globalThis.__dboCourtSync !== 'function' || !z || !tg) return;
    const titles = C.factionRanks[rank] || [];
    // Seating names the character appointed; unseating reaches every character of the account, since offices are kept
    // per account and the household per character
    const actors = seated ? [tg.actor].filter(Boolean) : Array.from(new Set([tg.actor].concat(accountActors(tg.pid)).filter(Boolean)));
    for (const a of actors) {
      const text = globalThis.__dboCourtSync(z.id, a, titles, !!seated);
      if (text) log(`court: ${text}`);
    }
  };

  // ---- offers ---------------------------------------------------------------------------------------------------------
  const offerTo = (a, z, rank, tg, chk) => {
    if (tg.pid === profileOf(a)) return { error: 'You cannot offer a post to yourself.' };
    const others = live().filter((o) => !(o.zone === z.id && o.pid === tg.pid));
    const offer = { id: `c${Date.now().toString(36)}${(++S.seq).toString(36)}`, zone: z.id, rank, pid: tg.pid, actor: tg.actor >>> 0, name: tg.label,
      by: a >>> 0, byPid: profileOf(a), byWho: who(a), byName: display(a), staff: isAdmin(a), overridden: chk && chk.overridden ? chk.overridden : '', at: Date.now() };
    S.offers = others.concat([offer]);
    saveOffers();
    redrawCourt(tg.online);
    if (tg.online) system(tg.online, `${display(a)} offers you the post of ${rankTitle(rank)} of ${z.name}. Open your journal (F3), Court, to accept or decline, or type /court accept.`);
    audit(`${isAdmin(a) ? 'GM' : 'OFFICIAL'} ${who(a)} offered ${tg.who} the post of ${rankTitle(rank)} of ${z.name}${tg.online ? '' : ' (offline)'}`);
    return { text: `You offered ${tg.label} the post of ${rankTitle(rank)} of ${z.name}. They accept it in their journal.` };
  };
  // gamemode.js /appoint (appointFrom): a ruler's appointment becomes an offer
  globalThis.__dboCourtOffer = (a, z, rank, tg, chk) => (C.enabled ? offerTo(a >>> 0, z, rank, tg, chk) : seatOfficial(z, rank, tg, { who: who(a), staff: isAdmin(a), overridden: chk && chk.overridden }));

  const selfTarget = (a) => ({ pid: profileOf(a), actor: a >>> 0, online: a >>> 0, label: display(a), who: who(a) });
  const answerOffer = (a, id, yes) => {
    const o = live().find((x) => x.id === String(id));
    if (!o || o.pid !== profileOf(a)) return { error: 'That offer has expired or was withdrawn.' };
    const z = zoneById(o.zone);
    S.offers = live().filter((x) => x.id !== o.id);
    if (!yes || !z) {
      saveOffers();
      if (isOnline(o.by)) system(o.by, `${display(a)} declined the post of ${rankTitle(o.rank)}${z ? ` of ${z.name}` : ''}.`);
      audit(`OFFICIAL ${who(a)} declined the post of ${rankTitle(o.rank)} of ${z ? z.name : o.zone} offered by ${o.byWho}`);
      return { text: 'You declined the post.' };
    }
    // The offer is checked again as if it were made now: the one who offered may have lost their seat since, the seats
    // may have filled, and the character accepting is the one the post goes to
    const tg = selfTarget(a);
    const chk = appointCheck(o.by, z, o.rank, tg, !!o.overridden);
    if (chk.error) { saveOffers(); return { error: `The offer no longer stands. ${chk.error}` }; }
    const r = seatOfficial(z, o.rank, tg, { who: o.byWho, staff: o.staff, overridden: chk.overridden, via: ', offered and accepted' });
    saveOffers();
    if (!r.error && isOnline(o.by) && o.by !== (a >>> 0)) system(o.by, `${display(a)} accepted the post of ${rankTitle(o.rank)} of ${z.name}.`);
    return r.error ? r : { text: `You are now ${rankTitle(o.rank)} of ${z.name}.` };
  };
  const withdraw = (a, id) => {
    const o = live().find((x) => x.id === String(id));
    if (!o) return { error: 'That offer has already gone.' };
    if (!isAdmin(a) && o.byPid !== profileOf(a)) return { error: 'Only the one who made an offer may withdraw it.' };
    S.offers = live().filter((x) => x.id !== o.id);
    saveOffers();
    audit(`${isAdmin(a) ? 'GM' : 'OFFICIAL'} ${who(a)} withdrew the offer of ${rankTitle(o.rank)} of ${o.zone} to ${o.name}`);
    return { text: `The offer to ${o.name} is withdrawn.` };
  };

  // ---- the view -------------------------------------------------------------------------------------------------------
  const courtZoneIds = (a) => {
    const ids = new Set();
    try { for (const m of ranksOf(profileOf(a)) || []) ids.add(m.zone.id); } catch (e) { /* no ranks */ }
    const guilds = typeof globalThis.__dboGuildsOf === 'function' ? (globalThis.__dboGuildsOf(a) || []) : [];
    for (const g of guilds) if ((g.kind === 'hold' || g.kind === 'stronghold') && g.zone) ids.add(g.zone);
    for (const o of live()) if (o.pid === profileOf(a)) ids.add(o.zone);
    return ids;
  };
  const offersFor = (a) => live().filter((o) => o.pid === profileOf(a));
  const seatsOf = (z, rank) => {
    const top = (z.officials || [])[0];
    if (rank === top) return 1;
    const n = Number(((APPOINT_RULES || {})[top] || {})[rank]);
    return n > 0 ? n : null;
  };
  const holderView = (pid) => {
    const on = onlineOf(pid);
    const ids = accountActors(pid);
    const actor = on || ids[0] || 0;
    let tag = '';
    try { tag = actor ? String(tagOf(actor) || '') : ''; } catch (e) { tag = ''; }
    return { pid: Number(pid), name: on ? nameOf(on) : officialName(pid), tag, online: !!on };
  };
  const zoneView = (a, z, mine) => {
    const zo = readOfficials()[z.id] || {};
    const staff = isAdmin(a);
    const offices = (z.officials || []).map((rank) => {
      const cap = appointCap(a, z, rank);
      return { rank, title: rankTitle(rank), seats: seatsOf(z, rank), holders: (zo[rank] || []).map(holderView), canAppoint: cap > 0 };
    });
    const pid = profileOf(a);
    const outgoing = live().filter((o) => o.zone === z.id && (staff || o.byPid === pid))
      .map((o) => ({ id: o.id, name: o.name, rank: o.rank, title: rankTitle(o.rank), from: o.byName, at: o.at, expiresAt: Number(o.at) + OFFER_MS }));
    const household = typeof globalThis.__dboCourtHousehold === 'function' ? globalThis.__dboCourtHousehold(a, z.id) : null;
    const holdsOffice = offices.some((o) => o.holders.some((h) => h.pid === pid));
    let treasury = null;
    try { if (z.treasury && (staff || holdsOffice) && globalThis.__dboTreasuryZone) treasury = Number(globalThis.__dboTreasuryZone.balance(z.id)) || 0; } catch (e) { treasury = null; }
    return { id: z.id, name: z.name, kind: z.center ? 'stronghold' : z.capital ? 'hold' : 'region', mine: !!mine, offices, outgoing, household, treasury,
      appointable: offices.filter((o) => o.canAppoint).map((o) => ({ rank: o.rank, title: o.title })) };
  };
  const visible = (a) => {
    if (!C.enabled) return false;
    const n = offersFor(a).length;
    if (isAdmin(a) || courtZoneIds(a).size) return n ? { badge: n } : true;
    return false;
  };
  const view = (a) => {
    const staff = isAdmin(a);
    const mine = courtZoneIds(a);
    const zones = zoneList().filter((z) => staff || mine.has(z.id));
    return {
      staff, outright: staff,
      courts: zones.map((z) => zoneView(a, z, mine.has(z.id))),
      selected: (zones.find((z) => z.id === S.lastZone.get(a >>> 0)) || zones.find((z) => mine.has(z.id)) || zones[0] || {}).id || '',
      offers: offersFor(a).map((o) => { const z = zoneById(o.zone); return { id: o.id, zone: o.zone, zoneName: z ? z.name : o.zone, rank: o.rank, title: rankTitle(o.rank), from: o.byName, at: o.at, expiresAt: Number(o.at) + OFFER_MS }; }),
    };
  };
  const sections = globalThis.__dboJournalSections || (globalThis.__dboJournalSections = {});
  sections.court = { visible, view };
  // /court and /officials: true when the hub journal opened on Court. Today's journal opens Profile for any tab, so the
  // shell (__dboJournalLimited) must be there; a journal that refused (in a fight) stays shut and the chat answers.
  globalThis.__dboCourtOpen = (a) => {
    const g = globalThis;
    try {
      if (typeof g.__dboJournalLimited !== 'function' || typeof g.__dboJournalOpenTab !== 'function' || !visible(a)) return false;
      return g.__dboJournalOpenTab(a >>> 0, 'court') === true && (typeof g.__dboJournalIsOpen !== 'function' || g.__dboJournalIsOpen(a >>> 0) === true);
    } catch (e) { log('court: journal open failed', e.message); return false; }
  };

  // ---- events ---------------------------------------------------------------------------------------------------------
  const fresh = (a, args) => typeof globalThis.__dboJournalFresh === 'function' && !!globalThis.__dboJournalFresh(a, String((args || [])[0] || ''));
  const answer = (a, fn) => {
    const run = () => { let r; try { r = fn(); } catch (e) { log('court: action failed', e.stack || e.message); r = { error: 'That cannot be done just now.' }; } return { tab: 'court', text: r.error || r.text || '', kind: r.error ? 'refused' : 'ok' }; };
    if (typeof globalThis.__dboJournalLimited === 'function') globalThis.__dboJournalLimited(a, run);
  };
  // A zone the viewer may act in: staff anywhere, anyone else only at their own courts
  const zoneFor = (a, id) => {
    const z = zoneById(String(id || ''));
    if (!z) return null;
    S.lastZone.set(a >>> 0, z.id);
    return isAdmin(a) || courtZoneIds(a).has(z.id) ? z : null;
  };
  const NO_COURT = { error: 'That is not a court you serve.' };
  const target = (q) => officialTarget(String(q || '').trim());
  const rankIn = (z, r) => { const rank = String(r || '').toLowerCase(); return (z.officials || []).includes(rank) ? rank : ''; };
  const appointLike = (a, args, offerOnly) => {
    const z = zoneFor(a, args[1]); if (!z) return NO_COURT;
    const rank = rankIn(z, args[3]); if (!rank) return { error: `${z.name} has no such office.` };
    const tg = target(args[2]); if (tg.error) return tg;
    if (!isAdmin(a) && tg.pid === profileOf(a)) return { error: 'You cannot offer a post to yourself.' };
    if (!offerOnly) return appointFrom(a, z, rank, tg, false);
    const chk = appointCheck(a, z, rank, tg, false);
    return chk.error ? chk : offerTo(a, z, rank, tg, chk);
  };
  onUi('courtAppoint', (a, args) => { if (fresh(a, args)) answer(a, () => appointLike(a, args, false)); });
  onUi('courtOffer', (a, args) => { if (fresh(a, args)) answer(a, () => appointLike(a, args, true)); });
  onUi('courtDismiss', (a, args) => {
    if (!fresh(a, args)) return;
    answer(a, () => {
      const z = zoneFor(a, args[1]); if (!z) return NO_COURT;
      const tg = target(String(Math.floor(Number(args[2])))); if (tg.error) return tg;
      return unseatOfficial(a, z, tg);
    });
  });
  onUi('courtMove', (a, args) => {
    if (!fresh(a, args)) return;
    answer(a, () => {
      const z = zoneFor(a, args[1]); if (!z) return NO_COURT;
      const rank = rankIn(z, args[3]); if (!rank) return { error: `${z.name} has no such office.` };
      const tg = target(String(Math.floor(Number(args[2])))); if (tg.error) return tg;
      const zo = readOfficials()[z.id] || {};
      const had = Object.keys(zo).find((r) => (zo[r] || []).map(Number).includes(tg.pid));
      if (!had) return { error: `${tg.label} holds no office in ${z.name}. Offer them a post instead.` };
      if (had === rank) return { error: `${tg.label} is already ${rankTitle(rank)}.` };
      if (!appointCap(a, z, had)) return { error: `You cannot move a ${rankTitle(had)} of ${z.name}.` };
      const chk = appointCheck(a, z, rank, tg, false); if (chk.error) return chk;
      // Already in the court's service, so a move needs no acceptance; seatOfficial drops the old office's household rank
      return seatOfficial(z, rank, tg, { who: who(a), staff: isAdmin(a), overridden: chk.overridden, via: `, moved from ${rankTitle(had)}` });
    });
  });
  onUi('courtAnswer', (a, args) => { if (fresh(a, args)) answer(a, () => answerOffer(a, args[1], String(args[2]) === 'accept')); });
  onUi('courtWithdraw', (a, args) => { if (fresh(a, args)) answer(a, () => withdraw(a, args[1])); });
  const householdOf = (a, zoneId) => {
    const z = zoneFor(a, zoneId); if (!z) return { error: NO_COURT.error };
    const fid = typeof globalThis.__dboCourtFaction === 'function' ? globalThis.__dboCourtFaction(z.id) : null;
    return fid ? { z, fid } : { error: `${z.name} has no household.` };
  };
  const guildCall = (name, ...rest) => (typeof globalThis[name] === 'function' ? globalThis[name](...rest) : { error: 'The household cannot be changed just now.' });
  onUi('courtRank', (a, args) => {
    if (!fresh(a, args)) return;
    answer(a, () => { const h = householdOf(a, args[1]); return h.error ? h : guildCall('__dboGuildSetRank', a, h.fid, Number(args[2]) >>> 0, Math.floor(Number(args[3])), true); });
  });
  onUi('courtKick', (a, args) => {
    if (!fresh(a, args)) return;
    answer(a, () => { const h = householdOf(a, args[1]); return h.error ? h : guildCall('__dboGuildKick', a, h.fid, Number(args[2]) >>> 0); });
  });
  onUi('courtInvite', (a, args) => {
    if (!fresh(a, args)) return;
    answer(a, () => {
      const h = householdOf(a, args[1]); if (h.error) return h;
      const t = findByName(String(args[2] || '')); if (!t) return { error: 'No such player online. Use their name or #TAG.' };
      return guildCall('__dboGuildInvite', a, t, h.fid);
    });
  });

  // ---- chat, for a client on today's journal (no Court tab): the panel stays the main way ----------------------------
  if (typeof api.registerChatCommand === 'function') {
    api.registerChatCommand('court', (a, args) => {
      const [sub, ...rest] = String(args || '').trim().split(/\s+/);
      const s = String(sub || '').toLowerCase();
      const mine = offersFor(a);
      const label = (o, i) => { const z = zoneById(o.zone); return `${i + 1}. ${rankTitle(o.rank)} of ${z ? z.name : o.zone}, offered by ${o.byName}`; };
      if (!s || s === 'offers') {
        if (!s && globalThis.__dboCourtOpen(a)) return;
        return personal(a, mine.length ? `Posts offered to you: ${mine.map(label).join(' | ')}. Answer with /court accept <number> or /court decline <number>.` : 'No post is offered to you.');
      }
      if (s === 'accept' || s === 'decline') {
        if (!mine.length) return personal(a, 'No post is offered to you.');
        const n = rest[0] ? Math.floor(Number(rest[0])) : (mine.length === 1 ? 1 : 0);
        const o = mine[n - 1];
        if (!o) return personal(a, `Which one? ${mine.map(label).join(' | ')}. Use /court ${s} <number>.`);
        const r = answerOffer(a, o.id, s === 'accept');
        return personal(a, r.error || r.text);
      }
      personal(a, 'Usage: /court (your journal\'s Court tab), /court offers, /court accept [number], /court decline [number]');
    }, { help: '[offers|accept|decline] the posts a court offers you (F3 Court shows them too)' });
  }

  log(`court ${C.enabled ? 'on' : 'off'}: ${zoneList().length} courts, ${live().length} open offers`);
  return { view, visible, offerTo, answerOffer, withdraw };
};
