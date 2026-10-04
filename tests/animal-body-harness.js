// A wild animal's body is searched by the server (gamemode.js __dboAnimalBody, lifted and run against a stub mp): E on a
// dead wild deer hands over the venison and antlers the server's body holds, and empties it; the living, players' bodies,
// dungeon bodies and plugin references are left to the rest of the chain. (#bugs "Animals", 29 Sep.)
//   node tests/animal-body-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const i = src.indexOf('const ANIMAL_BODY = '), j = src.indexOf('\n};\n', src.indexOf('globalThis.__dboAnimalBody = '));
if (i < 0 || j < 0) { console.log('FAIL gamemode.js has no ANIMAL_BODY / __dboAnimalBody'); process.exit(1); }
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };
const props = new Map(), said = [], given = [];
// Stub load order for mp.getIdFromDesc: the food and tusk descs animalBody.addFood names, at stub ids
const DESCS = { 'edb2e:skyrim.esm': 0xedb2e, '65c99:skyrim.esm': 0x65c99, '6020ad:bsassets.esm': 0x076020ad, 'f25:ccbgssse001-fish.esm': 0x06000f25,
  '3bd14:dragonborn.esm': 0x0403bd14, '1cd6f:dragonborn.esm': 0x0401cd6f };
const mp = { get: (id, k) => props.get(`${id}|${k}`), set: (id, k, v) => props.set(`${id}|${k}`, v),
  getIdFromDesc: (d) => { const id = DESCS[String(d).toLowerCase()]; if (!id) throw new Error('no such form'); return id; } };
// Record stubs keyed by id (the ids only need to be distinct here; the type and editor id are what the rule reads)
const RECS = { 0x669a2: ['ALCH', 'FoodVenison'], 0x6bc0a: ['INGR', 'AntlersLarge'], 0x65c9e: ['ALCH', 'FoodRabbit'], 0xf2011: ['ALCH', 'FoodChicken'],
  0x3b97c: ['ARMO', 'SilverRing'], 0x63b45: ['MISC', 'GemRuby'], 0xf: ['MISC', 'Gold001'], 0x2e4e3: ['SLGM', 'SoulGemPetty'],
  0x3eadd: ['ALCH', 'RestoreHealth01'], 0x6b683: ['MISC', 'BoneHumanSkullFull'], 0x3ad6f: ['INGR', 'BearClaws'],
  0x3ad52: ['MISC', 'MammothTusk'], 0x9151b: ['MISC', 'BearPelt'], 0x13982: ['WEAP', 'IronDagger'], 0x13989: ['ARMO', 'ArmorIronHelmet'],
  0xedb2e: ['ALCH', 'FoodDogMeat'], 0x65c99: ['ALCH', 'FoodBeef'], 0x076020ad: ['ALCH', 'BSKFoodRatMeat'], 0x06000f25: ['ALCH', 'ccBGSSSE001_FoodSlaughterfish'],
  0x0403bd14: ['ALCH', 'DLC2FoodBoarMeat'], 0x0401cd6f: ['INGR', 'DLC2BoarTusk'] };
// Creature bases (NPC_) the bodies are made from, by stub id
const CREATURES = {};
const creature = (edid) => { const id = 0x0a000000 + Object.keys(CREATURES).length + 1; CREATURES[id] = edid; RECS[id] = ['NPC_', edid]; return id; };
const build = (cfg, G = {}) => new Function('globalThis', 'mp', 'cfg', 'baseIdOf', 'profileOf', 'giveItem', 'recordOf', 'edidWords', 'personal', 'log', 'display',
  `${src.slice(i, j + 3)}\nreturn globalThis.__dboAnimalBody;`)(
  G, mp, cfg, (id) => Number(props.get(`${id}|baseId`)) || 0, (a) => (a === 0xff000014 ? 30 : -1), (a, id, n) => { given.push([id, n]); return true; },
  (id) => (RECS[id] ? { record: { type: RECS[id][0], editorId: RECS[id][1] } } : null),
  (edid, fb) => String(edid || '').replace(/([a-z])([A-Z])/g, '$1 $2').trim() || fb, (a, t) => said.push(t), (t) => logged.push(t), String);
const logged = [];
// gearswap.js's loot cap, the real module against real ids (Skyrim.esm plugin 0, BSAssets 7, BSHeartland 8)
Object.assign(RECS, { 0x5ad99: ['MISC', 'IngotOrichalcum'], 0x5ad9f: ['MISC', 'IngotIMoonstone'], 0x5ace5: ['MISC', 'IngotSteel'], 0x13995: ['WEAP', 'DwarvenBow'], 0x13985: ['WEAP', 'HuntingBow'],
  0x139bd: ['AMMO', 'ElvenArrow'], 0x1397d: ['AMMO', 'IronArrow'] });
const capOf = (lootTiers) => {
  const PLUG = { 0: 'Skyrim.esm', 7: 'BSAssets.esm', 8: 'BSHeartland.esm' };
  const descOf = (id) => `${((id >>> 0) & 0xffffff).toString(16)}:${PLUG[(id >>> 0) >>> 24] || 'X.esp'}`;
  const idOf = (d) => { const m = /^([0-9a-f]+):(.+)$/i.exec(String(d)); if (!m) return 0; const top = Object.keys(PLUG).find((k) => PLUG[k].toLowerCase() === m[2].toLowerCase()); return top === undefined ? 0 : ((Number(top) << 24) | parseInt(m[1], 16)) >>> 0; };
  const saved = globalThis.__dboGearSwapLoot;
  require(path.resolve(__dirname, '..', 'gearswap.js'))({ mp: { get: () => undefined, set: () => {}, getDescFromId: descOf, getIdFromDesc: idOf }, log: () => {}, audit: () => {}, who: String, personal: () => {},
    onlineActors: () => [], every: () => {}, cfg: { dungeons: { lootTiers } }, registerChatCommand: () => {}, recordOf: (id) => (RECS[id >>> 0] ? { record: { type: RECS[id >>> 0][0], editorId: RECS[id >>> 0][1], fields: [] } } : null) });
  const f = globalThis.__dboGearSwapLoot;
  globalThis.__dboGearSwapLoot = saved;
  return { __dboGearSwapLoot: f };
};
const CAPG = capOf(undefined), CAPGNONE = capOf({ cap: 'none' });
for (const k of ['__dboGearSwapTake', '__dboGearSwapContainer', '__dboGearSwapLogin', '__dboGearSwapLoot']) delete globalThis[k];
const fn = build({});
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
// Only the animal comes off an animal (GroundedPasta, 30 Sep: "Is a deer supposed to drop a silver ring?"). The death item
// rolls treasure too; a wild body hands over its meat and parts and the treasure stays with the body.
const put = (id, tag, entries) => { props.set(`${id}|private.npcSpawner`, tag); props.set(`${id}|isDead`, true); props.set(`${id}|inventory`, { entries }); };
const RINGDEER = 0xff000600, BEAR = 0xff000601, RIEK = 0xff000602, GIANT = 0xff000603;
put(RINGDEER, 'wild:deer:2878', [{ baseId: 0x669a2, count: 1 }, { baseId: 0x6bc0a, count: 1 }, { baseId: 0x3b97c, count: 1 }]);
given.length = 0; said.length = 0; logged.length = 0;
ok(fn(RINGDEER, P) === false && given.length === 2 && !given.some(([id]) => id === 0x3b97c), 'a deer with a silver ring gives its venison and antlers, not the ring', given);
ok(/You take Venison, Antlers Large\./.test(said[0] || ''), 'the player is told only about the animal parts', said);
ok(props.get(`${RINGDEER}|inventory`).entries.length === 0, 'the ring goes away with the body');
ok(/not animal parts, left with the body: 1x SilverRing/.test(logged.join('\n')), 'the thrown-away treasure is logged', logged);
put(BEAR, 'wild:bear:12', [{ baseId: 0x3ad6f, count: 2 }, { baseId: 0x63b45, count: 1 }, { baseId: 0xf, count: 7 }, { baseId: 0x2e4e3, count: 1 }, { baseId: 0x9151b, count: 1 }]);
given.length = 0; said.length = 0;
ok(fn(BEAR, P) === false && given.map(([id]) => id).sort().join() === [0x3ad6f, 0x9151b].sort().join(), 'a bear gives its claws and pelt; its gem, gold and soul gem stay behind', given);
put(RIEK, 'wild:riekling:3', [{ baseId: 0x3eadd, count: 1 }, { baseId: 0x6b683, count: 1 }, { baseId: 0x13982, count: 1 }]);
given.length = 0; said.length = 0;
ok(fn(RIEK, P) === false && given.length === 0 && /nothing left/.test(said[0] || ''), 'potions, a human skull and a dagger are not animal parts', given);
put(GIANT, 'wild:giant:1', [{ baseId: 0x3ad52, count: 1 }, { baseId: 0x13989, count: 1 }, { baseId: 0x63b45, count: 2 }]);
given.length = 0;
ok(fn(GIANT, P) === false && given.length === 1 && given[0][0] === 0x3ad52, 'by default a giant gives only its mammoth tusk', given);
put(GIANT, 'wild:giant:1', [{ baseId: 0x3ad52, count: 1 }, { baseId: 0x13989, count: 1 }, { baseId: 0x63b45, count: 2 }]);
given.length = 0;
ok(build({ animalBody: { keepAllKinds: ['giant'] } }, CAPG)(GIANT, P) === false && given.length === 3, 'a kind in keepAllKinds keeps its whole body (through the loot cap)', given);
put(GIANT, 'wild:giant:1', [{ baseId: 0x3ad52, count: 1 }, { baseId: 0x13989, count: 1 }, { baseId: 0x63b45, count: 2 }]);
given.length = 0;
ok(build({ animalBody: { keepAllKinds: ['giant'] } })(GIANT, P) === false && given.length === 1 && given[0][0] === 0x3ad52, 'without gearswap.js\'s loot cap a keep-everything body hands over only its animal parts (fails closed)', given);
put(RINGDEER, 'wild:deer:2878', [{ baseId: 0x669a2, count: 1 }]);
given.length = 0;
ok(build({ animalBody: { denyEditorIds: ['Venison'] } })(RINGDEER, P) === false && given.length === 0, 'the deny list in config wins over the allow rules', given);
const conf = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'gamemode-config.json'), 'utf8')).animalBody;
ok(conf && Array.isArray(conf.allowEditorIds) && conf.allowEditorIds.every((x) => { try { new RegExp(x); return true; } catch (e) { return false; } }), 'gamemode-config.json animalBody is present and its patterns compile');
put(RINGDEER, 'wild:deer:2878', [{ baseId: 0x669a2, count: 1 }, { baseId: 0x3b97c, count: 1 }]);
given.length = 0;
ok(build({ animalBody: conf })(RINGDEER, P) === false && given.length === 1 && given[0][0] === 0x669a2, 'the shipped config keeps the venison and drops the ring', given);
// Nate, 30 Sep: "Giants keep their gear" (animalBody.keepAllKinds ["giant"] in the shipped config)
put(GIANT, 'wild:giant:1', [{ baseId: 0x3ad52, count: 1 }, { baseId: 0x13989, count: 1 }, { baseId: 0x63b45, count: 2 }]);
given.length = 0;
ok(Array.isArray(conf.keepAllKinds) && conf.keepAllKinds.includes('giant') && build({ animalBody: conf }, CAPG)(GIANT, P) === false && given.length === 3, 'with the shipped config a giant keeps its whole body (tusk, helmet, gems)', given);
// The loot cap on a keep-everything body (Nate, 4 Oct; live: goblin bodies handed over an Orichalcum ingot and a Dwarven
// bow). Metals above steel never come from a body; gear above the cap becomes its steel target; arrows follow the cap
{
  const GOB = 0xff000604;
  put(GOB, 'wild:goblin:4', [{ baseId: 0x5ad99, count: 1 }, { baseId: 0x13995, count: 1 }, { baseId: 0x139bd, count: 6 }, { baseId: 0x3ad52, count: 1 }, { baseId: 0x5ace5, count: 2 }]);
  given.length = 0; said.length = 0; logged.length = 0;
  ok(conf.keepAllKinds.includes('goblin') && build({ animalBody: conf }, CAPG)(GOB, P) === false, 'a goblin (keepAllKinds in the shipped config) is searched with E');
  const ids = given.map(([id]) => id);
  ok(!ids.includes(0x5ad99) && !ids.includes(0x13995) && !ids.includes(0x139bd), 'neither the Orichalcum ingot, the Dwarven bow nor the Elven arrows are handed over as they are', given);
  ok(given.some(([id, n]) => id === 0x13985 && n === 1) && given.some(([id, n]) => id === 0x1397d && n === 6), '...the bow becomes its steel target (a hunting bow), the arrows iron arrows', given);
  ok(given.some(([id, n]) => id === 0x5ace5 && n === 2) && !given.some(([id]) => id === 0x5ace5 && given.filter(([x]) => x === 0x5ace5).length > 1), '...steel ingots under the cap pass, and the orichalcum is not turned into steel (metals never come from loot)', given);
  ok(/not animal parts, left with the body: [^\n]*1x IngotOrichalcum/.test(logged.join('\n')) && logged.some((l) => /DwarvenBow from wild:goblin:4 handed over as HuntingBow \(loot cap\)/.test(l)), 'the kept-back ingot and the swapped bow are logged', logged);
  put(GOB, 'wild:goblin:4', [{ baseId: 0x139bd, count: 6 }, { baseId: 0x13995, count: 1 }]);
  given.length = 0;
  build({ animalBody: conf }, CAPGNONE)(GOB, P);
  ok(given.some(([id, n]) => id === 0x139bd && n === 6) && given.some(([id]) => id === 0x13995), 'at cap "none" the Elven arrows and the Dwarven bow come as they are (gear and arrows follow the cap)', given);
  put(GOB, 'wild:goblin:4', [{ baseId: 0x5ad99, count: 1 }, { baseId: 0x5ad9f, count: 2 }]);
  given.length = 0;
  build({ animalBody: conf }, CAPGNONE)(GOB, P);
  ok(given.length === 0, '...but never a metal above steel, at any cap', given);
}
// Food on every animal (Nate, 30 Sep: "add food to all animals"). Every wild creature whose death item holds no meat, by
// its own editor id (the census of wildlife.json's spawnable creatures, 30 Sep), gets its food with the other parts;
// monsters and folk get nothing added.
const FED = {
  CYREncWolf: 'FoodDogMeat', CYREncWolfTimber: 'FoodDogMeat', EncWolf: 'FoodDogMeat', EncWolfIce: 'FoodDogMeat', dunPOITrappedWolf: 'FoodDogMeat',
  CYREncFox: 'FoodDogMeat', CYREncFoxGray: 'FoodDogMeat', EncFox: 'FoodDogMeat', EncFoxArctic: 'FoodDogMeat',
  CYREncBearBlack: 'FoodBeef', CYREncBearBrown: 'FoodBeef', CYREncBearMasked: 'FoodBeef', EncBear: 'FoodBeef', EncBearCave: 'FoodBeef', EncBearSnow: 'FoodBeef',
  EncSabreCat: 'FoodBeef', EncSabreCatSnow: 'FoodBeef', dunRavenscarSabreCat: 'FoodBeef', CYREncMountainLion: 'FoodBeef',
  EncSkeever: 'BSKFoodRatMeat', EncSlaughterfish: 'ccBGSSSE001_FoodSlaughterfish',
};
const UNFED = ['CYREncTroll', 'CYREncTrollRiver', 'EncTrollFrost', 'EncIceWraith', 'EncChaurus', 'EncFrostbiteSpider', 'EncGiant01', 'CYREncOgre01',
  'CYREncMinotaur', 'DLC2EncNetchBull', 'DLC2EncLurker01', 'DLC2EncRiekling01Melee'];
let bodyN = 0x700;
const kill = (edid, tag, entries) => { const id = 0xff000000 + bodyN++; put(id, tag, entries); props.set(`${id}|baseId`, creature(edid)); return id; };
const edidOf = (id) => (RECS[id] || [])[1];
for (const [edid, food] of Object.entries(FED)) {
  const b = kill(edid, 'wild:wolf:1', []);
  given.length = 0; said.length = 0;
  ok(fn(b, P) === false && given.length === 1 && edidOf(given[0][0]) === food, `a dead ${edid} gives ${food}`, given.map(([id]) => edidOf(id)));
}
for (const edid of UNFED) {
  const b = kill(edid, 'wild:troll:1', []);
  given.length = 0;
  ok(fn(b, P) === false && given.length === 0, `a dead ${edid} gets no food added`, given.map(([id]) => edidOf(id)));
}
// A boar's death item already holds its meat: only the tusk is added, and the meat is not doubled
const boar = kill('DLC2EncBoarWild', 'wild:boar:1', [{ baseId: 0x0403bd14, count: 1 }]);
given.length = 0;
ok(fn(boar, P) === false && given.map(([id, n]) => `${edidOf(id)}x${n}`).sort().join() === 'DLC2BoarTuskx1,DLC2FoodBoarMeatx1', 'a boar gives one boar meat and a tusk', given.map(([id, n]) => `${edidOf(id)}x${n}`));
const bare = kill('DLC2EncBoarWild', 'wild:boar:2', []);
given.length = 0;
ok(fn(bare, P) === false && given.length === 2, 'a boar with nothing on it still gives meat and a tusk', given.map(([id]) => edidOf(id)));
// Once per death: the second E finds nothing, and a new death feeds again
const wolf = kill('CYREncWolf', 'wild:wolf:9', []);
fn(wolf, P); given.length = 0; said.length = 0;
ok(fn(wolf, P) === false && given.length === 0 && /nothing left/.test(said[0] || ''), 'the food is added once: a second E finds nothing left');
ok(/'private\.dboBodyFed', false\)/.test(src), 'a death clears the fed flag, so the next death is fed again');
props.set(`${wolf}|private.dboBodyFed`, false); props.set(`${wolf}|inventory`, { entries: [] });
given.length = 0;
ok(fn(wolf, P) === false && given.length === 1, 'after the flag is cleared (a new death) the wolf is fed again');
// A bad desc in config is skipped, not thrown
logged.length = 0;
const broken = build({ animalBody: { addFood: [{ creature: 'Wolf', items: ['123:NoSuchPlugin.esp'] }] } });
const w2 = kill('EncWolf', 'wild:wolf:3', []);
given.length = 0;
ok(broken(w2, P) === false && given.length === 0 && logged.some((l) => /not in the load order/.test(l)), 'a food not in the load order is logged and skipped', logged);
// The shipped config: every rule's items resolve in the stub order, one per rule
ok(Array.isArray(conf.addFood) && conf.addFood.every((r) => Array.isArray(r.items) && r.items.every((d) => DESCS[String(d).toLowerCase()])), 'every addFood item in gamemode-config.json is a known desc');
const cf = build({ animalBody: conf });
const w3 = kill('EncFoxArctic', 'wild:fox:3', []);
given.length = 0;
ok(cf(w3, P) === false && given.length === 1 && edidOf(given[0][0]) === 'FoodDogMeat', 'the shipped config feeds an arctic fox');
const gm = src;
ok(/__dboSkin\(targetId >>> 0, casterId >>> 0\) === false\) return false;\n  if \(globalThis\.__dboAnimalBody && globalThis\.__dboAnimalBody\(targetId >>> 0, casterId >>> 0\) === false\) return false;/.test(gm), 'the activate chain asks it right after skinning');

console.log(fails ? `${fails} FAILED` : 'all checks passed');
process.exit(fails ? 1 : 0);
