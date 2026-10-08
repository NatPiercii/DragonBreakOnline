// A patron's identity reroll (patrons.js /reroll) reopens RaceMenu on the same character, as /appearance and a GM's
// /chargen do, so a close that keeps race and sex can come back with the Nord head in place of the race's own (review,
// 8 Oct). Loads the real patrons.js and appearance.js and runs gamemode.js's own appearanceHook cut out of the file: the
// head goes back before the reroll is spent and before the vampire race fix reads the look; a reroll to another race or
// sex is left as made; a menu that failed to open leaves no snapshot behind (it would hold a vampire's tells). Second
// review, 8 Oct: a reroll's new look goes to the tells as an /appearance edit does (a feed gave back the look from
// before it), the hold lasts through the client's settle window after the close, and /reroll waits while a forced
// werewolf change is coming (an open creator would only hold it).
//   node tests/appearance-reroll-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
// patrons.js reads patron-tiers.json and writes patron-tokens.json in the working directory
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance-reroll-'));
fs.copyFileSync(path.join(ROOT, 'patron-tiers.json'), path.join(tmp, 'patron-tiers.json'));
process.chdir(tmp);
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });

let fails = 0;
const ok = (c, label, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${label}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };

const A = 0xff000101;
const NORD_M = 0x5162f;
// The clock, moved on by hand past the client's settle window after a close
let skew = 0;
const realNow = Date.now;
Date.now = () => realNow() + skew;
const settleWindow = () => { skew += 4000; };
const props = new Map();
let said = [], audits = [], timers = [], reapplied = [], retakes = [], order = [], failOpen = false;
const mp = {
  get: (id, k) => props.get(`${id}|${k}`),
  set: (id, k, v) => { props.set(`${id}|${k}`, v); },
  setRaceMenuOpen: (id, on) => { if (failOpen && on) throw new Error('no such actor'); },
};
const owner = JSON.parse(fs.readFileSync('patron-tiers.json', 'utf8')).tiers.find((t) => t.rerolls === 'unlimited');
const cmds = new Map();
const api = {
  mp, log: () => {}, personal: (a, t) => said.push(t), system: (a, t) => said.push(t), audit: (t) => audits.push(t), who: () => 'Brand', display: () => 'Brand',
  registerChatCommand: (n, f) => cmds.set(n, f), cfg: { appearance: { cost: 500, cooldownHours: 24 } },
  userOf: () => 3, profileOf: () => 7, rolesOf: () => [String(owner.roleId)], isAdmin: () => false, findByName: () => null,
  later: (fn, ms) => timers.push({ fn, ms }),
};
delete globalThis.__dboPatronStore;
require(path.join(ROOT, 'appearance.js'))(api);
require(path.join(ROOT, 'patrons.js'))(api);
const E = globalThis.__dboAppearanceEdit;
// What the vampire race fix (supernatural.js, called by __dboRerollDone) would read, and the tells retake
globalThis.__dboSuperReapplyLook = (a) => { order.push('race fix'); reapplied.push(JSON.parse(JSON.stringify(props.get(`${a}|appearance`)))); };
globalThis.__dboTellsRetake = (a, before) => { order.push('tells'); retakes.push(before); };

// gamemode.js's appearanceHook, as written there, over stubs of what it calls
const src = fs.readFileSync(path.join(ROOT, 'gamemode.js'), 'utf8');
const hookSrc = src.slice(src.indexOf('const appearanceHook = '), src.indexOf('appearanceHook.__dbo = true;'));
ok(hookSrc.length > 200, 'gamemode.js has its appearanceHook');
globalThis.__dboAppearanceHookPrev = () => true;
globalThis.__dboCreatorName = null;
const hook = new Function('mp', 'log', 'creationPending', 'moveToHubWhenReady', 'giveStarterKit', 'creatorClosedAt', 'endCreation', 'CREATION_MOVE_MS', 'setTimeout',
  `${hookSrc}\nreturn appearanceHook;`)(mp, () => {}, (a) => props.get(`${a}|private.creationPending`) === true,
  () => {}, () => {}, { set: () => {} }, () => {}, 9000, () => {});

// A Breton man (4 Oct look); the editor's result with the Nord head swapped in, as /appearance's closes came back
const look = (raceId, headpartIds, extra) => Object.assign({ raceId, isFemale: false, name: 'Brand Stoneborn', weight: 50, skinColor: 13021352, hairColor: 2,
  headpartIds, headTextureSetId: 3, options: [0], presets: [0], tints: [] }, extra || {});
const bretonM = () => look(0x13741, [0x51633, 0x51631, 0x8555f, 0x220064cb]);
const stored = () => props.get(`${A}|appearance`);
const parts = (x) => x.headpartIds.map((h) => h.toString(16)).join(' ');
const reset = () => { props.clear(); props.set(`${A}|appearance`, bretonM()); said = []; audits = []; timers = []; reapplied = []; retakes = []; order = []; failOpen = false; };
// The creator closes allowed with `after` (the engine stores it first)
const close = (after) => { props.set(`${A}|appearance`, JSON.parse(JSON.stringify(after))); return hook(A, after, true); };

// 1. A reroll that keeps race and sex: own head back before the reroll is spent and the vampire fix reads the look
reset();
cmds.get('reroll')(A, 'confirm');
const snap = props.get(`${A}|private.dboChargenEdit`);
ok(props.get(`${A}|private.rerollPending`) === true && snap && snap.kind === 'reroll' && JSON.stringify(snap.before) === JSON.stringify(bretonM()), '/reroll confirm snapshots the look once the creator is open');
ok(E.editing(A), 'an open reroll counts as an open editor (the tells and forced changes wait)');
close(look(0x13741, [0x51631, 0x8555f, 0x220064cb, NORD_M], { hairColor: 9 }));
ok(parts(stored()) === '51633 51631 8555f 220064cb' && stored().hairColor === 9, 'the Nord head out, their own back in its slot, the new hair kept', parts(stored()));
ok(props.get(`${A}|private.rerollPending`) === false && audits.some((t) => /^REROLL /.test(t)), 'the reroll is spent as before');
ok(reapplied.length === 1 && reapplied[0].headpartIds.includes(0x51633) && !reapplied[0].headpartIds.includes(NORD_M), 'the vampire race fix reads the corrected look', reapplied.map(parts));
ok(audits.some((t) => t === "APPEARANCE Brand editor swapped in Nord's default head; kept their own (reroll)") && said.some((t) => /another race's face; your own was kept/.test(t)), 'audited and the player told', audits);
ok(timers.length === 1 && timers[0].ms === 3500, 'sent again after the settle window');
ok(retakes.length === 1 && JSON.stringify(retakes[0]) === JSON.stringify(bretonM()) && order.join() === 'tells,race fix', 'the new look goes to the tells, with the look before, ahead of the vampire race fix', order);
ok(!props.get(`${A}|private.dboChargenEdit`) && E.editing(A), 'the snapshot is gone with the close; the tells are still held in the client\'s settle window');
settleWindow();
ok(!E.editing(A), 'and released after it');

// 2. A reroll to another race (or sex) is left as made
reset();
cmds.get('reroll')(A, 'confirm');
const nord = look(0x13746, [NORD_M, 0x51631, 0x8555f], { hairColor: 9 });
close(nord);
ok(JSON.stringify(stored()) === JSON.stringify(nord) && !audits.some((t) => /swapped in/.test(t)) && props.get(`${A}|private.rerollPending`) === false, 'a Breton rerolled into a Nord keeps the Nord head', parts(stored()));
reset();
cmds.get('reroll')(A, 'confirm');
const woman = look(0x13741, [0x51631, 0x8555f, 0x51623], { isFemale: true });
close(woman);
ok(JSON.stringify(stored()) === JSON.stringify(woman) && !audits.some((t) => /swapped in/.test(t)), 'a change of sex is left as made');

// 3. The editor kept their own head: nothing to put back
reset();
cmds.get('reroll')(A, 'confirm');
const kept = look(0x13741, [0x51631, 0x8555f, 0x220064cb, 0x51633], { hairColor: 9 });
close(kept);
ok(JSON.stringify(stored()) === JSON.stringify(kept) && !audits.some((t) => /swapped in/.test(t)) && timers.length === 0, 'their own head came back: the look stands as made, nothing sent again');
reset(); settleWindow();
cmds.get('reroll')(A, 'confirm');
close(JSON.parse(JSON.stringify(bretonM())));
ok(retakes.length === 0 && props.get(`${A}|private.rerollPending`) === false, 'a reroll closed with the look unchanged: nothing for the tells, the reroll spent as before');

// 4. A creator that would not open leaves no snapshot, and an unfinished reroll reopened takes a fresh one
reset(); settleWindow(); failOpen = true;
cmds.get('reroll')(A, 'confirm');
ok(!props.get(`${A}|private.dboChargenEdit`) && props.get(`${A}|private.rerollPending`) === false && !E.editing(A), 'the creator failed to open: no snapshot left to hold the tells');
reset();
props.set(`${A}|private.rerollPending`, true);
cmds.get('reroll')(A, '');
ok(props.get(`${A}|private.dboChargenEdit`) && props.get(`${A}|private.dboChargenEdit`).kind === 'reroll', 'an unfinished reroll reopened is snapshotted too');

// 5. Not while a forced werewolf change is coming (supernatural.js __dboFeralDue): the open creator would hold it, and the
// unlimited tier could skip every change that way (second review, 8 Oct)
reset(); settleWindow(); said = [];
globalThis.__dboFeralDue = new Map([[A, Date.now() + 30000]]);
cmds.get('reroll')(A, 'confirm');
ok(said.at(-1) === 'Not while the beast is coming.' && !props.get(`${A}|private.rerollPending`) && !props.get(`${A}|private.dboChargenEdit`), '/reroll waits while the beast is coming', said.at(-1));
props.set(`${A}|private.rerollPending`, true); said = [];
cmds.get('reroll')(A, '');
ok(said.at(-1) === 'Not while the beast is coming.' && !props.get(`${A}|private.dboChargenEdit`), '...an unfinished one too', said.at(-1));
globalThis.__dboFeralDue = new Map([[A, Date.now() - 120000]]); said = [];
cmds.get('reroll')(A, '');
ok(props.get(`${A}|private.dboChargenEdit`), 'a due time two minutes past is a leftover: the creator opens', said);
globalThis.__dboFeralDue = new Map();

// 6. patrons.js snapshots after it opens the creator
const pat = fs.readFileSync(path.join(ROOT, 'patrons.js'), 'utf8');
const openSrc = pat.slice(pat.indexOf('const open = (a) =>'), pat.indexOf("registerChatCommand('reroll'"));
ok(openSrc.indexOf("chargenOpened(a, 'reroll')") > openSrc.indexOf('mp.setRaceMenuOpen(a, true)') && openSrc.indexOf('mp.setRaceMenuOpen(a, true)') > 0, 'patrons.js open() takes the snapshot once the creator is open');

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
