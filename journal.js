// DragonBreak Online: the Character Journal, phase 1, the server half (Nate, 2026-09-30: "go with your recommendations";
// design ~/claude-nate-release/specs/character-journal-design.md, sections 1, 4, 6 and 9). Loaded by gamemode.js.
//
// F3 opens the journal, front widget 50 "journal" (features/journal, Worker D), for a client whose dbo:uiCaps lists
// 'journal'; any other client gets today's faction panel 37. The faction panel lives on as the journal's Faction tab:
// guilds.js redraws the journal instead of panel 37 while the journal is open. Contract agreed with Worker D:
//   Server -> client (dboWidget, one hop through the relay):
//     { type: 'journal', id: 50, nonce, tab?, result?, resultKind?, clock: { date, time, moons },
//       profile: { name, race, playtime, created?, joined?, backstory, origin, backstoryMax, originMax,
//                  skills: [{ id, name, level, tier, tierName, epithet }], title, titleEpithet, titleId, titles: [{ id, label }] },
//       faction: <panel 37's payload, its own nonce included> | null, supernatural: <__dboSuperProgress> | null,
//       stats: { groups: [{ name, rows: [{ label, value, hint? }] }] } }
//   Client -> server (dbo events): journalProfile [nonce, backstory, origin], journalTitle [nonce, titleId],
//     journalClose [nonce]; the relay's own "close" for widget 50 (Escape).
// A new journal nonce is sent on opening and with every answer; the minute clock redraw and faction redraws keep it.
// Opening plays the page-turn idle (idles.js "journal"): a client that knows hold (client-journal-client) keeps it until
// the dboIdleStop sent on closing; an older one plays it 10 s and ignores the stop.
// Stored in the character's journal file (journalstats.js, journal/<actor hex>.json): profile { backstory, origin,
// titleId, savedAt }. Titles come from journal-titles.json.
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, display, nameOf, openWidget, closeWidget, onUi, sendPacket, every, onlineActors, hasCap, skills, cfg } = api;
  const C = Object.assign({ enabled: true, backstoryMax: 4000, originMax: 1000, saveEveryMs: 3000, clockRedrawSeconds: 60 },
    (cfg && cfg.journal) || {});
  const WIDGET_ID = 50;
  const IDLE_ANIM = 'IdleBook_PageTurn';   // idles.js "journal"; the stop names it so it never ends another idle
  const TIER_FLOORS = [1, 25, 50, 75, 90];
  const TIER_NAMES = ['Novice', 'Apprentice', 'Adept', 'Expert', 'Master'];
  // actor -> { nonce, tab, at }: open journals; savedAt: actor -> last save; idleAt: actor -> when the page-turn began
  const J = globalThis.__dboJournal || (globalThis.__dboJournal = { open: new Map(), savedAt: new Map(), idleAt: new Map(), seq: 0 });

  const readJson = (file, dflt) => { try { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); } catch (e) { return dflt; } };
  const TITLES = readJson('journal-titles.json', { ranks: [[0, 'Novice']], minLevel: 25, classes: [], wanderer: 'Wanderer', adventurer: 'Adventurer' });
  const SKILLS = new Map((Array.isArray(skills) ? skills : []).map((s) => [String(s.id), s]));

  const get = (a, k, dflt) => { try { const v = mp.get(a, k); return v === undefined || v === null ? dflt : v; } catch (e) { return dflt; } };
  const mkNonce = (a) => `j${(a >>> 0).toString(16)}-${Date.now().toString(36)}-${(++J.seq).toString(36)}`;
  const docOf = (a) => { const d = globalThis.__dboJournalDoc; return d && typeof d.of === 'function' ? d.of(a >>> 0) : null; };
  const profileDoc = (a) => { const d = docOf(a); if (!d) return null; if (!d.profile || typeof d.profile !== 'object') d.profile = {}; return d.profile; };
  const touchDoc = (a) => { const d = globalThis.__dboJournalDoc; if (d && typeof d.touch === 'function') d.touch(a >>> 0); };

  // ---- skills and titles -----------------------------------------------------------------------------------------
  const tierOf = (level) => { let t = 0; for (let i = 0; i < TIER_FLOORS.length; i++) if (level >= TIER_FLOORS[i]) t = i; return t; };
  // Every skill the character has, highest first (level, then xp)
  const skillLevels = (a) => {
    const m = get(a, 'private.mastery', null);
    const rec = m && m.skills && typeof m.skills === 'object' ? m.skills : {};
    return Object.entries(rec).map(([id, r]) => ({ id, level: Math.max(0, Math.min(100, Math.floor(Number(r && r.level) || 0))), xp: Number(r && r.xp) || 0 }))
      .filter((s) => s.level > 0 && SKILLS.has(s.id))
      .sort((x, y) => y.level - x.level || y.xp - x.xp || x.id.localeCompare(y.id));
  };
  const skillView = (s) => {
    const def = SKILLS.get(s.id) || {};
    const tier = tierOf(s.level);
    return { id: s.id, name: String(def.label || s.id), level: s.level, tier, tierName: TIER_NAMES[tier], epithet: String(def.title || '') };
  };
  const rankWord = (level, fighting) => {
    let word = 'Novice';
    for (const [floor, w] of TITLES.ranks || []) if (level >= floor) word = w;
    return fighting && word === 'Adept' && TITLES.fightingAdept ? TITLES.fightingAdept : word;
  };
  const primarySchool = (a) => { try { return typeof globalThis.__dboSchoolsPrimary === 'function' ? String(globalThis.__dboSchoolsPrimary(a) || '') : ''; } catch (e) { return ''; } };
  // Every title the character qualifies for, best first: [{ id, label, epithet }]
  const titlesFor = (a, levels) => {
    const all = levels || skillLevels(a);
    const top = all.slice(0, 3);
    const min = Number(TITLES.minLevel) || 25;
    const lv = new Map(top.map((s) => [s.id, s.level]));
    const has = (id) => (lv.get(id) || 0) >= min;
    const out = [];
    const add = (cls, label, ids) => {
      const avg = ids.reduce((n, id) => n + (lv.get(id) || 0), 0) / ids.length;
      const lead = ids.slice().sort((x, y) => (lv.get(y) || 0) - (lv.get(x) || 0))[0];
      out.push({ id: cls.id, label: `${rankWord(avg, !!cls.fighting)} ${label}`, epithet: String((SKILLS.get(lead) || {}).title || '') });
    };
    for (const cls of TITLES.classes || []) {
      if (cls.professions) {
        const first = top[0], second = top[1];
        const name = first && cls.professions[first.id];
        if (name && first.level >= 1 && first.level - (second ? second.level : 0) >= (Number(cls.lead) || 0)) add(cls, name, [first.id]);
        continue;
      }
      if (cls.top) {
        if (!top[0] || top[0].id !== cls.top || !has(cls.top)) continue;
        const label = cls.bySchool ? (cls.bySchool[primarySchool(a)] || cls.label) : cls.label;
        add(cls, label, [cls.top]);
        continue;
      }
      if (cls.atLeast) {
        const got = (cls.of || []).filter(has);
        if (got.length >= cls.atLeast) add(cls, cls.label, got);
        continue;
      }
      const all2 = cls.all || [];
      if (!all2.length || !all2.every(has)) continue;
      const anyGot = (cls.any || []).filter(has);
      if (cls.any && !anyGot.length) continue;
      add(cls, cls.label, all2.concat(anyGot));
    }
    if (!out.length) {
      if (top[0] && top[0].level >= min) out.push({ id: 'adventurer', label: `${rankWord(top[0].level, false)} ${TITLES.adventurer || 'Adventurer'}`, epithet: String((SKILLS.get(top[0].id) || {}).title || '') });
      else out.push({ id: 'wanderer', label: TITLES.wanderer || 'Wanderer', epithet: '' });
    }
    return out;
  };

  // ---- the pieces of the page -----------------------------------------------------------------------------------
  const ordinal = (n) => { const v = n % 100; return `${n}${v >= 11 && v <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`; };
  const clockView = () => {
    const c = globalThis.__dboClock;
    if (!c || typeof c.summary !== 'function') return { date: '', time: '', moons: '' };
    const s = c.summary();
    const total = Math.round((Number(s.hour) || 0) * 60) % 1440;
    const hh = Math.floor(total / 60), mm = total % 60;
    const part = hh >= 5 && hh < 12 ? 'in the morning' : hh >= 12 && hh < 17 ? 'in the afternoon' : hh >= 17 && hh < 22 ? 'in the evening' : 'at night';
    return { date: `${ordinal(Number(s.day) || 1)} of ${s.month}, 4E ${s.year}`, time: `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${part}`,
      moons: s.phaseName ? `The moons are ${s.phaseName}.` : '' };
  };
  const RACE_NAMES = globalThis.__dboRaceNames instanceof Map ? globalThis.__dboRaceNames : (globalThis.__dboRaceNames = new Map());
  const raceName = (raceId) => {
    const id = Number(raceId) >>> 0;
    if (!id) return 'Unknown';
    if (RACE_NAMES.has(id)) return RACE_NAMES.get(id);
    let name = 'Unknown';
    try {
      const rec = mp.lookupEspmRecordById(id); const edid = rec && rec.record && rec.record.editorId;
      if (edid) name = String(edid).replace(/Race(Vampire)?$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
    } catch (e) { /* unknown race */ }
    RACE_NAMES.set(id, name);
    return name;
  };
  const hm = (ms) => { const m = Math.floor(Math.max(0, Number(ms) || 0) / 60000); return `${Math.floor(m / 60)} h ${m % 60} min`; };
  const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const dateText = (t) => { if (!t) return ''; const d = new Date(Number(t)); return `${d.getUTCDate()} ${MONTHS_EN[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
  const statsData = (a) => { try { return typeof globalThis.__dboStatsData === 'function' ? globalThis.__dboStatsData(a) : null; } catch (e) { return null; } };

  const profileView = (a) => {
    const levels = skillLevels(a);
    const titles = titlesFor(a, levels);
    const p = profileDoc(a) || {};
    const chosen = titles.find((t) => t.id === p.titleId) || titles[0];
    const st = statsData(a);
    const app = get(a, 'appearance', {}) || {};
    return {
      name: String(nameOf(a) || ''), race: raceName(app.raceId), playtime: st ? hm(st.playMs) : '',
      created: st && st.created ? dateText(st.created) : '', joined: st && st.joined ? dateText(st.joined) : '',
      backstory: String(p.backstory || ''), origin: String(p.origin || ''), backstoryMax: C.backstoryMax, originMax: C.originMax,
      skills: levels.slice(0, 3).map(skillView),
      title: chosen.label, titleEpithet: chosen.epithet, titleId: chosen.id,
      titles: titles.length > 1 ? titles.map((t) => ({ id: t.id, label: t.label })) : [],
    };
  };
  const km = (units) => Number(units) / 70 / 1000;
  const statsView = (a) => {
    const st = statsData(a);
    if (!st) return { groups: [] };
    const n = (v) => String(Math.max(0, Math.floor(Number(v) || 0)));
    return { groups: [
      { name: 'Character History', rows: [
        { label: 'Joined the server', value: st.joined ? dateText(st.joined) : 'Not known', hint: 'Your first sign-in with the launcher' },
        { label: 'Character created', value: st.created ? dateText(st.created) : 'Before counting began' },
        { label: 'Counted since', value: dateText(st.since) },
      ] },
      { name: 'Time & Travel', rows: [
        { label: 'Total playtime', value: hm(st.playMs) },
        { label: 'Sessions', value: n(st.sessions) },
        { label: 'Longest session', value: hm(st.longestMs) },
        { label: 'Average session', value: hm(st.averageMs) },
        { label: 'Distance travelled', value: `${km(st.distanceUnits).toFixed(1)} km (${(km(st.distanceUnits) * 0.621371).toFixed(1)} mi)` },
      ] },
      { name: 'Combat', rows: [
        { label: 'Enemies killed', value: n(st.enemiesKilled) },
        { label: 'Players killed', value: n(st.playerKills), hint: 'The finishing blow' },
        { label: 'Killed by players', value: n(st.killedByPlayers) },
        { label: 'Times downed', value: n(st.downs) },
        { label: 'Players downed', value: n(st.playersDowned) },
      ] },
      { name: 'Crime & Law', rows: [
        { label: 'Times robbed', value: n(st.timesRobbed) },
        { label: 'People robbed', value: n(st.peopleRobbed) },
        { label: 'Pockets picked', value: n(st.pickpockets) },
        { label: 'Times pickpocketed', value: n(st.timesPickpocketed) },
        { label: 'Jail time served', value: hm(st.jailMs) },
      ] },
      { name: 'Activities', rows: [
        { label: 'Trades completed', value: n(st.trades) },
        { label: 'Dungeons cleared', value: n(st.dungeonsCleared) },
        { label: 'Spells learned', value: n(st.spellsLearned) },
      ] },
    ] };
  };
  // keep: a redraw keeps the faction panel's nonce, so a faction click in flight is not refused by the clock tick
  const factionView = (a, keep) => { try { return typeof globalThis.__dboFactionPayload === 'function' ? globalThis.__dboFactionPayload(a, !!keep) : null; } catch (e) { log('journal: faction view failed', e.message); return null; } };
  const superView = (a) => { try { return typeof globalThis.__dboSuperProgress === 'function' ? globalThis.__dboSuperProgress(a) : null; } catch (e) { return null; } };

  const payload = (a, st, extra) => Object.assign({
    type: 'journal', id: WIDGET_ID, nonce: st.nonce, clock: clockView(), profile: profileView(a),
    faction: 'faction' in (extra || {}) ? extra.faction : factionView(a, !(extra && extra.tab === 'profile' && extra.fresh)), supernatural: superView(a), stats: statsView(a),
  }, extra || {}, { fresh: undefined });
  // focus only on opening: a redraw is data only and never moves the keyboard (the relay's refresh)
  const draw = (a, st, extra, focus) => { try { openWidget(a, payload(a, st, extra), !!focus); } catch (e) { log('journal: draw failed for', display(a), e.message); } };

  // ---- opening and closing --------------------------------------------------------------------------------------
  const open = (a) => {
    const st = { nonce: mkNonce(a), tab: 'profile', at: Date.now() };
    J.open.set(a >>> 0, st);
    draw(a, st, { tab: 'profile', fresh: true }, true);
    try { if (typeof globalThis.__dboInteractionIdle === 'function' && globalThis.__dboInteractionIdle(a, 'journal')) J.idleAt.set(a >>> 0, Date.now()); } catch (e) { /* no idle */ }
  };
  // F3 (gamemode.js factionMenuRequest): true when the journal took it
  globalThis.__dboJournalRequest = (a) => {
    if (!C.enabled || !(typeof hasCap === 'function' && hasCap(a, 'journal'))) return false;
    open(a >>> 0);
    return true;
  };
  const ended = (a) => {
    J.open.delete(a >>> 0);
    const began = J.idleAt.get(a >>> 0);
    J.idleAt.delete(a >>> 0);
    if (began) { try { sendPacket(a, { customPacketType: 'dboIdleStop', anim: IDLE_ANIM }); } catch (e) { /* offline */ } }
  };
  const fresh = (a, args) => { const st = J.open.get(a >>> 0); return st && String((args || [])[0] || '') === st.nonce ? st : null; };
  onUi('journalClose', (a, args) => { if (!fresh(a, args)) return; ended(a); closeWidget(a, WIDGET_ID); });
  onUi('close', (a, args, widgetId) => { if (Number(widgetId) === WIDGET_ID && J.open.has(a >>> 0)) ended(a); });
  // guilds.js: while the journal is open a faction answer redraws its Faction tab, not panel 37 (true when it did)
  globalThis.__dboJournalFaction = (a, factionPayload) => {
    const st = J.open.get(a >>> 0);
    if (!st) return false;
    st.tab = 'faction';
    draw(a, st, { tab: 'faction', faction: factionPayload }, false);
    return true;
  };
  globalThis.__dboJournalIsOpen = (a) => J.open.has(a >>> 0);

  // ---- the profile ------------------------------------------------------------------------------------------------
  // Newlines stay; every other control character goes
  const clean = (v, max) => String(v === undefined || v === null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').slice(0, max);
  const answer = (a, st, text, kind) => { st.nonce = mkNonce(a); draw(a, st, { result: text, resultKind: kind }, false); };
  onUi('journalProfile', (a, args) => {
    const st = fresh(a, args); if (!st) return;
    const now = Date.now();
    if (now - (J.savedAt.get(a >>> 0) || 0) < C.saveEveryMs) return answer(a, st, 'Wait a moment before saving again.', 'refused');
    const backstory = clean(args[1], C.backstoryMax), origin = clean(args[2], C.originMax);
    let blocked = false;
    try { blocked = typeof globalThis.__dboTextBlocked === 'function' && (globalThis.__dboTextBlocked(backstory) || globalThis.__dboTextBlocked(origin)); } catch (e) { blocked = false; }
    if (blocked) return answer(a, st, 'Some of those words will not do here. Change them and save again.', 'refused');
    const p = profileDoc(a);
    if (!p) return answer(a, st, 'Your journal cannot be written just now. Try again later.', 'refused');
    J.savedAt.set(a >>> 0, now);
    p.backstory = backstory; p.origin = origin; p.savedAt = now;
    touchDoc(a);
    log(`journal: ${display(a)} saved their story (${backstory.length} + ${origin.length} characters)`);
    answer(a, st, 'Your story is saved.', 'ok');
  });
  onUi('journalTitle', (a, args) => {
    const st = fresh(a, args); if (!st) return;
    const want = String((args || [])[1] || '');
    const t = titlesFor(a).find((x) => x.id === want);
    if (!t) return answer(a, st, 'You have not earned that title.', 'refused');
    const p = profileDoc(a);
    if (!p) return answer(a, st, 'Your journal cannot be written just now. Try again later.', 'refused');
    p.titleId = t.id;
    touchDoc(a);
    answer(a, st, `You are now known as ${t.label}.`, 'ok');
  });

  // The clock header moves on while the journal is open; a player gone offline closes it
  every('journalClock', C.clockRedrawSeconds * 1000, () => {
    const online = new Set(onlineActors().map((x) => x >>> 0));
    for (const [a, st] of J.open) { if (!online.has(a)) { ended(a); continue; } draw(a, st, {}, false); }
  });

  log(`journal ${C.enabled ? 'on' : 'off'}: widget ${WIDGET_ID}, ${(TITLES.classes || []).length} title classes, ${J.open.size} open`);
  return { titlesFor, clockView, profileView, statsView, payload, open };
};
