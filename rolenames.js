// DragonBreak Online: the names staff give offices and ranks (Nate, 4 Oct 2026: "GMs can rename roles in Holds/factions
// live"). Loaded by gamemode.js before guilds.js and court.js, on every hot reload.
//
// A name here is shown in place of the default and never replaces the role's id: an office stays "steward" in
// officials.json, appointRules and wages, and a faction rank keeps its own title in guild-defs.json, guild-overrides.json,
// the roster's title stamps and the court's office-to-rank map (court.js factionRanks). So nothing keyed on the role
// changes, the rank remap still finds every member, and regenerated data is shown under the same staff name as long as
// the role it names is still there.
//
// role-names.json (runtime, gitignored: the remote is public), written whole on every change:
//   { offices: { <zoneId>: { <office id>: { name, by, at } } },
//     ranks:   { <factionId>: { <own title, lower case>[#n]: { name, canon, by, at } } } }
// #n tells apart a faction's ranks of one title (the Blades have two Blades); canon keeps the title's case for listings.
//
// Who: a Lead GM and above (config roleNames.staff 'lead'); 'gm' lets every GM. Where: the F3 Court tab (offices and the
// household's ranks), the Faction tab's rank editor (a Lead GM's renames land here), and /rolename in chat.
// An office renamed at a court renames the household rank it sets too, while the two were shown alike (Steward and
// Steward, Jarl and Jarl), so a hold's office and rank never part by accident.
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { log, audit, who, registerChatCommand, zoneList, zoneById } = api;
  const personal = typeof api.personal === 'function' ? api.personal : () => {};
  const system = typeof api.system === 'function' ? api.system : () => {};
  const isAdmin = typeof api.isAdmin === 'function' ? api.isAdmin : () => false;
  const isLeadStaff = typeof api.isLeadStaff === 'function' ? api.isLeadStaff : () => false;
  const onlineActors = typeof api.onlineActors === 'function' ? api.onlineActors : () => [];
  const profileOf = typeof api.profileOf === 'function' ? api.profileOf : () => -1;
  const readOfficials = typeof api.readOfficials === 'function' ? api.readOfficials : () => ({});
  const C = Object.assign({ enabled: true, staff: 'lead', titleMin: 2, titleMax: 40 }, ((api.cfg || {}).roleNames) || {});
  const DEFAULTS = api.defaultTitles && typeof api.defaultTitles === 'object' ? api.defaultTitles : {};
  const PATH = path.resolve('role-names.json');
  const readJson = (p, dflt) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return dflt; } };
  const fn = (name) => (typeof globalThis[name] === 'function' ? globalThis[name] : null);
  const lower = (t) => String(t || '').toLowerCase();
  const canName = (a) => !!C.enabled && (String(C.staff) === 'gm' ? isAdmin(a) : isLeadStaff(a));

  // ---- the name rules ------------------------------------------------------------------------------------------------
  // The game's own text font (Tavern.spritefont) draws ASCII and Cyrillic only, and anything else as "?"; a title is
  // letters of those, spaces, apostrophes and hyphens ("Wise-Woman", "Hunt-Master", "Jarl's Fist")
  const FOLD = { '‘': "'", '’': "'", 'ʼ': "'", '`': "'", '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-' };
  const clean = (t) => String(t === undefined || t === null ? '' : t).replace(/[\u0000-\u001f\u007f]/g, '').replace(/./gu, (c) => FOLD[c] || c).replace(/\s+/g, ' ').trim();
  const FONT_OK = /^[A-Za-zЁА-яё' -]+$/;
  const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'i' };
  const fold = (s) => String(s).toLowerCase().replace(/./gu, (c) => LEET[c] || c).replace(/[^\p{L}]/gu, '');
  const words = () => {
    const r = readJson(path.resolve('name-filter.json'), {});
    const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x).map((x) => x.toLowerCase()) : []);
    return { blocked: list(r.blocked), reserved: list(r.reserved) };
  };
  // name-filter.json's blocked words inside any one word, or spelled out across short ones ("P U S S Y"), never across
  // two real words ("Night Watch" folds to "...twat..."): the same rule as charters.js hasBlocked
  const hasBlocked = (text, blocked) => {
    const chunks = []; let run = '';
    for (const w of String(text).split(/[\s-]+/).map(fold).filter(Boolean)) {
      if (w.length <= 2) { run += w; continue; }
      if (run) { chunks.push(run); run = ''; }
      chunks.push(w);
    }
    if (run) chunks.push(run);
    return chunks.some((c) => blocked.some((bad) => c.includes(bad)));
  };
  // { name } or { error }
  const check = (raw) => {
    const name = clean(raw);
    const min = Math.max(1, Number(C.titleMin) || 2), max = Math.max(min, Number(C.titleMax) || 40);
    if (name.length < min || name.length > max) return { error: `A title is ${min} to ${max} characters.` };
    if (!FONT_OK.test(name)) return { error: 'A title uses Latin or Cyrillic letters, spaces, apostrophes and hyphens only: the game\'s lettering has no others.' };
    if (/^[' -]|[' -]$/.test(name) || /[' -]{2}/.test(name)) return { error: 'A title cannot start or end with, or run together, spaces, apostrophes or hyphens.' };
    if (name.split(/[\s-]+/).some((w) => !/^\p{L}/u.test(w))) return { error: 'Each word of a title starts with a letter.' };
    const letters = name.replace(/[^\p{L}]/gu, '');
    if (letters.length >= 4 && letters === letters.toUpperCase()) return { error: 'Titles are not written in capitals.' };
    const w = words();
    if (hasBlocked(name, w.blocked)) return { error: 'That title will not do here. Choose one in keeping with the world.' };
    if (name.split(/[\s-]+/).map(fold).some((x) => w.reserved.includes(x))) return { error: 'That title would pass for staff or the server. Choose another.' };
    const prose = fn('__dboProseProblem');
    const bad = prose ? prose(name) : null;
    if (bad) return { error: `The word "${bad}" will not do in a title.` };
    return { name };
  };

  // ---- the store -----------------------------------------------------------------------------------------------------
  // Read whole at every load: every write is synchronous, so the file is always the truth and a hot reload inherits no
  // state of an older version of this file
  const load = () => {
    const raw = readJson(PATH, {});
    const out = { offices: {}, ranks: {} };
    let dropped = 0;
    for (const kind of ['offices', 'ranks']) {
      for (const [owner, table] of Object.entries((raw && raw[kind]) || {})) {
        if (!table || typeof table !== 'object') continue;
        for (const [key, e] of Object.entries(table)) {
          const name = e && clean(e.name);
          if (!name || !FONT_OK.test(name) || name.length > 80) { dropped++; continue; }
          (out[kind][lower(owner)] = out[kind][lower(owner)] || {})[lower(key)] = Object.assign({}, e, { name });
        }
      }
    }
    if (dropped) log(`role-names.json: ${dropped} unreadable name(s) ignored`);
    return out;
  };
  let S = load();
  const save = (next) => {
    fs.writeFileSync(PATH + '.tmp', JSON.stringify(next, null, 1));
    fs.renameSync(PATH + '.tmp', PATH);
    S = next;
  };
  const rankKey = (canon, nth) => `${lower(canon)}${Number(nth) > 0 ? `#${Number(nth)}` : ''}`;
  const officeName = (zoneId, rank) => { const e = ((S.offices[lower(zoneId)] || {})[lower(rank)]); return e ? e.name : null; };
  const officeDefault = (rank) => String(DEFAULTS[rank] || rank);
  const officeTitle = (zoneId, rank) => officeName(zoneId, rank) || officeDefault(rank);
  const rankName = (fid, canon, nth) => { const e = ((S.ranks[lower(fid)] || {})[rankKey(canon, nth)]); return e ? e.name : null; };

  // A faction's ranks as guilds.js holds them ([{ title, role }], its own titles), and each one's place among the ranks
  // of its title
  const ranksOf = (fid) => { const f = fn('__dboGuildRankList'); const r = f ? f(fid) : null; return Array.isArray(r) ? r : null; };
  const nthIn = (titles, i) => titles.slice(0, i).filter((t) => lower(t) === lower(titles[i])).length;
  const tiedTitles = () => { const f = fn('__dboCourtTiedTitles'); try { return f ? (f() || []).map(lower) : []; } catch (e) { return []; } };
  const courtKind = (fid) => { const f = fn('__dboGuildInfo'); const g = f ? f(fid) : null; return !!g && (g.kind === 'hold' || g.kind === 'stronghold'); };
  const factionName = (fid) => { const f = fn('__dboGuildInfo'); const g = f ? f(fid) : null; return (g && g.name) || fid; };

  // ---- changes -------------------------------------------------------------------------------------------------------
  // changes: [{ kind: 'office', zone, rank, name }, { kind: 'rank', fid, index, name }]; an empty name, or the default
  // itself, goes back to the default. opts.ranks: { fid: [{ title, role }] } checks against a rank list about to be saved
  // (guilds.js's editor), opts.link false leaves the household alone, opts.dry only checks. { text, done } or { error }.
  const apply = (a, changes, opts) => {
    const o = opts || {};
    if (!C.enabled) return { error: 'Renaming offices and ranks is switched off.' };
    if (!canName(a)) return { error: String(C.staff) === 'gm' ? 'Only staff rename offices and ranks.' : 'Only a Lead GM or above renames offices and ranks.' };
    const list = (Array.isArray(changes) ? changes : []).slice(0, 40);
    if (!list.length) return { error: 'Nothing to rename.' };
    const next = JSON.parse(JSON.stringify(S));
    const done = [];
    const touched = new Set();
    const zonesTouched = new Set(), factionsTouched = new Set();
    const rankLists = Object.assign({}, o.ranks || {});
    const listFor = (fid) => (rankLists[fid] = rankLists[fid] || ranksOf(fid));
    const shownRank = (store, fid, ranks, i) => { const titles = ranks.map((r) => r.title); const e = (store.ranks[lower(fid)] || {})[rankKey(titles[i], nthIn(titles, i))]; return e ? e.name : ranks[i].title; };
    const shownOffice = (store, zid, rank) => { const e = (store.offices[zid] || {})[rank]; return e ? e.name : officeDefault(rank); };
    const setRank = (fid, i, raw, via) => {
      const ranks = listFor(fid);
      if (!ranks || !(i >= 0 && i < ranks.length)) return { error: 'No such rank.' };
      const titles = ranks.map((r) => r.title);
      const canon = titles[i], key = rankKey(canon, nthIn(titles, i));
      if (touched.has(`r:${fid}:${key}`)) return null;
      touched.add(`r:${fid}:${key}`);
      const was = shownRank(next, fid, ranks, i);
      const reset = !clean(raw) || clean(raw) === canon;
      let name = canon;
      if (!reset) {
        const c = check(raw); if (c.error) return c;
        name = c.name;
        // A title a court office sets (court.js, by title) would read as that office's rank on another
        if (courtKind(fid) && tiedTitles().includes(lower(name)) && lower(name) !== lower(canon)) return { error: `${name} is a title a court office sets; choose another.` };
      }
      const table = (next.ranks[lower(fid)] = next.ranks[lower(fid)] || {});
      if (reset) delete table[key]; else table[key] = { name, canon, by: who(a), at: Date.now() };
      if (!Object.keys(table).length) delete next.ranks[lower(fid)];
      factionsTouched.add(fid);
      if (was !== name) done.push({ kind: 'rank', fid, index: i, canon, was, name, reset, via });
      return null;
    };
    for (const ch of list) {
      if (!ch || typeof ch !== 'object') return { error: 'That rename is not possible.' };
      if (ch.kind === 'office') {
        const z = zoneById(String(ch.zone || ''));
        const rank = lower(ch.rank);
        if (!z) return { error: 'No such court.' };
        if (!(z.officials || []).includes(rank)) return { error: `${z.name} has no such office.` };
        if (touched.has(`o:${z.id}:${rank}`)) continue;
        touched.add(`o:${z.id}:${rank}`);
        const was = shownOffice(next, z.id, rank);
        const reset = !clean(ch.name) || clean(ch.name) === officeDefault(rank);
        let name = officeDefault(rank);
        if (!reset) { const c = check(ch.name); if (c.error) return c; name = c.name; }
        const table = (next.offices[z.id] = next.offices[z.id] || {});
        if (reset) delete table[rank]; else table[rank] = { name, by: who(a), at: Date.now() };
        if (!Object.keys(table).length) delete next.offices[z.id];
        zonesTouched.add(z.id);
        if (was !== name) done.push({ kind: 'office', zone: z.id, zoneName: z.name, rank, was, name, reset });
        // The household rank this office sets, while it is shown as the office was
        const linkFn = fn('__dboCourtLinkedRank');
        const link = o.link === false || !linkFn ? null : linkFn(z.id, rank);
        if (link && link.fid) {
          const ranks = listFor(link.fid);
          if (ranks && link.index >= 0 && link.index < ranks.length && lower(shownRank(S, link.fid, ranks, link.index)) === lower(was)) {
            const err = setRank(link.fid, link.index, reset ? '' : name, `office:${z.id}:${rank}`);
            if (err) return err;
          }
        }
      } else if (ch.kind === 'rank') {
        const fid = String(ch.fid || '');
        if (!listFor(fid)) return { error: 'No such faction.' };
        const err = setRank(fid, Math.floor(Number(ch.index)), ch.name, '');
        if (err) return err;
      } else return { error: 'That rename is not possible.' };
    }
    // No two offices of a court, nor two ranks of a faction, shown alike once everything above is in (so a swap is fine)
    for (const zid of zonesTouched) {
      const z = zoneById(zid); const seen = new Map();
      for (const r of z.officials || []) { const k = lower(shownOffice(next, zid, r)); if (seen.has(k)) return { error: `${z.name} would have two offices called ${shownOffice(next, zid, r)}.` }; seen.set(k, r); }
    }
    for (const fid of factionsTouched) {
      const ranks = listFor(fid); const seen = new Set();
      for (let i = 0; i < ranks.length; i++) { const k = lower(shownRank(next, fid, ranks, i)); if (seen.has(k)) return { error: `${factionName(fid)} would have two ranks shown as ${shownRank(next, fid, ranks, i)}.` }; seen.add(k); }
    }
    if (o.dry) return { text: '', done };
    if (!done.length) return { text: 'Those names are already shown.', done };
    try { save(next); } catch (e) { log('role-names.json write failed', e.message); return { error: 'The names could not be saved. Try again later.' }; }
    const lines = [];
    for (const d of done) {
      const what = d.kind === 'office' ? `the ${officeDefault(d.rank)} office (${d.rank}) of ${d.zoneName}` : `the ${d.canon} rank of ${factionName(d.fid)}`;
      audit(`ROLENAME GM ${who(a)} ${d.reset ? 'reset' : 'renamed'} ${what}: ${d.was} -> ${d.name}${d.reset ? ' (the default)' : ''}${d.via ? ' (with its office)' : ''}`);
      if (d.via) continue;
      const linked = d.kind === 'office' && done.some((x) => x.via === `office:${d.zone}:${d.rank}`);
      lines.push(d.kind === 'office'
        ? `${d.zoneName}'s ${d.was} is now called ${d.name}${d.reset ? ' again' : ''}${linked ? ', and so is the household rank it sets' : ''}.`
        : `${factionName(d.fid)}'s ${d.was} is now called ${d.name}${d.reset ? ' again' : ''}.`);
    }
    tellHolders(a, done);
    return { text: lines.join(' '), done };
  };
  // Holders who are online hear of it once, in chat; everyone else sees it in their journal next time
  const tellHolders = (a, done) => {
    try {
      const online = onlineActors();
      const told = new Set();
      const tell = (t, text) => { if (t && t !== (a >>> 0) && !told.has(t)) { told.add(t); system(t, text); } };
      for (const d of done) {
        if (d.kind === 'office') {
          const pids = (((readOfficials() || {})[d.zone] || {})[d.rank] || []).map(Number);
          for (const t of online) if (pids.includes(Number(profileOf(t)))) tell(t, `Your office in ${d.zoneName} is now called ${d.name}.`);
        } else {
          const holders = fn('__dboGuildHolders') ? fn('__dboGuildHolders')(d.fid, d.index) : [];
          for (const t of holders) if (online.includes(t)) tell(t, `Your rank in ${factionName(d.fid)} is now called ${d.name}.`);
        }
      }
    } catch (e) { log('rolenames: telling the holders failed', e.message); }
  };
  // guilds.js: ranks taken out of a faction take their staff names with them
  const prune = (fid, ranks) => {
    const table = S.ranks[lower(fid)];
    if (!table || !Array.isArray(ranks)) return 0;
    const titles = ranks.map((r) => r.title);
    const keep = new Set(titles.map((t, i) => rankKey(t, nthIn(titles, i))));
    const gone = Object.keys(table).filter((k) => !keep.has(k));
    if (!gone.length) return 0;
    const next = JSON.parse(JSON.stringify(S));
    for (const k of gone) delete next.ranks[lower(fid)][k];
    if (!Object.keys(next.ranks[lower(fid)]).length) delete next.ranks[lower(fid)];
    try { save(next); } catch (e) { log('role-names.json write failed', e.message); return 0; }
    log(`rolenames: ${gone.length} staff name(s) of ${fid} went with their ranks (${gone.join(', ')})`);
    return gone.length;
  };

  const R = { check, apply, prune, canName, officeName, officeTitle, officeDefault, rankName, rankKey, store: () => JSON.parse(JSON.stringify(S)) };
  globalThis.__dboRoleNames = R;
  // The fork's systems (zones.ts titleOf: the notice boards' bylines) ask here, and fall back to zones.json without it
  globalThis.__dboOfficeTitle = (zoneId, rank) => officeTitle(zoneId, rank);

  // ---- chat: the fallback for a client without the Court tab's rename -------------------------------------------------
  const listLines = (target) => {
    const z = zoneById(target);
    if (z) return `${z.name}'s offices: ${(z.officials || []).map((r) => { const n = officeName(z.id, r); return `${r} = ${n || officeDefault(r)}${n ? ` (default ${officeDefault(r)})` : ''}`; }).join(', ')}.`;
    const ranks = ranksOf(target);
    if (ranks) {
      const titles = ranks.map((r) => r.title);
      return `${factionName(target)}'s ranks: ${ranks.map((r, i) => { const n = rankName(target, r.title, nthIn(titles, i)); return `${i + 1}. ${n || r.title}${n ? ` (default ${r.title})` : ''}`; }).join(', ')}.`;
    }
    return null;
  };
  if (typeof registerChatCommand === 'function') {
    registerChatCommand('rolename', (a, args) => {
      if (!canName(a)) return personal(a, String(C.staff) === 'gm' ? 'Only staff rename offices and ranks.' : 'Only a Lead GM or above renames offices and ranks.');
      const parts = String(args || '').trim().split(/\s+/).filter(Boolean);
      const usage = 'Usage: /rolename list <court|faction id> | /rolename <court> <office id> <new title> | /rolename <faction id> <rank number> <new title> | /rolename reset <court> <office id> | /rolename reset <faction id> <rank number>. The F3 Court tab does the same.';
      const s = lower(parts[0]);
      if (!s) return personal(a, `${usage} Renamed now: ${Object.keys(S.offices).length} court(s), ${Object.keys(S.ranks).length} faction(s).`);
      if (s === 'list') {
        if (!parts[1]) return personal(a, `Courts: ${zoneList().map((z) => z.id).join(', ')}. Factions: /faction list.`);
        return personal(a, listLines(lower(parts[1])) || `No court or faction ${parts[1]}.`);
      }
      const reset = s === 'reset';
      const [target, key, ...rest] = reset ? parts.slice(1) : parts;
      if (!target || !key || (!reset && !rest.length)) return personal(a, usage);
      const z = zoneById(lower(target));
      let ch;
      if (z) ch = { kind: 'office', zone: z.id, rank: lower(key), name: reset ? '' : rest.join(' ') };
      else if (ranksOf(lower(target))) {
        const n = Math.floor(Number(key));
        if (!(n >= 1)) return personal(a, `Give the rank by its number: ${listLines(lower(target))}`);
        ch = { kind: 'rank', fid: lower(target), index: n - 1, name: reset ? '' : rest.join(' ') };
      } else return personal(a, `No court or faction ${target}. ${usage}`);
      const r = apply(a, [ch]);
      personal(a, r.error || r.text);
    }, { admin: true, help: 'list <court|faction> | <court> <office> <title> | <faction> <rank number> <title> | reset ...: rename an office or rank for everyone holding it (Lead GM; F3 Court does it too)' });
  }

  log(`rolenames ${C.enabled ? 'on' : 'off'}: ${Object.values(S.offices).reduce((n, t) => n + Object.keys(t).length, 0)} office and ${Object.values(S.ranks).reduce((n, t) => n + Object.keys(t).length, 0)} rank name(s) (${String(C.staff) === 'gm' ? 'any GM' : 'Lead GM and above'})`);
  return R;
};
