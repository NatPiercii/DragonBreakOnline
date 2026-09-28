// martial.js against a stub mp: tired blows, fists into armour and their stamina drain, the unarmed power attack's
// disarm, staves through armour, and the staff list read from the real skills.json.
// node tests/martial-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const MODULE = path.resolve(__dirname, '..', 'martial.js');
const SKILLS = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'skills.json'), 'utf8'));
const CFG = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'gamemode-config.json'), 'utf8'));

const FIST = 0x1f4, SWORD = 0x12eb7, GREATSWORD = 0x1359d, BOW = 0x3b562, FIREBALL = 0x1c789;
const QUARTERSTAFF = 0x0a050d64, BS_STAFF = 0x07601aa8; // Immersive Weapons.esp 50d64, BSAssets.esm 601aa8
const PLATE = 0x9000;
const DESC = { 'immersive weapons.esp': 0x0a000000, 'bsassets.esm': 0x07000000 };
const PLAYER = 0xff000001, VICTIM = 0xff000002, NPC = 0x0005a0f1, NPC2 = 0x0005a0f2;
let P, MAST, WORN, disarms, logs;
const reset = () => {
  P = { [PLAYER]: { health: 1, magicka: 1, stamina: 1 }, [VICTIM]: { health: 1, magicka: 1, stamina: 1 }, [NPC]: { health: 1, magicka: 1, stamina: 1 }, [NPC2]: { health: 1, magicka: 1, stamina: 1 } };
  MAST = { [PLAYER]: { order: ['unarmed'], skills: { unarmed: { rank: 4 } } } };
  WORN = {}; disarms = []; logs = [];
};
reset();
const mp = {
  get: (a, k) => (k === 'percentages' ? P[a] : k === 'equipment' ? { inv: { entries: (WORN[a] || []).map((b) => ({ baseId: b, worn: true })) } } : null),
  set: (a, k, v) => { if (k === 'percentages') P[a] = v; },
  getIdFromDesc: (d) => { const [h, p] = String(d).split(':'); const base = DESC[String(p).toLowerCase()]; if (base === undefined) throw new Error('unknown plugin'); return (base + parseInt(h, 16)) >>> 0; },
};
const HANDS = { [SWORD]: 'one', [GREATSWORD]: 'two', [BOW]: 'bow', [QUARTERSTAFF]: 'two', [BS_STAFF]: 'two' };
const api = {
  mp, log: (...x) => logs.push(x.join(' ')), display: String,
  profileOf: (a) => (a === PLAYER ? 1 : a === VICTIM ? 2 : -1),
  masteryOf: (a) => MAST[a] || null,
  wornOf: (e) => e.inv.entries.map((x) => ({ baseId: x.baseId })),
  armorPieceOf: (b) => (b === PLATE ? { rating: 40 / 0.12, heavy: true } : null), // 40 % reduction at 0.12 per point
  gmstFloat: (id, fallback) => fallback,
  weaponHandsOf: (src) => HANDS[src] || '',
  skills: SKILLS,
  combat: { disarmPlayer: (tgt, text) => { disarms.push([tgt, text]); return 1; } },
  cfg: CFG,
};
const load = () => require(MODULE)(api);
let pass = 0, fail = 0;
const ok = (c, what) => { if (c) pass++; else { fail++; console.log('FAIL', what); } };
const near = (a, b) => Math.abs(a - b) < 1e-6;
const flags = (o) => Object.assign({ spell: false, blocked: false, power: false, bash: false, targetMaxHealth: 200, targetMaxStamina: 200 }, o || {});

let M = load();
ok(M.isStaff(QUARTERSTAFF) && M.isStaff(BS_STAFF) && !M.isStaff(GREATSWORD), 'the staves come from skills.json (Immersive Weapons and BSAssets)');
ok(M.isFist(FIST) && !M.isFist(SWORD), 'the fist is the engine source 0x1f4');

// Tired blows, for every melee weapon and the fist, from anyone
reset(); M = load();
ok(near(M.onAttempt(PLAYER, VICTIM, SWORD, 10, flags()), 1), 'a fresh attacker hits in full');
P[PLAYER].stamina = 0.5;
ok(near(M.onAttempt(PLAYER, VICTIM, SWORD, 10, flags()), 1), '...still in full at half stamina (fullAt)');
P[PLAYER].stamina = 0.25;
ok(near(M.onAttempt(PLAYER, VICTIM, GREATSWORD, 10, flags()), 0.75), 'a quarter stamina: x0.75');
P[PLAYER].stamina = 0;
ok(near(M.onAttempt(PLAYER, VICTIM, SWORD, 10, flags()), 0.5), 'no stamina left: x0.5 (minMult)');
ok(near(M.onAttempt(PLAYER, VICTIM, BOW, 10, flags()), 1), 'a bow is not a melee blow');
ok(near(M.onAttempt(PLAYER, VICTIM, FIREBALL, 10, flags({ spell: true })), 1), 'nor is a spell');
P[NPC].stamina = 0;
ok(near(M.onAttempt(NPC, PLAYER, SWORD, 10, flags()), 0.5), 'an NPC out of stamina hits weaker too (PvE)');

// Fists: armour counts half again, and every landed blow drains stamina
reset(); M = load();
WORN[VICTIM] = [PLATE];
const m = M.onAttempt(PLAYER, VICTIM, FIST, 10, flags());
ok(near(m, (1 - 0.4 * 1.5) / 0.6), 'a fist into 40 % armour: x0.67, as if the armour took 60 %');
ok(near(P[VICTIM].stamina, 1 - 16 / 200), 'a Master fist drains 16 of the target\'s 200 stamina');
reset(); M = load();
M.onAttempt(PLAYER, VICTIM, FIST, 10, flags({ power: true }));
ok(near(P[VICTIM].stamina, 1 - 32 / 200), 'a power attack drains twice as much');
reset(); M = load();
MAST[PLAYER] = null;
M.onAttempt(PLAYER, NPC, FIST, 10, flags());
ok(near(P[NPC].stamina, 1 - 4 / 200), 'anyone\'s fist drains a little (untrainedDrain), NPC targets included');
reset(); M = load();
M.onAttempt(PLAYER, VICTIM, FIST, 10, flags({ blocked: true }));
ok(near(P[VICTIM].stamina, 1), 'a blocked fist drains nothing here (combat.js charges the block)');
reset(); M = load();
M.onAttempt(PLAYER, VICTIM, SWORD, 10, flags());
ok(near(P[VICTIM].stamina, 1), 'a sword drains no stamina');
reset(); M = load();
P[VICTIM].stamina = 0.02;
M.onAttempt(PLAYER, VICTIM, FIST, 10, flags());
ok(P[VICTIM].stamina === 0, 'stamina stops at none');

// The unarmed power attack disarms a player
reset(); M = load();
M.onAttempt(PLAYER, VICTIM, FIST, 10, flags({ power: true }));
ok(disarms.length === 1 && disarms[0][0] === VICTIM && /knocks the weapon/.test(disarms[0][1]), 'a landed unarmed power attack disarms a player, through combat.js');
reset(); M = load();
M.onAttempt(PLAYER, VICTIM, FIST, 10, flags());
ok(disarms.length === 0, 'a light blow does not');
M.onAttempt(PLAYER, VICTIM, FIST, 10, flags({ power: true, blocked: true }));
ok(disarms.length === 0, 'nor a blocked one');
M.onAttempt(PLAYER, NPC, FIST, 10, flags({ power: true }));
ok(disarms.length === 0, 'an NPC keeps its weapon: Papyrus reaches player actors only');
MAST[PLAYER] = null;
M.onAttempt(PLAYER, VICTIM, FIST, 10, flags({ power: true }));
ok(disarms.length === 0, 'someone without Martial Arts does not disarm');
M.onAttempt(PLAYER, VICTIM, SWORD, 10, flags({ power: true }));
ok(disarms.length === 0, 'nor does a sword\'s power attack');

// Staves pass a quarter of the armour
reset(); M = load();
WORN[VICTIM] = [PLATE];
ok(near(M.onAttempt(PLAYER, VICTIM, QUARTERSTAFF, 10, flags()), (1 - 0.4 * 0.75) / 0.6), 'a staff into 40 % armour: x1.17, as if it took 30 %');
ok(near(M.onAttempt(PLAYER, VICTIM, GREATSWORD, 10, flags()), 1), 'a greatsword gets no such help');
WORN[VICTIM] = [];
ok(near(M.onAttempt(PLAYER, VICTIM, QUARTERSTAFF, 10, flags()), 1), 'against no armour a staff is unchanged');
ok(logs.some((l) => /martial .* staff through armour x1\.17 \[staff\]/.test(l)), 'every rule that applied is logged');

// Off switches
reset();
M = require(MODULE)(Object.assign({}, api, { cfg: { martialArts: { enabled: false } } }));
P[PLAYER].stamina = 0;
ok(near(M.onAttempt(PLAYER, VICTIM, FIST, 10, flags({ power: true })), 1) && disarms.length === 0 && near(P[VICTIM].stamina, 1), 'enabled: false turns it all off');
reset();
M = require(MODULE)(Object.assign({}, api, { cfg: { martialArts: { staminaDamage: { enabled: false } } } }));
P[PLAYER].stamina = 0;
ok(near(M.onAttempt(PLAYER, VICTIM, SWORD, 10, flags()), 1), 'staminaDamage.enabled: false leaves tired blows alone');

console.log(`${pass}/${pass + fail}`);
process.exitCode = fail ? 1 : 0;
