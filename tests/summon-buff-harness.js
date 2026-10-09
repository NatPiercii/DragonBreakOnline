// A player's summon by its owner's Conjuration rank (gamemode-config summonBuff; gamemode.js summonTakenMult,
// summonDealtMult, summonSpellGuard, npcLethalGuard for a summon, __dboSummonDurationMult). Lifts the NPC damage block out
// of gamemode.js and runs it on a stub mp; then replays the boar bite that undid a Conjure Familiar (#suggestions, 9 Oct).
//   node tests/summon-buff-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const GM = fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8');
const START = '// ---- NPC power hits: how hard a creature', END = 'const hitDamageAttemptHook =';
const a = GM.indexOf(START), b = GM.indexOf(END, a);
if (a < 0 || b < 0) { console.log('FAIL the NPC damage block is gone from gamemode.js'); process.exit(1); }
const BLOCK = GM.slice(a, b);

let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };
const near = (x, y) => Math.abs(x - y) < 1e-9;

const MAGE = 0xff000a45, OTHER = 0xff000a46, FAMILIAR = 0xff000300, ZOMBIE = 0xff000301, WARBAND = 0xff000302, BOAR = 0xff000100;
const props = new Map();
const put = (id, k, v) => props.set(id + '|' + k, v);
put(FAMILIAR, 'private.dboCompanion', 'summon'); put(FAMILIAR, 'ff_companionOf', MAGE);
put(ZOMBIE, 'private.dboCompanion', 'reanimated'); put(ZOMBIE, 'ff_companionOf', MAGE);
put(WARBAND, 'private.dboCompanion', 'companion'); put(WARBAND, 'ff_companionOf', MAGE);
put(BOAR, 'private.npcSpawner', 'wild:boar:12');
const mp = { get: (id, k) => props.get(id + '|' + k), set: (id, k, v) => props.set(id + '|' + k, v), getIdFromDesc: () => 0 };
const profileOf = (x) => (x === MAGE || x === OTHER ? 85 : -1);
const rank = { [MAGE]: 0 };
globalThis.__dboSchoolRank = (o, school) => (school === 'Conjuration' && rank[o] !== undefined ? rank[o] : -1);
const timers = [];
const load = (cfg) => new Function('mp', 'cfg', 'profileOf', 'recordOf', 'display', 'log', 'setTimeout', BLOCK +
  '\nreturn { summonTakenMult, summonDealtMult, summonSpellGuard, npcLethalGuard, playerSummonOf };')(mp, cfg, profileOf, () => null, (x) => `#${x.toString(16)}`, () => {}, (f) => timers.push(f));

let F = load({});
const TAKEN = [0.6, 0.5, 0.42, 0.35, 0.3], DEALT = [1.2, 1.35, 1.5, 1.7, 2], DUR = [1.5, 1.75, 2, 2.5, 3];
for (let t = 0; t < 5; t++) {
  rank[MAGE] = t;
  ok(near(F.summonTakenMult(BOAR, FAMILIAR, 30), TAKEN[t]) && near(F.summonDealtMult(FAMILIAR, BOAR, 30), DEALT[t]) && near(globalThis.__dboSummonDurationMult(MAGE, 'summon'), DUR[t]),
    `rank ${t}: a summon takes x${TAKEN[t]}, deals x${DEALT[t]}, stays x${DUR[t]}`, [F.summonTakenMult(BOAR, FAMILIAR, 30), F.summonDealtMult(FAMILIAR, BOAR, 30), globalThis.__dboSummonDurationMult(MAGE, 'summon')]);
}
rank[MAGE] = -1;
ok(near(F.summonTakenMult(BOAR, FAMILIAR, 30), 0.6), 'a caster outside the Conjuration school counts as Novice');
rank[MAGE] = 2;
ok(near(F.summonTakenMult(BOAR, ZOMBIE, 30), 0.42), 'a raised corpse is buffed too');
ok(F.summonTakenMult(BOAR, WARBAND, 30) === 1 && F.summonDealtMult(WARBAND, BOAR, 30) === 1 && globalThis.__dboSummonDurationMult(MAGE, 'companion') === 1, 'a GM warband companion is not');
ok(F.summonDealtMult(FAMILIAR, OTHER, 30) === 1, 'a summon hits a player no harder');
ok(F.summonTakenMult(BOAR, BOAR, 30) === 1 && F.summonTakenMult(BOAR, OTHER, 30) === 1 && F.summonTakenMult(BOAR, FAMILIAR, 0) === 1, 'no change on a self hit, on a player, or with no damage');

// The boar bite: a Familiar at 40 of 40 health and a 50-point bite, Novice owner (x0.6 = 30)
rank[MAGE] = 0;
put(FAMILIAR, 'percentages', { health: 1, magicka: 1, stamina: 1 });
const g = F.npcLethalGuard(BOAR, FAMILIAR, 50, 0.6, { targetMaxHealth: 40 });
ok(g && near(mp.get(FAMILIAR, 'percentages').health, 1) && g.rest < 1, 'a weapon bite the Familiar would not live through is raised first, the cap given back after', g);
put(FAMILIAR, 'percentages', { health: 1, magicka: 1, stamina: 1 });
ok(F.npcLethalGuard(BOAR, FAMILIAR, 80, 0.6, { targetMaxHealth: 40 }) === null, '...not when even the scaled bite kills');
ok(F.npcLethalGuard(OTHER, FAMILIAR, 50, 0.6, { targetMaxHealth: 40 }) === null, '...and never a player\'s blow');

// The 30-point spell on a 25-health Familiar, Adept owner (x0.42 = 12.6)
rank[MAGE] = 2;
put(FAMILIAR, 'percentages', { health: 1, magicka: 1, stamina: 1 });
timers.length = 0;
ok(F.summonSpellGuard(BOAR, FAMILIAR, 30, 0.42, { spell: true, targetMaxHealth: 25 }) === true && timers.length === 1, 'a lethal spell the scaled hit survives is refused and taken off after');
timers.shift()();
ok(near(mp.get(FAMILIAR, 'percentages').health, 1 - 12.6 / 25), '...by the scaled 12.6 of 25', mp.get(FAMILIAR, 'percentages'));
ok(F.summonSpellGuard(BOAR, FAMILIAR, 5, 0.42, { spell: true, targetMaxHealth: 25 }) === false && F.summonSpellGuard(BOAR, FAMILIAR, 30, 0.42, { targetMaxHealth: 25 }) === false && F.summonSpellGuard(BOAR, BOAR, 300, 0.42, { spell: true, targetMaxHealth: 25 }) === false,
  'a survivable spell, a weapon hit or a non-summon is left to the usual path');

F = load({ summonBuff: { enabled: false } });
ok(F.summonTakenMult(BOAR, FAMILIAR, 30) === 1 && F.summonDealtMult(FAMILIAR, BOAR, 30) === 1 && globalThis.__dboSummonDurationMult(MAGE, 'summon') === 1, 'summonBuff.enabled false turns it all off');
F = load({ summonBuff: { takenByTier: [0.9] } });
rank[MAGE] = 4;
ok(near(F.summonTakenMult(BOAR, FAMILIAR, 30), 0.9), 'a shorter list holds its last value');

const cfgFile = JSON.parse(fs.readFileSync(path.join(SERVER, 'gamemode-config.json'), 'utf8')).summonBuff;
ok(cfgFile && JSON.stringify(cfgFile.takenByTier) === JSON.stringify(TAKEN) && JSON.stringify(cfgFile.dealtByTier) === JSON.stringify(DEALT), 'gamemode-config.json carries the tiers');
const SC = fs.readFileSync(path.join(SERVER, 'schools.js'), 'utf8');
ok(/globalThis\.__dboSchoolRank = \(a, school\) =>/.test(SC) && /'__dboSchoolRank'\]\) globalThis\[k\] = null/.test(GM), 'schools.js gives the rank read-only, and a failed load clears it');
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
