// Schools of magic (Swag's rework, Nate 2026-09-30): four school meters inside Arcane Arts, Study Magic and the Class
// Lectern. Loaded by gamemode.js after spells.js, whose spellbook and spell records it reads through globalThis.
//
// A mage picks a primary school (Destruction, Illusion, Conjuration or Alteration); only it is active and the other three
// are locked. At Arcane Arts `secondaryAtLevel` (76) one more may be chosen as the secondary, which starts at
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
// Study and classes also feed Arcane Arts itself through masterySystem's own "cast" credit (__alduinakMasteryEvent with a
// spell of the school), so the Wheel's hourly bucket and daily caps hold for them as for any cast.
//
// State, on the character: private.dboSchools
//   { v, primary, secondary, levels: { <school>: { level, xp } }, grandfathered: [spell desc...], study: { log: [[from, to] ms...] }, cast: { day, units: {} },
//     ring: [{ h, at }], classAt, paidAt, teacher: { by, at } }
// Classes live on globalThis and end with the process (a restart cancels a class in progress).
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
    castUnits: 0.5,
    castDailyUnits: 120,
    study: {
      enabled: true, edid: 'StudyMagic', refs: [], tickSeconds: 10, unitsPerTick: 1, minutesPerWindow: 20, windowHours: 4,
      moveLimitMeters: 1.5, anim: 'IdleBook_PageTurn', exitAnim: 'IdleForceDefaultState', wheelEverySeconds: 60, wheelValue: 0,
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
  const fresh = () => ({ v: 1, primary: null, secondary: null, grandfathered: [], levels: {}, study: { log: [] }, cast: { day: '', units: {} }, ring: [], classAt: 0, paidAt: 0, teacher: null });
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

  // ---- the Wheel: Arcane Arts through masterySystem's own cast credit ----------------------------------------------
  // One Novice spell of each school from spell-tomes.json, vanilla first, stands for the school when nothing was cast
  const SCHOOL_SPELL = (() => {
    const out = {};
    let list = [];
    try { list = (JSON.parse(require('fs').readFileSync(require('path').resolve('spell-tomes.json'), 'utf8')).tomes) || []; } catch (e) { /* no tome list */ }
    const canonToDesc = (c) => { const i = String(c).lastIndexOf(':'); return i < 0 ? '' : `${parseInt(c.slice(i + 1), 16).toString(16)}:${c.slice(0, i)}`; };
    const sorted = list.filter((t) => t && t.spellId && Number(t.rank) === 0).sort((x, y) => (String(x.spellId).startsWith('Skyrim.esm:') ? 0 : 1) - (String(y.spellId).startsWith('Skyrim.esm:') ? 0 : 1));
    for (const t of sorted) if (SCHOOLS.includes(t.school) && !out[t.school]) out[t.school] = canonToDesc(t.spellId);
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
      return { ok: true, text: `${school} is your school of magic. The other schools are closed to you until your Arcane Arts reaches ${C.secondaryAtLevel}.` };
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
    const nonce = mkNonce('m', a);
    menuNonces.set(a >>> 0, nonce);
    return {
      skill: C.arcaneSkill,
      title: 'Schools of Magic',
      note: !s.primary
        ? 'Choose the school you will give yourself to. The others stay closed until your Arcane Arts reaches ' + C.secondaryAtLevel + '.'
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
        const pick = !s.primary ? 'primary' : secondaryOpen && role === 'locked' ? 'secondary' : '';
        const l = s.levels[school];
        return {
          name: school, role, level, rank: role === 'locked' ? '' : RANKS[Math.max(0, r)],
          roleLabel: role === 'primary' ? 'Primary school' : role === 'secondary' ? 'Secondary school' : 'Closed',
          // The meter fills bottom to top over the whole ladder, 0..100
          fill: role === 'locked' ? 0 : Math.max(0, Math.min(1, (level + (l ? Number(l.xp) || 0 : 0) / 100) / 100)),
          hint: role === 'locked' ? (pick ? '' : 'Closed to you') : next ? `${RANKS[r + 1]} at ${next}` : 'The top of the school',
          choose: pick ? { as: pick, label: pick === 'primary' ? 'Choose as my school' : 'Choose as secondary', title: `Choose ${school}?`, yes: 'Choose', no: 'Not yet',
            confirm: pick === 'primary' ? `Do you want to choose ${school} as your school of magic? The other schools will be closed to you.` : `Do you want to choose ${school} as your secondary school of magic?` } : null,
        };
      }),
      events: { choose: 'dbo:schoolChoose' },
    };
  };
  globalThis.__dboSchoolsProgress = progressOf;
  // The primary school's name ('' before one is chosen), for the journal's mage titles; reads only
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
    // Chosen from the Study Magic panel: it goes on to studying
    if (studyNonces.get(a >>> 0) === nonce) { const at = studyAt.get(a >>> 0); if (at && r.ok) startStudy(a, at); else if (at) openStudy(a, at, r.text, r.ok ? 'ok' : 'refused'); }
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
  const isLectern = (ref) => C.classes.enabled && (LECTERN_REFS.has(ref) || (!!C.classes.edid && baseEdidOf(ref) === String(C.classes.edid).toLowerCase()));

  // ---- Study Magic ---------------------------------------------------------------------------------------------------
  const S = globalThis.__dboSchoolsState || (globalThis.__dboSchoolsState = {});
  S.studying = S.studying instanceof Map ? S.studying : new Map(); // actor -> { ref, at, pos, cell, lastTick, lastWheel, gained }
  S.classes = S.classes instanceof Map ? S.classes : new Map();   // lectern ref -> class
  const studyNonces = S.studyNonces instanceof Map ? S.studyNonces : (S.studyNonces = new Map());
  const studyAt = S.studyAt instanceof Map ? S.studyAt : (S.studyAt = new Map()); // actor -> the study ref of the open panel
  const anim = (a, ev) => { if (!ev) return; try { mp.callPapyrusFunction('global', 'Debug', 'SendAnimationEvent', null, [{ type: 'form', desc: descOf(a) }, ev]); } catch (e) { log(`schools: ${ev} failed for ${display(a)}: ${e.message}`); } };
  const windowMs = () => Math.max(1, Number(C.study.windowHours) || 4) * HOUR;
  const budgetMs = () => Math.max(0, Number(C.study.minutesPerWindow) || 0) * MIN;
  // The sittings of the last windowHours, as [from, to]; a record from before the rolling window is one sitting
  const studyLog = (s) => {
    const st = s.study || {};
    const log = Array.isArray(st.log) ? st.log : (Number(st.usedMs) > 0 ? [[Number(st.windowAt) || 0, (Number(st.windowAt) || 0) + Number(st.usedMs)]] : []);
    return log.filter((x) => Array.isArray(x) && Number(x[1]) > Date.now() - windowMs()).map((x) => [Number(x[0]) || 0, Number(x[1]) || 0]);
  };
  // Study time inside the rolling window that ends at `at`
  const usedAt = (log, at) => log.reduce((n, [from, to]) => n + Math.max(0, Math.min(to, at) - Math.max(from, at - windowMs())), 0);
  // { usedMs, leftMs, resetsIn }: resetsIn is how long until the window has room for one more tick
  const studyBudget = (s) => {
    const now = Date.now(), log = studyLog(s), used = usedAt(log, now);
    const room = budgetMs() - Math.max(1000, C.study.tickSeconds * 1000);
    let resetsIn = 0;
    if (used > room) {
      let lo = 0, hi = windowMs();
      while (hi - lo > 1000) { const mid = (lo + hi) / 2; if (usedAt(log, now + mid) > room) lo = mid; else hi = mid; }
      resetsIn = hi;
    }
    return { usedMs: used, leftMs: Math.max(0, budgetMs() - used), resetsIn };
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
    const why = s.primary ? studyRefusal(a, s) : '';
    const school = s.primary;
    openWidget(a, {
      type: 'studyMagic', id: STUDY_PANEL_ID, nonce, title: 'Study Magic',
      mode: !school ? 'choose' : ses ? 'studying' : 'idle',
      school: school || '', level: school ? levelOf(s, school) : 0, rank: school ? RANKS[Math.max(0, schoolRank(s, school))] : '',
      fill: school ? Math.max(0, Math.min(1, levelOf(s, school) / 100)) : 0,
      leftSeconds: Math.round(b.leftMs / 1000), tickSeconds: C.study.tickSeconds,
      gained: ses ? Math.round(ses.gained * 10) / 10 : 0,
      whyNot: why,
      choices: !school ? SCHOOLS.map((n) => ({ name: n, blurb: BLURB[n] || '', confirm: `Do you want to choose ${n} as your school of magic? The other schools will be closed to you.` })) : [],
      result: result || '', resultKind: resultKind || '',
      events: { choose: 'dbo:schoolChoose', start: 'dbo:studyStart', stop: 'dbo:studyStop', close: 'dbo:studyClose' },
    }, focus);
  };
  const posOf = (a) => { try { return mp.get(a, 'pos'); } catch (e) { return null; } };
  const startStudy = (a, ref) => {
    const s = stateOf(a);
    const why = studyRefusal(a, s);
    if (why) return openStudy(a, ref, why, 'refused');
    S.studying.set(a >>> 0, { ref, at: Date.now(), pos: posOf(a), cell: String(get(a, 'worldOrCellDesc', '')), lastTick: Date.now(), lastWheel: Date.now(), gained: 0 });
    anim(a, C.study.anim);
    audit(`SCHOOLS ${who(a)} began studying ${s.primary} at ${descOf(ref)}`);
    openStudy(a, ref, `You open the books on ${s.primary}.`, 'ok');
  };
  const stopStudy = (a, why) => {
    const ses = S.studying.get(a >>> 0);
    if (!ses) return;
    S.studying.delete(a >>> 0);
    anim(a, C.study.exitAnim);
    const s = stateOf(a);
    s.study = { log: studyLog(s).concat(ses.lastTick > ses.at ? [[ses.at, ses.lastTick]] : []) };
    save(a, s);
    audit(`SCHOOLS ${who(a)} stopped studying (${why}): +${Math.round(ses.gained * 10) / 10} units of ${s.primary}`);
    if (why !== 'offline' && why !== 'closed') personal(a, why === 'budget' ? `You've done enough studying for the day. Come back in ${inWords(studyBudget(s).resetsIn || windowMs())}.` : `You close the books.${ses.gained > 0 ? ` Your study of ${s.primary} stands at ${levelOf(s, s.primary)}.` : ''}`);
  };
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
      if (paid > 0) {
        const before = levelOf(s, s.primary);
        credit(s, s.primary, paid * C.study.unitsPerTick);
        ses.gained += paid * C.study.unitsPerTick;
        save(a, s);
        tellGain(a, s.primary, before, s);
      }
      ses.lastTick += paid * tickMs;
      if (C.study.wheelEverySeconds > 0 && now - ses.lastWheel >= C.study.wheelEverySeconds * 1000) {
        ses.lastWheel = now;
        wheel(a, idOf(SCHOOL_SPELL[s.primary] || ''), C.study.wheelValue, 1);
      }
      if (paid < ticks) { stopStudy(a, 'budget'); closeWidget(a, STUDY_PANEL_ID); continue; }
      if (studyAt.get(a) === ses.ref) openStudy(a, ses.ref, '', '', false);
    }
  };
  onUi('studyStart', (a, args) => { if (studyNonces.get(a >>> 0) !== String(args[0] || '')) return; const ref = studyAt.get(a >>> 0); if (ref && !S.studying.has(a >>> 0)) startStudy(a, ref); });
  onUi('studyStop', (a, args) => { if (studyNonces.get(a >>> 0) !== String(args[0] || '')) return; stopStudy(a, 'stopped'); const ref = studyAt.get(a >>> 0); if (ref) openStudy(a, ref); });
  onUi('studyClose', (a) => { stopStudy(a, 'closed'); studyNonces.delete(a >>> 0); studyAt.delete(a >>> 0); closeWidget(a, STUDY_PANEL_ID); });
  onUi('close', (a, args, widgetId) => {
    if (widgetId === STUDY_PANEL_ID) { stopStudy(a, 'closed'); studyNonces.delete(a >>> 0); studyAt.delete(a >>> 0); }
    if (widgetId === CLASS_PANEL_ID) lecternOpen.delete(a >>> 0);
  });
  const useStudy = (ref, a) => {
    const s = stateOf(a);
    if (!s.primary) return openStudy(a, ref);
    if (S.studying.has(a >>> 0)) return openStudy(a, ref);
    startStudy(a, ref);
  };

  // ---- classes --------------------------------------------------------------------------------------------------------
  const lecternOpen = S.lecternOpen instanceof Map ? S.lecternOpen : (S.lecternOpen = new Map()); // actor -> { ref, nonce }
  const guildsOf = (a) => { const g = get(a, 'private.dboGuilds', []); return Array.isArray(g) ? g.map((m) => String(m && m.id)) : []; };
  const knownSpells = (a) => { try { return typeof globalThis.__dboSpellsKnown === 'function' ? (globalThis.__dboSpellsKnown(a) || []) : []; } catch (e) { return []; } };
  const listed = (a) => { const t = stateOf(a).teacher; return !!(t && t.at); };
  // Why `a` may not teach at all, or ''
  const teacherRefusal = (a) => {
    if (!C.enabled || !C.classes.enabled) return 'Classes are not held just now.';
    if (C.classes.requireList && !listed(a)) return 'Only teachers the Synod has named may hold a class. Ask the staff.';
    const guilds = Array.isArray(C.classes.teacherGuilds) ? C.classes.teacherGuilds : [];
    if (guilds.length && !guildsOf(a).some((g) => guilds.includes(g))) return 'A class is held by a member of the Synod or a College.';
    const s = stateOf(a);
    if (!SCHOOLS.some((n) => schoolRank(s, n) >= C.classes.teacherMinRank)) return `Teaching a class takes ${RANKS[C.classes.teacherMinRank]} study in one of your schools.`;
    const next = (Number(s.classAt) || 0) + C.classes.teacherCooldownMinutes * MIN;
    if (next > Date.now()) return `You taught a class not long ago. You may hold the next in ${inWords(next - Date.now())}.`;
    return '';
  };
  // Spells `a` may set a class by: known, of a school where they are qualified, no higher than their study of it
  const classSpells = (a) => {
    const s = stateOf(a);
    const seen = new Set();
    return knownSpells(a).filter((sp) => {
      if (!sp || !SCHOOLS.includes(sp.school) || seen.has(sp.id)) return false;
      seen.add(sp.id);
      const r = schoolRank(s, sp.school);
      return r >= C.classes.teacherMinRank && Number(sp.rank) <= r;
    }).sort((x, y) => SCHOOLS.indexOf(x.school) - SCHOOLS.indexOf(y.school) || x.rank - y.rank || String(x.name).localeCompare(String(y.name)));
  };
  const scaleFor = (studentRank, classRank) => {
    const row = (C.classes.scale || [])[studentRank];
    const v = Array.isArray(row) ? Number(row[classRank]) : 0;
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  const gainWords = (f) => (f >= 1 ? 'the full lesson' : f > 0 ? `${Math.round(f * 100)}% of the lesson` : 'nothing at your level');
  // Where the class is held: the lectern's interior cell, or `radiusMeters` around it outdoors
  const inRoom = (k, a) => {
    if (!online(a)) return false;
    const cell = String(get(a, 'worldOrCellDesc', ''));
    if (norm(cell) !== norm(k.cell)) return false;
    let world = false; try { world = typeof isWorldspace === 'function' ? isWorldspace(k.cell) : false; } catch (e) { world = false; }
    return !world || distanceMeters(a, k.ref) <= C.classes.radiusMeters;
  };
  // Nate's lecterns carry two activator boxes each (DLE v7: 15e4bb/15e4bc at the Synod, 16 units apart). Boxes within
  // sameLecternUnits of each other in one cell are one lectern: one class, and the status on every box's crosshair.
  const nearRef = (x, y) => {
    if (x === y) return true;
    if (norm(get(x, 'worldOrCellDesc', '')) !== norm(get(y, 'worldOrCellDesc', ''))) return false;
    const p = get(x, 'pos', null), q = get(y, 'pos', null);
    return !!(p && q) && Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) <= C.classes.sameLecternUnits;
  };
  const siblingsOf = (ref) => [ref >>> 0].concat([...LECTERN_REFS].filter((r) => r !== (ref >>> 0) && nearRef(ref >>> 0, r)));
  const classOf = (ref) => {
    ref >>>= 0;
    const exact = S.classes.get(ref);
    if (exact) return exact;
    for (const k of S.classes.values()) {
      if ((k.refs || []).includes(ref)) return k;
      if (nearRef(ref, k.ref)) { k.refs = (k.refs || [k.ref]).concat([ref]); return k; }
    }
    return null;
  };
  const studentRefusal = (k, a) => {
    if (a === k.teacher) return 'You are teaching this class.';
    if (k.students.has(a)) return '';
    if (Date.now() - k.startedAt > C.classes.joinMinutes * MIN) return `Sign-ups closed ${C.classes.joinMinutes} minutes into the class.`;
    if (k.students.size >= C.classes.maxStudents) return 'The class is full.';
    const s = stateOf(a);
    if (!active(s, k.spell.school)) return `${k.spell.school} is not one of your schools of magic.`;
    const f = scaleFor(schoolRank(s, k.spell.school), k.spell.rank);
    if (f <= 0) return `At your study of ${k.spell.school} this class would teach you nothing.`;
    const next = (Number(s.paidAt) || 0) + C.classes.studentCooldownHours * HOUR;
    if (next > Date.now()) return `You sat a class not long ago. You may learn in another in ${inWords(next - Date.now())}.`;
    return '';
  };
  const lecternName = (k) => (k ? (Date.now() >= k.endsAt ? 'Class Lectern: the class may be ended' : `Class Lectern: Class in Progress, ${inWords(k.endsAt - Date.now())} left`) : null);
  // The class's status on the crosshair of every box of its lectern, for everyone in its cell; null hands the name back
  const decorate = (k, over) => {
    const name = over ? null : lecternName(k);
    const refs = (k.refs || [k.ref]).map((r) => ({ refId: r >>> 0, name, locked: false }));
    for (const a of onlineActors()) {
      if (norm(get(a, 'worldOrCellDesc', '')) !== norm(k.cell)) continue;
      try { sendPacket(a, { customPacketType: 'refDecor', refs }); } catch (e) { /* offline */ }
    }
  };
  const openLectern = (a, ref, result, resultKind, focus = true) => {
    const was = lecternOpen.get(a >>> 0);
    const nonce = (!focus && was && was.ref === ref && was.nonce) || mkNonce('l', a);
    lecternOpen.set(a >>> 0, { ref, nonce });
    const k = classOf(ref);
    const base = { type: 'classLectern', id: CLASS_PANEL_ID, nonce, title: 'Class Lectern', result: result || '', resultKind: resultKind || '',
      events: { start: 'dbo:lecternStart', join: 'dbo:lecternJoin', leave: 'dbo:lecternLeave', end: 'dbo:lecternEnd', cancel: 'dbo:lecternCancel', close: 'dbo:lecternClose' } };
    if (!k) {
      const why = teacherRefusal(a);
      const spells = why ? [] : classSpells(a);
      return openWidget(a, Object.assign(base, {
        mode: 'idle',
        status: 'No class is being held here.',
        canTeach: !why && spells.length > 0,
        whyNot: why || (spells.length ? '' : 'You know no spell of your schools to set a class by.'),
        minutes: C.classes.minutes,
        spells: spells.map((sp) => ({ id: sp.desc || descOf(sp.id), name: sp.name, school: sp.school, rank: sp.rank, rankName: RANKS[sp.rank] })),
      }), focus);
    }
    const s = stateOf(a);
    const mine = a === k.teacher;
    const signed = k.students.has(a);
    const f = mine ? 0 : scaleFor(schoolRank(s, k.spell.school), k.spell.rank);
    const why = mine || signed ? '' : studentRefusal(k, a);
    openWidget(a, Object.assign(base, {
      mode: 'running',
      status: Date.now() >= k.endsAt ? 'The class has run its course.' : 'Class in Progress',
      teacher: k.teacherName, spell: k.spell.name, school: k.spell.school, rankName: RANKS[k.spell.rank],
      endsInMs: Math.max(0, k.endsAt - Date.now()), minutes: C.classes.minutes,
      teacherAway: k.teacherAwaySince ? Math.max(0, k.teacherAwaySince + C.classes.graceMinutes * MIN - Date.now()) : 0,
      students: [...k.students.keys()].map((st) => ({ name: display(st), away: !!k.students.get(st).awaySince })),
      role: mine ? 'teacher' : signed ? 'student' : 'visitor',
      gain: mine ? '' : `At your study of ${k.spell.school} you would take ${gainWords(f)}.`,
      canJoin: !mine && !signed && !why, whyNot: why,
      canEnd: mine && Date.now() >= k.endsAt,
    }), focus);
  };
  // Everyone else looking at this lectern; `except` is the player whose click just redrew their own panel
  const refreshLectern = (k, except) => { for (const [a, o] of lecternOpen) if (a !== except && (k.refs || [k.ref]).includes(o.ref) && online(a)) openLectern(a, o.ref, '', '', false); };
  const endClass = (k, paid) => {
    S.classes.delete(k.ref);
    decorate(k, true);
    const t = stateOf(k.teacher);
    if (paid) { t.classAt = Date.now(); save(k.teacher, t); }
    const got = [];
    for (const [st, e] of k.students) {
      if (!paid) { if (online(st)) personal(st, `The ${k.spell.school} class was cancelled. Nobody is paid for it.`); continue; }
      if (e.awaySince || !inRoom(k, st)) { if (online(st)) personal(st, 'You were not in the classroom when the class ended.'); continue; }
      const s = stateOf(st);
      const f = scaleFor(schoolRank(s, k.spell.school), k.spell.rank);
      if (f <= 0 || !active(s, k.spell.school)) continue;
      // Checked again at payout: sign-ups for two classes at once would otherwise both pay
      if ((Number(s.paidAt) || 0) + C.classes.studentCooldownHours * HOUR > Date.now()) { if (online(st)) personal(st, 'You were paid for another class too recently to be paid for this one.'); continue; }
      const before = levelOf(s, k.spell.school);
      credit(s, k.spell.school, C.classes.units * f);
      s.paidAt = Date.now();
      save(st, s);
      const w = wheel(st, idOf(k.spell.desc), C.classes.wheelValue, Math.max(1, Math.round(C.classes.wheelEvents * f)));
      got.push(`${who(st)} x${f} (${before}->${levelOf(s, k.spell.school)}, wheel ${w})`);
      personal(st, `${display(k.teacher)}'s class on ${k.spell.name} is over. You took ${gainWords(f)}: your study of ${k.spell.school} stands at ${levelOf(s, k.spell.school)}.`);
      tellGain(st, k.spell.school, before, s);
    }
    audit(`SCHOOLS class by ${who(k.teacher)} on ${k.spell.name} (${k.spell.school} ${RANKS[k.spell.rank]}) at ${descOf(k.ref)} ${paid ? `ended: ${got.join(', ') || 'nobody paid'}` : 'cancelled'}`);
    for (const [a, o] of [...lecternOpen]) if ((k.refs || [k.ref]).includes(o.ref) && online(a)) openLectern(a, o.ref, paid ? 'The class is over.' : 'The class was cancelled.', paid ? 'ok' : 'refused', false);
  };
  const startClass = (a, ref, spellDesc) => {
    if (classOf(ref)) return { ok: false, text: 'A class is already held at this lectern.' };
    for (const k of S.classes.values()) if (k.teacher === a) return { ok: false, text: 'You are already teaching a class.' };
    const why = teacherRefusal(a);
    if (why) return { ok: false, text: why };
    const sp = classSpells(a).find((x) => norm(x.desc || descOf(x.id)) === norm(spellDesc));
    if (!sp) return { ok: false, text: 'You cannot set a class by that spell.' };
    const now = Date.now();
    const k = { ref: ref >>> 0, refs: siblingsOf(ref), teacher: a >>> 0, teacherName: display(a), spell: { id: sp.id >>> 0, desc: sp.desc || descOf(sp.id), name: sp.name, school: sp.school, rank: Number(sp.rank) || 0 },
      cell: String(get(ref, 'worldOrCellDesc', '') || get(a, 'worldOrCellDesc', '')), startedAt: now, endsAt: now + C.classes.minutes * MIN, students: new Map(), teacherAwaySince: 0 };
    S.classes.set(k.ref, k);
    decorate(k);
    audit(`SCHOOLS ${who(a)} opened a class on ${sp.name} (${sp.school} ${RANKS[k.spell.rank]}) at ${descOf(ref)}`);
    return { ok: true, text: `Your class on ${sp.name} has begun. Students sign up at this lectern for the first ${C.classes.joinMinutes} minutes; after ${C.classes.minutes} minutes, end it here.` };
  };
  const classTick = () => {
    const now = Date.now();
    for (const k of [...S.classes.values()]) {
      if (inRoom(k, k.teacher)) k.teacherAwaySince = 0;
      else if (!k.teacherAwaySince) {
        k.teacherAwaySince = now;
        for (const st of k.students.keys()) if (online(st)) personal(st, `${k.teacherName} has left the classroom. If they are not back within ${C.classes.graceMinutes} minutes, the class is cancelled.`);
        if (online(k.teacher)) personal(k.teacher, `You have left your classroom. Come back within ${C.classes.graceMinutes} minutes or the class is cancelled.`);
      } else if (now - k.teacherAwaySince >= C.classes.graceMinutes * MIN) { endClass(k, false); continue; }
      for (const [st, e] of [...k.students]) {
        if (inRoom(k, st)) { e.awaySince = 0; continue; }
        if (!e.awaySince) { e.awaySince = now; if (online(st)) personal(st, `You have left the classroom. Come back within ${C.classes.graceMinutes} minutes to stay in the class.`); }
        else if (now - e.awaySince >= C.classes.graceMinutes * MIN) { k.students.delete(st); if (online(st)) personal(st, 'You were away too long and have dropped out of the class.'); }
      }
      if (!k.readyTold && now >= k.endsAt) { k.readyTold = true; if (online(k.teacher)) personal(k.teacher, 'Your class has run its course. End it at the lectern to mark the lesson.'); }
      decorate(k);
      refreshLectern(k);
    }
  };
  const lecternRef = (a, args) => { const o = lecternOpen.get(a >>> 0); return o && o.nonce === String(args[0] || '') ? o.ref : 0; };
  onUi('lecternStart', (a, args) => { const ref = lecternRef(a, args); if (!ref) return; const r = startClass(a, ref, String(args[1] || '')); openLectern(a, ref, r.text, r.ok ? 'ok' : 'refused'); });
  onUi('lecternJoin', (a, args) => {
    const ref = lecternRef(a, args); if (!ref) return;
    const k = classOf(ref);
    if (!k) return openLectern(a, ref, 'The class is over.', 'refused');
    const why = studentRefusal(k, a);
    if (why) return openLectern(a, ref, why, 'refused');
    if (!inRoom(k, a)) return openLectern(a, ref, 'Step into the classroom to sign up.', 'refused');
    k.students.set(a >>> 0, { joinedAt: Date.now(), awaySince: 0 });
    audit(`SCHOOLS ${who(a)} signed up for ${who(k.teacher)}'s class on ${k.spell.name}`);
    if (online(k.teacher)) personal(k.teacher, `${display(a)} has signed up for your class.`);
    openLectern(a, ref, `You have signed up. Stay in the classroom until ${k.teacherName} ends the class.`, 'ok');
    refreshLectern(k, a >>> 0);
  });
  onUi('lecternLeave', (a, args) => {
    const ref = lecternRef(a, args); if (!ref) return;
    const k = classOf(ref);
    if (k && k.students.delete(a >>> 0)) { audit(`SCHOOLS ${who(a)} left ${who(k.teacher)}'s class`); openLectern(a, ref, 'You have left the class.', 'ok'); refreshLectern(k, a >>> 0); }
  });
  onUi('lecternEnd', (a, args) => {
    const ref = lecternRef(a, args); if (!ref) return;
    const k = classOf(ref);
    if (!k || k.teacher !== (a >>> 0)) return openLectern(a, ref);
    if (Date.now() < k.endsAt) return openLectern(a, ref, `The class runs another ${inWords(k.endsAt - Date.now())}.`, 'refused');
    endClass(k, true);
  });
  onUi('lecternCancel', (a, args) => {
    const ref = lecternRef(a, args); if (!ref) return;
    const k = classOf(ref);
    if (!k || k.teacher !== (a >>> 0)) return openLectern(a, ref);
    endClass(k, false);
  });
  onUi('lecternClose', (a) => { lecternOpen.delete(a >>> 0); closeWidget(a, CLASS_PANEL_ID); });

  // gamemode.js onActivate: true when the ref is a study activator or a Class Lectern (the use is handled here)
  globalThis.__dboSchoolsActivate = (targetId, casterId) => {
    if (!ready(casterId) || !isPlayer(casterId)) return false;
    if (isLectern(targetId)) { openLectern(casterId, targetId >>> 0); return true; }
    if (isStudy(targetId)) { useStudy(targetId >>> 0, casterId >>> 0); return true; }
    return false;
  };
  // A player who logs out or changes cell mid-study stops; one who disconnects mid-class is caught by the class tick
  every('schools.tick', 2000, () => {
    try { studyTick(); } catch (e) { log('schools: study tick failed', e.stack || e.message); }
  });
  every('schools.classes', 10000, () => {
    try { classTick(); } catch (e) { log('schools: class tick failed', e.stack || e.message); }
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

  log(`schools ${C.enabled ? 'on' : 'off'}: ${SCHOOLS.join(', ')}; secondary at Arcane Arts ${C.secondaryAtLevel} from ${C.secondaryStartLevel}; study ${C.study.enabled ? `${C.study.minutesPerWindow} min per ${C.study.windowHours} h at ${C.study.edid}${STUDY_REFS.size ? ` + ${STUDY_REFS.size} refs` : ''}` : 'off'}; classes ${C.classes.enabled ? `${C.classes.minutes} min at ${C.classes.edid}${LECTERN_REFS.size ? ` + ${LECTERN_REFS.size} refs` : ''}, ${S.classes.size} running` : 'off'}; school spells ${Object.keys(SCHOOL_SPELL).length}; Alteration ${ALTERATION}`);
};
