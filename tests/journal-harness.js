// Scripted test for the Character Journal, phase 1, server half (journal.js; contract agreed with Worker D's front,
// widget 50): F3 routing, the payload, the clock words, the title table (journal-titles.json, skills.json as shipped),
// saving the story and choosing a title, both ways of closing, the Faction tab redraw and the clock tick, plus the small
// exports it needs in guilds.js, journalstats.js, naming.js, schools.js and idles.js. Run it from this folder's parent:
//
//   node tests/journal-harness.js
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
process.chdir(root);
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

let now = 1_900_000_000_000;
const realNow = Date.now;
Date.now = () => now;

// ---- a fake world ----
const P = 0xff000014, BEAST = 0xff000015, NOCAP = 0xff000016;
const props = new Map();
const setp = (a, k, v) => props.set(`${a}|${k}`, v);
const mastery = (lv) => ({ order: Object.keys(lv), skills: Object.fromEntries(Object.entries(lv).map(([id, level], i) => [id, { level, xp: 100 - i }])) });
setp(P, 'appearance', { name: 'Aela', raceId: 0x13746 });
setp(P, 'private.mastery', mastery({ arcane: 60, defense: 55, blade: 50, cook: 12 }));
setp(BEAST, 'appearance', { name: 'Vilkas', raceId: 0x13746 });
setp(BEAST, 'private.mastery', mastery({ blade: 30 }));
const docs = new Map(), touched = [];
const sent = [], widgets = [], closed = [], idles = [];
const caps = new Map([[P, new Set(['journal', 'dboIdle'])], [BEAST, new Set(['journal'])], [NOCAP, new Set(['menu'])]]);
const ui = new Map();
const timers = {};
let online = [P, BEAST, NOCAP];
let factionSeq = 0;
globalThis.__dboJournalDoc = { of: (a) => { if (!docs.has(a)) docs.set(a, {}); return docs.get(a); }, touch: (a) => touched.push(a) };
globalThis.__dboStatsData = (a) => ({ since: Date.UTC(2026, 9, 1), created: Date.UTC(2026, 9, 1, 6), joined: Date.UTC(2026, 8, 20), playMs: 31 * 3600000 + 12 * 60000,
  sessions: 4, longestMs: 3 * 3600000, averageMs: 7.8 * 3600000, distanceUnits: 70 * 12345, enemiesKilled: 17, playerKills: 1, killedByPlayers: 2, downs: 3,
  playersDowned: 1, timesRobbed: 0, peopleRobbed: 1, pickpockets: 2, timesPickpocketed: 0, jailMs: 30 * 60000, trades: 5, dungeonsCleared: 2, spellsLearned: 6 });
let lastFactionKeep = null;
globalThis.__dboFactionPayload = (a, keep) => { lastFactionKeep = keep; return { type: 'faction', id: 37, nonce: keep ? 'f-kept' : `f-${++factionSeq}`, factions: [] }; };
globalThis.__dboSuperProgress = (a) => (a === BEAST ? { kind: 'werewolf', rank: 'Fledgling' } : null);
let clockHour = 21.7;
globalThis.__dboClock = { summary: () => ({ hour: clockHour, day: 17, month: 'Last Seed', year: 211, phaseName: 'waxing crescent' }) };
globalThis.__dboInteractionIdle = (a, key) => { idles.push([a, key]); return true; };
let primary = '';
globalThis.__dboSchoolsPrimary = () => primary;
globalThis.__dboTextBlocked = (t) => /\bnwah\b/i.test(String(t));

const skillsDef = JSON.parse(fs.readFileSync('skills.json', 'utf8')).skills;
delete globalThis.__dboJournal;
const load = () => {
  delete require.cache[path.resolve('journal.js')];
  ui.clear();
  return require(path.resolve('journal.js'))({
    mp: { get: (a, k) => props.get(`${a}|${k}`), lookupEspmRecordById: (id) => (id === 0x13746 ? { record: { editorId: 'NordRace' } } : null) },
    log: () => {}, display: (a) => `#${(a >>> 0).toString(16)}`, nameOf: (a) => ((props.get(`${a}|appearance`) || {}).name || ''),
    openWidget: (a, w, focus) => widgets.push({ a, w, focus }), closeWidget: (a, id) => closed.push([a, id]),
    onUi: (ev, fn) => { const l = ui.get(ev) || []; l.push(fn); ui.set(ev, l); }, sendPacket: (a, p) => sent.push([a, p]),
    every: (n, ms, fn) => { timers[n] = fn; }, onlineActors: () => online, cfg: {}, skills: skillsDef,
    hasCap: (a, cap) => !!(caps.get(a) && caps.get(a).has(cap)),
  });
};
const fire = (ev, a, args, wid) => { for (const fn of ui.get(ev) || []) fn(a, args, wid === undefined ? 50 : wid); };
const last = (a) => widgets.filter((x) => x.a === a).pop();
const J = load();

// ---- F3 ----
check('F3 from a client without the journal cap: not taken, so panel 37 opens as today', globalThis.__dboJournalRequest(NOCAP) === false && widgets.length === 0);
check('F3 from a journal client opens it, focused', globalThis.__dboJournalRequest(P) === true && last(P).focus === true && last(P).w.type === 'journal' && last(P).w.id === 50);
const w = last(P).w;
// JOURNAL_SAMPLE=<file> writes this payload out, for the front
if (process.env.JOURNAL_SAMPLE) fs.writeFileSync(process.env.JOURNAL_SAMPLE, JSON.stringify(w, null, 1));
check('...on the Profile tab, with a nonce', w.tab === 'profile' && typeof w.nonce === 'string' && w.nonce.length > 4, w.tab);
check('...and plays the page-turn idle', idles.some(([a, k]) => a === P && k === 'journal'));
check('...with a fresh faction nonce on opening', lastFactionKeep === false && w.faction.nonce === 'f-1', w.faction);
check('no internal marker reaches the client', !('fresh' in JSON.parse(JSON.stringify(w))));
const gm = fs.readFileSync('gamemode.js', 'utf8');
const f3 = gm.slice(gm.indexOf("content.customPacketType === 'factionMenuRequest'"), gm.indexOf("content.customPacketType === 'factionMenuRequest'") + 700);
check('gamemode.js asks the journal first on F3 and falls back to panel 37', f3.indexOf('__dboJournalRequest(a)') > 0 && f3.indexOf('__dboJournalRequest(a)') < f3.indexOf('__dboFactionMenu(a)') && /if \(!journal && /.test(f3));

// ---- the payload ----
check('clock: date and time in words, and the moons', w.clock.date === '17th of Last Seed, 4E 211' && w.clock.time === '9:42 in the evening' && w.clock.moons === 'The moons are waxing crescent.', w.clock);
const p = w.profile;
check('profile: name, race, playtime, dates', p.name === 'Aela' && p.race === 'Nord' && p.playtime === '31 h 12 min' && p.created === '1 October 2026' && p.joined === '20 September 2026', p);
check('...the story fields and their limits', p.backstory === '' && p.origin === '' && p.backstoryMax === 4000 && p.originMax === 1000);
check('...the top three skills, ranked, with levels, tiers and epithets', p.skills.length === 3 && p.skills.map((s) => s.id).join() === 'arcane,defense,blade'
  && p.skills[0].name === 'Arcane Arts' && p.skills[0].level === 60 && p.skills[0].tier === 2 && p.skills[0].tierName === 'Adept' && p.skills[0].epithet === 'The Ordered Mind', p.skills);
check('...the title, its epithet and the choices', p.title === 'Adept Battlemage' && p.titleId === 'battlemage' && p.titleEpithet === 'The Ordered Mind'
  && p.titles.map((t) => t.id).join() === 'battlemage,spellsword,warrior,mage', p.titles);
check('supernatural: null for a mortal (no tab)', w.supernatural === null);
check('stats: groups of label and value strings', w.stats.groups.length === 5 && w.stats.groups.every((g) => g.rows.every((r) => typeof r.label === 'string' && typeof r.value === 'string')), w.stats.groups.map((g) => g.name));
const row = (g, l) => w.stats.groups.find((x) => x.name === g).rows.find((r) => r.label === l).value;
check('...formatted: playtime, distance in km and mi, counts', row('Time & Travel', 'Total playtime') === '31 h 12 min' && row('Time & Travel', 'Distance travelled') === '12.3 km (7.7 mi)'
  && row('Combat', 'Enemies killed') === '17' && row('Crime & Law', 'Jail time served') === '0 h 30 min' && row('Activities', 'Spells learned') === '6');
globalThis.__dboJournalRequest(BEAST);
check('a werewolf gets the Supernatural data', last(BEAST).w.supernatural && last(BEAST).w.supernatural.kind === 'werewolf');

// ---- the clock words ----
for (const [h, want] of [[0.5, '12:30 at night'], [7.2, '7:12 in the morning'], [12.07, '12:04 in the afternoon'], [17, '5:00 in the evening'], [22, '10:00 at night'], [4.98, '4:59 at night'], [23.999, '12:00 at night']]) {
  clockHour = h;
  check(`clock at ${h}: "${want}"`, J.clockView().time === want, J.clockView().time);
}
clockHour = 21.7;

// ---- the title table (journal-titles.json, skills.json) ----
const title = (lv, school) => { setp(0xff000099, 'private.mastery', mastery(lv)); primary = school || ''; const t = J.titlesFor(0xff000099); primary = ''; return t; };
const first = (lv, school) => title(lv, school)[0].label;
check('Priest, Defense and Blunt: Apprentice Paladin', first({ priest: 40, defense: 30, blunt: 35 }) === 'Apprentice Paladin', title({ priest: 40, defense: 30, blunt: 35 }));
check('Blade, Blunt and Defense near 50: Seasoned Knight, and Seasoned Warrior offered', first({ blunt: 52, blade: 50, defense: 48 }) === 'Seasoned Knight'
  && title({ blunt: 52, blade: 50, defense: 48 }).some((t) => t.label === 'Seasoned Warrior'), title({ blunt: 52, blade: 50, defense: 48 }));
check('Blacksmith 92 well ahead: Master Smith, with its epithet', first({ blacksmith: 92, cook: 40, miner: 30 }) === 'Master Smith' && title({ blacksmith: 92 })[0].epithet === 'The Forge-Bound');
check('a profession only 5 ahead is no profession title: Adept Adventurer', first({ blacksmith: 50, miner: 45 }) === 'Adept Adventurer', first({ blacksmith: 50, miner: 45 }));
check('nothing at 25 and no profession leading: Wanderer', first({ blade: 10, cook: 15 }) === 'Wanderer' && first({}) === 'Wanderer');
check('...but a low profession 10 ahead is already one: Novice Cook', first({ blade: 10, cook: 20 }) === 'Novice Cook', first({ blade: 10, cook: 20 }));
check('Arcane Arts on top with Destruction: Expert Pyromancer; with no school yet, Expert Mage', first({ arcane: 80 }, 'Destruction') === 'Expert Pyromancer' && first({ arcane: 80 }) === 'Expert Mage');
check('Archery, Skinner and Harvesting: Apprentice Ranger, then Scout and Archer offered', title({ archery: 30, skinner: 28, harvesting: 26 }).map((t) => t.label).join('|') === 'Apprentice Ranger|Apprentice Scout|Apprentice Archer', title({ archery: 30, skinner: 28, harvesting: 26 }));
check('Martial Arts on top: Brawler; with Priest: Monk first', first({ unarmed: 40 }) === 'Apprentice Brawler' && first({ unarmed: 40, priest: 30 }) === 'Apprentice Monk');
check('Lockpicking on top: Thief; Arcane Arts with Lockpicking: Nightblade', first({ lockpicking: 90 }) === 'Master Thief' && first({ arcane: 30, lockpicking: 30 }) === 'Apprentice Nightblade');
check('a skill not in skills.json is ignored', title({ madeup: 99, blade: 30 }).every((t) => !/madeup/i.test(t.label)));

// ---- saving the story ----
const nonceOf = (a) => last(a).w.nonce;
let n0 = nonceOf(P);
fire('journalProfile', P, ['stale', 'x', 'y']);
check('a save with a stale nonce is ignored', !(docs.get(P) || {}).profile || !docs.get(P).profile.backstory);
fire('journalProfile', P, [n0, 'Born in Bruma.\r\nRaised by wolves.\u0007', 'Cyrodiil']);
check('a save keeps the text (newlines kept, control characters dropped) in the character\'s journal file', docs.get(P).profile.backstory === 'Born in Bruma.\nRaised by wolves.' && docs.get(P).profile.origin === 'Cyrodiil' && touched.includes(P), docs.get(P).profile);
check('...answers with a new nonce and "saved"', nonceOf(P) !== n0 && last(P).w.result === 'Your story is saved.' && last(P).w.resultKind === 'ok' && last(P).focus === false);
check('...and the next page shows the story', last(P).w.profile.backstory === 'Born in Bruma.\nRaised by wolves.');
n0 = nonceOf(P);
fire('journalProfile', P, [n0, 'again', '']);
check('a second save inside 3 s is refused and changes nothing', last(P).w.resultKind === 'refused' && /Wait/.test(last(P).w.result) && docs.get(P).profile.backstory !== 'again');
now += 3001;
fire('journalProfile', P, [nonceOf(P), 'x'.repeat(5000), 'y'.repeat(2000)]);
check('the story is cut to 4000 and the origin to 1000', docs.get(P).profile.backstory.length === 4000 && docs.get(P).profile.origin.length === 1000);
now += 3001;
const before = docs.get(P).profile.backstory;
fire('journalProfile', P, [nonceOf(P), 'I am a nwah', '']);
check('a blocked word is refused and nothing saved', last(P).w.resultKind === 'refused' && /will not do/.test(last(P).w.result) && docs.get(P).profile.backstory === before);

// ---- choosing a title ----
fire('journalTitle', P, [nonceOf(P), 'warrior']);
check('a title the character qualifies for is chosen and shown', docs.get(P).profile.titleId === 'warrior' && last(P).w.profile.title === 'Seasoned Warrior' && last(P).w.profile.titleId === 'warrior' && /Seasoned Warrior/.test(last(P).w.result));
fire('journalTitle', P, [nonceOf(P), 'paladin']);
check('one they have not earned is refused', docs.get(P).profile.titleId === 'warrior' && last(P).w.resultKind === 'refused');
setp(P, 'private.mastery', mastery({ blacksmith: 60, cook: 20 }));
now += 60000;
timers.journalClock();
check('a chosen title that no longer fits falls back to the best one', last(P).w.profile.title === 'Adept Smith', last(P).w.profile.title);
setp(P, 'private.mastery', mastery({ arcane: 60, defense: 55, blade: 50, cook: 12 }));

// ---- the Faction tab ----
const jn = nonceOf(P);
check('a faction answer while the journal is open redraws its Faction tab, same journal nonce, no focus', globalThis.__dboJournalFaction(P, { type: 'faction', nonce: 'f-new' }) === true
  && last(P).w.tab === 'faction' && last(P).w.faction.nonce === 'f-new' && last(P).w.nonce === jn && last(P).focus === false);
check('...and with the journal closed it is not taken (panel 37 opens)', globalThis.__dboJournalFaction(NOCAP, { type: 'faction' }) === false);
timers.journalClock();
check('the minute clock redraw keeps the tab and both nonces', !('tab' in last(P).w) && last(P).w.nonce === jn && lastFactionKeep === true && last(P).focus === false);
const gd = fs.readFileSync('guilds.js', 'utf8');
check('guilds.js redraws the journal instead of panel 37 while it is open, and gives its payload to the journal', /__dboJournalFaction\(a >>> 0, p\)\) return;/.test(gd) && /globalThis\.__dboFactionPayload = \(a, keepNonce\) => menuPayload\(/.test(gd));

// ---- closing ----
fire('journalClose', P, ['stale']);
check('Close with a stale nonce does nothing', closed.length === 0);
now = realNow() + 0; Date.now = () => now;
globalThis.__dboJournalRequest(P);
fire('journalClose', P, [nonceOf(P)]);
check('Close closes widget 50 and stops the page-turn it began', closed.some(([a, id]) => a === P && id === 50) && sent.some(([a, q]) => a === P && q.customPacketType === 'dboIdleStop'));
check('...and the journal is no longer open', globalThis.__dboJournalIsOpen(P) === false);
sent.length = 0;
globalThis.__dboJournalRequest(P);
now += 11000;
fire('close', P, [], 50);
check('Escape (the relay\'s close for widget 50) ends it; past the 10 s idle, no stop is sent', globalThis.__dboJournalIsOpen(P) === false && !sent.some(([, q]) => q.customPacketType === 'dboIdleStop'));
globalThis.__dboJournalRequest(P);
fire('close', P, [], 37);
check('a close of another widget leaves the journal open', globalThis.__dboJournalIsOpen(P) === true);
online = [BEAST, NOCAP];
timers.journalClock();
check('a player gone offline has their journal closed on the next tick', globalThis.__dboJournalIsOpen(P) === false);
online = [P, BEAST, NOCAP];

// ---- a hot reload keeps an open journal ----
globalThis.__dboJournalRequest(P);
const keep = nonceOf(P);
load();
fire('journalTitle', P, [keep, 'battlemage']);
check('a hot reload keeps the open journal and its nonce', docs.get(P).profile.titleId === 'battlemage');

// ---- the small exports ----
const js = fs.readFileSync('journalstats.js', 'utf8');
check('journalstats.js gives the numbers (__dboStatsData) and the character file (__dboJournalDoc)', /globalThis\.__dboStatsData = \(a\) =>/.test(js) && /globalThis\.__dboJournalDoc = \{ of: \(a\) => statsOf\(a\), touch: \(a\) => touch\(a\) \};/.test(js));
const idl = fs.readFileSync('idles.js', 'utf8');
check('idles.js plays IdleBook_PageTurn (the allowlisted event of IdleBook_TurnManyPages) for 10 s', /journal: \{ anim: 'IdleBook_PageTurn', seconds: 10, endsItself: false \}/.test(idl));
check('schools.js reads the primary school without making a menu nonce', /globalThis\.__dboSchoolsPrimary = \(a\) => \{ try \{ return ready\(a\) \? String\(stateOf\(a\)\.primary/.test(fs.readFileSync('schools.js', 'utf8')));
// naming.js's prose filter, run for real against a scratch name-filter.json
{
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-jnl-'));
  process.chdir(dir);
  fs.writeFileSync('name-filter.json', JSON.stringify({ blocked: ['nwah'], reserved: [] }));
  delete require.cache[path.join(root, 'naming.js')];
  const savedBlocked = globalThis.__dboTextBlocked;
  require(path.join(root, 'naming.js'))({ mp: { get: () => undefined, set: () => {}, findFormsByPropertyValue: () => [] }, log: () => {}, personal: () => {}, onUi: () => {},
    openWidget: () => {}, closeWidget: () => {}, registerChatCommand: () => {}, display: String, who: String, audit: () => {}, cfg: {}, every: () => {}, sendPacket: () => {} });
  check('naming.js flags a blocked word in prose, any spelling', globalThis.__dboTextBlocked('you are a N-w4h, friend') === true);
  check('...but never across the spaces of ordinary words ("n wah")', globalThis.__dboTextBlocked('Born in the town of N, wah was the word') === false);
  globalThis.__dboTextBlocked = savedBlocked;
  process.chdir(root);
  fs.rmSync(dir, { recursive: true, force: true });
}

Date.now = realNow;
delete globalThis.__dboJournal;
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
