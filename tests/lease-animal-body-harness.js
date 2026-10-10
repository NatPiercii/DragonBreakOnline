// A claimed dungeon's creatures are searched with E for their meat and parts, as a wild animal's body is (#bug-tracker
// 1557894681508061319, Purr #7DJT 8 Oct 23:17, Red Ruby Cave: "rats arent harvestable in caves"). The same player took Rat
// Meat off wild rats at 22:29-22:31 and 23:46 (animal body ... from wild:wolf:*), but a lease body (spawn tag
// dungeon:<id>:<zone>) had no searcher: dungeons.js __dboCorpseLoot takes only a lease's humanoids, undead and master,
// gamemode.js __dboAnimalBody took only wild:* tags, and the client blocks the engine's own container on every actor, so
// E on a cave rat (or on a cave wolf after skinning it) did nothing.
// gamemode.js __dboAnimalBody is lifted and run against a stub mp, as tests/animal-body-harness.js does, with the real
// dungeons.js loaded for a real lease (claimed the way tests/goblin-body-loot-harness.js claims Silorn):
// 1. a lease member's E on a dead lease rat hands over its rat meat, once, and empties the body;
// 2. a lease wolf that was skinned gives its meat (the pelt is in the stash, not on the body);
// 3. gold, gems and a giant's club stay with a lease body (keepAllKinds is for wild:<kind> tags only);
// 4. not for someone outside the claiming party, not after the lease is gone, not while alive, and not without dungeons.js;
// 5. the real dungeons.js still leaves a lease creature to this (null), and a wild body is still searched as before.
//   node tests/lease-animal-body-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };

// ---- the real dungeons.js, a real lease ------------------------------------------------------------------------------
const ids = new Map(); let nextId = 0x100;
const idOf = (d) => { const k = String(d).toLowerCase(); if (!ids.has(k)) { ids.set(k, nextId); nextId++; } return ids.get(k); };
const A = 0x14, OUTSIDER = 0x15;
const dir = fs.mkdtempSync(path.join(process.env.HARNESS_TMP || (fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir()), 'lease-animal-body-'));
const here = process.cwd(); process.chdir(dir);
for (const f of ['loot.json', 'ayleid-loot.json', 'expeditions.json']) fs.copyFileSync(path.join(ROOT, f), f);
fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [] }));
const props = new Map([[`${idOf('boardref')}|baseDesc`, '6:DragonBreak.esp'], [`${A}|worldOrCellDesc`, 'f8d:BSHeartland.esm'], [`${A}|pos`, [0, -500, -221]]]);
const ui = new Map(); const savedTimeout = global.setTimeout; global.setTimeout = () => 0;
const PROFILE = (a) => (a === A || a === 0xff000014 ? 1 : a === OUTSIDER || a === 0xff000015 ? 2 : -1);
globalThis.__dboDungeons = undefined; globalThis.__dboExpeditionPending = undefined;
require(path.join(ROOT, 'dungeons.js'))({
  mp: { get: (id, p) => (p === 'profileId' ? PROFILE(id) : props.get(`${id}|${p}`)), set: (id, p, v) => props.set(`${id}|${p}`, v), getIdFromDesc: idOf,
    lookupEspmRecordById: (id) => (id === idOf('6:DragonBreak.esp') ? { record: { editorId: 'ExpeditionBoard' } } : { record: null }) },
  log: () => {}, personal: () => {}, system: () => {}, audit: () => {}, registerChatCommand: () => {}, onUi: (n, fn) => { const l = ui.get(n) || []; l.push(fn); ui.set(n, l); },
  openWidget: () => true, closeWidget: () => true, sendPacket: () => true, findByName: () => 0, display: String, who: String, profileOf: PROFILE, nameOf: () => 'P',
  onlineActors: () => [A], isAdmin: () => false, giveItem: () => true, cfg: { dungeons: {} }, every: () => {},
});
const fire = (n, a, args) => (ui.get(n) || []).forEach((f) => f(a, args, 0));
globalThis.__dboDungeonActivate(idOf('boardref'), A); fire('expeditionPick', A, ['CYRSilornLocation']);
const pend = globalThis.__dboDungeons.pending.get(A);
if (pend) fire('dungeonClaim', A, [pend.nonce, 'normal']);
const lease = globalThis.__dboDungeons.leases.get('CYRSilornLocation');
ok(!!(lease && lease.members && lease.members.has(1) && !lease.members.has(2)), 'a lease is claimed (profile 1 is in its party, profile 2 is not)');
global.setTimeout = savedTimeout; process.chdir(here); fs.rmSync(dir, { recursive: true, force: true });

// ---- gamemode.js __dboAnimalBody, lifted --------------------------------------------------------------------------------
const src = fs.readFileSync(path.join(ROOT, 'gamemode.js'), 'utf8');
const i = src.indexOf('const ANIMAL_BODY = '), j = src.indexOf('\n};\n', src.indexOf('globalThis.__dboAnimalBody = '));
if (i < 0 || j < 0) { console.log('FAIL gamemode.js has no ANIMAL_BODY / __dboAnimalBody'); process.exit(1); }
const body = new Map(), said = [], given = [], logged = [];
const DESCS = { 'edb2e:skyrim.esm': 0xedb2e, '65c99:skyrim.esm': 0x65c99, '6020ad:bsassets.esm': 0x076020ad, 'f25:ccbgssse001-fish.esm': 0x06000f25,
  '3bd14:dragonborn.esm': 0x0403bd14, '1cd6f:dragonborn.esm': 0x0401cd6f };
const smp = { get: (id, k) => body.get(`${id}|${k}`), set: (id, k, v) => body.set(`${id}|${k}`, v),
  getIdFromDesc: (d) => { const id = DESCS[String(d).toLowerCase()]; if (!id) throw new Error('no such form'); return id; } };
const RECS = { 0x076020ad: ['ALCH', 'BSKFoodRatMeat'], 0xedb2e: ['ALCH', 'FoodDogMeat'], 0x65c99: ['ALCH', 'FoodBeef'], 0x669a2: ['ALCH', 'FoodVenison'],
  0xf: ['MISC', 'Gold001'], 0x63b45: ['MISC', 'GemRuby'], 0x3ad52: ['MISC', 'MammothTusk'], 0x13989: ['ARMO', 'ArmorIronHelmet'], 0x9151b: ['MISC', 'WolfPelt'],
  0x0a000001: ['NPC_', 'CYREncRat'], 0x0a000002: ['NPC_', 'CYREncWolf'], 0x0a000003: ['NPC_', 'CYREncGiant'], 0x0a000004: ['NPC_', 'CYREncDeer'] };
const RAT_BASE = 0x0a000001, WOLF_BASE = 0x0a000002, GIANT_BASE = 0x0a000003, DEER_BASE = 0x0a000004;
const build = (cfg, G) => new Function('globalThis', 'mp', 'cfg', 'baseIdOf', 'profileOf', 'giveItem', 'recordOf', 'edidWords', 'personal', 'log', 'display',
  `${src.slice(i, j + 3)}\nreturn globalThis.__dboAnimalBody;`)(
  G, smp, cfg, (id) => Number(body.get(`${id}|baseId`)) || 0, PROFILE, (a, id, n) => { given.push([id, n]); return true; },
  (id) => (RECS[id] ? { record: { type: RECS[id][0], editorId: RECS[id][1] } } : null),
  (edid, fb) => String(edid || '').replace(/([a-z])([A-Z])/g, '$1 $2').trim() || fb, (a, t) => said.push(t), (t) => logged.push(t), String);
const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'gamemode-config.json'), 'utf8'));
const fn = build({ animalBody: conf.animalBody }, globalThis);   // the live config (keepAllKinds giant, goblin; addFood)
const P = 0xff000014, OUT = 0xff000015;
let next = 0xff000700;
const put = (tag, base, entries, extra = {}) => { const id = next++; body.set(`${id}|private.npcSpawner`, tag); body.set(`${id}|isDead`, true); body.set(`${id}|baseId`, base); body.set(`${id}|inventory`, { entries }); for (const [k, v] of Object.entries(extra)) body.set(`${id}|${k}`, v); return id; };
const reset = () => { given.length = 0; said.length = 0; logged.length = 0; };
const TAG = (n) => `dungeon:CYRSilornLocation:${n}`;

// 1. a cave rat
reset();
const RAT = put(TAG(14), RAT_BASE, [{ baseId: 0x076020ad, count: 1 }]);
ok(fn(RAT, P) === false, 'E on a dead rat of a claimed dungeon is the server\'s search (was null: nothing searched it)');
ok(given.length === 1 && given[0][0] === 0x076020ad && given[0][1] === 1, 'the rat meat is handed over', given);
ok(/You take .*Rat Meat\./.test(said[0] || ''), 'the player is told what they took', said);
ok((body.get(`${RAT}|inventory`) || {}).entries.length === 0, 'the body is emptied');
ok(/animal body .* took .*Rat Meat from dungeon:CYRSilornLocation:14/.test(logged.join('\n')), 'the take is logged with the lease tag', logged);
reset();
ok(fn(RAT, P) === false && given.length === 0 && /nothing left/.test(said[0] || ''), 'a second E finds nothing left');
// A rat whose death item has no meat gets one from animalBody.addFood only when its editor id is the Skeever rule's; the
// cave rat of the report keeps what its body holds, the same as a wild one
reset();
const RAT2 = put(TAG(15), RAT_BASE, []);
ok(fn(RAT2, P) === false && given.length === 0 && /nothing left/.test(said[0] || ''), 'a lease body with nothing on it says so (handled, nothing given)', given);

// 2. a skinned cave wolf: the pelt is in the stash, the meat is on the body
reset();
const WOLF = put(TAG(16), WOLF_BASE, [], { 'private.dboPelts': [{ baseId: 0x9151b, count: 1 }], 'private.dboSkinned': true });
ok(fn(WOLF, P) === false && given.length === 1 && given[0][0] === 0xedb2e, 'a skinned cave wolf gives its meat (addFood Wolf), not a second pelt', given);

// 3. treasure stays with a lease body; keepAllKinds does not reach lease tags
reset();
const GIANT = put(TAG(17), GIANT_BASE, [{ baseId: 0x3ad52, count: 1 }, { baseId: 0x13989, count: 1 }, { baseId: 0x63b45, count: 2 }, { baseId: 0xf, count: 40 }]);
ok(fn(GIANT, P) === false && given.length === 1 && given[0][0] === 0x3ad52, 'a lease giant gives its tusk only: helmet, gems and gold stay with the body', given);
ok(/not animal parts, left with the body/.test(logged.join('\n')), 'what stays behind is logged', logged);

// 4. who and when
reset();
const RAT3 = put(TAG(18), RAT_BASE, [{ baseId: 0x076020ad, count: 1 }]);
ok(fn(RAT3, OUT) === null && given.length === 0, 'someone outside the claiming party gets nothing (left to the chain, as before)', given);
ok((body.get(`${RAT3}|inventory`) || {}).entries.length === 1, 'and the body keeps its meat for the party');
body.set(`${RAT3}|isDead`, false);
ok(fn(RAT3, P) === null, 'a living lease rat is left alone');
body.set(`${RAT3}|isDead`, true);
reset();
const GONE = put('dungeon:CYRNoSuchLeaseLocation:3', RAT_BASE, [{ baseId: 0x076020ad, count: 1 }]);
ok(fn(GONE, P) === null && given.length === 0, 'a body whose lease is gone is left alone');
const saved = globalThis.__dboCorpseLoot; globalThis.__dboCorpseLoot = undefined;
ok(fn(RAT3, P) === null, 'without dungeons.js (no __dboCorpseLoot) a lease body is left alone, as before');
globalThis.__dboCorpseLoot = saved;
ok(fn(RAT3, 0xff000099) === null, 'an NPC activating is left alone');

// 5. the chain around it
const real = globalThis.__dboCorpseLoot;
const R = 0xff000800; props.set(`${R}|private.npcSpawner`, TAG(19)); props.set(`${R}|isDead`, true);
lease.kinds[TAG(19)] = 'CYRLvlRat';
ok(typeof real === 'function' && real(R, A) === null, 'the real dungeons.js still leaves a lease creature (a rat kind) to the rest of the chain');
reset();
const DEER = put('wild:deer:2878', DEER_BASE, [{ baseId: 0x669a2, count: 1 }]);
ok(fn(DEER, P) === false && given.length === 1 && given[0][0] === 0x669a2, 'a wild deer is still searched as before', given);
reset();
const SKEEV = put('wild:wolf:2813', RAT_BASE, [{ baseId: 0x076020ad, count: 1 }, { baseId: 0xf, count: 3 }]);
ok(fn(SKEEV, OUT) === false && given.length === 1, 'a wild rat is anyone\'s to search, party or not', given);

console.log(fails ? `${fails} FAILED` : 'all checks passed');
process.exit(fails ? 1 : 0);
