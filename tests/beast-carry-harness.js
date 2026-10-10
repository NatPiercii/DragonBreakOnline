// A beast form cut short by the session ending keeps its rest (beastform.js keepCarry / carryOf): GroundedPasta #7DJT,
// 10 Oct, "crashed while in wolf form and lost my whole beast form". A login or logout revert of a werewolf keeps the
// seconds left; the next change that in-game day takes only those and spends no daily change (supernatural.js
// __dboBeastAllow opts.carry). A death, the timer or a revert by choice keeps nothing; a new day drops the carry.
//   node tests/beast-carry-harness.js   (from server/)
'use strict';
const path = require('path');
let now = 1790000000000;
Date.now = () => now;
const WOLF = 0xff000001;
const props = new Map();
const logs = [], said = [];
const mp = {
  get: (id, k) => props.get(`${id}|${k}`),
  set: (id, k, v) => props.set(`${id}|${k}`, v),
  getIdFromDesc: (d) => 0x100 + d.length,
  getDescFromId: (id) => id.toString(16),
  callPapyrusFunction: () => true,
};
const noop = () => {};
global.setTimeout = () => 0;
globalThis.__dboBeastPowers = undefined;
let day = 10.2;
globalThis.__dboClock = { gameDays: () => day };
// The daily limit as supernatural.js applies it: one change a day, none counted for a carried rest
const allowed = [];
let usedToday = 0;
globalThis.__dboBeastAllow = (a, key, forced, opts) => {
  allowed.push(opts || null);
  if (opts && opts.carry === true) return null;
  if (usedToday >= 1) return 'The beast within is spent for today.';
  usedToday++;
  return null;
};
require(path.resolve(__dirname, '..', 'beastform.js'))({
  mp, log: (...x) => logs.push(x.join(' ')), personal: (a, t) => said.push(t), registerChatCommand: noop, sendPacket: noop,
  display: String, who: String, audit: noop, findByName: () => null, every: noop, redress: noop, cfg: {}, isAdmin: () => false,
  onlineActors: () => [WOLF],
});
let pass = 0, fail = 0;
const ok = (c, what, detail) => { if (c) { pass++; console.log('ok  ', what); } else { fail++; console.log('FAIL', what, detail !== undefined ? detail : ''); } };
const appearance = { raceId: 0x13746, name: 'Masked Person' };
props.set(`${WOLF}|appearance`, appearance);
const beast = () => props.get(`${WOLF}|private.beast`);
const carry = () => props.get(`${WOLF}|private.beastCarry`);
const secondsLeft = () => Math.round((beast().until - now) / 1000);

ok(globalThis.__dboBeastTransform(WOLF, 'werewolf') === true && secondsLeft() === 150, 'the first change of the day lasts 150 s');
now += 20000;
globalThis.__dboBeastRevert(WOLF, 'login');   // a crash: the state outlived the session, and the next login reverts it
ok(!beast() && carry() && carry().seconds === 130 && carry().form === 'werewolf', 'a login revert 20 s in keeps 130 s', JSON.stringify(carry()));
now += 40000;
ok(globalThis.__dboBeastTransform(WOLF, 'werewolf') === true, 'the next change that day is allowed although the day\'s change is spent');
ok(allowed[allowed.length - 1] && allowed[allowed.length - 1].carry === true, '...as a carried rest, which spends no daily change');
ok(secondsLeft() === 130, '...for the 130 s kept, not a full change', secondsLeft());
ok(!carry(), '...and the carry is used up');
now += 30000;
globalThis.__dboBeastRevert(WOLF, 'revert power');
ok(!carry(), 'a revert by choice keeps nothing');
ok(globalThis.__dboBeastTransform(WOLF, 'werewolf') === false && !beast(), 'so the day is spent after it');

// A logout revert keeps the rest too; a death does not
usedToday = 0; day = 11.1;
globalThis.__dboBeastTransform(WOLF, 'werewolf');
now += 100000;
globalThis.__dboBeastRevert(WOLF, 'logout');
ok(carry() && carry().seconds === 50, 'a logout revert 100 s in keeps 50 s', JSON.stringify(carry()));
props.set(`${WOLF}|private.beastCarry`, null);
usedToday = 0; day = 12.1;
globalThis.__dboBeastTransform(WOLF, 'werewolf');
now += 10000;
globalThis.__dboBeastRevert(WOLF, 'death');
ok(!carry(), 'a death keeps nothing');

// Too little left keeps nothing; a carry from yesterday is dropped and the day's own change is spent as usual
usedToday = 0; day = 13.1;
globalThis.__dboBeastTransform(WOLF, 'werewolf');
now += 145000;
globalThis.__dboBeastRevert(WOLF, 'login');
ok(!carry(), 'under 10 s left keeps nothing');
props.set(`${WOLF}|private.beastCarry`, { form: 'werewolf', seconds: 90, at: now, day: 13 });
usedToday = 0; day = 14.05;
globalThis.__dboBeastTransform(WOLF, 'werewolf');
ok(secondsLeft() === 150 && usedToday === 1 && !carry(), 'a carry from an earlier in-game day is dropped: a full change, counted');
globalThis.__dboBeastRevert(WOLF, 'revert power');

// A carry never makes a change longer than a full one, whatever was written
props.set(`${WOLF}|private.beastCarry`, { form: 'werewolf', seconds: 9999, at: now, day: 14 });
globalThis.__dboBeastTransform(WOLF, 'werewolf');
ok(secondsLeft() === 150, 'a carry is capped at one full change', secondsLeft());

console.log(fail ? `\n${fail} FAILED` : `\nall ${pass} checks passed`);
process.exit(fail ? 1 : 0);
