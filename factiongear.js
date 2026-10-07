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
      const file = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      const out = {}; for (const [k, v] of Object.entries(file.items || {})) out[norm(k)] = v;
      // A faction's war uniform: its own items and the worn-only extras (faction id -> set of item descs)
      const uni = new Map();
      const add = (fid, desc) => { if (!uni.has(fid)) uni.set(fid, new Set()); uni.get(fid).add(norm(desc)); };
      for (const [desc, v] of Object.entries(out)) for (const fid of v.factions || []) add(fid, desc);
      for (const [fid, list] of Object.entries(file.uniforms || {})) for (const desc of list || []) add(fid, desc);
      S.items = out; S.uniforms = uni; S.mtime = mtime;
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

  // ---- war uniforms (Nate, 2026-09-28: "with wars, people have to wear the faction uniforms") ------------------------
  // Wearing the uniform is wearing a body piece (BOD2 slot 32, bit 2) of the faction's uniform. realm.js asks it for
  // each fighter at a standard. null: the faction has no uniform to wear, so the rule cannot hold it.
  const bodyCache = new Map();
  const isBody = (baseId) => {
    if (bodyCache.has(baseId)) return bodyCache.get(baseId);
    let yes = false;
    try {
      const r = mp.lookupEspmRecordById(baseId >>> 0);
      const f = r && r.record && String(r.record.type) === 'ARMO' ? (r.record.fields || []).find((x) => x && x.type === 'BOD2' && x.data instanceof Uint8Array) : null;
      if (f && f.data.byteLength >= 4) yes = (new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength).getUint32(0, true) & (1 << 2)) !== 0;
    } catch (e) { yes = false; }
    bodyCache.set(baseId, yes);
    return yes;
  };
  const wornIds = (a) => {
    let eq = null; try { eq = mp.get(a >>> 0, 'equipment'); } catch (e) { return []; }
    const entries = eq && eq.inv && Array.isArray(eq.inv.entries) ? eq.inv.entries : [];
    return entries.filter((e) => e && (e.worn || e.wornLeft)).map((e) => Number(e.baseId) >>> 0);
  };
  const idOf = (desc) => { try { return mp.getIdFromDesc(String(desc)) >>> 0; } catch (e) { return 0; } };
  // A uniform needs a body piece to wear: Windhelm's guard list is only a shield, so Windhelm has none to be held to
  const uniformOf = (fid) => {
    items();
    const set = S.uniforms && S.uniforms.get(String(fid));
    return set && [...set].some((d) => isBody(idOf(d))) ? set : null;
  };
  globalThis.__dboInUniform = (a, fid) => {
    const set = uniformOf(fid);
    if (!set) return null;
    return wornIds(a).some((id) => set.has(norm(descOf(id))) && isBody(id));
  };
  globalThis.__dboHasUniform = (fid) => !!uniformOf(fid);

  // Called by regions.js's craft hook: false refuses the craft (and says why), true lets it on
  // True when a makes their own faction's gear as a member of the right rank (not as staff): regions.js lets that craft skip
  // the province rule, since the faction rule already says who makes it (Nate, 7 Oct: the Dawnguard in Bruma)
  globalThis.__dboFactionGearMember = (actorId, itemId) => {
    try { return check(Number(actorId) >>> 0, Number(itemId) >>> 0).why === 'member'; } catch (e) { return false; }
  };
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
