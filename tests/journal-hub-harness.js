// Scripted test for the F3 hub's shell, server half (journal.js; specs/f3-hub-design.md section 2, piece H1): the tab
// list per kind of player and per front, lazy sections, the journalTab switch (nonce, flood guard, the last tab), the
// section registry other modules plug into, and the hooks they answer through (__dboJournalFresh, Answer, Limited,
// Redraw, OpenTab). An older journal front must get today's payload unchanged. Run it from this folder's parent:
//
//   node tests/journal-hub-harness.js
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
process.chdir(root);
if (!/__dboJournalSections/.test(fs.readFileSync('journal.js', 'utf8'))) {
  require('./expect')('journal-hub', 'journal.js has no hub');
  console.log('ok   skipped: this journal.js predates the F3 hub');
  process.exit(0);
}
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 600) : ''}`); if (!ok) failures++; };

let now = 1_900_000_000_000;
Date.now = () => now;

// ---- a fake world: a hub player, a staff member, an older journal front, a werewolf on the hub ----
const HUB = 0xff000020, STAFF = 0xff000021, OLD = 0xff000022, WOLF = 0xff000023, NEWER = 0xff000024;
const props = new Map();
const setp = (a, k, v) => props.set(`${a}|${k}`, v);
const mastery = (lv) => ({ skills: Object.fromEntries(Object.entries(lv).map(([id, level], i) => [id, { level, xp: 100 - i }])) });
for (const [a, name] of [[HUB, 'Aela'], [STAFF, 'Kodlak'], [OLD, 'Farkas'], [WOLF, 'Vilkas'], [NEWER, 'Ria']]) {
  setp(a, 'appearance', { name, raceId: 0x13746 });
  setp(a, 'private.mastery', mastery({ blade: 40, defense: 30 }));
}
const HUBCAPS = ['journal', 'journalHub'];
const caps = new Map([[HUB, new Set(HUBCAPS)], [STAFF, new Set(HUBCAPS)], [OLD, new Set(['journal'])], [WOLF, new Set(HUBCAPS)],
  [NEWER, new Set(HUBCAPS.concat(['journalTab:court', 'journalTab:skills', 'journalTab:settings', 'journalTab:factionStaff']))]]);
const widgets = [], closed = [], told = [];
const ui = new Map();
const timers = {};
let online = [HUB, STAFF, OLD, WOLF, NEWER];
const docs = new Map();
globalThis.__dboJournalDoc = { of: (a) => { if (!docs.has(a)) docs.set(a, {}); return docs.get(a); }, touch: () => {} };
globalThis.__dboStatsData = () => ({ since: 0, created: 0, joined: 0, playMs: 3600000, sessions: 1, longestMs: 0, averageMs: 0, distanceUnits: 0 });
let factionCalls = 0;
globalThis.__dboFactionPayload = (a, keep) => { factionCalls++; return { type: 'faction', id: 37, nonce: keep ? 'f-kept' : 'f-new', factions: [], invites: [] }; };
const tabInfo = new Map([[HUB, { member: 1, invites: 0, staff: false }], [STAFF, { member: 0, invites: 0, staff: true }], [WOLF, { member: 0, invites: 2, staff: false }], [NEWER, { member: 0, invites: 0, staff: false }]]);
globalThis.__dboFactionTabInfo = (a) => tabInfo.get(a) || { member: 0, invites: 0, staff: false };
let superCalls = 0;
globalThis.__dboSuperProgress = (a) => { superCalls++; return a === WOLF ? { kind: 'werewolf', label: 'Werewolf' } : null; };
globalThis.__dboClock = { summary: () => ({ hour: 12, day: 1, month: 'Morning Star', year: 211, phaseName: '' }) };
globalThis.__dboCombatAt = new Map();
const pending = [];
global.setTimeout = (fn, ms) => { pending.push({ fn, at: now + (Number(ms) || 0) }); return 0; };
const runDue = () => { for (let i = 0; i < pending.length;) { if (pending[i].at <= now) { const t = pending.splice(i, 1)[0]; t.fn(); } else i++; } };

const skillsDef = JSON.parse(fs.readFileSync('skills.json', 'utf8')).skills;
delete globalThis.__dboJournal;
delete globalThis.__dboJournalSections;
const load = () => {
  delete require.cache[path.resolve('journal.js')];
  ui.clear();
  return require(path.resolve('journal.js'))({
    mp: { get: (a, k) => props.get(`${a}|${k}`), lookupEspmRecordById: (id) => (id === 0x13746 ? { record: { editorId: 'NordRace' } } : null) },
    log: () => {}, display: (a) => `#${(a >>> 0).toString(16)}`, nameOf: (a) => ((props.get(`${a}|appearance`) || {}).name || ''), personal: (a, t) => told.push([a, t]),
    openWidget: (a, w, focus) => widgets.push({ a, w, focus }), closeWidget: (a, id) => closed.push([a, id]),
    onUi: (ev, fn) => { const l = ui.get(ev) || []; l.push(fn); ui.set(ev, l); }, sendPacket: () => {},
    every: (n, ms, fn) => { timers[n] = fn; }, onlineActors: () => online, cfg: {}, skills: skillsDef,
    hasCap: (a, cap) => !!(caps.get(a) && caps.get(a).has(cap)), isAdmin: (a) => a === STAFF,
  });
};
const fire = (ev, a, args, wid) => { for (const fn of ui.get(ev) || []) fn(a, args, wid === undefined ? 50 : wid); };
const last = (a) => (widgets.filter((x) => x.a === a).pop() || {}).w;
const ids = (w) => (w && w.tabs ? w.tabs.map((t) => t.id).join(',') : '');

// Two tabs from another module (F3-build-b's shape): Court, and the staff half of Faction
const courtViews = [];
globalThis.__dboJournalSections = {
  court: { visible: (a) => (a === NEWER ? { badge: 1 } : a === STAFF), view: (a, o) => { courtViews.push([a, o.focus]); return { zones: ['bruma'], focus: o.focus || null }; } },
  factionStaff: { tab: 'faction', visible: (a) => a === STAFF, view: () => ({ all: 52 }) },
  skills: { visible: () => true, view: () => ({ skills: [] }) },
};
load();

// ---- an older journal front: today's payload, untouched ----
globalThis.__dboJournalRequest(OLD);
let w = last(OLD);
check('an older journal front gets today\'s payload: no hub, no tabs, every section as before', w && !w.hub && !w.tabs && w.profile && w.profile.name === 'Farkas' && 'stats' in w && 'faction' in w && 'supernatural' in w, w && Object.keys(w));
check('...and K\'s Skills cannot open on it (the caller falls back to widget 25)', globalThis.__dboJournalOpenTab(OLD, 'skills') === false);
check('...while Faction still can, as /faction does today', globalThis.__dboJournalOpenTab(OLD, 'faction') === true && last(OLD).tab === 'faction');

// ---- the hub: tabs per player ----
factionCalls = 0; superCalls = 0;
check('F3 on the hub opens, focused', globalThis.__dboJournalRequest(HUB) === true && widgets[widgets.length - 1].focus === true);
w = last(HUB);
check('the hub payload says so, with the tab list and the open tab', w.hub === 1 && Array.isArray(w.tabs) && w.tab === 'profile', w && { hub: w.hub, tab: w.tab });
check('a guild member on a first-package front: Profile, Faction, Stats (Court and Skills are drawn only by a front that names them; Settings likewise)', ids(w) === 'profile,faction,stats', ids(w));
check('only the open tab\'s section is sent: profile yes; faction, stats, supernatural not', w.profile && w.profile.name === 'Aela' && !('faction' in w) && !('stats' in w) && !('supernatural' in w), Object.keys(w));
check('...so opening on Profile never builds the faction panel', factionCalls === 0, factionCalls);
check('the header: name, title and race', w.head && w.head.name === 'Aela' && w.head.race === 'Nord' && typeof w.head.title === 'string' && w.head.title.length > 0, w.head);
check('...and the clock', w.clock && /Morning Star/.test(w.clock.date));
check('no internal marker reaches the client (fresh, focus, memo)', !/"fresh"|"memo"/.test(JSON.stringify(w)));

globalThis.__dboJournalRequest(NEWER);
w = last(NEWER);
check('a front that names Court, Skills and Settings gets them, in order, Settings pinned right', ids(w) === 'profile,court,stats,skills,settings' && w.tabs.find((t) => t.id === 'settings').pinned === true, w.tabs);
check('...Court with its badge', w.tabs.find((t) => t.id === 'court').badge === '1');
check('...no Faction tab for someone with no faction, no invite and no staff rank', !w.tabs.some((t) => t.id === 'faction'));

globalThis.__dboJournalRequest(WOLF);
w = last(WOLF);
check('a werewolf with two invites: Faction with a badge of 2, and the curse tab by its name', ids(w) === 'profile,faction,stats,supernatural' && w.tabs.find((t) => t.id === 'faction').badge === '2' && w.tabs.find((t) => t.id === 'supernatural').label === 'Werewolf', w.tabs);

caps.get(STAFF).add('journalTab:factionStaff'); caps.get(STAFF).add('journalTab:court');
globalThis.__dboJournalRequest(STAFF);
w = last(STAFF);
check('staff: Faction always (every faction), and Court', ids(w) === 'profile,faction,court,stats', ids(w));

// ---- switching tabs ----
const nonceOf = (a) => last(a).nonce;
let n = nonceOf(STAFF);
fire('journalTab', STAFF, [n, 'faction']);
w = last(STAFF);
check('a tab switch is answered at once with that section', w.tab === 'faction' && w.faction && w.faction.type === 'faction', w && w.tab);
check('...the faction panel\'s own nonce kept (a redraw, not an opening)', w.faction.nonce === 'f-kept');
check('...a section hosted in Faction comes with it (the staff view)', w.factionStaff && w.factionStaff.all === 52);
check('...and Profile is not sent again', !('profile' in w));
check('...the journal nonce is kept, so a click in flight on another tab is not refused', w.nonce === n);
now += 1000;
fire('journalTab', STAFF, ['stale-nonce', 'stats']);
check('a switch under another nonce is ignored', last(STAFF).tab === 'faction');
now += 1000;
fire('journalTab', STAFF, [n, 'court', { zone: 'bruma' }]);
w = last(STAFF);
check('a switch may carry a focus for the section (a deep link inside the tab)', w.tab === 'court' && w.court.focus && w.court.focus.zone === 'bruma' && courtViews.pop()[1].zone === 'bruma');
now += 1000;
const before = widgets.length;
fire('journalTab', STAFF, [n, 'supernatural']);
check('a tab the player may not see is not opened: the journal redraws where it was', widgets.length === before + 1 && last(STAFF).tab === 'court');
now += 1000;
fire('journalTab', STAFF, [n, 'skills']);
check('...nor one the front cannot draw', last(STAFF).tab === 'court');

// flood guard: one answer per 120 ms, the latest one
now += 1000;
const b2 = widgets.length;
for (const t of ['stats', 'profile', 'faction', 'stats', 'profile']) fire('journalTab', STAFF, [n, t]);
check('a burst of switches: the first is answered at once', widgets.length === b2 + 1 && last(STAFF).tab === 'stats');
now += 200; runDue();
check('...and the rest as one answer, the latest', widgets.length === b2 + 2 && last(STAFF).tab === 'profile', widgets.length - b2);

// ---- F3 reopens the last tab used this session ----
now += 1000;
fire('journalTab', STAFF, [n, 'court']);
fire('journalClose', STAFF, [n]);
check('closing closes', closed.some(([a, id]) => a === STAFF && id === 50));
now += 5000;
globalThis.__dboJournalRequest(STAFF);
check('F3 again reopens Court, the last tab used', last(STAFF).tab === 'court' && last(STAFF).court);
check('...and a named tab wins over it (K asks for Skills on a front that has it)', globalThis.__dboJournalRequest(NEWER, 'skills') === true && last(NEWER).tab === 'skills');
online = online.filter((x) => x !== STAFF);
timers.journalWatch();
online.push(STAFF);
globalThis.__dboJournalRequest(STAFF);
check('a new session starts on Profile again', last(STAFF).tab === 'profile');

// ---- __dboJournalOpenTab ----
check('OpenTab: a tab the client can draw and the player sees opens', globalThis.__dboJournalOpenTab(NEWER, 'court') === true && last(NEWER).tab === 'court');
check('OpenTab: a tab the player may not see is false, and nothing opens', (() => { const c = widgets.length; return globalThis.__dboJournalOpenTab(HUB, 'supernatural') === false && widgets.length === c; })());
check('OpenTab: an unknown tab is false', globalThis.__dboJournalOpenTab(HUB, 'nonsense') === false);
check('OpenTab: a hosted section is never a tab of its own', globalThis.__dboJournalOpenTab(STAFF, 'factionStaff') === false);

// ---- the hooks ----
globalThis.__dboJournalRequest(HUB);
n = nonceOf(HUB);
check('Fresh: true for the open journal\'s nonce, false for another or a closed journal', globalThis.__dboJournalFresh(HUB, n) === true && globalThis.__dboJournalFresh(HUB, 'x') === false && globalThis.__dboJournalFresh(0xff0000ff, n) === false);
now += 10000;
check('Answer: redraws on the tab it names, with the result and a new nonce', globalThis.__dboJournalAnswer(HUB, 'stats', 'Done.', 'ok') === true
  && last(HUB).tab === 'stats' && last(HUB).result === 'Done.' && last(HUB).resultKind === 'ok' && last(HUB).nonce !== n && last(HUB).stats);
let ran = 0;
const b3 = widgets.length;
check('Limited: inside the 3 s window the action waits', globalThis.__dboJournalLimited(HUB, () => { ran++; return { tab: 'profile', text: 'Promoted.', kind: 'ok' }; }) === true && ran === 0 && widgets.length === b3);
now += 3100; runDue();
check('...then runs once and its answer is drawn', ran === 1 && last(HUB).result === 'Promoted.' && last(HUB).tab === 'profile');
now += 3100;
globalThis.__dboJournalLimited(HUB, () => { throw new Error('boom'); });
check('...an action that throws is answered as refused, never left hanging', last(HUB).resultKind === 'refused');
now += 3100;
const b4 = widgets.length;
globalThis.__dboJournalLimited(HUB, () => undefined);
check('...one that returns nothing draws nothing (it answered its own way)', widgets.length === b4);
now += 3100;
const r0 = ran;
for (let i = 0; i < 5; i++) globalThis.__dboJournalLimited(HUB, () => { ran++; return { text: `r${i}` }; });
const r1 = ran;
now += 3100; runDue();
check('...a burst: the first runs at once, then only the latest, once', r1 - r0 === 1 && ran - r0 === 2 && last(HUB).result === 'r4', { r0, r1, ran });
check('Limited and Answer on a closed journal: false', globalThis.__dboJournalLimited(OLD + 99, () => ({})) === false && globalThis.__dboJournalAnswer(OLD + 99, 'x', 'y') === false);
const b5 = widgets.length;
check('Redraw: only while its tab is in view, nonce kept', globalThis.__dboJournalRedraw(HUB, 'court') === false && widgets.length === b5
  && globalThis.__dboJournalRedraw(HUB) === true && last(HUB).nonce === widgets[b5 - 1].w.nonce);
check('TabOf names the open tab', globalThis.__dboJournalTabOf(HUB) === last(HUB).tab && globalThis.__dboJournalTabOf(0xff0000ff) === '');

// ---- Magic (L4's schools.js hooks) ----
let magicOpen = false, magicBuilt = 0;
const magicCalls = [];
globalThis.__dboMagicView = (a) => { magicBuilt++; return magicOpen ? { v: 1, open: true, schools: [] } : { v: 1, open: false }; };
globalThis.__dboMagicAction = (a, op, args) => { magicCalls.push([op, args]); return op === 'firstSpell' ? { ok: true, text: 'You learn Flames.' } : { ok: false, text: 'Not here.' }; };
globalThis.__dboJournalOpenTab(NEWER, 'profile');
check('no Magic tab for a front that does not name it, and nothing built for it', !ids(last(NEWER)).includes('magic') && magicBuilt === 0);
caps.get(NEWER).add('journalTab:magic');
globalThis.__dboJournalOpenTab(NEWER, 'profile');
check('...nor for a player off the Wheel ({ open: false })', !ids(last(NEWER)).includes('magic'));
magicOpen = true; magicBuilt = 0;
check('Magic opens for Arcane Arts or Priest', globalThis.__dboJournalOpenTab(NEWER, 'magic') === true && last(NEWER).tab === 'magic' && last(NEWER).magic.open === true);
magicBuilt = 0; globalThis.__dboJournalRedraw(NEWER);
check('...and a draw builds its view once, for the tab list and the section together', magicBuilt === 1, magicBuilt);
check('...placed after Skills, before Settings', ids(last(NEWER)) === 'profile,court,stats,skills,magic,settings', ids(last(NEWER)));
now += 10000;
fire('journalMagic', NEWER, [last(NEWER).nonce, 'firstSpell', 'Destruction', 'Skyrim.esm:012FCD']);
check('journalMagic goes to __dboMagicAction and answers on Magic', magicCalls.length === 1 && magicCalls[0][0] === 'firstSpell' && magicCalls[0][1].join() === 'Destruction,Skyrim.esm:012FCD' && last(NEWER).result === 'You learn Flames.' && last(NEWER).resultKind === 'ok' && last(NEWER).tab === 'magic');
fire('journalMagic', NEWER, ['stale', 'prepare', 'x']);
check('...never under a stale nonce', magicCalls.length === 1);
globalThis.__dboJournalRequest(OLD);
fire('journalMagic', OLD, [last(OLD).nonce, 'firstSpell', 'Destruction', 'x']);
check('...nor from an older journal front', magicCalls.length === 1);
check('an older journal front never gets a magic section', !('magic' in last(OLD)));

// ---- Settings, Help: Report a problem (debugsnap.js __dboBugReport) ----
const reports = [];
globalThis.__dboBugReport = (a, t) => { reports.push([a, t]); return t.length >= 5 ? { ok: true, text: 'Thanks, the staff team has your report.' } : { ok: false, text: 'Say what went wrong.' }; };
globalThis.__dboJournalOpenTab(NEWER, 'settings');
check('Settings opens for a front that draws it, with the staff flag', last(NEWER).tab === 'settings' && last(NEWER).settings && last(NEWER).settings.staff === false);
now += 10000;
fire('journalReport', NEWER, [last(NEWER).nonce, 'the wolf\nis floating\u0007 badly']);
check('journalReport files the report as /bug does and answers on Settings', reports.length === 1 && reports[0][1] === 'the wolf\nis floating badly' && last(NEWER).result === 'Thanks, the staff team has your report.' && last(NEWER).tab === 'settings');
fire('journalReport', NEWER, ['stale', 'x x x x x']);
check('...never under a stale nonce', reports.length === 1);

// ---- a section that throws ----
globalThis.__dboJournalSections.court.view = () => { throw new Error('court broke'); };
globalThis.__dboJournalOpenTab(NEWER, 'court');
check('a section that throws arrives as null (the front says it cannot be shown), and the journal still draws', last(NEWER).tab === 'court' && last(NEWER).court === null && last(NEWER).tabs.length > 0);

// ---- the faction answer while the hub is open ----
globalThis.__dboJournalRequest(HUB);
globalThis.__dboJournalFaction(HUB, { type: 'faction', id: 37, nonce: 'f-answer', factions: [] });
check('a faction answer redraws the hub on Faction with that payload', last(HUB).tab === 'faction' && last(HUB).faction.nonce === 'f-answer' && last(HUB).hub === 1);

// ---- staff: another's journal, read only (__dboJournalOpenFor) ----
const actsBefore = magicCalls.length, repBefore = reports.length;
check('OpenFor: refused to a player who is not staff, and for oneself', globalThis.__dboJournalOpenFor(HUB, WOLF) === false && globalThis.__dboJournalOpenFor(STAFF, STAFF) === false);
check('...staff open the target\'s journal, focused, read only', globalThis.__dboJournalOpenFor(STAFF, WOLF, 'supernatural') === true && widgets[widgets.length - 1].focus === true && last(STAFF).readOnly === 1);
w = last(STAFF);
check('...the target\'s tabs and sections (the curse tab is the werewolf\'s), the target\'s name in the header', ids(w) === 'profile,faction,stats,supernatural' && w.tab === 'supernatural' && w.supernatural.kind === 'werewolf' && w.head.name === 'Vilkas', { tabs: ids(w), head: w.head });
now += 1000;
fire('journalTab', STAFF, [w.nonce, 'profile']);
check('...browsing tabs works', last(STAFF).tab === 'profile' && last(STAFF).profile.name === 'Vilkas' && last(STAFF).readOnly === 1);
now += 10000;
fire('journalMagic', STAFF, [w.nonce, 'firstSpell', 'Destruction', 'x']);
fire('journalReport', STAFF, [w.nonce, 'a report from a read-only page']);
check('...every action is refused, and Fresh says no, so the tabs\' own modules refuse too', magicCalls.length === actsBefore && reports.length === repBefore && globalThis.__dboJournalFresh(STAFF, w.nonce) === false);
globalThis.__dboJournalFaction(STAFF, { type: 'faction', id: 37, nonce: 'staff-own', factions: [] });
check('...a faction answer of the staff member\'s own does not draw into it', last(STAFF).readOnly === 1 && (!last(STAFF).faction || last(STAFF).faction.nonce !== 'staff-own'));
fire('journalClose', STAFF, [w.nonce]);
now += 5000;
globalThis.__dboJournalRequest(STAFF);
check('...closing it leaves the staff member\'s own last tab alone (F3 opens their own journal)', !last(STAFF).readOnly && last(STAFF).head.name === 'Kodlak');
check('OpenFor from an older journal front: false', globalThis.__dboJournalOpenFor(OLD, HUB) === false);

// ---- a hold-only member: Faction only for a front without Court ----
const HOLD = 0xff000025;
props.set(`${HOLD}|appearance`, { name: 'Jarl', raceId: 0x13746 }); props.set(`${HOLD}|private.mastery`, mastery({ blade: 10 }));
online.push(HOLD);
tabInfo.set(HOLD, { member: 0, invites: 0, courtMember: 1, courtInvites: 1, staff: false });
caps.set(HOLD, new Set(HUBCAPS));
globalThis.__dboJournalRequest(HOLD);
check('a hold-only member on a front without Court: a Faction tab, the hold invite counted', ids(last(HOLD)).startsWith('profile,faction') && last(HOLD).tabs.find((t) => t.id === 'faction').badge === '1', last(HOLD).tabs);
caps.get(HOLD).add('journalTab:court');
const courtVis = globalThis.__dboJournalSections.court.visible;
globalThis.__dboJournalSections.court.visible = (a) => a === HOLD || courtVis(a);
globalThis.__dboJournalRequest(HOLD);
check('...on a front with Court: no Faction tab, Court covers it', !ids(last(HOLD)).includes('faction') && ids(last(HOLD)).includes('court'), ids(last(HOLD)));
globalThis.__dboJournalSections.court.visible = courtVis;

// ---- read-only extras: no Settings of another, the staff flag is the viewer's, the faction panel read only ----
caps.get(STAFF).add('journalTab:settings');
let ffArgs = null;
const fp = globalThis.__dboFactionPayload;
globalThis.__dboFactionPayload = (a, keep, ro) => { ffArgs = [a, keep, ro]; return fp(a, keep); };
globalThis.__dboJournalOpenFor(STAFF, WOLF, 'faction');
w = last(STAFF);
check('another\'s journal never shows their Settings', !ids(w).includes('settings'), ids(w));
check('...their faction panel is asked for read only', ffArgs && ffArgs[0] === WOLF && ffArgs[2] === true, ffArgs);
check('...and carries the subject and the opening, so the front starts its cache afresh', w.subject === (WOLF >>> 0).toString(16) && typeof w.opened === 'number');
const firstOpening = w.opened;
fire('journalClose', STAFF, [w.nonce]);
globalThis.__dboJournalOpenFor(STAFF, HUB, 'profile');
check('...a second reading is another opening, of another subject', last(STAFF).opened !== firstOpening && last(STAFF).subject === (HUB >>> 0).toString(16));
let staffSeen = null;
globalThis.__dboJournalSections.probeStaff = { visible: () => true, view: (a, o) => { staffSeen = o.staff; return {}; } };
caps.get(STAFF).add('journalTab:probeStaff');
fire('journalTab', STAFF, [last(STAFF).nonce, 'probeStaff']);
check('...the staff flag sections see is the viewer\'s (a player\'s journal read by staff)', staffSeen === true);
delete globalThis.__dboJournalSections.probeStaff;
globalThis.__dboFactionPayload = fp;
fire('journalClose', STAFF, [last(STAFF).nonce]);
globalThis.__dboJournalRequest(STAFF);
check('the staff member\'s own journal keeps Settings', ids(last(STAFF)).includes('settings') && !last(STAFF).readOnly && !('subject' in last(STAFF)));

// ---- a reload keeps the other modules' sections ----
load();
check('a hot reload of journal.js keeps the sections other modules registered', !!globalThis.__dboJournalSections.court && !!globalThis.__dboJournalSections.factionStaff && !!globalThis.__dboJournalSections.profile);

// ---- wired in: gamemode.js passes the tab and isAdmin; guilds.js the cheap tab info ----
const gm = fs.readFileSync('gamemode.js', 'utf8');
check('gamemode.js gives journal.js isAdmin', /require\(JOURNAL_JS\)\(\{[^}]*\bisAdmin\b/.test(gm));
const gsrc = fs.readFileSync('guilds.js', 'utf8');
check('guilds.js exports the Faction tab\'s count without building the panel, hold and stronghold factions counted apart',
  /courtMember: ms\.filter\(\(m\) => courtKind\(m\.fid\)\)\.length, courtInvites: inv\.filter\(\(i\) => courtKind\(i\.fid\)\)\.length/.test(gsrc)
  && /member: ms\.filter\(\(m\) => !courtKind\(m\.fid\)\)\.length/.test(gsrc) && /f\.kind === 'hold' \|\| f\.kind === 'stronghold'/.test(gsrc));
check('...and the faction panel for a read-only view makes and keeps no nonce for the subject', /const nonce = readOnly \? '' :/.test(gsrc) && /if \(!readOnly\) ST\.nonces\.set\(a >>> 0, nonce\);/.test(gsrc));

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
