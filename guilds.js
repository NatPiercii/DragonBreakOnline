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
    onlineActors, isAdmin, findByName, audit, who, cfg } = api;

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
  for (const f of DEFS.factions || []) {
    const ranks = Array.isArray(f.ranks) ? f.ranks : ((DEFS.templates || {})[f.template] || []);
    if (!f.id || !ranks.length) { log(`faction ${f.id || '?'} has no ranks, skipped`); continue; }
    FACTIONS.set(f.id, Object.assign({}, f, { ranks }));
  }

  // ---- membership state -------------------------------------------------------------------------
  // { factionId: { actorId: { rank, name, tag, since } } }
  const ST = globalThis.__dboGuildState || (globalThis.__dboGuildState = { members: readJson(STATE_PATH, {}), invites: new Map(), nonces: new Map() });
  const save = () => {
    try { fs.writeFileSync(STATE_PATH + '.tmp', JSON.stringify(ST.members, null, 1)); fs.renameSync(STATE_PATH + '.tmp', STATE_PATH); }
    catch (e) { log('guilds.json write failed', e.message); }
  };
  const rosterOf = (fid) => (ST.members[fid] = ST.members[fid] || {});
  const entryOf = (fid, a) => (ST.members[fid] || {})[String(a >>> 0)] || null;
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
  const fits = (a, f) => !f || !f.requires || isAdmin(a) || (typeof globalThis.__dboSuperKind === 'function' && globalThis.__dboSuperKind(a) === f.requires);

  // ---- invites ------------------------------------------------------------------------------------
  const invitesOf = (t) => (ST.invites.get(t >>> 0) || []).filter((i) => Date.now() - i.at < INVITE_MS);
  const invite = (a, t, fid) => {
    const f = FACTIONS.get(fid);
    if (!f) return 'No such faction.';
    if (!isAdmin(a) && !can(fid, a, 'invite')) return `Your rank in ${f.name} cannot invite.`;
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
      canInvite: admin || can(fid, a, 'invite'), canKick: admin || can(fid, a, 'kick'), canSetRank: admin || can(fid, a, 'setRank'),
      ranks: f.ranks.map((r) => ({ title: r.title, role: r.role })), members,
    };
  };
  const openMenu = (a, result, resultKind, focusFid) => {
    const nonce = `${(a >>> 0).toString(16)}-${Date.now().toString(36)}`;
    ST.nonces.set(a >>> 0, nonce);
    const mine = membershipsOf(a).map((m) => m.fid);
    const list = isAdmin(a) ? [...FACTIONS.keys()] : mine;
    const invites = invitesOf(a).map((i) => ({ factionId: i.fid, name: FACTIONS.get(i.fid).name, from: display(i.from) }));
    openWidget(a, {
      type: 'faction', id: WIDGET_ID, nonce, admin: isAdmin(a), self: a >>> 0,
      factions: list.map((fid) => factionView(a, fid)), invites, selected: focusFid || mine[0] || list[0] || '',
      result: result || '', resultKind: resultKind || '',
    }, true);
  };
  globalThis.__dboFactionMenu = (a) => openMenu(a >>> 0);
  // ledger.js: the factions a character belongs to (offline ones too), and whether an id names a faction
  globalThis.__dboGuildsOf = (a) => membershipsOf(a >>> 0).map((m) => { const f = FACTIONS.get(m.fid); return { id: m.fid, name: f.name, title: (f.ranks[m.e.rank] || {}).title || '', secret: !!f.secret }; });
  globalThis.__dboGuildExists = (id) => FACTIONS.has(String(id));
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
  onUi('factionKick', (a, args) => {
    if (!fresh(a, args)) return;
    const fid = String(args[1] || ''); const t = Number(args[2]) >>> 0; const f = FACTIONS.get(fid);
    if (!f || !entryOf(fid, t)) return reply(a, 'They are not in that faction.', fid, true);
    if (!isAdmin(a) && !(can(fid, a, 'kick') && outranks(fid, a, t))) return reply(a, 'You cannot remove someone of equal or higher rank.', fid, true);
    const name = rosterOf(fid)[String(t)].name;
    removeMember(fid, t);
    if (isOnline(t)) system(t, `You have been removed from ${f.name}.`);
    audit(`FACTION ${who(a)} removed ${name} from ${f.name}`);
    reply(a, `${name} is no longer in ${f.name}.`, fid, false);
  });
  onUi('factionSetRank', (a, args) => {
    if (!fresh(a, args)) return;
    const fid = String(args[1] || ''); const t = Number(args[2]) >>> 0; const rank = Math.floor(Number(args[3])); const f = FACTIONS.get(fid);
    if (!f || !entryOf(fid, t) || !(rank >= 0 && rank < f.ranks.length)) return reply(a, 'That rank change is not possible.', fid, true);
    const leaderRank = f.ranks.findIndex((r) => r.role === 'leader');
    if (!isAdmin(a)) {
      if (!can(fid, a, 'setRank')) return reply(a, 'Only the leader sets ranks.', fid, true);
      if (t === (a >>> 0)) return reply(a, 'Pass leadership by naming someone else leader.', fid, true);
    }
    // Naming a new leader steps the old one down to the rank below, so a faction never has two
    if (rank === leaderRank) for (const [id, m] of Object.entries(rosterOf(fid))) if (m.rank === leaderRank && Number(id) !== t) { m.rank = Math.min(leaderRank + 1, lowestRank(fid)); if (isOnline(Number(id))) mirror(Number(id)); }
    const err = setMember(fid, t, rank);
    if (err) return reply(a, err, fid, true);
    const title = f.ranks[rank].title;
    if (isOnline(t)) system(t, `You are now ${title} of ${f.name}.`);
    audit(`FACTION ${who(a)} made ${rosterOf(fid)[String(t)].name} ${title} of ${f.name}`);
    reply(a, `${rosterOf(fid)[String(t)].name} is now ${title}.`, fid, false);
  });
  onUi('factionLeave', (a, args) => {
    if (!fresh(a, args)) return;
    const fid = String(args[1] || ''); const f = FACTIONS.get(fid);
    if (!f || !entryOf(fid, a)) return reply(a, 'You are not in that faction.', fid, true);
    removeMember(fid, a);
    audit(`FACTION ${who(a)} left ${f.name}`);
    reply(a, `You have left ${f.name}.`, '', false);
  });

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
    if (!s || s === 'menu') return openMenu(a);
    if (s === 'list') return personal(a, [...FACTIONS.values()].filter((f) => !f.secret || isAdmin(a) || entryOf(f.id, a)).map((f) => `${f.id} (${f.name})`).join(', '));
    if (s === 'accept') return personal(a, accept(a, rest[0] || (invitesOf(a)[0] || {}).fid || ''));
    if (s === 'invite') { const t = findByName(rest[0] || ''); const fid = rest[1] || (membershipsOf(a).find((m) => can(m.fid, a, 'invite')) || {}).fid; return personal(a, t ? invite(a, t, fid) : 'Usage: /faction invite <player|#TAG> [faction]'); }
    if (s === 'leader') {
      if (!isAdmin(a)) return personal(a, 'Only an admin names the first leader of a faction.');
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
      if (!isAdmin(a)) return personal(a, 'Use the faction menu (F3) to remove members.');
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
