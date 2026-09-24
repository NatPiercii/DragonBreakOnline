// Spell study, slots, unlearning, teaching and the Synod tome shop, loaded by gamemode.js like jail.js.
//
// Reading a spell tome is refused unless the reader has taken up the school's skill (arcane: Destruction,
// Conjuration, Illusion; priest: Restoration, Alteration), the tome's rank fits their tier, they stand at a spell
// study point (skills.json spellStudyPoints) and a slot of that skill is free. A refused read keeps the tome and the
// engine takes the spell back off the client (ReadBookEvent::OnFireBlocked sends Actor.RemoveSpell).
// /spells lists studied spells, /forget frees a slot, /teach passes a spell to a nearby player, /tomes is the
// college shop inside the Synod enclave. Tomes are classified from spell-tomes.json (ck-mcp/readables.py), and any
// tome missing from it is read from its records at runtime.
//
// State, on the character:
//   private.dboStudied       { arcane: [spell desc...], priest: [...] }  spells learned through this system
//   private.dboTomeBoughtAt  ms of the last shop purchase

const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, system, audit, display, who, cfg, openWidget, closeWidget, onUi, registerChatCommand,
    onlineActors, distanceMeters, takeGold, giveItem, depositToTreasury } = api;

  const CFG = Object.assign({
    enabled: true,
    slots: 0,
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
  }, cfg.spells || {});

  const SHOP_ID = 44;
  const MENU_ID = 45;
  const GOLD = 0xf;
  const DAY = 86400000;
  const MAX_ROWS = 12;
  const RANKS = ['Novice', 'Apprentice', 'Adept', 'Expert', 'Master'];
  const AV_SCHOOL = { 18: 'Alteration', 19: 'Conjuration', 20: 'Destruction', 21: 'Illusion', 22: 'Restoration' };
  const STUDIED = 'private.dboStudied';
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
  const TIER_NAMES = Array.isArray(SKILLS_JSON.tierNames) ? SKILLS_JSON.tierNames : ['Novice', 'Apprentice', 'Journeyman', 'Expert', 'Master'];
  const SPELL_SKILLS = (Array.isArray(SKILLS_JSON.skills) ? SKILLS_JSON.skills : []).filter((s) => s && s.studyAt === 'spellStudyPoints');
  const SKILL_OF_SCHOOL = {};
  for (const s of SPELL_SKILLS) for (const school of s.vanillaSkills || []) SKILL_OF_SCHOOL[school] = s;
  const skillDef = (id) => SPELL_SKILLS.find((s) => s.id === id) || null;
  const slotsOf = (id) => Number(CFG.slots) > 0 ? Number(CFG.slots) : Math.max(0, Number((skillDef(id) || {}).spellSlots) || 3);
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
  const STUDY_POINTS = (Array.isArray(SKILLS_JSON.spellStudyPoints) ? SKILLS_JSON.spellStudyPoints : []).map((p) => ({
    name: String(p.name || 'a spell study point'),
    cells: new Set([].concat(p.cells || [], p.cell ? [p.cell] : []).map(norm)),
    refr: p.refr ? String(p.refr) : null,
    radius: Number(p.radiusMeters) || 6,
    schools: Array.isArray(p.schools) ? p.schools : Object.keys(AV_SCHOOL).map((k) => AV_SCHOOL[k]),
  }));
  const studyPointAt = (a, school) => {
    const cell = norm(get(a, 'worldOrCellDesc', ''));
    return STUDY_POINTS.find((p) => p.cells.has(cell) && (!school || p.schools.includes(school)) && (!p.refr || distanceMeters(a, idOf(p.refr)) <= p.radius)) || null;
  };

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

  // ---- studied slots ---------------------------------------------------------------------------------
  const studiedOf = (a) => { const s = get(a, STUDIED, null); return s && typeof s === 'object' ? s : {}; };
  const studiedIds = (a, skillId) => (Array.isArray(studiedOf(a)[skillId]) ? studiedOf(a)[skillId] : []).map(idOf).filter(Boolean);
  const writeStudied = (a, skillId, ids) => set(a, STUDIED, Object.assign({}, studiedOf(a), { [skillId]: ids.map(descOf).filter(Boolean) }));
  const spellLabel = (sp) => `${sp.name} (${sp.school}, ${RANKS[sp.rank]})`;
  const slotLine = (a, skillId) => `${skillDef(skillId).label} slots: ${studiedIds(a, skillId).length} of ${slotsOf(skillId)}`;

  // Why this actor cannot hold this spell in a slot, or null
  const slotRefusal = (a, sp, whose) => {
    const skill = SKILL_OF_SCHOOL[sp.school];
    if (!skill) return `${sp.school} is not studied here.`;
    const tier = tierOf(a, skill.id);
    if (tier < 0) return `${whose} not taken up ${skill.label}, the skill that studies ${sp.school}.`;
    const max = maxRankFor(skill.id, tier);
    if (sp.rank > max) return `${sp.name} is ${/^[AEIOU]/.test(RANKS[sp.rank]) ? 'an' : 'a'} ${RANKS[sp.rank]} spell. ${skill.label} at ${TIER_NAMES[tier]} allows up to ${RANKS[max]} spells.`;
    const held = studiedIds(a, skill.id);
    if (held.length >= slotsOf(skill.id)) return `All ${slotsOf(skill.id)} ${skill.label} slots are full (${held.map((id) => (classifySpell(id) || { name: '?' }).name).join(', ')}). /forget one first.`;
    return null;
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
    const why = slotRefusal(a, tome, 'You have');
    if (why) return refuse(why);
    if (!studyPointAt(a, tome.school)) return refuse(`a tome is studied at a spell study point: ${STUDY_POINTS.filter((p) => p.schools.includes(tome.school)).map((p) => p.name).join(', ') || 'none is set'}.`);
    const skill = SKILL_OF_SCHOOL[tome.school];
    return {
      // Runs after the engine's OnFireSuccess, which skips spells the actor's race or base already grants
      commit: () => {
        if (!knows(a, tome.spellId) || studiedIds(a, skill.id).includes(tome.spellId)) return log(`spells: ${descOf(a)} read ${descOf(bookId)} but the engine did not learn ${descOf(tome.spellId)}`);
        writeStudied(a, skill.id, studiedIds(a, skill.id).concat([tome.spellId]));
        personal(a, `You study ${spellLabel(tome)}. ${slotLine(a, skill.id)}.`);
        audit(`SPELL ${who(a)} learned ${descOf(tome.spellId)} ${tome.name} from tome ${descOf(bookId)} (${skill.id} ${studiedIds(a, skill.id).length}/${slotsOf(skill.id)})`);
      },
    };
  };

  // Wrapped around whatever handler was there before; a reload unwraps its own previous wrapper first
  const prevRead = typeof mp.onReadBook === 'function' ? ('__dboSpellsInner' in mp.onReadBook ? mp.onReadBook.__dboSpellsInner : mp.onReadBook) : null;
  const readHook = function (actorId, baseId, ...rest) {
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
  const studiedList = (a) => {
    const out = [];
    for (const s of SPELL_SKILLS) for (const id of studiedIds(a, s.id)) out.push({ skill: s, id, sp: classifySpell(id) || { name: descOf(id), school: '?', rank: 0 } });
    return out;
  };
  registerChatCommand('spells', (a) => {
    let n = 0;
    const parts = SPELL_SKILLS.map((s) => {
      const tier = tierOf(a, s.id);
      if (tier < 0) return `${s.label}: not taken up.`;
      const held = studiedIds(a, s.id).map((id) => `${++n}. ${spellLabel(classifySpell(id) || { name: descOf(id), school: '?', rank: 0 })}`);
      return `${s.label} (${TIER_NAMES[tier]}, up to ${RANKS[maxRankFor(s.id, tier)]} spells): ${held.length} of ${slotsOf(s.id)} slots${held.length ? ': ' + held.join(', ') : ''}.`;
    });
    personal(a, parts.join(' '));
    if (n) personal(a, '/forget <number> frees a slot. Spells you knew before study began take no slot.');
  }, { help: 'Your studied spells and free slots' });

  const confirmForget = (a, entry) => menu(a, MENU_ID, `Forget ${entry.sp.name}?`, [
    { id: `forget:${descOf(entry.id)}`, label: `Forget ${entry.sp.name} and free the slot` },
    { id: 'cancel', label: 'Keep it' },
  ], { kind: 'forget' });
  registerChatCommand('forget', (a, args) => {
    const list = studiedList(a);
    if (!list.length) return personal(a, 'You have no studied spells to forget.');
    const n = parseInt(String(Array.isArray(args) ? args[0] : args || '').trim(), 10);
    if (Number.isFinite(n)) {
      if (n < 1 || n > list.length) return personal(a, `Pick a number from 1 to ${list.length}; /spells lists them.`);
      return confirmForget(a, list[n - 1]);
    }
    menu(a, MENU_ID, 'Forget which spell?', list.slice(0, MAX_ROWS).map((e) => ({ id: `pick:${descOf(e.id)}`, label: `${spellLabel(e.sp)} - ${e.skill.label}` })), { kind: 'forget' });
  }, { help: '<number> forget a studied spell to free its slot' });

  const forget = (a, spellId) => {
    const entry = studiedList(a).find((e) => e.id === spellId);
    if (!entry) return personal(a, 'That spell is not among your studied spells.');
    const removed = papyrus(a, 'RemoveSpell', spellId);
    writeStudied(a, entry.skill.id, studiedIds(a, entry.skill.id).filter((id) => id !== spellId));
    personal(a, `You let ${entry.sp.name} fade from memory. ${slotLine(a, entry.skill.id)}.`);
    audit(`SPELL ${who(a)} forgot ${descOf(spellId)} ${entry.sp.name} (${entry.skill.id}, server ${removed ? 'removed it' : 'did not hold it'})`);
  };

  // ---- /teach ----------------------------------------------------------------------------------------
  // Spells this teacher may pass on: school spells the server has learned for them (studied or known before) in skills at teacher tier
  const teachable = (a) => {
    const skills = SPELL_SKILLS.filter((s) => tierOf(a, s.id) >= CFG.teacherMinTier);
    if (!skills.length) return [];
    const ids = new Set(learnedIds(a) || []);
    for (const s of skills) for (const id of studiedIds(a, s.id)) ids.add(id);
    return [...ids].map(classifySpell).filter((sp) => sp && skills.includes(SKILL_OF_SCHOOL[sp.school]));
  };
  const near = (a, b) => distanceMeters(a, b) <= CFG.teachMeters;
  // Why the student cannot take this spell from this teacher now, or null
  const teachRefusal = (teacher, student, sp) => {
    if (!onlineActors().includes(student)) return `${display(student)} is not here.`;
    if (!near(teacher, student)) return `${display(student)} must stand within ${CFG.teachMeters} m.`;
    if (CFG.teachAtStudyPoint && !(studyPointAt(teacher, sp.school) && studyPointAt(student, sp.school))) return 'Teaching happens at a spell study point.';
    const skill = SKILL_OF_SCHOOL[sp.school];
    if (tierOf(teacher, skill.id) < CFG.teacherMinTier) return `Teaching ${sp.school} takes ${skill.label} at ${TIER_NAMES[CFG.teacherMinTier]}.`;
    if (tierOf(student, skill.id) < CFG.studentMinTier) return `${display(student)} needs ${skill.label} at ${TIER_NAMES[CFG.studentMinTier]} or higher to be taught.`;
    if (knows(student, sp.id)) return `${display(student)} already knows ${sp.name}.`;
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
      actions: [{ id: 'accept', label: `Learn it (fills a ${SKILL_OF_SCHOOL[sp.school].label} slot)` }, { id: 'decline', label: 'Decline' }],
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
    if (!papyrus(student, 'AddSpell', sp.id, [false])) { personal(student, `You already know ${sp.name}.`); return; }
    const skill = SKILL_OF_SCHOOL[sp.school];
    writeStudied(student, skill.id, studiedIds(student, skill.id).concat([sp.id]));
    personal(student, `${display(o.teacher)} teaches you ${spellLabel(sp)}. ${slotLine(student, skill.id)}.`);
    personal(o.teacher, `You teach ${display(student)} ${sp.name}.`);
    audit(`SPELL ${who(o.teacher)} taught ${who(student)} ${descOf(sp.id)} ${sp.name} (${skill.id} ${studiedIds(student, skill.id).length}/${slotsOf(skill.id)})`);
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
  const inShop = (a) => SHOP_CELLS.has(norm(get(a, 'worldOrCellDesc', '')));
  const isMember = (a) => { const g = get(a, 'private.dboGuilds', []); return Array.isArray(g) && g.some((m) => m && (CFG.shopFactions || []).includes(String(m.id))); };
  const goldOf = (a) => { const inv = get(a, 'inventory', { entries: [] }); return (Array.isArray(inv.entries) ? inv.entries : []).reduce((n, e) => n + ((Number(e.baseId) >>> 0) === GOLD && !e.worn ? Number(e.count) || 0 : 0), 0); };
  // The lowest tier of the skill whose spell rank reaches this tome, never below shopMinTier
  const tierFor = (skillId, rank) => { for (let t = 0; t < 5; t++) if (maxRankFor(skillId, t) >= rank) return Math.max(t, CFG.shopMinTier); return 4; };
  // Why this tome is out of the buyer's reach, or ''
  const tomeBlock = (a, t) => {
    const skill = SKILL_OF_SCHOOL[t.school];
    const need = tierFor(skill.id, t.rank);
    return tierOf(a, skill.id) >= need ? '' : `Needs ${skill.label} ${TIER_NAMES[need]}`;
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
    const schools = new Set([].concat(...held.map((x) => x.s.vanillaSkills || [])));
    const gold = goldOf(a);
    const whyNot = shopRefusal(a);
    openWidget(a, {
      type: 'tomeShop', id: SHOP_ID, nonce, title: 'The Synod: Spell Tomes', gold,
      canBuy: !whyNot, nextPurchaseAt: nextBuyAt(a), whyNot,
      skills: held.map((x) => ({ id: x.s.id, label: x.s.label, tier: x.tier, tierName: TIER_NAMES[x.tier], schools: (x.s.vanillaSkills || []).slice() })),
      tomes: SHOP.filter((t) => schools.has(t.school)).map((t) => ({
        id: descOf(t.bookId), name: t.title, spell: t.name, school: t.school, rank: t.rank, rankName: RANKS[t.rank],
        price: priceOf(t), canAfford: gold >= priceOf(t), blocked: tomeBlock(a, t),
      })),
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
    if (!t || tierOf(a, SKILL_OF_SCHOOL[t.school].id) < 0) return { ok: false, text: 'The court mage will not sell you that tome.' };
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
    closeMenu(a);
    if (!p || choice === 'cancel') return;
    if (p.kind === 'forget') {
      if (choice.startsWith('pick:')) { const e = studiedList(a).find((x) => x.id === idOf(choice.slice(5))); if (e) confirmForget(a, e); return; }
      if (choice.startsWith('forget:')) return forget(a, idOf(choice.slice(7)));
      return;
    }
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
  onUi('close', (a, args, widgetId) => { if (widgetId === MENU_ID) { pending.delete(a >>> 0); offers.delete(a >>> 0); } if (widgetId === SHOP_ID) shopNonces.delete(a >>> 0); });

  log(`spells ${CFG.enabled ? 'on' : 'off'}: ${TOMES.size} tomes known, ${STUDY_POINTS.length} study point(s), ${SHOP.length} tomes in the Synod shop, slots ${SPELL_SKILLS.map((s) => `${s.id} ${slotsOf(s.id)}`).join(', ')}`);
};
