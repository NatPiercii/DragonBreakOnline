// Two item duplications from the economy review (2026-09-29), both in normal play:
// - gamemode.js giveItem merged new loot into any stack of the same base, so a looted copy took the tempering or
//   enchantment of one the player kept; it joins only a plain stack now, and refuses a count that is not positive.
//   takeGold refuses a negative or NaN amount (a negative one added gold).
// - playermenu.js H (the mask) handed out a fresh mask every time once the last one was dropped or traded while worn.
//   node tests/econ-dupes-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const ok = (c, what, got) => { if (c) pass++; else { fail++; console.log('FAIL', what, got === undefined ? '' : JSON.stringify(got)); } };

// ---- giveItem and takeGold, lifted from gamemode.js as written there
const gm = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const lift = (start) => { const i = gm.indexOf(start); if (i < 0) throw new Error(`not found: ${start}`); const j = gm.indexOf('\n};\n', i); return gm.slice(i, j + 3); };
const GOLD_BASE = 0xf;
const inv = new Map();
const mp = { get: (a, k) => (k === 'inventory' ? inv.get(a) : undefined), set: (a, k, v) => { if (k === 'inventory') inv.set(a, v); } };
const line = (start) => { const i = gm.indexOf(start); if (i < 0) throw new Error(`not found: ${start}`); return gm.slice(i, gm.indexOf('\n', i)); };
const src = [line('const plainEntry'), lift('const giveItem'), lift('const takeGold')].join('\n');
const { giveItem, takeGold } = new Function('mp', 'log', 'GOLD_BASE', 'goldChanged', `${src}\nreturn { giveItem, takeGold };`)(mp, () => {}, GOLD_BASE, () => {});

const SWORD = 0x1359d, A = 0x14;
inv.set(A, { entries: [{ baseId: SWORD, count: 1, health: 1.6, enchantmentId: 0x10 }] });
ok(giveItem(A, SWORD, 1), 'a looted sword is given');
let e = inv.get(A).entries;
ok(e.length === 2 && e[0].count === 1 && e[1].count === 1 && e[1].health === undefined, 'a looted copy does not join a tempered, enchanted stack', e);
giveItem(A, SWORD, 2);
e = inv.get(A).entries;
ok(e.length === 2 && e[1].count === 3 && e[0].count === 1, '...it joins the plain stack beside it', e);
inv.set(A, { entries: [{ baseId: SWORD, count: 1, worn: false, health: undefined }] });
giveItem(A, SWORD, 1);
ok(inv.get(A).entries.length === 1 && inv.get(A).entries[0].count === 2, 'an unworn stack with empty extras is still plain');
ok(!giveItem(A, SWORD, 0) && !giveItem(A, SWORD, -3) && !giveItem(A, SWORD, NaN), 'a count of 0, below 0 or NaN is refused');
ok(inv.get(A).entries[0].count === 2, '...and changes nothing');

inv.set(A, { entries: [{ baseId: GOLD_BASE, count: 100 }] });
ok(!takeGold(A, -50) && inv.get(A).entries[0].count === 100, 'taking a negative amount of gold adds none');
ok(!takeGold(A, NaN) && inv.get(A).entries[0].count === 100, 'taking NaN gold leaves the purse');
ok(takeGold(A, 40) && inv.get(A).entries[0].count === 60, 'a real amount is taken');
ok(takeGold(A, '10') && inv.get(A).entries[0].count === 50, 'a numeric string still works as before');

// ---- the mask
const MASK = 0x808, P = 0xff000001;
const props = new Map([[`${0xff000001}|appearance`, { name: 'Aela', raceId: 0x13746 }]]);
const pm = {
  get: (a, k) => (k === 'inventory' ? inv.get(a) : props.get(`${a}|${k}`)),
  set: (a, k, v) => { if (k === 'inventory') inv.set(a, v); else props.set(`${a}|${k}`, v); },
  getIdFromDesc: () => MASK, getDescFromId: (id) => id.toString(16), callPapyrusFunction: () => {},
  lookupEspmRecordById: () => ({ record: { editorId: 'NordRace' } }),
};
const said = [], ui = new Map();
const timers = [];
const savedTimeout = global.setTimeout; global.setTimeout = (fn) => { timers.push(fn); return 0; };
const runTimers = () => { while (timers.length) timers.shift()(); };
const give = (a, b, n) => { const x = inv.get(a) || { entries: [] }; const es = x.entries.map((q) => Object.assign({}, q)); const h = es.find((q) => q.baseId === b && !q.worn); if (h) h.count += n; else es.push({ baseId: b, count: n }); inv.set(a, { entries: es }); return true; };
require(path.resolve(__dirname, '..', 'playermenu.js'))({
  mp: pm, log: () => {}, personal: (a, t) => said.push(t), system: () => {}, onUi: (n, fn) => ui.set(n, fn), sendPacket: () => {},
  display: String, nameOf: () => 'Aela', tagOf: () => 'AB12', profileOf: () => 1, onlineActors: () => [P], isAdmin: () => false,
  ranksOf: () => [], giveItem: give, makeProp: () => {}, runCommand: () => {}, cfg: {}, every: () => {}, registerChatCommand: () => {},
});
// Each press is 2.5 s after the last, past the toggle cooldown (the burst case below presses faster)
let fakeNow = 1_900_000_000_000;
const savedNow = Date.now; Date.now = () => fakeNow;
const toggle = () => { fakeNow += 2500; ui.get('maskToggle')(P); runTimers(); };
const masks = () => (inv.get(P) || { entries: [] }).entries.filter((q) => q.baseId === MASK).reduce((n, q) => n + q.count, 0);
inv.set(P, { entries: [] });
toggle();
ok(masks() === 1, 'H hands out the mask');
toggle();
ok(masks() === 0, 'H again takes it back');
toggle();
ok(masks() === 1, 'and hands it out again');
inv.set(P, { entries: [] }); // dropped, stored or traded while worn
toggle();
ok(masks() === 0 && props.get(`${P}|private.maskLost`) === MASK, 'taking off a mask the player no longer has records it as lost');
said.length = 0;
toggle();
ok(masks() === 0 && /not on you/.test(said.join(' ')), 'no fresh mask is handed out while the last one is gone', said);
inv.set(P, { entries: [{ baseId: MASK, count: 1 }] }); // got it back
toggle();
ok(masks() === 1 && !props.get(`${P}|private.maskLost`), 'with the lost mask back in hand, H puts that one on and hands out none');
toggle();
ok(masks() === 0, '...and takes it back as before');
// A burst of H, the taken-off masks put away before their removal lands: one mask comes out, not one per press
{
  const pending = [];
  global.setTimeout = (fn) => { pending.push(fn); return 0; };
  inv.set(P, { entries: [] }); props.set(`${P}|private.maskLost`, 0);
  fakeNow += 5000;
  for (let i = 0; i < 20; i++) { ui.get('maskToggle')(P); fakeNow += 50; }
  const handedOut = masks();
  inv.set(P, { entries: [] });                 // put in a chest inside the 1.5 s
  while (pending.length) pending.shift()();
  ok(handedOut <= 1, 'twenty presses of H in a second hand out one mask at most', handedOut);
  global.setTimeout = (fn) => { timers.push(fn); return 0; };
}
Date.now = savedNow;
// X on a player who logged out (their body stays through the logout grace) says so, not "get closer"
said.length = 0;
ui.get('playerMenu')(P, [0xff000099]);
ok(said.some((t) => /stepped out of the world/.test(t)) && !said.some((t) => /Get closer/.test(t)), 'X on a logged-out player says they are gone', said);
global.setTimeout = savedTimeout;

console.log(`${pass}/${pass + fail}`);
process.exitCode = fail ? 1 : 0;
