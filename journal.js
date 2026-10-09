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
//
// The F3 hub (specs/f3-hub-design.md section 2; H1), for a front whose dbo:uiCaps lists 'journalHub'. An older front
// keeps the payload above, unchanged. The hub payload carries the frame and only the open tab's section:
//     { type: 'journal', id: 50, nonce, hub: 1, tabs: [{ id, label, badge?, pinned? }], tab, clock, head: { name, title, race },
//       [tab]: <that tab's section>, [extra]: <a section hosted inside that tab>, result?, resultKind? }
//   Tabs, in this order: profile, faction, court, stats, skills, magic, deity, supernatural, settings (pinned right).
//   Client -> server: journalTab [nonce, tab, focus?]: answered at once, outside the 3 s rule, and the nonce is kept,
//   so a click in flight on another tab is not refused. F3 reopens the last tab used this session.
// Sections come from one registry, globalThis.__dboJournalSections[id] = { visible(a), view(a, opts), label?(a), tab? }
// (contract agreed with F3-build-b, 3 Oct): visible returns false, true or { badge: n }; view(a, { staff, keep, focus })
// is called only for the open tab and lands at payload[id]; an entry with tab: '<host>' is no tab of its own but a
// section drawn inside that host tab (faction's staff view: factionStaff). This file registers profile, faction,
// stats, supernatural and settings itself. A tab other than those four first ones is offered only to a front that
// names it in its caps ('journalTab:<id>'), so a newer server never sends a tab an older front cannot draw.
// Hooks for the modules behind the tabs: __dboJournalFresh(a, nonce), __dboJournalAnswer(a, tab, text, kind),
// __dboJournalLimited(a, fn) (fn runs inside the 3 s rule; a returned { tab, text, kind } is answered),
// __dboJournalRedraw(a, tab?) and __dboJournalOpenTab(a, tab) (false when this client cannot draw that tab, so the
// caller falls back to its own panel).
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, display, nameOf, openWidget, closeWidget, onUi, sendPacket, every, onlineActors, hasCap, skills, cfg } = api;
  const personal = typeof api.personal === 'function' ? api.personal : () => {};
  const isAdmin = typeof api.isAdmin === 'function' ? api.isAdmin : () => false;
  const C = Object.assign({ enabled: true, backstoryMax: 4000, originMax: 1000, saveEveryMs: 3000, combatSeconds: 8, watchSeconds: 1, sweepHours: 6, sweepAfterBootMinutes: 30 },
    (cfg && cfg.journal) || {});
  const WIDGET_ID = 50;
  const TIER_FLOORS = [1, 25, 50, 75, 90];
  const TIER_NAMES = ['Novice', 'Apprentice', 'Adept', 'Expert', 'Master'];
  // actor -> { nonce, tab, at }: open journals; savedAt: actor -> last save; idleAt: actor -> when the page-turn began
  // answerAt: actor -> last answer; queued: actor -> the latest request inside the window; gone: file key -> sweeps that listed it
  const J = globalThis.__dboJournal || (globalThis.__dboJournal = { open: new Map(), savedAt: new Map(), idleAt: new Map(), seq: 0 });
  // lastTab: actor -> the hub tab last opened this session; tabAt: actor -> the last tab answer (a flood guard)
  for (const k of ['answerAt', 'queued', 'gone', 'lastTab', 'tabAt']) if (!(J[k] instanceof Map)) J[k] = new Map();

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
  // own: the player's own journal; staff reading another's never see that player's reroll tokens (patrons.js)
  const rerollGroup = (a) => { try { return typeof globalThis.__dboRerollStatsGroup === 'function' ? globalThis.__dboRerollStatsGroup(a) : null; } catch (e) { log('journal: reroll tokens failed', e.message); return null; } };
  // What /status reports (gamemode.js statusParts), first on the Stats tab: Death's Chill above all, which an undead never
  // sees among active effects because it resists the disease it counts as (#suggestions 'Chill of the grave', 9 Oct)
  const EFFECTS = [['chill', ["Death's Chill"]], ['hunger', ['Hunger']], ['rest', ['Well Rested', 'Well Fed']], ['sentence', ['Sentence']]];
  const effectsGroup = (a) => {
    const parts = globalThis.__dboStatusParts;
    if (!(parts instanceof Map)) return null;
    const rows = [];
    for (const [key, names] of EFFECTS) {
      const part = parts.get(key);
      if (!part || typeof part.fn !== 'function') continue;
      let line = null;
      try { line = part.fn(a); } catch (e) { log(`journal: status ${key} failed`, e.message); continue; }
      if (typeof line !== 'string' || !line.trim()) continue;
      for (const piece of line.trim().split(', ')) {
        const name = names.find((n) => piece.startsWith(n));
        const row = name ? { label: name, value: piece.slice(name.length).trim() } : { label: piece, value: '' };
        if (key === 'chill') row.hint = 'Shown here because the undead do not see it among their active effects';
        rows.push(row);
      }
    }
    return rows.length ? { name: 'Current Effects', rows } : null;
  };
  const statsView = (a, own) => {
    const st = statsData(a);
    const tokens = own === false ? null : rerollGroup(a);
    const effects = own === false ? null : effectsGroup(a);
    if (!st) return { groups: [effects, tokens].filter(Boolean) };
    const n = (v) => String(Math.max(0, Math.floor(Number(v) || 0)));
    return { groups: (effects ? [effects] : []).concat([
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
    ]).concat(tokens ? [tokens] : []) };
  };
  // keep: a redraw keeps the faction panel's nonce, so a faction click in flight is not refused by the clock tick
  // readOnly: another's faction panel, read by staff: guilds.js makes no nonce for them
  const factionView = (a, keep, readOnly) => { try { return typeof globalThis.__dboFactionPayload === 'function' ? globalThis.__dboFactionPayload(a, !!keep, !!readOnly) : null; } catch (e) { log('journal: faction view failed', e.message); return null; } };
  const superView = (a) => { try { return typeof globalThis.__dboSuperProgress === 'function' ? globalThis.__dboSuperProgress(a) : null; } catch (e) { return null; } };

  const payload = (a, st, extra) => Object.assign({
    type: 'journal', id: WIDGET_ID, nonce: st.nonce, clock: clockView(), profile: profileView(a),
    faction: 'faction' in (extra || {}) ? extra.faction : factionView(a, !(extra && extra.tab === 'profile' && extra.fresh)), supernatural: superView(a), stats: statsView(a),
  }, extra || {}, { fresh: undefined });
  // ---- the hub: tabs and lazy sections ----------------------------------------------------------------------------
  const SECTIONS = globalThis.__dboJournalSections && typeof globalThis.__dboJournalSections === 'object'
    ? globalThis.__dboJournalSections : (globalThis.__dboJournalSections = {});
  const ORDER = ['profile', 'faction', 'court', 'stats', 'skills', 'magic', 'deity', 'supernatural', 'settings'];
  const LABELS = { profile: 'Profile', faction: 'Faction', court: 'Court', stats: 'Stats', skills: 'Skills', magic: 'Magic', deity: 'Deity', supernatural: 'Supernatural', settings: 'Settings' };
  const PINNED = new Set(['settings']);
  // Every journalHub front draws these; any other tab needs the front to name it ('journalTab:<id>')
  const CORE = new Set(['profile', 'faction', 'stats', 'supernatural']);
  const isHub = (a) => typeof hasCap === 'function' && hasCap(a, 'journalHub');
  const canDraw = (a, id) => CORE.has(id) || (typeof hasCap === 'function' && hasCap(a, `journalTab:${id}`));
  // One draw asks each module once: visible() and view() of the supernatural tab share their answer
  const memo = (m, k, f) => (k in m ? m[k] : (m[k] = f()));
  const factionTabInfo = (a) => { try { return typeof globalThis.__dboFactionTabInfo === 'function' ? globalThis.__dboFactionTabInfo(a) : null; } catch (e) { return null; } };
  SECTIONS.profile = { visible: () => true, view: (a) => profileView(a) };
  SECTIONS.stats = { visible: () => true, view: (a, o) => statsView(a, !(o && o.readOnly)) };
  // A member, someone invited, or staff (who see every faction); without guilds.js's count it shows, as before the hub.
  // Hold and stronghold memberships count here only when the viewer's front has no Court tab (m.viewer: who is looking)
  SECTIONS.faction = {
    visible: (a, m) => {
      const i = factionTabInfo(a); if (!i) return true;
      const court = canDraw(m && m.viewer !== undefined ? m.viewer : a, 'court');
      const member = (i.member || 0) + (court ? 0 : i.courtMember || 0), invites = (i.invites || 0) + (court ? 0 : i.courtInvites || 0);
      if (!(member || invites || i.staff)) return false;
      return invites ? { badge: invites } : true;
    },
    view: (a, o) => factionView(a, !!(o && o.keep), !!(o && o.readOnly)),
  };
  SECTIONS.supernatural = { visible: (a, m) => !!memo(m || {}, 'super', () => superView(a)), view: (a, o) => memo((o && o.memo) || {}, 'super', () => superView(a)),
    label: (a, m) => { const v = memo(m || {}, 'super', () => superView(a)); return (v && v.label) || 'Supernatural'; } };
  // Magic (L4's schools.js on magic-flow-2: __dboMagicView, { open: false } off the Wheel; specs 3.3). Its own cheap
  // __dboMagicOpen(a) is asked first when schools.js has one; otherwise the view is built, once per draw (memo)
  const magicView = (a) => (typeof globalThis.__dboMagicView === 'function' ? globalThis.__dboMagicView(a) : null);
  SECTIONS.magic = {
    visible: (a, m) => {
      if (typeof globalThis.__dboMagicOpen === 'function') return !!globalThis.__dboMagicOpen(a);
      const v = memo(m || {}, 'magic', () => magicView(a)); return !!(v && v.open);
    },
    view: (a, o) => memo((o && o.memo) || {}, 'magic', () => magicView(a)),
  };
  // Settings belong to the player's PC: the server sends only what the page cannot know (H3-H5 add to it)
  SECTIONS.settings = { visible: () => true, view: (a, o) => settingsView(a, o) };
  // focus { section, peer }: X's "Voice settings for <name>" opens Voice on that player
  const settingsView = (a, o) => {
    const v = { staff: !!isAdmin(a) };
    try { if (typeof globalThis.__dboJournalSettingsExtra === 'function') Object.assign(v, globalThis.__dboJournalSettingsExtra(a, o) || {}); } catch (e) { log('journal: settings extra failed', e.message); }
    const f = o && o.focus && typeof o.focus === 'object' ? o.focus : null;
    if (f && typeof f.section === 'string' && /^[a-z]{1,16}$/.test(f.section)) v.section = f.section;
    if (f && typeof f.peer === 'string' && /^[0-9a-f]{1,8}$/.test(f.peer)) v.focusPeer = f.peer;
    return v;
  };
  const sectionOf = (id) => { const s = SECTIONS[id]; return s && typeof s === 'object' && typeof s.view === 'function' ? s : null; };
  const call = (f, ...args) => { try { return f(...args); } catch (e) { log('journal: a section failed', e.message); return undefined; } };
  // The tabs this player sees, in ORDER (unknown registered ids before Settings), each with its badge. subject: whose
  // journal it is (a staff member reading another's: the viewer's front decides what can be drawn, the subject what shows)
  const tabsFor = (a, m, subject) => {
    const who = subject === undefined ? a : subject;
    if (m && typeof m === 'object') m.viewer = a;
    const ids = ORDER.filter((id) => id !== 'settings').concat(Object.keys(SECTIONS).filter((id) => !ORDER.includes(id))).concat(['settings']);
    const out = [];
    for (const id of ids) {
      const s = sectionOf(id);
      if (!s || s.tab || !canDraw(a, id)) continue;
      // Another's journal shows their character, never their Settings (those belong to their PC, and carry who is near them)
      if (id === 'settings' && (who >>> 0) !== (a >>> 0)) continue;
      let vis = typeof s.visible === 'function' ? call(s.visible, who, m) : true;
      // A section hosted in this tab can show it (a staff view of an empty Faction tab)
      for (const [xid, x] of Object.entries(SECTIONS)) {
        if (vis || !x || x.tab !== id || typeof x.visible !== 'function' || !canDraw(a, xid)) continue;
        vis = call(x.visible, who, m);
      }
      if (!vis) continue;
      const t = { id, label: String((typeof s.label === 'function' ? call(s.label, who, m) : s.label) || LABELS[id] || id) };
      const badge = vis && typeof vis === 'object' ? Number(vis.badge) || 0 : 0;
      if (badge > 0) t.badge = String(badge);
      if (PINNED.has(id)) t.pinned = true;
      out.push(t);
    }
    return out;
  };
  const headView = (a, profile) => {
    if (profile) return { name: profile.name, title: profile.title, race: profile.race };
    const levels = skillLevels(a);
    const titles = titlesFor(a, levels);
    const p = profileDoc(a) || {};
    const chosen = titles.find((t) => t.id === p.titleId) || titles[0];
    return { name: String(nameOf(a) || ''), title: chosen.label, race: raceName((get(a, 'appearance', {}) || {}).raceId) };
  };
  const hubPayload = (a, st, extra) => {
    const x = extra || {};
    const m = {};
    const subj = st.viewOf || a;
    const tabs = tabsFor(a, m, subj);
    const want = x.tab || st.tab;
    const tab = tabs.some((t) => t.id === want) ? want : (tabs[0] ? tabs[0].id : 'profile');
    st.tab = tab;
    const out = { type: 'journal', id: WIDGET_ID, nonce: st.nonce, hub: 1, tabs, tab, clock: clockView() };
    // Read-only: another's faction panel keeps its nonce, so reading it never refuses their own click
    const opts = { staff: !!isAdmin(a), keep: st.viewOf ? true : !x.fresh, focus: x.focus, memo: m, readOnly: !!st.viewOf };
    const fill = (id) => { if (id in x) { out[id] = x[id]; return; } const s = sectionOf(id); const v = s ? call(s.view, subj, opts) : undefined; out[id] = v === undefined ? null : v; };
    fill(tab);
    for (const [xid, xs] of Object.entries(SECTIONS)) if (xs && xs.tab === tab && typeof xs.view === 'function' && canDraw(a, xid)) fill(xid);
    out.head = headView(subj, tab === 'profile' ? out.profile : null);
    // The subject and the opening, so a front reading another's journal starts its section cache afresh for each
    if (st.viewOf) { out.readOnly = 1; out.subject = (st.viewOf >>> 0).toString(16); }
    out.opened = st.opened;
    for (const k of ['result', 'resultKind']) if (x[k] !== undefined) out[k] = x[k];
    return out;
  };
  // focus only on opening: a redraw is data only and never moves the keyboard (the relay's refresh)
  const draw = (a, st, extra, focus) => {
    try { openWidget(a, st.hub ? hubPayload(a, st, extra) : payload(a, st, extra), !!focus); } catch (e) { log('journal: draw failed for', display(a), e.message); }
  };

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
  // viewOf: a staff member reading another character's journal (__dboJournalOpenFor); every action is refused
  const open = (a, tab, focus, viewOf) => {
    const why = busyReason(a, 0);
    if (why) { personal(a, why); return; }
    const st = { nonce: mkNonce(a), tab: tab || 'profile', at: Date.now(), hub: isHub(a), opened: ++J.seq };
    if (viewOf) st.viewOf = viewOf >>> 0;
    J.open.set(a >>> 0, st);
    if (st.hub && !st.viewOf) J.lastTab.set(a >>> 0, st.tab);
    draw(a, st, Object.assign({ tab: st.tab, fresh: true }, focus && typeof focus === 'object' ? { focus } : {}), true);
    try {
      const def = typeof globalThis.__dboInteractionIdleDef === 'function' ? globalThis.__dboInteractionIdleDef('journal') : null;
      if (typeof globalThis.__dboInteractionIdle === 'function' && globalThis.__dboInteractionIdle(a, 'journal')) J.idleAt.set(a >>> 0, { at: Date.now(), anim: def && def.anim ? String(def.anim) : '' });
    } catch (e) { /* no idle */ }
  };
  // F3 (gamemode.js factionMenuRequest) and /faction (guilds.js, tab 'faction'): true when the journal took it, refused
  // or not, so a journal client never gets panel 37
  // A hub front opens any tab it can draw and the player may see; asked for one it cannot (a tab from a newer package,
  // or Magic without Arcane Arts or Priest), this is false and the caller opens its own panel. An older journal front
  // opens Profile or Faction as before.
  const tabOk = (a, tab, subject) => {
    const s = sectionOf(tab);
    if (!s || s.tab || !canDraw(a, tab)) return false;
    return tabsFor(a, {}, subject).some((t) => t.id === tab);
  };
  // focus (a hub front): handed to the tab's view, as a journalTab focus is (X's Voice settings names the player)
  globalThis.__dboJournalOpenTab = (a, tab, focus) => {
    if (!C.enabled || !(typeof hasCap === 'function' && hasCap(a, 'journal'))) return false;
    const id = String(tab || 'profile');
    if (isHub(a)) {
      if (!tabOk(a, id)) return false;
      open(a >>> 0, id, focus);
      return true;
    }
    if (id !== 'profile' && id !== 'faction') return false;
    open(a >>> 0, id);
    return true;
  };
  // Staff: another character's journal, read only (the admin panel's Players tab). The viewer's hub front draws it;
  // every action in it is refused. True when it opened.
  globalThis.__dboJournalOpenFor = (staff, target, tab) => {
    const s = staff >>> 0, t = target >>> 0;
    if (!C.enabled || !t || s === t || !isAdmin(s) || !isHub(s)) return false;
    const id = tab && tabOk(s, String(tab), t) ? String(tab) : 'profile';
    open(s, id, undefined, t);
    log(`journal: ${display(s)} reads the journal of ${display(t)} (${id})`);
    return true;
  };
  // F3 (gamemode.js factionMenuRequest, which may name a tab): a hub opens the last tab used this session
  globalThis.__dboJournalRequest = (a, tab) => {
    if (tab && globalThis.__dboJournalOpenTab(a, tab)) return true;
    const last = isHub(a) ? J.lastTab.get(a >>> 0) : null;
    if (last && last !== 'profile' && globalThis.__dboJournalOpenTab(a, last)) return true;
    return globalThis.__dboJournalOpenTab(a, 'profile');
  };
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
  // An action's nonce check; a read-only journal (another's) takes none. seen: the same check for browsing (a tab switch)
  const seen = (a, args) => { const st = J.open.get(a >>> 0); return st && String((args || [])[0] || '') === st.nonce ? st : null; };
  const fresh = (a, args) => { const st = seen(a, args); return st && !st.viewOf ? st : null; };
  // Closing can do no harm, so a stale nonce (a click while an answer was on its way) still closes
  onUi('journalClose', (a) => shut(a));
  // gamemode.js openWidget: another focused panel (a downed, rob, feed or trade prompt) has just opened; the journal goes
  // as a plain close after it, which keeps the cursor on the new one
  globalThis.__dboJournalYield = (a, widgetId) => { if (Number(widgetId) !== WIDGET_ID) shut(a); };
  onUi('close', (a, args, widgetId) => { if (Number(widgetId) === WIDGET_ID && J.open.has(a >>> 0)) ended(a); });
  // guilds.js: while the journal is open a faction answer redraws its Faction tab, not panel 37 (true when it did)
  globalThis.__dboJournalFaction = (a, factionPayload) => {
    const st = J.open.get(a >>> 0);
    if (!st || st.viewOf) return false;
    st.tab = 'faction';
    draw(a, st, { tab: 'faction', faction: factionPayload }, false);
    return true;
  };
  globalThis.__dboJournalIsOpen = (a) => J.open.has(a >>> 0);
  // The tab the open journal shows ('' when closed), so a module redraws only when its tab is in view
  globalThis.__dboJournalTabOf = (a) => { const st = J.open.get(a >>> 0); return st ? st.tab : ''; };
  // Whether this player's front draws that tab and they may see it (playermenu.js offers Voice settings… on it)
  globalThis.__dboJournalHasTab = (a, tab) => !!C.enabled && typeof hasCap === 'function' && hasCap(a, 'journal') && isHub(a) && tabOk(a >>> 0, String(tab || ''));

  // ---- a tab switch -------------------------------------------------------------------------------------------------
  // The nonce asked for is the open journal's: tab answers keep it, so only a save's answer moves it on
  const TAB_GAP_MS = 120;
  onUi('journalTab', (a, args) => {
    const id = a >>> 0;
    const st = seen(a, args);
    if (!st || !st.hub) return;
    const tab = String((args || [])[1] || '');
    const focus = (args || [])[2];
    if (!tabOk(a, tab, st.viewOf || a)) { draw(a, st, {}, false); return; }
    // A scripted flood gets one answer per gap, the latest one
    const run = () => {
      const s2 = J.open.get(id);
      if (!s2) return;
      s2.tab = tab;
      if (!s2.viewOf) J.lastTab.set(id, tab);
      J.tabAt.set(id, Date.now());
      draw(a, s2, { tab, focus: focus && typeof focus === 'object' ? focus : undefined }, false);
    };
    const wait = TAB_GAP_MS - (Date.now() - (J.tabAt.get(id) || 0));
    if (wait <= 0) return run();
    const had = st.tabQueued;
    st.tabQueued = run;
    if (!had) setTimeout(() => { const s2 = J.open.get(id); const f = s2 && s2.tabQueued; if (s2) s2.tabQueued = null; if (f) f(); }, wait);
  });

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
  // The hooks the tabs' own modules answer through (contract with F3-build-b, 3 Oct)
  globalThis.__dboJournalFresh = (a, nonce) => !!fresh(a, [nonce]);
  globalThis.__dboJournalAnswer = (a, tab, text, kind) => {
    if (!J.open.has(a >>> 0)) return false;
    limited(a, () => { const st = J.open.get(a >>> 0); if (!st) return; if (tab) st.tab = String(tab); answer(a, st, String(text || ''), kind || 'ok'); });
    return true;
  };
  // fn runs inside the 3 s rule (an action's body, not only its answer); what it returns, { tab, text, kind }, is answered
  globalThis.__dboJournalLimited = (a, fn) => {
    if (!J.open.has(a >>> 0) || typeof fn !== 'function') return false;
    limited(a, () => {
      const st = J.open.get(a >>> 0); if (!st) return;
      let r;
      try { r = fn(); } catch (e) { log('journal: an action failed for', display(a), e.message); r = { text: 'That could not be done just now.', kind: 'refused' }; }
      if (!r || typeof r !== 'object' || r.text === undefined) return;
      if (r.tab) st.tab = String(r.tab);
      answer(a, st, String(r.text), r.kind || 'ok');
    });
    return true;
  };
  // Data only, the nonce kept: a module whose state changed while its tab is open (an offer arriving)
  globalThis.__dboJournalRedraw = (a, tab) => {
    const st = J.open.get(a >>> 0);
    if (!st || (tab && st.tab !== String(tab))) return false;
    draw(a, st, {}, false);
    return true;
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
  // The Magic tab's actions: [nonce, op, ...] (firstSpell <school> <spell desc>, prepare <spell desc>, unprepare <spell desc>),
  // to schools.js __dboMagicAction, inside the 3 s rule (L4's hook, moved here from magic-flow-2 so the two edits are one)
  onUi('journalMagic', (a, args) => {
    const st0 = fresh(a, args);
    if (!st0 || !st0.hub) return;
    limited(a, () => {
      const st = J.open.get(a >>> 0); if (!st) return;
      let r;
      try { r = typeof globalThis.__dboMagicAction === 'function' ? globalThis.__dboMagicAction(a, String(args[1] || ''), args.slice(2)) : null; } catch (e) { log('journal: a magic action failed', e.message); r = null; }
      if (!r) r = { ok: false, text: 'Magic is not open just now.' };
      st.tab = 'magic';
      answer(a, st, String(r.text || ''), r.ok ? 'ok' : 'refused');
    });
  });
  // Settings, Help: Report a problem, the same report as /bug (debugsnap.js), answered in the footer
  onUi('journalReport', (a, args) => {
    const st0 = fresh(a, args);
    if (!st0 || !st0.hub) return;
    const text = clean((args || [])[1], 500);
    limited(a, () => {
      const st = J.open.get(a >>> 0); if (!st) return;
      let r;
      try { r = typeof globalThis.__dboBugReport === 'function' ? globalThis.__dboBugReport(a, text) : null; } catch (e) { log('journal: a report failed', e.message); r = null; }
      if (!r) r = { ok: false, text: 'Reports cannot be sent just now; type /bug in chat instead.' };
      st.tab = 'settings';
      answer(a, st, String(r.text || ''), r.ok ? 'ok' : 'refused');
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
    for (const a of [...J.lastTab.keys()]) if (!online.has(a)) { J.lastTab.delete(a); J.tabAt.delete(a); }
    for (const [a, st] of J.open) {
      if (!online.has(a)) { ended(a); continue; }
      const why = busyReason(a, st.at);
      if (why) { shut(a); personal(a, `Your journal closes. ${why.replace(/^Not /, 'You cannot read ').replace(/\.$/, '')}.`); }
    }
  });

  // A deleted character's journal file goes with it. Nothing tells the gameplay that a character was deleted, so a sweep
  // asks journalstats for the files no character carries the key of any more (orphans()): listed on two sweeps running,
  // the file is moved aside to removed/ (forget()). Not in the first minutes after a boot, when reads can come back
  // empty, and if most files are listed at once the check itself is suspect and nothing is moved.
  const sweep = () => {
    const d = globalThis.__dboJournalDoc;
    if (!d || typeof d.orphans !== 'function' || typeof d.forget !== 'function' || !d.dir) return 0;
    if (process.uptime() < C.sweepAfterBootMinutes * 60) return 0;
    let total = 0, keys = [];
    try { total = fs.readdirSync(d.dir).filter((f) => /^[0-9a-f]{16}\.json$/.test(f)).length; keys = d.orphans(); }
    catch (e) { log(`journal: the orphan check failed: ${e.message}`); return 0; }
    if (!Array.isArray(keys)) return 0;
    const listed = new Set(keys);
    for (const k of [...J.gone.keys()]) if (!listed.has(k)) J.gone.delete(k);
    if (total > 3 && keys.length * 2 > total) { log(`journal: ${keys.length} of ${total} files look orphaned at once; the check is suspect, nothing moved`); return 0; }
    let moved = 0;
    for (const k of keys) {
      const n = (J.gone.get(k) || 0) + 1;
      if (n < 2) { J.gone.set(k, n); continue; }
      J.gone.delete(k);
      if (d.forget(k)) { moved++; log(`journal: ${k} moved to removed/, its character no longer exists`); }
      else log(`journal: could not move ${k} aside`);
    }
    return moved;
  };
  every('journalSweep', C.sweepHours * 3600000, sweep);

  log(`journal ${C.enabled ? 'on' : 'off'}: widget ${WIDGET_ID}, ${(TITLES.classes || []).length} title classes, ${J.open.size} open`);
  return { titlesFor, clockView, profileView, statsView, payload, hubPayload, tabsFor, open, proseProblem, sweep, busyReason };
};
