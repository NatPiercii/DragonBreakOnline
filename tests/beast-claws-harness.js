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
// RACE DATA with the unarmed damage at 96 (libespm RACE.cpp). getIdFromDesc gives every beast race 0x1234 here
const raceData = (unarmed) => { const d = new Uint8Array(128); new DataView(d.buffer).setFloat32(96, unarmed, true); return { type: 'RACE', fields: [{ type: 'DATA', data: d }] }; };
const BEAST_RACE = 0x1234, IMPERIAL = 0x13744, KHAJIIT = 0x13745;
const RACES = { [BEAST_RACE]: raceData(20), [IMPERIAL]: raceData(4), [KHAJIIT]: raceData(14) };
const store = new Map();
const noop = () => {};
const mp = {
  get: (id, p) => (p === 'type' ? 'MpActor' : store.get(`${id}|${p}`)),
  set: (id, p, v) => store.set(`${id}|${p}`, v),
  getDescFromId: (id) => `${id.toString(16)}:x`, getIdFromDesc: () => 0x1234, callPapyrusFunction: () => null,
  lookupEspmRecordById: (id) => (RACES[id] ? { record: RACES[id] } : RECORDS[id] ? { record: { type: RECORDS[id], fields: [] } } : null),
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

// #bugs 1556845702422990888 (6 Oct): the server's formula takes the claws' base from appearance.raceId, which a beast
// now keeps mortal, so the beast race's unarmed damage is put back (werewolf 20 / Imperial 4 = x5 on top)
const WOLF2 = 0x81, WOLF3 = 0x82, WOLF4 = 0x83;
for (const [w, race] of [[WOLF2, IMPERIAL], [WOLF3, KHAJIIT], [WOLF4, BEAST_RACE]]) {
  store.set(`${w}|private.beast`, { form: 'werewolf', original: { raceId: race } });
  store.set(`${w}|appearance`, { raceId: race });
}
const near = (x, y) => Math.abs(x - y) < 1e-6;
ok(near(mult(WOLF2, CLAWS), wolfMult * 5), "an Imperial werewolf's claws get the beast race's base back (20 / 4)", mult(WOLF2, CLAWS));
ok(near(mult(WOLF3, CLAWS), wolfMult * 20 / 14), "a Khajiit werewolf's claws too (20 / 14), so every werewolf hits alike", mult(WOLF3, CLAWS));
ok(near(mult(WOLF4, CLAWS), wolfMult), 'an appearance already of the beast race gets no extra', mult(WOLF4, CLAWS));
ok(mult(WOLF2, GREATSWORD) === 1 && mult(WOLF2, FIREBOLT) === 1, 'a held weapon or a spell still gets nothing');
store.set(`${WOLF2}|appearance`, { raceId: 0x999 });
ok(near(mult(WOLF2, CLAWS), wolfMult), 'a race with no readable record leaves the multiplier as it was', mult(WOLF2, CLAWS));

const gm = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
ok(/let mult = \(beastAgg \? 1 : masteryDamageMult\(agg, src\)\)/.test(gm), 'the hit hook skips the Martial Arts mastery bonus in beast form');
ok(/if \(martial && !beastAgg\)/.test(gm), '...and the fist effects (drain, disarm, armour)');

// Held attackers (combat review #9): bound, carried or paralysed, as the hit hook reads them
ok(/if \(r && \(r\.boundHands \|\| r\.carried\)\) return false;/.test(gm), 'a bound or carried attacker lands no blow');
ok(/if \(agg !== tgt && \(paralysedUntil\.get\(agg\) \|\| 0\) > Date\.now\(\)\) return false;/.test(gm), 'a paralysed attacker lands no blow');
console.log(`${pass}/${pass + fail}`);
process.exitCode = fail ? 1 : 0;
