// beastform.js Mist Form and Bats against a stub mp: the ethereal state cannot be chained, ends with the form, and
// (gamemode.js) an ethereal attacker lands nothing. Combat review, 2026-09-29.
//   node tests/beast-ethereal-harness.js   (from server/)
'use strict';
const path = require('path');
const IDS = { '38ba:Dawnguard.esm': 0x020038ba, '38b9:Dawnguard.esm': 0x020038b9 };
const MIST = IDS['38ba:Dawnguard.esm'], BATS = IDS['38b9:Dawnguard.esm'];
const VL = 0xff000001;
const props = new Map();
const mp = {
  get: (id, k) => props.get(`${id}|${k}`),
  set: (id, k, v) => props.set(`${id}|${k}`, v),
  getIdFromDesc: (d) => IDS[d] || 0x100 + d.length,
  getDescFromId: (id) => id.toString(16),
};
const noop = () => {};
globalThis.__dboBeastPowers = undefined;
require(path.resolve(__dirname, '..', 'beastform.js'))({
  mp, log: noop, personal: noop, registerChatCommand: noop, sendPacket: noop, display: String, who: String, audit: noop,
  findByName: () => null, every: noop, redress: noop, cfg: {}, isAdmin: () => false, onlineActors: () => [VL],
});
let pass = 0, fail = 0;
const ok = (c, what) => { if (c) pass++; else { fail++; console.log('FAIL', what); } };
const setForm = (form) => mp.set(VL, 'private.beast', form ? { form, original: { raceId: 0x13746, name: 'Aela' } } : null);
const realNow = Date.now; let clock = realNow();
Date.now = () => clock;

setForm('vampirelord');
globalThis.__dboBeastPower(VL, BATS);
ok(globalThis.__dboBeastEthereal(VL), 'Bats makes a Vampire Lord untouchable');
clock += 3100;
ok(!globalThis.__dboBeastEthereal(VL), '...for 3 seconds');
globalThis.__dboBeastPower(VL, BATS);
ok(!globalThis.__dboBeastEthereal(VL), 'Bats cannot be pressed again the moment it ends');
clock += 9000;
globalThis.__dboBeastPower(VL, BATS);
ok(globalThis.__dboBeastEthereal(VL), '...but can after its 12 s cooldown');

clock += 30000;
globalThis.__dboBeastPower(VL, MIST);
ok(globalThis.__dboBeastEthereal(VL), 'Mist Form makes a Vampire Lord untouchable');
setForm(null);
ok(!globalThis.__dboBeastEthereal(VL), 'leaving the form mid-Mist ends it (the state no longer outlives the form)');
setForm('vampirelord');
ok(!globalThis.__dboBeastEthereal(VL), '...and taking the form again does not bring it back');
clock += 30000;
globalThis.__dboBeastPower(VL, MIST);
globalThis.__dboBeastRevert(VL, 'test');
ok(!globalThis.__dboBeastEthereal(VL) && !globalThis.__dboBeastPowers.ethereal.has(VL), 'a revert clears the ethereal entry');

// gamemode.js hit hook, step 0, as written there
const gm = require('fs').readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
ok(/__dboBeastEthereal\(tgt\) \|\| \(agg !== tgt && globalThis\.__dboBeastEthereal\(agg\)\)\)\) return false/.test(gm), 'the hit hook refuses an ethereal attacker as well as an ethereal target');
ok(/\} else if \(dmg > 0 && combat && !combat\.spellHitAllowed\(agg, tgt, src\)\) return false;/.test(gm), 'the hit hook asks combat.js to rate spell hits');

Date.now = realNow;
console.log(`${pass}/${pass + fail}`);
process.exitCode = fail ? 1 : 0;
