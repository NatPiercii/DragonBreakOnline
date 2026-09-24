// Scripted test for the arrow share of a bow hit in server\gamemode.js (arrowDamageMult). No server and no
// game: run it from this folder's parent with
//
//   node tests\arrow-damage-harness.js
//
// It lifts the same block as tests\mastery-damage-harness.js and feeds it record bytes laid out as
// Skyrim.esm has them (read from /opt/skyrim-data/Skyrim.esm on 2026-09-24): WEAP DATA is value u32,
// weight f32, damage u16 (GlassBow 15, HuntingBow 7) and AMMO DATA is projectile u32, flags u32,
// damage f32, value u32, weight f32 (IronArrow 8, GlassArrow 18, DaedricArrow 24).
'use strict';
const fs = require('fs');
const path = require('path');

const GAMEMODE = path.join(path.resolve(__dirname, '..'), 'gamemode.js');
const START = '// ---- mastery: the combat tiers reach the damage the target takes';
const END = '// Combat adjudication and damage clamp';
const src = fs.readFileSync(GAMEMODE, 'utf8');
const from = src.indexOf(START), to = src.indexOf(END);
if (from < 0 || to < 0) { console.error('mastery block markers not found in gamemode.js'); process.exit(1); }
const block = src.slice(from, to);

const GLASS_BOW = 0x139a5, HUNTING_BOW = 0x13985, IRON_SWORD = 0x12eb7;
const IRON_ARROW = 0x1397d, GLASS_ARROW = 0x139be, DAEDRIC_ARROW = 0x139c0, ROBE = 0x12345;
const weapData = (damage) => { const b = new DataView(new ArrayBuffer(10)); b.setUint32(0, 50, true); b.setFloat32(4, 7, true); b.setUint16(8, damage, true); return new Uint8Array(b.buffer); };
const ammoData = (damage) => { const b = new DataView(new ArrayBuffer(20)); b.setUint32(0, 0x3be11, true); b.setUint32(4, 4, true); b.setFloat32(8, damage, true); b.setUint32(12, 1, true); return new Uint8Array(b.buffer); };
const records = {
  [GLASS_BOW]: { type: 'WEAP', fields: [{ type: 'DNAM', data: Uint8Array.from([7, 0, 0]) }, { type: 'DATA', data: weapData(15) }] },
  [HUNTING_BOW]: { type: 'WEAP', fields: [{ type: 'DNAM', data: Uint8Array.from([7, 0, 0]) }, { type: 'DATA', data: weapData(7) }] },
  [IRON_SWORD]: { type: 'WEAP', fields: [{ type: 'DNAM', data: Uint8Array.from([1, 0, 0]) }, { type: 'DATA', data: weapData(7) }] },
  [IRON_ARROW]: { type: 'AMMO', fields: [{ type: 'DATA', data: ammoData(8) }] },
  [GLASS_ARROW]: { type: 'AMMO', fields: [{ type: 'DATA', data: ammoData(18) }] },
  [DAEDRIC_ARROW]: { type: 'AMMO', fields: [{ type: 'DATA', data: ammoData(24) }] },
  [ROBE]: { type: 'ARMO', fields: [] },
};
const worn = new Map();
const mp = {
  lookupEspmRecordById: (id) => (records[id] ? { record: records[id] } : null),
  get: (id, prop) => {
    if (prop === 'equipment') return { inv: { entries: (worn.get(id) || []).map((baseId) => ({ baseId, count: 1, worn: true })) } };
    throw new Error(`unexpected get ${prop}`);
  },
};
const fieldsOf = (lr, type) => ((lr && lr.record && lr.record.fields) || []).filter((f) => f.type === type && f.data instanceof Uint8Array);
const wornOf = (equipment) => { const entries = equipment && equipment.inv && Array.isArray(equipment.inv.entries) ? equipment.inv.entries : []; return entries.filter((e) => e && (e.worn || e.wornLeft)).map((e) => ({ baseId: Number(e.baseId) >>> 0, left: !!e.wornLeft })); };
const recordOf = (id) => { try { const r = mp.lookupEspmRecordById(id >>> 0); return r && r.record ? r : null; } catch (e) { return null; } };

const load = (cfg) => {
  delete globalThis.__dboRecordDamage;
  delete globalThis.__dboWeaponSkill;
  return new Function('mp', 'cfg', 'log', 'display', 'recordOf', 'masteryOf', 'fieldsOf', 'wornOf',
    block + '\nreturn { arrowDamageMult };')(mp, cfg, () => {}, String, recordOf, () => null, fieldsOf, wornOf);
};

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  if (Math.abs(Number(got) - Number(want)) < 1e-6) pass++;
  else { fail++; console.log(`  FAIL ${name}: got ${got}, want ${want}`); }
};
const A = 0xff000001;
console.log('arrow damage harness');

let M = load({});
worn.set(A, [GLASS_BOW, GLASS_ARROW]);
ok('glass bow + glass arrow = (15 + 18) / 15', M.arrowDamageMult(A, GLASS_BOW), 33 / 15);
worn.set(A, [HUNTING_BOW, IRON_ARROW, ROBE]);
ok('hunting bow + iron arrow = (7 + 8) / 7', M.arrowDamageMult(A, HUNTING_BOW), 15 / 7);
worn.set(A, [GLASS_BOW, DAEDRIC_ARROW]);
ok('glass bow + daedric arrow = (15 + 24) / 15', M.arrowDamageMult(A, GLASS_BOW), 39 / 15);
worn.set(A, [GLASS_BOW]);
ok('no arrow worn: unchanged', M.arrowDamageMult(A, GLASS_BOW), 1);
worn.set(A, [IRON_SWORD, IRON_ARROW]);
ok('a sword hit ignores the quiver', M.arrowDamageMult(A, IRON_SWORD), 1);
ok('unknown weapon: unchanged', M.arrowDamageMult(A, 0xdead), 1);
ok('no equipment readable: unchanged', M.arrowDamageMult(0xff0000ee, GLASS_BOW), 1);

M = load({ arrows: { scale: 0.5 } });
worn.set(A, [GLASS_BOW, GLASS_ARROW]);
ok('scale 0.5 halves the arrow share', M.arrowDamageMult(A, GLASS_BOW), 1 + 9 / 15);
M = load({ arrows: { enabled: false } });
ok('disabled: unchanged', M.arrowDamageMult(A, GLASS_BOW), 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
