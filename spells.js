// Spell study, the spellbook and prepared spells, teaching and the Synod tome shop, loaded by gamemode.js like jail.js.
//
// Reading a spell tome is refused unless the reader has taken up the school's skill (arcane: Destruction,
// Conjuration, Illusion; priest: Restoration, Alteration), the tome's rank fits their tier, they stand at a spell
// study point (skills.json spellStudyPoints) and a slot of that skill is free. A Novice tome read at a study point
// takes the skill up for one pool point when the reader has not (masterySystem's __alduinakMasteryFirstTouch). A refused read keeps the tome and the
// engine takes the spell back off the client (ReadBookEvent::OnFireBlocked sends Actor.RemoveSpell).
// Prepared spells (Nate, 2026-09-28: "a panel to set what 3 spells you want active/prepared at a time instead of
// unlearning/forgetting a spell"): every spell studied or taught stays in the character's spellbook, with no limit, and
// at most `prepared` (3) of them, whatever their school, are on the character at a time (Actor.AddSpell / RemoveSpell).
// The spellbook panel (/spells, front widget "spellbook") shows them all; the prepared ones are changed only at a magic
// college (prepareCells: the Synod Conclave, the College of Winterhold; the College of Whispers has no hall yet).
// Spells the engine holds outside the book (granted outright, never studied) take no place. /forget is retired.
// /teach passes a spell to a nearby player, /tomes is the college shop inside the Synod enclave. Tomes are classified from spell-tomes.json (ck-mcp/readables.py), and any
// tome missing from it is read from its records at runtime. The shop stocks only the tomes regions.js sells in
// shopProvince; /teach carries a spell anywhere.
//
// State, on the character:
//   private.dboStudied       { arcane: [spell desc...], priest: [...] }  the spellbook: every spell learned through this system
//   private.dboPrepared      [spell desc...]                           the prepared ones, at most `prepared`
//   private.dboTomeBoughtAt  ms of the last shop purchase

const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, system, audit, display, who, cfg, openWidget, closeWidget, onUi, registerChatCommand,
    onlineActors, distanceMeters, takeGold, giveItem, depositToTreasury } = api;

  const CFG = Object.assign({
    enabled: true,
    // How many studied spells are on the character at once, and where they are changed (the magic colleges)
    prepared: 3,
    prepareCells: ['20ff:BSHeartland.esm', '6c152:BSHeartland.esm',                             // the Synod Conclave, Bruma
      '1380e:Skyrim.esm', '1380f:Skyrim.esm', 'cab91:Skyrim.esm', '13810:Skyrim.esm', 'cab92:Skyrim.esm'], // College of Winterhold halls
    teachMeters: 5,
    teacherMinTier: 3,
    studentMinTier: 1,
    teachAtStudyPoint: false,
    offerSeconds: 60,
    shopCells: ['20ff:BSHeartland.esm', '6c152:BSHeartland.esm'],
    shopFactions: ['synod', 'college-of-winterhold', 'college-of-whispers'],
    shopMinTier: 1,
    shopMaxRank: 3,
    shopPriceMultiplier: 1,
    shopCooldownDays: 7,
    shopTreasury: 'bruma',
    shopPreferPlugins: ['BSHeartland.esm', 'BSAssets.esm'],
    shopExcludePlugins: ['Gray Fox Cowl.esm', 'SurWR.esp'],
    shopExcludePattern: '^(dun|MGR)|quest|FF\\d\\d',
    shopProvince: 'cyrodiil',
    shopShowForeign: false,
    // Workshops the guilds keep for their own (a ref's CYRBlockedFactionWorkshop script, which the server never runs)
    guildWorkshops: ['651cb:BSHeartland.esm'],
  }, cfg.spells || {});

  const SHOP_ID = 44;
  const MENU_ID = 45;
  const BOOK_ID = 58;
  const GOLD = 0xf;
  const DAY = 86400000;
  const MAX_ROWS = 12;
  const RANKS = ['Novice', 'Apprentice', 'Adept', 'Expert', 'Master'];
  const AV_SCHOOL = { 18: 'Alteration', 19: 'Conjuration', 20: 'Destruction', 21: 'Illusion', 22: 'Restoration' };
  const STUDIED = 'private.dboStudied';
  const PREPARED = 'private.dboPrepared';
  const BOUGHT = 'private.dboTomeBoughtAt';

  const readJson = (file) => { try { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); } catch (e) { log(`spells: ${file} unreadable`, e.message); return null; } };
  const get = (id, prop, dflt) => { try { const v = mp.get(id, prop); return v === undefined || v === null ? dflt : v; } catch (e) { return dflt; } };
  const set = (id, prop, v) => { try { mp.set(id, prop, v); return true; } catch (e) { log(`spells: set ${prop} failed`, e.message); return false; } };
  const idOf = (desc) => { try { return mp.getIdFromDesc(String(desc)) >>> 0; } catch (e) { return 0; } };
  const descOf = (id) => { try { return String(mp.getDescFromId(id >>> 0)); } catch (e) { return ''; } };
  const norm = (d) => { const s = String(d || ''); const i = s.indexOf(':'); if (i < 0) return s.toLowerCase(); const n = parseInt(s.slice(0, i), 16); return (Number.isFinite(n) ? n.toString(16) : s.slice(0, i).toLowerCase()) + ':' + s.slice(i + 1).toLowerCase(); };
  // 'Skyrim.esm:09E2A7' -> '9e2a7:Skyrim.esm'
  const canonToDesc = (c) => { const i = String(c).lastIndexOf(':'); return i < 0 ? '' : `${parseInt(c.slice(i + 1), 16).toString(16)}:${c.slice(0, i)}`; };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const humanize = (edid) => String(edid || 'a spell')
    .replace(/^(ccBGSSSE\d+_|manny_GF_Spell_|ISS_|CYR|BSK|DLC\d)/, '').replace(/^(SpellTome)/, '')
    .replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim() || 'a spell';

  // ---- skills and tiers ------------------------------------------------------------------------------
  const SKILLS_JSON = readJson('skills.json') || {};
  const TIER_NAMES = Array.isArray(SKILLS_JSON.tierNames) ? SKILLS_JSON.tierNames : ['Novice', 'Apprentice', 'Adept', 'Expert', 'Master'];
  const SPELL_SKILLS = (Array.isArray(SKILLS_JSON.skills) ? SKILLS_JSON.skills : []).filter((s) => s && s.studyAt === 'spellStudyPoints');
  const SKILL_OF_SCHOOL = {};
  for (const s of SPELL_SKILLS) for (const school of s.vanillaSkills || []) SKILL_OF_SCHOOL[school] = s;
  const skillDef = (id) => SPELL_SKILLS.find((s) => s.id === id) || null;
  // Tier index 0..4 of a taken-up skill, -1 when not taken up
  const tierOf = (a, skillId) => {
    const r = get(a, 'private.mastery', null);
    if (!r || !Array.isArray(r.order) || !r.order.includes(skillId)) return -1;
    return Math.max(0, Math.min(4, Number(((r.skills || {})[skillId] || {}).rank) || 0));
  };
  const maxRankFor = (skillId, tier) => {
    if (tier < 0) return -1;
    const by = (skillDef(skillId) || {}).spellRankByTier;
    const i = Array.isArray(by) ? RANKS.indexOf(by[tier]) : -1;
    return i >= 0 ? i : tier;
  };

  // ---- study points ----------------------------------------------------------------------------------
  // An entry of skills.json spellStudyPoints is `cells` (or `cell`) alone: anywhere in them; `cell` + `refr`: within
  // radiusMeters of that reference; or `cell` + `places` [{ refr, pos }]: within radiusMeters of any of them, measured
  // from the plugin position (tools/spells/study_points.py writes these for the Study Magic activators, so a reference
  // nobody has loaded still counts). `requires` (a record desc): the entry counts only when that record is in the load
  // order; `until`: only while it is not. The Study Magic activators replace the older points that way (Nate,
  // 2026-09-30: "make StudyMagic activators the study points"), and the older ones hold until the plugin with them is live.
  const UNITS_PER_METER = 70; // as gamemode.js
  const inLoadOrder = (desc) => { try { const id = idOf(desc); const r = id ? mp.lookupEspmRecordById(id) : null; return !!(r && r.record); } catch (e) { return false; } };
  const STUDY_POINTS = (Array.isArray(SKILLS_JSON.spellStudyPoints) ? SKILLS_JSON.spellStudyPoints : [])
    .filter((p) => p && (!p.requires || inLoadOrder(p.requires)) && (!p.until || !inLoadOrder(p.until))).map((p) => ({
      name: String(p.name || 'a spell study point'),
      cells: new Set([].concat(p.cells || [], p.cell ? [p.cell] : []).map(norm)),
      refr: p.refr ? String(p.refr) : null,
      places: Array.isArray(p.places) ? p.places.filter((q) => q && Array.isArray(q.pos) && q.pos.length === 3).map((q) => q.pos.map(Number)) : null,
      radius: Number(p.radiusMeters) || 6,
      schools: Array.isArray(p.schools) ? p.schools : Object.keys(AV_SCHOOL).map((k) => AV_SCHOOL[k]),
    }));
  const nearPlace = (a, p) => {
    const pos = get(a, 'pos', null);
    return Array.isArray(pos) && p.places.some((q) => Math.hypot(pos[0] - q[0], pos[1] - q[1], pos[2] - q[2]) / UNITS_PER_METER <= p.radius);
  };
  const studyPointAt = (a, school) => {
    const cell = norm(get(a, 'worldOrCellDesc', ''));
    return STUDY_POINTS.find((p) => p.cells.has(cell) && (!school || p.schools.includes(school))
      && (p.places ? nearPlace(a, p) : !p.refr || distanceMeters(a, idOf(p.refr)) <= p.radius)) || null;
  };
  // Meters to the nearest study spot of the school in the reader's own cell, or null when the cell has none: a reader
  // inside Frost Crag Spire or the Synod was told only the places' names, which named the place they stood in
  const nearestHere = (a, school) => {
    const cell = norm(get(a, 'worldOrCellDesc', ''));
    const pos = get(a, 'pos', null);
    let best = Infinity;
    if (Array.isArray(pos)) {
      for (const p of STUDY_POINTS) {
        if (!p.places || !p.cells.has(cell) || !p.schools.includes(school)) continue;
        for (const q of p.places) best = Math.min(best, Math.hypot(pos[0] - q[0], pos[1] - q[1], pos[2] - q[2]) / UNITS_PER_METER);
      }
    }
    return best < Infinity ? best : null;
  };
  const studyPointNames = (school) => [...new Set(STUDY_POINTS.filter((p) => p.schools.includes(school)).map((p) => (p.places ? `Study Magic in ${p.name.replace(/^The /, 'the ')}` : p.name)))].join(', ');

  // ---- spells and tomes ------------------------------------------------------------------------------
  const lookup = (id) => { try { const r = id ? mp.lookupEspmRecordById(id >>> 0) : null; return r && r.record ? r : null; } catch (e) { return null; } };
  const field = (rec, type) => { const f = ((rec && rec.record && rec.record.fields) || []).find((x) => x && x.type === type && x.data); return f ? f.data : null; };
  const u32 = (data, off) => (data && data.byteLength >= off + 4 ? new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(off, true) : 0);
  const toGlobal = (rec, local) => { try { return local && rec && typeof rec.toGlobalRecordId === 'function' ? rec.toGlobalRecordId(local) >>> 0 : 0; } catch (e) { return 0; } };

  // Rank from the half-cost perk's editor id (DestructionAdept50), else the first effect's minimum skill level
  const rankFrom = (level, perkEdid) => {
    const i = RANKS.findIndex((w) => String(perkEdid || '').toLowerCase().includes(w.toLowerCase()));
    if (i >= 0) return i;
    return level < 25 ? 0 : level < 50 ? 1 : level < 75 ? 2 : level < 100 ? 3 : 4;
  };
  const spellCache = new Map();
  // { id, desc, school, rank, name } of a castable school spell, or null
  const classifySpell = (spellId) => {
    spellId >>>= 0;
    if (spellCache.has(spellId)) return spellCache.get(spellId);
    let out = null;
    const spel = lookup(spellId);
    if (spel && String(spel.record.type) === 'SPEL') {
      const spit = field(spel, 'SPIT');
      const efid = field(spel, 'EFID');
      const mgef = lookup(toGlobal(spel, u32(efid, 0)));
      const data = field(mgef, 'DATA');
      // SPIT: type at 0x08 (0 = spell), perk at 0x20; MGEF DATA: magic skill at 0x0C, minimum skill level at 0x28
      if (spit && spit.byteLength >= 36 && u32(spit, 8) === 0 && data && data.byteLength >= 0x2c) {
        const school = AV_SCHOOL[u32(data, 0x0c)];
        const perk = lookup(toGlobal(spel, u32(spit, 0x20)));
        if (school) out = { id: spellId, desc: descOf(spellId), school, rank: rankFrom(u32(data, 0x28), perk && perk.record.editorId), name: humanize(spel.record.editorId) };
      }
    }
    spellCache.set(spellId, out);
    return out;
  };

  const TOMES = new Map(); // book id -> { bookId, spellId, school, rank, name, value, plugin, edid }
  const TOME_LIST = (readJson('spell-tomes.json') || {}).tomes || [];
  for (const t of TOME_LIST) {
    const bookId = idOf(canonToDesc(t.id)); const spellId = idOf(canonToDesc(t.spellId));
    if (!bookId || !spellId || !(Number(t.rank) >= 0)) continue;
    const name = String(t.spellName || '') || humanize(t.spell);
    TOMES.set(bookId, { bookId, spellId, school: String(t.school), rank: Number(t.rank), name, title: String(t.fullName || '') || `Spell Tome: ${name}`, value: Math.max(0, Number(t.value) || 0), plugin: String(t.id).split(':')[0], edid: String(t.name || '') });
    if (!spellCache.has(spellId)) spellCache.set(spellId, { id: spellId, desc: descOf(spellId), school: String(t.school), rank: Number(t.rank), name });
  }
  const tomeCache = new Map();
  // null: not a spell tome; { unknown: true }: teaches a spell nobody could classify
  const tomeOf = (bookId) => {
    bookId >>>= 0;
    if (TOMES.has(bookId)) return TOMES.get(bookId);
    if (tomeCache.has(bookId)) return tomeCache.get(bookId);
    let out = null;
    const book = lookup(bookId);
    if (book && String(book.record.type) === 'BOOK') {
      // BOOK DATA: flags at 0x00 (0x04 teaches a spell), spell at 0x04, value at 0x08
      const data = field(book, 'DATA');
      if (data && data.byteLength >= 12 && (data[0] & 0x04)) {
        const sp = classifySpell(toGlobal(book, u32(data, 4)));
        out = sp ? { bookId, spellId: sp.id, school: sp.school, rank: sp.rank, name: sp.name, title: `Spell Tome: ${sp.name}`, value: u32(data, 8), plugin: '', edid: String(book.record.editorId || '') } : { unknown: true, edid: String(book.record.editorId || '') };
      }
    }
    tomeCache.set(bookId, out);
    return out;
  };

  // Spells the server has learned for the actor (not race or base spells), or null when it cannot tell
  const learnedIds = (a) => {
    try {
      const self = { type: 'form', desc: descOf(a) };
      const n = Number(mp.callPapyrusFunction('method', 'Actor', 'GetSpellCount', self, [])) || 0;
      const out = [];
      for (let i = 0; i < n; i++) {
        const s = mp.callPapyrusFunction('method', 'Actor', 'GetNthSpell', self, [i]);
        if (s && s.desc) out.push(idOf(s.desc));
      }
      return out;
    } catch (e) { log('spells: learned list failed', e.message); return null; }
  };
  const knows = (a, spellId) => { const l = learnedIds(a); return !!l && l.includes(spellId >>> 0); };
  const papyrus = (a, fn, spellId, extra) => {
    try { return mp.callPapyrusFunction('method', 'Actor', fn, { type: 'form', desc: descOf(a) }, [{ type: 'espm', desc: descOf(spellId) }].concat(extra || [])) === true; }
    catch (e) { log(`spells: ${fn} ${descOf(spellId)} failed`, e.message); return false; }
  };

  // ---- the spellbook (studied spells, per skill) ----------------------------------------------------------------
  const studiedOf = (a) => { const s = get(a, STUDIED, null); return s && typeof s === 'object' ? s : {}; };
  const studiedIds = (a, skillId) => (Array.isArray(studiedOf(a)[skillId]) ? studiedOf(a)[skillId] : []).map(idOf).filter(Boolean);
  const writeStudied = (a, skillId, ids) => set(a, STUDIED, Object.assign({}, studiedOf(a), { [skillId]: ids.map(descOf).filter(Boolean) }));
  const spellLabel = (sp) => `${sp.name} (${sp.school}, ${RANKS[sp.rank]})`;
  // ---- the spellbook and the prepared spells -------------------------------------------------------------------------
  const MAXP = () => Math.max(0, Number(CFG.prepared) || 0);
  const knownIds = (a) => [].concat(...SPELL_SKILLS.map((s) => studiedIds(a, s.id)));
  const inBook = (a, spellId) => knownIds(a).includes(spellId >>> 0);
  // null until the character has been brought over to prepared spells (migrate below)
  const preparedOf = (a) => { const p = get(a, PREPARED, null); return Array.isArray(p) ? p.map(idOf).filter(Boolean) : null; };
  const preparedIds = (a) => preparedOf(a) || [];
  const writePrepared = (a, ids) => set(a, PREPARED, ids.map(descOf).filter(Boolean));
  const preparedLine = (a) => `Prepared: ${preparedIds(a).length} of ${MAXP()}`;
  const COLLEGE_CELLS = new Set((CFG.prepareCells || []).map(norm));
  // The Scholars' Ledger (salvage.js) is a college of its own (Nate, 2026-09-28: "use the breakdown ledger to access
  // both the book breakdown panel and spells"). The ledger a player opened the book from is kept, and every change is
  // checked against it again: still within reach of it, as a prepare cell is checked by where they stand.
  const LEDGER_REACH_M = 6.5;
  const bookLedger = globalThis.__dboSpellbookLedger instanceof Map ? globalThis.__dboSpellbookLedger : (globalThis.__dboSpellbookLedger = new Map());
  const atLedger = (a) => {
    const ref = bookLedger.get(a >>> 0);
    if (!ref) return false;
    try { return distanceMeters(a, ref) <= LEDGER_REACH_M; } catch (e) { return false; }
  };
  const atCollege = (a) => COLLEGE_CELLS.has(norm(get(a, 'worldOrCellDesc', ''))) || atLedger(a);
  const COLLEGE_HINT = "Prepared spells are changed at a magic college (the Synod Conclave in Bruma, or the College of Winterhold) or at a Scholars' Ledger.";
  // A spell newly in the book: prepared at once while there is room (the engine already holds it after a read; a lesson
  // adds it), else it waits in the book and the engine's copy is taken back. Returns the line to tell the player.
  const settleNew = (a, sp, engineHasIt) => {
    const id = (sp.spellId || sp.id) >>> 0;   // a tome carries its spell as spellId, a classified spell as id
    const prep = preparedIds(a);
    if (prep.length < MAXP()) {
      if (!engineHasIt && !papyrus(a, 'AddSpell', id, [false])) return `${sp.name} is in your spellbook.`;
      writePrepared(a, prep.concat([id]));
      return `It is prepared. ${preparedLine(a)}.`;
    }
    if (engineHasIt) papyrus(a, 'RemoveSpell', id);
    return `Your ${MAXP()} prepared spells are full, so it waits in your spellbook. ${COLLEGE_HINT}`;
  };

  // The skills whose path may take a spell of this school for this character, skills.json's owner first. Alteration is
  // Priest's and, by the schools of magic's rule (schools.js, config schools.alteration; Nate 2026-09-30: "both for priest
  // and arcane"), also Arcane Arts' ('both'), or Arcane Arts' alone ('arcane'). Arcane Arts' path is the school's too.
  const pathsOf = (a, school) => {
    const own = SKILL_OF_SCHOOL[school];
    let rule = 'priest';
    try { rule = typeof globalThis.__dboSchoolsAlteration === 'function' ? String(globalThis.__dboSchoolsAlteration(a) || 'priest') : 'priest'; } catch (e) { rule = 'priest'; }
    const arcane = school === 'Alteration' && rule !== 'priest' ? skillDef('arcane') : null;
    if (!arcane || arcane === own) return own ? [own] : [];
    if (rule === 'arcane') return [arcane];
    return own ? [own, arcane] : [arcane];
  };
  // Why this path cannot take the spell, or null; Arcane Arts' path also asks the schools of magic
  const pathRefusal = (a, sp, whose, skill) => {
    const tier = tierOf(a, skill.id);
    if (tier < 0) return `${whose} not taken up ${skill.label}, the skill that studies ${sp.school}. Reading a Novice ${sp.school} tome at a spell study point takes it up.`;
    const max = maxRankFor(skill.id, tier);
    if (sp.rank > max) return `${sp.name} is ${/^[AEIOU]/.test(RANKS[sp.rank]) ? 'an' : 'a'} ${RANKS[sp.rank]} spell. ${skill.label} at ${TIER_NAMES[tier]} allows up to ${RANKS[max]} spells.`;
    return skill.id === 'arcane' ? schoolRefusal(a, sp, whose === 'You have' ? 'You' : display(a)) : null;
  };
  // The skill whose book a spell goes into: the first path that takes it, or null
  const bookSkillFor = (a, sp) => pathsOf(a, sp.school).find((skill) => !pathRefusal(a, sp, 'You have', skill)) || null;
  // Why this actor cannot hold this spell in a slot, or null. With two paths either will do; the refusal told is the one of
  // the path the character is on (the first whose skill is taken up)
  const slotRefusal = (a, sp, whose) => {
    const paths = pathsOf(a, sp.school);
    if (!paths.length) return `${sp.school} is not studied here.`;
    const whys = paths.map((skill) => pathRefusal(a, sp, whose, skill));
    if (whys.some((w) => !w)) return null;
    const held = paths.findIndex((skill) => tierOf(a, skill.id) >= 0);
    return whys[held >= 0 ? held : 0];
  };
  // The schools of magic (schools.js): a spell of Destruction, Illusion, Conjuration or Alteration is taken only in a school
  // the character has chosen, and no higher than their study of it. null when schools.js has no objection or is not loaded.
  const schoolRefusal = (a, sp, whose) => {
    try { if (typeof globalThis.__dboSchoolsGrandfathered === 'function' && globalThis.__dboSchoolsGrandfathered(a, (sp.spellId || sp.id) >>> 0)) return null; } catch (e) { /* no schools */ }
    try { return typeof globalThis.__dboSchoolsRefusal === 'function' ? (globalThis.__dboSchoolsRefusal(a, sp.school, Number(sp.rank) || 0, whose) || null) : null; }
    catch (e) { log('spells: school check failed', e.message); return null; }
  };

  // ---- reading a tome --------------------------------------------------------------------------------
  // { refuse } or { commit } for the read, or null to leave it to the engine
  const judgeRead = (a, bookId) => {
    if (!CFG.enabled || !onlineActors().includes(a)) return null;
    const tome = tomeOf(bookId);
    if (!tome) return null;
    const refuse = (why) => {
      personal(a, `The words will not settle: ${why} You keep the tome.`);
      audit(`SPELL ${who(a)} refused tome ${descOf(bookId)} (${tome.edid || tome.name}): ${why}`);
      return { refuse: true };
    };
    if (tome.unknown) { log(`spells: tome ${descOf(bookId)} ${tome.edid} teaches a spell that could not be classified`); return refuse('this tome belongs to no school we know.'); }
    if (knows(a, tome.spellId)) return null; // the engine keeps the tome and changes nothing
    if (inBook(a, tome.spellId)) {
      personal(a, `${tome.name} is already in your spellbook. You keep the tome. ${COLLEGE_HINT}`);
      return { refuse: true };
    }
    // A school tome is refused before it can take a skill up: no pool point is spent on a read the school would refuse
    const paths = pathsOf(a, tome.school);
    if (paths.length === 1 && paths[0].id === 'arcane') { const noSchool = schoolRefusal(a, tome, 'You'); if (noSchool) return refuse(noSchool); }
    // A Novice tome read at a spell study point takes up its school's skill, for one pool point, the way a trade is
    // started at its bench (Nate, 2026-09-25): a new character has no spell to cast, so Arcane Arts had no way in.
    // Not when another path already takes it (an Alteration mage of the schools needs no Priest).
    const opens = slotRefusal(a, tome, 'You have') ? paths[0] : null;
    if (opens && tierOf(a, opens.id) < 0 && Number(tome.rank) === 0 && studyPointAt(a, tome.school)
      && typeof globalThis.__alduinakMasteryFirstTouch === 'function') {
      let took = 'unknown';
      try { took = String(globalThis.__alduinakMasteryFirstTouch(a, opens.id)); } catch (e) { log('spells: first touch failed', e.message); }
      if (took === 'full') return refuse(`taking up ${opens.label} needs a free skill point. Mark a skill to fall (K) first.`);
      if (took === 'ok') audit(`SPELL ${who(a)} took up ${opens.id} by reading ${descOf(bookId)} (${tome.edid || tome.name}) at a study point`);
    }
    const why = slotRefusal(a, tome, 'You have');
    if (why) return refuse(why);
    if (!studyPointAt(a, tome.school)) {
      const near = nearestHere(a, tome.school);
      return refuse(`a tome is studied at a spell study point: ${studyPointNames(tome.school) || 'none is set'}.${near === null ? '' : ` The nearest one here is ${Math.max(1, Math.round(near))} m away.`}`);
    }
    const skill = bookSkillFor(a, tome);
    return {
      // Runs after the engine's OnFireSuccess, which skips spells the actor's race or base already grants
      commit: () => {
        migrate(a); // a character not yet brought over is, before the new spell joins the book
        if (!knows(a, tome.spellId) || studiedIds(a, skill.id).includes(tome.spellId)) return log(`spells: ${descOf(a)} read ${descOf(bookId)} but the engine did not learn ${descOf(tome.spellId)}`);
        writeStudied(a, skill.id, studiedIds(a, skill.id).concat([tome.spellId]));
        const line = settleNew(a, tome, true);
        personal(a, `You study ${spellLabel(tome)}. ${line}`);
        audit(`SPELL ${who(a)} learned ${descOf(tome.spellId)} ${tome.name} from tome ${descOf(bookId)} (book ${knownIds(a).length}, prepared ${preparedIds(a).length}/${MAXP()})`);
      },
    };
  };

  // Wrapped around whatever handler was there before; a reload unwraps its own previous wrapper first
  const prevRead = typeof mp.onReadBook === 'function' ? ('__dboSpellsInner' in mp.onReadBook ? mp.onReadBook.__dboSpellsInner : mp.onReadBook) : null;
  const readHook = function (actorId, baseId, ...rest) {
    // Smithing manuals and skill books (manuals.js) are asked first: a manual beyond the reader's tier is refused and kept
    try { if (typeof globalThis.__dboManualsRead === 'function' && globalThis.__dboManualsRead(Number(actorId) >>> 0, Number(baseId) >>> 0) === false) return false; } catch (e) { log('spells: manuals check failed', e.message); }
    let verdict = null;
    try { verdict = judgeRead(Number(actorId) >>> 0, Number(baseId) >>> 0); } catch (e) { log('spells: read check failed', e.stack || e.message); }
    if (verdict && verdict.refuse) return false;
    const r = prevRead ? prevRead.call(this, actorId, baseId, ...rest) : undefined;
    if (r === false) return false;
    if (verdict && verdict.commit) setTimeout(() => { try { verdict.commit(); } catch (e) { log('spells: commit failed', e.message); } }, 0);
    return r;
  };
  readHook.__dboSpellsInner = prevRead;
  mp.onReadBook = readHook;

  // ---- menus -----------------------------------------------------------------------------------------
  const pending = new Map(); // actorId -> { kind, ... }
  const menu = (a, id, title, actions, state) => {
    pending.set(a >>> 0, state);
    openWidget(a, { type: 'contextMenu', id, mode: 'menu', targetName: title, actions, events: { action: 'dbo:spellsChoose', close: 'dbo:spellsClose' } }, true);
  };
  const closeMenu = (a) => { pending.delete(a >>> 0); closeWidget(a, MENU_ID); };

  // ---- /spells and /forget ---------------------------------------------------------------------------
  const bookNonces = globalThis.__dboSpellbookNonces instanceof Map ? globalThis.__dboSpellbookNonces : (globalThis.__dboSpellbookNonces = new Map());
  const entryOf = (id, prepared) => { const sp = classifySpell(id) || { name: descOf(id), school: '?', rank: 0 }; return { id: descOf(id), name: sp.name, school: sp.school, rank: sp.rank, rankName: RANKS[sp.rank] || '', prepared }; };
  const openBook = (a, result, resultKind) => {
    const nonce = `${(a >>> 0).toString(16)}-${Date.now().toString(36)}`;
    bookNonces.set(a >>> 0, nonce);
    const prep = preparedIds(a);
    const college = atCollege(a);
    openWidget(a, {
      type: 'spellbook', id: BOOK_ID, nonce, max: MAXP(), atCollege: college, hint: college ? '' : COLLEGE_HINT,
      prepared: prep.map((id) => entryOf(id, true)),
      known: knownIds(a).map((id) => entryOf(id, prep.includes(id))).sort((x, y) => x.school.localeCompare(y.school) || x.rank - y.rank || x.name.localeCompare(y.name)),
      result: result || '', resultKind: resultKind || '',
      events: { prepare: 'dbo:spellbookPrepare', unprepare: 'dbo:spellbookUnprepare', close: 'dbo:spellbookClose' },
    }, true);
  };
  // Nothing is forgotten now (Nate, 2026-09-28): /spells forget and the hidden /forget (Worker B's aliases) open the book
  const RETIRED = 'Spells are no longer forgotten: put one away in your spellbook instead, at a magic college.';
  // The panel opens only for a client whose UI said it draws it (dbo:uiCaps 'spellbook' from the HUD): an unknown
  // widget opened with focus would leave an invisible panel holding the keys. An older client gets the book in chat.
  const caps = globalThis.__dboSpellbookCaps instanceof Map ? globalThis.__dboSpellbookCaps : (globalThis.__dboSpellbookCaps = new Map());
  onUi('uiCaps', (a, args) => { caps.set(a >>> 0, new Set((args || []).map(String))); });
  const hasPanel = (a) => (caps.get(a >>> 0) || new Set()).has('spellbook');
  const bookInChat = (a, result) => {
    const name = (id) => (classifySpell(id) || { name: descOf(id) }).name;
    const prep = preparedIds(a);
    const rest = knownIds(a).filter((id) => !prep.includes(id));
    personal(a, `${result ? result + ' ' : ''}Prepared (${prep.length} of ${MAXP()}): ${prep.map(name).join(', ') || 'none'}. In your spellbook: ${rest.map(name).join(', ') || 'nothing else'}. Update the game (restart the launcher) for the spellbook panel, where prepared spells are changed.`);
  };
  const openFromCommand = (a, result) => {
    if (!CFG.enabled) return personal(a, 'Spell study is closed.');
    migrate(a);
    if (!hasPanel(a)) return bookInChat(a, result);
    openBook(a, result || '', result ? 'refused' : '');
  };
  registerChatCommand('spells', (a, args) => {
    bookLedger.delete(a >>> 0);
    const first = String(Array.isArray(args) ? args[0] : args || '').trim();
    openFromCommand(a, /^forget\b/i.test(first) ? RETIRED : '');
  }, { help: 'your spellbook: every spell you have studied, and the prepared ones (changed at a magic college)' });
  registerChatCommand('forget', (a) => openFromCommand(a, RETIRED), { hidden: true, help: 'retired; /spells opens your spellbook' });

  // { ok, text } of preparing or putting away one spell
  const changePrepared = (a, spellId, want) => {
    if (!atCollege(a)) return { ok: false, text: COLLEGE_HINT };
    if (!inBook(a, spellId)) return { ok: false, text: 'That spell is not in your spellbook.' };
    const sp = classifySpell(spellId) || { id: spellId, name: descOf(spellId) };
    const prep = preparedIds(a);
    if (want) {
      if (prep.includes(spellId)) return { ok: true, text: `${sp.name} is already prepared.` };
      if (prep.length >= MAXP()) return { ok: false, text: `All ${MAXP()} prepared places are taken. Put one away first.` };
      if (!knows(a, spellId) && !papyrus(a, 'AddSpell', spellId, [false])) return { ok: false, text: `${sp.name} would not settle. Try again.` };
      writePrepared(a, prep.concat([spellId]));
      audit(`SPELL ${who(a)} prepared ${descOf(spellId)} ${sp.name} (${preparedIds(a).length}/${MAXP()})`);
      return { ok: true, text: `${sp.name} is prepared. ${preparedLine(a)}.` };
    }
    if (!prep.includes(spellId)) return { ok: true, text: `${sp.name} is not prepared.` };
    papyrus(a, 'RemoveSpell', spellId);
    writePrepared(a, prep.filter((id) => id !== spellId));
    audit(`SPELL ${who(a)} put away ${descOf(spellId)} ${sp.name} (${preparedIds(a).length}/${MAXP()})`);
    return { ok: true, text: `${sp.name} goes back into your spellbook. ${preparedLine(a)}.` };
  };
  const freshBook = (a, args) => bookNonces.get(a >>> 0) === String(args[0] || '');
  onUi('spellbookPrepare', (a, args) => { if (!freshBook(a, args)) return; const r = changePrepared(a, idOf(String(args[1] || '')), true); openBook(a, r.text, r.ok ? 'ok' : 'refused'); });
  onUi('spellbookUnprepare', (a, args) => { if (!freshBook(a, args)) return; const r = changePrepared(a, idOf(String(args[1] || '')), false); openBook(a, r.text, r.ok ? 'ok' : 'refused'); });
  onUi('spellbookClose', (a) => { bookNonces.delete(a >>> 0); bookLedger.delete(a >>> 0); closeWidget(a, BOOK_ID); });
  // salvage.js's ledger menu opens the book here; { ledger } is the ledger's ref, which lets spells be prepared beside it.
  // Opened any other way (/spells), the book forgets a ledger from before.
  globalThis.__dboOpenSpellbook = (a, opts) => {
    const ledger = opts && Number(opts.ledger) >>> 0;
    if (ledger) bookLedger.set(a >>> 0, ledger); else bookLedger.delete(a >>> 0);
    const panel = !!CFG.enabled && hasPanel(a);
    openFromCommand(a, '');
    return panel;
  };

  // For schools.js: the spellbook (every spell studied or taught), every school spell the character knows (the engine's
  // list and the book), and one spell's school and rank; each entry { id, desc, school, rank, name }
  globalThis.__dboSpellsBook = (a) => [].concat(...SPELL_SKILLS.map((s) => studiedIds(a, s.id).map((id) => { const sp = classifySpell(id); return sp ? Object.assign({ book: s.id }, sp) : null; }))).filter(Boolean);
  globalThis.__dboSpellsKnown = (a) => { const ids = new Set(learnedIds(a) || []); for (const id of knownIds(a)) ids.add(id); return [...ids].map(classifySpell).filter(Boolean); };
  globalThis.__dboSpellsClassify = (id) => classifySpell(Number(id) >>> 0);
  // A spell given outright into one skill's book, as a lesson adds it (schools.js: a new mage's first spell). No tier or
  // school check: the giver has decided. { ok, name, line }, or null when the spell is unknown here.
  globalThis.__dboSpellsGrant = (a, spellId, skillId) => {
    const sp = classifySpell(Number(spellId) >>> 0);
    const skill = skillDef(String(skillId || 'arcane'));
    if (!sp || !skill) return null;
    if (inBook(a, sp.id)) return { ok: false, name: sp.name, line: `${sp.name} is already in your spellbook.` };
    migrate(a);
    writeStudied(a, skill.id, studiedIds(a, skill.id).concat([sp.id]));
    const line = settleNew(a, sp, knows(a, sp.id));
    audit(`SPELL ${who(a)} was given ${descOf(sp.id)} ${sp.name} into ${skill.id} (book ${knownIds(a).length}, prepared ${preparedIds(a).length}/${MAXP()})`);
    return { ok: true, name: sp.name, line };
  };

  // Bringing a character over: the first time the server sees them after this change, the spells of their book the
  // engine holds become prepared, up to the limit in the order they were learned; any beyond it are taken back into
  // the book, and they are told once. A character with no studied spells just starts with none prepared.
  const migrate = (a) => {
    if (preparedOf(a) !== null) return;
    const book = knownIds(a);
    if (!book.length) { writePrepared(a, []); return; }
    const held = learnedIds(a);
    if (!held) return; // the engine could not say; try again later
    const on = book.filter((id) => held.includes(id));
    const keep = on.slice(0, MAXP()), away = on.slice(MAXP());
    for (const id of away) papyrus(a, 'RemoveSpell', id);
    writePrepared(a, keep);
    if (away.length) {
      personal(a, `Spells are now prepared, ${MAXP()} at a time. Prepared: ${keep.map((id) => (classifySpell(id) || { name: '?' }).name).join(', ')}. In your spellbook: ${away.map((id) => (classifySpell(id) || { name: '?' }).name).join(', ')}. /spells opens it. ${COLLEGE_HINT}`);
    }
    audit(`SPELL ${who(a)} brought over to prepared spells: ${keep.length} prepared, ${away.length} put away, book ${book.length}`);
  };
  if (typeof api.every === 'function') api.every('spells.migrate', 20000, () => { if (!CFG.enabled) return; for (const a of onlineActors()) { try { migrate(a); } catch (e) { log('spells: migrate failed', e.message); } } });

  // ---- /teach ----------------------------------------------------------------------------------------
  // Spells this teacher may pass on: school spells the server has learned for them (studied or known before) in skills at teacher tier
  const teachable = (a) => {
    const skills = SPELL_SKILLS.filter((s) => tierOf(a, s.id) >= CFG.teacherMinTier);
    if (!skills.length) return [];
    const ids = new Set(learnedIds(a) || []);
    for (const s of skills) for (const id of studiedIds(a, s.id)) ids.add(id);
    return [...ids].map(classifySpell).filter((sp) => sp && pathsOf(a, sp.school).some((skill) => skills.includes(skill)));
  };
  const near = (a, b) => distanceMeters(a, b) <= CFG.teachMeters;
  // Why the student cannot take this spell from this teacher now, or null
  const teachRefusal = (teacher, student, sp) => {
    if (!onlineActors().includes(student)) return `${display(student)} is not here.`;
    if (!near(teacher, student)) return `${display(student)} must stand within ${CFG.teachMeters} m.`;
    if (CFG.teachAtStudyPoint && !(studyPointAt(teacher, sp.school) && studyPointAt(student, sp.school))) return 'Teaching happens at a spell study point.';
    const taught = pathsOf(teacher, sp.school), learning = pathsOf(student, sp.school);
    if (!taught.some((skill) => tierOf(teacher, skill.id) >= CFG.teacherMinTier)) return `Teaching ${sp.school} takes ${taught.map((skill) => skill.label).join(' or ')} at ${TIER_NAMES[CFG.teacherMinTier]}.`;
    if (!learning.some((skill) => tierOf(student, skill.id) >= CFG.studentMinTier)) return `${display(student)} needs ${learning.map((skill) => skill.label).join(' or ')} at ${TIER_NAMES[CFG.studentMinTier]} or higher to be taught.`;
    if (knows(student, sp.id) || inBook(student, sp.id)) return `${display(student)} already knows ${sp.name}.`;
    return slotRefusal(student, sp, `${display(student)} has`);
  };
  const offers = globalThis.__dboSpellOffers instanceof Map ? globalThis.__dboSpellOffers : (globalThis.__dboSpellOffers = new Map()); // student -> offer
  registerChatCommand('teach', (a) => {
    if (!CFG.enabled) return personal(a, 'Spell teaching is closed.');
    if (!SPELL_SKILLS.some((s) => tierOf(a, s.id) >= CFG.teacherMinTier)) return personal(a, `Teaching takes ${SPELL_SKILLS.map((s) => s.label).join(' or ')} at ${TIER_NAMES[CFG.teacherMinTier]} or higher.`);
    if (!teachable(a).length) return personal(a, 'You know no spell of your schools to teach.');
    const students = onlineActors().filter((p) => p !== (a >>> 0) && near(a, p)).slice(0, MAX_ROWS);
    if (!students.length) return personal(a, `Nobody stands within ${CFG.teachMeters} m to teach.`);
    menu(a, MENU_ID, 'Teach whom?', students.map((p) => ({ id: `student:${p.toString(16)}`, label: display(p) })), { kind: 'teach' });
  }, { help: 'Teach a spell to a player beside you (Arcane Arts or Priest at Expert)' });

  const offerTeach = (teacher, student, spellId) => {
    const sp = teachable(teacher).find((x) => x.id === spellId);
    if (!sp) return personal(teacher, 'You cannot teach that spell.');
    const why = teachRefusal(teacher, student, sp);
    if (why) return personal(teacher, why);
    offers.set(student >>> 0, { teacher: teacher >>> 0, spellId, at: Date.now() });
    openWidget(student, { type: 'contextMenu', id: MENU_ID, mode: 'menu', targetName: `${display(teacher)} offers to teach you ${spellLabel(sp)}`,
      actions: [{ id: 'accept', label: 'Learn it (it goes into your spellbook)' }, { id: 'decline', label: 'Decline' }],
      events: { action: 'dbo:spellsOffer', close: 'dbo:spellsOfferClose' } }, true);
    personal(teacher, `You offer to teach ${display(student)} ${sp.name}.`);
  };
  const answerOffer = (student, accept) => {
    const o = offers.get(student >>> 0);
    offers.delete(student >>> 0);
    closeWidget(student, MENU_ID);
    if (!o) return;
    if (Date.now() - o.at > CFG.offerSeconds * 1000) return personal(student, 'The offer has lapsed.');
    if (!accept) { personal(o.teacher, `${display(student)} declines the lesson.`); return; }
    const sp = teachable(o.teacher).find((x) => x.id === o.spellId);
    if (!sp) { personal(student, 'Your teacher can no longer teach that spell.'); return; }
    const why = teachRefusal(o.teacher, student, sp);
    if (why) { personal(student, why); personal(o.teacher, why); return; }
    const skill = bookSkillFor(student, sp);
    migrate(student);
    writeStudied(student, skill.id, studiedIds(student, skill.id).concat([sp.id]));
    const line = settleNew(student, sp, false);
    personal(student, `${display(o.teacher)} teaches you ${spellLabel(sp)}. ${line}`);
    personal(o.teacher, `You teach ${display(student)} ${sp.name}.`);
    audit(`SPELL ${who(o.teacher)} taught ${who(student)} ${descOf(sp.id)} ${sp.name} (book ${knownIds(student).length}, prepared ${preparedIds(student).length}/${MAXP()})`);
  };
  onUi('spellsOffer', (a, args) => answerOffer(a, String(args[0] || '') === 'accept'));
  onUi('spellsOfferClose', (a) => answerOffer(a, false));

  // ---- /tomes: the college shop panel in the Synod enclave -------------------------------------------
  const SHOP_CELLS = new Set((CFG.shopCells || []).map(norm));
  const excluded = (() => { try { return new RegExp(CFG.shopExcludePattern, 'i'); } catch (e) { return null; } })();
  const SHOP = (() => {
    const pref = (t) => { const i = (CFG.shopPreferPlugins || []).indexOf(t.plugin); return i < 0 ? 99 : i; };
    const seen = new Set();
    return [...TOMES.values()]
      .filter((t) => t.rank <= Number(CFG.shopMaxRank) && !(CFG.shopExcludePlugins || []).includes(t.plugin) && !(excluded && excluded.test(t.edid)))
      .sort((x, y) => x.school.localeCompare(y.school) || x.rank - y.rank || pref(x) - pref(y) || x.name.localeCompare(y.name))
      .filter((t) => (seen.has(t.spellId) ? false : seen.add(t.spellId)));
  })();
  const priceOf = (t) => Math.max(1, Math.round(t.value * (Number(CFG.shopPriceMultiplier) || 1)));
  // The province filter from regions.js, or null when it is not loaded or switched off
  const regions = () => { const R = globalThis.__dboRegions; return R && R.tomesOn() ? R : null; };
  const soldHere = (R, t) => !R || R.tomeOk(t.bookId, CFG.shopProvince);
  const soldIn = (R, t) => { const w = R ? R.tomeWhere(t.bookId) : null; return w && w.length ? R.listNames(w) : ''; };
  const inShop = (a) => SHOP_CELLS.has(norm(get(a, 'worldOrCellDesc', '')));
  const isMember = (a) => { const g = get(a, 'private.dboGuilds', []); return Array.isArray(g) && g.some((m) => m && (CFG.shopFactions || []).includes(String(m.id))); };
  // The Synod Conclave's enchanting table is the Synod's (its CYRBlockedFactionWorkshop script, whose faction is the Synod,
  // never runs on the server): only members of the Synod or a College use it, as with the tome shop (Nate, 2026-09-30).
  // gamemode.js asks before the skills' own station gate, so a refused touch takes up nothing.
  const WORKSHOPS = new Set((CFG.guildWorkshops || []).map(idOf).filter(Boolean));
  const workshopDeny = globalThis.__dboGuildWorkshopDeny instanceof Map ? globalThis.__dboGuildWorkshopDeny : (globalThis.__dboGuildWorkshopDeny = new Map());
  globalThis.__dboGuildWorkshop = (targetId, casterId) => {
    if (!CFG.enabled || !WORKSHOPS.has(targetId >>> 0) || isMember(casterId)) return false;
    if (Date.now() - (workshopDeny.get(casterId >>> 0) || 0) > 1500) {
      workshopDeny.set(casterId >>> 0, Date.now());
      personal(casterId, "This is the Synod's own enchanting table. Only members of the Synod or a College may use it.");
    }
    return true;
  };
  const goldOf = (a) => { const inv = get(a, 'inventory', { entries: [] }); return (Array.isArray(inv.entries) ? inv.entries : []).reduce((n, e) => n + ((Number(e.baseId) >>> 0) === GOLD && !e.worn ? Number(e.count) || 0 : 0), 0); };
  // The lowest tier of the skill whose spell rank reaches this tome, never below shopMinTier
  const tierFor = (skillId, rank) => { for (let t = 0; t < 5; t++) if (maxRankFor(skillId, t) >= rank) return Math.max(t, CFG.shopMinTier); return 4; };
  // Why this tome is out of the buyer's reach, or ''
  const tomeBlock = (a, t) => {
    const paths = pathsOf(a, t.school);
    if (paths.some((skill) => tierOf(a, skill.id) >= tierFor(skill.id, t.rank))) return '';
    return `Needs ${paths.map((skill) => `${skill.label} ${TIER_NAMES[tierFor(skill.id, t.rank)]}`).join(' or ')}`;
  };
  const nextBuyAt = (a) => { const at = (Number(get(a, BOUGHT, 0)) || 0) + CFG.shopCooldownDays * DAY; return at > Date.now() ? at : 0; };
  const waitText = (ms) => { const h = Math.ceil(ms / 3600000); return h >= 24 ? `${plural(Math.floor(h / 24), 'day')}${h % 24 ? ' ' + plural(h % 24, 'hour') : ''}` : plural(h, 'hour'); };
  // Why this actor cannot buy now, or ''
  const shopRefusal = (a) => {
    if (!CFG.enabled) return 'The tome shop is closed.';
    if (!inShop(a)) return 'Tomes are sold inside the Synod Conclave in Bruma.';
    if (!isMember(a)) return 'The court mage sells tomes only to members of the Synod or a College.';
    if (!SPELL_SKILLS.some((s) => tierOf(a, s.id) >= CFG.shopMinTier)) return `Tomes are sold to those with ${SPELL_SKILLS.map((s) => s.label).join(' or ')} at ${TIER_NAMES[CFG.shopMinTier]} or higher.`;
    const next = nextBuyAt(a);
    if (next) return `You bought a tome this week. The next is yours in ${waitText(next - Date.now())}.`;
    return '';
  };

  const shopNonces = globalThis.__dboTomeNonces instanceof Map ? globalThis.__dboTomeNonces : (globalThis.__dboTomeNonces = new Map());
  const openShop = (a, result, resultKind) => {
    const nonce = `${(a >>> 0).toString(16)}-${Date.now().toString(36)}`;
    shopNonces.set(a >>> 0, nonce);
    const held = SPELL_SKILLS.map((s) => ({ s, tier: tierOf(a, s.id) })).filter((x) => x.tier >= 0);
    const schools = new Set([].concat(...held.map((x) => x.s.vanillaSkills || [])).concat(Object.keys(SKILL_OF_SCHOOL).filter((school) => pathsOf(a, school).some((skill) => tierOf(a, skill.id) >= 0))));
    const gold = goldOf(a);
    const whyNot = shopRefusal(a);
    const R = regions();
    const admin = !!R && R.bypass(a);
    openWidget(a, {
      type: 'tomeShop', id: SHOP_ID, nonce, title: R ? `The Synod: Spell Tomes of ${R.provinceName(CFG.shopProvince)}` : 'The Synod: Spell Tomes', gold,
      canBuy: !whyNot, nextPurchaseAt: nextBuyAt(a), whyNot,
      skills: held.map((x) => ({ id: x.s.id, label: x.s.label, tier: x.tier, tierName: TIER_NAMES[x.tier], schools: (x.s.vanillaSkills || []).slice() })),
      tomes: SHOP.filter((t) => schools.has(t.school) && (soldHere(R, t) || admin || CFG.shopShowForeign)).map((t) => {
        const foreign = !soldHere(R, t);
        return {
          id: descOf(t.bookId), name: foreign && admin ? `${t.title} (${soldIn(R, t) || 'sold nowhere'})` : t.title, spell: t.name, school: t.school, rank: t.rank, rankName: RANKS[t.rank],
          price: priceOf(t), canAfford: gold >= priceOf(t), blocked: foreign && !admin ? (soldIn(R, t) ? `Sold in ${soldIn(R, t)}` : 'Not sold anywhere') : tomeBlock(a, t),
        };
      }),
      result: result || '', resultKind: resultKind || '',
    }, true);
  };
  registerChatCommand('tomes', (a) => {
    if (!CFG.enabled) return personal(a, 'The tome shop is closed.');
    if (!inShop(a)) return personal(a, 'The court mage sells spell tomes inside the Synod Conclave in Bruma.');
    openShop(a);
  }, { help: 'The Synod tome shop (inside the Synod Conclave; college members, one tome a week)' });

  // { ok, text } of a purchase
  const buy = (a, bookId) => {
    const why = shopRefusal(a);
    if (why) return { ok: false, text: why };
    const t = SHOP.find((x) => x.bookId === bookId);
    if (!t || !pathsOf(a, t.school).some((skill) => tierOf(a, skill.id) >= 0)) return { ok: false, text: 'The court mage will not sell you that tome.' };
    const R = regions();
    if (!soldHere(R, t) && !R.bypass(a)) return { ok: false, text: `The Synod does not stock ${t.name}; ${soldIn(R, t) ? `it is sold in ${soldIn(R, t)}` : 'it is not sold anywhere'}.` };
    const block = tomeBlock(a, t);
    if (block) return { ok: false, text: `${t.title}: ${block}.` };
    const price = priceOf(t);
    if (!takeGold(a, price)) return { ok: false, text: `${t.title} costs ${price} gold, and you do not have it.` };
    if (!giveItem(a, t.bookId, 1)) { giveItem(a, GOLD, price); return { ok: false, text: 'The court mage could not hand you the tome. Your gold is returned.' }; }
    const paid = depositToTreasury(CFG.shopTreasury, price);
    set(a, BOUGHT, Date.now());
    audit(`SPELL ${who(a)} bought tome ${descOf(t.bookId)} ${t.title} for ${price} gold (${paid} to ${CFG.shopTreasury} treasury)`);
    return { ok: true, text: `You buy ${t.title} for ${price} gold. Read it at a spell study point. Your next tome is a week away.` };
  };
  const freshShop = (a, args) => shopNonces.get(a >>> 0) === String(args[0] || '');
  onUi('tomeBuy', (a, args) => {
    if (!freshShop(a, args)) return;
    const r = buy(a, idOf(String(args[1] || '')));
    openShop(a, r.text, r.ok ? 'ok' : 'refused');
  });
  onUi('tomeClose', (a) => { shopNonces.delete(a >>> 0); closeWidget(a, SHOP_ID); });

  // ---- menu answers ----------------------------------------------------------------------------------
  onUi('spellsChoose', (a, args) => {
    const p = pending.get(a >>> 0); const choice = String(args[0] || '');
    // Picking a spell to forget or a student reopens this widget id as the next menu; closing it first in the same tick
    // loses the cursor (the inn prompt, 2026-09-25), so those paths reopen with no close in between.
    const reopening = !!p && p.kind === 'teach' && choice.startsWith('student:');
    if (reopening) pending.delete(a >>> 0); else closeMenu(a);
    if (!p || choice === 'cancel') return;
    if (p.kind === 'teach') {
      if (choice.startsWith('student:')) {
        const student = parseInt(choice.slice(8), 16) >>> 0;
        const list = teachable(a).map((sp) => ({ id: `lesson:${student.toString(16)}:${descOf(sp.id)}`, label: spellLabel(sp) }));
        return menu(a, MENU_ID, `Teach ${display(student)} which spell?`, list.slice(0, MAX_ROWS), { kind: 'teach' });
      }
      if (choice.startsWith('lesson:')) { const [, s16, ...d] = choice.split(':'); return offerTeach(a, parseInt(s16, 16) >>> 0, idOf(d.join(':'))); }
      return;
    }
  });
  onUi('spellsClose', (a) => closeMenu(a));
  onUi('close', (a, args, widgetId) => { if (widgetId === MENU_ID) { pending.delete(a >>> 0); offers.delete(a >>> 0); } if (widgetId === SHOP_ID) shopNonces.delete(a >>> 0); if (widgetId === BOOK_ID) { bookNonces.delete(a >>> 0); bookLedger.delete(a >>> 0); } });

  // For the F3 Magic tab (schools.js __dboMagicTab): the book, the prepared spells and the spells held outside the book
  // (granted outright, never studied: they take no prepared place), and whether they may be changed where `a` stands
  globalThis.__dboSpellsTab = (a) => {
    const prep = preparedIds(a);
    const book = knownIds(a);
    const outside = (learnedIds(a) || []).filter((id) => !book.includes(id)).map(classifySpell).filter(Boolean)
      .map((sp) => ({ id: descOf(sp.id), name: sp.name, school: sp.school, rank: sp.rank, rankName: RANKS[sp.rank] || '' }));
    const college = atCollege(a);
    return {
      max: MAXP(), canPrepare: college, hint: college ? '' : COLLEGE_HINT,
      prepared: prep.map((id) => entryOf(id, true)),
      known: book.map((id) => entryOf(id, prep.includes(id))).sort((x, y) => x.school.localeCompare(y.school) || x.rank - y.rank || x.name.localeCompare(y.name)),
      outside,
    };
  };
  // The highest spell rank `skillId`'s tier lets `a` learn, -1 when the skill is not taken up
  globalThis.__dboSpellsRankCap = (a, skillId) => maxRankFor(String(skillId), tierOf(a, String(skillId)));
  // The Magic tab's prepare and put-away (the spellbook's rule: at a college or beside a Scholars' Ledger); { ok, text }
  globalThis.__dboSpellsChangePrepared = (a, spellDesc, want) => {
    if (!CFG.enabled) return { ok: false, text: 'Spell study is closed.' };
    migrate(a);
    const r = changePrepared(a, idOf(String(spellDesc || '')), !!want);
    return { ok: !!r.ok, text: r.text };
  };
  // Tomes of `school` up to the rank `skillId`'s tier allows (and `maxRank`), whose spell `a` does not know, lowest rank
  // first, with where they are sold: [{ spell, school, rank, rankName, where }]
  globalThis.__dboSpellsTomesFor = (a, school, skillId, maxRank, limit) => {
    const cap = Math.min(maxRankFor(String(skillId), tierOf(a, String(skillId))), Number.isFinite(Number(maxRank)) ? Number(maxRank) : 4);
    if (cap < 0) return [];
    const have = new Set([].concat(learnedIds(a) || [], knownIds(a)));
    const R = regions();
    const seen = new Set();
    const pref = (t) => { const i = (CFG.shopPreferPlugins || []).indexOf(t.plugin); return i < 0 ? 99 : i; };
    const shop = new Set(SHOP.map((t) => t.bookId));
    return [...TOMES.values()]
      .filter((t) => t.school === school && t.rank <= cap && !have.has(t.spellId) && !(CFG.shopExcludePlugins || []).includes(t.plugin) && !(excluded && excluded.test(t.edid)))
      .sort((x, y) => x.rank - y.rank || (shop.has(y.bookId) && soldHere(R, y) ? 1 : 0) - (shop.has(x.bookId) && soldHere(R, x) ? 1 : 0) || pref(x) - pref(y) || x.name.localeCompare(y.name))
      .filter((t) => (seen.has(t.spellId) ? false : seen.add(t.spellId)))
      .slice(0, Math.max(1, Number(limit) || 6))
      .map((t) => ({ spell: t.name, school: t.school, rank: t.rank, rankName: RANKS[t.rank],
        where: shop.has(t.bookId) && soldHere(R, t) ? 'Sold by the Synod in Bruma (members of the Synod or a College)' : soldIn(R, t) ? `Sold in ${soldIn(R, t)}` : 'Found, not sold' }));
  };

  const R0 = regions();
  log(`spells ${CFG.enabled ? 'on' : 'off'}: ${TOMES.size} tomes known, ${STUDY_POINTS.length} study point(s), ${SHOP.length} tomes in the Synod shop, ${MAXP()} prepared, changed in ${COLLEGE_CELLS.size} college cell(s)${R0 ? `, ${SHOP.filter((t) => soldHere(R0, t)).length} stocked for ${R0.provinceName(CFG.shopProvince)}` : ''}`);
};
