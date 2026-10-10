// A werewolf (or Vampire Lord) downed or killed (beastform.js revert 'death'): the revert reaches the player's own game while
// it lies in bleed-out and does not hold there (GroundedPasta #7DJT, 10 Oct 21:24Z: woke at the temple still a wolf to
// himself, a mortal to everyone else). The beastForms tick sends the own race again once the player is up and alive.
//   node tests/beast-death-resend-harness.js   (from server/)
'use strict';
const path = require('path');
const WOLF = 0xff000001, OTHER = 0xff000002;
const props = new Map();
const logs = [], packets = [], redressed = [];
const mp = { get: (id, k) => props.get(`${id}|${k}`), set: (id, k, v) => props.set(`${id}|${k}`, v), getIdFromDesc: (d) => 0x100 + d.length, getDescFromId: (id) => id.toString(16), callPapyrusFunction: () => true };
const noop = () => {};
const timers = [];
global.setTimeout = (fn) => { timers.push(fn); return 0; };
globalThis.__dboBeastPowers = undefined;
let online = [WOLF, OTHER];
require(path.resolve(__dirname, '..', 'beastform.js'))({
  mp, log: (...x) => logs.push(x.join(' ')), personal: noop, registerChatCommand: noop, sendPacket: (a, p) => packets.push([a, p]), display: String, who: String, audit: noop,
  findByName: () => null, every: noop, redress: (a) => redressed.push(a), cfg: {}, isAdmin: () => false, onlineActors: () => online,
});
let pass = 0, fail = 0;
const ok = (c, what, got) => { if (c) { pass++; console.log('ok  ', what); } else { fail++; console.log('FAIL', what, got === undefined ? '' : JSON.stringify(got)); } };
const own = { raceId: 0x13746, name: 'Masked Person' };
const wolf = () => { props.set(`${WOLF}|appearance`, { raceId: 0xcdd84, name: 'Werewolf' }); props.set(`${WOLF}|private.beast`, { form: 'werewolf', original: own }); };
const reverts = () => packets.filter(([a, p]) => a === WOLF && p.customPacketType === 'dboBeast' && p.beast === false && p.race === 0x13746).length;
const tick = (now) => globalThis.__dboBeastResendTick(new Set(online), now);

wolf(); props.set(`${WOLF}|isDead`, true);
globalThis.__dboBeastRevert(WOLF, 'death');
const t0 = Date.now();
ok(reverts() === 1 && !props.get(`${WOLF}|private.beast`), 'downed in beast form: reverted, own race sent once');
tick(t0 + 5000);
ok(reverts() === 1, 'still down: not sent again yet');
props.set(`${WOLF}|isDead`, false);
tick(t0 + 500);
ok(reverts() === 1, 'up, but within 2 s of the revert: wait');
tick(t0 + 40000);
ok(reverts() === 2 && logs.some((l) => /is up again after a death in Beast Form: own race sent again/.test(l)), 'up and alive: own race sent again, and logged', logs.slice(-2));
timers.forEach((f) => f());
ok(redressed.includes(WOLF), '...and re-dressed after it');
tick(t0 + 50000);
ok(reverts() === 2, '...once only');

// a revert for another reason is never sent again
wolf(); globalThis.__dboBeastRevert(WOLF, 'revert power'); tick(Date.now() + 10000);
ok(reverts() === 3, 'a revert by the power: no resend');
// taken the form again before getting up: nothing (the new form stands)
wolf(); props.set(`${WOLF}|isDead`, true); globalThis.__dboBeastRevert(WOLF, 'death'); wolf(); props.set(`${WOLF}|isDead`, false);
const n = reverts(); tick(Date.now() + 10000);
ok(reverts() === n, 'a beast again by the time they are up: nothing sent');
// gone offline: dropped (the login revert covers them)
props.set(`${WOLF}|private.beast`, null); wolf(); props.set(`${WOLF}|isDead`, true); globalThis.__dboBeastRevert(WOLF, 'death'); props.set(`${WOLF}|isDead`, false);
online = [OTHER]; const m = reverts(); tick(Date.now() + 10000); online = [WOLF, OTHER]; tick(Date.now() + 20000);
ok(reverts() === m, 'offline before getting up: dropped');

console.log(fail ? `\n${fail} FAILED` : `\nall ${pass} checks passed`);
process.exit(fail ? 1 : 0);
