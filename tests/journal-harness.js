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
  sessions: 12, longestMs: 5 * 3600000, averageMs: 2.6 * 3600000, distanceUnits: 70 * 12345, enemiesKilled: 17, playerKills: 1, killedByPlayers: 2, downs: 3,
  playersDowned: 1, timesRobbed: 0, peopleRobbed: 1, pickpockets: 2, timesPickpocketed: 0, jailMs: 30 * 60000, trades: 5, dungeonsCleared: 2, spellsLearned: 6 });
let lastFactionKeep = null;
globalThis.__dboFactionPayload = (a, keep) => { lastFactionKeep = keep; return { type: 'faction', id: 37, nonce: keep ? 'f-kept' : `f-${++factionSeq}`, factions: [] }; };
globalThis.__dboSuperProgress = (a) => (a === BEAST ? { kind: 'werewolf', rank: 'Fledgling' } : null);
let clockHour = 21.7;
globalThis.__dboClock = { summary: () => ({ hour: clockHour, day: 17, month: 'Last Seed', year: 211, phaseName: 'waxing crescent' }) };
globalThis.__dboInteractionIdle = (a, key) => { idles.push([a, key]); return true; };
let primary = '';
globalThis.__dboSchoolsPrimary = () => primary;
const told = [];
let flushes = 0;
globalThis.__dboStatsFlush = () => { flushes++; };
let idleDef = { anim: 'IdleBook_PageTurn', seconds: 10, hold: true };
globalThis.__dboInteractionIdleDef = () => (idleDef ? Object.assign({}, idleDef) : null);
globalThis.__dboCombatAt = new Map();
const downed = new Set();
globalThis.__dboIsDowned = (a) => downed.has(a);
// The limiter's timers run on the fake clock
const pending = [];
const realTimeout = global.setTimeout;
global.setTimeout = (fn, ms) => { pending.push({ fn, at: now + (Number(ms) || 0) }); return 0; };
const runDue = () => { for (let i = 0; i < pending.length;) { if (pending[i].at <= now) { const t = pending.splice(i, 1)[0]; t.fn(); } else i++; } };

const skillsDef = JSON.parse(fs.readFileSync('skills.json', 'utf8')).skills;
delete globalThis.__dboJournal;
const load = () => {
  delete require.cache[path.resolve('journal.js')];
  ui.clear();
  return require(path.resolve('journal.js'))({
    mp: { get: (a, k) => props.get(`${a}|${k}`), lookupEspmRecordById: (id) => (id === 0x13746 ? { record: { editorId: 'NordRace' } } : null) },
    log: () => {}, display: (a) => `#${(a >>> 0).toString(16)}`, nameOf: (a) => ((props.get(`${a}|appearance`) || {}).name || ''), personal: (a, t) => told.push([a, t]),
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
const f3 = gm.slice(gm.indexOf("content.customPacketType === 'factionMenuRequest'"), gm.indexOf("content.customPacketType === 'factionMenuRequest'") + 1000);
check('gamemode.js asks the journal first on F3 (with the tab a newer client names) and falls back to panel 37', f3.indexOf('__dboJournalRequest(a, tab)') > 0 && f3.indexOf('__dboJournalRequest(a, tab)') < f3.indexOf('__dboFactionMenu(a)') && /if \(!journal && /.test(f3));

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
check('the fake numbers are a real character\'s: the average session is not longer than the longest', row('Time & Travel', 'Average session') === '2 h 36 min' && row('Time & Travel', 'Longest session') === '5 h 0 min');
check('...and journalstats.js averages the counted sessions (sessionMs), not all play time', /averageMs: sessions \? \(s\.sessionMs \+ openMs\) \/ sessions : 0/.test(fs.readFileSync('journalstats.js', 'utf8'))
  && /s\.sessionMs \+= len; if \(len > s\.longestSessionMs\) s\.longestSessionMs = len;/.test(fs.readFileSync('journalstats.js', 'utf8')));
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

// ---- saving the story (one answer every 3 s: a request inside the window waits for it, the latest wins) ----
const nonceOf = (a) => last(a).w.nonce;
let n0 = nonceOf(P);
fire('journalProfile', P, ['stale', 'x', 'y']);
check('a save with a stale nonce is ignored', !(docs.get(P) || {}).profile || !docs.get(P).profile.backstory);
fire('journalProfile', P, [n0, 'Born in Bruma.\r\nRaised by wolves.\u0007', 'Cyrodiil']);
check('a save keeps the text (newlines kept, control characters dropped) in the character\'s journal file', docs.get(P).profile.backstory === 'Born in Bruma.\nRaised by wolves.' && docs.get(P).profile.origin === 'Cyrodiil' && touched.includes(P), docs.get(P).profile);
check('...answers with a new nonce and "saved"', nonceOf(P) !== n0 && last(P).w.result === 'Your story is saved.' && last(P).w.resultKind === 'ok' && last(P).focus === false);
check('...writes the file at once, not at the next minute\'s flush (a crash after "saved")', flushes === 1, flushes);
check('...and the next page shows the story', last(P).w.profile.backstory === 'Born in Bruma.\nRaised by wolves.');
// A scripted client inside the window: nothing is answered until it ends, then only the latest, once
let drawsBefore = widgets.length;
for (let i = 0; i < 100; i++) fire('journalProfile', P, [nonceOf(P), `draft ${i}`, '']);
check('100 saves inside 3 s: not one answered yet', widgets.length === drawsBefore, widgets.length - drawsBefore);
now += 3001; runDue();
check('...when the window ends, one answer, and the latest text is what is saved', widgets.length === drawsBefore + 1 && docs.get(P).profile.backstory === 'draft 99', [widgets.length - drawsBefore, docs.get(P).profile.backstory]);
now += 3001;
fire('journalProfile', P, [nonceOf(P), 'x'.repeat(5000), 'y'.repeat(2000)]);
check('the story is cut to 4000 and the origin to 1000', docs.get(P).profile.backstory.length === 4000 && docs.get(P).profile.origin.length === 1000);
// The prose filter: slurs only, as whole words, and the word is named back
now += 3001;
const before = docs.get(P).profile.backstory;
fire('journalProfile', P, [nonceOf(P), 'They called him a f4ggots, once.', '']);
check('a slur is refused, any spelling or ending, nothing saved, and the word is named', last(P).w.resultKind === 'refused' && /"f4ggots"/.test(last(P).w.result) && docs.get(P).profile.backstory === before, last(P).w.result);
now += 3001;
drawsBefore = widgets.length;
fire('journalTitle', P, [nonceOf(P), 'warrior']);
fire('journalProfile', P, [nonceOf(P), 'again', '']);
check('a refused save counts toward the window too, and so does a title', widgets.length === drawsBefore + 1 && docs.get(P).profile.titleId === 'warrior' && docs.get(P).profile.backstory !== 'again');
now += 3001; runDue();
check('...the queued save is answered when its window ends', docs.get(P).profile.backstory === 'again' && last(P).w.result === 'Your story is saved.');
const ordinary = 'I grew up in a basement in Bruma, a bastard of the Count, wary of raccoons. My analysis: the therapist of Scunthorpe was a fetcher and an n\'wah, a milk-drinker.';
check('ordinary prose and TES speech pass the prose filter (basement, bastard, raccoon, analysis, therapist, Scunthorpe, n\'wah)', J.proseProblem(ordinary) === null, J.proseProblem(ordinary));
check('...a slur inside hyphenated or quoted text is still found', J.proseProblem('"knife-ear kike"') === 'kike' && J.proseProblem('a spastic-looking fool') === 'spastic');
const pf = JSON.parse(fs.readFileSync('journal-prose-filter.json', 'utf8'));
check('the prose list is a short list of slurs, with its own file (not the name filter)', Array.isArray(pf.words) && pf.words.length <= 20 && !pf.words.includes('bastard') && !pf.words.includes('anal'));
now += 3001;

// ---- choosing a title ----
fire('journalTitle', P, [nonceOf(P), 'battlemage']);
check('a title the character qualifies for is chosen and shown', docs.get(P).profile.titleId === 'battlemage' && last(P).w.profile.title === 'Adept Battlemage' && /Adept Battlemage/.test(last(P).w.result));
now += 3001;
fire('journalTitle', P, [nonceOf(P), 'paladin']);
check('one they have not earned is refused', docs.get(P).profile.titleId === 'battlemage' && last(P).w.resultKind === 'refused');
setp(P, 'private.mastery', mastery({ blacksmith: 60, cook: 20 }));
globalThis.__dboJournalOpenTab(P, 'profile');
check('a chosen title that no longer fits falls back to the best one', last(P).w.profile.title === 'Adept Smith', last(P).w.profile.title);
setp(P, 'private.mastery', mastery({ arcane: 60, defense: 55, blade: 50, cook: 12 }));

// ---- F1: no timed redraw, so typing across a minute boundary keeps the caret ----
drawsBefore = widgets.length;
for (let i = 0; i < 180; i++) { now += 1000; timers.journalWatch(); }
check('three minutes of an open journal: the watch sends no redraw at all', widgets.length === drawsBefore && globalThis.__dboJournalIsOpen(P), widgets.length - drawsBefore);
check('there is no clock timer any more', !('journalClock' in timers));

// ---- the Faction tab ----
const jn = nonceOf(P);
check('a faction answer while the journal is open redraws its Faction tab, same journal nonce, no focus', globalThis.__dboJournalFaction(P, { type: 'faction', nonce: 'f-new' }) === true
  && last(P).w.tab === 'faction' && last(P).w.faction.nonce === 'f-new' && last(P).w.nonce === jn && last(P).focus === false);
check('...and with the journal closed it is not taken (panel 37 opens)', globalThis.__dboJournalFaction(NOCAP, { type: 'faction' }) === false);
check('/faction opens the journal on its Faction tab for a journal client', globalThis.__dboJournalOpenTab(P, 'faction') === true && last(P).w.tab === 'faction' && last(P).focus === true);
check('...and not for an older client (panel 37 as before)', globalThis.__dboJournalOpenTab(NOCAP, 'faction') === false);
const gd = fs.readFileSync('guilds.js', 'utf8');
check('guilds.js: /faction asks the journal first; faction answers redraw the journal while it is open', /__dboJournalOpenTab\(a >>> 0, 'faction'\)\) return;/.test(gd) && /__dboJournalFaction\(a >>> 0, p\)\) return;/.test(gd) && /globalThis\.__dboFactionPayload = \(a, keepNonce\) => menuPayload\(/.test(gd));

// ---- closing ----
closed.length = 0; sent.length = 0;
fire('journalClose', P, ['stale']);
check('Close with a stale nonce still closes (closing can do no harm)', closed.some(([a, id]) => a === P && id === 50) && globalThis.__dboJournalIsOpen(P) === false);
check('...and stops the page-turn by the name of the idle it began', sent.some(([a, q]) => a === P && q.customPacketType === 'dboIdleStop' && q.anim === 'IdleBook_PageTurn'));
idleDef = { anim: 'IdleSomethingElse', seconds: 10, hold: true };
globalThis.__dboJournalRequest(P);
sent.length = 0;
now += 11000;
fire('close', P, [], 50);
check('Escape ends it and stops the idle it began however long it ran, named as configured', globalThis.__dboJournalIsOpen(P) === false && sent.some(([a, q]) => a === P && q.customPacketType === 'dboIdleStop' && q.anim === 'IdleSomethingElse'));
idleDef = { anim: 'IdleBook_PageTurn', seconds: 10, hold: true };
globalThis.__dboJournalRequest(P);
fire('close', P, [], 37);
check('a close of another widget leaves the journal open', globalThis.__dboJournalIsOpen(P) === true);
globalThis.__dboJournalYield(P, 50);
check('its own widget opening again does not make it give way', globalThis.__dboJournalIsOpen(P) === true);
closed.length = 0;
globalThis.__dboJournalYield(P, 62);
check('another focused panel opening (a downed, rob or trade prompt) closes the journal after it, as a plain close', globalThis.__dboJournalIsOpen(P) === false && closed.some(([a, id]) => a === P && id === 50));
const gmSrc = fs.readFileSync('gamemode.js', 'utf8');
const ow = gmSrc.slice(gmSrc.indexOf('const openWidget = '), gmSrc.indexOf('const closeWidget = '));
check('gamemode.js openWidget sends the new focused widget first, then asks the journal to give way', ow.indexOf('sendPacket(a, {') < ow.indexOf('__dboJournalYield(a, widget.id)') && /if \(focus && widget && /.test(ow));
online = [BEAST, NOCAP];
globalThis.__dboJournalRequest(P);
online = [BEAST, NOCAP];
timers.journalWatch();
check('a player gone offline has their journal closed on the next tick', globalThis.__dboJournalIsOpen(P) === false);
online = [P, BEAST, NOCAP];

// ---- F2: never while down, dead, bound or fighting; closed when any of those happens ----
const refused = (why) => { told.length = 0; widgets.length = 0; const took = globalThis.__dboJournalRequest(P); return took === true && widgets.length === 0 && told.some(([a, t]) => a === P && why.test(t)); };
setp(P, 'isDead', true); downed.add(P);
check('F3 while down is refused with a word, and panel 37 does not open instead', refused(/while you are down/));
downed.delete(P);
check('...while dead', refused(/lie dead/));
setp(P, 'isDead', false);
setp(P, 'private.restrained', { boundHands: true });
check('...while bound', refused(/bound/));
setp(P, 'private.restrained', null);
globalThis.__dboCombatAt.set(P, now - 2000);
check('...two seconds after a blow', refused(/fight/));
now += 9000;
check('...but opens again once the fight is 8 s past', globalThis.__dboJournalRequest(P) === true && globalThis.__dboJournalIsOpen(P));
closed.length = 0; told.length = 0;
globalThis.__dboCombatAt.set(P, now + 1);
now += 1000; timers.journalWatch();
check('a blow while reading closes it (widget 50 closed, a word to the player)', globalThis.__dboJournalIsOpen(P) === false && closed.some(([a, id]) => a === P && id === 50) && told.some(([, t]) => /Your journal closes/.test(t)), told);
now += 9000;
globalThis.__dboJournalRequest(P);
setp(P, 'isDead', true); downed.add(P);
now += 1000; timers.journalWatch();
check('going down while reading closes it', globalThis.__dboJournalIsOpen(P) === false);
setp(P, 'isDead', false); downed.delete(P);
globalThis.__dboJournalRequest(P);
setp(P, 'private.restrained', { carried: true });
now += 1000; timers.journalWatch();
check('being carried off closes it', globalThis.__dboJournalIsOpen(P) === false);
setp(P, 'private.restrained', null);

// ---- a hot reload keeps an open journal ----
globalThis.__dboJournalRequest(P);
const keep = nonceOf(P);
load();
now += 3001;
fire('journalTitle', P, [keep, 'warrior']);
check('a hot reload keeps the open journal and its nonce', docs.get(P).profile.titleId === 'warrior');

// ---- a deleted character's file goes with it (journalstats.js itself: its keys, orphans() and forget()) ----
{
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-jsweep-'));
  const dir = path.join(tmp, 'journal');
  fs.mkdirSync(dir);
  const saved = new Map(Object.getOwnPropertyNames(globalThis).filter((k) => k.startsWith('__')).map((k) => [k, globalThis[k]]));
  const P2 = new Map(), deleted = new Set(), logs = [];
  const smp = {
    get: (a, k) => { if (deleted.has(a >>> 0)) throw new Error('no such form'); return P2.get(`${a >>> 0}|${k}`); },
    set: (a, k, v) => { if (deleted.has(a >>> 0)) throw new Error('no such form'); P2.set(`${a >>> 0}|${k}`, v); },
  };
  const ids = [0x101, 0x102, 0x103, 0x104, 0x105, 0x106, 0x107, 0x108].map((x) => (0xff000000 + x) >>> 0);
  const keyFor = new Map(ids.map((id, i) => [id, `a1b2c3d4e5f600${i.toString(16).padStart(2, '0')}`]));
  for (const id of ids) {
    P2.set(`${id}|private.dboJournalId`, keyFor.get(id));
    fs.writeFileSync(path.join(dir, `${keyFor.get(id)}.json`), JSON.stringify({ v: 1, since: 1, playMs: 5, actor: id.toString(16), profile: { backstory: `story ${id.toString(16)}` } }));
  }
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a journal');
  require(path.resolve('journalstats.js'))({
    mp: smp, log: (...x) => logs.push(x.join(' ')), personal: () => {}, registerChatCommand: () => {}, every: () => {}, onlineActors: () => [],
    profileOf: (a) => (keyFor.has(a >>> 0) && !deleted.has(a >>> 0) ? 1 : -1), display: String, findAnyByName: () => 0, isAdmin: () => false,
    creationPending: () => false, cfg: { journalStats: { dir, playersFile: path.join(tmp, 'players.json') } },
  });
  const J2 = (() => {
    delete require.cache[path.resolve('journal.js')];
    return require(path.resolve('journal.js'))({
      mp: Object.assign({ lookupEspmRecordById: () => null }, smp), log: (...x) => logs.push(x.join(' ')), display: String, nameOf: () => '', personal: () => {},
      openWidget: () => {}, closeWidget: () => {}, onUi: () => {}, sendPacket: () => {}, every: () => {}, onlineActors: () => [], cfg: {}, skills: skillsDef, hasCap: () => false,
    });
  })();
  const at = (id) => path.join(dir, `${keyFor.get(id)}.json`);
  const aside = (id) => path.join(dir, 'removed', `${keyFor.get(id)}.json`);
  const realUptime = process.uptime;
  check('the journal reads its own fields from the stats file (journalstats keeps doc.profile)', globalThis.__dboJournalDoc.of(ids[0]).profile.backstory === 'story ff000101');
  check('__dboStatsData gives the numbers, and null for a character no key can be kept for', globalThis.__dboStatsData(ids[0]).playMs === 5
    && (deleted.add(0xff0001ff), globalThis.__dboStatsData(0xff0001ff) === null));
  deleted.add(ids[4]);
  process.uptime = () => 60;
  check('no sweep in the first minutes after a boot, when reads can come back empty', J2.sweep() === 0 && J2.sweep() === 0 && fs.existsSync(at(ids[4])));
  process.uptime = () => 7200;
  check('a character gone on one sweep keeps its file (a passing read failure is not a deletion)', J2.sweep() === 0 && fs.existsSync(at(ids[4])));
  check('...gone on the next sweep too, its file is moved aside to removed/, not deleted', J2.sweep() === 1 && !fs.existsSync(at(ids[4])) && fs.existsSync(aside(ids[4])));
  P2.set(`${ids[3]}|private.dboJournalId`, 'ffffffffffffffff');
  J2.sweep();
  check('an actor id that now carries another character\'s key leaves the old file an orphan too', J2.sweep() === 1 && fs.existsSync(aside(ids[3])));
  deleted.add(ids[6]);
  J2.sweep();
  deleted.delete(ids[6]);
  J2.sweep();
  deleted.add(ids[6]);
  check('a strike is forgotten when the character reads again, so two sweeps apart it is not moved', J2.sweep() === 0 && fs.existsSync(at(ids[6])));
  deleted.delete(ids[6]);
  check('a file in the cache (a character in play) is never listed', !globalThis.__dboJournalDoc.orphans().includes(keyFor.get(ids[0])) && (deleted.add(ids[0]), !globalThis.__dboJournalDoc.orphans().includes(keyFor.get(ids[0]))));
  deleted.delete(ids[0]);
  check('...and nothing else is touched (other characters, other files)', [0, 1, 2, 5, 6, 7].every((i) => fs.existsSync(at(ids[i]))) && fs.existsSync(path.join(dir, 'notes.txt')));
  // ids[0] is cached (read above), and a cached file is never listed: 4 of the 6 left are
  for (const i of [1, 2, 5, 6]) deleted.add(ids[i]);
  J2.sweep();
  check('if most files look orphaned at once the check is suspect and nothing is moved', J2.sweep() === 0 && [1, 2, 5, 6].every((i) => fs.existsSync(at(ids[i])))
    && logs.some((l) => /4 of 6 files look orphaned at once/.test(l)), logs.slice(-1));
  process.uptime = realUptime;
  for (const k of Object.getOwnPropertyNames(globalThis)) if (k.startsWith('__') && !saved.has(k)) delete globalThis[k];
  for (const [k, v] of saved) globalThis[k] = v;
  fs.rmSync(tmp, { recursive: true, force: true });
  load();
}

// ---- the small exports ----
const js = fs.readFileSync('journalstats.js', 'utf8');
check('journalstats.js gives the numbers, and the character file is journalstats\' own (one assignment)', /globalThis\.__dboStatsData = \(a\) =>/.test(js)
  && (js.match(/globalThis\.__dboJournalDoc = /g) || []).length === 1 && /globalThis\.__dboJournalDoc = \{ of: statsOf, touch, keyOf, orphans, forget, dir: DIR \};/.test(js));
const idl = fs.readFileSync('idles.js', 'utf8');
check('idles.js plays IdleBook_PageTurn (the allowlisted event of IdleBook_TurnManyPages), 10 s, held where the client knows hold', /journal: \{ anim: 'IdleBook_PageTurn', seconds: 10, endsItself: false, hold: true \}/.test(idl)
  && /def\.hold === true \? \{ hold: true \} : \{\}/.test(idl) && /globalThis\.__dboInteractionIdleDef = \(key\) =>/.test(idl));
check('schools.js reads the primary school without making a menu nonce', /globalThis\.__dboSchoolsPrimary = \(a\) => \{ try \{ return ready\(a\) \? String\(stateOf\(a\)\.primary/.test(fs.readFileSync('schools.js', 'utf8')));
check('naming.js no longer carries a prose filter (the name filter refuses ordinary words)', !/__dboTextBlocked/.test(fs.readFileSync('naming.js', 'utf8')) && !/__dboTextBlocked/.test(fs.readFileSync('journal.js', 'utf8')));

global.setTimeout = realTimeout;
Date.now = realNow;
delete globalThis.__dboJournal;
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
