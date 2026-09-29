// A wild animal's body is searched by the server (gamemode.js __dboAnimalBody, lifted and run against a stub mp): E on a
// dead wild deer hands over the venison and antlers the server's body holds, and empties it; the living, players' bodies,
// dungeon bodies and plugin references are left to the rest of the chain. (#bugs "Animals", 29 Sep.)
//   node tests/animal-body-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const i = src.indexOf('globalThis.__dboAnimalBody = '), j = src.indexOf('\n};\n', i);
if (i < 0) { console.log('FAIL gamemode.js has no __dboAnimalBody'); process.exit(1); }
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };
const props = new Map(), said = [], given = [];
const mp = { get: (id, k) => props.get(`${id}|${k}`), set: (id, k, v) => props.set(`${id}|${k}`, v) };
const RECS = { 0x669a2: 'FoodVenison', 0x6bc0a: 'AntlersLarge', 0x65c9e: 'FoodRabbit', 0xf2011: 'FoodChicken' };
const fn = new Function('globalThis', 'mp', 'profileOf', 'giveItem', 'recordOf', 'edidWords', 'personal', 'log', 'display',
  `${src.slice(i, j + 3)}\nreturn globalThis.__dboAnimalBody;`)(
  {}, mp, (a) => (a === 0xff000014 ? 30 : -1), (a, id, n) => { given.push([id, n]); return true; },
  (id) => (RECS[id] ? { record: { editorId: RECS[id] } } : null),
  (edid, fb) => String(edid || '').replace(/([a-z])([A-Z])/g, '$1 $2').trim() || fb, (a, t) => said.push(t), () => {}, String);
const P = 0xff000014, DEER = 0xff000500;
props.set(`${DEER}|private.npcSpawner`, 'wild:deer:2878'); props.set(`${DEER}|isDead`, true);
props.set(`${DEER}|inventory`, { entries: [{ baseId: 0x669a2, count: 1 }, { baseId: 0x6bc0a, count: 1 }] });

ok(fn(DEER, P) === false, 'E on a dead wild deer is handled by the server (the local loot window does not open)');
ok(given.length === 2 && given.some(([id]) => id === 0x669a2), 'the venison and the antlers are handed over', given);
ok(/You take Venison, Antlers Large\./.test(said[0] || ''), 'the player is told what they took', said);
ok(props.get(`${DEER}|inventory`).entries.length === 0, 'the body is emptied');
given.length = 0; said.length = 0;
ok(fn(DEER, P) === false && given.length === 0 && /nothing left/.test(said[0] || ''), 'a second E finds nothing left');

props.set(`${DEER}|isDead`, false);
ok(fn(DEER, P) === null, 'a living deer is left to the rest of the chain');
props.set(`${DEER}|isDead`, true);
props.set(`${DEER}|private.npcSpawner`, 'dungeon:CYRBawn:3');
ok(fn(DEER, P) === null, 'a dungeon body is left to dungeons.js');
ok(fn(0x0001a2b3, P) === null, 'a plugin reference is left alone');
ok(fn(DEER, 0xff000099) === null, 'an NPC activating is left alone');
// Small game (GroundedPasta, #bugs "Animals", 29 Sep 21:32: "Chickens also don't drop anything and rabbits don't either").
// Beyond Skyrim puts its rabbit (CYREncRabbit 804933d) on fox spots, so a rabbit's tag is wild:fox:*; a chicken's is
// wild:chicken:*. Both carry an empty pelt stash, as the live bodies do, so skinning passes them on.
const RABBIT = 0xff000190, CHICKEN = 0xff0002b9;
props.set(`${RABBIT}|private.npcSpawner`, 'wild:fox:2781'); props.set(`${RABBIT}|isDead`, true); props.set(`${RABBIT}|private.dboPelts`, []);
props.set(`${RABBIT}|inventory`, { entries: [{ baseId: 0x65c9e, count: 1 }] });
props.set(`${CHICKEN}|private.npcSpawner`, 'wild:chicken:2779'); props.set(`${CHICKEN}|isDead`, true); props.set(`${CHICKEN}|private.dboPelts`, []);
props.set(`${CHICKEN}|inventory`, { entries: [{ baseId: 0xf2011, count: 1 }] });
given.length = 0; said.length = 0;
ok(fn(RABBIT, P) === false && given.length === 1 && given[0][0] === 0x65c9e, 'a dead rabbit (on a fox spot) hands over its FoodRabbit', given);
ok(/You take Rabbit\./.test(said[0] || ''), 'the player is told they took the rabbit', said);
ok(props.get(`${RABBIT}|inventory`).entries.length === 0, 'the rabbit is emptied');
given.length = 0; said.length = 0;
ok(fn(CHICKEN, P) === false && given.length === 1 && given[0][0] === 0xf2011, 'a dead chicken hands over its FoodChicken', given);
ok(/You take Chicken\./.test(said[0] || ''), 'the player is told they took the chicken', said);
ok(props.get(`${CHICKEN}|inventory`).entries.length === 0, 'the chicken is emptied');
// Nothing earlier in the chain may claim a pelt-less animal: skinning passes an empty stash, a player's body needs a
// profile on the target, and the expedition corpse search takes only dungeon:* tags.
ok(/if \(!pelts\.length\) return null;/.test(src), 'skinning passes a body with an empty pelt stash on down the chain');
ok(/__dboLootBody = \(targetId, casterId\) => \{\n  if \(targetId === casterId \|\| !\(profileOf\(targetId\) > 0\)/.test(src), 'the player-body search leaves bodies without a profile alone');
const dsrc = fs.readFileSync(path.resolve(__dirname, '..', 'dungeons.js'), 'utf8');
ok(/__dboCorpseLoot = \(targetId, casterId\) => \{[\s\S]{0,300}if \(!tag\.startsWith\(ZONE_PREFIX\)\) return null;/.test(dsrc) && /ZONE_PREFIX = 'dungeon:'/.test(dsrc), 'the expedition corpse search leaves wild:* bodies alone');
const gm = src;
ok(/__dboSkin\(targetId >>> 0, casterId >>> 0\) === false\) return false;\n  if \(globalThis\.__dboAnimalBody && globalThis\.__dboAnimalBody\(targetId >>> 0, casterId >>> 0\) === false\) return false;/.test(gm), 'the activate chain asks it right after skinning');

console.log(fails ? `${fails} FAILED` : 'all checks passed');
process.exit(fails ? 1 : 0);
