// Scripted test for the racial overhaul (racial.js `overhaul`, Nate's "Racial Updates" 10 Oct,
// ~/claude-nate-release/specs/racial-overhaul.md): the Maormer on the High Elf record, one XP boost per race, the Argonian's
// disease resistance and the Racial Power (state on the character, buffs in the hit and regeneration hooks, under the caps),
// and their wiring in skillrates.js, supernatural.js, journal.js and gamemode.js. The mock records and the hit-path readers
// are racial-harness.js's.
//   node tests/racial-overhaul-harness.js
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
    return (s.props || {})[k];
  },
  set: (id, k, v) => { state[id] = state[id] || {}; if (k === 'percentages') state[id].pc = v; else if (k === 'inventory') state[id].inv = v.entries; else { state[id].props = state[id].props || {}; state[id].props[k] = v; } },
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
const race = (id, name, pc) => { state[id] = { race: RACE_IDS[name][0], pc: pc || { health: 1, magicka: 1, stamina: 1 } }; };
const NPC = 1001;
state[NPC] = { pc: { health: 1, magicka: 1, stamina: 1 } };


const OFF = make({ enabled: true });
const R = make({ enabled: true, overhaul: true });
const set = (id, k, v) => mp.set(id, k, v);
const MAORMER = 11, ALTMER = 1, ARGONIAN = 2, BOSMER = 3, BRETON = 4, DUNMER = 5, IMPERIAL = 6, KHAJIIT = 7, NORD = 8, ORC = 9, REDGUARD = 10;
race(ALTMER, 'altmer'); race(ARGONIAN, 'argonian'); race(BOSMER, 'bosmer'); race(BRETON, 'breton'); race(DUNMER, 'dunmer');
race(IMPERIAL, 'imperial'); race(KHAJIIT, 'khajiit'); race(NORD, 'nord'); race(ORC, 'orc'); race(REDGUARD, 'redguard');
race(MAORMER, 'altmer'); set(MAORMER, 'private.rp', { species: 'mer', race: 'maormer' });
set(ALTMER, 'private.rp', { species: 'mer', race: 'altmer' });

// ---- 1. the overhaul off: today's numbers ----
check('off: a Maormer counts as an Altmer, as today', OFF.raceOf(MAORMER) === 'altmer' && near(OFF.regenFactor(MAORMER, 'magicka'), 1.25) && OFF.targetMult(NPC, MAORMER, SPARKS) === 1);
check('off: no XP boost, no disease resistance, no power', OFF.skillRate(NORD, 'blade', 'hit') === 1 && OFF.diseaseResist(ARGONIAN) === 0 && OFF.powerView(NORD) === null && OFF.usePower(NORD).ok === false);
check('off: nothing is written to the character', !(state[NORD].props || {})['private.racialPower']);

// ---- 2. the Maormer ----
check('on: a Maormer (High Elf record, private.rp.race maormer) is a Maormer', R.raceOf(MAORMER) === 'maormer');
check('on: an Altmer is still an Altmer (magicka x1.25)', R.raceOf(ALTMER) === 'altmer' && near(R.regenFactor(ALTMER, 'magicka'), 1.25));
check('Maormer: shock 50% (Nate\'s table), no other resistance', near(R.targetMult(NPC, MAORMER, SPARKS), 0.5) && R.targetMult(NPC, MAORMER, FLAMES) === 1, R.targetMult(NPC, MAORMER, SPARKS));
check('Maormer: a sword unchanged, no Altmer magicka gift', R.targetMult(NPC, MAORMER, SWORD) === 1 && R.regenFactor(MAORMER, 'magicka') === 1);
check('Maormer in a beast form has no gift', (() => { state[MAORMER].beast = { form: 'werewolf' }; const r = R.raceOf(MAORMER); delete state[MAORMER].beast; return r === ''; })());

// ---- 3. one XP boost per race, +15% ----
const XP = { altmer: 'arcane', argonian: 'harvesting', bosmer: 'archery', breton: 'priest', dunmer: 'arcane', imperial: 'defense', khajiit: 'unarmed', nord: 'blade', orc: 'blacksmith', redguard: 'blade', maormer: 'blade' };
const ids = { altmer: ALTMER, argonian: ARGONIAN, bosmer: BOSMER, breton: BRETON, dunmer: DUNMER, imperial: IMPERIAL, khajiit: KHAJIIT, nord: NORD, orc: ORC, redguard: REDGUARD, maormer: MAORMER };
check('every race: its one skill x1.15, another skill x1', Object.entries(XP).every(([r, sk]) => near(R.skillRate(ids[r], sk, 'hit'), 1.15) && R.skillRate(ids[r], sk === 'cook' ? 'blunt' : 'cook', 'craft') === 1), Object.entries(XP).map(([r, sk]) => [r, R.skillRate(ids[r], sk, 'hit')]));
check('...never for a staff award, never for an NPC', R.skillRate(NORD, 'blade', 'award') === 1 && R.skillRate(NPC, 'blade', 'hit') === 1);
// skillrates.js multiplies its own rate by the race's
delete require.cache[path.join(SERVER, 'skillrates.js')];
require(path.join(SERVER, 'skillrates.js'))({ log: () => {}, cfg: { skillRates: { rates: { blade: 2 } } }, recordOf, fieldsOf: () => [], inBeastForm: () => false });
check('skillrates.js: a Nord swinging a blade at rate 2 earns x2.3; an Imperial x2', near(globalThis.__dboSkillRate(NORD, 'blade', 'hit'), 2.3) && near(globalThis.__dboSkillRate(IMPERIAL, 'blade', 'hit'), 2), [globalThis.__dboSkillRate(NORD, 'blade', 'hit')]);

// ---- 4. disease ----
check('the Argonian shrugs off half of every fever (diseaseResist 0.5, Skyrim\'s 50%); the others none', R.diseaseResist(ARGONIAN) === 0.5 && R.diseaseResist(NORD) === 0 && R.diseaseResist(NPC) === 0);
const sup = fs.readFileSync(path.join(SERVER, 'supernatural.js'), 'utf8');
check('supernatural.js: a hit\'s and a feed\'s infection chance are scaled by it; rites and GM curses are not', /Math\.random\(\) < chance \* \(1 - raceDiseaseResist\(tgt\)\)\) infect\(tgt/.test(sup) && /Math\.random\(\) < C\.infectFeed \* \(1 - raceDiseaseResist\(t\)\)\) infect\(t, 'vampire'/.test(sup) && (sup.match(/raceDiseaseResist\(/g) || []).length === 2);

// ---- 5. the Racial Power ----
const view0 = R.powerView(NORD);
check('a Nord\'s power: Battle Cry, 60 s, ready', view0 && view0.name === 'Battle Cry' && view0.seconds === 60 && view0.ready === true, view0);
check('before it: a sword hits as today', R.attackMult(NORD, NPC, SWORD, 10) === 1);
const u = R.usePower(NORD);
check('used: told, and kept on the character with a day\'s wait', u.ok && /^Battle Cry: 60 seconds/.test(u.text) && (() => { const st = state[NORD].props['private.racialPower']; return st.race === 'nord' && st.activeUntil - st.usedAt === 60000 && st.readyAt - st.usedAt === 24 * 3600000; })(), u);
check('Battle Cry: melee +15% (a sword, fists), a bow and a spell unchanged', near(R.attackMult(NORD, NPC, SWORD, 10), 1.15) && near(R.attackMult(NORD, NPC, FIST, 10), 1.15) && R.attackMult(NORD, NPC, BOW, 10) === 1 && R.attackMult(NORD, NPC, FLAMES, 10) === 1);
check('...not used twice while it lasts', /already upon you/.test(R.usePower(NORD).text));
check('the status line and the HUD countdown say so', /^Battle Cry: upon you, (59|60) s left$/.test(R.statusLine(NORD)) && R.hudField(NORD) && R.hudField(NORD).name === 'Battle Cry' && [59000, 60000].includes(R.hudField(NORD).ms) && R.powerView(NORD).activeMs > 59000 && R.powerView(NORD).waitMs > 86399000, [R.statusLine(NORD), R.hudField(NORD)]);
// a relog: a new module over the same character state
const R2 = make({ enabled: true, overhaul: true });
check('a relog or a reload keeps the buff and the wait', near(R2.attackMult(NORD, NPC, SWORD, 10), 1.15) && /already upon you/.test(R2.usePower(NORD).text));
const st = state[NORD].props['private.racialPower'];
st.activeUntil = Date.now() - 1;
check('when it ends: the hit is plain again, and it waits out the day', R2.attackMult(NORD, NPC, SWORD, 10) === 1 && /^Battle Cry returns in 24 h\./.test(R2.usePower(NORD).text) && /^Battle Cry: returns in 24 h$/.test(R2.statusLine(NORD)), R2.usePower(NORD).text);
st.readyAt = Date.now() - 1;
check('...then it is ready again', R2.powerView(NORD).ready === true && R2.usePower(NORD).ok === true);
// the fade message
told.length = 0; state[NORD].props['private.racialPower'].activeUntil = Date.now() - 1; globalThis.__dboRacialState.powerOn.set(NORD, Date.now() - 1);
R2.powerTick();
check('it fades with a word', told.some(([a, t]) => a === NORD && t === 'Battle Cry fades.'), told);

// Orsimer Berserker Rage: +25% melee, -25% every hit taken; with the low-health rage under the cap
R.usePower(ORC);
check('Berserker Rage: melee x1.25, every hit taken x0.75 (a spell too)', near(R.attackMult(ORC, NPC, GREATSWORD, 10), 1.25) && near(R.targetMult(NPC, ORC, SWORD), 0.75) && near(R.targetMult(NPC, ORC, FLAMES), 0.75));
state[ORC].pc = { health: 0.2, magicka: 1, stamina: 1 };
check('...with the low-health rage: x1.2 x1.25 dealt, x0.8 x0.75 taken; the cap floor stays 0.25', near(R.attackMult(ORC, NPC, SWORD, 10), 1.5) && near(R.targetMult(NPC, ORC, SWORD), 0.6) && near(R.capTargetSide(0.6 * 0.3), 0.25));
state[ORC].pc = { health: 1, magicka: 1, stamina: 1 };
// Breton Dragonskin: 25% + 25% = 50% of a spell
R.usePower(BRETON);
check('Dragonskin: magic resist 25% + 25% = 50%, a sword unchanged', near(R.targetMult(NPC, BRETON, FROSTBITE), 0.5) && R.targetMult(NPC, BRETON, SWORD) === 1, R.targetMult(NPC, BRETON, FROSTBITE));
// Argonian Histskin: health regen x1.5 at any health, -15% physical
R.usePower(ARGONIAN);
check('Histskin: health regen x1.5 at full health (the timed cap), physical hits x0.85, a spell unchanged', near(R.regenFactor(ARGONIAN, 'health'), 1.5) && near(R.targetMult(NPC, ARGONIAN, SWORD), 0.85) && R.targetMult(NPC, ARGONIAN, FLAMES) === 1);
check('...and poison still 50% off (the gift and the power together)', near(R.targetMult(NPC, ARGONIAN, POISON), 0.5));
// Altmer Highborn: magicka x1.5 instead of x1.25, never x1.875
R.usePower(ALTMER);
check('Highborn: magicka regen x1.5 in place of the gift\'s x1.25', near(R.regenFactor(ALTMER, 'magicka'), 1.5));
// Imperial rally, Redguard, Bosmer
R.usePower(IMPERIAL); R.usePower(REDGUARD); R.usePower(BOSMER);
check('Voice of the Emperor: health and stamina regen x1.5', near(R.regenFactor(IMPERIAL, 'health'), 1.5) && near(R.regenFactor(IMPERIAL, 'stamina'), 1.5));
check('Adrenaline Rush: stamina x1.5 in place of the gift\'s x1.25', near(R.regenFactor(REDGUARD, 'stamina'), 1.5));
check('Wild Hunt: a bow x1.1 x1.2, stamina x1.5, a sword unchanged; 30 s', near(R.attackMult(BOSMER, NPC, BOW, 10), 1.1 * 1.2) && near(R.regenFactor(BOSMER, 'stamina'), 1.5) && R.attackMult(BOSMER, NPC, SWORD, 10) === 1
  && state[BOSMER].props['private.racialPower'].activeUntil - state[BOSMER].props['private.racialPower'].usedAt === 30000);
// Dunmer and Maormer: damage dealt by element
R.usePower(DUNMER); R.usePower(MAORMER);
check("Ancestor's Wrath: fire dealt x1.25 (a spell or a fire staff), frost unchanged", near(R.attackMult(DUNMER, NPC, FLAMES, 10), 1.25) && near(R.attackMult(DUNMER, NPC, FIRE_STAFF, 10), 1.25) && R.attackMult(DUNMER, NPC, FROSTBITE, 10) === 1);
check('Roaring Tempest: no shock damage dealt; the ward is 60 points', R.attackMult(MAORMER, NPC, SPARKS, 10) === 1 && state[MAORMER].props['private.racialPower'].wardLeft === 60);
check('...a 20-point fire spell: 25% magic resist leaves 15, the ward takes all of it', R.targetMult(NPC, MAORMER, FLAMES, 20) === 0 && state[MAORMER].props['private.racialPower'].wardLeft === 45, state[MAORMER].props['private.racialPower']);
check('...a sword is not warded', R.targetMult(NPC, MAORMER, SWORD, 20) === 1 && state[MAORMER].props['private.racialPower'].wardLeft === 45);
told.length = 0;
check('...a 100-point shock spell: x0.5 x0.75 = 37.5, the ward takes the last 45 to 0... and breaks', near(R.targetMult(NPC, MAORMER, SPARKS, 100), 0) && state[MAORMER].props['private.racialPower'].wardLeft === 7.5 && near(R.targetMult(NPC, MAORMER, SPARKS, 100), 0.375 * (37.5 - 7.5) / 37.5) && state[MAORMER].props['private.racialPower'].wardLeft === 0 && told.some(([a, x]) => a === MAORMER && x === 'Your ward breaks.'), state[MAORMER].props['private.racialPower']);
check('...spent: magic resist only', near(R.targetMult(NPC, MAORMER, FLAMES, 20), 0.75));
check('...under the cap: Defense x0.3 with the ward\'s 0 is floored at 0.25', near(R.capTargetSide(0.3 * 0), 0.25));
// Khajiit Night Eye: the client's, later
const k = R.usePower(KHAJIIT);
check('Night Eye is refused until the client can draw it; its view says so, not ready', !k.ok && /later update/.test(k.text) && R.powerView(KHAJIIT).ready === false && /later update/.test(R.statusLine(KHAJIIT)));
const RK = make({ enabled: true, overhaul: true, khajiit: { unarmedDamage: 8, power: { name: 'Night Eye', seconds: 60, cooldownHours: 1 / 3, buffs: {} } } });
const k2 = RK.usePower(KHAJIIT);
check('...once it is, it waits 20 minutes, not a day', k2.ok && state[KHAJIIT].props['private.racialPower'].readyAt - state[KHAJIIT].props['private.racialPower'].usedAt === 20 * 60000);
// a beast form has no race and no power
state[ORC].props['private.racialPower'].activeUntil = Date.now() + 60000; state[ORC].beast = { form: 'werewolf' };
check('in a beast form the running power gives nothing and none can be called', R.attackMult(ORC, NPC, SWORD, 10) === 1 && R.targetMult(NPC, ORC, SWORD) === 1 && /beast/.test(R.usePower(ORC).text));
delete state[ORC].beast;
check('NPCs have no power', R.powerView(NPC) === null && R.usePower(NPC).ok === false);

// ---- the Maormer's swimming ability and the ward's look (DLE records, config ids) ----
const calls = [];
mp.callPapyrusFunction = (kind, cls, method, self, args) => { calls.push([method, self.desc, args[0].desc]); };
mp.getDescFromId = (id) => `${(id >>> 0).toString(16)}:Skyrim.esm`;
const ABIL = 0x7701, LOOK = 0x7702;
const RA = make({ enabled: true, overhaul: true, maormer: { resistShock: 0.5, seafarerSpell: '' } });
RA.abilityTick();
check('no ability record in the load order yet: nothing is added', calls.length === 0);
records[ABIL] = { record: { type: 'SPEL', fields: [] } }; records[LOOK] = { record: { type: 'SPEL', fields: [] } };
mp.getIdFromDesc = ((orig) => (d) => ({ '7701:DragonBreak Online Edits.esp': ABIL, '7702:DragonBreak Online Edits.esp': LOOK, '7701:Skyrim.esm': ABIL })[d] || orig(d))(mp.getIdFromDesc);
const packets = [];
const RB = make({ enabled: true, overhaul: true, maormer: { resistShock: 0.5, seafarerSpell: '7701:DragonBreak Online Edits.esp', power: { name: 'Roaring Tempest', seconds: 60, wardSpell: '7702:DragonBreak Online Edits.esp', buffs: { resistMagic: 0.25, wardPoints: 60 } } } },
  { sendPacket: (a, p) => { packets.push([a, p]); return true; } });
RB.abilityTick();
check('the ability goes on the Maormer only, once', calls.length === 1 && calls[0][0] === 'AddSpell' && calls[0][1] === MAORMER.toString(16) + ':Skyrim.esm' && state[MAORMER].props['private.racialAbility'] === '7701:Skyrim.esm', calls);
RB.abilityTick();
check('...not again in the same session', calls.length === 1);
state[MAORMER].props['private.rp'] = { race: 'altmer' };
RB.abilityTick();
check('a character no longer a Maormer loses it', calls.length === 2 && calls[1][0] === 'RemoveSpell' && calls[1][2] === '7701:Skyrim.esm' && state[MAORMER].props['private.racialAbility'] === null, calls);
state[MAORMER].props['private.rp'] = { race: 'maormer' };
state[MAORMER].props['private.racialPower'] = {};
const tu = RB.usePower(MAORMER);
check("Roaring Tempest casts the ward's look on the player (dboCastSelf)", tu.ok && packets.some(([a, p]) => a === MAORMER && p.customPacketType === 'dboCastSelf' && p.spell === LOOK), packets);

// ---- the DLE's MaormerRace (config maormerRace) ----
const MRACE = 0x7801, MVAMP = 0x7802, MR_ACTOR = 12;
const R0 = make({ enabled: true, overhaul: true, maormerRace: { race: '7801:DragonBreak Online Edits.esp', vampire: '7802:DragonBreak Online Edits.esp' } });
check('not in the load order yet: no creator override', JSON.stringify(globalThis.__dboRaceOverrides) === '{}');
records[MRACE] = RACE(4); records[MVAMP] = RACE(4);
mp.getIdFromDesc = ((orig) => (d) => ({ '7801:DragonBreak Online Edits.esp': MRACE, '7802:DragonBreak Online Edits.esp': MVAMP })[d] || orig(d))(mp.getIdFromDesc);
const RM = make({ enabled: true, overhaul: true }, { cfg: { racial: { enabled: true, overhaul: true }, maormerRace: { race: '7801:DragonBreak Online Edits.esp', vampire: '7802:DragonBreak Online Edits.esp' } } });
check('both RACE records: the creator makes new Maormer on MaormerRace (__dboRaceOverrides)', globalThis.__dboRaceOverrides && globalThis.__dboRaceOverrides.maormer === MRACE);
state[MR_ACTOR] = { race: MRACE, pc: { health: 1, magicka: 1, stamina: 1 } };
check('a character on MaormerRace is the Maormer, without private.rp', RM.raceOf(MR_ACTOR) === 'maormer' && near(RM.targetMult(NPC, MR_ACTOR, SPARKS), 0.5));
state[MR_ACTOR].race = MVAMP;
check('...and on MaormerRaceVampire too', RM.raceOf(MR_ACTOR) === 'maormer');
const RMoff = make({ enabled: true }, { cfg: { racial: { enabled: true }, maormerRace: { race: '7801:DragonBreak Online Edits.esp', vampire: '7802:DragonBreak Online Edits.esp' } } });
state[MR_ACTOR].race = MRACE;
check('with the overhaul off a MaormerRace character has the Altmer gift, as on the High Elf record', RMoff.raceOf(MR_ACTOR) === 'altmer' && near(RMoff.regenFactor(MR_ACTOR, 'magicka'), 1.25));
check('a High Elf record Maormer (private.rp) is still one', RM.raceOf(MAORMER) === 'maormer');
const sup2 = fs.readFileSync(path.join(SERVER, 'supernatural.js'), 'utf8'), app2 = fs.readFileSync(path.join(SERVER, 'appearance.js'), 'utf8');
check('supernatural.js: MaormerRace <-> MaormerRaceVampire beside the vanilla pairs, the High Elf\'s tells', /VAMPIRE_RACES\.set\(maormerRace\[0\], maormerRace\[1\]\); MORTAL_RACES\.set\(maormerRace\[1\], maormerRace\[0\]\)/.test(sup2) && /FAMILY\.set\(maormerRace\[0\], 'highelf'\)/.test(sup2) && sup2.indexOf('const maormerRace') > sup2.indexOf('const recordOf = '));
check('appearance.js: both guarded as the High Elf\'s heads', /HEADS\.raceOf\.set\(r, 'HighElfRace'\); HEADS\.raceOf\.set\(v, 'HighElfRace'\)/.test(app2));
const gc = JSON.parse(fs.readFileSync(path.join(SERVER, 'gamemode-config.json'), 'utf8'));
check('gamemode-config.json: maormerRace is the final DLE\'s (ec2de1a0) MaormerRace 192ede and MaormerRaceVampire 192edf', gc.maormerRace && gc.maormerRace.race === '192ede:DragonBreak Online Edits.esp' && gc.maormerRace.vampire === '192edf:DragonBreak Online Edits.esp');
check('...the Seafarer ability 192ee1 and the Tempest ward look 192ee3; the power block whole, the overhaul still off', gc.racial.maormer.seafarerSpell === '192ee1:DragonBreak Online Edits.esp' && gc.racial.maormer.power.wardSpell === '192ee3:DragonBreak Online Edits.esp'
  && gc.racial.maormer.power.name === 'Roaring Tempest' && gc.racial.maormer.power.seconds === 60 && gc.racial.maormer.power.buffs.resistMagic === 0.25 && gc.racial.maormer.power.buffs.wardPoints === 60 && gc.racial.overhaul === false);
// the live config, as racial.js merges it: the Maormer as in the code's defaults but for the two spells
const RL = make(gc.racial, { cfg: { racial: Object.assign({}, gc.racial, { overhaul: true }), maormerRace: gc.maormerRace } });
check('...merged: the Maormer keep shock 50%, Blade +15% and the ward', RL.config.maormer.resistShock === 0.5 && RL.config.maormer.xp.blade === 1.15 && RL.config.maormer.power.buffs.wardPoints === 60);

// ---- 6. the wiring ----
const jr = fs.readFileSync(path.join(SERVER, 'journal.js'), 'utf8');
check('journal.js: the Profile tab\'s action racialPower and its view', /racialPower: \(a\) => \(typeof globalThis\.__dboRacialPowerUse === 'function'/.test(jr) && /racialPower: own === false \? null : racialPowerView\(a\)/.test(jr) && /racialPower: 'Racial Power'/.test(jr));
const gmSrc = fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8');
check('gamemode.js: the hit hands the ward its damage; racial gets sendPacket', /racial\.targetMult\(agg, tgt, src, dmg\)/.test(gmSrc) && /gmstFloat, cfg, sendPacket \}\);/.test(gmSrc));
check('gamemode.js: the HUD carries the countdown and can be sent on demand', /globalThis\.__dboRacialPowerHud\(a\) : null; if \(rp\) v\.racialPower = rp;/.test(gmSrc) && /globalThis\.__dboHudRefresh = \(a\) =>/.test(gmSrc));
check('the hooks are published', ['__dboRaceSkillRate', '__dboRaceDiseaseResist', '__dboRacialPowerUse', '__dboRacialPowerView', '__dboRacialPowerHud'].every((n) => typeof globalThis[n] === 'function'));
// Others see a power (Nate, 11 Oct: nobody saw Roaring Tempest): its lookShader as a dboGlow on the caster, for players near
{
  const SHADER = 0x10f9a6;
  records[SHADER] = { record: { type: 'EFSH', fields: [] } };
  mp.getIdFromDesc = ((orig) => (d) => (d === '10f9a6:Skyrim.esm' ? SHADER : orig(d)))(mp.getIdFromDesc);
  const pk = [];
  const RC = make({ enabled: true, overhaul: true, maormer: { resistShock: 0.5, power: { name: 'Roaring Tempest', seconds: 60, lookShader: '10f9a6:Skyrim.esm', buffs: { resistMagic: 0.25 } } } },
    { sendPacket: (to, p) => { pk.push([to, p]); return true; } });
  state[MAORMER].props['private.racialPower'] = {}; globalThis.__dboRacialState.powerOn.delete(MAORMER); globalThis.__dboRacialState.looks.clear();
  state[MAORMER].pos = [0, 0, 0]; state[NORD].pos = [500, 0, 0]; state[ORC].pos = [9000, 0, 0];
  const glows = () => pk.filter(([, p]) => p.customPacketType === 'dboGlow');
  RC.usePower(MAORMER);
  let g = glows();
  const toldOn = new Set(g.filter(([, p]) => p.on).map(([to]) => to));
  check('a player near sees the shader on the caster', g.some(([to, p]) => to === NORD && p.on === true && p.refs[0] === MAORMER && p.shader === SHADER), g);
  check('...one far away does not, nor the caster', !g.some(([to]) => to === ORC || to === MAORMER), g);
  state[ORC].pos = [800, 0, 0]; pk.length = 0; RC.powerTick();
  for (const [to, p] of glows()) if (p.on) toldOn.add(to);
  check('someone who comes near while it lasts sees it then, once', glows().length === 1 && glows()[0][0] === ORC && glows()[0][1].on === true, glows());
  pk.length = 0; RC.powerTick();
  check('...and is not told again', glows().length === 0, glows());
  globalThis.__dboRacialState.looks.get(MAORMER).until = Date.now() - 1; pk.length = 0; RC.powerTick();
  const off = glows().filter(([, p]) => p.on === false).map(([to]) => to);
  check('when it fades, everyone told sees it go, and only they', off.length === toldOn.size && off.every((to) => toldOn.has(to)) && toldOn.has(ORC), [...toldOn]);
  state[NORD].pos = undefined; state[ORC].pos = undefined; state[MAORMER].pos = undefined;
}
check('the timers are named (a reload replaces them)', timers.includes('racialRegen') && timers.includes('racialPower'));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
