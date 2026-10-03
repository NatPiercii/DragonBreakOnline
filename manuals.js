// Smithing manuals and smithing skill books (Nate, 2026-09-30: "do both, gives scholars more meaning"). Loaded by
// gamemode.js after spells.js; spells.js's read hook, the Scholar's reading, dungeons.js's boss chests and salvage.js's
// Scholars' Ledger ask it through globalThis at runtime.
//
// A manual (manuals.json, Worker C's table: DragonBreak Online Edits.esp BOOK DBO_BookManual<X> and marker SPEL
// DBO_Manual_<X>; a forge recipe needs the Blacksmith tier marker and the manual's marker) is read from the inventory.
// Below its tier (1-based, skills.json's Blacksmith list: rank 0 = T1) it is refused and kept: "You can't follow this
// yet". Otherwise its marker is added, the material kept in private.dboManuals, and the book used up (Nate): not at once,
// since the server cannot tell whether the Book menu still shows it and an item changed under an open vanilla menu is the
// "base-form writes race open menus" risk, but at the reader's next cell change, logout or login, when no book can be
// open (private.dboManualsOwed; a copy no longer carried then is taken from the next one they hold). A respec
// keeps what was learned: the knowledge is not the Wheel's, and each recipe still needs its tier marker, so a character
// who sets Blacksmith aside cannot forge with it and needs no second reading on taking it up again. A marker missing at
// login is put back from the record.
// Where manuals come from:
//   the Synod sells those up to shop.maxTier (T2) at the Scholars' Ledger in the Conclave, for shop.priceMultiplier x
//     the book's value, paid into the Bruma treasury;
//   boss chests (dungeons.js bossLoot), by the lease's difficulty; T4 only in hard and nightmare leases and rarely; never
//     T5 (Daedric, dragon: staff-granted with /manual grant, audit-logged, like artifacts); never outside the provinces
//     its material belongs to (provinces, from regions-overrides.json's families);
//   Scholars: at the Scholars' Ledger, a Scholar at or above a manual's tier copies any manual they have learned, for
//     copy.paper paper, inside the reading copies' daily cap (reading.bookDailyCap, private.scholarCopies).
// Smithing skill books (BOOK DATA "teaches skill" with actor value 10: the five vanilla and the five Beyond Skyrim ones)
// are Blacksmith work once per book per character, read from the inventory or won at the reading of a placed one:
// masterySystem's award (__alduinakMasteryAward) credits a Blacksmith inside the Wheel's caps.
//
// State, on the character: private.dboManuals { <material>: { at, from } }, private.dboSkillBooks [book desc...],
//   private.dboManualsOwed [{ book, cell }] (books learned and not yet used up)
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, audit, who, display, cfg, giveItem, takeGold, depositToTreasury, registerChatCommand,
    onlineActors, every, findByName, notify } = api;

  const D = {
    enabled: true, skill: 'blacksmith', scholarSkill: 'scholar', consume: true,
    shop: { enabled: true, maxTier: 2, priceMultiplier: 3, cells: ['20ff:BSHeartland.esm'], treasury: 'bruma' },
    loot: { enabled: true, chance: { story: 0.03, normal: 0.05, hard: 0.08, nightmare: 0.1 },
      maxTier: { story: 2, normal: 3, hard: 4, nightmare: 4 }, rareTier: 4, rareWeight: 0.2, staffTier: 5,
      capManuals: { steel: ['steel', 'silver', 'chainmail'], iron: [] } },
    provinces: {},
    copy: { enabled: true, paperId: '7cba1:BSHeartland.esm', paper: 1 },
    skillBooks: { enabled: true, av: 10, weight: 3 },
  };
  const raw = cfg.manuals || {};
  const C = Object.assign({}, D, raw, {
    shop: Object.assign({}, D.shop, raw.shop || {}),
    loot: Object.assign({}, D.loot, raw.loot || {}),
    copy: Object.assign({}, D.copy, raw.copy || {}),
    skillBooks: Object.assign({}, D.skillBooks, raw.skillBooks || {}),
    provinces: Object.assign({}, D.provinces, raw.provinces || {}),
  });
  const TIER_NAMES = ['Novice', 'Apprentice', 'Adept', 'Expert', 'Master'];
  const REC = 'private.dboManuals', BOOKS_READ = 'private.dboSkillBooks', COPIES = 'private.scholarCopies', OWED = 'private.dboManualsOwed';

  const get = (id, prop, dflt) => { try { const v = mp.get(id, prop); return v === undefined || v === null ? dflt : v; } catch (e) { return dflt; } };
  const set = (id, prop, v) => { try { mp.set(id, prop, v); return true; } catch (e) { log(`manuals: set ${prop} failed`, e.message); return false; } };
  const idOf = (desc) => { try { return desc ? mp.getIdFromDesc(String(desc)) >>> 0 : 0; } catch (e) { return 0; } };
  const descOf = (id) => { try { return String(mp.getDescFromId(id >>> 0)); } catch (e) { return ''; } };
  const norm = (d) => { const s = String(d || ''); const i = s.indexOf(':'); if (i < 0) return s.toLowerCase(); const n = parseInt(s.slice(0, i), 16); return (Number.isFinite(n) ? n.toString(16) : s.slice(0, i).toLowerCase()) + ':' + s.slice(i + 1).toLowerCase(); };
  const lookup = (id) => { try { const r = id ? mp.lookupEspmRecordById(id >>> 0) : null; return r && r.record ? r : null; } catch (e) { return null; } };
  const isPlayer = (a) => { try { return Number(mp.get(a, 'profileId')) >= 0; } catch (e) { return false; } };
  const tierName = (tier) => TIER_NAMES[Math.max(0, Math.min(4, tier - 1))];
  const rankIn = (a, skill) => {
    const r = get(a, 'private.mastery', null);
    if (!r || !Array.isArray(r.order) || !r.order.includes(skill)) return -1;
    return Math.max(0, Math.min(4, Number(((r.skills || {})[skill] || {}).rank) || 0));
  };

  // ---- the table ------------------------------------------------------------------------------------------------
  let table = { manuals: [] };
  try { table = JSON.parse(fs.readFileSync(path.resolve('manuals.json'), 'utf8')); } catch (e) { /* no table yet */ }
  const MANUALS = (Array.isArray(table.manuals) ? table.manuals : []).map((m) => {
    const key = String(m.material || m.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const bookId = idOf(m.book), markerId = idOf(m.marker);
    const bookRec = lookup(bookId);
    const value = bookRec ? (() => { const f = (bookRec.record.fields || []).find((x) => x && x.type === 'DATA' && x.data); return f && f.data.byteLength >= 12 ? new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength).getUint32(8, true) : 0; })() : 0;
    const provinces = Array.isArray(m.provinces) ? m.provinces : Array.isArray(C.provinces[key]) ? C.provinces[key] : null;
    return { key, name: String(m.name || m.material || key), title: String(m.title || `the ${m.name || key} manual`), tier: Math.max(1, Math.min(5, Number(m.tier) || 1)),
      bookId, markerId, book: bookId ? descOf(bookId) : '', value: Number(m.value) || value, provinces, ready: !!(bookId && markerId && bookRec) };
  }).filter((m) => m.key);
  const READY = MANUALS.filter((m) => m.ready);
  const BY_BOOK = new Map(READY.map((m) => [m.bookId, m]));

  // ---- the engine's spell list ----------------------------------------------------------------------------------
  const papyrus = (a, fn, spellId, extra) => {
    try { return mp.callPapyrusFunction('method', 'Actor', fn, { type: 'form', desc: descOf(a) }, [{ type: 'espm', desc: descOf(spellId) }].concat(extra || [])) === true; }
    catch (e) { log(`manuals: ${fn} ${descOf(spellId)} failed`, e.message); return false; }
  };
  const learnedIds = (a) => {
    try {
      const self = { type: 'form', desc: descOf(a) };
      const n = Number(mp.callPapyrusFunction('method', 'Actor', 'GetSpellCount', self, [])) || 0;
      const out = new Set();
      for (let i = 0; i < n; i++) { const s = mp.callPapyrusFunction('method', 'Actor', 'GetNthSpell', self, [i]); if (s && s.desc) out.add(idOf(s.desc)); }
      return out;
    } catch (e) { return null; }
  };
  const recordOf = (a) => { const r = get(a, REC, null); return r && typeof r === 'object' ? r : {}; };
  const knows = (a, m) => !!recordOf(a)[m.key];

  // Takes one of a stack the player is not wearing
  const takeOne = (a, baseId) => {
    try {
      const inv = mp.get(a, 'inventory') || { entries: [] };
      const entries = Array.isArray(inv.entries) ? inv.entries.map((e) => Object.assign({}, e)) : [];
      const i = entries.findIndex((e) => e && !e.worn && !e.wornLeft && (Number(e.baseId) >>> 0) === (baseId >>> 0) && (Number(e.count) || 0) > 0);
      if (i < 0) return false;
      entries[i].count = Number(entries[i].count) - 1;
      if (entries[i].count <= 0) entries.splice(i, 1);
      mp.set(a, 'inventory', { entries });
      return true;
    } catch (e) { log('manuals: take failed', e.message); return false; }
  };
  const countOf = (a, baseId) => { try { const inv = mp.get(a, 'inventory') || { entries: [] }; return (inv.entries || []).reduce((n, e) => n + ((Number(e.baseId) >>> 0) === (baseId >>> 0) && !e.worn ? Number(e.count) || 0 : 0), 0); } catch (e) { return 0; } };

  // ---- learning a manual ---------------------------------------------------------------------------------------
  const owedOf = (a) => { const o = get(a, OWED, []); return Array.isArray(o) ? o.filter((x) => x && x.book) : []; };
  // Uses up the books this reader owes; `moved` (a cell change, a logout, a login) says no book can be on screen. A book
  // no longer carried stays owed and is taken from the next copy they hold.
  const settleOwed = (a, why, onlyMoved) => {
    const owed = owedOf(a);
    if (!owed.length) return;
    const cell = String(get(a, 'worldOrCellDesc', ''));
    const left = [];
    for (const o of owed) {
      if (onlyMoved && norm(o.cell) === norm(cell)) { left.push(o); continue; }
      const bookId = idOf(o.book);
      if (bookId && takeOne(a, bookId)) { log(`manuals: used up ${who(a)}'s ${o.book} (${why})`); continue; }
      if (!o.missing) log(`manuals: ${who(a)} owes ${o.book} but carries none (${why}); the next copy settles it`);
      left.push(Object.assign({}, o, { missing: true, cell: onlyMoved ? cell : o.cell }));
    }
    if (left.length !== owed.length || left.some((x, i) => x.missing !== owed[i].missing)) set(a, OWED, left);
  };
  const learn = (a, m, how) => {
    if (!papyrus(a, 'AddSpell', m.markerId, [false])) {
      const held = learnedIds(a);
      if (!held || !held.has(m.markerId)) { log(`manuals: ${who(a)} could not be given ${descOf(m.markerId)}`); return false; }
    }
    set(a, REC, Object.assign({}, recordOf(a), { [m.key]: { at: Date.now(), from: how } }));
    audit(`MANUAL ${who(a)} learned ${m.name} (T${m.tier}) from ${how}`);
    return true;
  };
  // An inventory read: false refuses it (the book is kept), true learned it, null leaves it to the rest of the chain
  const readManual = (a, m, fromInventory) => {
    if (knows(a, m)) { personal(a, `You already know how to work ${m.name}. Read on if you like; the book stays yours.`); return null; }
    const rank = rankIn(a, C.skill);
    if (rank < m.tier - 1) {
      personal(a, `You can't follow this yet: ${m.title} is for a Blacksmith of ${tierName(m.tier)} rank or better. You keep the book.`);
      audit(`MANUAL ${who(a)} could not follow ${m.name} (T${m.tier}) at Blacksmith ${rank < 0 ? 'none' : TIER_NAMES[rank]}`);
      return false;
    }
    if (!learn(a, m, fromInventory ? 'a book' : 'a book on the shelf')) { personal(a, 'The words will not settle. Try again in a moment.'); return false; }
    if (fromInventory && C.consume) set(a, OWED, owedOf(a).concat([{ book: m.book, cell: String(get(a, 'worldOrCellDesc', '')) }]));
    personal(a, `You study ${m.title}. You can work ${m.name} at the forge now.${fromInventory && C.consume ? ' Your notes fill every margin: the book is spent, and it is gone once you move on.' : ''}`);
    return true;
  };

  // ---- smithing skill books -------------------------------------------------------------------------------------
  const skillOfBook = (bookId) => {
    const r = lookup(bookId);
    if (!r || String(r.record.type) !== 'BOOK') return null;
    const f = (r.record.fields || []).find((x) => x && x.type === 'DATA' && x.data);
    if (!f || f.data.byteLength < 8 || !(f.data[0] & 0x01)) return null;
    return { av: new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength).getInt32(4, true), edid: String(r.record.editorId || '') };
  };
  const bookTitle = (edid) => String(edid || 'the book').replace(/^(BSK)?Skill/, '').replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/\s*\d+$/, '').trim() || 'the book';
  // A line for the reader, or '' when the book is no smithing skill book
  const skillBook = (a, bookId) => {
    if (!C.skillBooks.enabled) return '';
    const sb = skillOfBook(bookId);
    if (!sb || sb.av !== Number(C.skillBooks.av)) return '';
    const read = get(a, BOOKS_READ, []);
    const desc = descOf(bookId);
    if (Array.isArray(read) && read.includes(desc)) return 'you know this book on smithing already';
    if (rankIn(a, C.skill) < 0) return 'only a Blacksmith learns from a book on smithing';
    const award = globalThis.__alduinakMasteryAward;
    if (typeof award !== 'function') { log('manuals: the skill system has no award; a smithing book taught nothing'); return ''; }
    let units = 0;
    try { units = Number(award(a, C.skill, Number(C.skillBooks.weight) || 3, bookId)) || 0; } catch (e) { log('manuals: award failed', e.message); }
    if (units <= 0) return 'you have worked at your craft enough for now; the book will teach you more another time';
    set(a, BOOKS_READ, (Array.isArray(read) ? read : []).concat([desc]));
    audit(`SKILLBOOK ${who(a)} read ${sb.edid}: Blacksmith +${Math.round(units * 100) / 100} units`);
    return 'what you read on the forge stays with you';
  };

  // spells.js's read hook asks first, for every book read from the inventory: false refuses the read (a manual beyond
  // the reader's tier), anything else lets it go on
  globalThis.__dboManualsRead = (a, bookId) => {
    if (!C.enabled || !isPlayer(a)) return undefined;
    const m = BY_BOOK.get(bookId >>> 0);
    if (m) return readManual(a, m, true) === false ? false : undefined;
    const line = skillBook(a, bookId >>> 0);
    if (line) personal(a, `${line[0].toUpperCase()}${line.slice(1)}.`);
    return undefined;
  };
  // The Scholar's reading of a placed book, won: a line for the results, or ''. A placed manual cannot be taken or used up.
  globalThis.__dboManualsReadWon = (a, bookId) => {
    if (!C.enabled || !isPlayer(a)) return '';
    const m = BY_BOOK.get(bookId >>> 0);
    if (m) { const r = knows(a, m) ? null : readManual(a, m, false); return r === true ? `you learn to work ${m.name}` : ''; }
    return skillBook(a, bookId >>> 0);
  };
  // The reading's copy roll leaves manuals alone: copies of a manual come only from a Scholar who learned it
  globalThis.__dboManualsIsManual = (bookId) => BY_BOOK.has(bookId >>> 0) || MANUALS.some((m) => m.bookId && m.bookId === (bookId >>> 0));
  // A copy its reader still owes stays with them until it is used up (it goes at their next cell change): moving `count`
  // must leave them at least as many as they owe. Asked on a drop, a put and a trade; a reason for the player, or null
  globalThis.__dboManualsOwedMove = (a, baseId, count) => {
    const id = baseId >>> 0;
    if (!C.consume || !globalThis.__dboManualsIsManual(id)) return null;
    const owed = owedOf(a).filter((o) => idOf(o.book) === id).length;
    if (!owed || countOf(a, id) - (Number(count) || 0) >= owed) return null;
    return 'Your notes fill every margin of that book: it is spent, and it stays with you until you move on.';
  };

  // ---- boss chests (dungeons.js bossLoot) -----------------------------------------------------------------------
  const inProvince = (m, province) => !province || !Array.isArray(m.provinces) || m.provinces.includes(String(province).toLowerCase());
  // { id, name } of a manual for this boss chest, or null
  globalThis.__dboManualsBossLoot = (difficulty, province) => {
    if (!C.enabled || !C.loot.enabled) return null;
    const chance = Number((C.loot.chance || {})[difficulty]) || 0;
    if (!(Math.random() < chance)) return null;
    const maxTier = Number((C.loot.maxTier || {})[difficulty]) || 0;
    // No manual of a material that is never loot (dungeons.js BANNED_LOOT: Ebony, Daedric, Dragon, Stalhrim, Orcish;
    // Nate, 1 Oct). Without that pattern no manual drops, rather than any
    const banned = globalThis.__dboBannedLoot instanceof RegExp ? globalThis.__dboBannedLoot : null;
    if (!banned) return null;
    // Under the dungeons' gear ceiling (loottiers.js cap, globalThis.__dboLootCap; Jake and Nate, 1 Oct) only the manuals of
    // what may drop: at 'steel' Steel, Silver and Chainmail (Ancient Nord and Falmer teach their honed pieces too, which hit
    // like Elven), at 'iron' none. Without the cap known, no manual
    const cap = typeof globalThis.__dboLootCap === 'string' ? globalThis.__dboLootCap : '';
    if (!cap) return null;
    const capKeys = cap === 'none' ? null : new Set(((C.loot.capManuals || {})[cap] || []).map((k) => String(k).toLowerCase()));
    const pool = READY.filter((m) => m.tier <= maxTier && m.tier < Number(C.loot.staffTier) && inProvince(m, province) && !banned.test(String(m.material || m.name || '')) && (!capKeys || capKeys.has(m.key)));
    if (!pool.length) return null;
    const weight = (m) => (m.tier >= Number(C.loot.rareTier) ? Number(C.loot.rareWeight) || 0 : 1);
    const total = pool.reduce((n, m) => n + weight(m), 0);
    if (!(total > 0)) return null;
    let r = Math.random() * total;
    const pick = pool.find((m) => (r -= weight(m)) < 0) || pool[pool.length - 1];
    return { id: pick.book, name: pick.title };
  };

  // ---- the Scholars' Ledger (salvage.js): the Synod's manuals, and a Scholar's copies ----------------------------
  const inShop = (a) => (C.shop.cells || []).map(norm).includes(norm(get(a, 'worldOrCellDesc', '')));
  const priceOf = (m) => Math.max(1, Math.round((m.value || 0) * (Number(C.shop.priceMultiplier) || 1)));
  const goldOf = (a) => countOf(a, 0xf);
  // The Synod's stock at this ledger, or [] where it sells none
  globalThis.__dboManualsShop = (a) => {
    if (!C.enabled || !C.shop.enabled || !inShop(a)) return [];
    const gold = goldOf(a);
    return READY.filter((m) => m.tier <= Number(C.shop.maxTier)).sort((x, y) => x.tier - y.tier || x.name.localeCompare(y.name))
      .map((m) => ({ bookId: m.bookId, label: `${m.title} (T${m.tier}), ${priceOf(m)} gold${gold < priceOf(m) ? ': more than you carry' : ''}` }));
  };
  // { ok, text }
  globalThis.__dboManualsBuy = (a, bookId) => {
    const m = BY_BOOK.get(bookId >>> 0);
    if (!C.enabled || !C.shop.enabled || !m || m.tier > Number(C.shop.maxTier)) return { ok: false, text: 'The Synod does not sell that manual.' };
    if (!inShop(a)) return { ok: false, text: 'The Synod sells its manuals in the Synod Conclave.' };
    const price = priceOf(m);
    if (!takeGold(a, price)) return { ok: false, text: `${m.title} costs ${price} gold, and you do not have it.` };
    if (!giveItem(a, m.bookId, 1)) { giveItem(a, 0xf, price); return { ok: false, text: 'The book could not be handed over. Your gold is returned.' }; }
    let paid = 0; try { paid = depositToTreasury(C.shop.treasury, price); } catch (e) { paid = 0; }
    audit(`MANUAL ${who(a)} bought ${m.name} (T${m.tier}) from the Synod for ${price} gold (${paid} to ${C.shop.treasury})`);
    try { if (typeof notify === 'function') notify(a, `${m.title} added`); } catch (e) { /* offline */ }
    return { ok: true, text: `You buy ${m.title} for ${price} gold. Read it to learn it; the book is used up as you learn.` };
  };
  const dayCap = () => Math.max(0, Number(((cfg.reading || {}).bookDailyCap)) || 6);
  const today = () => new Date(Date.now()).toISOString().slice(0, 10);
  const copiesToday = (a) => { const c = get(a, COPIES, null); return c && c.day === today() ? Number(c.n) || 0 : 0; };
  // The manuals this Scholar may copy: learned, at or above its tier; each { bookId, label }
  globalThis.__dboManualsCopyList = (a) => {
    if (!C.enabled || !C.copy.enabled) return [];
    const rank = rankIn(a, C.scholarSkill);
    if (rank < 0) return [];
    const mine = recordOf(a);
    return READY.filter((m) => mine[m.key] && rank >= m.tier - 1).sort((x, y) => x.tier - y.tier || x.name.localeCompare(y.name))
      .map((m) => ({ bookId: m.bookId, label: `Copy ${m.title} (T${m.tier})` }));
  };
  // Why this Scholar cannot copy now, or ''
  globalThis.__dboManualsCopyRefusal = (a) => {
    if (!C.enabled || !C.copy.enabled) return 'Manuals are not copied here.';
    if (rankIn(a, C.scholarSkill) < 0) return 'Only a Scholar copies manuals.';
    if (copiesToday(a) >= dayCap()) return `You have copied ${dayCap()} books today. Rest your hand until tomorrow.`;
    if (!globalThis.__dboManualsCopyList(a).length) return 'You know no manual you are learned enough to copy.';
    return '';
  };
  // { ok, text }
  globalThis.__dboManualsCopy = (a, bookId) => {
    const m = BY_BOOK.get(bookId >>> 0);
    const why = globalThis.__dboManualsCopyRefusal(a);
    if (why) return { ok: false, text: why };
    if (!m || !globalThis.__dboManualsCopyList(a).some((x) => x.bookId === m.bookId)) return { ok: false, text: 'You cannot copy that manual.' };
    const paperId = idOf(C.copy.paperId), paper = Math.max(0, Number(C.copy.paper) || 0);
    if (paper && countOf(a, paperId) < paper) return { ok: false, text: `Copying ${m.title} takes ${paper} paper, and you have none.` };
    for (let i = 0; i < paper; i++) if (!takeOne(a, paperId)) return { ok: false, text: 'Your paper is gone.' };
    if (!giveItem(a, m.bookId, 1)) { if (paper) giveItem(a, paperId, paper); return { ok: false, text: 'The copy could not be made. Your paper is returned.' }; }
    set(a, COPIES, { day: today(), n: copiesToday(a) + 1 });
    audit(`MANUAL ${who(a)} copied ${m.name} (T${m.tier}) at the Scholars' Ledger (${copiesToday(a)}/${dayCap()} today)`);
    try { if (typeof notify === 'function') notify(a, `${m.title} added`); } catch (e) { /* offline */ }
    return { ok: true, text: `You copy out ${m.title} in a careful hand.` };
  };

  // ---- the markers after a login ----------------------------------------------------------------------------------
  const S = globalThis.__dboManualsState || (globalThis.__dboManualsState = { checked: new Set() });
  const regrant = (a) => {
    // A login: nothing is on screen yet, so what is owed from before the logout is used up
    settleOwed(a, 'login', false);
    const mine = recordOf(a);
    const want = READY.filter((m) => mine[m.key]);
    if (!want.length) return;
    const held = learnedIds(a);
    if (!held) return;
    for (const m of want) if (!held.has(m.markerId) && papyrus(a, 'AddSpell', m.markerId, [false])) log(`manuals: put ${m.name}'s marker back on ${who(a)}`);
  };
  // A cell change passed a loading screen, which closes every menu
  every('manuals.settle', 5000, () => {
    if (!C.enabled) return;
    for (const a of onlineActors()) { try { if (owedOf(a).length) settleOwed(a, 'cell change', true); } catch (e) { log('manuals: settle failed', e.message); } }
  });
  // gamemode.js's disconnect handler: a logout closes every menu
  globalThis.__dboManualsLeave = (a) => { try { settleOwed(a >>> 0, 'logout', false); } catch (e) { log('manuals: logout settle failed', e.message); } };
  every('manuals.regrant', 15000, () => {
    if (!C.enabled) return;
    const on = new Set(onlineActors().map((x) => x >>> 0));
    for (const a of [...S.checked]) if (!on.has(a)) S.checked.delete(a);
    for (const a of on) if (!S.checked.has(a)) { S.checked.add(a); try { regrant(a); } catch (e) { log('manuals: regrant failed', e.message); } }
  });

  // ---- staff: the T5 manuals are given in roleplay, like artifacts -----------------------------------------------
  const findManual = (q) => { const k = String(q || '').toLowerCase().replace(/[^a-z0-9]/g, ''); return MANUALS.find((m) => m.key === k) || null; };
  registerChatCommand('manual', (a, args) => {
    const words = String(Array.isArray(args) ? args.join(' ') : args || '').trim().split(/\s+/).filter(Boolean);
    const verb = (words[0] || '').toLowerCase();
    if (verb === 'list' || !verb) return personal(a, `Manuals: ${MANUALS.map((m) => `${m.key} T${m.tier}${m.ready ? '' : ' (not in the plugin yet)'}`).join(', ') || 'none'}. /manual grant <material> <player>, /manual known <player>.`);
    if (verb === 'known') {
      const t = findByName(words.slice(1).join(' ')); if (!t) return personal(a, 'Nobody online answers to that.');
      const mine = recordOf(t);
      return personal(a, `${display(t)} knows: ${Object.keys(mine).join(', ') || 'no manual'}.`);
    }
    if (verb === 'grant') {
      const m = findManual(words[1]); if (!m) return personal(a, `No manual "${words[1] || ''}". /manual list.`);
      if (!m.ready) return personal(a, `${m.name}'s book is not in the plugin yet.`);
      const t = findByName(words.slice(2).join(' ')); if (!t) return personal(a, 'Nobody online answers to that.');
      if (!giveItem(t, m.bookId, 1)) return personal(a, 'The book could not be given.');
      audit(`MANUAL ${who(a)} granted ${m.name} (T${m.tier}) to ${who(t)}`);
      personal(a, `${display(t)} has been given ${m.title}.`);
      return personal(t, `You have been given ${m.title}.`);
    }
    return personal(a, 'Usage: /manual list | known <player> | grant <material> <player>');
  }, { admin: true, help: 'smithing manuals: list, who knows what, and grant one in roleplay (T5 are staff-given)' });

  log(`manuals ${C.enabled ? 'on' : 'off'}: ${READY.length} of ${MANUALS.length} manuals in the load order${READY.length < MANUALS.length ? ` (waiting: ${MANUALS.filter((m) => !m.ready).map((m) => m.key).join(', ')})` : ''}; Synod up to T${C.shop.maxTier}, x${C.shop.priceMultiplier}; boss chests ${C.loot.enabled ? 'on' : 'off'}, T${C.loot.staffTier} staff-given; copies ${C.copy.enabled ? 'on' : 'off'}; smithing skill books ${C.skillBooks.enabled ? `on (${typeof globalThis.__alduinakMasteryAward === 'function' ? 'award ready' : 'waiting for the award'})` : 'off'}`);
};
