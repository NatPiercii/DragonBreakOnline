// H (the mask) lends a face covering by race and takes it back on the next press. A /bug (2026-10-01): a Khajiit
// pressed H while wearing their own mask, Sentinel's "Bosmer Mask" turned up in the inventory, and the player read it
// as a free item they never had. The loan was working; the words never said it was a loan. Now they do.
//   node tests/mask-loan-harness.js   (from server/)
'use strict';
const path = require('path');
let pass = 0, fail = 0;
const ok = (c, what, got) => { if (c) pass++; else { fail++; console.log('FAIL', what, got === undefined ? '' : JSON.stringify(got)); } };

const RACE_MASK = 0xfe00c849, DEFAULT_MASK = 0xfe00b808, OWN_MASK = 0x80f85, P = 0xff000021;
const DESCS = { '849:Sentinel.esp': RACE_MASK, '808:Armors of the Velothi Pt2.esp': DEFAULT_MASK };
const RACES = { 0x13745: 'KhajiitRace', 0x13746: 'NordRace' };
const inv = new Map(), props = new Map();
const entries = () => (inv.get(P) || { entries: [] }).entries;
const count = (b) => entries().filter((q) => q.baseId === b).reduce((n, q) => n + q.count, 0);
const wornOf = (b) => entries().some((q) => q.baseId === b && q.worn);
const pm = {
  get: (a, k) => (k === 'inventory' ? inv.get(a) : props.get(`${a}|${k}`)),
  set: (a, k, v) => { if (k === 'inventory') inv.set(a, v); else props.set(`${a}|${k}`, v); },
  getIdFromDesc: (d) => DESCS[d] || 0, getDescFromId: (id) => id.toString(16),
  // The client equips and unequips what the server asks; its equipment report flips the worn flag
  callPapyrusFunction: (kind, cls, method, self, args) => {
    const b = parseInt(args[0].desc, 16);
    const e = entries().find((q) => q.baseId === b);
    if (e) e.worn = method === 'EquipItem';
  },
  lookupEspmRecordById: (id) => ({ record: { editorId: RACES[id] || '' } }),
};
const said = [], ui = new Map(), timers = [];
const savedTimeout = global.setTimeout; global.setTimeout = (fn) => { timers.push(fn); return 0; };
const runTimers = () => { while (timers.length) timers.shift()(); };
const give = (a, b, n) => { const x = inv.get(a) || { entries: [] }; const es = x.entries.map((q) => Object.assign({}, q)); const h = es.find((q) => q.baseId === b && !q.worn); if (h) h.count += n; else es.push({ baseId: b, count: n }); inv.set(a, { entries: es }); return true; };
require(path.resolve(__dirname, '..', 'playermenu.js'))({
  mp: pm, log: () => {}, personal: (a, t) => said.push(t), system: () => {}, onUi: (n, fn) => ui.set(n, fn), sendPacket: () => {},
  display: String, nameOf: () => 'Someone', tagOf: () => 'AB12', profileOf: () => 1, onlineActors: () => [P], isAdmin: () => false,
  ranksOf: () => [], giveItem: give, makeProp: () => {}, runCommand: () => {}, every: () => {}, registerChatCommand: () => {},
  cfg: { playerMenu: { maskItemByRace: { ArgonianRace: '849:Sentinel.esp', KhajiitRace: '849:Sentinel.esp', OrcRace: '849:Sentinel.esp' } } },
});
let fakeNow = 1_900_000_000_000;
const savedNow = Date.now; Date.now = () => fakeNow;
const press = () => { said.length = 0; fakeNow += 2500; ui.get('maskToggle')(P); runTimers(); return said.join(' '); };

// The report: a Khajiit already wearing their own mask presses H
props.set(`${P}|appearance`, { name: 'Someone', raceId: 0x13745 });
inv.set(P, { entries: [{ baseId: OWN_MASK, count: 1, worn: true }] });
let t = press();
ok(count(RACE_MASK) === 1 && wornOf(RACE_MASK), 'H on a Khajiit lends and puts on the race mask (Sentinel\'s Bosmer Mask)', entries());
ok(count(DEFAULT_MASK) === 0, '...not the default Camonna mask');
ok(props.get(`${P}|appearance`).name === 'Masked Person', '...and the name shown is Masked Person');
ok(/borrowed/i.test(t), 'the message says the mask is borrowed, not given', t);
ok(/hand it back/i.test(t), '...and that H hands it back', t);
t = press();
ok(count(RACE_MASK) === 0, 'H again takes the lent mask back', entries());
ok(count(OWN_MASK) === 1, '...and leaves the player\'s own mask alone', entries());
ok(props.get(`${P}|appearance`).name === 'Someone', '...and the real name is back');
ok(/hand(ed)? it back/i.test(t) && /borrowed/i.test(t), 'taking it off says the borrowed mask went back', t);

// Any other race borrows the default mask, with the same words
props.set(`${P}|appearance`, { name: 'Someone', raceId: 0x13746 });
inv.set(P, { entries: [] });
t = press();
ok(count(DEFAULT_MASK) === 1 && count(RACE_MASK) === 0, 'a Nord borrows the default mask', entries());
ok(/borrowed/i.test(t), '...told it is borrowed', t);
press();
ok(count(DEFAULT_MASK) === 0, '...and gives it back');

Date.now = savedNow;
global.setTimeout = savedTimeout;
console.log(`${pass}/${pass + fail}`);
process.exitCode = fail ? 1 : 0;
