// A forced werewolf change is felt coming (Nate, 5 Oct; #bugs 1556456325079244860): feralWarn.seconds before the
// change the player is told and the screen shakes (dboShake packets, harder each time), and the change happens only if
// they still can change then. Loads the real supernatural.js against a stub api and drives its timers by hand.
// An appearance editor neither holds nor skips a forced change (8 Oct): the change comes as it always did, and only
// /appearance waits while one is coming (real appearance.js at the end). A hold tried on 8 Oct let an /appearance opened
// just before the roll and closed unchanged, free and with no cooldown, skip every change.
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
globalThis.__dboBeastTransform = (a, key, forced) => { changes.push([a, key, forced]); store.set(`${a}|private.beast`, { form: key }); return true; };
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

// ---- an appearance editor changes nothing about a forced change (8 Oct): the real appearance.js, the default 45 s ----
const APPEARANCE = path.resolve(__dirname, '..', 'appearance.js');
// The default 45 s warning; no login grace (a login above is still recent on this clock)
const W45 = { supernatural: { feralLoginGraceMinutes: 0, feralWarn: { seconds: 45, shakes: [{ at: 45, strength: 0.25, seconds: 2 }] } } };
const loadBoth = () => { load(W45); delete require.cache[APPEARANCE]; api.cfg = Object.assign({}, W45, { appearance: { cost: 500, cooldownHours: 24 } }); return require(APPEARANCE)(Object.assign({}, api, { userOf: () => 3, later: (fn, ms) => setTimeout(fn, ms) })); };
const LOOK = { raceId: 0x13746, isFemale: false, name: 'Ulfgar', weight: 50, skinColor: 1, hairColor: 2, headpartIds: [0x5162f, 0x51631], headTextureSetId: 3, options: [0], presets: [0], tints: [] };
const gold = () => (store.get(`${A}|inventory`).entries.find((e) => e.baseId === 0xf) || { count: 0 }).count;
const warned = () => said.some(([a, t]) => a === A && /The beast is coming\./.test(t));
const realBoth = () => {
  reset(); loadBoth();
  store.set(`${A}|inventory`, { entries: [{ baseId: 0xf, count: 800 }] });
  store.set(`${A}|appearance`, JSON.parse(JSON.stringify(LOOK)));
  store.set(`${A}|private.dboAppearanceEdit`, null); store.set(`${A}|private.dboChargenEdit`, null); store.set(`${A}|private.dboAppearanceAt`, 0);
  globalThis.__dboCombatAt = new Map(); globalThis.__dboDungeonCells = new Set(); globalThis.__dboIsDowned = null; globalThis.__dboBeastOriginalRace = null;
};
// The engine stores an allowed close before the hook (gamemode.js appearanceHook) hears of it
const closeEditor = (app) => { store.set(`${A}|appearance`, JSON.parse(JSON.stringify(app))); const E = globalThis.__dboAppearanceEdit; return E.pending(A) ? E.finish(A, app) : E.chargenFinish(A, app); };
// The pre-tick dodge: /appearance opened 2 s before the superFeral tick and closed unchanged 1 s after it, five times
realBoth();
let warnings = 0;
for (let i = 0; i < 5; i++) {
  store.delete(`${A}|private.beast`);
  cmds.appearance(A, '');
  advance(2000); said.length = 0;
  timers.superFeral();
  if (warned()) warnings++;
  advance(1000);
  closeEditor(LOOK);
  advance(57000);
}
ok(warnings === 5 && changes.length === 5 && changes.every((c) => c[2] === true), '/appearance opened just before each roll and closed unchanged: every roll still warns and every change lands', { warnings, changes: changes.length });
ok(gold() === 800 && !store.get(`${A}|private.dboAppearanceAt`) && !logs.some((l) => /forced change passed/.test(l)), '...each close free, as before, and no change passed', gold());
// The full moon's change the same way
realBoth();
globalThis.__dboClock = { gameDays: () => 1, isNight: () => true, isFullMoon: () => true, weatherFor: () => 0 };
cmds.appearance(A, '');
advance(2000);
timers.superMoon();
ok(said.some(([a, t]) => a === A && /full moon pulls at your blood/.test(t)) && shakes().length === 1, 'the full moon with /appearance open: warned as usual');
advance(1000);
closeEditor(LOOK);
advance(44000);
ok(changes.length === 1 && changes[0][2] === true, '...closed unchanged, and the change lands 45 s after the warning', changes);
globalThis.__dboClock = { gameDays: () => 0, isNight: () => false, isFullMoon: () => false, weatherFor: () => 0 };
// An editor still open when the change falls due: it lands on time, as before the guards (the editor's result can then
// overwrite it: a known issue, appearance.js header)
realBoth();
cmds.appearance(A, '');
timers.superFeral();
ok(warned() && shakes().length === 1, 'a roll with /appearance open warns as usual');
advance(45000);
ok(changes.length === 1 && !globalThis.__dboFeralDue.has(A), '...and the change lands on time with the editor still open: nothing holds it', changes);
realBoth();
timers.superFeral();
advance(40000);
globalThis.__dboAppearanceEdit.chargenOpened(A);
advance(5000);
ok(changes.length === 1 && !globalThis.__dboFeralDue.has(A), 'a GM /chargen opened in the warning: the change lands on time all the same', changes);
// /appearance opened in the warning: refused, so the editor is not open when the change lands
realBoth();
timers.superFeral();
advance(40000);
said.length = 0;
cmds.appearance(A, '');
ok(said.some(([a, t]) => a === A && t === 'Not while the beast is coming.') && !store.get(`${A}|private.dboAppearanceEdit`), '/appearance 40 s into the warning: refused, the editor does not open', said);
advance(5000);
ok(changes.length === 1 && gold() === 800, 'the change lands at 45 s as warned', changes);
globalThis.__dboAppearanceEdit = undefined;

Math.random = realRandom;
globalThis.setTimeout = realSetTimeout;
ok(/feralWarn: \{ seconds: 45,/.test(require('fs').readFileSync(MODULE, 'utf8')) && /feralPerMinute: \{ sated: 0,/.test(require('fs').readFileSync(MODULE, 'utf8')), 'defaults (Jake, 6 Oct): a 45 s warning, and no feral change while sated');
console.log(fail ? `${fail} FAILED` : 'all passed');
process.exit(fail ? 1 : 0);
