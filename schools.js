// Schools of magic (Swag's rework, Nate 2026-09-30): four school meters inside Arcane Arts, Study Magic and the Class
// Lectern. Loaded by gamemode.js after spells.js, whose spellbook and spell records it reads through globalThis.
//
// A mage picks a primary school (Destruction, Illusion, Conjuration or Alteration); only it is active and the other three
// are locked. The choice opens at Arcane Arts `firstSchoolAt` (25; Swag's flow, Nate 1 Oct) and gives the school's starter
// spell (`starters`); before it, Study Magic pays Arcane Arts itself and school tomes are refused. At Arcane Arts `secondaryAtLevel` (76) one more may be chosen as the secondary, which starts at
// `secondaryStartLevel` (33, never above the primary), and the rest lock for good. Each school is a meter of levels 0-100
// on the Wheel's own curve (skillPoints.ts: flat early, steep late) and ranks by the spell names: Novice 1, Apprentice 25,
// Adept 50, Expert 75, Master 90. A tome of a school is read only up to that school's rank (spells.js asks
// __dboSchoolsRefusal), and Arcane Arts' own tier still caps every school (spells.js spellRankByTier).
// Restoration is not one of the four: it stays with Priest.
//
// School levels come from:
//   casting a spell of an active school (gamemode.js castHook -> __dboSchoolsCast), repeated spells worth less, with a
//     daily cap per school;
//   Study Magic: a study activator (base editor id `study.edid`, or a ref in `study.refs`) plays a reading idle and pays
//     the primary school every `tickSeconds` while the reader stays put, `minutesPerWindow` minutes per `windowHours`.
//     Studying closes for good once a spell of the four schools is in the spellbook (the engine's own list is no guide:
//     every race starts knowing Flames and Healing);
//   classes at a Class Lectern (base editor id `classes.edid`): a qualified teacher picks one spell they know, which sets
//     the class's school and rank only (nobody learns it); students sign up at the same lectern. It runs `minutes` (30),
//     teacher and students in the classroom (the lectern's interior cell, or `radiusMeters` outdoors); after it the
//     teacher ends it at the lectern and every student still there is paid by `scale[student rank][class rank]`.
//     A teacher gone for `graceMinutes` (5; a disconnect or crash counts) cancels it with nothing paid; a student gone as
//     long drops out. Cooldowns: the teacher `teacherCooldownMinutes` after a class they finished, a student
//     `studentCooldownHours` between paid classes.
//   Priest Studies: a PriestStudy activator (base editor id `priestStudy.edid`, or a ref in `priestStudy.refs`; DLE v10's
//     temples) plays the same reading idle under the same windows and limits, its own window, and pays Priest: no school
//     meter, only the Wheel's cast credit with a Novice Restoration spell every `wheelEverySeconds`. It closes for good
//     once a Restoration spell studied through Priest is in the spellbook, as Study Magic closes at the first school spell.
//   Preach: sermons at a temple pulpit (Nate, 1 Oct), the Class Lectern's rules for Priest. A Preach activator (base editor
//     id `preach.edid`, DLE v9/v10's temple pulpits) opens the same panel (widget 76, titled Sermon). A follower of a Divine
//     at Priest rank `preach.teacherMinRank` picks a Restoration spell they know (it sets the rank; nobody learns it);
//     listeners join at the pulpit, and when the preacher ends it those still in the temple are paid Priest by
//     `preach.scale[listener rank][sermon rank]` through the Wheel's cast credit with that spell. Grace, sign-up window,
//     the full nave and cooldowns as the classes, each with its own record (preachAt, sermonPaidAt).
// Study and classes also feed Arcane Arts itself through masterySystem's own "cast" credit (__alduinakMasteryEvent with a
// spell of the school), so the Wheel's hourly bucket and daily caps hold for them as for any cast.
//
// State, on the character: private.dboSchools
//   { v, primary, secondary, levels: { <school>: { level, xp } }, grandfathered: [spell desc...], study: { log: [[from, to] ms...] },
//     priestStudy: { log: [[from, to] ms...] }, cast: { day, units: {} },
//     ring: [{ h, at }], classAt, paidAt, teacher: { by, at }, preachAt, sermonPaidAt, preacher: { by, at } }
// Classes and sermons live on globalThis and end with the process (a restart cancels one in progress).
'use strict';

module.exports = (api) => {
  const { mp, log, personal, audit, display, who, cfg, openWidget, closeWidget, onUi, registerChatCommand, onlineActors,
    distanceMeters, every, sendPacket, isAdmin, findByName, isWorldspace, profileOf } = api;

  const DEFAULTS = {
    enabled: true,
    requireClient: true,
    schools: ['Destruction', 'Illusion', 'Conjuration', 'Alteration'],
    // Nate, 2026-09-30: Alteration is "both for priest and arcane". 'both': a Priest's path or the school's takes an
    // Alteration spell, and a cast credits Arcane Arts and the school for a mage who chose it, Priest otherwise. 'arcane':
    // the school's path alone. 'priest': Priest's alone, and Alteration is no school here.
    alteration: 'both',
    arcaneSkill: 'arcane',
    secondaryAtLevel: 76,
    secondaryStartLevel: 33,
    // Swag's first spell (Nate, 1 Oct): the primary school is chosen at Arcane Arts `firstSchoolAt`, and the choice gives the
    // school's starter spell into the Arcane Arts book. Before it, Study Magic pays Arcane Arts itself, `firstStudyWeight` of
    // the Wheel's units each `study.wheelEverySeconds`, inside the Wheel's hourly and daily limits. 0: a school at once.
    firstSchoolAt: 25,
    starters: { Destruction: '2b96b:Skyrim.esm', Conjuration: '211eb:Skyrim.esm', Illusion: '4dee8:Skyrim.esm', Alteration: '43324:Skyrim.esm' },
    firstStudyWeight: 3,
    // The client sets its spells back to the list it was sent at character load for its first seconds in the world
    // (skymp5-client remoteServer.ts SPELL_ENFORCE_PASSES, 1 to 20 s, paused by loading screens), so a spell the server
    // adds then is taken off the player's screen while the server keeps it (3-4 Oct: every starter given at login). The
    // starter waits until the character has been seen in the world this long.
    starterSettleSeconds: 90,
    castUnits: 0.5,
    castDailyUnits: 120,
    study: {
      enabled: true, edid: 'StudyMagic', refs: [], tickSeconds: 10, unitsPerTick: 1, minutesPerWindow: 20, windowHours: 4,
      moveLimitMeters: 1.5, anim: 'IdleBook_PageTurn', exitAnim: 'IdleForceDefaultState', wheelEverySeconds: 60, wheelValue: 0,
    },
    priestStudy: {
      enabled: true, edid: 'PriestStudy', refs: [], skill: 'priest', school: 'Restoration', tickSeconds: 10, unitsPerTick: 1, minutesPerWindow: 20,
      windowHours: 4, moveLimitMeters: 1.5, anim: 'IdleBook_PageTurn', exitAnim: 'IdleForceDefaultState', wheelEverySeconds: 60, wheelValue: 0,
    },
    // Sermons at a temple pulpit: the Class Lectern's rules for Priest. A preacher follows a Divine (`teacherFaiths`, the
    // deity kinds of skills.json; there is no temple guild) at Priest rank `teacherMinRank` or above; `requireList` would
    // also need the staff's /preacher list
    preach: {
      enabled: true, edid: 'Preach', refs: [], school: 'Restoration', sameLecternUnits: 300, minutes: 30, joinMinutes: 10, graceMinutes: 5, radiusMeters: 15,
      teacherCooldownMinutes: 60, studentCooldownHours: 12, teacherMinRank: 3, requireList: false, teacherFaiths: ['divine'],
      wheelEvents: 8, wheelValue: 150, maxStudents: 12,
      scale: [
        [1, 0.7, 0, 0, 0],
        [0.35, 1, 0.7, 0, 0],
        [0, 0, 1, 0.7, 0],
        [0, 0, 0, 1, 0.7],
        [0, 0, 0, 0, 1],
      ],
    },
    classes: {
      enabled: true, edid: 'ClassLectern', lecterns: [], sameLecternUnits: 300, minutes: 30, joinMinutes: 10, graceMinutes: 5, radiusMeters: 15,
      teacherCooldownMinutes: 60, studentCooldownHours: 12, teacherMinRank: 3, requireList: true, teacherGuilds: ['synod', 'college-of-winterhold', 'college-of-whispers'],
      units: 60, wheelEvents: 8, wheelValue: 150, maxStudents: 12,
      // [student rank][class rank], ranks Novice..Master. "Reduced" (Apprentice student, Novice class) and "XP" (Expert
      // student, Master class) had no figure in Swag's spec: 0.35 and 0.7 until Nate says otherwise.
      scale: [
        [1, 0.7, 0, 0, 0],
        [0.35, 1, 0.7, 0, 0],
        [0, 0, 1, 0.7, 0],
        [0, 0, 0, 1, 0.7],
        [0, 0, 0, 0, 1],
      ],
    },
    wheel: { enabled: true },
  };
  const raw = cfg.schools || {};
  const C = Object.assign({}, DEFAULTS, raw, {
    study: Object.assign({}, DEFAULTS.study, raw.study || {}),
    priestStudy: Object.assign({}, DEFAULTS.priestStudy, raw.priestStudy || {}),
    preach: Object.assign({}, DEFAULTS.preach, raw.preach || {}),
    classes: Object.assign({}, DEFAULTS.classes, raw.classes || {}),
    wheel: Object.assign({}, DEFAULTS.wheel, raw.wheel || {}),
  });
  const ALTERATION = ['both', 'arcane', 'priest'].includes(String(C.alteration)) ? String(C.alteration) : 'both';
  const SCHOOLS = (Array.isArray(C.schools) ? C.schools : DEFAULTS.schools).map(String).filter((n) => n !== 'Alteration' || ALTERATION !== 'priest');
  const RANKS = ['Novice', 'Apprentice', 'Adept', 'Expert', 'Master'];
  // One line each for the choice, as the colleges of the Fourth Era teach them
  const BLURB = {
    Destruction: 'Fire, frost and shock: magic that does harm.',
    Illusion: 'The minds of others: fear and calm, courage and fury, and silence for oneself.',
    Conjuration: 'Daedra called from Oblivion, weapons bound from nothing, and the dead raised to serve.',
    Alteration: 'The world bent to the will: skin as hard as stone, light from nothing, things moved without a hand.',
  };
  const PROP = 'private.dboSchools';
  const CLASS_PANEL_ID = 72;
  const STUDY_PANEL_ID = 73;
  const PRIEST_PANEL_ID = 75;
  const PREACH_PANEL_ID = 76;
  const MIN = 60000, HOUR = 3600000;

  const get = (id, prop, dflt) => { try { const v = mp.get(id, prop); return v === undefined || v === null ? dflt : v; } catch (e) { return dflt; } };
  const set = (id, prop, v) => { try { mp.set(id, prop, v); return true; } catch (e) { log(`schools: set ${prop} failed`, e.message); return false; } };
  const idOf = (desc) => { try { return mp.getIdFromDesc(String(desc)) >>> 0; } catch (e) { return 0; } };
  const descOf = (id) => { try { return String(mp.getDescFromId(id >>> 0)); } catch (e) { return ''; } };
  const norm = (d) => { const s = String(d || ''); const i = s.indexOf(':'); if (i < 0) return s.toLowerCase(); const n = parseInt(s.slice(0, i), 16); return (Number.isFinite(n) ? n.toString(16) : s.slice(0, i).toLowerCase()) + ':' + s.slice(i + 1).toLowerCase(); };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const inWords = (ms) => { const m = Math.max(1, Math.ceil(ms / MIN)); return m < 90 ? plural(m, 'minute') : plural(Math.round(m / 60), 'hour'); };
  const online = (a) => { try { return onlineActors().includes(a >>> 0); } catch (e) { return false; } };
  const isPlayer = (a) => { try { return profileOf(a) >= 0; } catch (e) { return false; } };
  // A client whose UI cannot draw the meters and panels (it did not report 'schools' in dbo:uiCaps, which spells.js keeps)
  // is left as it was before the schools: no gate, no panels, no meters, so a server switched on ahead of the client pack
  // locks nobody out of their tomes
  const ready = (a) => {
    if (!C.enabled) return false;
    if (!C.requireClient) return true;
    const caps = globalThis.__dboSpellbookCaps;
    const mine = caps instanceof Map ? caps.get(a >>> 0) : null;
    return !!(mine && mine.has('schools'));
  };

  // ---- the Wheel's curve, as skillPoints.ts has it --------------------------------------------------------------
  const XP_BANDS = [[0, 10], [25, 5], [50, 2.5], [75, 1.25], [90, 0.5], [95, 0.25]];
  const xpPerUnitAt = (level) => { let x = XP_BANDS[0][1]; for (const [from, per] of XP_BANDS) if (level >= from) x = per; return x; };
  const addUnits = (level, xp, units) => {
    let lv = Math.max(0, Math.min(100, level)), x = Math.max(0, xp), gained = 0;
    if (units > 0 && lv < 100) {
      x += units * xpPerUnitAt(lv);
      while (x >= 100 && lv < 100) { x -= 100; lv++; gained++; x = x / xpPerUnitAt(lv - 1) * xpPerUnitAt(lv); }
    }
    return { level: lv, xp: lv >= 100 ? 0 : Math.round(x * 100) / 100, gained };
  };
  const FLOORS = [1, 25, 50, 75, 90];
  const rankOfLevel = (level) => { if (!(level >= 1)) return -1; let r = 0; for (let i = 0; i < FLOORS.length; i++) if (level >= FLOORS[i]) r = i; return r; };

  // ---- the record -------------------------------------------------------------------------------------------------
  const arcaneOf = (a) => {
    const r = get(a, 'private.mastery', null);
    const p = r && r.skills && r.skills[C.arcaneSkill];
    return { held: !!(r && Array.isArray(r.order) && r.order.includes(C.arcaneSkill)), level: p ? Math.max(0, Number(p.level) || 0) : 0 };
  };
  const bookOf = (a) => { try { return typeof globalThis.__dboSpellsBook === 'function' ? (globalThis.__dboSpellsBook(a) || []) : []; } catch (e) { return []; } };
  const fresh = () => ({ v: 1, primary: null, secondary: null, grandfathered: [], levels: {}, study: { log: [] }, priestStudy: { log: [] }, cast: { day: '', units: {} }, ring: [], classAt: 0, paidAt: 0, teacher: null });
  // A mage from before the rework keeps what they had: the school most of their studied spells belong to becomes the
  // primary at their Arcane Arts level, and a second school they hold spells of becomes the secondary when the level
  // allows one. Anyone else starts with no school and chooses.
  // Every spell studied before the schools stays the character's whatever its school: always preparable, never refused
  // (nobody loses a spell). Recorded once, at the first read of the record.
  const studiedNow = (a) => bookOf(a).map((sp) => norm(sp.desc || descOf(sp.id))).filter(Boolean);
  const migrate = (a, s) => {
    const arc = arcaneOf(a);
    s.grandfathered = studiedNow(a);
    // Spells of the Arcane Arts book only: a priest's Alteration spells never force a school on them
    const book = bookOf(a).filter((sp) => sp && SCHOOLS.includes(sp.school) && (!sp.book || sp.book === C.arcaneSkill));
    if (!arc.held || !book.length) return s;
    // The school of the most studied spells; a tie goes to the most combined tiers (Novice 1 .. Master 5), then to the
    // school studied most recently (the book keeps the order they were learned in)
    const by = new Map();
    book.forEach((sp, i) => { const e = by.get(sp.school) || { n: 0, tiers: 0, last: -1 }; e.n++; e.tiers += (Number(sp.rank) || 0) + 1; e.last = i; by.set(sp.school, e); });
    const order = [...by.entries()].sort((x, y) => y[1].n - x[1].n || y[1].tiers - x[1].tiers || y[1].last - x[1].last || SCHOOLS.indexOf(x[0]) - SCHOOLS.indexOf(y[0]));
    const why = order.length < 2 ? 'the only school studied'
      : order[0][1].n !== order[1][1].n ? 'the most spells' : order[0][1].tiers !== order[1][1].tiers ? 'a tie broken by the most combined tiers'
        : order[0][1].last !== order[1][1].last ? 'a tie broken by the most recent study' : 'a tie broken by list order';
    log(`schools: ${who(a)} brought over to ${order[0][0]} (${why}): ${order.map(([n, e]) => `${n} ${e.n} spells, tiers ${e.tiers}, last #${e.last}`).join('; ')}`);
    const start = Math.max(1, arc.level);
    s.primary = order[0][0];
    s.levels[s.primary] = { level: start, xp: 0 };
    if (order[1] && arc.level >= C.secondaryAtLevel) {
      s.secondary = order[1][0];
      s.levels[s.secondary] = { level: Math.min(start, Math.max(1, C.secondaryStartLevel)), xp: 0 };
    }
    audit(`SCHOOLS ${who(a)} brought over: primary ${s.primary}${s.secondary ? `, secondary ${s.secondary}` : ''} at Arcane Arts ${arc.level} (${book.length} studied spells, ${why}; ${s.grandfathered.length} kept whatever their school)`);
    return s;
  };
  const stateOf = (a) => {
    const s = get(a, PROP, null);
    if (s && typeof s === 'object' && s.v) {
      const out = Object.assign(fresh(), s);
      // A record from before the grandfathered set keeps what its spellbook held then
      if (!Array.isArray(s.grandfathered)) { out.grandfathered = studiedNow(a); set(a, PROP, out); }
      return out;
    }
    const out = migrate(a, fresh());
    set(a, PROP, out);
    return out;
  };
  const save = (a, s) => set(a, PROP, s);
  const levelOf = (s, school) => { const l = s.levels[school]; return l ? Math.max(0, Number(l.level) || 0) : 0; };
  const roleOf = (s, school) => (s.primary === school ? 'primary' : s.secondary === school ? 'secondary' : 'locked');
  const active = (s, school) => s.primary === school || s.secondary === school;
  const schoolRank = (s, school) => (active(s, school) ? rankOfLevel(levelOf(s, school)) : -1);
  // Adds units to one school; returns levels gained
  const credit = (s, school, units) => {
    const l = s.levels[school] || { level: 0, xp: 0 };
    const out = addUnits(Number(l.level) || 0, Number(l.xp) || 0, units);
    s.levels[school] = { level: out.level, xp: out.xp };
    return out.gained;
  };
  const tellGain = (a, school, before, s) => {
    const now = levelOf(s, school);
    if (now <= before) return;
    const r0 = rankOfLevel(before), r1 = rankOfLevel(now);
    personal(a, r1 > r0 ? `Your study of ${school} rises to ${now}: you are now ${/^[AEIOU]/.test(RANKS[r1]) ? 'an' : 'a'} ${RANKS[r1]} of ${school}.` : `Your study of ${school} rises to ${now}.`);
  };

  // ---- the first spell: the school is chosen at Arcane Arts firstSchoolAt, with its starter (Swag's flow) -----------
  const FIRST_AT = Math.max(0, Number(C.firstSchoolAt) || 0);
  const FIRST_LINE = "You've dedicated yourself to the study of magic and are now finally able to learn your first spell and choose your school.";
  const starterId = (school) => idOf((C.starters || {})[school] || '');
  const starterName = (school) => {
    const id = starterId(school);
    try { const sp = id && typeof globalThis.__dboSpellsClassify === 'function' ? globalThis.__dboSpellsClassify(id) : null; return sp ? String(sp.name) : ''; } catch (e) { return ''; }
  };
  // No school yet, and Arcane Arts short of the first spell
  const beforeFirst = (a, s) => !!FIRST_AT && !s.primary && arcaneOf(a).level < FIRST_AT;
  const notYet = (level) => `Your first spell and your school of magic open at Arcane Arts ${FIRST_AT}; yours is ${level}. Study Magic at a place of learning, or cast what you know, to get there.`;
  // When each online character was last seen arriving (login, or the first check that saw them), kept over a reload
  const SETTLE_MS = Math.max(0, Number(C.starterSettleSeconds) || 0) * 1000;
  const seenAt = globalThis.__dboSchoolsSeenAt instanceof Map ? globalThis.__dboSchoolsSeenAt : (globalThis.__dboSchoolsSeenAt = new Map());
  const seen = (a, arrived) => { if (arrived || !seenAt.has(a >>> 0)) seenAt.set(a >>> 0, Date.now()); };
  const settled = (a) => seenAt.has(a >>> 0) && Date.now() - seenAt.get(a >>> 0) >= SETTLE_MS;
  // The school's starter into the Arcane Arts book, once, for a mage with no spell of the four schools yet; the line to tell.
  // Inside the client's first seconds it waits (''), and firstCheck gives it once they are over.
  const giveStarter = (a, s) => {
    if (!s.primary || s.starter) return '';
    const had = firstSpell(a);
    if (had) { s.starter = 'had'; save(a, s); return ''; }
    if (!settled(a)) return '';
    const id = starterId(s.primary);
    if (!id || typeof globalThis.__dboSpellsGrant !== 'function') return '';
    let r = null;
    try { r = globalThis.__dboSpellsGrant(a, id, C.arcaneSkill); } catch (e) { log('schools: starter failed', e.message); return ''; }
    if (!r) return '';
    s.starter = descOf(id);
    s.starterSent = Date.now();
    save(a, s);
    audit(`SCHOOLS ${who(a)} was given the ${s.primary} starter ${s.starter} ${r.name}`);
    return r.ok ? `You learn ${r.name}. ${r.line}` : '';
  };

  // A starter given before starterSettleSeconds existed went in inside the client's first seconds and was taken off the
  // screen again. It is sent once more, in two checks so the client cannot run the add before the remove: taken back,
  // then given again (a relog, or putting it away and preparing it, did the same by hand).
  const papyrusSpell = (a, fn, id, extra) => { try { return mp.callPapyrusFunction('method', 'Actor', fn, { type: 'form', desc: descOf(a) }, [{ type: 'espm', desc: descOf(id) }].concat(extra || [])) === true; } catch (e) { log(`schools: ${fn} ${descOf(id)} failed`, e.message); return false; } };
  const resendStarter = (a, s) => {
    if (!s.starter || s.starter === 'had' || (s.starterSent && s.starterSent !== 'taken') || !settled(a)) return '';
    const id = idOf(s.starter);
    const sp = id && typeof globalThis.__dboSpellsClassify === 'function' ? globalThis.__dboSpellsClassify(id) : null;
    const prepared = (get(a, 'private.dboPrepared', []) || []).map((d) => norm(d)).includes(norm(s.starter));
    if (!sp || !prepared) { s.starterSent = Date.now(); save(a, s); return ''; }
    if (s.starterSent !== 'taken') { papyrusSpell(a, 'RemoveSpell', id); s.starterSent = 'taken'; save(a, s); return ''; }
    papyrusSpell(a, 'AddSpell', id, [false]);
    s.starterSent = Date.now();
    save(a, s);
    audit(`SCHOOLS ${who(a)} was sent the ${s.primary} starter ${s.starter} ${sp.name} again`);
    return `${sp.name} is ready among your spells.`;
  };

  // ---- the Wheel: Arcane Arts through masterySystem's own cast credit ----------------------------------------------
  // One Novice spell of each school from spell-tomes.json, vanilla first, stands for the school when nothing was cast
  let PRIEST_SPELL = '';
  const SCHOOL_SPELL = (() => {
    const out = {};
    let list = [];
    try { list = (JSON.parse(require('fs').readFileSync(require('path').resolve('spell-tomes.json'), 'utf8')).tomes) || []; } catch (e) { /* no tome list */ }
    const canonToDesc = (c) => { const i = String(c).lastIndexOf(':'); return i < 0 ? '' : `${parseInt(c.slice(i + 1), 16).toString(16)}:${c.slice(0, i)}`; };
    const sorted = list.filter((t) => t && t.spellId && Number(t.rank) === 0).sort((x, y) => (String(x.spellId).startsWith('Skyrim.esm:') ? 0 : 1) - (String(y.spellId).startsWith('Skyrim.esm:') ? 0 : 1));
    for (const t of sorted) if ((SCHOOLS.includes(t.school) || t.school === C.priestStudy.school) && !out[t.school]) out[t.school] = canonToDesc(t.spellId);
    // Restoration is Priest's, never a school: it stands only for Priest Studies' credit
    PRIEST_SPELL = out[C.priestStudy.school] || '';
    if (!SCHOOLS.includes(C.priestStudy.school)) delete out[C.priestStudy.school];
    return out;
  })();
  const wheel = (a, spellId, value, times) => {
    if (!C.wheel.enabled || typeof globalThis.__alduinakMasteryEvent !== 'function' || !spellId) return 0;
    let n = 0;
    for (let i = 0; i < times; i++) { try { globalThis.__alduinakMasteryEvent('cast', a, { spellId: spellId >>> 0, value: Math.max(0, Math.round(value)) }); n++; } catch (e) { break; } }
    return n;
  };

  // ---- choosing schools ------------------------------------------------------------------------------------------
  // { ok, text }
  const choose = (a, school, as) => {
    if (!C.enabled) return { ok: false, text: 'The schools of magic are closed.' };
    if (!SCHOOLS.includes(school)) return { ok: false, text: `${school || 'That'} is not a school you can choose.` };
    const s = stateOf(a);
    if (as === 'primary') {
      if (s.primary) return { ok: false, text: `${s.primary} is already your primary school.` };
      const arc = arcaneOf(a);
      if (FIRST_AT && arc.level < FIRST_AT) return { ok: false, text: notYet(arc.level) };
      if (!arc.held) {
        let took = 'unknown';
        try { took = typeof globalThis.__alduinakMasteryFirstTouch === 'function' ? String(globalThis.__alduinakMasteryFirstTouch(a, C.arcaneSkill)) : 'unknown'; } catch (e) { log('schools: first touch failed', e.message); }
        if (took === 'full') return { ok: false, text: 'Taking up Arcane Arts needs a free skill point. Mark a skill to fall (K) first.' };
        if (took !== 'ok' && took !== 'held') return { ok: false, text: 'Arcane Arts could not be taken up just now. Try again in a moment.' };
      }
      s.primary = school;
      s.levels[school] = { level: Math.max(1, arcaneOf(a).level), xp: 0 };
      save(a, s);
      audit(`SCHOOLS ${who(a)} chose ${school} as their primary school (level ${levelOf(s, school)})`);
      const learned = giveStarter(a, s);
      const soon = !learned && !s.starter && starterName(school) ? `${starterName(school)} comes to you in a moment. ` : '';
      return { ok: true, text: `${school} is your school of magic. ${learned ? learned + ' ' : soon}The other schools are closed to you until your Arcane Arts reaches ${C.secondaryAtLevel}.` };
    }
    if (as === 'secondary') {
      if (!s.primary) return { ok: false, text: 'Choose your primary school first.' };
      if (s.secondary) return { ok: false, text: `${s.secondary} is already your secondary school.` };
      if (school === s.primary) return { ok: false, text: `${school} is your primary school.` };
      const arc = arcaneOf(a);
      if (arc.level < C.secondaryAtLevel) return { ok: false, text: `A secondary school opens at Arcane Arts ${C.secondaryAtLevel}. Yours is ${arc.level}.` };
      s.secondary = school;
      s.levels[school] = { level: Math.min(levelOf(s, s.primary), Math.max(1, C.secondaryStartLevel)), xp: 0 };
      save(a, s);
      audit(`SCHOOLS ${who(a)} chose ${school} as their secondary school (level ${levelOf(s, school)})`);
      return { ok: true, text: `${school} is your secondary school of magic. The remaining schools are closed to you.` };
    }
    return { ok: false, text: 'Choose a school as your primary or your secondary.' };
  };

  // ---- spells.js asks before a tome is read or a spell taught ------------------------------------------------------
  // A spell studied before the schools is never refused, whatever its school
  // Asked for every tome read, so a player the schools do not apply to yet (switched off, or an old client) is answered
  // before their record is read: reading it would bring them over, and fix the kept set, too early
  globalThis.__dboSchoolsGrandfathered = (a, spellId) => { if (!ready(a)) return false; try { return stateOf(a).grandfathered.includes(norm(descOf(spellId >>> 0))); } catch (e) { return false; } };
  // Why `a` cannot take a spell of this school and rank, or null. `whose` is 'You' or the student's name.
  globalThis.__dboSchoolsRefusal = (a, school, rank, whose) => {
    if (!ready(a) || !SCHOOLS.includes(String(school))) return null;
    const s = stateOf(a);
    const you = !whose || whose === 'You';
    if (beforeFirst(a, s)) return you ? notYet(arcaneOf(a).level) : `${whose} has not reached Arcane Arts ${FIRST_AT} yet.`;
    if (!s.primary) return you ? `Choose your school of magic first: open your skills (K) and pick one on the Arcane Arts page, or use Study Magic at a place of learning.` : `${whose} has not chosen a school of magic yet.`;
    if (!active(s, school)) return you ? `${school} is not one of your schools of magic.` : `${school} is not one of ${whose}'s schools of magic.`;
    const r = schoolRank(s, school);
    if (Number(rank) > r) return `${you ? 'Your' : `${whose}'s`} study of ${school} is ${RANKS[Math.max(0, r)]}; ${/^[AEIOU]/.test(RANKS[rank]) ? 'an' : 'a'} ${RANKS[rank]} spell needs more.`;
    return null;
  };

  // ---- Alteration, both Priest's and Arcane Arts' ------------------------------------------------------------------
  // spells.js asks which rule holds for this character: an old client keeps Priest's alone, as before the schools
  globalThis.__dboSchoolsAlteration = (a) => (ready(a) ? ALTERATION : 'priest');
  // masterySystem asks which one skill a player's cast of a school credits (its cast route); undefined keeps skills.json,
  // which gives Alteration to Priest. The study and class credit below goes through the same route.
  globalThis.__dboCastSkill = (actorId, school) => {
    if (school !== 'Alteration' || ALTERATION === 'priest' || !ready(actorId) || !isPlayer(actorId)) return undefined;
    if (ALTERATION === 'arcane') return C.arcaneSkill;
    return active(stateOf(actorId), 'Alteration') ? C.arcaneSkill : undefined;
  };

  // ---- casting -------------------------------------------------------------------------------------------------
  const today = () => new Date(Date.now()).toISOString().slice(0, 10);
  globalThis.__dboSchoolsCast = (casterId, spellId) => {
    if (!ready(casterId) || !isPlayer(casterId)) return;
    let sp = null; try { sp = typeof globalThis.__dboSpellsClassify === 'function' ? globalThis.__dboSpellsClassify(spellId >>> 0) : null; } catch (e) { return; }
    if (!sp || !SCHOOLS.includes(sp.school)) return;
    const s = stateOf(casterId);
    if (!active(s, sp.school)) return;
    if (s.cast.day !== today()) s.cast = { day: today(), units: {} };
    const spent = Number(s.cast.units[sp.school]) || 0;
    if (spent >= C.castDailyUnits) return;
    // The same spell again within the hour is worth less, as the Wheel counts it
    const now = Date.now();
    const ring = (Array.isArray(s.ring) ? s.ring : []).filter((e) => e && now - e.at < HOUR);
    const k = ring.filter((e) => e.h === (spellId >>> 0)).length;
    s.ring = ring.concat([{ h: spellId >>> 0, at: now }]).slice(-16);
    const units = Math.min(C.castDailyUnits - spent, C.castUnits / (1 + k / 8));
    s.cast.units[sp.school] = spent + units;
    const before = levelOf(s, sp.school);
    credit(s, sp.school, units);
    save(casterId, s);
    tellGain(casterId, sp.school, before, s);
  };

  // A panel's nonce names its panel and never repeats: the K menu and the study shelf answer the same school choice, and
  // two opened in one millisecond must not be taken for each other
  const mkNonce = (kind, a) => { const st = globalThis.__dboSchoolsState || (globalThis.__dboSchoolsState = {}); st.seq = (Number(st.seq) || 0) + 1; return `${kind}${(a >>> 0).toString(16)}-${Date.now().toString(36)}-${st.seq.toString(36)}`; };

  // ---- the K menu: school meters on the Arcane Arts page (dboSchoolProgress) ---------------------------------------
  const menuNonces = globalThis.__dboSchoolsMenuNonces instanceof Map ? globalThis.__dboSchoolsMenuNonces : (globalThis.__dboSchoolsMenuNonces = new Map());
  const progressOf = (a) => {
    if (!ready(a)) return null;
    const s = stateOf(a);
    const arc = arcaneOf(a);
    const secondaryOpen = !!s.primary && !s.secondary && arc.level >= C.secondaryAtLevel;
    const early = beforeFirst(a, s);
    const nonce = mkNonce('m', a);
    menuNonces.set(a >>> 0, nonce);
    return {
      skill: C.arcaneSkill,
      title: 'Schools of Magic',
      note: early
        ? notYet(arc.level)
        : !s.primary
        ? 'Choose the school you will give yourself to; it brings you its first spell. The others stay closed until your Arcane Arts reaches ' + C.secondaryAtLevel + '.'
        : secondaryOpen
          ? 'Your Arcane Arts has reached ' + C.secondaryAtLevel + ': you may take up one more school as your secondary.'
          : s.secondary
            ? 'Your two schools are chosen. The others are closed to you.'
            : `A secondary school opens at Arcane Arts ${C.secondaryAtLevel}.`,
      nonce,
      floors: FLOORS.slice(),
      ranks: RANKS.slice(),
      schools: SCHOOLS.map((school) => {
        const role = roleOf(s, school);
        const level = levelOf(s, school);
        const r = rankOfLevel(level);
        const next = r + 1 < FLOORS.length ? FLOORS[r + 1] : 0;
        const pick = early ? '' : !s.primary ? 'primary' : secondaryOpen && role === 'locked' ? 'secondary' : '';
        const first = pick === 'primary' ? starterName(school) : '';
        const l = s.levels[school];
        return {
          name: school, role, level, rank: role === 'locked' ? '' : RANKS[Math.max(0, r)],
          roleLabel: role === 'primary' ? 'Primary school' : role === 'secondary' ? 'Secondary school' : 'Closed',
          // The meter fills bottom to top over the whole ladder, 0..100
          fill: role === 'locked' ? 0 : Math.max(0, Math.min(1, (level + (l ? Number(l.xp) || 0 : 0) / 100) / 100)),
          hint: role === 'locked' ? (pick ? (first ? `Begins with ${first}` : '') : early ? `Opens at Arcane Arts ${FIRST_AT}` : 'Closed to you') : next ? `${RANKS[r + 1]} at ${next}` : 'The top of the school',
          choose: pick ? { as: pick, label: pick === 'primary' ? 'Choose as my school' : 'Choose as secondary', title: `Choose ${school}?`, yes: 'Choose', no: 'Not yet',
            confirm: pick === 'primary' ? `Do you want to choose ${school} as your school of magic?${first ? ` You will learn ${first}, and the` : ' The'} other schools will be closed to you.` : `Do you want to choose ${school} as your secondary school of magic?` } : null,
        };
      }),
      events: { choose: 'dbo:schoolChoose' },
    };
  };
  globalThis.__dboSchoolsProgress = progressOf;
  // The primary school's name ('' before one is chosen), for the journal's mage titles (stateOf migrates an old record the first time, as the K menu would)
  globalThis.__dboSchoolsPrimary = (a) => { try { return ready(a) ? String(stateOf(a).primary || '') : ''; } catch (e) { return ''; } };
  globalThis.__dboSchoolsProgressSend = (a) => {
    let progress = null;
    try { progress = progressOf(a); } catch (e) { log(`schools: progress for ${display(a)} failed: ${e.message}`); }
    sendPacket(a, { customPacketType: 'dboSchoolProgress', progress });
  };
  onUi('schoolChoose', (a, args) => {
    const nonce = String(args[0] || ''), school = String(args[1] || ''), as = String(args[2] || '');
    if (menuNonces.get(a >>> 0) !== nonce && studyNonces.get(a >>> 0) !== nonce) return;
    const r = choose(a, school, as);
    personal(a, r.text);
    globalThis.__dboSchoolsProgressSend(a);
    // Chosen from the Study Magic panel: it goes on to studying, or shows the first spell the choice gave. Opened at login
    // (no shelf), it closes once the school is chosen.
    if (studyNonces.get(a >>> 0) === nonce) {
      const at = studyAt.get(a >>> 0);
      if (at && r.ok && !firstSpell(a)) startStudy(a, at);
      else if (at || !r.ok) openStudy(a, at || 0, r.text, r.ok ? 'ok' : 'refused');
      else { studyNonces.delete(a >>> 0); studyAt.delete(a >>> 0); closeWidget(a, STUDY_PANEL_ID); }
    }
  });

  // ---- study activators and lecterns -------------------------------------------------------------------------------
  // Every activation in the world asks this, so a base's editor id is looked up once per base
  const edidCache = new Map();
  const baseEdidOf = (ref) => {
    let desc = '';
    try { desc = String(mp.get(ref, 'baseDesc') || ''); } catch (e) { return ''; }
    if (!desc) return '';
    if (edidCache.has(desc)) return edidCache.get(desc);
    let edid = '';
    try { const rec = mp.lookupEspmRecordById(mp.getIdFromDesc(desc)); edid = rec && rec.record ? String(rec.record.editorId || '').toLowerCase() : ''; } catch (e) { edid = ''; }
    if (edidCache.size > 5000) edidCache.clear();
    edidCache.set(desc, edid);
    return edid;
  };
  const refSet = (list) => new Set((Array.isArray(list) ? list : []).map((d) => idOf(d)).filter(Boolean));
  const STUDY_REFS = refSet(C.study.refs);
  const LECTERN_REFS = refSet(C.classes.lecterns);
  const isStudy = (ref) => C.study.enabled && (STUDY_REFS.has(ref) || (!!C.study.edid && baseEdidOf(ref) === String(C.study.edid).toLowerCase()));
  const PRIEST_REFS = refSet(C.priestStudy.refs);
  const isPriestStudy = (ref) => C.priestStudy.enabled && (PRIEST_REFS.has(ref) || (!!C.priestStudy.edid && baseEdidOf(ref) === String(C.priestStudy.edid).toLowerCase()));
  const PREACH_REFS = refSet(C.preach.refs);
  const isPreach = (ref) => C.preach.enabled && (PREACH_REFS.has(ref) || (!!C.preach.edid && baseEdidOf(ref) === String(C.preach.edid).toLowerCase()));
  const isLectern = (ref) => C.classes.enabled && (LECTERN_REFS.has(ref) || (!!C.classes.edid && baseEdidOf(ref) === String(C.classes.edid).toLowerCase()));

  // ---- Study Magic ---------------------------------------------------------------------------------------------------
  const S = globalThis.__dboSchoolsState || (globalThis.__dboSchoolsState = {});
  S.studying = S.studying instanceof Map ? S.studying : new Map(); // actor -> { ref, at, pos, cell, lastTick, lastWheel, gained }
  S.classes = S.classes instanceof Map ? S.classes : new Map();   // lectern ref -> class
  const studyNonces = S.studyNonces instanceof Map ? S.studyNonces : (S.studyNonces = new Map());
  const studyAt = S.studyAt instanceof Map ? S.studyAt : (S.studyAt = new Map()); // actor -> the study ref of the open panel
  const anim = (a, ev) => { if (!ev) return; try { mp.callPapyrusFunction('global', 'Debug', 'SendAnimationEvent', null, [{ type: 'form', desc: descOf(a) }, ev]); } catch (e) { log(`schools: ${ev} failed for ${display(a)}: ${e.message}`); } };
  const windowMs = (conf = C.study) => Math.max(1, Number(conf.windowHours) || 4) * HOUR;
  const budgetMs = (conf = C.study) => Math.max(0, Number(conf.minutesPerWindow) || 0) * MIN;
  // The sittings of the last windowHours, as [from, to]; a record from before the rolling window is one sitting
  const studyLog = (s, conf = C.study, key = 'study') => {
    const st = s[key] || {};
    const log = Array.isArray(st.log) ? st.log : (Number(st.usedMs) > 0 ? [[Number(st.windowAt) || 0, (Number(st.windowAt) || 0) + Number(st.usedMs)]] : []);
    return log.filter((x) => Array.isArray(x) && Number(x[1]) > Date.now() - windowMs(conf)).map((x) => [Number(x[0]) || 0, Number(x[1]) || 0]);
  };
  // Study time inside the rolling window that ends at `at`
  const usedAt = (log, at, conf = C.study) => log.reduce((n, [from, to]) => n + Math.max(0, Math.min(to, at) - Math.max(from, at - windowMs(conf))), 0);
  // { usedMs, leftMs, resetsIn }: resetsIn is how long until the window has room for one more tick
  const studyBudget = (s, conf = C.study, key = 'study') => {
    const now = Date.now(), log = studyLog(s, conf, key), used = usedAt(log, now, conf);
    const room = budgetMs(conf) - Math.max(1000, conf.tickSeconds * 1000);
    let resetsIn = 0;
    if (used > room) {
      let lo = 0, hi = windowMs(conf);
      while (hi - lo > 1000) { const mid = (lo + hi) / 2; if (usedAt(log, now + mid, conf) > room) lo = mid; else hi = mid; }
      resetsIn = hi;
    }
    return { usedMs: used, leftMs: Math.max(0, budgetMs(conf) - used), resetsIn };
  };
  // A spell learned through Arcane Arts: a priest's Alteration spells do not close the shelves to a new mage
  const firstSpell = (a) => bookOf(a).find((sp) => sp && SCHOOLS.includes(sp.school) && (!sp.book || sp.book === C.arcaneSkill)) || null;
  // Why `a` cannot study now, or ''
  const studyRefusal = (a, s) => {
    if (!C.enabled || !C.study.enabled) return 'Study is closed.';
    const first = firstSpell(a);
    if (first) return `You have learned ${first.name}; the shelves have nothing more to teach you. Your schools grow now by casting and in class.`;
    const b = studyBudget(s);
    if (b.leftMs <= 0) return `You've done enough studying for the day. Come back in ${inWords(b.resetsIn || windowMs())}.`;
    return '';
  };
  // A panel takes focus only when the player opened it or clicked in it; the server's own refreshes (the study tick, the
  // class tick, another player's sign-up) redraw it in place, so a timer never grabs the mouse, least of all over a vanilla
  // Book or Container menu (Worker E's review, 2026-09-30)
  const openStudy = (a, ref, result, resultKind, focus = true) => {
    const s = stateOf(a);
    // A refresh keeps the panel's nonce, so a click in flight still counts and the panel keeps an open question
    const kept = !focus && studyAt.get(a >>> 0) === ref ? studyNonces.get(a >>> 0) : '';
    const nonce = kept || mkNonce('s', a);
    studyNonces.set(a >>> 0, nonce);
    studyAt.set(a >>> 0, ref);
    const ses = S.studying.get(a >>> 0);
    const b = studyBudget(s);
    const early = beforeFirst(a, s);
    const why = s.primary || early ? studyRefusal(a, s) : '';
    const school = s.primary;
    // Before the first spell the books teach Arcane Arts itself, and the meter fills toward it
    const arc = early ? arcaneOf(a).level : 0;
    openWidget(a, {
      type: 'studyMagic', id: STUDY_PANEL_ID, nonce, title: 'Study Magic',
      mode: !school && !early ? 'choose' : ses ? 'studying' : 'idle',
      school: early ? 'Arcane Arts' : school || '',
      level: early ? arc : school ? levelOf(s, school) : 0,
      rank: early ? `First spell at ${FIRST_AT}` : school ? RANKS[Math.max(0, schoolRank(s, school))] : '',
      fill: early ? Math.max(0, Math.min(1, arc / FIRST_AT)) : school ? Math.max(0, Math.min(1, levelOf(s, school) / 100)) : 0,
      leftSeconds: Math.round(b.leftMs / 1000), tickSeconds: C.study.tickSeconds,
      gained: ses ? Math.round(ses.gained * 10) / 10 : 0,
      whyNot: why,
      choices: !school && !early ? SCHOOLS.map((n) => {
        const first = starterName(n);
        return { name: n, blurb: `${BLURB[n] || ''}${first ? ` You begin with ${first}.` : ''}`, confirm: `Do you want to choose ${n} as your school of magic?${first ? ` You will learn ${first}, and the` : ' The'} other schools will be closed to you.` };
      }) : [],
      result: result || '', resultKind: resultKind || '',
      events: { choose: 'dbo:schoolChoose', start: 'dbo:studyStart', stop: 'dbo:studyStop', close: 'dbo:studyClose' },
    }, focus);
  };
  const posOf = (a) => { try { return mp.get(a, 'pos'); } catch (e) { return null; } };
  // A panel's Study button starts a sitting only within activation reach of its books (6.5 m, as gamemode.js allows)
  const atBooks = (a, ref) => { try { return distanceMeters(a, ref) <= 6.5; } catch (e) { return false; } };
  const startStudy = (a, ref) => {
    const s = stateOf(a);
    const why = studyRefusal(a, s);
    if (why) return openStudy(a, ref, why, 'refused');
    // The first sitting takes Arcane Arts up, as choosing a school did before the first spell came at firstSchoolAt
    if (beforeFirst(a, s) && !arcaneOf(a).held) {
      let took = 'unknown';
      try { took = typeof globalThis.__alduinakMasteryFirstTouch === 'function' ? String(globalThis.__alduinakMasteryFirstTouch(a, C.arcaneSkill)) : 'unknown'; } catch (e) { log('schools: first touch failed', e.message); }
      if (took === 'full') return openStudy(a, ref, 'Taking up Arcane Arts needs a free skill point. Mark a skill to fall (K) first.', 'refused');
      if (took !== 'ok' && took !== 'held') return openStudy(a, ref, 'Arcane Arts could not be taken up just now. Try again in a moment.', 'refused');
    }
    S.studying.set(a >>> 0, { ref, at: Date.now(), pos: posOf(a), cell: String(get(a, 'worldOrCellDesc', '')), lastTick: Date.now(), lastWheel: Date.now(), gained: 0 });
    anim(a, C.study.anim);
    audit(`SCHOOLS ${who(a)} began studying ${s.primary || 'Arcane Arts'} at ${descOf(ref)}`);
    openStudy(a, ref, `You open the books on ${s.primary || 'the magical arts'}.`, 'ok');
  };
  const stopStudy = (a, why) => {
    const ses = S.studying.get(a >>> 0);
    if (!ses) return;
    S.studying.delete(a >>> 0);
    anim(a, C.study.exitAnim);
    const s = stateOf(a);
    s.study = { log: studyLog(s).concat(ses.lastTick > ses.at ? [[ses.at, ses.lastTick]] : []) };
    save(a, s);
    const what = s.primary || 'Arcane Arts';
    audit(`SCHOOLS ${who(a)} stopped studying (${why}): +${Math.round(ses.gained * 10) / 10} units of ${what}`);
    if (why !== 'offline' && why !== 'closed' && why !== 'reached') personal(a, why === 'budget' ? `You've done enough studying for the day. Come back in ${inWords(studyBudget(s).resetsIn || windowMs())}.` : `You close the books.${ses.gained > 0 ? ` Your ${s.primary ? `study of ${what}` : what} stands at ${s.primary ? levelOf(s, s.primary) : arcaneOf(a).level}.` : ''}`);
  };
  // A sitting before the first spell pays Arcane Arts through the Wheel's award, inside its limits; the units it gave
  const studyArcane = (a, ref) => {
    if (typeof globalThis.__alduinakMasteryAward !== 'function') return 0;
    try { return Number(globalThis.__alduinakMasteryAward(a, C.arcaneSkill, Number(C.firstStudyWeight) || 1, ref >>> 0)) || 0; } catch (e) { log('schools: study award failed', e.message); return 0; }
  };
  // The first spell's moment, looked at every few seconds, at login and when a sitting reaches it. A mage who chose a
  // school before this and has no spell of it gets the school's starter once. A mage at firstSchoolAt with no school is
  // told once; at a Study Magic shelf the choice opens there, at login it opens on its own, in the field K has it.
  const firstCheck = (a, why) => {
    if (!ready(a) || !isPlayer(a)) return;
    seen(a, why === 'login');
    const s = stateOf(a);
    if (s.primary) {
      const line = giveStarter(a, s);
      if (line) personal(a, `Your study of ${s.primary} brings you your first spell. ${line}`);
      const again = line ? '' : resendStarter(a, s);
      if (again) personal(a, `Your first spell is back. ${again}`);
      return;
    }
    if (!FIRST_AT || arcaneOf(a).level < FIRST_AT) return;
    const told = !!s.firstOffered;
    if (told && why !== 'login') return;
    if (!told) { s.firstOffered = Date.now(); save(a, s); audit(`SCHOOLS ${who(a)} reached Arcane Arts ${FIRST_AT}: first spell offered (${why})`); }
    const shelf = studyAt.get(a >>> 0);
    if (shelf) { personal(a, FIRST_LINE); return openStudy(a, shelf); }
    if (why === 'login') { personal(a, told ? 'Your first spell and your school of magic wait to be chosen.' : FIRST_LINE); return openStudy(a, 0); }
    personal(a, `${FIRST_LINE} Open your skills (K) to choose on the Arcane Arts page, or go to a Study Magic shelf.`);
  };
  globalThis.__dboSchoolsLogin = (a) => { try { firstCheck(a, 'login'); } catch (e) { log(`schools: login check for ${display(a)} failed: ${e.message}`); } };

  // One study tick for every reader: pays whole ticks only, stops a reader who walked off, left or ran out of time
  const studyTick = () => {
    const now = Date.now();
    for (const [a, ses] of [...S.studying.entries()]) {
      if (!online(a)) { stopStudy(a, 'offline'); continue; }
      const p = posOf(a);
      const moved = !p || !ses.pos || Math.hypot(p[0] - ses.pos[0], p[1] - ses.pos[1], p[2] - ses.pos[2]) / 70 > C.study.moveLimitMeters;
      if (moved || String(get(a, 'worldOrCellDesc', '')) !== ses.cell) { stopStudy(a, 'moved'); closeWidget(a, STUDY_PANEL_ID); continue; }
      const s = stateOf(a);
      const b = studyBudget(s);
      const tickMs = Math.max(1000, C.study.tickSeconds * 1000);
      const ticks = Math.floor((now - ses.lastTick) / tickMs);
      if (ticks <= 0) continue;
      const room = Math.floor(Math.max(0, b.leftMs - (ses.lastTick - ses.at)) / tickMs);
      const paid = Math.min(ticks, room);
      if (paid > 0 && s.primary) {
        const before = levelOf(s, s.primary);
        credit(s, s.primary, paid * C.study.unitsPerTick);
        ses.gained += paid * C.study.unitsPerTick;
        save(a, s);
        tellGain(a, s.primary, before, s);
      }
      ses.lastTick += paid * tickMs;
      if (C.study.wheelEverySeconds > 0 && now - ses.lastWheel >= C.study.wheelEverySeconds * 1000) {
        ses.lastWheel = now;
        if (s.primary) wheel(a, idOf(SCHOOL_SPELL[s.primary] || ''), C.study.wheelValue, 1);
        else ses.gained += studyArcane(a, ses.ref);
      }
      // Arcane Arts has reached the first spell: the books close and the choice opens here
      if (!s.primary && FIRST_AT && arcaneOf(a).level >= FIRST_AT) { stopStudy(a, 'reached'); firstCheck(a, 'study'); continue; }
      if (paid < ticks) { stopStudy(a, 'budget'); closeWidget(a, STUDY_PANEL_ID); continue; }
      if (studyAt.get(a) === ses.ref) openStudy(a, ses.ref, '', '', false);
    }
  };
  onUi('studyStart', (a, args) => {
    if (studyNonces.get(a >>> 0) !== String(args[0] || '')) return;
    const ref = studyAt.get(a >>> 0);
    if (!ref || S.studying.has(a >>> 0)) return;
    if (S.priestStudying.has(a >>> 0)) return openStudy(a, ref, 'You are already at the books of Restoration.', 'refused');
    if (!atBooks(a, ref)) return openStudy(a, ref, 'Stand at the books to study.', 'refused');
    startStudy(a, ref);
  });
  onUi('studyStop', (a, args) => { if (studyNonces.get(a >>> 0) !== String(args[0] || '')) return; stopStudy(a, 'stopped'); const ref = studyAt.get(a >>> 0); if (ref) openStudy(a, ref); });
  onUi('studyClose', (a) => { stopStudy(a, 'closed'); studyNonces.delete(a >>> 0); studyAt.delete(a >>> 0); closeWidget(a, STUDY_PANEL_ID); });
  onUi('close', (a, args, widgetId) => {
    if (widgetId === STUDY_PANEL_ID) { stopStudy(a, 'closed'); studyNonces.delete(a >>> 0); studyAt.delete(a >>> 0); }
    if (widgetId === PRIEST_PANEL_ID) { stopPriest(a, 'closed'); priestNonces.delete(a >>> 0); priestAt.delete(a >>> 0); }
    if (widgetId === CLASS_PANEL_ID) CLASSES.forget(a);
    if (widgetId === PREACH_PANEL_ID) SERMONS.forget(a);
  });
  const openOrStartStudy = (ref, a) => {
    const s = stateOf(a);
    if (!s.primary && !beforeFirst(a, s)) return openStudy(a, ref);
    if (S.studying.has(a >>> 0)) return openStudy(a, ref);
    startStudy(a, ref);
  };
  // One set of books at a time; the new panel opens before the other closes, so the cursor stays (panel handoff)
  const useStudy = (ref, a) => {
    const priestOpen = priestAt.has(a >>> 0);
    stopPriest(a, 'closed');
    openOrStartStudy(ref, a);
    if (priestOpen) { priestNonces.delete(a >>> 0); priestAt.delete(a >>> 0); closeWidget(a, PRIEST_PANEL_ID); }
  };

  // ---- Priest Studies ------------------------------------------------------------------------------------------------
  // Study Magic's sittings, windows and limits under C.priestStudy, paying Priest through the Wheel; the same panel
  const PS = C.priestStudy;
  S.priestStudying = S.priestStudying instanceof Map ? S.priestStudying : new Map(); // actor -> { ref, at, pos, cell, lastTick, lastWheel, gained }
  const priestNonces = S.priestNonces instanceof Map ? S.priestNonces : (S.priestNonces = new Map());
  const priestAt = S.priestAt instanceof Map ? S.priestAt : (S.priestAt = new Map()); // actor -> the study ref of the open panel
  const priestOf = (a) => {
    const r = get(a, 'private.mastery', null);
    const p = r && r.skills && r.skills[PS.skill];
    const held = !!(r && Array.isArray(r.order) && r.order.includes(PS.skill));
    return { held, level: p ? Math.max(0, Number(p.level) || 0) : 0, rank: p ? Math.max(0, Number(p.rank) || 0) : 0 };
  };
  // A Restoration spell studied through Priest: the race's own Healing is no study
  const firstPriestSpell = (a) => bookOf(a).find((sp) => sp && sp.school === PS.school && sp.book === PS.skill) || null;
  const priestRefusal = (a, s) => {
    if (!C.enabled || !PS.enabled) return 'Study is closed.';
    const first = firstPriestSpell(a);
    if (first) return `You have learned ${first.name}; the shelves have nothing more to teach you. Priest grows now by casting and in prayer.`;
    const b = studyBudget(s, PS, 'priestStudy');
    if (b.leftMs <= 0) return `You've done enough studying for the day. Come back in ${inWords(b.resetsIn || windowMs(PS))}.`;
    return '';
  };
  const openPriest = (a, ref, result, resultKind, focus = true) => {
    const s = stateOf(a);
    const kept = !focus && priestAt.get(a >>> 0) === ref ? priestNonces.get(a >>> 0) : '';
    const nonce = kept || mkNonce('p', a);
    priestNonces.set(a >>> 0, nonce);
    priestAt.set(a >>> 0, ref);
    const ses = S.priestStudying.get(a >>> 0);
    const b = studyBudget(s, PS, 'priestStudy');
    const pr = priestOf(a);
    openWidget(a, {
      type: 'studyMagic', id: PRIEST_PANEL_ID, nonce, title: 'Priest Studies',
      mode: ses ? 'studying' : 'idle',
      school: 'Priest', level: pr.level, rank: pr.held ? RANKS[Math.min(RANKS.length - 1, pr.rank)] : 'Not yet taken up',
      fill: Math.max(0, Math.min(1, pr.level / 100)),
      leftSeconds: Math.round(b.leftMs / 1000), tickSeconds: PS.tickSeconds,
      gained: ses ? Math.round(ses.gained * 10) / 10 : 0,
      whyNot: priestRefusal(a, s),
      choices: [],
      result: result || '', resultKind: resultKind || '',
      events: { choose: 'dbo:priestStudyStart', start: 'dbo:priestStudyStart', stop: 'dbo:priestStudyStop', close: 'dbo:priestStudyClose' },
    }, focus);
  };
  const startPriest = (a, ref) => {
    const s = stateOf(a);
    const why = priestRefusal(a, s);
    if (why) return openPriest(a, ref, why, 'refused');
    S.priestStudying.set(a >>> 0, { ref, at: Date.now(), pos: posOf(a), cell: String(get(a, 'worldOrCellDesc', '')), lastTick: Date.now(), lastWheel: Date.now(), gained: 0 });
    anim(a, PS.anim);
    audit(`SCHOOLS ${who(a)} began Priest Studies at ${descOf(ref)}`);
    openPriest(a, ref, `You open the books on ${PS.school}.`, 'ok');
  };
  const stopPriest = (a, why) => {
    const ses = S.priestStudying.get(a >>> 0);
    if (!ses) return;
    S.priestStudying.delete(a >>> 0);
    anim(a, PS.exitAnim);
    const s = stateOf(a);
    s.priestStudy = { log: studyLog(s, PS, 'priestStudy').concat(ses.lastTick > ses.at ? [[ses.at, ses.lastTick]] : []) };
    save(a, s);
    audit(`SCHOOLS ${who(a)} stopped Priest Studies (${why}): ${Math.round(ses.gained * 10) / 10} units`);
    if (why !== 'offline' && why !== 'closed') personal(a, why === 'budget' ? `You've done enough studying for the day. Come back in ${inWords(studyBudget(s, PS, 'priestStudy').resetsIn || windowMs(PS))}.` : 'You close the books.');
  };
  const priestTick = () => {
    const now = Date.now();
    for (const [a, ses] of [...S.priestStudying.entries()]) {
      if (!online(a)) { stopPriest(a, 'offline'); continue; }
      const p = posOf(a);
      const moved = !p || !ses.pos || Math.hypot(p[0] - ses.pos[0], p[1] - ses.pos[1], p[2] - ses.pos[2]) / 70 > PS.moveLimitMeters;
      if (moved || String(get(a, 'worldOrCellDesc', '')) !== ses.cell) { stopPriest(a, 'moved'); closeWidget(a, PRIEST_PANEL_ID); continue; }
      const s = stateOf(a);
      const b = studyBudget(s, PS, 'priestStudy');
      const tickMs = Math.max(1000, PS.tickSeconds * 1000);
      const ticks = Math.floor((now - ses.lastTick) / tickMs);
      if (ticks <= 0) continue;
      const room = Math.floor(Math.max(0, b.leftMs - (ses.lastTick - ses.at)) / tickMs);
      const paid = Math.min(ticks, room);
      ses.gained += paid * PS.unitsPerTick;
      ses.lastTick += paid * tickMs;
      if (paid > 0 && PS.wheelEverySeconds > 0 && now - ses.lastWheel >= PS.wheelEverySeconds * 1000) {
        ses.lastWheel = now;
        wheel(a, idOf(PRIEST_SPELL), PS.wheelValue, 1);
      }
      if (paid < ticks) { stopPriest(a, 'budget'); closeWidget(a, PRIEST_PANEL_ID); continue; }
      if (priestAt.get(a) === ses.ref) openPriest(a, ses.ref, '', '', false);
    }
  };
  const priestNonce = (a, args) => priestNonces.get(a >>> 0) === String(args[0] || '');
  onUi('priestStudyStart', (a, args) => {
    if (!priestNonce(a, args)) return;
    const ref = priestAt.get(a >>> 0);
    if (!ref || S.priestStudying.has(a >>> 0)) return;
    if (S.studying.has(a >>> 0)) return openPriest(a, ref, 'You are already at the books of magic.', 'refused');
    if (!atBooks(a, ref)) return openPriest(a, ref, 'Stand at the books to study.', 'refused');
    startPriest(a, ref);
  });
  onUi('priestStudyStop', (a, args) => { if (!priestNonce(a, args)) return; stopPriest(a, 'stopped'); const ref = priestAt.get(a >>> 0); if (ref) openPriest(a, ref); });
  onUi('priestStudyClose', (a) => { stopPriest(a, 'closed'); priestNonces.delete(a >>> 0); priestAt.delete(a >>> 0); closeWidget(a, PRIEST_PANEL_ID); });
  const usePriest = (ref, a) => {
    const studyOpen = studyAt.has(a >>> 0);
    stopStudy(a, 'closed');
    if (S.priestStudying.has(a >>> 0)) openPriest(a, ref);
    else startPriest(a, ref);
    if (studyOpen) { studyNonces.delete(a >>> 0); studyAt.delete(a >>> 0); closeWidget(a, STUDY_PANEL_ID); }
  };
  // DLE v10 brings the activator; until a ref of it is used, this is never reached. Said once per process when it is.
  const notePriestStudy = (ref) => {
    if (S.priestStudySeen) return;
    S.priestStudySeen = true;
    log(`schools: Priest Studies found its first ${PS.edid} activator (${descOf(ref)})`);
  };

  // ---- lecterns: the Class Lectern and the Preach pulpit share one engine ----------------------------------------------
  const guildsOf = (a) => { const g = get(a, 'private.dboGuilds', []); return Array.isArray(g) ? g.map((m) => String(m && m.id)) : []; };
  const knownSpells = (a) => { try { return typeof globalThis.__dboSpellsKnown === 'function' ? (globalThis.__dboSpellsKnown(a) || []) : []; } catch (e) { return []; } };
  const faithOf = (a) => { const f = get(a, 'private.dboDeity', null); return f && typeof f === 'object' && f.id ? f : null; };
  const priestRank = (a) => { const p = priestOf(a); return p.held && p.level >= 1 ? p.rank : -1; };
  // K: one kind of lectern. conf, refs, the state maps' keys, the record keys for its cooldowns and named list, the
  // teacher's own rule, the spells it is set by, the listener's rank, the pay, and its words (W)
  const makeLectern = (K) => {
    const conf = K.conf, W = K.words;
    const runs = S[K.runsKey] instanceof Map ? S[K.runsKey] : (S[K.runsKey] = new Map()); // pulpit/lectern ref -> session
    const open = S[K.openKey] instanceof Map ? S[K.openKey] : (S[K.openKey] = new Map()); // actor -> { ref, nonce }
    const listed = (a) => { const t = stateOf(a)[K.listKey]; return !!(t && t.at); };
    const teacherRefusal = (a) => {
      if (!C.enabled || !conf.enabled) return W.closed;
      if (conf.requireList && !listed(a)) return W.notListed;
      const qual = K.qualified(a);
      if (qual) return qual;
      const next = (Number(stateOf(a)[K.teacherAtKey]) || 0) + conf.teacherCooldownMinutes * MIN;
      if (next > Date.now()) return W.teacherCooldown(inWords(next - Date.now()));
      return '';
    };
    const scaleFor = (studentRank, classRank) => {
      const row = (conf.scale || [])[studentRank];
      const v = Array.isArray(row) ? Number(row[classRank]) : 0;
      return Number.isFinite(v) && v > 0 ? v : 0;
    };
    // Where it is held: the lectern's interior cell, or `radiusMeters` around it outdoors
    const inRoom = (k, a) => {
      if (!online(a)) return false;
      const cell = String(get(a, 'worldOrCellDesc', ''));
      if (norm(cell) !== norm(k.cell)) return false;
      let world = false; try { world = typeof isWorldspace === 'function' ? isWorldspace(k.cell) : false; } catch (e) { world = false; }
      return !world || distanceMeters(a, k.ref) <= conf.radiusMeters;
    };
    // Nate's lecterns carry two activator boxes each (DLE v7: 15e4bb/15e4bc at the Synod, 16 units apart). Boxes within
    // sameLecternUnits of each other in one cell are one lectern: one session, and the status on every box's crosshair.
    const nearRef = (x, y) => {
      if (x === y) return true;
      if (norm(get(x, 'worldOrCellDesc', '')) !== norm(get(y, 'worldOrCellDesc', ''))) return false;
      const p = get(x, 'pos', null), q = get(y, 'pos', null);
      return !!(p && q) && Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) <= conf.sameLecternUnits;
    };
    const siblingsOf = (ref) => [ref >>> 0].concat([...K.refs].filter((r) => r !== (ref >>> 0) && nearRef(ref >>> 0, r)));
    const runOf = (ref) => {
      ref >>>= 0;
      const exact = runs.get(ref);
      if (exact) return exact;
      for (const k of runs.values()) {
        if ((k.refs || []).includes(ref)) return k;
        if (nearRef(ref, k.ref)) { k.refs = (k.refs || [k.ref]).concat([ref]); return k; }
      }
      return null;
    };
    const studentRefusal = (k, a) => {
      if (a === k.teacher) return W.youTeach;
      if (k.students.has(a)) return '';
      if (Date.now() - k.startedAt > conf.joinMinutes * MIN) return W.joinClosed(conf.joinMinutes);
      if (k.students.size >= conf.maxStudents) return W.full;
      const not = K.cannotLearn(a, k);
      if (not) return not;
      const f = scaleFor(K.studentRank(a, k), k.spell.rank);
      if (f <= 0) return W.nothing(k);
      const next = (Number(stateOf(a)[K.paidAtKey]) || 0) + conf.studentCooldownHours * HOUR;
      if (next > Date.now()) return W.studentCooldown(inWords(next - Date.now()));
      return '';
    };
    const nameOf = (k) => (k ? (Date.now() >= k.endsAt ? W.decorEnded : W.decorRunning(inWords(k.endsAt - Date.now()))) : null);
    // The session's status on the crosshair of every box of its lectern, for everyone in its cell; null hands the name back
    const decorate = (k, over) => {
      const name = over ? null : nameOf(k);
      const refs = (k.refs || [k.ref]).map((r) => ({ refId: r >>> 0, name, locked: false }));
      for (const a of onlineActors()) {
        if (norm(get(a, 'worldOrCellDesc', '')) !== norm(k.cell)) continue;
        try { sendPacket(a, { customPacketType: 'refDecor', refs }); } catch (e) { /* offline */ }
      }
    };
    const openPanel = (a, ref, result, resultKind, focus = true) => {
      const was = open.get(a >>> 0);
      const nonce = (!focus && was && was.ref === ref && was.nonce) || mkNonce(K.nonceKind, a);
      open.set(a >>> 0, { ref, nonce });
      const k = runOf(ref);
      const ev = K.events;
      const base = Object.assign({ type: 'classLectern', id: K.panelId, nonce, title: W.title, result: result || '', resultKind: resultKind || '',
        events: { start: `dbo:${ev}Start`, join: `dbo:${ev}Join`, leave: `dbo:${ev}Leave`, end: `dbo:${ev}End`, cancel: `dbo:${ev}Cancel`, close: `dbo:${ev}Close` } }, W.panel ? { words: W.panel } : {});
      if (!k) {
        const why = teacherRefusal(a);
        const spells = why ? [] : K.spellsOf(a);
        return openWidget(a, Object.assign(base, {
          mode: 'idle',
          status: W.idleStatus,
          canTeach: !why && spells.length > 0,
          whyNot: why || (spells.length ? '' : W.noSpells),
          minutes: conf.minutes,
          spells: spells.map((sp) => ({ id: sp.desc || descOf(sp.id), name: sp.name, school: sp.school, rank: sp.rank, rankName: RANKS[sp.rank] })),
        }), focus);
      }
      const mine = a === k.teacher;
      const signed = k.students.has(a);
      const f = mine ? 0 : scaleFor(K.studentRank(a, k), k.spell.rank);
      const why = mine || signed ? '' : studentRefusal(k, a);
      openWidget(a, Object.assign(base, {
        mode: 'running',
        status: Date.now() >= k.endsAt ? W.runCourse : W.inProgress,
        teacher: k.teacherName, spell: k.spell.name, school: k.spell.school, rankName: RANKS[k.spell.rank],
        endsInMs: Math.max(0, k.endsAt - Date.now()), minutes: conf.minutes,
        teacherAway: k.teacherAwaySince ? Math.max(0, k.teacherAwaySince + conf.graceMinutes * MIN - Date.now()) : 0,
        students: [...k.students.keys()].map((st) => ({ name: display(st), away: !!k.students.get(st).awaySince })),
        role: mine ? 'teacher' : signed ? 'student' : 'visitor',
        gain: mine ? '' : W.gain(k, W.gainWords(f)),
        canJoin: !mine && !signed && !why, whyNot: why,
        canEnd: mine && Date.now() >= k.endsAt,
      }), focus);
    };
    // Everyone else looking at this lectern; `except` is the player whose click just redrew their own panel
    const refresh = (k, except) => { for (const [a, o] of open) if (a !== except && (k.refs || [k.ref]).includes(o.ref) && online(a)) openPanel(a, o.ref, '', '', false); };
    const end = (k, paid) => {
      runs.delete(k.ref);
      decorate(k, true);
      const t = stateOf(k.teacher);
      if (paid) { t[K.teacherAtKey] = Date.now(); save(k.teacher, t); }
      const got = [];
      for (const [st, e] of k.students) {
        if (!paid) { if (online(st)) personal(st, W.cancelledToStudent(k)); continue; }
        if (e.awaySince || !inRoom(k, st)) { if (online(st)) personal(st, W.notThere); continue; }
        const s = stateOf(st);
        const f = scaleFor(K.studentRank(st, k), k.spell.rank);
        if (f <= 0 || K.cannotLearn(st, k)) continue;
        // Checked again at payout: sign-ups for two at once would otherwise both pay
        if ((Number(s[K.paidAtKey]) || 0) + conf.studentCooldownHours * HOUR > Date.now()) { if (online(st)) personal(st, W.paidTooRecently); continue; }
        got.push(K.pay(st, s, k, f));
      }
      audit(`SCHOOLS ${W.auditNoun} by ${who(k.teacher)} on ${k.spell.name} (${k.spell.school} ${RANKS[k.spell.rank]}) at ${descOf(k.ref)} ${paid ? `ended: ${got.join(', ') || 'nobody paid'}` : 'cancelled'}`);
      for (const [a, o] of [...open]) if ((k.refs || [k.ref]).includes(o.ref) && online(a)) openPanel(a, o.ref, paid ? W.over : W.cancelled, paid ? 'ok' : 'refused', false);
    };
    const start = (a, ref, spellDesc) => {
      if (runOf(ref)) return { ok: false, text: W.alreadyHere };
      for (const k of runs.values()) if (k.teacher === a) return { ok: false, text: W.alreadyTeaching };
      const why = teacherRefusal(a);
      if (why) return { ok: false, text: why };
      const sp = K.spellsOf(a).find((x) => norm(x.desc || descOf(x.id)) === norm(spellDesc));
      if (!sp) return { ok: false, text: W.badSpell };
      const now = Date.now();
      const k = { ref: ref >>> 0, refs: siblingsOf(ref), teacher: a >>> 0, teacherName: display(a), spell: { id: sp.id >>> 0, desc: sp.desc || descOf(sp.id), name: sp.name, school: sp.school, rank: Number(sp.rank) || 0 },
        cell: String(get(ref, 'worldOrCellDesc', '') || get(a, 'worldOrCellDesc', '')), startedAt: now, endsAt: now + conf.minutes * MIN, students: new Map(), teacherAwaySince: 0 };
      runs.set(k.ref, k);
      decorate(k);
      audit(`SCHOOLS ${who(a)} ${W.auditOpened} on ${sp.name} (${sp.school} ${RANKS[k.spell.rank]}) at ${descOf(ref)}`);
      return { ok: true, text: W.begun(sp.name, conf.joinMinutes, conf.minutes) };
    };
    const tick = () => {
      const now = Date.now();
      for (const k of [...runs.values()]) {
        if (inRoom(k, k.teacher)) k.teacherAwaySince = 0;
        else if (!k.teacherAwaySince) {
          k.teacherAwaySince = now;
          for (const st of k.students.keys()) if (online(st)) personal(st, W.teacherLeftToStudents(k.teacherName, conf.graceMinutes));
          if (online(k.teacher)) personal(k.teacher, W.teacherLeft(conf.graceMinutes));
        } else if (now - k.teacherAwaySince >= conf.graceMinutes * MIN) { end(k, false); continue; }
        for (const [st, e] of [...k.students]) {
          if (inRoom(k, st)) { e.awaySince = 0; continue; }
          if (!e.awaySince) { e.awaySince = now; if (online(st)) personal(st, W.studentLeft(conf.graceMinutes)); }
          else if (now - e.awaySince >= conf.graceMinutes * MIN) { k.students.delete(st); if (online(st)) personal(st, W.droppedOut); }
        }
        if (!k.readyTold && now >= k.endsAt) { k.readyTold = true; if (online(k.teacher)) personal(k.teacher, W.runItsCourse); }
        decorate(k);
        refresh(k);
      }
    };
    const refOf = (a, args) => { const o = open.get(a >>> 0); return o && o.nonce === String(args[0] || '') ? o.ref : 0; };
    const ev = K.events;
    onUi(`${ev}Start`, (a, args) => { const ref = refOf(a, args); if (!ref) return; const r = start(a, ref, String(args[1] || '')); openPanel(a, ref, r.text, r.ok ? 'ok' : 'refused'); });
    onUi(`${ev}Join`, (a, args) => {
      const ref = refOf(a, args); if (!ref) return;
      const k = runOf(ref);
      if (!k) return openPanel(a, ref, W.over, 'refused');
      const why = studentRefusal(k, a);
      if (why) return openPanel(a, ref, why, 'refused');
      if (!inRoom(k, a)) return openPanel(a, ref, W.stepIn, 'refused');
      k.students.set(a >>> 0, { joinedAt: Date.now(), awaySince: 0 });
      audit(`SCHOOLS ${who(a)} ${W.auditJoined} ${who(k.teacher)}'s ${W.auditNoun} on ${k.spell.name}`);
      if (online(k.teacher)) personal(k.teacher, W.joinedToTeacher(display(a)));
      openPanel(a, ref, W.joined(k.teacherName), 'ok');
      refresh(k, a >>> 0);
    });
    onUi(`${ev}Leave`, (a, args) => {
      const ref = refOf(a, args); if (!ref) return;
      const k = runOf(ref);
      if (k && k.students.delete(a >>> 0)) { audit(`SCHOOLS ${who(a)} left ${who(k.teacher)}'s ${W.auditNoun}`); openPanel(a, ref, W.left, 'ok'); refresh(k, a >>> 0); }
    });
    onUi(`${ev}End`, (a, args) => {
      const ref = refOf(a, args); if (!ref) return;
      const k = runOf(ref);
      if (!k || k.teacher !== (a >>> 0)) return openPanel(a, ref);
      if (Date.now() < k.endsAt) return openPanel(a, ref, W.runsAnother(inWords(k.endsAt - Date.now())), 'refused');
      end(k, true);
    });
    onUi(`${ev}Cancel`, (a, args) => {
      const ref = refOf(a, args); if (!ref) return;
      const k = runOf(ref);
      if (!k || k.teacher !== (a >>> 0)) return openPanel(a, ref);
      end(k, false);
    });
    onUi(`${ev}Close`, (a) => { open.delete(a >>> 0); closeWidget(a, K.panelId); });
    return { open: openPanel, tick, listed, forget: (a) => open.delete(a >>> 0), runs };
  };

  const classWords = {
    title: 'Class Lectern', closed: 'Classes are not held just now.', notListed: 'Only teachers the Synod has named may hold a class. Ask the staff.',
    teacherCooldown: (w) => `You taught a class not long ago. You may hold the next in ${w}.`,
    idleStatus: 'No class is being held here.', noSpells: 'You know no spell of your schools to set a class by.',
    inProgress: 'Class in Progress', runCourse: 'The class has run its course.',
    gainWords: (f) => (f >= 1 ? 'the full lesson' : f > 0 ? `${Math.round(f * 100)}% of the lesson` : 'nothing at your level'),
    gain: (k, g) => `At your study of ${k.spell.school} you would take ${g}.`,
    youTeach: 'You are teaching this class.', joinClosed: (m) => `Sign-ups closed ${m} minutes into the class.`, full: 'The class is full.',
    nothing: (k) => `At your study of ${k.spell.school} this class would teach you nothing.`,
    studentCooldown: (w) => `You sat a class not long ago. You may learn in another in ${w}.`,
    decorEnded: 'Class Lectern: the class may be ended', decorRunning: (w) => `Class Lectern: Class in Progress, ${w} left`,
    cancelledToStudent: (k) => `The ${k.spell.school} class was cancelled. Nobody is paid for it.`,
    notThere: 'You were not in the classroom when the class ended.', paidTooRecently: 'You were paid for another class too recently to be paid for this one.',
    auditNoun: 'class', auditOpened: 'opened a class', auditJoined: 'signed up for', over: 'The class is over.', cancelled: 'The class was cancelled.',
    alreadyHere: 'A class is already held at this lectern.', alreadyTeaching: 'You are already teaching a class.', badSpell: 'You cannot set a class by that spell.',
    begun: (name, join, minutes) => `Your class on ${name} has begun. Students sign up at this lectern for the first ${join} minutes; after ${minutes} minutes, end it here.`,
    teacherLeftToStudents: (t, g) => `${t} has left the classroom. If they are not back within ${g} minutes, the class is cancelled.`,
    teacherLeft: (g) => `You have left your classroom. Come back within ${g} minutes or the class is cancelled.`,
    studentLeft: (g) => `You have left the classroom. Come back within ${g} minutes to stay in the class.`,
    droppedOut: 'You were away too long and have dropped out of the class.',
    runItsCourse: 'Your class has run its course. End it at the lectern to mark the lesson.',
    stepIn: 'Step into the classroom to sign up.', joinedToTeacher: (n) => `${n} has signed up for your class.`,
    joined: (t) => `You have signed up. Stay in the classroom until ${t} ends the class.`, left: 'You have left the class.',
    runsAnother: (w) => `The class runs another ${w}.`,
  };
  const CLASSES = makeLectern({
    conf: C.classes, refs: LECTERN_REFS, runsKey: 'classes', openKey: 'lecternOpen', listKey: 'teacher', teacherAtKey: 'classAt', paidAtKey: 'paidAt',
    panelId: CLASS_PANEL_ID, events: 'lectern', nonceKind: 'l', words: classWords,
    qualified: (a) => {
      const guilds = Array.isArray(C.classes.teacherGuilds) ? C.classes.teacherGuilds : [];
      if (guilds.length && !guildsOf(a).some((g) => guilds.includes(g))) return 'A class is held by a member of the Synod or a College.';
      const s = stateOf(a);
      if (!SCHOOLS.some((n) => schoolRank(s, n) >= C.classes.teacherMinRank)) return `Teaching a class takes ${RANKS[C.classes.teacherMinRank]} study in one of your schools.`;
      return '';
    },
    // Spells `a` may set a class by: known, of a school where they are qualified, no higher than their study of it
    spellsOf: (a) => {
      const s = stateOf(a);
      const seen = new Set();
      return knownSpells(a).filter((sp) => {
        if (!sp || !SCHOOLS.includes(sp.school) || seen.has(sp.id)) return false;
        seen.add(sp.id);
        const r = schoolRank(s, sp.school);
        return r >= C.classes.teacherMinRank && Number(sp.rank) <= r;
      }).sort((x, y) => SCHOOLS.indexOf(x.school) - SCHOOLS.indexOf(y.school) || x.rank - y.rank || String(x.name).localeCompare(String(y.name)));
    },
    studentRank: (a, k) => schoolRank(stateOf(a), k.spell.school),
    cannotLearn: (a, k) => (active(stateOf(a), k.spell.school) ? '' : `${k.spell.school} is not one of your schools of magic.`),
    pay: (st, s, k, f) => {
      const before = levelOf(s, k.spell.school);
      credit(s, k.spell.school, C.classes.units * f);
      s.paidAt = Date.now();
      save(st, s);
      const w = wheel(st, idOf(k.spell.desc), C.classes.wheelValue, Math.max(1, Math.round(C.classes.wheelEvents * f)));
      personal(st, `${display(k.teacher)}'s class on ${k.spell.name} is over. You took ${classWords.gainWords(f)}: your study of ${k.spell.school} stands at ${levelOf(s, k.spell.school)}.`);
      tellGain(st, k.spell.school, before, s);
      return `${who(st)} x${f} (${before}->${levelOf(s, k.spell.school)}, wheel ${w})`;
    },
  });
  const listed = CLASSES.listed;

  // ---- Preach: sermons at a temple pulpit, the Class Lectern's rules for Priest (Nate, 1 Oct) --------------------------
  // A follower of a Divine at Priest rank teacherMinRank or above gives a sermon on a Restoration spell they know (it sets
  // the rank; nobody learns it). Listeners join at the same pulpit and are paid Priest by scale[listener rank][sermon rank]
  // through the Wheel's cast credit with the sermon's spell, the route Priest Studies takes. Someone who has not taken
  // Priest up listens at Novice, and the credit banks toward the offer.
  const P = C.preach;
  const sermonWords = {
    title: 'Sermon', closed: 'No sermons are given just now.', notListed: 'Only priests the temple has named may preach. Ask the staff.',
    teacherCooldown: (w) => `You preached not long ago. You may give the next sermon in ${w}.`,
    idleStatus: 'No sermon is being given here.', noSpells: 'You know no Restoration spell to preach on.',
    inProgress: 'Sermon in Progress', runCourse: 'The sermon has run its course.',
    gainWords: (f) => (f >= 1 ? 'the full sermon' : f > 0 ? `${Math.round(f * 100)}% of the sermon` : 'nothing at your level'),
    gain: (k, g) => `At your rank in Priest you would take ${g}.`,
    youTeach: 'You are giving this sermon.', joinClosed: (m) => `Listeners could join for the first ${m} minutes of the sermon.`, full: 'The nave is full.',
    nothing: () => 'At your rank in Priest this sermon would teach you nothing.',
    studentCooldown: (w) => `You heard a sermon not long ago. You may learn from another in ${w}.`,
    decorEnded: 'Pulpit: the sermon may be ended', decorRunning: (w) => `Pulpit: Sermon in Progress, ${w} left`,
    cancelledToStudent: (k) => `The sermon on ${k.spell.name} was cancelled. Nobody is paid for it.`,
    notThere: 'You were not in the temple when the sermon ended.', paidTooRecently: 'You were paid for another sermon too recently to be paid for this one.',
    auditNoun: 'sermon', auditOpened: 'began a sermon', auditJoined: 'joined', over: 'The sermon is over.', cancelled: 'The sermon was cancelled.',
    alreadyHere: 'A sermon is already being given at this pulpit.', alreadyTeaching: 'You are already preaching.', badSpell: 'You cannot preach on that spell.',
    begun: (name, join, minutes) => `Your sermon on ${name} has begun. Listeners join at this pulpit for the first ${join} minutes; after ${minutes} minutes, end it here.`,
    teacherLeftToStudents: (t, g) => `${t} has left the temple. If they are not back within ${g} minutes, the sermon is cancelled.`,
    teacherLeft: (g) => `You have left your temple. Come back within ${g} minutes or the sermon is cancelled.`,
    studentLeft: (g) => `You have left the temple. Come back within ${g} minutes to stay for the sermon.`,
    droppedOut: 'You were away too long and have left the sermon.',
    runItsCourse: 'Your sermon has run its course. End it at the pulpit to close it.',
    stepIn: 'Step into the temple to join.', joinedToTeacher: (n) => `${n} has joined your sermon.`,
    joined: (t) => `You have joined. Stay in the temple until ${t} ends the sermon.`, left: 'You have left the sermon.',
    runsAnother: (w) => `The sermon runs another ${w}.`,
    // The panel's own lines; a client from before them keeps the Class Lectern's
    panel: {
      lead: `Choose the Restoration spell your sermon is on. It decides the rank; your listeners do not learn it. The sermon runs ${P.minutes} minutes.`,
      teacher: 'Priest', lesson: 'Sermon', students: 'Listeners', none: 'None yet',
      teacherAway: 'The priest has left the temple. The sermon is cancelled in {clock} unless they return.',
      begin: 'Begin the sermon', join: 'Join', leave: 'Leave the sermon', end: 'End Sermon', cancel: 'Cancel the sermon',
      cancelTitle: 'Cancel the sermon?', cancelText: 'Nobody is paid for a cancelled sermon.', cancelYes: 'Cancel it', cancelNo: 'Keep preaching',
    },
  };
  const SERMONS = makeLectern({
    conf: P, refs: PREACH_REFS, runsKey: 'sermons', openKey: 'preachOpen', listKey: 'preacher', teacherAtKey: 'preachAt', paidAtKey: 'sermonPaidAt',
    panelId: PREACH_PANEL_ID, events: 'preach', nonceKind: 'r', words: sermonWords,
    qualified: (a) => {
      const kinds = Array.isArray(P.teacherFaiths) ? P.teacherFaiths : [];
      const faith = faithOf(a);
      if (kinds.length && !(faith && kinds.includes(String(faith.kind)))) return 'A sermon is given by a follower of the Divines.';
      if (priestRank(a) < P.teacherMinRank) return `Preaching takes ${RANKS[P.teacherMinRank]} rank in Priest.`;
      return '';
    },
    // Restoration spells `a` knows, no higher than their Priest rank
    spellsOf: (a) => {
      const r = priestRank(a);
      if (r < P.teacherMinRank) return [];
      const seen = new Set();
      return knownSpells(a).filter((sp) => {
        if (!sp || sp.school !== P.school || seen.has(sp.id)) return false;
        seen.add(sp.id);
        return Number(sp.rank) <= r;
      }).sort((x, y) => x.rank - y.rank || String(x.name).localeCompare(String(y.name)));
    },
    studentRank: (a) => Math.max(0, priestRank(a)),
    cannotLearn: () => '',
    pay: (st, s, k, f) => {
      s.sermonPaidAt = Date.now();
      save(st, s);
      const w = wheel(st, idOf(k.spell.desc), P.wheelValue, Math.max(1, Math.round(P.wheelEvents * f)));
      personal(st, `${display(k.teacher)}'s sermon on ${k.spell.name} is over. You took ${sermonWords.gainWords(f)}; it counts toward Priest.`);
      return `${who(st)} x${f} (wheel ${w})`;
    },
  });

  // gamemode.js onActivate: true when the ref is a study activator or a Class Lectern (the use is handled here)
  globalThis.__dboSchoolsActivate = (targetId, casterId) => {
    if (!ready(casterId) || !isPlayer(casterId)) return false;
    if (isLectern(targetId)) { CLASSES.open(casterId, targetId >>> 0); return true; }
    if (isStudy(targetId)) { useStudy(targetId >>> 0, casterId >>> 0); return true; }
    if (isPriestStudy(targetId)) { notePriestStudy(targetId >>> 0); usePriest(targetId >>> 0, casterId >>> 0); return true; }
    if (isPreach(targetId)) { SERMONS.open(casterId, targetId >>> 0); return true; }
    return false;
  };
  // A player who logs out or changes cell mid-study stops; one who disconnects mid-class is caught by the class tick
  every('schools.tick', 2000, () => {
    try { studyTick(); } catch (e) { log('schools: study tick failed', e.stack || e.message); }
    try { priestTick(); } catch (e) { log('schools: Priest Studies tick failed', e.stack || e.message); }
  });
  // The first spell's moment for everyone online (firstCheck): Arcane Arts reached in the field, or a school with no spell
  every('schools.first', 10000, () => {
    const on = new Set(onlineActors().map((x) => x >>> 0));
    for (const a of [...seenAt.keys()]) if (!on.has(a)) seenAt.delete(a);
    for (const a of onlineActors()) { try { firstCheck(a, 'tick'); } catch (e) { log(`schools: first check for ${display(a)} failed: ${e.message}`); } }
  });
  every('schools.classes', 10000, () => {
    try { CLASSES.tick(); } catch (e) { log('schools: class tick failed', e.stack || e.message); }
    try { SERMONS.tick(); } catch (e) { log('schools: sermon tick failed', e.stack || e.message); }
  });

  // ---- staff ---------------------------------------------------------------------------------------------------------
  const argList = (args) => (Array.isArray(args) ? args.map(String) : String(args || '').trim().split(/\s+/)).filter(Boolean);
  registerChatCommand('classteacher', (a, args) => {
    const [verb, ...rest] = argList(args);
    if (!verb || !['add', 'remove', 'list'].includes(verb.toLowerCase())) return personal(a, 'Usage: /classteacher add|remove <player>, or /classteacher list (players online).');
    if (verb.toLowerCase() === 'list') {
      const names = onlineActors().filter(listed).map(display);
      return personal(a, names.length ? `Named teachers online: ${names.join(', ')}.` : 'No named teacher is online.');
    }
    const t = findByName(rest.join(' '));
    if (!t) return personal(a, `Nobody online answers to "${rest.join(' ')}".`);
    const s = stateOf(t);
    s.teacher = verb.toLowerCase() === 'add' ? { by: who(a), at: Date.now() } : null;
    save(t, s);
    audit(`SCHOOLS ${who(a)} ${s.teacher ? 'named' : 'removed'} ${who(t)} as a class teacher`);
    personal(a, `${display(t)} ${s.teacher ? 'may now hold classes at a Class Lectern' : 'may no longer hold classes'}.`);
    if (t !== a) personal(t, s.teacher ? 'You have been named a teacher: you may hold classes at a Class Lectern.' : 'You may no longer hold classes.');
  }, { admin: true, help: 'name or remove a class teacher (Class Lectern)' });
  // Named preachers matter only with preach.requireList (off by default: a follower of a Divine at Priest rank may preach)
  registerChatCommand('preacher', (a, args) => {
    const [verb, ...rest] = argList(args);
    if (!verb || !['add', 'remove', 'list'].includes(verb.toLowerCase())) return personal(a, 'Usage: /preacher add|remove <player>, or /preacher list (players online).');
    if (verb.toLowerCase() === 'list') {
      const names = onlineActors().filter(SERMONS.listed).map(display);
      return personal(a, names.length ? `Named preachers online: ${names.join(', ')}.` : 'No named preacher is online.');
    }
    const t = findByName(rest.join(' '));
    if (!t) return personal(a, `Nobody online answers to "${rest.join(' ')}".`);
    const s = stateOf(t);
    s.preacher = verb.toLowerCase() === 'add' ? { by: who(a), at: Date.now() } : null;
    save(t, s);
    audit(`SCHOOLS ${who(a)} ${s.preacher ? 'named' : 'removed'} ${who(t)} as a preacher`);
    personal(a, `${display(t)} ${s.preacher ? 'may now preach at a pulpit' : 'may no longer preach'}.`);
    if (t !== a) personal(t, s.preacher ? 'You have been named a preacher: you may give sermons at a temple pulpit.' : 'You may no longer give sermons.');
  }, { admin: true, help: 'name or remove a preacher (Preach pulpit; only with preach.requireList)' });
  registerChatCommand('schools', (a, args) => {
    const words = argList(args);
    const isReset = !!words[0] && words[0].toLowerCase() === 'reset';
    const query = (isReset ? words.slice(1) : words).join(' ');
    const t = query ? findByName(query) : (isReset ? 0 : a);
    if (!t) return personal(a, query ? `Nobody online answers to "${query}".` : 'Usage: /schools <player>, or /schools reset <player>.');
    if (isReset) {
      save(t, fresh());
      audit(`SCHOOLS ${who(a)} reset ${who(t)}'s schools of magic`);
      return personal(a, `${display(t)}'s schools of magic are cleared; they choose again.`);
    }
    const s = stateOf(t);
    personal(a, `${display(t)}: ${SCHOOLS.map((n) => `${n} ${roleOf(s, n)}${active(s, n) ? ` ${levelOf(s, n)}` : ''}`).join(', ')}; Arcane Arts ${arcaneOf(t).level}${s.teacher ? '; a named teacher' : ''}.`);
  }, { admin: true, help: 'a player\'s schools of magic (or reset them)' });

  log(`schools ${C.enabled ? 'on' : 'off'}: ${SCHOOLS.join(', ')}; first spell at Arcane Arts ${FIRST_AT || 'any level'} (${SCHOOLS.map((n) => `${n} ${starterName(n) || '?'}`).join(', ')}); secondary at Arcane Arts ${C.secondaryAtLevel} from ${C.secondaryStartLevel}; study ${C.study.enabled ? `${C.study.minutesPerWindow} min per ${C.study.windowHours} h at ${C.study.edid}${STUDY_REFS.size ? ` + ${STUDY_REFS.size} refs` : ''}` : 'off'}; classes ${C.classes.enabled ? `${C.classes.minutes} min at ${C.classes.edid}${LECTERN_REFS.size ? ` + ${LECTERN_REFS.size} refs` : ''}, ${CLASSES.runs.size} running` : 'off'}; school spells ${Object.keys(SCHOOL_SPELL).length}; Alteration ${ALTERATION}`);
  log(`schools: sermons ${P.enabled && C.enabled ? `${P.minutes} min at ${P.edid}${PREACH_REFS.size ? ` + ${PREACH_REFS.size} refs` : ''}, by a follower of ${(P.teacherFaiths || []).join('/') || 'any faith'} at Priest ${RANKS[P.teacherMinRank]}${P.requireList ? ', named preachers only' : ''}, ${SERMONS.runs.size} running` : 'off'}`);
  log(`schools: Priest Studies ${PS.enabled && C.enabled ? `${PS.minutesPerWindow} min per ${PS.windowHours} h at ${PS.edid}${PRIEST_REFS.size ? ` + ${PRIEST_REFS.size} refs` : ''}, paying ${PS.skill} with ${PRIEST_SPELL || 'no Restoration spell'}${S.priestStudySeen ? '' : `; inert until a ${PS.edid} activator is used (DLE v10)`}` : 'off'}`);
};
