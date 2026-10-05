// Scripted test for the regeneration blessings the server holds itself (prayer.js, 2026-10-01). The server crops every
// vitals report to its own regeneration (CropRegeneration.cpp), which a blessing's rate effects never reach, so Akatosh,
// Hircine, Meridia and the Worm Cult sped up only the player's own bar and the server pulled it back. Now a tick raises the
// worshipper's percentage by what the blessing adds, read from the blessing's own record the way the game counts it (a
// rate effect adds its magnitude to the rate, a Mult effect its magnitude % of the race's rate), and the Hist and the
// Yokudan gods name theirs in skills.json (blessingRegen). Loads the real module with a mock gamemode api, and records
// shaped like the real ones (SPEL SPIT/EFID/EFIT, MGEF DATA, RACE DATA). Run it from this folder's parent with
//
//   node tests/blessing-regen-harness.js
'use strict';
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const PRAYER = path.join(SERVER, 'prayer.js');
const SKILLS = JSON.parse(JSON.stringify(require(path.join(SERVER, 'skills.json'))));

globalThis.performance = { now: () => 0 };
let wallClock = 1790000000000;
const realNow = Date.now;
Date.now = () => wallClock;
const H = 3600000;

const ACTOR = 0x14;
const NORD = 0x13746;
const idOf = (d) => parseInt(String(d).split(':')[0], 16) >>> 0;
const choiceOf = (id) => SKILLS.deities.choices.find((c) => c.id === id);
const spellOf = (id) => idOf(choiceOf(id).blessing);

// A deity for the filter only: its spell carries a detrimental and a hostile regeneration effect beside a good one
SKILLS.deities.choices.push({ id: 'testgod', name: 'Test God', kind: 'faith', blessing: 'abcde:Skyrim.esm', shrines: [], prayAnywhere: true, boon: 'x', sphere: 'x', blessingSource: 'vanilla' });

const field = (type, bytes) => ({ type, data: Uint8Array.from(bytes) });
const u32le = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const f32le = (x) => { const b = Buffer.alloc(4); b.writeFloatLE(x); return [...b]; };
// MGEF DATA (libespm MGEF.h): flags u32 at 0, resist value i32 at 16, archetype u32 at 64, primary actor value i32 at 68
const mgef = (flags, archetype, av) => {
  const d = new Array(152).fill(0);
  u32le(flags).forEach((b, i) => { d[i] = b; });
  u32le(-1 >>> 0).forEach((b, i) => { d[16 + i] = b; });
  u32le(archetype).forEach((b, i) => { d[64 + i] = b; });
  u32le(av >>> 0).forEach((b, i) => { d[68 + i] = b; });
  return { record: { type: 'MGEF', fields: [field('DATA', d)] } };
};
// A SPEL: SPIT (type, cast type, delivery) and one EFID/EFIT pair per effect [mgef id, magnitude, seconds]
const spel = (type, castType, effects) => ({ record: { type: 'SPEL', fields: [
  field('SPIT', [...u32le(402104), ...u32le(0), ...u32le(type), ...u32le(0), ...u32le(castType), ...u32le(0), ...u32le(0), ...u32le(0), ...u32le(0)]),
  ...effects.flatMap(([id, mag, secs]) => [field('EFID', u32le(id)), field('EFIT', [...f32le(mag), ...u32le(0), ...u32le(secs)])]),
] } });
// RACE DATA: health, magicka and stamina regeneration at 84, 88, 92 (libespm RACE.cpp)
const race = (h, m, s) => { const d = new Array(128).fill(0); f32le(h).forEach((b, i) => { d[84 + i] = b; }); f32le(m).forEach((b, i) => { d[88 + i] = b; }); f32le(s).forEach((b, i) => { d[92 + i] = b; }); return { record: { type: 'RACE', fields: [field('DATA', d)] } }; };

// The effects as measured in the server's load order (2026-10-01): archetype 34 Peak Value Modifier, 3 Cure Disease
const MGEF = {
  FortifyMagickaRateFFSelf: [0xfb989, mgef(0x200902, 34, 156)],      // MagickaRateMult
  FortifyStaminaRateFFSelf: [0xfb98b, mgef(0x200902, 34, 29)],       // StaminaRate
  AlchFortifyHealRate: [0x3eb06, mgef(0x200802, 34, 155)],           // HealRateMult
  doomMagickaRecoveryAbility: [0xe5f4f, mgef(0x200802, 34, 156)],    // MagickaRateMult
  FortifyMagickaFFSelf: [0xfb98c, mgef(0x200902, 34, 25)],           // Magicka (not a rate)
  CureDiseaseEffect: [0xfbff5, mgef(0x201a00, 3, -1)],
  PerkArgonianFortifyHealRateNonCombat: [0x106aeb, mgef(0x4201802, 34, 27)],   // Histskin's HealRate +10
  DisDamageMagickaRegen: [0xb8784, mgef(0x6, 34, 156)],              // detrimental (0x4)
  HostileStaminaRate: [0xb8785, mgef(0x1, 0, 157)],                  // hostile (0x1)
  TestStaminaRateMult: [0xb8786, mgef(0x0, 0, 157)],                 // a plain Value Modifier, counted
};
const records = new Map();
for (const [, [id, r]] of Object.entries(MGEF)) records.set(id, r);
const E = (name, mag, secs = 28800) => [MGEF[name][0], mag, secs];
records.set(spellOf('akatosh'), spel(0, 1, [E('FortifyMagickaRateFFSelf', 10), E('CureDiseaseEffect', 25, 0)]));
records.set(spellOf('hircine'), spel(0, 1, [E('FortifyStaminaRateFFSelf', 10), E('CureDiseaseEffect', 25, 0)]));
records.set(spellOf('meridia'), spel(0, 1, [E('AlchFortifyHealRate', 25), E('CureDiseaseEffect', 25, 0)]));
records.set(spellOf('julianos'), spel(0, 1, [E('FortifyMagickaFFSelf', 25), E('CureDiseaseEffect', 25, 0)]));
records.set(spellOf('wormcult'), spel(4, 0, [E('doomMagickaRecoveryAbility', 100, 0)]));
records.set(0xe40d5, spel(2, 1, [E('PerkArgonianFortifyHealRateNonCombat', 10, 60)]));           // Histskin, the old Hist blessing
records.set(0xabcde, spel(0, 1, [E('DisDamageMagickaRegen', 50), E('HostileStaminaRate', 50), E('TestStaminaRateMult', 20)]));
records.set(NORD, race(0.7, 3, 5));
records.set(0x13748, race(1.4, 6, 10));    // a race of our own, twice the Nord's rates

const props = new Map();
let online = [ACTOR];
const out = { sets: [], logs: [], packets: [] };
const handlers = new Map(), commands = new Map(), timers = new Map();
let settings = {};
const api = {
  mp: {
    getIdFromDesc: (d) => idOf(d),
    getDescFromId: (id) => `${(id >>> 0).toString(16)}:Skyrim.esm`,
    get: (id, prop) => props.get(id + '|' + prop),
    set: (id, prop, v) => { if (prop === 'percentages') out.sets.push(v); props.set(id + '|' + prop, v); },
    lookupEspmRecordById: (id) => records.get(id >>> 0) || null,
    callPapyrusFunction: () => true,
    getServerSettings: () => settings,
  },
  log: (...a) => out.logs.push(a.join(' ')),
  personal: () => {}, audit: () => {}, display: () => 'Tester #ABCD', who: () => 'Tester #ABCD (profile 1)',
  cfg: {}, openWidget: () => true, closeWidget: () => true,
  onUi: (ev, fn) => handlers.set(ev, fn), registerChatCommand: (name, fn) => commands.set(name, fn),
  onlineActors: () => online, every: (name, ms, fn) => timers.set(name, { ms, fn }),
  skills: SKILLS, takeGold: () => true, treasuryHere: (a, n) => n, sendPacket: (a, p) => out.packets.push(p),
};

let failures = 0;
const check = (name, cond, detail) => { if (!cond) failures++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + detail : ''}`); };
const near = (x, y, eps = 1e-6) => Math.abs(x - y) < eps;
const load = () => { delete require.cache[require.resolve(PRAYER)]; timers.clear(); out.logs.length = 0; require(PRAYER)(api); };
const pc = () => props.get(ACTOR + '|percentages');
const setPc = (health, magicka, stamina) => props.set(ACTOR + '|percentages', { health, magicka, stamina });
const bless = (deity, hours = 8, extra = {}) => {
  globalThis.__dboBlessingRegenOwed.delete(ACTOR);
  props.set(ACTOR + '|private.dboBlessing', Object.assign({ deity, spell: blessingSpell(deity), until: wallClock + hours * H, via: 'cast' }, extra));
};
const blessingSpell = (deity) => { const s = String(choiceOf(deity).blessing || ''); return /^[0-9a-f]+:/i.test(s) ? idOf(s) : 0; };
// n ticks of the regeneration timer, a second apart
const run = (n = 1) => { for (let i = 0; i < n; i++) { wallClock += 1000; timers.get('prayerBlessingRegen').fn(); } };
const gained = (deity, stat, secs, start = 0.5) => {
  bless(deity); setPc(start, start, start); out.sets.length = 0;
  run(secs);
  return pc()[stat] - start;
};

props.set(ACTOR + '|appearance', { raceId: NORD });
load();

// ---- what is held, read from the records -------------------------------------------------------------------------------
const line = out.logs.find((l) => /regeneration held by the server/.test(l)) || '';
check('the boot line names every regeneration blessing, as the tick reads it',
  /akatosh MagickaRateMult \+10/.test(line) && /hircine StaminaRate \+10/.test(line) && /meridia HealRateMult \+25/.test(line)
  && /hist HealRateMult \+50/.test(line) && /yokudan StaminaRateMult \+100/.test(line) && /wormcult MagickaRateMult \+100/.test(line)
  && !/julianos/.test(line), line.replace(/^.*: /, ''));
check('the tick runs every second', timers.get('prayerBlessingRegen').ms === 1000);

const RATES = [
  // deity, bar, per second (share of the bar), why
  ['akatosh', 'magicka', 0.003, 'MagickaRateMult +10: a tenth of the Nord\'s 3% a second'],
  ['hircine', 'stamina', 0.10, 'StaminaRate +10: 10% a second on top of 5%, three times the stamina regeneration'],
  ['meridia', 'health', 0.00175, 'HealRateMult +25: a quarter of the Nord\'s 0.7% a second'],
  ['wormcult', 'magicka', 0.03, 'MagickaRateMult +100 (an Ability): the Nord\'s 3% a second again'],
  ['hist', 'health', 0.0035, 'blessingRegen HealRateMult +50: half the Nord\'s 0.7% a second'],
  ['yokudan', 'stamina', 0.05, 'blessingRegen StaminaRateMult +100: the Nord\'s 5% a second again'],
];
const table = [];
for (const [deity, stat, perSec, why] of RATES) {
  bless(deity);
  const held = globalThis.__dboBlessingRegen(ACTOR);
  const rate = held.filter((e) => e.stat === stat).reduce((n, e) => n + e.perSecond, 0);
  check(`${deity}: the server's own rate is ${perSec} of the ${stat} bar a second (${why})`, near(rate, perSec), rate);
  // From a tenth of the bar, for 20 s or as long as it takes to fill most of it
  const secs = Math.min(20, Math.floor(0.8 / perSec));
  const got = gained(deity, stat, secs, 0.1);
  const others = ['health', 'magicka', 'stamina'].filter((s) => s !== stat).every((s) => near(pc()[s], 0.1));
  check(`${deity}: ${secs} s of the blessing raise ${stat} by ${(perSec * secs).toFixed(4)} on the server, and nothing else`, near(got, perSec * secs, 1e-4) && others, got.toFixed(5));
  // and after it: the blessing ends, the tick adds nothing
  wallClock += 9 * H;
  setPc(0.5, 0.5, 0.5); out.sets.length = 0;
  run(5);
  check(`${deity}: once the blessing has run out, nothing more is added`, out.sets.length === 0 && near(pc()[stat], 0.5), JSON.stringify(pc()));
  table.push([deity, stat, perSec, secs, got]);
}

// ---- the rest of the rule ------------------------------------------------------------------------------------------
check('a blessing with no rate effect (Julianos, Magicka +25) adds nothing', (() => { const g = gained('julianos', 'magicka', 10); return near(g, 0) && out.sets.length === 0; })());
check('nor does a blessing the server cleared', (() => { bless('akatosh'); props.delete(ACTOR + '|private.dboBlessing'); setPc(0.5, 0.5, 0.5); out.sets.length = 0; run(5); return out.sets.length === 0; })());
check('a slow boon waits for a whole step (minStep 0.002): Meridia\'s 0.00175 a second is sent every second tick',
  (() => { bless('meridia'); setPc(0.5, 0.5, 0.5); out.sets.length = 0; run(1); const one = out.sets.length; run(1); return one === 0 && out.sets.length === 1 && near(pc().health, 0.5035); })());
check('a full bar is left alone', (() => { bless('hircine'); setPc(0.5, 0.5, 1); out.sets.length = 0; run(5); return out.sets.length === 0 && pc().stamina === 1; })());
check('and the last step stops at full', (() => { bless('hircine'); setPc(0.5, 0.5, 0.97); run(1); return pc().stamina === 1; })());
check('nothing for the dead', (() => { bless('hircine'); setPc(0, 0.5, 0.5); out.sets.length = 0; run(3); return out.sets.length === 0; })());
globalThis.__dboIsDowned = () => true;
check('nor for the downed', (() => { bless('hircine'); setPc(0.5, 0.5, 0.5); out.sets.length = 0; run(3); return out.sets.length === 0; })());
delete globalThis.__dboIsDowned;
globalThis.__dboChillRateMult = (a, av) => (av === 'StaminaRateMult' ? 0.5 : 1);
check('Death\'s Chill slows it by its own factor for that bar (downed.js): half', near(gained('hircine', 'stamina', 10), 0.5, 1e-4));
globalThis.__dboChillRateMult = (a, av) => (av === 'StaminaRateMult' ? 0 : 1);
check('and stops it at the chill\'s cap (factor 0)', near(gained('hircine', 'stamina', 10), 0));
delete globalThis.__dboChillRateMult;
check('a long stall pays at most three ticks', (() => { bless('hircine'); setPc(0.2, 0.2, 0.2); run(1); wallClock += 60000; timers.get('prayerBlessingRegen').fn(); return near(pc().stamina, 0.2 + 0.1 + 0.3, 1e-6); })());
bless('testgod');
check('only boosts count: a detrimental or hostile rate effect is left out, a plain Value Modifier is in',
  (() => { const h = globalThis.__dboBlessingRegen(ACTOR); return h.length === 1 && h[0].av === 'StaminaRateMult' && near(h[0].perSecond, 0.01); })(), JSON.stringify(globalThis.__dboBlessingRegen(ACTOR)));
props.set(ACTOR + '|private.dboBlessing', { deity: 'hist', spell: 0xe40d5, until: wallClock + H, via: 'spell' });
check('a Hist blessing from before (Histskin\'s record) runs the Hist\'s boon of today, not the power\'s HealRate +10',
  (() => { const h = globalThis.__dboBlessingRegen(ACTOR); return h.length === 1 && h[0].av === 'HealRateMult' && near(h[0].perSecond, 0.0035); })(), JSON.stringify(globalThis.__dboBlessingRegen(ACTOR)));
props.set(ACTOR + '|appearance', { raceId: 0x13748 });
check('the race\'s own rate is read from its record: twice the rate, twice the Mult boon', (() => { bless('akatosh'); return near(globalThis.__dboBlessingRegen(ACTOR)[0].perSecond, 0.006); })());
check('a rate effect does not depend on the race', (() => { bless('hircine'); return near(globalThis.__dboBlessingRegen(ACTOR)[0].perSecond, 0.10); })());
props.set(ACTOR + '|appearance', { raceId: 0x99999 });
check('a race the server cannot read falls back to the vanilla rates', (() => { bless('akatosh'); return near(globalThis.__dboBlessingRegen(ACTOR)[0].perSecond, 0.003); })());
props.set(ACTOR + '|appearance', { raceId: NORD });
settings = { regenerationMultiplier: 2 };
load();
check('the server\'s regenerationMultiplier scales it as the crop is scaled', (() => { bless('akatosh'); return near(globalThis.__dboBlessingRegen(ACTOR)[0].perSecond, 0.006); })()
  && /regenerationMultiplier 2/.test(out.logs.find((l) => /regeneration held/.test(l)) || ''));
settings = {};
api.cfg = { prayer: { blessingRegen: { enabled: false } } };
load();
check('config can turn the tick off (the timer stays registered, so a reload replaces a running one)', /\(off\)/.test(out.logs.find((l) => /regeneration held/.test(l)) || '')
  && (() => { bless('hircine'); setPc(0.5, 0.5, 0.5); out.sets.length = 0; run(3); return timers.has('prayerBlessingRegen') && out.sets.length === 0; })());
api.cfg = {};
load();
online = [];
bless('hircine'); globalThis.__dboBlessingRegenOwed.set(ACTOR, { at: wallClock, health: 0, magicka: 0, stamina: 0.001 });
run(1);
check('an offline worshipper is dropped from the tick', !globalThis.__dboBlessingRegenOwed.has(ACTOR));
online = [ACTOR];

// 5 Oct (#bugs 1556641893054681179): just after a cast the server's bars predate the spell; a write then refunded it
globalThis.__dboCastHeld = (a, now) => a === ACTOR && now - castAt < 3000;
let castAt = wallClock;
check('no blessing write for castHoldSeconds after the worshipper\'s cast (racial.js castHeld): the spell stays paid',
  (() => { bless('hircine'); setPc(0.5, 0.2, 0.5); castAt = wallClock + 1; out.sets.length = 0; run(2); return out.sets.length === 0 && near(pc().magicka, 0.2); })());
check('...and the blessing runs again once the hold is over', (() => { run(2); return out.sets.length > 0 && pc().stamina > 0.5; })());
delete globalThis.__dboCastHeld;

console.log('');
console.log('deity      bar      server rate/s   during the blessing   after it ends');
for (const [deity, stat, perSec, secs, got] of table) console.log(`${deity.padEnd(10)} ${stat.padEnd(8)} ${String(perSec).padEnd(15)} +${got.toFixed(4)} in ${String(secs).padEnd(2)} s    +0`);
Date.now = realNow;
console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
