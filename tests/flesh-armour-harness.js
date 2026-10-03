// Scripted test for the Flesh spells' armour in server\gamemode.js (fleshOfSpell .. fleshDamageMult; Nate, 3 Oct 2026:
// Oakflesh and the later Flesh spells must count server-side). The block is lifted out of gamemode.js and run against
// mock records shaped like the live ones (Skyrim.esm Oakflesh 5ad5c: ArmorFFSelf0 40 for 60 s, plus three HideInUI perk
// riders; Ironflesh 80; a ward, a concentration spell; a hostile effect). Run it from this folder's parent with
//
//   node tests/flesh-armour-harness.js
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const a = src.indexOf("// Alteration's Flesh spells"), b = src.indexOf('// A werewolf in beast form hits harder');
if (a < 0 || b < a) { console.log('FAIL block not found'); process.exit(1); }

const u32le = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const f32le = (x) => { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, x, true); return [0, 1, 2, 3].map((i) => d.getUint8(i)); };
const field = (type, bytes) => ({ type, data: Uint8Array.from(bytes) });
// MGEF DATA: flags at 0, archetype at 0x40, actor value at 0x44 (libespm MGEF.cpp)
const MGEF = (flags, archetype, av) => { const d = new Array(152).fill(0); u32le(flags).forEach((x, i) => { d[i] = x; }); u32le(archetype).forEach((x, i) => { d[0x40 + i] = x; }); u32le(av >>> 0).forEach((x, i) => { d[0x44 + i] = x; }); return { record: { type: 'MGEF', fields: [field('DATA', d)] }, toGlobalRecordId: (l) => l }; };
// SPIT: type at 0x08, cast type at 0x10, delivery at 0x14 (libespm SPEL.h, 36 bytes)
const SPEL = (type, cast, delivery, effects) => {
  const spit = new Array(36).fill(0); u32le(type).forEach((x, i) => { spit[8 + i] = x; }); u32le(cast).forEach((x, i) => { spit[16 + i] = x; }); u32le(delivery).forEach((x, i) => { spit[20 + i] = x; });
  return { record: { type: 'SPEL', fields: [field('SPIT', spit)].concat(...effects.map(([m, mag, dur]) => [field('EFID', u32le(m)), field('EFIT', [...f32le(mag), 0, 0, 0, 0, ...u32le(dur)])])) }, toGlobalRecordId: (l) => l };
};
const ARMOR0 = 0x100, PERK30 = 0x101, HOSTILE_DR = 0x102, HEALTH = 0x103, SHIELD = 0x104;
const records = {
  [ARMOR0]: MGEF(0, 34, 39), [PERK30]: MGEF(0x8000, 34, 39), [HOSTILE_DR]: MGEF(0x4, 34, 39), [HEALTH]: MGEF(0, 0, 24), [SHIELD]: MGEF(0, 34, 39),
  0x5ad5c: SPEL(0, 1, 0, [[ARMOR0, 40, 60], [PERK30, 40, 60], [PERK30, 20, 60], [PERK30, 20, 60]]), // Oakflesh
  0x51b16: SPEL(0, 1, 0, [[ARMOR0, 80, 60], [PERK30, 80, 60]]),                                    // Ironflesh
  0x13018: SPEL(0, 2, 0, [[SHIELD, 40, 0]]),                                                       // Lesser Ward: concentration
  0x0cdb70: SPEL(0, 1, 0, [[ARMOR0, 0, 30]]),                                                      // Dragonhide: magnitude 0
  0x200: SPEL(0, 1, 1, [[ARMOR0, 50, 60]]),                                                        // aimed, not self
  0x201: SPEL(0, 1, 0, [[HOSTILE_DR, 50, 60]]),                                                    // a detrimental armour effect
  0x202: SPEL(4, 0, 0, [[ARMOR0, 100, 0]]),                                                        // an ability
  0x203: SPEL(0, 1, 0, [[HEALTH, 50, 60]]),                                                        // Healing-like
  0x300: { record: { type: 'WEAP', fields: [] } }, 0x301: { record: { type: 'SPEL', fields: [] } }, 0x302: { record: { type: 'ARMO', fields: [] } },
};
const OAKFLESH = 0x5ad5c, IRONFLESH = 0x51b16, SWORD = 0x300, FIREBOLT = 0x301, FIST = 0x1f4, IRON_CUIRASS = 0x302;
let now = 1790000000000;
const Date2 = { now: () => now };
const recordOf = (id) => records[id] || null;
const fieldsOf = (lr, type) => ((lr && lr.record && lr.record.fields) || []).filter((f) => f.type === type && f.data instanceof Uint8Array);
const u32At = (f, off) => (f && f.data.byteLength >= off + 4 ? new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength).getUint32(off, true) : 0);
const globalAt = (lr, local) => { try { return local ? lr.toGlobalRecordId(local) >>> 0 : 0; } catch (e) { return 0; } };
const worn = {};
const wornWithHealth = (t) => worn[t] || [];
const armorPieceOf = (id) => (id === IRON_CUIRASS ? { rating: 25, counted: 25, heavy: true, chest: true } : null);
const temperBonus = () => 0;
let defense = { heavy: 1, light: 1 };
const defensePieceMult = () => defense;
const gmstFloat = (id, fb) => fb;
const g = {};
const fn = new Function('recordOf', 'fieldsOf', 'u32At', 'globalAt', 'wornWithHealth', 'armorPieceOf', 'temperBonus', 'defensePieceMult', 'gmstFloat', 'cfg', 'Date', 'globalThis',
  src.slice(a, b) + '\nreturn { fleshOfSpell, fleshCast, fleshArmorOf, fleshDamageMult };');
const F = fn(recordOf, fieldsOf, u32At, globalAt, wornWithHealth, armorPieceOf, temperBonus, defensePieceMult, gmstFloat, {}, Date2, g);

let fails = 0, n = 0;
const ok = (c, what, detail) => { n++; if (!c) fails++; console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${!c && detail !== undefined ? ': ' + JSON.stringify(detail) : ''}`); };
const near = (x, y) => Math.abs(x - y) < 1e-9;
const kept = (r) => 1 - Math.min(r * 0.12, 80) / 100;

ok(JSON.stringify(F.fleshOfSpell(OAKFLESH)) === '{"armor":40,"seconds":60}', 'Oakflesh: 40 armour for 60 s, the three HideInUI perk riders not counted', F.fleshOfSpell(OAKFLESH));
ok(F.fleshOfSpell(IRONFLESH).armor === 80, 'Ironflesh: 80');
ok(F.fleshOfSpell(0x13018) === null, 'a ward (concentration) is no Flesh spell');
ok(F.fleshOfSpell(0x0cdb70) === null, 'Dragonhide (magnitude 0 on its visible effect) adds nothing');
ok(F.fleshOfSpell(0x200) === null && F.fleshOfSpell(0x201) === null && F.fleshOfSpell(0x202) === null && F.fleshOfSpell(0x203) === null, 'aimed, detrimental, ability and non-armour spells are none');
ok(F.fleshOfSpell(SWORD) === null && F.fleshOfSpell(0x999) === null, 'a weapon or an unknown record is none');

const P = 0x14, Q = 0x15;
ok(F.fleshDamageMult(P, SWORD) === 1, 'no Flesh spell: no change');
F.fleshCast(P, OAKFLESH);
ok(F.fleshArmorOf(P) === 40, 'cast: the caster has 40 more armour');
ok(near(F.fleshDamageMult(P, SWORD), kept(40) / kept(0)), 'unarmoured, a sword hit keeps 95.2% (40 x 0.12%)', F.fleshDamageMult(P, SWORD));
ok(near(F.fleshDamageMult(P, FIST), kept(40)), '...a fist too');
ok(F.fleshDamageMult(P, FIREBOLT) === 1, '...a spell is not reduced by armour');
worn[P] = [{ baseId: IRON_CUIRASS, health: 1 }];
ok(near(F.fleshDamageMult(P, SWORD), kept(65) / kept(25)), 'over an iron cuirass (25): counted on top of the worn armour', F.fleshDamageMult(P, SWORD));
defense = { heavy: 2.5, light: 2.5 };
ok(near(F.fleshDamageMult(P, SWORD), kept(62.5 + 40) / kept(62.5)), '...Defense multiplies the worn armour, not the spell');
defense = { heavy: 1, light: 1 };
F.fleshCast(P, IRONFLESH);
ok(F.fleshArmorOf(P) === 80, 'a second Flesh spell replaces the first: 80, not 120');
F.fleshCast(P, 0x203);
ok(F.fleshArmorOf(P) === 80, 'another spell leaves it');
ok(F.fleshArmorOf(Q) === 0, 'it is the caster\'s only');
now += 59 * 1000;
ok(F.fleshArmorOf(P) === 80, '59 s later it still holds');
now += 2 * 1000;
ok(F.fleshArmorOf(P) === 0 && F.fleshDamageMult(P, SWORD) === 1, 'after 60 s it ends');
worn[P] = Array.from({ length: 30 }, () => ({ baseId: IRON_CUIRASS, health: 1 }));
F.fleshCast(P, OAKFLESH);
ok(F.fleshDamageMult(P, SWORD) === 1, 'at the armour cap (80%) it adds nothing more');
const g2 = {};
const F2 = fn(recordOf, fieldsOf, u32At, globalAt, wornWithHealth, armorPieceOf, temperBonus, defensePieceMult, gmstFloat, { fleshSpells: { enabled: false } }, Date2, g2);
F2.fleshCast(P, OAKFLESH);
ok(F2.fleshArmorOf(P) === 0, 'config fleshSpells.enabled false: nothing counts');
ok(/fleshDamageMult\(tgt, src\)/.test(src) && /__dboFleshCast\(Number\(casterId\) >>> 0, Number\(spellId\) >>> 0\)/.test(src), 'gamemode.js counts it in the hit\'s target side and notes it at the cast');

console.log(fails ? `${fails} of ${n} FAILED` : `all ${n} checks passed`);
process.exit(fails ? 1 : 0);
