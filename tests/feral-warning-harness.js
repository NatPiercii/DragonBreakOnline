// A forced werewolf change is felt coming (Nate, 5 Oct; #bugs 1556456325079244860): feralWarn.seconds before the
// change the player is told and the screen shakes (dboShake packets, harder each time), and the change happens only if
// they still can change then. Loads the real supernatural.js against a stub api and drives its timers by hand.
// Second review, 8 Oct: a change that falls due while an appearance editor is open waits for it to close and settle
// instead of passing, and /appearance is refused while one is coming (real appearance.js below): an editor opened in the
// warning and closed unchanged, free and with no cooldown, skipped the change at will.
// node tests/feral-warning-harness.js   (from server/)
'use strict';
const path = require('path');
const store = new Map();
const said = [], packets = [], logs = [], changes = [];
const cmds = {}, timers = {};
let online = [];
const noop = () => {};
let now = Date.UTC(2026, 9, 5, 3, 0);
Date.now = () => now;
// Timers queued by due time and run by hand
let queue = [];
const realSetTimeout = setTimeout;
globalThis.setTimeout = (fn, ms) => { queue.push({ at: now + (Number(ms) || 0), fn }); return queue.length; };
const advance = (ms) => { const end = now + ms; for (;;) { queue.sort((x, y) => x.at - y.at); const n = queue[0]; if (!n || n.at > end) break; queue.shift(); now = n.at; n.fn(); } now = end; };
globalThis.__dboClock = { gameDays: () => 0, isNight: () => false, isFullMoon: () => false, weatherFor: () => 0 };
const mp = {
  get: (id, p) => store.get(`${id}|${p}`),
  set: (id, p, v) => { store.set(`${id}|${p}`, v); },
  getDescFromId: (id) => `${id.toString(16)}:x`, getIdFromDesc: () => 0x1234,
  callPapyrusFunction: () => null, lookupEspmRecordById: () => null, setRaceMenuOpen: () => {},
};
const api = {
  mp, log: (...x) => logs.push(x.join(' ')), audit: noop, personal: (a, t) => said.push([a, t]), system: (a, t) => said.push([a, t]), registerChatCommand: (n, f) => { cmds[n] = f; },
  onUi: noop, openWidget: noop, closeWidget: noop, sendPacket: (a, p) => packets.push([a, p]), display: String, who: String,
  isAdmin: () => true, findByName: () => null, onlineActors: () => online, every: (n, ms, fn) => { timers[n] = fn; }, profileOf: (a) => a,
  nameOf: String, isWorldspace: () => true, needsFeed: noop, hungerOf: () => 100, cfg: {},
};
// The look the transform would keep to revert to (beastform.js tryTransform reads the stored appearance)
globalThis.__dboBeastTransform = (a, key, forced) => { changes.push([a, key, forced, JSON.parse(JSON.stringify(store.get(`${a}|appearance`) || null))]); store.set(`${a}|private.beast`, { form: key }); return true; };
const MODULE = path.resolve(__dirname, '..', 'supernatural.js');
const load = (cfg) => { api.cfg = cfg || {}; delete require.cache[MODULE]; require(MODULE)(api); };
// The 12 s schedule these checks were written for (the default is 45 s since 6 Oct, Jake): passed in, so they test the mechanics
load({ supernatural: { feralWarn: { seconds: 12, shakes: [{ at: 12, strength: 0.25, seconds: 2 }, { at: 6, strength: 0.45, seconds: 2.5 }, { at: 1, strength: 0.7, seconds: 1.5 }] } } });

let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fail++; };
const A = 7;
const shakes = () => packets.filter(([a, p]) => a === A && p.customPacketType === 'dboShake').map(([, p]) => p);
const reset = () => { said.length = 0; packets.length = 0; changes.length = 0; logs.length = 0; queue = []; store.delete(`${A}|private.beast`); globalThis.__dboFeralDue && globalThis.__dboFeralDue.clear(); };
store.set(`${A}|private.supernatural`, { kind: 'werewolf', disease: null, stage: 0, blessed: false });
store.set(`${A}|isDead`, false);
online = [A];
const realRandom = Math.random;
Math.random = () => 0;   // every roll goes feral

// ---- the warning comes first ----
reset();
timers.superFeral();
ok(changes.length === 0, 'a feral roll does not change the werewolf at once');
ok(said.some(([a, t]) => a === A && /The beast is coming\./.test(t)) && packets.some(([a, p]) => a === A && p.customPacketType === 'dboBanner' && /The beast is coming/.test(p.text)), 'the player is told the beast is coming (chat and banner)', said);
ok(shakes().length === 1 && shakes()[0].strength === 0.25 && shakes()[0].seconds === 2, 'the first shake comes with the warning, softly', shakes());
advance(6000);
ok(shakes().length === 2 && shakes()[1].strength === 0.45, 'a harder shake halfway (6 s before)', shakes());
advance(5000);
ok(shakes().length === 3 && shakes()[2].strength === 0.7 && changes.length === 0, 'the hardest a second before the change, still no change', shakes());
timers.superFeral();
ok(shakes().length === 3, 'a second roll while one is coming starts nothing new');
advance(1000);
ok(changes.length === 1 && changes[0][1] === 'werewolf' && changes[0][2] === true, 'the change comes 12 s after the warning, forced', changes);
ok(said.some(([a, t]) => a === A && /beast (tears free|takes you without asking)/.test(t)) && logs.some((l) => /went feral \(hunger 100/.test(l)), 'with the old change line and the old log line');
ok(!globalThis.__dboFeralDue.has(A), 'nothing is left pending');

// ---- it passes when the werewolf can no longer change ----
reset();
timers.superFeral();
store.set(`${A}|isDead`, true);
advance(12000);
ok(changes.length === 0 && logs.some((l) => /forced change passed/.test(l)), 'a werewolf who died in the meantime does not change');
store.set(`${A}|isDead`, false);
reset();
timers.superFeral();
online = [];
advance(12000);
ok(changes.length === 0, 'nor one who logged out');
online = [A];
reset();
timers.superFeral();
store.set(`${A}|private.beast`, { form: 'werewolf' });
advance(12000);
ok(changes.length === 0, 'nor one already in beast form');

// ---- configured ----
reset();
load({ supernatural: { feralWarn: { seconds: 0 } } });
timers.superFeral();
ok(changes.length === 1 && shakes().length === 0, 'feralWarn.seconds 0 changes at once, as before');
reset();
load({ supernatural: { feralWarn: { seconds: 5, shakes: [{ at: 5, strength: 3, seconds: 1 }] } } });
timers.superFeral();
ok(shakes().length === 1 && shakes()[0].strength === 1, 'a shake is held to strength 1', shakes());
advance(5000);
ok(changes.length === 1, 'a configured lead applies (5 s)');

// ---- the full moon's change is warned the same way ----
reset();
load({ supernatural: { feralWarn: { seconds: 12, shakes: [{ at: 12, strength: 0.25, seconds: 2 }, { at: 6, strength: 0.45, seconds: 2.5 }, { at: 1, strength: 0.7, seconds: 1.5 }] } } });
globalThis.__dboClock = { gameDays: () => 1, isNight: () => true, isFullMoon: () => true, weatherFor: () => 0 };
timers.superMoon();
ok(changes.length === 0 && said.some(([, t]) => /full moon pulls at your blood/.test(t)) && shakes().length === 1, 'the full moon warns first too');
advance(12000);
ok(changes.length === 1, '...and the change follows');

// ---- no forced change just after a login (#bugs 1556845702422990888, 6 Oct) ----
globalThis.__dboClock = { gameDays: () => 0, isNight: () => false, isFullMoon: () => false, weatherFor: () => 0 };
reset();
load({ supernatural: { feralWarn: { seconds: 12, shakes: [{ at: 12, strength: 0.25, seconds: 2 }, { at: 6, strength: 0.45, seconds: 2.5 }, { at: 1, strength: 0.7, seconds: 1.5 }] } } });
globalThis.__dboSuperLogin(A);
timers.superFeral();
advance(12000);
ok(changes.length === 0 && shakes().length === 0, 'a werewolf who just logged in does not go feral');
advance(4 * 60000);
timers.superFeral();
advance(12000);
ok(changes.length === 0, '...nor 4 minutes later');
advance(60000);
timers.superFeral();
advance(12000);
ok(changes.length === 1, '...but can after the 5 minutes of feralLoginGraceMinutes', changes);
reset();
globalThis.__dboClock = { gameDays: () => 1, isNight: () => true, isFullMoon: () => true, weatherFor: () => 0 };
globalThis.__dboSuperLogin(A);
timers.superMoon();
ok(changes.length === 0 && shakes().length === 0, 'the full moon waits out the login grace too');
reset();
load({ supernatural: { feralLoginGraceMinutes: 0, feralWarn: { seconds: 12, shakes: [{ at: 12, strength: 0.25, seconds: 2 }] } } });
globalThis.__dboClock = { gameDays: () => 0, isNight: () => false, isFullMoon: () => false, weatherFor: () => 0 };
globalThis.__dboSuperLogin(A);
timers.superFeral();
advance(12000);
ok(changes.length === 1, 'feralLoginGraceMinutes 0 turns it off');

// ---- not while an appearance editor is open (review, 8 Oct): a beast form taken then saved the look from before the
// edit as the one to revert to, and the revert threw away an /appearance edit just paid for ----
let editorOpen = true;
globalThis.__dboAppearanceEdit = { editing: (a) => editorOpen && a === A };
reset();
timers.superFeral();
advance(12000);
ok(changes.length === 0 && shakes().length === 0 && !said.some(([, t]) => /beast is coming/.test(t)), 'the appearance editor open: no warning, no change');
editorOpen = false; reset();
timers.superFeral();
editorOpen = true;
advance(12000);
ok(changes.length === 0 && !logs.some((l) => /forced change passed/.test(l)) && globalThis.__dboFeralDue.has(A) && logs.some((l) => /forced change waits for the appearance editor/.test(l)), 'an editor open when the change falls due: it waits, it does not pass', logs);
advance(60000);
timers.superFeral();
ok(changes.length === 0 && shakes().length === 1 && logs.filter((l) => /waits for the appearance editor/.test(l)).length === 1, 'still waiting a minute later, with no second warning and one log line', shakes().length);
editorOpen = false;
advance(2000);
ok(changes.length === 1 && changes[0][2] === true && !globalThis.__dboFeralDue.has(A) && logs.some((l) => /went feral/.test(l)), 'the editor closed: the held change lands', changes);
reset();
timers.superFeral();
editorOpen = true;
advance(12000);
online = [];
advance(2000);
ok(changes.length === 0 && !globalThis.__dboFeralDue.has(A) && logs.some((l) => /forced change passed/.test(l)), 'held, then logged out: it passes and nothing is left pending');
online = [A];
editorOpen = false; reset();
timers.superFeral();
advance(12000);
ok(changes.length === 1, 'the editor closed: the beast comes again');
globalThis.__dboAppearanceEdit = undefined;

// ---- the real appearance.js (second review, 8 Oct: 5 of 5 changes dodged with an /appearance opened in the warning) ----
const APPEARANCE = path.resolve(__dirname, '..', 'appearance.js');
// The default 45 s warning; no login grace (a login above is still recent on this clock)
const W45 = { supernatural: { feralLoginGraceMinutes: 0, feralWarn: { seconds: 45, shakes: [{ at: 45, strength: 0.25, seconds: 2 }] } } };
const loadBoth = () => { load(W45); delete require.cache[APPEARANCE]; api.cfg = Object.assign({}, W45, { appearance: { cost: 500, cooldownHours: 24 } }); return require(APPEARANCE)(Object.assign({}, api, { userOf: () => 3, later: (fn, ms) => setTimeout(fn, ms) })); };
const LOOK = { raceId: 0x13746, isFemale: false, name: 'Ulfgar', weight: 50, skinColor: 1, hairColor: 2, headpartIds: [0x5162f, 0x51631], headTextureSetId: 3, options: [0], presets: [0], tints: [] };
const gold = () => (store.get(`${A}|inventory`).entries.find((e) => e.baseId === 0xf) || { count: 0 }).count;
const realBoth = () => {
  reset(); loadBoth();
  store.set(`${A}|inventory`, { entries: [{ baseId: 0xf, count: 800 }] });
  store.set(`${A}|appearance`, JSON.parse(JSON.stringify(LOOK)));
  store.set(`${A}|private.dboAppearanceEdit`, null); store.set(`${A}|private.dboChargenEdit`, null); store.set(`${A}|private.dboAppearanceAt`, 0);
  globalThis.__dboCombatAt = new Map(); globalThis.__dboDungeonCells = new Set(); globalThis.__dboIsDowned = null; globalThis.__dboBeastOriginalRace = null;
};
// The engine stores an allowed close before the hook (gamemode.js appearanceHook) hears of it
const closeEditor = (app) => { store.set(`${A}|appearance`, JSON.parse(JSON.stringify(app))); const E = globalThis.__dboAppearanceEdit; return E.pending(A) ? E.finish(A, app) : E.chargenFinish(A, app); };
realBoth();
timers.superFeral();
advance(40000);
said.length = 0;
cmds.appearance(A, '');
ok(said.some(([a, t]) => a === A && t === 'Not while the beast is coming.') && !store.get(`${A}|private.dboAppearanceEdit`), '/appearance 40 s into the warning: refused, the editor does not open', said);
advance(5000);
ok(changes.length === 1 && gold() === 800, 'the change lands at 45 s as warned', changes);
// A GM's /chargen opened during the warning (gamemode.js snapshots it): held till the close and the settle window
realBoth();
timers.superFeral();
advance(40000);
globalThis.__dboAppearanceEdit.chargenOpened(A);
advance(5000);
ok(changes.length === 0 && globalThis.__dboFeralDue.has(A), 'a GM /chargen open when it falls due: held');
advance(120000);
ok(changes.length === 0, 'held for as long as it stays open');
closeEditor(LOOK);
advance(2000);
ok(changes.length === 0, 'not in the client\'s settle window after the close (a rebuild during RaceMenu teardown crashes the client)');
advance(4000);
ok(changes.length === 1 && !globalThis.__dboFeralDue.has(A), 'it lands once the window is over');
// An /appearance opened before the warning could start (no roll warns an open editor), then a paid edit: the change
// that comes after the close keeps the new look (the transform reads it then)
realBoth();
cmds.appearance(A, '');
ok(!!store.get(`${A}|private.dboAppearanceEdit`), 'the editor opens with no change coming');
timers.superFeral();
advance(45000);
ok(changes.length === 0 && shakes().length === 0, 'a roll with the editor open warns nothing and changes nothing');
const paid = Object.assign(JSON.parse(JSON.stringify(LOOK)), { hairColor: 9 });
closeEditor(paid);
ok(gold() === 300 && store.get(`${A}|appearance`).hairColor === 9, 'the edit is saved and paid');
advance(1000);
timers.superFeral();
advance(45000);
ok(changes.length === 0 && shakes().length === 0, 'a roll in the settle window after the close warns nothing either');
advance(4000);
timers.superFeral();
advance(45000);
ok(changes.length === 1 && changes[0][3] && changes[0][3].hairColor === 9 && shakes().length === 1, 'the next roll after the window warns and changes as usual, keeping the new look to revert to', changes);
globalThis.__dboAppearanceEdit = undefined;

Math.random = realRandom;
globalThis.setTimeout = realSetTimeout;
ok(/feralWarn: \{ seconds: 45,/.test(require('fs').readFileSync(MODULE, 'utf8')) && /feralPerMinute: \{ sated: 0,/.test(require('fs').readFileSync(MODULE, 'utf8')), 'defaults (Jake, 6 Oct): a 45 s warning, and no feral change while sated');
console.log(fail ? `${fail} FAILED` : 'all passed');
process.exit(fail ? 1 : 0);
