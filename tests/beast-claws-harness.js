// A beast's claws are its own (combat review, 2026-09-29): supernatural.js gives the beast multiplier to claws (the
// engine's unarmed source 0x1f4) and not to a weapon a modified client kept in hand, and gamemode.js leaves the Martial
// Arts fist bonus, drain and disarm out for a player in beast form.
// Also #9 of that review: a bound, carried or paralysed attacker lands no blow (read from the hit hook's text).
//   node tests/beast-claws-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const MODULE = path.resolve(__dirname, '..', 'supernatural.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-beast-claws-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });

const CLAWS = 0x1f4, GREATSWORD = 0x1359f, FIREBOLT = 0x12fcd;
const RECORDS = { [CLAWS]: 'WEAP', [GREATSWORD]: 'WEAP', [FIREBOLT]: 'SPEL' };
const store = new Map();
const noop = () => {};
const mp = {
  get: (id, p) => (p === 'type' ? 'MpActor' : store.get(`${id}|${p}`)),
  set: (id, p, v) => store.set(`${id}|${p}`, v),
  getDescFromId: (id) => `${id.toString(16)}:x`, getIdFromDesc: () => 0x1234, callPapyrusFunction: () => null,
  lookupEspmRecordById: (id) => (RECORDS[id] ? { record: { type: RECORDS[id], fields: [] } } : null),
};
const WOLF = 0x77, VL = 0x78, MORTAL = 0x79, VICTIM = 0x80;
store.set(`${WOLF}|private.beast`, { form: 'werewolf', original: {} });
store.set(`${VL}|private.beast`, { form: 'vampirelord', original: {} });
const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'gamemode-config.json'), 'utf8'));
delete globalThis.__dboSuperState;
require(MODULE)({
  mp, log: noop, audit: noop, personal: noop, registerChatCommand: noop, onUi: noop, openWidget: noop, closeWidget: noop,
  sendPacket: noop, display: String, who: String, isAdmin: () => false, findByName: () => null, onlineActors: () => [], every: noop,
  profileOf: (a) => a, nameOf: String, isWorldspace: () => true, needsFeed: noop, hungerOf: () => 0, cfg: { supernatural: cfg.supernatural || {} },
});
let pass = 0, fail = 0;
const ok = (c, what, got) => { if (c) pass++; else { fail++; console.log('FAIL', what, got === undefined ? '' : JSON.stringify(got)); } };
const mult = (a, src) => globalThis.__dboSuperDamageMult(a, VICTIM, src);
const wolfMult = Number(((cfg.supernatural || {}).beastMeleeMult || {}).werewolf) || 2.5;

ok(mult(WOLF, CLAWS) === wolfMult, "a werewolf's claws take the beast multiplier", mult(WOLF, CLAWS));
ok(mult(VL, CLAWS) > 1, "a Vampire Lord's claws take it", mult(VL, CLAWS));
ok(mult(WOLF, GREATSWORD) === 1, 'a greatsword held in beast form does not', mult(WOLF, GREATSWORD));
ok(mult(VL, FIREBOLT) === 1, 'nor does a spell', mult(VL, FIREBOLT));
ok(mult(MORTAL, CLAWS) === 1, 'a mortal fist does not', mult(MORTAL, CLAWS));

const gm = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
ok(/let mult = \(beastAgg \? 1 : masteryDamageMult\(agg, src\)\)/.test(gm), 'the hit hook skips the Martial Arts mastery bonus in beast form');
ok(/if \(martial && !beastAgg\)/.test(gm), '...and the fist effects (drain, disarm, armour)');

// Held attackers (combat review #9): bound, carried or paralysed, as the hit hook reads them
ok(/if \(r && \(r\.boundHands \|\| r\.carried\)\) return false;/.test(gm), 'a bound or carried attacker lands no blow');
ok(/if \(agg !== tgt && \(paralysedUntil\.get\(agg\) \|\| 0\) > Date\.now\(\)\) return false;/.test(gm), 'a paralysed attacker lands no blow');
console.log(`${pass}/${pass + fail}`);
process.exitCode = fail ? 1 : 0;
