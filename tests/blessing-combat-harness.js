// Scripted test for the blessing damage multipliers in server\gamemode.js (BLESS_COMBAT .. blessingDamageMult).
// The block is lifted out of gamemode.js and run against mock records and blessings. Run it from this folder's
// parent with
//
//   node tests\blessing-combat-harness.js
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const a = src.indexOf('const BLESS_COMBAT'), b = src.indexOf('// The server\'s hit formula counts only');
if (a < 0 || b < a) { console.log('FAIL block not found'); process.exit(1); }

const WEAP = (anim) => ({ record: { type: 'WEAP', fields: [{ type: 'DNAM', data: Uint8Array.from([anim, 0, 0, 0]) }] } });
const records = { 0x100: WEAP(1), 0x101: WEAP(5), 0x102: WEAP(7), 0x103: WEAP(9), 0x104: WEAP(6), 0x200: { record: { type: 'SPEL', fields: [] } } };
const SWORD = 0x100, GREATSWORD = 0x101, BOW = 0x102, CROSSBOW = 0x103, WARHAMMER = 0x104, FIREBOLT = 0x200, FIST = 0x1f4;
// The element is the MGEF DATA resist value (i32 at 16): 41 FireResist, 43 FrostResist; -1 none
const u32le = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const MGEF = (resist) => { const d = new Array(152).fill(0); u32le(resist >>> 0).forEach((b, i) => { d[16 + i] = b; }); return { record: { type: 'MGEF', fields: [{ type: 'DATA', data: Uint8Array.from(d) }] } }; };
const withEffects = (type, ...mgefs) => ({ record: { type, fields: mgefs.flatMap((m) => [{ type: 'EFID', data: Uint8Array.from(u32le(m)) }, { type: 'EFIT', data: Uint8Array.from(new Array(12).fill(0)) }]) } });
Object.assign(records, { 0x301: MGEF(41), 0x302: MGEF(43), 0x303: MGEF(-1),
  0x210: withEffects('SPEL', 0x301), 0x211: withEffects('SPEL', 0x302), 0x212: withEffects('ENCH', 0x301), 0x213: withEffects('SPEL', 0x303, 0x301), 0x214: withEffects('SPEL', 0x303) });
const FLAMES = 0x210, ICE_SPIKE = 0x211, FIRE_STAFF = 0x212, FIRE_BREATH = 0x213, PARALYZE = 0x214;
let now = 1790000000000;
const blessings = {};
const mp = { get: (id, k) => (k === 'private.dboBlessing' ? blessings[id] : undefined) };
const recordOf = (id) => records[id] || null;
const cfg = {};
const Date2 = { now: () => now };
const fn = new Function('mp', 'recordOf', 'cfg', 'Date', src.slice(a, b) + '\nreturn blessingDamageMult;');
const mult = fn(mp, recordOf, cfg, Date2);

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${got !== undefined ? '   ' + got : ''}`); if (!ok) failures++; };
const near = (x, y) => Math.abs(x - y) < 1e-9;
const bless = (id, deity, hours = 1) => { blessings[id] = { deity, spell: 1, until: now + hours * 3600000 }; };
const A = 1, T = 2;

check('no blessings, no change', near(mult(A, T, SWORD), 1));
bless(A, 'talos');
check('Talos: greatsword +10%', near(mult(A, T, GREATSWORD), 1.1));
check('Talos: warhammer +10%', near(mult(A, T, WARHAMMER), 1.1));
check('Talos: a one-handed sword unchanged', near(mult(A, T, SWORD), 1));
check('Talos: a spell unchanged', near(mult(A, T, FIREBOLT), 1));
bless(A, 'boethiah');
check('Boethiah: one-handed +10%, two-handed unchanged', near(mult(A, T, SWORD), 1.1) && near(mult(A, T, GREATSWORD), 1));
bless(A, 'auriel');
check('Auri-El: bows and crossbows +10%', near(mult(A, T, BOW), 1.1) && near(mult(A, T, CROSSBOW), 1.1) && near(mult(A, T, SWORD), 1));
bless(A, 'malacath');
check('Malacath: every weapon +10%, not fists or spells', near(mult(A, T, SWORD), 1.1) && near(mult(A, T, BOW), 1.1) && near(mult(A, T, FIST), 1) && near(mult(A, T, FIREBOLT), 1));
bless(A, 'mehrunes');
check('Mehrunes Dagon: spells +10%, weapons unchanged', near(mult(A, T, FIREBOLT), 1.1) && near(mult(A, T, SWORD), 1));
delete blessings[A];
bless(T, 'azura');
check('Azura on the target: spells -10%, weapons unchanged', near(mult(A, T, FIREBOLT), 0.9) && near(mult(A, T, SWORD), 1));
bless(T, 'trinimac');
check('Trinimac on the target: spells -25%', near(mult(A, T, FIREBOLT), 0.75));
bless(A, 'mehrunes');
check('both at once multiply: 1.1 x 0.75', near(mult(A, T, FIREBOLT), 1.1 * 0.75));
delete blessings[A];
bless(T, 'ancestors');
check('the Ancestors on the target: fire -25% (a fire spell, a fire enchantment, a spell with fire among its effects)',
  near(mult(A, T, FLAMES), 0.75) && near(mult(A, T, FIRE_STAFF), 0.75) && near(mult(A, T, FIRE_BREATH), 0.75));
check('the Ancestors: frost, a spell with no element, weapons and fists unchanged',
  near(mult(A, T, ICE_SPIKE), 1) && near(mult(A, T, PARALYZE), 1) && near(mult(A, T, FIREBOLT), 1) && near(mult(A, T, SWORD), 1) && near(mult(A, T, FIST), 1));
bless(A, 'mehrunes');
check('Mehrunes Dagon\'s fire into the Ancestors\' ward: 1.1 x 0.75', near(mult(A, T, FLAMES), 1.1 * 0.75));
delete blessings[T];
check('the Ancestors\' ward is the target\'s, not the attacker\'s', (() => { bless(A, 'ancestors'); return near(mult(A, T, FLAMES), 1); })());
bless(A, 'talos', -1);
check('an expired blessing does nothing', near(mult(A, T, GREATSWORD), 1));
bless(A, 'akatosh'); delete blessings[T];
check('a blessing with no combat rule does nothing', near(mult(A, T, GREATSWORD), 1));
cfg.blessingCombat = { enabled: false };
const off = fn(mp, recordOf, cfg, Date2);
bless(A, 'talos');
check('config can turn it off', near(off(A, T, GREATSWORD), 1));

console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
