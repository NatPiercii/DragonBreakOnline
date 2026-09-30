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
// A new journal nonce is sent on opening and with every answer; faction redraws keep it. There is no timed redraw: a
// relay refresh re-appends the widget, which takes the caret out of a text box being written in (review F1).
// Answers are at most one every 3 s per player: a request inside that is kept (the latest wins) and answered then.
// Opening plays the page-turn idle (idles.js "journal"): a client that knows hold (client-journal-client) keeps it until
// the dboIdleStop sent on closing; an older one plays it 10 s and ignores the stop.
// F3 is refused while dead, downed, bound or fighting; an open journal closes on any of those, and gives way to any other
// focused panel (gamemode.js openWidget), which opens first so the cursor stays (review F2).
// Backstory and origin are checked against journal-prose-filter.json only (slurs, as whole words), never the name
// filter, whose substrings refuse ordinary words; the refusal names the word (review S3).
// Stored in the character's journal file (journalstats.js, journal/<actor hex>.json): profile { backstory, origin,
// titleId, savedAt }. Titles come from journal-titles.json.
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, display, nameOf, openWidget, closeWidget, onUi, sendPacket, every, onlineActors, hasCap, skills, cfg } = api;
  const personal = typeof api.personal === 'function' ? api.personal : () => {};
  const C = Object.assign({ enabled: true, backstoryMax: 4000, originMax: 1000, saveEveryMs: 3000, combatSeconds: 8, watchSeconds: 1, sweepHours: 6 },
    (cfg && cfg.journal) || {});
  const WIDGET_ID = 50;
  const TIER_FLOORS = [1, 25, 50, 75, 90];
  const TIER_NAMES = ['Novice', 'Apprentice', 'Adept', 'Expert', 'Master'];
  // actor -> { nonce, tab, at }: open journals; savedAt: actor -> last save; idleAt: actor -> when the page-turn began
  // answerAt: actor -> last answer; queued: actor -> the latest request inside the window; gone: file hex -> sweeps missed
  const J = globalThis.__dboJournal || (globalThis.__dboJournal = { open: new Map(), savedAt: new Map(), idleAt: new Map(), seq: 0 });
  for (const k of ['answerAt', 'queued', 'gone']) if (!(J[k] instanceof Map)) J[k] = new Map();

  const readJson = (file, dflt) => { try { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); } catch (e) { return dflt; } };
  const TITLES = readJson('journal-titles.json', { ranks: [[0, 'Novice']], minLevel: 25, classes: [], wanderer: 'Wanderer', adventurer: 'Adventurer' });
  const PROSE = readJson('journal-prose-filter.json', { words: [], endings: [] });
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
  // Why the journal cannot be open now: dead, downed, bound or carried, or in a fight (a blow given or taken lately)
  const busyReason = (a, since) => {
    const id = a >>> 0;
    if (get(id, 'isDead', false) === true) {
      try { if (typeof globalThis.__dboIsDowned === 'function' && globalThis.__dboIsDowned(id)) return 'Not while you are down.'; } catch (e) { /* no downed module */ }
      return 'Not while you lie dead.';
    }
    const r = get(id, 'private.restrained', null);
    if (r && (r.boundHands || r.carried || r.captorActorId)) return 'Not while you are bound.';
    const hit = globalThis.__dboCombatAt instanceof Map ? Number(globalThis.__dboCombatAt.get(id)) || 0 : 0;
    if (hit && hit > (since || 0) && Date.now() - hit < C.combatSeconds * 1000) return 'Not in the middle of a fight.';
    return null;
  };
  const open = (a, tab) => {
    const why = busyReason(a, 0);
    if (why) { personal(a, why); return; }
    const st = { nonce: mkNonce(a), tab: tab || 'profile', at: Date.now() };
    J.open.set(a >>> 0, st);
    draw(a, st, { tab: st.tab, fresh: true }, true);
    try {
      const def = typeof globalThis.__dboInteractionIdleDef === 'function' ? globalThis.__dboInteractionIdleDef('journal') : null;
      if (typeof globalThis.__dboInteractionIdle === 'function' && globalThis.__dboInteractionIdle(a, 'journal')) J.idleAt.set(a >>> 0, { at: Date.now(), anim: def && def.anim ? String(def.anim) : '' });
    } catch (e) { /* no idle */ }
  };
  // F3 (gamemode.js factionMenuRequest) and /faction (guilds.js, tab 'faction'): true when the journal took it, refused
  // or not, so a journal client never gets panel 37
  globalThis.__dboJournalOpenTab = (a, tab) => {
    if (!C.enabled || !(typeof hasCap === 'function' && hasCap(a, 'journal'))) return false;
    open(a >>> 0, tab === 'faction' ? 'faction' : 'profile');
    return true;
  };
  globalThis.__dboJournalRequest = (a) => globalThis.__dboJournalOpenTab(a, 'profile');
  const ended = (a) => {
    const id = a >>> 0;
    J.open.delete(id);
    J.queued.delete(id);
    const idle = J.idleAt.get(id);
    J.idleAt.delete(id);
    // The stop names the idle this journal began (idles.js may be configured), so it never ends another
    if (idle) { try { sendPacket(a, Object.assign({ customPacketType: 'dboIdleStop' }, idle.anim ? { anim: idle.anim } : {})); } catch (e) { /* offline */ } }
  };
  const shut = (a) => { if (!J.open.has(a >>> 0)) return; ended(a); closeWidget(a, WIDGET_ID); };
  const fresh = (a, args) => { const st = J.open.get(a >>> 0); return st && String((args || [])[0] || '') === st.nonce ? st : null; };
  // Closing can do no harm, so a stale nonce (a click while an answer was on its way) still closes
  onUi('journalClose', (a) => shut(a));
  // gamemode.js openWidget: another focused panel (a downed, rob, feed or trade prompt) has just opened; the journal goes
  // as a plain close after it, which keeps the cursor on the new one
  globalThis.__dboJournalYield = (a, widgetId) => { if (Number(widgetId) !== WIDGET_ID) shut(a); };
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
  // One answer every saveEveryMs per player, whatever it says: a request inside the window is kept, the latest one wins,
  // and it is answered when the window ends, so a scripted client gets one redraw per window and a real one still gets
  // its answer (the front waits for a new nonce)
  const limited = (a, run) => {
    const id = a >>> 0;
    const wait = C.saveEveryMs - (Date.now() - (J.answerAt.get(id) || 0));
    if (wait <= 0) { J.answerAt.set(id, Date.now()); run(); return; }
    const had = J.queued.has(id);
    J.queued.set(id, run);
    if (!had) setTimeout(() => { const f = J.queued.get(id); J.queued.delete(id); if (!f || !J.open.has(id)) return; J.answerAt.set(id, Date.now()); f(); }, wait);
  };
  // The first word of the text that is on the prose list, as the writer wrote it; null when there is none
  const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'i' };
  const foldWord = (w) => String(w).toLowerCase().replace(/./gu, (c) => LEET[c] || c).replace(/[^\p{L}]/gu, '');
  const proseWords = new Set((Array.isArray(PROSE.words) ? PROSE.words : []).map((w) => foldWord(w)).filter(Boolean));
  const proseEndings = [''].concat(Array.isArray(PROSE.endings) ? PROSE.endings.map(String) : []);
  const proseProblem = (text) => {
    if (!proseWords.size) return null;
    for (const raw of String(text || '').split(/[\s\-\u2013\u2014/]+/)) {
      const f = foldWord(raw);
      if (!f) continue;
      for (const end of proseEndings) if ((!end || f.endsWith(end)) && proseWords.has(end ? f.slice(0, -end.length) : f)) return raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    }
    return null;
  };
  const flushDoc = () => { try { if (typeof globalThis.__dboStatsFlush === 'function') globalThis.__dboStatsFlush(); } catch (e) { log('journal: flush after a save failed', e.message); } };
  onUi('journalProfile', (a, args) => {
    if (!fresh(a, args)) return;
    const backstory = clean(args[1], C.backstoryMax), origin = clean(args[2], C.originMax);
    limited(a, () => {
      const st = J.open.get(a >>> 0); if (!st) return;
      const bad = proseProblem(backstory) || proseProblem(origin);
      if (bad) return answer(a, st, `The word "${bad}" will not do here. Change it and save again.`, 'refused');
      const p = profileDoc(a);
      if (!p) return answer(a, st, 'Your journal cannot be written just now. Try again later.', 'refused');
      p.backstory = backstory; p.origin = origin; p.savedAt = Date.now();
      touchDoc(a);
      // Written at once: "saved" must survive a crash before the next minute's flush
      flushDoc();
      log(`journal: ${display(a)} saved their story (${backstory.length} + ${origin.length} characters)`);
      answer(a, st, 'Your story is saved.', 'ok');
    });
  });
  onUi('journalTitle', (a, args) => {
    if (!fresh(a, args)) return;
    limited(a, () => chooseTitle(a, args));
  });
  const chooseTitle = (a, args) => {
    const st = J.open.get(a >>> 0); if (!st) return;
    const want = String((args || [])[1] || '');
    const t = titlesFor(a).find((x) => x.id === want);
    if (!t) return answer(a, st, 'You have not earned that title.', 'refused');
    const p = profileDoc(a);
    if (!p) return answer(a, st, 'Your journal cannot be written just now. Try again later.', 'refused');
    p.titleId = t.id;
    touchDoc(a);
    answer(a, st, `You are now known as ${t.label}.`, 'ok');
  };

  // An open journal closes when its player goes offline, down or dead, is bound, or is hit (the clock header is not
  // redrawn: see F1 above)
  every('journalWatch', C.watchSeconds * 1000, () => {
    const online = new Set(onlineActors().map((x) => x >>> 0));
    for (const [a, st] of J.open) {
      if (!online.has(a)) { ended(a); continue; }
      const why = busyReason(a, st.at);
      if (why) { shut(a); personal(a, `Your journal closes. ${why.replace(/^Not /, 'You cannot read ').replace(/\.$/, '')}.`); }
    }
  });

  // A deleted character's journal file goes with it. Nothing tells the gameplay that a character was deleted, so a
  // sweep looks for files whose character no longer exists (any read of a deleted form throws; guilds.js prunes rosters
  // the same way): gone on two sweeps running, the file is deleted. If most files look gone at once, the check itself is
  // broken (a boot, a load problem) and nothing is removed.
  const sweep = () => {
    const d = globalThis.__dboJournalDoc;
    const dir = d && d.dir;
    if (!dir) return 0;
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /^[0-9a-f]+\.json$/.test(f)); } catch (e) { return 0; }
    const gone = [];
    for (const f of files) {
      const id = parseInt(f, 16) >>> 0;
      let exists = true;
      try { mp.get(id, 'type'); } catch (e) { exists = false; }
      if (!exists) gone.push(f); else J.gone.delete(f);
    }
    if (files.length > 3 && gone.length * 2 > files.length) { log(`journal: ${gone.length} of ${files.length} files look deleted at once; the check is suspect, nothing removed`); return 0; }
    let removed = 0;
    for (const f of gone) {
      const n = (J.gone.get(f) || 0) + 1;
      if (n < 2) { J.gone.set(f, n); continue; }
      J.gone.delete(f);
      try { if (typeof d.forget === 'function') d.forget(parseInt(f, 16) >>> 0); fs.unlinkSync(path.join(dir, f)); removed++; log(`journal: ${f} deleted, its character no longer exists`); }
      catch (e) { log(`journal: could not delete ${f}: ${e.message}`); }
    }
    return removed;
  };
  every('journalSweep', C.sweepHours * 3600000, sweep);

  log(`journal ${C.enabled ? 'on' : 'off'}: widget ${WIDGET_ID}, ${(TITLES.classes || []).length} title classes, ${J.open.size} open`);
  return { titlesFor, clockView, profileView, statsView, payload, open, proseProblem, sweep, busyReason };
};
