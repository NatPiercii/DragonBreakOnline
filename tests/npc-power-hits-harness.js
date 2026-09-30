// A creature's or NPC's power attack on a player (gamemode.js npcPowerHitMult, gamemode-config npcPowerHits). The
// server doubles every power attack flat on top of the NPC-on-player x2, so a boar took half a new character's health
// in one bite (Purr, /bug 30 Sep 15:19). Lifts the block out of gamemode.js, as mastery-damage-harness.js does.
//   node tests/npc-power-hits-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8');
const START = '// ---- NPC power hits:', END = 'const hitDamageAttemptHook =';
const from = src.indexOf(START), to = src.indexOf(END);
if (from < 0 || to < 0 || to < from) { console.error('npc power hit block not found in gamemode.js'); process.exit(1); }
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };

const PLAYER = 0x14, OTHER_PLAYER = 0x15, BOAR = 0xff000191, TROLL = 0xff000200;
const profileOf = (id) => ({ [PLAYER]: 30, [OTHER_PLAYER]: 31 })[id] ?? -1;
const load = (cfg) => new Function('cfg', 'profileOf', src.slice(from, to) + '\nreturn npcPowerHitMult;')(cfg, profileOf);

const real = JSON.parse(fs.readFileSync(path.join(SERVER, 'gamemode-config.json'), 'utf8'));
ok(real.npcPowerHits && real.npcPowerHits.mult === 0.5, 'gamemode-config ships npcPowerHits.mult 0.5 (Nate, 2026-09-30): undoes the flat x2 on creature and NPC power hits on players', real.npcPowerHits);
let f = load({ npcPowerHits: { mult: 1 } });
ok(f(BOAR, PLAYER, { power: true }, 93.6) === 1, 'at 1, a boar power bite is untouched');
f = load(real);
ok(f(BOAR, PLAYER, { power: true }, 93.6) === 0.5, 'as shipped, a boar power bite on a player is halved');

f = load({ npcPowerHits: { mult: 0.5 } });
ok(f(BOAR, PLAYER, { power: true }, 93.6) === 0.5, "at 0.5, a boar's power bite on a player loses the flat x2 (93.6 -> 46.8)");
ok(f(TROLL, PLAYER, { power: true }, 130.2) === 0.5, "...and a troll's (130.2 -> 65.1)");
ok(f(BOAR, PLAYER, { power: false }, 46.8) === 1, 'a normal bite is untouched');
ok(f(BOAR, PLAYER, {}, 46.8) === 1, 'a hit with no flags is untouched');
ok(f(PLAYER, OTHER_PLAYER, { power: true }, 60) === 1, "a player's power attack on a player is untouched (PvP has its own knobs)");
ok(f(PLAYER, BOAR, { power: true }, 60) === 1, "a player's power attack on a creature is untouched");
ok(f(BOAR, TROLL, { power: true }, 60) === 1, 'a creature on a creature is untouched');
ok(f(BOAR, PLAYER, { power: true, spell: true }, 60) === 1, 'a spell hit flagged power is untouched');
ok(f(BOAR, PLAYER, { power: true }, 0) === 1, 'a zero-damage hit is untouched');
ok(f(PLAYER, PLAYER, { power: true }, 10) === 1, 'self-damage is untouched');
ok(f(BOAR, PLAYER, null, 60) === 1, 'no flags object at all is untouched');
for (const bad of [0, -1, 'x', null]) ok(load({ npcPowerHits: { mult: bad } })(BOAR, PLAYER, { power: true }, 60) === 1, `mult ${JSON.stringify(bad)} counts as off`);
ok(load({})(BOAR, PLAYER, { power: true }, 60) === 1, 'no npcPowerHits block: off');

ok(/mult \*= npcPowerHitMult\(agg, tgt, flags, dmg\);/.test(src.slice(to)), 'the hit hook multiplies it into the hit, beside the combat factors');
console.log(fails ? `${fails} FAILED` : 'all checks passed');
process.exit(fails ? 1 : 0);
