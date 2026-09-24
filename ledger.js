// DragonBreak Online: the ledger of contacts (suggestions forum, "Ledgers"). Loaded by gamemode.js.
//
// Everyone a character has met (private.metActors, the same list pigeons fly by) written into a book that is read at a
// ledger point: a notice board, a spot an admin marks (a court, a guild hall; optionally for one faction's members), or
// inside a house the character owns or rents. Contacts sort themselves into the factions both belong to and into
// family (marked by hand, or by a shared family name), then the reader's own groups, then acquaintances. Each contact
// can carry a private note. From the ledger a letter can be sent by pigeon, and a contact can be forgotten: they come
// back only by meeting again in person.
//
// Per character in private.ledger: { <actorId>: { group?: string ('none' turns the automatic family off), note?: string } }.
// Ledger points in ledger-points.json (runtime, gitignored): [{ name, where, pos, faction?, by, at }].

const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, audit, who, nameOf, tagOf, profileOf, onlineActors, registerChatCommand, isAdmin, isWorldspace,
    metOf, forgetMet, sendPigeon, boardZoneNear, zoneOfActor, cfg } = api;

  const C = Object.assign({ atBoards: true, atHome: true, pointReach: 300, perPage: 15, maxNote: 160, maxGroup: 24 }, cfg.ledger || {});
  const POINTS_FILE = path.resolve('ledger-points.json');
  const S = globalThis.__dboLedger || (globalThis.__dboLedger = { points: null, cellDoors: null });
  const PROP = 'private.ledger';

  const points = () => {
    if (S.points) return S.points;
    try { S.points = JSON.parse(fs.readFileSync(POINTS_FILE, 'utf8')); } catch (e) { S.points = []; }
    if (!Array.isArray(S.points)) S.points = [];
    return S.points;
  };
  const savePoints = () => {
    try { fs.writeFileSync(POINTS_FILE + '.tmp', JSON.stringify(points(), null, 1)); fs.renameSync(POINTS_FILE + '.tmp', POINTS_FILE); }
    catch (e) { log('ledger: saving points failed', e.message); }
  };

  const guildsOf = (a) => { try { return typeof globalThis.__dboGuildsOf === 'function' ? globalThis.__dboGuildsOf(a) : []; } catch (e) { return []; } };
  const placeOf = (a) => {
    try { const pos = mp.get(a, 'pos'); const where = String(mp.get(a, 'worldOrCellDesc') || '').toLowerCase(); return Array.isArray(pos) && where ? { pos, where } : null; }
    catch (e) { return null; }
  };
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

  // Interior cell -> the load doors standing in it, from doors.json; read once, doors never move
  const cellDoors = () => {
    if (S.cellDoors) return S.cellDoors;
    S.cellDoors = new Map();
    let ids = [];
    try { ids = Object.keys(JSON.parse(fs.readFileSync(path.resolve('doors.json'), 'utf8')).doors || {}); } catch (e) { log('ledger: doors.json unreadable', e.message); }
    for (const desc of ids) {
      try {
        const id = mp.getIdFromDesc(desc) >>> 0;
        const where = String(mp.get(id, 'worldOrCellDesc') || '').toLowerCase();
        if (!where || isWorldspace(where)) continue;
        const list = S.cellDoors.get(where); if (list) list.push(id); else S.cellDoors.set(where, [id]);
      } catch (e) { /* not in this load order */ }
    }
    return S.cellDoors;
  };
  const atHome = (a, here) => {
    const housing = globalThis.__dboHousing;
    if (!C.atHome || !housing || !here || isWorldspace(here.where)) return false;
    const me = Number(profileOf(a));
    return (cellDoors().get(here.where) || []).some((d) => { try { const r = housing.recordOf(d); return !!r && Number(r.owner) === me; } catch (e) { return false; } });
  };

  // The ledger point the character stands at, as a short name, or '' when there is none
  const pointAt = (a) => {
    const here = placeOf(a);
    if (here) {
      const mine = new Set(guildsOf(a).map((g) => g.id));
      for (const p of points()) {
        if (p.where !== here.where || dist(p.pos, here.pos) > C.pointReach) continue;
        if (p.faction && !mine.has(p.faction) && !isAdmin(a)) continue;
        return p.name;
      }
      if (atHome(a, here)) return 'your home';
    }
    if (C.atBoards && boardZoneNear(a)) return 'the notice board';
    return '';
  };

  const book = (a) => { try { const b = mp.get(a, PROP); return b && typeof b === 'object' && !Array.isArray(b) ? b : {}; } catch (e) { return {}; } };
  const writeBook = (a, b) => { for (const k of Object.keys(b)) if (!b[k].group && !b[k].note) delete b[k]; mp.set(a, PROP, b); };

  // Family name: the last word, without the Orcish gro-/gra- or the Nordic and Redguard at-/af- ("gro-Shatul" = "gra-Shatul")
  const familyName = (name) => {
    const words = String(name || '').trim().split(/\s+/);
    if (words.length < 2) return '';
    return words[words.length - 1].toLowerCase().replace(/^(gro|gra|at|af|ap)-/, '');
  };

  const contactsOf = (a) => {
    const online = new Set(onlineActors());
    const mine = new Map(guildsOf(a).map((g) => [g.id, g]));
    const myFamily = familyName(nameOf(a));
    const b = book(a);
    const out = [];
    for (const id of metOf(a)) {
      try { if (!mp.get(id, 'appearance')) continue; } catch (e) { continue; }
      const e = b[id] || {};
      const name = nameOf(id);
      const shared = guildsOf(id).filter((g) => mine.has(g.id)).map((g) => ({ name: g.name, title: g.title }));
      let group = e.group || '';
      if (!group && myFamily && familyName(name) === myFamily) group = 'Family';
      if (group === 'none') group = '';
      out.push({ id, name, tag: tagOf(id), online: online.has(id), group, note: e.note || '', shared });
    }
    return out.sort((x, y) => x.name.localeCompare(y.name));
  };

  // A contact by #TAG, full name, or the start of a name when only one contact fits
  const findContact = (a, query) => {
    const q = String(query || '').trim().toLowerCase().replace(/^#/, '');
    if (!q) return { err: 'Name someone from your ledger.' };
    const list = contactsOf(a);
    const byTag = list.find((c) => c.tag.toLowerCase() === q); if (byTag) return { c: byTag };
    const exact = list.filter((c) => c.name.toLowerCase() === q);
    if (exact.length === 1) return { c: exact[0] };
    const start = exact.length ? exact : list.filter((c) => c.name.toLowerCase().startsWith(q));
    if (start.length === 1) return { c: start[0] };
    if (start.length > 1) return { err: `Your ledger has ${start.length} who fit that: ${start.slice(0, 6).map((c) => `${c.name} #${c.tag}`).join(', ')}. Use their #TAG.` };
    return { err: `Nobody called "${query.trim()}" is in your ledger. You have to meet someone in person first.` };
  };
  // Splits "<who> <rest>" where who may be several words: the longest leading run that names exactly one contact wins
  const splitContact = (a, text) => {
    const words = String(text || '').trim().split(/\s+/).filter(Boolean);
    let lastErr = null;
    for (let n = Math.min(words.length, 5); n >= 1; n--) {
      const r = findContact(a, words.slice(0, n).join(' '));
      if (r.c) return { c: r.c, rest: words.slice(n).join(' ') };
      if (!lastErr || n === 1) lastErr = r.err;
    }
    return { err: lastErr || 'Name someone from your ledger.' };
  };

  const line = (c) => `${c.name} #${c.tag}${c.online ? ' (about)' : ''}${c.note ? ` - ${c.note}` : ''}`;

  const showPage = (a, where, pageArg) => {
    const list = contactsOf(a);
    const mine = guildsOf(a);
    if (mine.length) personal(a, `Your factions: ${mine.map((g) => `${g.name} (${g.title})`).join(', ')}.`);
    if (!list.length) return personal(a, `Your ledger at ${where} is empty. Anyone you speak with in person is written in.`);
    // Sections in order: each shared faction, Family, the reader's own groups, then acquaintances. A contact appears once,
    // under the first that fits
    const sections = new Map();
    const put = (title, c) => { const s = sections.get(title); if (s) s.push(c); else sections.set(title, [c]); };
    const factionTitles = mine.map((g) => g.name);
    for (const c of list) {
      const f = factionTitles.find((t) => c.shared.some((s) => s.name === t));
      if (f && !c.group) put(f, c);
      else if (c.group) put(c.group, c);
      else put('Acquaintances', c);
    }
    const order = [...factionTitles, 'Family', ...[...sections.keys()].filter((k) => !factionTitles.includes(k) && k !== 'Family' && k !== 'Acquaintances').sort(), 'Acquaintances'];
    const rows = [];
    for (const title of order) for (const c of sections.get(title) || []) rows.push({ title, c });
    const pages = Math.max(1, Math.ceil(rows.length / C.perPage));
    const page = Math.min(pages, Math.max(1, parseInt(pageArg, 10) || 1));
    personal(a, `Your ledger at ${where}: ${list.length} contact${list.length === 1 ? '' : 's'}${pages > 1 ? `, page ${page} of ${pages}` : ''}.`);
    let last = '';
    for (const r of rows.slice((page - 1) * C.perPage, page * C.perPage)) {
      if (r.title !== last) { personal(a, `-- ${r.title} --`); last = r.title; }
      personal(a, line(r.c));
    }
    personal(a, pages > 1 && page < pages
      ? `/ledger ${page + 1} for the next page. /ledger help for what you can write in it.`
      : '/ledger help for what you can write in it.');
  };

  const HELP = [
    '/ledger [page]: everyone you have met, by faction, family and your own groups',
    '/ledger <name>: one contact, with your note on them',
    '/ledger note <name> <text>: write a private note on them (no text wipes it)',
    '/ledger group <name> <group>: file them under Family, Friends or a group of your own; "none" takes them out',
    '/ledger letter <name> <text>: send them a letter by pigeon from here',
    '/ledger forget <name>: strike them out; you will know them again only by meeting in person',
    'A ledger lies at every notice board, in your own home, and where a court or guild keeps one.',
  ];

  registerChatCommand('ledger', (a, args) => {
    const text = String(args || '').trim();
    const [sub] = text.split(/\s+/);
    const cmd = (sub || '').toLowerCase();
    if (cmd === 'help') { for (const h of HELP) personal(a, h); return; }
    const where = pointAt(a);
    if (!where) return personal(a, 'There is no ledger here. One lies at every notice board, in your own home, and where a court or guild keeps one.');
    const rest = text.slice(sub ? sub.length : 0).trim();

    if (!text || /^\d+$/.test(text)) return showPage(a, where, text);

    if (cmd === 'note') {
      const r = splitContact(a, rest); if (r.err) return personal(a, r.err);
      const note = r.rest.replace(/\s+/g, ' ').trim();
      if (note.length > C.maxNote) return personal(a, `A note holds at most ${C.maxNote} characters.`);
      const b = book(a); const e = b[r.c.id] = b[r.c.id] || {};
      if (note) e.note = note; else delete e.note;
      writeBook(a, b);
      return personal(a, note ? `Written beside ${r.c.name}: ${note}` : `Your note on ${r.c.name} is struck out.`);
    }
    if (cmd === 'group') {
      const r = splitContact(a, rest); if (r.err) return personal(a, r.err);
      let group = r.rest.replace(/[^\p{L}\p{N}' -]/gu, '').replace(/\s+/g, ' ').trim();
      if (!group) return personal(a, 'Usage: /ledger group <name> <group>, e.g. Family, Friends, Rivals; "none" takes them out of any.');
      if (group.length > C.maxGroup) return personal(a, `A group name holds at most ${C.maxGroup} characters.`);
      if (/^none$/i.test(group)) group = 'none';
      else group = group.replace(/\b\p{L}/gu, (x) => x.toUpperCase());
      if (group === 'Acquaintances') group = 'none';
      const b = book(a); const e = b[r.c.id] = b[r.c.id] || {};
      e.group = group;
      writeBook(a, b);
      return personal(a, group === 'none' ? `${r.c.name} is filed under no group.` : `${r.c.name} is filed under ${group}.`);
    }
    if (cmd === 'letter') {
      const r = splitContact(a, rest); if (r.err) return personal(a, r.err);
      if (!r.rest) return personal(a, 'Usage: /ledger letter <name> <text>');
      const zone = zoneOfActor(a);
      const res = sendPigeon(a, r.c.id, r.rest, zone ? zone.id : null);
      return personal(a, res.text);
    }
    if (cmd === 'forget') {
      const r = findContact(a, rest); if (r.err) return personal(a, r.err);
      forgetMet(a, r.c.id);
      const b = book(a); delete b[r.c.id]; writeBook(a, b);
      log(`ledger: ${who(a)} forgot ${r.c.name} #${r.c.tag}`);
      return personal(a, `${r.c.name} is struck out of your ledger. You will know them again once you meet in person.`);
    }
    const r = findContact(a, text); if (r.err) return personal(a, r.err);
    const c = r.c;
    personal(a, `${c.name} #${c.tag}${c.online ? ', about in the world now' : ''}.`);
    if (c.shared.length) personal(a, `Shares with you: ${c.shared.map((s) => `${s.name} (${s.title})`).join(', ')}.`);
    if (c.group) personal(a, `Filed under ${c.group}.`);
    personal(a, c.note ? `Your note: ${c.note}` : 'No note. /ledger note <name> <text> writes one.');
  }, { help: 'help | [page] | <name> | note | group | letter | forget: the ledger of everyone you have met' });

  // Admins mark where a court or guild keeps its ledger: at their own feet, optionally for one faction's members only
  registerChatCommand('ledgerpoint', (a, args) => {
    if (!isAdmin(a)) return personal(a, 'Only staff place ledgers.');
    const text = String(args || '').trim();
    const [sub] = text.split(/\s+/);
    const cmd = (sub || '').toLowerCase();
    const here = placeOf(a);
    if (cmd === 'add') {
      if (!here) return personal(a, 'Your position cannot be read right now.');
      let name = text.slice(3).trim(); let faction = '';
      const m = name.match(/^(.*?)\s+for\s+(\S+)$/i);
      if (m) { name = m[1].trim(); faction = m[2].toLowerCase(); }
      if (!name) return personal(a, 'Usage: /ledgerpoint add <name> [for <faction id>]   e.g. /ledgerpoint add Castle Bruma court');
      if (faction && typeof globalThis.__dboGuildExists === 'function' && !globalThis.__dboGuildExists(faction)) return personal(a, `No faction has the id "${faction}".`);
      points().push({ name, where: here.where, pos: here.pos.map((v) => Math.round(Number(v))), faction: faction || undefined, by: tagOf(a), at: Date.now() });
      savePoints();
      audit(`LEDGER ${who(a)} placed a ledger "${name}"${faction ? ` for ${faction}` : ''}`);
      return personal(a, `A ledger lies here now: ${name}${faction ? `, for ${faction} only` : ''}.`);
    }
    if (cmd === 'remove') {
      if (!here) return personal(a, 'Your position cannot be read right now.');
      let best = -1, bestD = C.pointReach;
      points().forEach((p, i) => { if (p.where === here.where) { const d = dist(p.pos, here.pos); if (d <= bestD) { bestD = d; best = i; } } });
      if (best < 0) return personal(a, 'No placed ledger within reach.');
      const [gone] = points().splice(best, 1);
      savePoints();
      audit(`LEDGER ${who(a)} removed the ledger "${gone.name}"`);
      return personal(a, `The ledger "${gone.name}" is gone.`);
    }
    if (cmd === 'list' || !cmd) {
      if (!points().length) return personal(a, 'No ledgers are placed. /ledgerpoint add <name> [for <faction id>] puts one at your feet.');
      for (const p of points()) personal(a, `${p.name}${p.faction ? ` (for ${p.faction})` : ''}: ${p.where} ${p.pos.join(' ')}`);
      return;
    }
    personal(a, 'Usage: /ledgerpoint add <name> [for <faction id>] | remove | list');
  }, { help: 'add <name> [for <faction id>] | remove | list: where courts and guilds keep a ledger (staff)' });
};
