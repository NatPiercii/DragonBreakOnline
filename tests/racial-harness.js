// Scripted test for server\racial.js (each race's gift) and its use by gamemode.js (the hit path, the cast hook, the
// needs chain), dungeons.js, wildlife.js and contracts.js (Imperial Luck). The real record readers of gamemode.js
// (sourceResistsOf, weaponHandsOf, the blessing multipliers) are lifted out and run on mock records, as
// blessing-combat-harness does. Run from this folder's parent:
//   node tests/racial-harness.js
'use strict';
const fs = require('fs');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const near = (x, y) => Math.abs(x - y) < 1e-9;

// ---- records ----
const u32le = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const f32le = (x) => { const b = Buffer.alloc(4); b.writeFloatLE(x); return [...b]; };
const WEAP = (anim) => ({ record: { type: 'WEAP', fields: [{ type: 'DNAM', data: Uint8Array.from([anim, 0, 0, 0]) }] } });
const MGEF = (resist) => { const d = new Array(152).fill(0); u32le(resist >>> 0).forEach((b, i) => { d[16 + i] = b; }); return { record: { type: 'MGEF', fields: [{ type: 'DATA', data: Uint8Array.from(d) }] } }; };
const withEffects = (type, ...mgefs) => ({ record: { type, fields: mgefs.flatMap((m) => [{ type: 'EFID', data: Uint8Array.from(u32le(m)) }, { type: 'EFIT', data: Uint8Array.from(new Array(12).fill(0)) }]) } });
// RACE DATA: regeneration at 84/88/92, unarmed damage at 96 (the vanilla values, Khajiit and Argonian claws 10)
const RACE = (unarmed) => { const d = new Array(128).fill(0); [[84, 0.7], [88, 3], [92, 5], [96, unarmed]].forEach(([at, v]) => f32le(v).forEach((b, i) => { d[at + i] = b; })); return { record: { type: 'RACE', fields: [{ type: 'DATA', data: Uint8Array.from(d) }] } }; };
const { RACE_IDS } = require(path.join(SERVER, 'racial.js'));
const records = {
  0x100: WEAP(1), 0x101: WEAP(5), 0x102: WEAP(7), 0x200: { record: { type: 'SPEL', fields: [] } },
  0x301: MGEF(41), 0x302: MGEF(43), 0x303: MGEF(42), 0x304: MGEF(40), 0x305: MGEF(-1),
  0x210: withEffects('SPEL', 0x301), 0x211: withEffects('SPEL', 0x302), 0x212: withEffects('SPEL', 0x303), 0x213: withEffects('SPEL', 0x304),
  0x214: withEffects('SPEL', 0x305), 0x215: withEffects('ENCH', 0x301),
  0x3c: { record: { type: 'WRLD', fields: [] } }, 0xa764b: { record: { type: 'WRLD', fields: [] } }, 0x5000: { record: { type: 'CELL', fields: [] } },
};
for (const [race, ids] of Object.entries(RACE_IDS)) for (const id of ids) records[id] = RACE(race === 'khajiit' || race === 'argonian' ? 10 : 4);
const SWORD = 0x100, GREATSWORD = 0x101, BOW = 0x102, FIST = 0x1f4, FLAMES = 0x210, FROSTBITE = 0x211, SPARKS = 0x212, POISON = 0x213, PARALYZE = 0x214, FIRE_STAFF = 0x215;
const recordOf = (id) => records[id >>> 0] || null;

// ---- gamemode.js's own readers, lifted out ----
const gm = fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8');
const a0 = gm.indexOf('const BLESS_COMBAT'), b0 = gm.indexOf('// The server\'s hit formula counts only');
const blessings = {};
const state = {};
const mp = {
  get: (id, k) => {
    const s = state[id] || {};
    if (k === 'private.dboBlessing') return blessings[id];
    if (k === 'appearance') return s.race ? { raceId: s.race } : null;
    if (k === 'private.beast') return s.beast || null;
    if (k === 'percentages') return s.pc;
    if (k === 'worldOrCellDesc') return s.desc || '3c:Skyrim.esm';
    if (k === 'pos') return s.pos || [0, 0, 0];
    if (k === 'inventory') return { entries: s.inv || [] };
    return undefined;
  },
  set: (id, k, v) => { state[id] = state[id] || {}; if (k === 'percentages') state[id].pc = v; if (k === 'inventory') state[id].inv = v.entries; },
  getIdFromDesc: (d) => ({ '3c:Skyrim.esm': 0x3c, 'a764b:BSHeartland.esm': 0xa764b, '5000:Skyrim.esm': 0x5000 })[d] || 0,
  getServerSettings: () => ({}),
};
const lifted = new Function('mp', 'recordOf', 'cfg', gm.slice(a0, b0) + '\nreturn { sourceResistsOf, weaponHandsOf, blessingTargetMult, blessingAttackMult, blessingDamageMult };');
const G = lifted(mp, recordOf, {});

// ---- the module ----
const P = (n) => n; // profiles: actors 1..99 are players, 1000+ NPCs
const given = [];
const told = [];
let timers = [];
const make = (racialCfg, extra = {}) => require(path.join(SERVER, 'racial.js'))(Object.assign({
  mp, log: () => {}, personal: (a, t) => told.push([a, t]), display: (a) => String(a), recordOf,
  giveItem: (a, base, n) => { given.push([a, base, n]); return true; }, profileOf: (a) => (a < 1000 ? P(a) : -1),
  every: (name, ms, fn) => { timers.push(name); }, onlineActors: () => Object.keys(state).map(Number).filter((a) => a < 1000),
  weaponHandsOf: G.weaponHandsOf, sourceResistsOf: G.sourceResistsOf, cfg: { racial: racialCfg },
}, extra));
// regions.js: the province of where the player stands (Skyrim's Tamriel worldspace, else Cyrodiil)
globalThis.__dboRegions = { provinceAt: (a) => ({ province: String((state[a] || {}).desc || '3c:Skyrim.esm').startsWith('3c:') ? 'skyrim' : 'cyrodiil' }) };
const R = make({ enabled: true });
const race = (id, name, pc) => { state[id] = { race: RACE_IDS[name][0], pc: pc || { health: 1, magicka: 1, stamina: 1 } }; };
const NPC = 1001;
state[NPC] = { pc: { health: 1, magicka: 1, stamina: 1 } };

// ---- 1. one check per race ----
race(1, 'altmer'); race(2, 'argonian'); race(3, 'bosmer'); race(4, 'breton'); race(5, 'dunmer');
race(6, 'imperial'); race(7, 'khajiit'); race(8, 'nord'); race(9, 'orc'); race(10, 'redguard');
check('Altmer: magicka regenerates x1.25, nothing else', near(R.regenFactor(1, 'magicka'), 1.25) && R.regenFactor(1, 'stamina') === 1 && R.targetMult(NPC, 1, FLAMES) === 1);
check('Argonian: poison 50% less, fire unchanged', near(R.targetMult(NPC, 2, POISON), 0.5) && R.targetMult(NPC, 2, FLAMES) === 1);
state[2].pc = { health: 0.3, magicka: 1, stamina: 1 };
check('Argonian: below 35% health heals x1.5, above it not', near(R.regenFactor(2, 'health'), 1.5) && (state[2].pc.health = 0.5, R.regenFactor(2, 'health') === 1));
check('Bosmer: bows +10%, swords unchanged, poison 50% less', near(R.attackMult(3, NPC, BOW, 10), 1.1) && R.attackMult(3, NPC, SWORD, 10) === 1 && near(R.targetMult(NPC, 3, POISON), 0.5));
check('Breton: spells and staves 25% less (any element), weapons unchanged', near(R.targetMult(NPC, 4, FLAMES), 0.75) && near(R.targetMult(NPC, 4, PARALYZE), 0.75) && near(R.targetMult(NPC, 4, FIRE_STAFF), 0.75) && R.targetMult(NPC, 4, SWORD) === 1);
check('Dunmer: fire 50% less, frost and a fire staff\'s fire too', near(R.targetMult(NPC, 5, FLAMES), 0.5) && R.targetMult(NPC, 5, FROSTBITE) === 1 && near(R.targetMult(NPC, 5, FIRE_STAFF), 0.5));
check('Khajiit: a punch counts the claws\' base 10 + 8 (x1.8), a sword unchanged', near(R.attackMult(7, NPC, FIST, 10), 1.8) && R.attackMult(7, NPC, SWORD, 10) === 1);
check('Nord: frost 50% less, fire unchanged', near(R.targetMult(NPC, 8, FROSTBITE), 0.5) && R.targetMult(NPC, 8, FLAMES) === 1);
check('Nord: stamina x1.15 outdoors in Skyrim', near(R.regenFactor(8, 'stamina'), 1.15));
state[8].desc = '5000:Skyrim.esm';
check('...not indoors', R.regenFactor(8, 'stamina') === 1);
state[8].desc = 'a764b:BSHeartland.esm'; state[8].pos = [60000, 205000, 7100];
check('...outdoors at Bruma (the Jerall Mountains), yes', near(R.regenFactor(8, 'stamina'), 1.15));
state[8].pos = [0, -200000, 0];
check('...outdoors far south in Cyrodiil, no', R.regenFactor(8, 'stamina') === 1);
check('Orc: above 30% health, nothing', R.attackMult(9, NPC, SWORD, 10) === 1 && R.targetMult(NPC, 9, SWORD) === 1);
state[9].pc = { health: 0.25, magicka: 1, stamina: 1 };
check('Orc: below 30%, melee +20% (one-, two-handed, fists) and 20% less taken', near(R.attackMult(9, NPC, SWORD, 10), 1.2) && near(R.attackMult(9, NPC, GREATSWORD, 10), 1.2) && near(R.attackMult(9, NPC, FIST, 10), 1.2) && near(R.targetMult(NPC, 9, FLAMES), 0.8));
check('...a bow or a spell is not melee', R.attackMult(9, NPC, BOW, 10) === 1 && R.attackMult(9, NPC, FLAMES, 10) === 1);
check('Redguard: stamina x1.25, poison 50% less', near(R.regenFactor(10, 'stamina'), 1.25) && near(R.targetMult(NPC, 10, POISON), 0.5));
given.length = 0;
check('Imperial: +10% of 57 gold is 5, given as new coin', R.goldBonus(6, 57, 'contract pay') === 5 && given.length === 1 && given[0][0] === 6 && given[0][1] === 0xf && given[0][2] === 5);
check('...nobody else gets it', R.goldBonus(8, 100, 'contract pay') === 0 && given.length === 1);
check('...once per chest key', R.goldBonus(6, 100, 'a chest', 'L:1:c1:6') === 10 && R.goldBonus(6, 100, 'a chest', 'L:1:c1:6') === 0);

// ---- 2. the rules ----
const OFF = make({ enabled: false });
check('enabled false: no gift at all', OFF.raceOf(5) === '' && OFF.targetMult(NPC, 5, FLAMES) === 1 && OFF.regenFactor(1, 'magicka') === 1 && OFF.goldBonus(6, 100) === 0);
const R2 = make({ enabled: true });
check('an NPC has no gift whatever its race', (state[1002] = { race: RACE_IDS.dunmer[0] }, R2.targetMult(NPC, 1002, FLAMES) === 1));
check('a vampire keeps their own race\'s gift (the vampire race variant)', (state[11] = { race: RACE_IDS.dunmer[1] }, near(R2.targetMult(NPC, 11, FLAMES), 0.5)));
state[5].beast = { form: 'werewolf' }; state[1].beast = { form: 'vampirelord' }; state[9].beast = { form: 'werewolf' };
check('beast form: no resistance, no regen, no rage', R2.targetMult(NPC, 5, FLAMES) === 1 && R2.regenFactor(1, 'magicka') === 1 && R2.attackMult(9, NPC, FIST, 10) === 1);
delete state[5].beast; delete state[1].beast; delete state[9].beast;
const BIG = make({ enabled: true, alwaysRegenCap: 1.25, conditionalRegenCap: 1.5, altmer: { magickaRegen: 2 }, redguard: { staminaRegen: 3 }, argonian: { lowHealthHealRegen: 4 }, nord: { coldStaminaRegen: 9 } });
state[2].pc = { health: 0.1, magicka: 1, stamina: 1 }; state[8].desc = '3c:Skyrim.esm';
check('regen caps: always-on at most x1.25, conditional at most x1.5, whatever the config says',
  near(BIG.regenFactor(1, 'magicka'), 1.25) && near(BIG.regenFactor(10, 'stamina'), 1.25) && near(BIG.regenFactor(2, 'health'), 1.5) && near(BIG.regenFactor(8, 'stamina'), 1.5));
check('the reduction cap: never more than 75% off', near(R2.capTargetSide(0.1), 0.25) && near(R2.capTargetSide(0.5), 0.5) && near(R2.capTargetSide(1.2), 1.2));
check('the cap is off with the gifts', near(OFF.capTargetSide(0.1), 0.1));
// A stack as gamemode.js builds it: Defense x the target's blessing x the race, capped together
const side = (tgt, src, defense) => R2.capTargetSide(defense * G.blessingTargetMult(tgt, src) * R2.targetMult(NPC, tgt, src));
blessings[5] = { deity: 'ancestors', spell: 1, until: Date.now() + 3600000 };
check('Dunmer + the Ancestors\' ward on fire, no armour: 0.5 x 0.75 = 0.375', near(side(5, FLAMES, 1), 0.375));
check('...plus a Master Defense heavy set (x0.4): 0.15, capped to 0.25', near(side(5, FLAMES, 0.4), 0.25));
check('...the same armour on a sword hit: 0.4, under the cap', near(side(5, SWORD, 0.4), 0.4));
state[9].pc = { health: 0.2, magicka: 1, stamina: 1 };
check('Orc at low health in Master heavy armour (x0.3): 0.24, capped to 0.25', near(side(9, SWORD, 0.3), 0.25));
delete blessings[5];

// ---- 3. regeneration is added on the server, through the rest of the chain ----
for (const k of Object.keys(state)) delete state[k];
race(10, 'redguard', { health: 1, magicka: 1, stamina: 0.5 });
const R3 = make({ enabled: true, tickSeconds: 1, minStep: 0 });
let t = 1000000;
// a player's first tick pays one tickSeconds
R3.regenTick(t);
// vanilla stamina rate 5% a second x 0.25 = 1.25% a second
check('Redguard: one second adds 1.25% of stamina on top of the client\'s own regen', near(state[10].pc.stamina, 0.5 + 0.0125) && state[10].pc.health === 1, state[10].pc);
globalThis.__dboNeedsRateMult = () => 0.5;
globalThis.__dboChillRateMult = () => 0.5;
state[10].pc.stamina = 0.5; t += 1000; R3.regenTick(t);
check('...hungry (x0.5) and chilled (x0.5): a quarter of that', near(state[10].pc.stamina, 0.5 + 0.0125 * 0.25), state[10].pc);
globalThis.__dboChillRateMult = () => 0;
state[10].pc.stamina = 0.5; t += 1000; R3.regenTick(t);
check('...the chill at its cap (0): nothing', near(state[10].pc.stamina, 0.5));
delete globalThis.__dboNeedsRateMult; delete globalThis.__dboChillRateMult;
race(1, 'altmer', { health: 1, magicka: 0.2, stamina: 1 });
globalThis.__dboBlessingRegen = () => [{ stat: 'magicka', perSecond: 0.01 }];
t += 1000; R3.regenTick(t);
// (3% x 1 + 1% from Akatosh) x 0.25
check('Altmer with a magicka blessing: the gift multiplies the blessing\'s share too', near(state[1].pc.magicka, 0.2 + 0.04 * 0.25), state[1].pc);
delete globalThis.__dboBlessingRegen;
R3.onCast(1, 0x0e40c8);
state[1].pc.magicka = 0.2; t += 1000; R3.regenTick(t);
check('Highborn reaching the server: the gift waits its minute, never both', near(state[1].pc.magicka, 0.2) && R3.regenFactor(1, 'magicka') === 1);
globalThis.__dboIsDowned = (a) => a === 10;
state[10].pc.stamina = 0.5; t += 1000; R3.regenTick(t);
check('the downed get nothing', near(state[10].pc.stamina, 0.5));
delete globalThis.__dboIsDowned;
check('the timer is registered by name, so a reload replaces it', timers.includes('racialRegen'));

// ---- 4. the wiring ----
const hook = gm.slice(gm.indexOf('const hitDamageAttemptHook'), gm.indexOf('hitDamageAttemptHook.__dbo = true;'));
check('gamemode: the target\'s side is Defense x the target\'s blessing x the race, capped together',
  /let targetSide = defenseDamageMult\(tgt\) \* blessingTargetMult\(tgt, src\);/.test(hook) && /targetSide = racial\.capTargetSide\(targetSide \* racial\.targetMult\(agg, tgt, src\)\)/.test(hook));
check('gamemode: the race\'s attack gift joins the product, never for a beast',
  /if \(racial && !beastAgg\) \{ try \{ raceAtk = racial\.attackMult\(agg, tgt, src, dmg\)/.test(hook) && /\* targetSide \* blessingAttackMult\(agg, src\) \* raceAtk \*/.test(hook) && !/blessingDamageMult\(/.test(hook));
check('gamemode: the blessing split keeps the old product', /const blessingDamageMult = \(aggressorId, targetId, sourceId\) => blessingAttackMult\(aggressorId, sourceId\) \* blessingTargetMult\(targetId, sourceId\);/.test(gm));
check('gamemode: racial.js is loaded fresh on every reload', /delete require\.cache\[RACIAL_JS\];\s*racial = require\(RACIAL_JS\)/.test(gm));
check('gamemode: castHook tells racial.js of a cast', /const castHook = [^\n]*\n\s*try \{ if \(racial\) racial\.onCast\(/.test(gm));
check('gamemode: the needs chain answers __dboNeedsRateMult', /globalThis\.__dboNeedsRateMult = /.test(gm));
const dg = fs.readFileSync(path.join(SERVER, 'dungeons.js'), 'utf8');
const wl = fs.readFileSync(path.join(SERVER, 'wildlife.js'), 'utf8');
const ct = fs.readFileSync(path.join(SERVER, 'contracts.js'), 'utf8');
check('dungeons: a body\'s coin, a share of it, and a chest\'s rolled coin only (racial-gold-harness drives the chest)',
  /raceGold\(casterId, kept, master/.test(dg) && /raceGold\(m, share, 'a share of loot'\)/.test(dg) && /luck\(actorId, count - handed, 'a chest'\)/.test(dg) && /luck\(actorId, count, 'a chest'\)/.test(dg) && /const lucky = Math\.min\(count, rolled\)/.test(dg));
check('wildlife: a camp chest\'s coin', /__dboRaceGold\(casterId, it\.count, 'a camp chest'\)/.test(wl));
check('contracts: the pay, as new coin', /__dboRaceGold\(killerId, paid, 'contract pay'\)/.test(ct));
const others = fs.readdirSync(SERVER).filter((f) => f.endsWith('.js') && !['racial.js', 'dungeons.js', 'wildlife.js', 'contracts.js'].includes(f));
check('nothing else pays Imperial Luck (not the bank, trades, refunds or staff grants)', others.every((f) => !fs.readFileSync(path.join(SERVER, f), 'utf8').includes('__dboRaceGold(')), others.filter((f) => fs.readFileSync(path.join(SERVER, f), 'utf8').includes('__dboRaceGold(')));
const conf = JSON.parse(fs.readFileSync(path.join(SERVER, 'gamemode-config.json'), 'utf8')).racial || {};
check('gamemode-config: racial on, the approved numbers', conf.enabled === true && conf.reductionCap === 0.75 && conf.altmer.magickaRegen === 1.25 && conf.argonian.lowHealthHealRegen === 1.5
  && conf.bosmer.bowDamage === 0.1 && conf.breton.resistMagic === 0.25 && conf.dunmer.resistFire === 0.5 && conf.imperial.goldBonus === 0.1 && conf.khajiit.unarmedDamage === 8
  && conf.nord.coldStaminaRegen === 1.15 && conf.orc.meleeDamage === 0.2 && conf.orc.damageTaken === 0.2 && conf.redguard.staminaRegen === 1.25);

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
