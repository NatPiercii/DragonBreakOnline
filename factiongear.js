// Faction gear: an item in faction-gear.json may be crafted only by one of its factions' own smiths and tailors, loaded
// by gamemode.js. Nate, 2026-09-28: "legion armor can only be made by Imperial legion faction, hold armor per hold
// blacksmith, Orcish Clan for the strongholds, etc", armor and weapons alike.
//
// Who may: a member of one of the item's factions (guilds.js, __dboGuildsOf) whose rank role is the item's role
// (blacksmith for forge work, tailor for the loom and tanning rack) or leader, which is Nat's faction spec of 2026-09-21.
// Everyone else is refused with a line naming who can make it. Admins pass unless /factiongear test is on for them.
//
// The check runs in regions.js's craft hook, before its province rule: a refused craft never reaches the engine's
// OnFireSuccess, so the server keeps the materials and never adds the product (the same mechanism as the province
// rule; see regions.js). The list is built by tools/faction_gear.py; the file is re-read when it changes.
//
// Config "factionGear": { enabled (off by default: shipped off until the in-game test), adminBypass }
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, audit, who, cfg, registerChatCommand, isAdmin, sendPacket } = api;
  // Off for players until the in-game test; an admin in test mode is held to the rules even while it is off
  const CFG = Object.assign({ enabled: false, adminBypass: true }, cfg.factionGear || {});
  const FILE = path.resolve('faction-gear.json');
  const S = globalThis.__dboFactionGearState = globalThis.__dboFactionGearState || { items: null, mtime: -1, checkedAt: 0, testing: new Set(), toldAt: new Map() };

  const norm = (d) => { const s = String(d || ''); const i = s.indexOf(':'); if (i < 0) return s.toLowerCase(); const n = parseInt(s.slice(0, i), 16); return (Number.isFinite(n) ? n.toString(16) : s.slice(0, i).toLowerCase()) + ':' + s.slice(i + 1).toLowerCase(); };
  const descOf = (id) => { try { return String(mp.getDescFromId(id >>> 0)); } catch (e) { return ''; } };
  // Re-read at most every 5 s, and only when the file changed; a half-saved file keeps the last good list
  const items = () => {
    const now = Date.now();
    if (S.items && now - S.checkedAt < 5000) return S.items;
    S.checkedAt = now;
    let mtime = -1; try { mtime = fs.statSync(FILE).mtimeMs; } catch (e) { return S.items || {}; }
    if (mtime === S.mtime && S.items) return S.items;
    try {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')).items || {};
      const out = {}; for (const [k, v] of Object.entries(raw)) out[norm(k)] = v;
      S.items = out; S.mtime = mtime;
      log(`factiongear: ${Object.keys(out).length} faction items from ${path.basename(FILE)}`);
    } catch (e) { log(`factiongear: ${FILE} unreadable (${e.message})${S.items ? ', keeping the last good list' : ''}`); }
    return S.items || {};
  };

  const factionName = (fid) => { try { const f = typeof globalThis.__dboGuildInfo === 'function' ? globalThis.__dboGuildInfo(fid) : null; return (f && f.name) || fid; } catch (e) { return fid; } };
  const ROLE_WORD = { blacksmith: 'smiths', tailor: 'tailors' };
  const listNames = (names) => (names.length <= 1 ? names.join('') : names.length === 2 ? `${names[0]} or ${names[1]}` : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`);

  // { ok, entry, why } for the crafter a making itemId
  const check = (a, itemId) => {
    if (!CFG.enabled && !S.testing.has(a >>> 0)) return { ok: true, why: 'off' };
    const entry = items()[norm(descOf(itemId))];
    if (!entry) return { ok: true, why: 'open' };
    const mine = (typeof globalThis.__dboGuildsOf === 'function' ? globalThis.__dboGuildsOf(a) : null) || [];
    const role = entry.role || 'blacksmith';
    const ok = mine.some((m) => (entry.factions || []).includes(m.id) && (m.role === role || m.role === 'leader'));
    if (ok) return { ok: true, entry, why: 'member' };
    if (CFG.adminBypass && isAdmin(a) && !S.testing.has(a >>> 0)) return { ok: true, entry, why: 'admin' };
    return { ok: false, entry, why: mine.some((m) => (entry.factions || []).includes(m.id)) ? 'rank' : 'outsider' };
  };

  // "Imperial Helmet is made only by the Imperial Legion's smiths." and, for a member of the wrong rank, the rank it needs
  const makers = (e) => {
    if (e.set === 'Orcish') return "the strongholds'";
    const names = [...new Set((e.factions || []).map(factionName))];
    if (names.length > 3) return "the vampire clans'";
    return `the ${listNames(names)}'s`.replace(/s's$/, "s'");
  };
  const refusalText = (v) => {
    const e = v.entry || {};
    const role = e.role || 'blacksmith';
    const bench = role === 'tailor' ? 'loom' : 'forge';
    const rank = v.why === 'rank' ? ` You are one of them, but it takes their ${role === 'tailor' ? 'Tailor' : 'Blacksmith'} rank or their leader.` : '';
    return `${e.name || 'That'} is made only by ${makers(e)} ${ROLE_WORD[role] || 'crafters'}.${rank} Your materials return when you leave the ${bench}.`;
  };
  const refuse = (a, v) => {
    const now = Date.now();
    if (now - (S.toldAt.get(a) || 0) < 1500) return;
    S.toldAt.set(a, now);
    const text = refusalText(v);
    personal(a, text);
    try { sendPacket(a, { customPacketType: 'dboNotice', text }); } catch (e) { /* the chat line is enough */ }
    audit(`FACTIONGEAR refused ${who(a)} ${(v.entry && v.entry.name) || '?'} (${(v.entry && v.entry.set) || '?'}, ${v.why})`);
  };

  // Called by regions.js's craft hook: false refuses the craft (and says why), true lets it on
  globalThis.__dboFactionCraft = (actorId, itemId) => {
    const a = Number(actorId) >>> 0;
    let v = null;
    try { v = check(a, Number(itemId) >>> 0); } catch (e) { log('factiongear: check failed', e.stack || e.message); return true; }
    if (v.ok) return true;
    refuse(a, v);
    return false;
  };

  registerChatCommand('factiongear', (a, args) => {
    if (!isAdmin(a)) return personal(a, 'Admins only.');
    const arg = String(Array.isArray(args) ? args[0] || '' : args || '').trim().toLowerCase();
    if (arg === 'test') {
      if (S.testing.has(a >>> 0)) S.testing.delete(a >>> 0); else S.testing.add(a >>> 0);
      return personal(a, S.testing.has(a >>> 0) ? 'Faction gear test on: you are held to the faction rules like a player.' : 'Faction gear test off: admins pass again.');
    }
    const n = Object.keys(items()).length;
    const test = S.testing.has(a >>> 0) ? ' Test mode is on for you.' : ' /factiongear test holds you to the rules.';
    personal(a, `Faction gear is ${CFG.enabled ? 'on' : 'off for players; test mode still applies to you'}: ${n} items listed in faction-gear.json.${test}`);
  }, { admin: true, help: '[test] faction gear rules; test holds an admin to them' });

  items();
  return { check };
};
