// DragonBreak Online: player factions. Loaded by gamemode.js on every hot reload.
//
// Factions and their ranks come from guild-defs.json (tracked); membership from guilds.json (runtime,
// gitignored), keyed by the character's actor id so a player's other characters inherit nothing.
// Hold offices (Jarl, Steward...) are a separate system in zones.json/officials.json.
//
// Roles decide what a rank may do: leader everything, officer invite + kick, sergeant invite; mage,
// blacksmith, tailor and member are crafts and standing (faction gear crafting comes later).
// A secret faction (the Daedric cults, Thieves Guild, Dark Brotherhood, Clan Volkihar) shows its
// roster only to its own members.
//
// F3 (client factionService) sends factionMenuRequest; the menu is front widget "faction" (id 37).
// X on a player lists "Invite to <faction>" for every faction the viewer may invite into.
'use strict';

module.exports = (api) => {
  const fs = require('fs');
  const path = require('path');
  const { mp, log, personal, system, registerChatCommand, onUi, openWidget, closeWidget, display, nameOf, tagOf,
    onlineActors, isAdmin, findByName, audit, who, cfg, profileOf } = api;
  // Online first, then offline characters too (Add member); an older gamemode passes only findByName
  const findAnyByName = typeof api.findAnyByName === 'function' ? api.findAnyByName : findByName;
  // A GM observes; the powers below are for a Lead GM and above (claude-jake's review A3). Fails closed with an old gamemode.
  const isLeadStaff = typeof api.isLeadStaff === 'function' ? api.isLeadStaff : () => false;

  const WIDGET_ID = 37;
  const INVITE_MS = 2 * 60000;
  const DEFS_PATH = path.resolve('guild-defs.json');
  const STATE_PATH = path.resolve('guilds.json');
  const MIRROR_PROP = 'private.dboGuilds';

  const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; } };
  const DEFS = readJson(DEFS_PATH, { roles: {}, templates: {}, factions: [] });
  const ROLES = DEFS.roles || {};
  const CAPS = Object.assign({}, DEFS.roleCaps || {}, (cfg.factions || {}).roleCaps || {});
  const FACTIONS = new Map();
  // fid -> the rank titles before any rank marked "added" in the defs: what a roster entry written before its faction's
  // titles were stamped (guilds.json from before 4 Oct 2026) was indexed against
  const BEFORE_STAMPS = new Map();
  for (const f of DEFS.factions || []) {
    const raw = Array.isArray(f.ranks) ? f.ranks : ((DEFS.templates || {})[f.template] || []);
    if (!f.id || !raw.length) { log(`faction ${f.id || '?'} has no ranks, skipped`); continue; }
    FACTIONS.set(f.id, Object.assign({}, f, { ranks: raw.map((r) => ({ title: String(r.title), role: String(r.role) })) }));
    BEFORE_STAMPS.set(f.id, raw.filter((r) => !r.added).map((r) => String(r.title)));
  }
  // Factions founded by players' charters (charters.js) live in player-factions.json, written at runtime and never in git;
  // guild-defs.json stays the hand-kept canon list. A defs id always wins over a player faction of the same id.
  const PLAYER_PATH = path.resolve('player-factions.json');
  const addPlayerFaction = (f) => {
    if (!f || !f.id || FACTIONS.has(String(f.id)) || !Array.isArray(f.ranks) || !f.ranks.length) return false;
    FACTIONS.set(String(f.id), Object.assign({}, f, { id: String(f.id), player: true }));
    return true;
  };
  for (const f of (readJson(PLAYER_PATH, { factions: [] }).factions || [])) addPlayerFaction(f);

  // ---- rank overrides: titles renamed and ranks added, moved or removed in game (F3 Faction tab, staff view) ---------
  // guild-overrides.json (runtime, gitignored): { factionId: { ranks: [{ title, role }], by, at } }. A faction's ranks are
  // replaced whole, never edited in place, since factions of one template share its rank array.
  const OVR_PATH = path.resolve('guild-overrides.json');
  const OVR = readJson(OVR_PATH, {});
  const RANK_TITLE_MAX = 40;
  const RANKS_MAX = 12;
  const cleanTitle = (t) => String(t === undefined || t === null ? '' : t).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, RANK_TITLE_MAX);
  // An error string for a rank list that cannot stand, or null: one leader and it comes first, known roles, titles unique
  const ranksProblem = (ranks) => {
    if (!Array.isArray(ranks) || !ranks.length) return 'A faction needs at least one rank.';
    if (ranks.length > RANKS_MAX) return `A faction has at most ${RANKS_MAX} ranks.`;
    if (ranks.some((r) => !r || !r.title)) return 'Every rank needs a title.';
    if (ranks.some((r) => !ROLES[r.role])) return 'Every rank needs one of the known roles.';
    if (ranks[0].role !== 'leader' || ranks.filter((r) => r.role === 'leader').length !== 1) return 'The leader rank comes first, and there is only one.';
    const seen = new Set();
    for (const r of ranks) { const k = r.title.toLowerCase(); if (seen.has(k)) return `Two ranks are called ${r.title}.`; seen.add(k); }
    return null;
  };
  for (const [fid, o] of Object.entries(OVR)) {
    const f = FACTIONS.get(fid);
    const ranks = o && Array.isArray(o.ranks) ? o.ranks.map((r) => ({ title: cleanTitle(r && r.title), role: String((r && r.role) || '') })) : null;
    if (!f || !ranks) continue;
    const bad = ranksProblem(ranks);
    if (bad) { log(`guild-overrides.json: ${fid} kept its own ranks (${bad})`); continue; }
    f.ranks = ranks;
  }
  const saveOverrides = () => { fs.writeFileSync(OVR_PATH + '.tmp', JSON.stringify(OVR, null, 1)); fs.renameSync(OVR_PATH + '.tmp', OVR_PATH); };

  // ---- membership state -------------------------------------------------------------------------
  // { factionId: { actorId: { rank, name, tag, since } } }
  const ST = globalThis.__dboGuildState || (globalThis.__dboGuildState = { members: readJson(STATE_PATH, {}), invites: new Map(), nonces: new Map() });
  const save = () => {
    stampAll();
    try { fs.writeFileSync(STATE_PATH + '.tmp', JSON.stringify(ST.members, null, 1)); fs.renameSync(STATE_PATH + '.tmp', STATE_PATH); }
    catch (e) { log('guilds.json write failed', e.message); }
  };
  // ---- a rank list changed in guild-defs.json keeps every member on their title -----------------------------------
  // Members are stored by rank index, so a rank inserted or moved in the defs would shift everyone below it. Every
  // entry therefore carries its rank's title (title, and nth when the faction has that title more than once: the Blades
  // have two Blades), stamped on every save. At load an entry whose stamp no longer names its index is moved to the rank
  // with that title, or to the lowest rank when the title is gone. An entry with no stamp was written before stamping
  // began, against the defs without their "added" ranks, and is mapped from there. Loading twice changes nothing, and a
  // guilds.json restored from before or after stamping comes out the same.
  const lower = (t) => String(t || '').toLowerCase();
  const nthOf = (titles, i) => titles.slice(0, i).filter((t) => lower(t) === lower(titles[i])).length;
  const indexOfNth = (titles, title, nth) => {
    let seen = 0;
    for (let i = 0; i < titles.length; i++) if (lower(titles[i]) === lower(title)) { if (seen === (nth || 0)) return i; seen++; }
    return -1;
  };
  const stamp = (f, e) => {
    const titles = f.ranks.map((r) => r.title);
    if (!(e.rank >= 0 && e.rank < titles.length)) return;
    e.title = titles[e.rank];
    const n = nthOf(titles, e.rank);
    if (n) e.nth = n; else delete e.nth;
  };
  const stampAll = () => { for (const [fid, roster] of Object.entries(ST.members)) { const f = FACTIONS.get(fid); if (f) for (const e of Object.values(roster || {})) stamp(f, e); } };
  const remapByTitle = () => {
    let moved = 0, unstamped = 0;
    for (const [fid, roster] of Object.entries(ST.members)) {
      const f = FACTIONS.get(fid);
      if (!f) continue;
      const now = f.ranks.map((r) => r.title);
      const before = BEFORE_STAMPS.get(fid) || now;
      for (const e of Object.values(roster || {})) {
        let title, nth;
        if (typeof e.title === 'string') { title = e.title; nth = Number(e.nth) || 0; }
        else { unstamped++; title = before[e.rank]; nth = title === undefined ? 0 : nthOf(before, e.rank); }
        if (title !== undefined && lower(now[e.rank]) === lower(title) && nthOf(now, e.rank) === nth) continue;
        const at = title === undefined ? -1 : indexOfNth(now, title, nth);
        const to = at >= 0 ? at : now.length - 1;
        if (to !== e.rank) { log(`guilds: ${e.name || '?'} in ${fid} keeps the title ${title === undefined ? '(unknown)' : title}: rank ${e.rank} -> ${to}${at < 0 ? ' (the title is gone: the lowest rank)' : ''}`); e.rank = to; moved++; }
      }
    }
    if (moved || unstamped) save();
    return { moved, unstamped };
  };
  remapByTitle();
  // ---- the faction's storage ---------------------------------------------------------------------
  // Nate 2026-09-27: recruitment and access stay roleplay. A leader claims a container through housing, locks
  // it and cuts keys for whoever should reach it; this records only WHERE it is, so members can find it and it
  // outlives a change of leader. Nothing here grants access, and rank-gated doors were deliberately not built:
  // a key handed over in character does the same job and the leader keeps control of it.
  const STORE_PATH = path.resolve('faction-storage.json');
  const STORES = globalThis.__dboGuildStores || (globalThis.__dboGuildStores = readJson(STORE_PATH, {}));
  const saveStores = () => {
    try { fs.writeFileSync(STORE_PATH + '.tmp', JSON.stringify(STORES, null, 1)); fs.renameSync(STORE_PATH + '.tmp', STORE_PATH); }
    catch (e) { log('faction-storage.json write failed', e.message); }
  };
  // The region the playtest is locked to (playtest.js holds the real lock; this only decides wording)
  const PLAYTEST_ZONE = String((cfg.playtest || {}).zone || 'bruma');
  const STORE_REACH = 400;
  // The claimed property the player is standing at. housing.json is the index of claimed ids the housing
  // system keeps (an array of form ids); a ref that is not loaded simply does not answer and is skipped.
  const propertyAt = (a) => {
    let pos = null, cell = null;
    try { pos = mp.get(a, 'pos'); cell = mp.get(a, 'worldOrCellDesc'); } catch (e) { return 0; }
    if (!pos) return 0;
    const claimed = readJson(path.resolve('housing.json'), []);
    let best = 0, bestD = Infinity;
    for (const raw of Array.isArray(claimed) ? claimed : []) {
      const ref = Number(raw) >>> 0; if (!ref) continue;
      try {
        if (mp.get(ref, 'worldOrCellDesc') !== cell) continue;
        const p = mp.get(ref, 'pos'); if (!p) continue;
        const d = Math.hypot(p[0] - pos[0], p[1] - pos[1], p[2] - pos[2]);
        if (d <= STORE_REACH && d < bestD) { bestD = d; best = ref; }
      } catch (e) { /* not loaded right now */ }
    }
    return best;
  };
  // charters.js: the claimed property a player stands at, for a chartered faction's seat
  globalThis.__dboPropertyAt = (a) => propertyAt(a >>> 0);
  const storageOf = (fid) => {
    const st = STORES[fid];
    return st && st.ref ? { ref: st.ref, name: st.name || 'the strongbox', hall: st.hall || '', by: st.by || '', at: st.at || 0 } : null;
  };

  const rosterOf = (fid) => (ST.members[fid] = ST.members[fid] || {});
  const entryOf = (fid, a) => (ST.members[fid] || {})[String(a >>> 0)] || null;
  // A faction's circle: the supernatural kind it takes (guild-defs "requires"), or config factions.circles for a faction
  // whose kind is lore rather than a rule (Clan Volkihar is a vampire clan that takes thralls too)
  const CIRCLES = Object.assign({ 'clan-volkihar': 'vampire' }, (cfg.factions || {}).circles || {});
  const circleOf = (fid) => { const f = FACTIONS.get(String(fid)); return (f && (CIRCLES[f.id] || f.requires)) || ''; };
  const membershipsOf = (a) => [...FACTIONS.keys()].map((fid) => ({ fid, e: entryOf(fid, a) })).filter((m) => m.e);
  const rankOf = (fid, a) => { const e = entryOf(fid, a); const f = FACTIONS.get(fid); return e && f ? f.ranks[e.rank] || null : null; };
  const can = (fid, a, perm) => { const r = rankOf(fid, a); return !!(r && (ROLES[r.role] || {})[perm]); };
  const roleCount = (fid, role) => Object.values(rosterOf(fid)).filter((e) => (FACTIONS.get(fid).ranks[e.rank] || {}).role === role).length;
  const mirror = (a) => { try { mp.set(a, MIRROR_PROP, membershipsOf(a).map((m) => ({ id: m.fid, role: (FACTIONS.get(m.fid).ranks[m.e.rank] || {}).role }))); } catch (e) { /* offline */ } };
  const isOnline = (a) => onlineActors().includes(a >>> 0);

  const setMember = (fid, a, rank) => {
    const f = FACTIONS.get(fid);
    const role = (f.ranks[rank] || {}).role;
    const cap = Number(CAPS[role]) || 0;
    const had = entryOf(fid, a);
    if (cap && (!had || (f.ranks[had.rank] || {}).role !== role) && roleCount(fid, role) >= cap) return `${f.name} already has ${cap} ${f.ranks[rank].title}${cap === 1 ? '' : 's'}.`;
    rosterOf(fid)[String(a >>> 0)] = { rank, name: nameOf(a), tag: tagOf(a), since: had ? had.since : Date.now() };
    save(); mirror(a);
    return null;
  };
  const removeMember = (fid, a) => { delete rosterOf(fid)[String(a >>> 0)]; save(); if (isOnline(a)) mirror(a); };
  const lowestRank = (fid) => FACTIONS.get(fid).ranks.length - 1;
  const outranks = (fid, a, b) => { const ea = entryOf(fid, a), eb = entryOf(fid, b); return !!ea && (!eb || ea.rank < eb.rank); };

  // A clan or pack with requires takes only that kind (supernatural.js); admins are not bound by it
  const fits = (a, f) => !f || !f.requires || isLeadStaff(a) || (typeof globalThis.__dboSuperKind === 'function' && globalThis.__dboSuperKind(a) === f.requires);

  // ---- invites ------------------------------------------------------------------------------------
  const invitesOf = (t) => (ST.invites.get(t >>> 0) || []).filter((i) => Date.now() - i.at < INVITE_MS);
  const invite = (a, t, fid) => {
    const f = FACTIONS.get(fid);
    if (!f) return 'No such faction.';
    if (!isLeadStaff(a) && !can(fid, a, 'invite')) return `Your rank in ${f.name} cannot invite.`;
    if (!t || t === a || !isOnline(t)) return 'They must be online.';
    if (entryOf(fid, t)) return `${nameOf(t)} is already in ${f.name}.`;
    if (!fits(t, f)) return `${nameOf(t)} could never belong to ${f.name}.`;
    const list = invitesOf(t).filter((i) => i.fid !== fid);
    list.push({ fid, from: a >>> 0, at: Date.now() });
    ST.invites.set(t >>> 0, list);
    system(t, `${display(a)} invites you to join ${f.name}. Open your factions (F3) or type /faction accept ${fid}.`);
    audit(`FACTION ${who(a)} invited ${who(t)} to ${f.name}`);
    return `You invited ${nameOf(t)} to ${f.name}.`;
  };
  const accept = (t, fid) => {
    const inv = invitesOf(t).find((i) => i.fid === fid);
    if (!inv) return 'That invitation has expired or never came.';
    if (!fits(t, FACTIONS.get(fid))) return `${FACTIONS.get(fid).name} is not for your kind.`;
    ST.invites.set(t >>> 0, invitesOf(t).filter((i) => i.fid !== fid));
    const f = FACTIONS.get(fid);
    const err = setMember(fid, t, lowestRank(fid));
    if (err) return err;
    const title = f.ranks[lowestRank(fid)].title;
    for (const m of Object.keys(rosterOf(fid)).map(Number)) if (m !== (t >>> 0) && isOnline(m)) system(m, `${display(t)} has joined ${f.name}.`);
    audit(`FACTION ${who(t)} joined ${f.name} as ${title}`);
    return `You are now ${title} of ${f.name}.`;
  };

  // ---- the menu -----------------------------------------------------------------------------------
  const factionView = (a, fid) => {
    const f = FACTIONS.get(fid); const e = entryOf(fid, a); const admin = isAdmin(a);
    const visible = !f.secret || !!e || admin;
    const members = visible ? Object.entries(rosterOf(fid)).map(([id, m]) => ({
      actorId: Number(id), name: m.name, tag: m.tag, rank: m.rank, title: (f.ranks[m.rank] || {}).title || '?', role: (f.ranks[m.rank] || {}).role || 'member', online: isOnline(Number(id)),
    })).sort((x, y) => x.rank - y.rank || x.name.localeCompare(y.name)) : [];
    return {
      id: fid, name: f.name, kind: f.kind, secret: !!f.secret, prince: f.prince || '',
      myRank: e ? e.rank : -1, myTitle: e ? (f.ranks[e.rank] || {}).title : '',
      // The staff override is a Lead GM's, as the handlers check (a GM observes)
      canInvite: isLeadStaff(a) || can(fid, a, 'invite'), canKick: isLeadStaff(a) || can(fid, a, 'kick'), canSetRank: isLeadStaff(a) || can(fid, a, 'setRank'),
      ranks: f.ranks.map((r) => ({ title: r.title, role: r.role })), members,
      // The journal's Faction tab: holds and strongholds are shown on the Court tab instead (Nate, 3 Oct, Q3); a leader
      // renames the titles, a Lead GM also adds, moves and removes ranks and adds members
      court: f.kind === 'hold' || f.kind === 'stronghold', count: Object.keys(rosterOf(fid)).length, player: !!f.player,
      canRename: isLeadStaff(a) || (rankOf(fid, a) || {}).role === 'leader', canEditRanks: isLeadStaff(a), canAdd: isLeadStaff(a),
    };
  };
  // The panel's content, also the Character Journal's Faction tab (journal.js); keepNonce: a journal redraw keeps the
  // nonce the front already holds
  const CHARTER_HINT = 'To found a faction or a cult of your own, type /charter found <name> or /charter cult <name> in chat. Your co-founders confirm it, then a GM approves it.';
  // readOnly: a staff member reading `a`'s journal; no nonce is made or kept for `a`, so nothing in it can act for them
  const menuPayload = (a, result, resultKind, focusFid, keepNonce, readOnly) => {
    const nonce = readOnly ? '' : keepNonce && ST.nonces.get(a >>> 0) ? ST.nonces.get(a >>> 0) : `${(a >>> 0).toString(16)}-${Date.now().toString(36)}`;
    if (!readOnly) ST.nonces.set(a >>> 0, nonce);
    const mine = membershipsOf(a).map((m) => m.fid);
    // Nate, 2026-09-26: a werewolf pack's members also see the other packs, a vampire clan's the other clans (their circle);
    // cults and everyone else see only their own. Members of a faction outside your own stay hidden (factionView).
    const circles = new Set(mine.map(circleOf).filter(Boolean));
    const list = isAdmin(a) ? [...FACTIONS.keys()] : mine.concat([...FACTIONS.keys()].filter((fid) => !mine.includes(fid) && circles.has(circleOf(fid))));
    const invites = invitesOf(a).map((i) => ({ factionId: i.fid, name: FACTIONS.get(i.fid).name, from: display(i.from) }));
    return {
      type: 'faction', id: WIDGET_ID, nonce, admin: isLeadStaff(a), staff: isAdmin(a), self: a >>> 0,
      roles: Object.keys(ROLES), rankTitleMax: RANK_TITLE_MAX, ranksMax: RANKS_MAX,
      factions: list.map((fid) => factionView(a, fid)), invites, selected: focusFid || mine[0] || list[0] || '',
      // The Realm and War tabs (realm.js): territories and their owners, wars, and what this character leads
      realm: typeof globalThis.__dboRealmView === 'function' ? globalThis.__dboRealmView(a >>> 0) : null,
      economy: typeof globalThis.__dboEconomyView === 'function' ? globalThis.__dboEconomyView(a >>> 0) : null,
      // The panel has no founding control yet (charters.js is chat only), so with nothing else to say it says how
      ...(result || !((cfg.charters || {}).enabled) ? { result: result || '', resultKind: resultKind || '' } : { result: CHARTER_HINT, resultKind: 'info' }),
    };
  };
  // While the Character Journal is open its Faction tab is redrawn instead of panel 37
  const openMenu = (a, result, resultKind, focusFid) => {
    const p = menuPayload(a, result, resultKind, focusFid, false);
    try { if (typeof globalThis.__dboJournalFaction === 'function' && globalThis.__dboJournalFaction(a >>> 0, p)) return; } catch (e) { log('guilds: journal redraw failed', e.message); }
    openWidget(a, p, true);
  };
  globalThis.__dboFactionMenu = (a) => openMenu(a >>> 0);
  globalThis.__dboFactionPayload = (a, keepNonce, readOnly) => menuPayload(a >>> 0, '', '', undefined, !!keepNonce, !!readOnly);
  // journal.js (the F3 hub's tab list): whether the Faction tab shows, without building the whole panel
  // Hold and stronghold factions show on the Court tab (Nate, F3 Q3): counted apart, so journal.js counts them on Faction
  // only for a front that has no Court tab
  const courtKind = (fid) => { const f = FACTIONS.get(fid); return !!f && (f.kind === 'hold' || f.kind === 'stronghold'); };
  globalThis.__dboFactionTabInfo = (a) => {
    const ms = membershipsOf(a >>> 0), inv = invitesOf(a >>> 0);
    return { member: ms.filter((m) => !courtKind(m.fid)).length, invites: inv.filter((i) => !courtKind(i.fid)).length,
      courtMember: ms.filter((m) => courtKind(m.fid)).length, courtInvites: inv.filter((i) => courtKind(i.fid)).length, staff: !!isAdmin(a >>> 0) };
  };
  // realm.js: redraws an open panel with the result of a war action (true when one was open), and checks its nonce
  globalThis.__dboFactionRefresh = (a, text, ok) => { if (!ST.nonces.has(a >>> 0)) return false; openMenu(a >>> 0, text, ok ? 'ok' : 'refused'); return true; };
  globalThis.__dboFactionNonceOk = (a, nonce) => ST.nonces.get(a >>> 0) === String(nonce || '');
  // ledger.js: the factions a character belongs to (offline ones too), and whether an id names a faction
  const hallOf = (f) => {
    const h = f && f.hall;
    if (!h || !h.name) return null;
    return { name: String(h.name), zone: h.zone || '', doors: Array.isArray(h.doors) ? h.doors.slice() : [], shared: !!h.shared, note: h.note || '' };
  };
  globalThis.__dboGuildsOf = (a) => membershipsOf(a >>> 0).map((m) => { const f = FACTIONS.get(m.fid); const r = f.ranks[m.e.rank] || {}; return { id: m.fid, name: f.name, title: r.title || '', role: r.role || '', kind: f.kind || '', zone: f.zone || '', secret: !!f.secret, player: !!f.player, hall: hallOf(f) }; });
  globalThis.__dboGuildExists = (id) => FACTIONS.has(String(id));
  // When a faction was founded, for realm.js's protectDays: its first member's joining; a hold or stronghold is as old as
  // the land (review m6: nothing defined this, so the rule never applied)
  globalThis.__dboGuildFoundedAt = (id) => {
    const f = FACTIONS.get(String(id));
    if (!f || f.kind === 'hold' || f.kind === 'stronghold') return 0;
    const since = Object.values(rosterOf(f.id)).map((e) => Number(e && e.since) || 0).filter((t) => t > 0);
    return since.length ? Math.min(...since) : 0;
  };
  // Every faction that is not secret, for the war section's lists (realm.js)
  globalThis.__dboFactionList = () => [...FACTIONS.values()].filter((f) => !f.secret).map((f) => f.id);
  // For the war system (realm.js): a faction's name and kind, and the characters on its roster (actor ids)
  globalThis.__dboGuildInfo = (id) => { const f = FACTIONS.get(String(id)); return f ? { id: f.id, name: f.name, kind: f.kind || '', zone: f.zone || '', secret: !!f.secret, circle: circleOf(f.id), hall: hallOf(f) } : null; };
  // Where a faction is seated (guild-defs.json "hall"). A home address for now: the name players are told and
  // the doors that lead in. The Blades have none on purpose while Cloud Ruler Temple is a ruin.
  globalThis.__dboGuildHall = (id) => { const f = FACTIONS.get(String(id)); return f ? hallOf(f) : null; };
  globalThis.__dboGuildStorage = (id) => storageOf(String(id));
  // charters.js: a faction founded by charter goes live at once (charters.js has already written player-factions.json, so a
  // reload keeps it). The founder takes the leader rank, and each co-founder ({ actor, role }) the rank of their role, or
  // the rank below the leader without one. An error string, or null.
  globalThis.__dboGuildFoundPlayer = (def, founder, cofounders) => {
    if (!addPlayerFaction(def)) return `A faction with the id ${def && def.id} already exists.`;
    const fid = String(def.id); const f = FACTIONS.get(fid);
    const lead = Math.max(0, f.ranks.findIndex((r) => r.role === 'leader'));
    const err = setMember(fid, founder, lead);
    if (err) { FACTIONS.delete(fid); delete ST.members[fid]; save(); return err; }
    for (const c of cofounders || []) {
      const actor = typeof c === 'object' && c ? c.actor : c;
      const at = typeof c === 'object' && c ? f.ranks.findIndex((r) => r.role === c.role) : -1;
      const e = setMember(fid, actor, at > lead ? at : Math.min(lead + 1, lowestRank(fid)));
      if (e) log(`charter faction ${fid}: ${e}`);
    }
    return null;
  };
  // charters.js: a GM dissolves a player faction. Its roster goes; a canon faction from guild-defs.json is never touched.
  globalThis.__dboGuildDissolvePlayer = (id) => {
    const f = FACTIONS.get(String(id)); if (!f || !f.player) return false;
    const ids = Object.keys(rosterOf(f.id)).map(Number);
    delete ST.members[f.id]; FACTIONS.delete(f.id); save();
    for (const m of ids) mirror(m);
    return true;
  };
  globalThis.__dboGuildMembers = (id) => Object.keys(ST.members[String(id)] || {}).map((x) => Number(x) >>> 0);
  // Characters deleted at character select, by /wipechars or from the admin panel stay on the rosters (nothing tells
  // the gameplay), and economy.js paid wages to them until it threw (review A1-2). economy.js calls this before it pays;
  // a deleted character's form is gone, so any get on it throws. If every entry looks gone at once, the check itself is
  // broken, not the rosters: nothing is removed then.
  globalThis.__dboGuildPrune = () => {
    const gone = [];
    let checked = 0;
    for (const [fid, roster] of Object.entries(ST.members)) {
      for (const k of Object.keys(roster || {})) {
        checked++;
        try { mp.get(Number(k) >>> 0, 'type'); } catch (e) { gone.push([fid, k]); }
      }
    }
    if (!gone.length) return 0;
    if (gone.length === checked && checked > 3) { log(`guilds: all ${checked} roster entries look deleted; the check is suspect, nothing removed`); return 0; }
    for (const [fid, k] of gone) {
      const m = ST.members[fid][k];
      log(`guilds: ${(m && m.name) || k} (${k}) taken off ${fid}: the character no longer exists`);
      delete ST.members[fid][k];
    }
    save();
    return gone.length;
  };
  globalThis.__dboGuildRanks = (id) => { const f = FACTIONS.get(String(id)); return f ? f.ranks.map((r) => r.title) : []; };
  globalThis.__dboHoldFactionOf = (zoneId) => { for (const f of FACTIONS.values()) if (f.kind === 'hold' && f.zone === zoneId) return f.id; return null; };
  const fresh = (a, args) => ST.nonces.get(a >>> 0) === String(args[0] || '');
  const reply = (a, text, fid, bad) => openMenu(a, text, bad ? 'refused' : 'ok', fid);
  const findMember = (fid, query) => {
    const q = String(query || '').trim().toLowerCase().replace(/^#/, '');
    for (const [id, m] of Object.entries(rosterOf(fid))) if (String(m.tag).toLowerCase() === q || String(m.name).toLowerCase() === q) return Number(id);
    return 0;
  };

  onUi('factionClose', (a) => { ST.nonces.delete(a >>> 0); closeWidget(a, WIDGET_ID); });
  onUi('factionInvite', (a, args) => {
    if (!fresh(a, args)) return;
    const fid = String(args[1] || ''); const t = findByName(String(args[2] || ''));
    if (!t) return reply(a, 'No such player online. Use their name or #TAG.', fid, true);
    const text = invite(a, t, fid); reply(a, text, fid, !/^You invited/.test(text));
  });
  onUi('factionAccept', (a, args) => { if (!fresh(a, args)) return; const fid = String(args[1] || ''); const text = accept(a, fid); reply(a, text, fid, !/^You are now/.test(text)); });
  onUi('factionDecline', (a, args) => {
    if (!fresh(a, args)) return;
    const fid = String(args[1] || ''); ST.invites.set(a >>> 0, invitesOf(a).filter((i) => i.fid !== fid));
    reply(a, 'Invitation declined.', '', false);
  });
  // Kick and set rank, shared by the faction panel and the Court tab's household (court.js): { error } or { text }
  const kickMember = (a, fid, t) => {
    const f = FACTIONS.get(fid);
    if (!f || !entryOf(fid, t)) return { error: 'They are not in that faction.' };
    if (!isLeadStaff(a) && !(can(fid, a, 'kick') && outranks(fid, a, t))) return { error: 'You cannot remove someone of equal or higher rank.' };
    const name = rosterOf(fid)[String(t)].name;
    removeMember(fid, t);
    if (isOnline(t)) system(t, `You have been removed from ${f.name}.`);
    audit(`FACTION ${who(a)} removed ${name} from ${f.name}`);
    return { text: `${name} is no longer in ${f.name}.` };
  };
  // court: a household's head follows the court's office (court.js), so its rank can be neither given nor taken here
  const setRankOf = (a, fid, t, rank, court) => {
    const f = FACTIONS.get(fid);
    if (!f || !entryOf(fid, t) || !(rank >= 0 && rank < f.ranks.length)) return { error: 'That rank change is not possible.' };
    const leaderRank = f.ranks.findIndex((r) => r.role === 'leader');
    if (court && (rank === leaderRank || entryOf(fid, t).rank === leaderRank)) return { error: `The ${f.ranks[leaderRank].title} of ${f.name} follows the court's office: appoint or dismiss the office instead.` };
    if (!isLeadStaff(a)) {
      if (!can(fid, a, 'setRank')) return { error: 'Only the leader sets ranks.' };
      if (t === (a >>> 0)) return { error: 'Pass leadership by naming someone else leader.' };
    }
    // Naming a new leader steps the old one down to the rank below, so a faction never has two
    if (rank === leaderRank) for (const [id, m] of Object.entries(rosterOf(fid))) if (m.rank === leaderRank && Number(id) !== t) { m.rank = Math.min(leaderRank + 1, lowestRank(fid)); if (isOnline(Number(id))) mirror(Number(id)); }
    const err = setMember(fid, t, rank);
    if (err) return { error: err };
    const title = f.ranks[rank].title;
    if (isOnline(t)) system(t, `You are now ${title} of ${f.name}.`);
    audit(`FACTION ${who(a)} made ${rosterOf(fid)[String(t)].name} ${title} of ${f.name}`);
    return { text: `${rosterOf(fid)[String(t)].name} is now ${title}.` };
  };
  onUi('factionKick', (a, args) => {
    if (!fresh(a, args)) return;
    const fid = String(args[1] || ''); const r = kickMember(a, fid, Number(args[2]) >>> 0);
    reply(a, r.error || r.text, fid, !!r.error);
  });
  onUi('factionSetRank', (a, args) => {
    if (!fresh(a, args)) return;
    const fid = String(args[1] || ''); const r = setRankOf(a, fid, Number(args[2]) >>> 0, Math.floor(Number(args[3])));
    reply(a, r.error || r.text, fid, !!r.error);
  });
  globalThis.__dboGuildKick = (a, fid, t) => kickMember(a >>> 0, String(fid), Number(t) >>> 0);
  globalThis.__dboGuildSetRank = (a, fid, t, rank, court) => setRankOf(a >>> 0, String(fid), Number(t) >>> 0, Math.floor(Number(rank)), !!court);
  globalThis.__dboGuildInvite = (a, t, fid) => { const text = invite(a >>> 0, Number(t) >>> 0, String(fid)); return /^You invited/.test(text) ? { text } : { error: text }; };
  onUi('factionLeave', (a, args) => {
    if (!fresh(a, args)) return;
    const fid = String(args[1] || ''); const f = FACTIONS.get(fid);
    if (!f || !entryOf(fid, a)) return reply(a, 'You are not in that faction.', fid, true);
    removeMember(fid, a);
    audit(`FACTION ${who(a)} left ${f.name}`);
    reply(a, `You have left ${f.name}.`, '', false);
  });
  // A Lead GM adds a character, online or offline, at the lowest rank (the Faction tab's staff view)
  const addMember = (a, fid, query) => {
    const f = FACTIONS.get(fid);
    if (!isLeadStaff(a)) return { error: 'Only a Lead GM or above adds members.' };
    if (!f) return { error: 'No such faction.' };
    const t = findAnyByName(String(query || '').trim());
    if (t < 0) return { error: `${-t} characters have that name. Use their #TAG.` };
    if (!t) return { error: 'No character by that name or #TAG.' };
    if (entryOf(fid, t)) return { error: `${nameOf(t)} is already in ${f.name}.` };
    if (!fits(t, f)) return { error: `${nameOf(t)} could never belong to ${f.name}.` };
    const err = setMember(fid, t, lowestRank(fid));
    if (err) return { error: err };
    const title = f.ranks[lowestRank(fid)].title;
    ST.invites.set(t >>> 0, invitesOf(t).filter((i) => i.fid !== fid));
    if (isOnline(t)) system(t, `You have been made ${title} of ${f.name}.`);
    audit(`FACTION GM ${who(a)} added ${who(t)} to ${f.name} as ${title}${isOnline(t) ? '' : ' (offline)'}`);
    return { text: `${nameOf(t)} is now ${title} of ${f.name}.${isOnline(t) ? '' : ' They are offline and will see it when they return.'}` };
  };
  onUi('factionAdd', (a, args) => {
    if (!fresh(a, args)) return;
    const fid = String(args[1] || ''); const r = addMember(a, fid, args[2]);
    reply(a, r.error || r.text, fid, !!r.error);
  });
  // The whole rank list at once: [{ title, role, from }], from = the rank's index before the edit, or -1 for a new one.
  // A leader may only rename; a Lead GM may also add, move and remove ranks. Members keep their rank through a move
  // (they are stored by index, so the roster is renumbered in the same write); a rank somebody holds cannot go.
  const editRanks = (a, fid, list) => {
    const f = FACTIONS.get(fid);
    if (!f) return { error: 'No such faction.' };
    const lead = isLeadStaff(a);
    if (!lead && (rankOf(fid, a) || {}).role !== 'leader') return { error: 'Only the leader renames ranks, and only a Lead GM adds, moves or removes them.' };
    if (!Array.isArray(list)) return { error: 'That rank list is not possible.' };
    const next = list.slice(0, RANKS_MAX + 1).map((r) => ({ title: cleanTitle(r && r.title), role: String((r && r.role) || ''), from: Number.isInteger(r && r.from) ? r.from : -1 }));
    const froms = next.map((r) => r.from).filter((x) => x >= 0);
    if (froms.some((x) => x >= f.ranks.length) || new Set(froms).size !== froms.length) return { error: 'That rank list is not possible.' };
    if (!lead && (next.length !== f.ranks.length || next.some((r, i) => r.from !== i || r.role !== f.ranks[i].role))) return { error: 'You may rename your ranks. A Lead GM adds, moves or removes them.' };
    const bad = ranksProblem(next);
    if (bad) return { error: bad };
    // A hold's or stronghold's ranks that court offices set (court.js, by title) keep their title and stay
    if (f.kind === 'hold' || f.kind === 'stronghold') {
      const tied = typeof globalThis.__dboCourtTiedTitles === 'function' ? globalThis.__dboCourtTiedTitles() : [];
      for (let i = 0; i < f.ranks.length; i++) {
        if (!tied.includes(f.ranks[i].title.toLowerCase())) continue;
        const kept = next.find((r) => r.from === i);
        if (!kept || kept.title.toLowerCase() !== f.ranks[i].title.toLowerCase()) return { error: `${f.ranks[i].title} is set by a court office, so it keeps its title and cannot be removed.` };
      }
      // Nor may another rank take such a title (a new one, or a rename): the office would then set the wrong rank
      const taken = next.find((r) => tied.includes(r.title.toLowerCase()) && !(r.from >= 0 && f.ranks[r.from].title.toLowerCase() === r.title.toLowerCase()));
      if (taken) return { error: `${taken.title} is a title a court office sets; choose another.` };
    }
    const roster = rosterOf(fid);
    const held = (i) => Object.values(roster).filter((e) => e.rank === i).length;
    for (let i = 0; i < f.ranks.length; i++) if (!froms.includes(i) && held(i)) return { error: `${f.ranks[i].title} cannot go: ${held(i)} ${held(i) === 1 ? 'member holds' : 'members hold'} it.` };
    const map = new Map(next.map((r, i) => [r.from, i]).filter(([from]) => from >= 0));
    // A member stored at a rank the list no longer has (a stale index) lands on the new lowest rank
    const newIndex = (old) => (map.has(old) ? map.get(old) : next.length - 1);
    for (const [role, cap] of Object.entries(CAPS)) {
      const n = Object.values(roster).filter((e) => (next[newIndex(e.rank)] || {}).role === role).length;
      if (Number(cap) && n > Number(cap)) return { error: `${f.name} may have only ${cap} with the ${role} role, and ${n} would hold it.` };
    }
    const prose = typeof globalThis.__dboProseProblem === 'function' ? globalThis.__dboProseProblem : null;
    const word = prose ? next.map((r) => prose(r.title)).find(Boolean) : null;
    if (word) return { error: `The word "${word}" will not do in a rank title.` };
    const renamed = next.filter((r) => r.from >= 0 && f.ranks[r.from].title !== r.title).map((r) => [f.ranks[r.from].title, r.title]);
    const old = f.ranks;
    const ranks = next.map((r) => ({ title: r.title, role: r.role }));
    const prev = OVR[fid];
    OVR[fid] = { ranks, by: who(a), at: Date.now() };
    try { saveOverrides(); } catch (e) { if (prev) OVR[fid] = prev; else delete OVR[fid]; log('guild-overrides.json write failed', e.message); return { error: 'The ranks could not be saved. Try again later.' }; }
    f.ranks = ranks;
    for (const e of Object.values(roster)) e.rank = newIndex(e.rank);
    save();
    for (const id of Object.keys(roster).map(Number)) if (isOnline(id)) mirror(id);
    // economy.js keeps a non-hold faction's wages by rank title: every rename at once, so a swap or a chain keeps each wage
    if (renamed.length && typeof globalThis.__dboEconomyRanksRenamed === 'function') { try { globalThis.__dboEconomyRanksRenamed(fid, renamed); } catch (e) { log('guilds: wage rename failed', e.message); } }
    audit(`FACTION ${lead ? 'GM ' : ''}${who(a)} set the ranks of ${f.name}: ${old.map((r) => r.title).join(', ')} -> ${ranks.map((r) => `${r.title} (${r.role})`).join(', ')}`);
    return { text: `The ranks of ${f.name} are saved.` };
  };
  onUi('factionRanksEdit', (a, args) => {
    if (!fresh(a, args)) return;
    const fid = String(args[1] || ''); const r = editRanks(a, fid, args[2]);
    reply(a, r.error || r.text, fid, !!r.error);
  });

  // ---- the Court tab (court.js): a zone's hold or stronghold faction is its household ---------------------------
  const courtFactionOf = (zoneId) => [...FACTIONS.values()].find((f) => (f.kind === 'hold' || f.kind === 'stronghold') && f.zone === String(zoneId)) || null;
  globalThis.__dboCourtFaction = (zoneId) => { const f = courtFactionOf(zoneId); return f ? f.id : null; };
  globalThis.__dboCourtHousehold = (a, zoneId) => {
    const f = courtFactionOf(zoneId); if (!f) return null;
    const view = factionView(a >>> 0, f.id);
    // The invitations the household has out, for those who may invite
    const pending = !view.canInvite ? [] : [...ST.invites.entries()].flatMap(([t, list]) => (list || [])
      .filter((i) => i.fid === f.id && Date.now() - i.at < INVITE_MS).map((i) => ({ actorId: Number(t) >>> 0, name: nameOf(Number(t) >>> 0), from: nameOf(i.from), at: i.at })));
    return Object.assign(view, { pending, mine: invitesOf(a).some((i) => i.fid === f.id) });
  };
  // The office is the source of truth (Nate, 3 Oct, Q3): seating someone sets their household rank to the office's
  // (titles: the first of these the faction has, or '@leader'); unseating drops it to the lowest rank if they still hold
  // the office's rank. An office with no matching rank only makes sure the holder is in the household.
  const courtRankIndex = (f, titles) => {
    for (const t of titles || []) {
      if (t === '@leader') { const i = f.ranks.findIndex((r) => r.role === 'leader'); if (i >= 0) return i; continue; }
      const i = f.ranks.findIndex((r) => r.title.toLowerCase() === String(t).toLowerCase());
      if (i >= 0) return i;
    }
    return -1;
  };
  globalThis.__dboCourtSync = (zoneId, actor, titles, seated) => {
    const f = courtFactionOf(zoneId); const t = Number(actor) >>> 0;
    if (!f || !t) return null;
    const want = courtRankIndex(f, titles);
    const e = entryOf(f.id, t);
    if (!seated) {
      if (!e || want < 0 || e.rank !== want) return null;
      const err = setMember(f.id, t, lowestRank(f.id));
      return err || `${nameOf(t)} is ${f.ranks[lowestRank(f.id)].title} of ${f.name} again.`;
    }
    const rank = want >= 0 ? want : (e ? e.rank : lowestRank(f.id));
    if (e && e.rank === rank) return null;
    const leaderRank = f.ranks.findIndex((r) => r.role === 'leader');
    if (rank === leaderRank) for (const [id, m] of Object.entries(rosterOf(f.id))) if (m.rank === leaderRank && Number(id) !== t) { m.rank = Math.min(leaderRank + 1, lowestRank(f.id)); if (isOnline(Number(id))) mirror(Number(id)); }
    const err = setMember(f.id, t, rank);
    if (err) { log(`court: ${err}`); return err; }
    return `${nameOf(t)} is ${f.ranks[rank].title} of ${f.name}.`;
  };

  // ---- X menu: "Invite to <faction>" --------------------------------------------------------------
  globalThis.__dboFactionMenuEntries = (a, t) => membershipsOf(a)
    .filter((m) => can(m.fid, a, 'invite') && !entryOf(m.fid, t))
    .map((m) => ({ id: `faction:${m.fid}`, label: `Invite to ${FACTIONS.get(m.fid).name}` }));
  globalThis.__dboFactionMenuAction = (a, id, t) => {
    if (!String(id).startsWith('faction:')) return false;
    personal(a, invite(a, t, String(id).slice(8)));
    return true;
  };

  // ---- chat -----------------------------------------------------------------------------------------
  registerChatCommand('faction', (a, args) => {
    const [sub, ...rest] = String(args || '').trim().split(/\s+/);
    const s = (sub || '').toLowerCase();
    // A journal client gets its Faction tab (journal.js), never panel 37
    if (!s || s === 'menu') {
      try { if (typeof globalThis.__dboJournalOpenTab === 'function' && globalThis.__dboJournalOpenTab(a >>> 0, 'faction')) return; } catch (e) { log('guilds: journal open failed', e.message); }
      return openMenu(a);
    }
    if (s === 'list') return personal(a, [...FACTIONS.values()].filter((f) => !f.secret || isAdmin(a) || entryOf(f.id, a)).map((f) => `${f.id} (${f.name})`).join(', '));
    // Where a faction is seated. A hall the player cannot reach is not worth naming, so only Bruma shows while
    // the playtest is locked there.
    // A leader records where the faction keeps its things. Access is the leader's business: housing locks it and
    // cuts the keys, and this never opens anything.
    if (s === 'storage') {
      const mine = membershipsOf(a).filter((m) => isLeadStaff(a) || can(m.fid, a, 'setRank'));
      const fid = (rest[1] && String(rest[1]).toLowerCase()) || (rest[0] && FACTIONS.get(String(rest[0]).toLowerCase()) ? String(rest[0]).toLowerCase() : '') || (mine[0] || {}).fid;
      const f = fid && FACTIONS.get(fid);
      if (!f) return personal(a, 'Only a faction leader sets the storage. Usage: /faction storage [faction] | /faction storage clear [faction]');
      if (!isLeadStaff(a) && !can(fid, a, 'setRank')) return personal(a, `Your rank in ${f.name} does not set the storage.`);
      if (String(rest[0] || '').toLowerCase() === 'clear') {
        if (!STORES[fid]) return personal(a, `${f.name} has no storage recorded.`);
        delete STORES[fid]; saveStores(); audit(`FACTION ${who(a)} cleared the storage of ${f.name}`);
        return personal(a, `${f.name} no longer has a storage recorded.`);
      }
      if (rest[0] && !FACTIONS.get(String(rest[0]).toLowerCase())) return personal(a, `No such faction: ${rest[0]} (/faction list)`);
      const ref = propertyAt(a);
      if (!ref) return personal(a, 'Stand at a claimed door or container of yours and say /faction storage again.');
      const H = globalThis.__dboHousing;
      const rec = H && typeof H.recordOf === 'function' ? H.recordOf(ref) : null;
      if (!rec || !rec.owner) return personal(a, 'That property belongs to nobody yet. Have it granted first, then record it.');
      const me = Number(profileOf(a)) || 0;
      if (!isLeadStaff(a) && rec.owner !== me) return personal(a, `That property belongs to ${rec.ownerName || 'someone else'}. Record one of your own.`);
      const hall = hallOf(f);
      STORES[fid] = { ref: ref >>> 0, name: rec.name || 'the strongbox', hall: hall ? hall.name : '', by: nameOf(a), at: Date.now() };
      saveStores();
      audit(`FACTION ${who(a)} set the storage of ${f.name} to ${rec.name || ref.toString(16)}`);
      return personal(a, `${f.name} keeps its things in ${rec.name || 'that container'}${hall ? ` at ${hall.name}` : ''}. Lock it and cut keys for whoever should reach it.`);
    }
    if (s === 'hall' || s === 'halls') {
      const one = rest[0] && FACTIONS.get(String(rest[0]).toLowerCase());
      if (rest[0] && !one) return personal(a, `No such faction: ${rest[0]} (/faction list)`);
      const seen = one ? [one] : [...FACTIONS.values()].filter((f) => !f.secret || isAdmin(a) || entryOf(f.id, a));
      const storeLine = (f) => { const st = storageOf(f.id); return st && (isAdmin(a) || entryOf(f.id, a)) ? `, storage: ${st.name}` : ''; };
      // A seat outside the playtest's region is real but cannot be walked to yet, and saying so is kinder than
      // letting someone hunt for it (Mythic Dawn keeps the museum in Dawnstar).
      const reach = (h) => (h.zone && h.zone !== PLAYTEST_ZONE ? ' (not reachable yet)' : '');
      const lines = seen.filter((f) => hallOf(f)).map((f) => { const h = hallOf(f); return `${f.name}: ${h.name}${h.shared ? ' (shared)' : ''}${reach(h)}${h.note ? ` - ${h.note}` : ''}${storeLine(f)}`; });
      if (one) return personal(a, lines[0] || `${one.name} has no seat at all.`);
      return personal(a, lines.length ? `Faction seats: ${lines.join(' | ')}` : 'No faction has a seat yet.');
    }
    if (s === 'accept') return personal(a, accept(a, rest[0] || (invitesOf(a)[0] || {}).fid || ''));
    if (s === 'invite') { const t = findByName(rest[0] || ''); const fid = rest[1] || (membershipsOf(a).find((m) => can(m.fid, a, 'invite')) || {}).fid; return personal(a, t ? invite(a, t, fid) : 'Usage: /faction invite <player|#TAG> [faction]'); }
    if (s === 'leader') {
      if (!isLeadStaff(a)) return personal(a, 'Only a Lead GM or above names the first leader of a faction.');
      const t = findByName(rest[0] || ''); const fid = rest[1] || ''; const f = FACTIONS.get(fid);
      if (!t || !f) return personal(a, 'Usage: /faction leader <player|#TAG> <faction id>   (/faction list)');
      const leaderRank = f.ranks.findIndex((r) => r.role === 'leader');
      for (const [id, m] of Object.entries(rosterOf(fid))) if (m.rank === leaderRank && Number(id) !== (t >>> 0)) m.rank = Math.min(leaderRank + 1, lowestRank(fid));
      const err = setMember(fid, t, leaderRank); if (err) return personal(a, err);
      system(t, `You are now ${f.ranks[leaderRank].title} of ${f.name}.`);
      audit(`FACTION GM ${who(a)} named ${who(t)} ${f.ranks[leaderRank].title} of ${f.name}`);
      return personal(a, `${display(t)} now leads ${f.name}.`);
    }
    if (s === 'remove') {
      if (!isLeadStaff(a)) return personal(a, 'Use the faction menu (F3) to remove members.');
      const fid = rest[1] || ''; const id = findMember(fid, rest[0]); if (!FACTIONS.get(fid) || !id) return personal(a, 'Usage: /faction remove <name|#TAG> <faction id>');
      removeMember(fid, id); return personal(a, 'Removed.');
    }
    personal(a, 'Usage: /faction [menu|list|accept [id]|invite <player> [id]]  admins: /faction leader <player> <id>, /faction remove <name> <id>');
  }, { help: '[menu|list|accept|invite] your factions (F3 opens the menu)' });

  // ---- packs: the leader runs with the pale coat, and a packmate who kills them in beast form takes the pack
  const packs = () => [...FACTIONS.values()].filter((f) => f.kind === 'pack');
  const leaderRankOf = (f) => f.ranks.findIndex((r) => r.role === 'leader');
  globalThis.__dboGuildIsPackLeader = (a) => packs().some((f) => { const e = entryOf(f.id, a); return !!e && e.rank === leaderRankOf(f); });
  globalThis.__dboGuildPackChallenge = (victim, killer) => {
    for (const f of packs()) {
      const lead = leaderRankOf(f); const ev = entryOf(f.id, victim), ek = entryOf(f.id, killer);
      if (!ev || !ek || ev.rank !== lead) continue;
      ev.rank = Math.min(lead + 1, lowestRank(f.id));
      const err = setMember(f.id, killer, lead); if (err) { log(`pack challenge: ${err}`); continue; }
      for (const m of Object.keys(rosterOf(f.id)).map(Number)) if (isOnline(m)) personal(m, `${nameOf(killer)} has brought down ${nameOf(victim)} and leads ${f.name} now.`);
      audit(`FACTION ${who(killer)} took ${f.name} from ${who(victim)} by challenge`);
    }
  };

  // Names and tags follow a character across renames and masks being taken off
  globalThis.__dboFactionLogin = (a) => {
    let changed = false;
    for (const m of membershipsOf(a)) { if (m.e.name !== nameOf(a) || m.e.tag !== tagOf(a)) { m.e.name = nameOf(a); m.e.tag = tagOf(a); changed = true; } }
    if (changed) save();
    mirror(a);
  };

  const total = [...FACTIONS.values()].length;
  const members = Object.values(ST.members).reduce((n, r) => n + Object.keys(r || {}).length, 0);
  log(`factions on: ${total} factions (${[...FACTIONS.values()].filter((f) => f.kind === 'cult').length} cults, ${[...FACTIONS.values()].filter((f) => f.secret).length} secret), ${members} memberships, menu F3 (widget ${WIDGET_ID})`);
};
