// craftedExtrasSystem credits the skill behind an accepted bench change (fork client-enchanter-credit): an enchantment
// is Enchanter work weighed by the soul spent, a temper Blacksmith work weighed by the steps it rose, both through
// masterySystem's award (the Wheel's limits). Enchanting never reached Enchanter before: it is no COBJ craft, so the
// onCraft credit never saw it, and Enchanter stayed where it was taken up (Worker G, 2026-09-30).
//
//   node tests/crafted-credit-harness.js <bundled craftedExtrasSystem.js>
//
// A craftedExtrasSystem without the credit has nothing to test, which is said and not failed.
'use strict';
const fs = require('fs');
const path = require('path');

const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests/crafted-credit-harness.js <bundled craftedExtrasSystem.js>'); process.exit(2); }
if (!/creditWork/.test(fs.readFileSync(bundle, 'utf8'))) { console.log('ok   skipped: this craftedExtrasSystem credits no skill'); process.exit(0); }
const { CraftedExtrasSystem } = require(path.resolve(bundle));

let fails = 0;
const ok = (label, cond, got) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && got !== undefined ? `: got ${JSON.stringify(got)}` : ''}`); if (!cond) fails++; };

// ---- a small load order ----
const u32 = (...v) => { const b = new Uint8Array(v.length * 4); const d = new DataView(b.buffer); v.forEach((x, i) => d.setUint32(i * 4, x >>> 0, true)); return b; };
const f32at = (len, pairs) => { const b = new Uint8Array(len); const d = new DataView(b.buffer); for (const [off, v, t] of pairs) t === 'f' ? d.setFloat32(off, v, true) : d.setUint32(off, v >>> 0, true); return b; };
const ENCHANTER_BASE = 0x000bad0d, GRINDSTONE_BASE = 0x00088108, KW_GRINDSTONE = 0x00088105;
const DAGGER = 0x0001397e, INGOT = 0x0005ace4, PETTY = 0x0002e4e2, COMMON = 0x0002e4e6, GRAND = 0x0002e4fc;
const ENCH = 0x0004605a, MGEF = 0x0004605b, TEMPER = 0x0000c0b1;
const RECORDS = {
  [ENCHANTER_BASE]: { type: 'FURN', fields: [{ type: 'WBDT', data: new Uint8Array([3, 0]) }] },
  [GRINDSTONE_BASE]: { type: 'FURN', fields: [{ type: 'WBDT', data: new Uint8Array([2, 0]) }, { type: 'KWDA', data: u32(KW_GRINDSTONE) }] },
  [DAGGER]: { type: 'WEAP', fields: [] },
  [INGOT]: { type: 'MISC', fields: [] },
  [PETTY]: { type: 'SLGM', fields: [{ type: 'SOUL', data: new Uint8Array([1]) }] },
  [COMMON]: { type: 'SLGM', fields: [{ type: 'SOUL', data: new Uint8Array([3]) }] },
  [GRAND]: { type: 'SLGM', fields: [{ type: 'SOUL', data: new Uint8Array([5]) }] },
  // a weapon enchantment (fire and forget, contact, type Enchantment) of one effect, magnitude 10
  [ENCH]: { type: 'ENCH', fields: [{ type: 'ENIT', data: f32at(24, [[8, 1], [16, 1], [20, 6]]) }, { type: 'EFID', data: u32(MGEF) }, { type: 'EFIT', data: f32at(12, [[0, 10, 'f'], [4, 0], [8, 0]]) }] },
  [MGEF]: { type: 'MGEF', fields: [{ type: 'DATA', data: f32at(8, [[4, 1, 'f']]) }] },
  // the grindstone tempers the dagger for one iron ingot
  [TEMPER]: { type: 'COBJ', fields: [{ type: 'CNAM', data: u32(DAGGER) }, { type: 'BNAM', data: u32(KW_GRINDSTONE) }, { type: 'CNTO', data: u32(INGOT, 1) }] },
};
const ENCHANTER = 0xff00a001, GRINDSTONE = 0xff00a002, ACTOR = 0xff000030, USER = 5, CELL = '3c:Skyrim.esm';
const props = new Map();
const sent = [];
const mp = {
  get: (id, key) => {
    if (id === ENCHANTER || id === GRINDSTONE) {
      if (key === 'worldOrCellDesc') return CELL;
      if (key === 'pos') return [100, 0, 0];
      if (key === 'baseDesc') return `${(id === ENCHANTER ? ENCHANTER_BASE : GRINDSTONE_BASE).toString(16)}:Skyrim.esm`;
    }
    if (id === ACTOR && key === 'worldOrCellDesc') return CELL;
    const v = props.get(`${id >>> 0}:${key}`);
    return v === undefined ? undefined : JSON.parse(v);
  },
  set: (id, key, value) => props.set(`${id >>> 0}:${key}`, JSON.stringify(value)),
  getActorPos: () => [0, 0, 0],
  getUserActor: () => ACTOR,
  getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16) >>> 0,
  lookupEspmRecordById: (id) => (RECORDS[id >>> 0] ? { record: RECORDS[id >>> 0], toGlobalRecordId: (x) => x >>> 0 } : null),
  getEspmRecordIdsByType: (type) => Object.keys(RECORDS).map(Number).filter((id) => RECORDS[id].type === type),
  sendCustomPacket: (u, s) => sent.push(JSON.parse(s)),
};
const ctx = { svr: mp };
const logs = [];
const sys = new CraftedExtrasSystem((m) => logs.push(String(m)));

const awards = [];
globalThis.__alduinakMasteryAward = (actorId, skill, weight, key) => { awards.push({ actorId: actorId >>> 0, skill, weight, key: key >>> 0 }); return 1; };
const mastery = (skills) => mp.set(ACTOR, 'private.mastery', { v: 2, order: Object.keys(skills), skills: Object.fromEntries(Object.entries(skills).map(([k, r]) => [k, { level: 1 + r * 25, xp: 0, rank: r }])) });
const inventory = (entries) => mp.set(ACTOR, 'inventory', { entries: entries.map(([baseId, count, extra]) => Object.assign({ baseId, count }, extra || {})) });
const effect = { effectId: MGEF, magnitude: 10, area: 0, duration: 0, cost: 12 };
const enchantReport = (gem, bench = ENCHANTER) => ({ workbench: bench, gained: [{ baseId: DAGGER, count: 1, enchantmentEffects: [effect] }], lost: [{ baseId: DAGGER, count: 1 }].concat(gem ? [{ baseId: gem, count: 1 }] : []) });
const temperReport = (health) => ({ workbench: GRINDSTONE, gained: [{ baseId: DAGGER, count: 1, health }], lost: [{ baseId: DAGGER, count: 1 }, { baseId: INGOT, count: 1 }] });
const run = (report) => { awards.length = 0; sent.length = 0; sys.onReport(ctx, USER, report); return awards.slice(); };
const daggerNow = () => mp.get(ACTOR, 'inventory').entries.find((e) => e.baseId === DAGGER) || {};

// ---- an enchantment ----
mastery({ enchanter: 0, blacksmith: 0 });
inventory([[DAGGER, 1], [COMMON, 1], [INGOT, 2]]);
let a = run(enchantReport(COMMON));
ok('an accepted enchantment is Enchanter work, once, keyed on the item', a.length === 1 && a[0].skill === 'enchanter' && a[0].actorId === ACTOR && a[0].key === DAGGER, a);
ok('...weighed by the soul spent: a common soul (3) is 2.2 units', a.length === 1 && Math.abs(a[0].weight - 2.2) < 1e-9, a);
ok('...and the enchantment itself is kept, as before', Array.isArray(daggerNow().enchantmentEffects) && !sent.some((p) => p.customPacketType === 'craftedExtrasRefused'), [daggerNow(), sent]);

inventory([[DAGGER, 1], [PETTY, 1]]);
a = run(enchantReport(PETTY));
ok('a petty soul (1) is 1.4 units', a.length === 1 && Math.abs(a[0].weight - 1.4) < 1e-9, a);
inventory([[DAGGER, 1], [GRAND, 1]]);
a = run(enchantReport(GRAND));
ok('a grand soul (5) is the most an act is worth, 3 units', a.length === 1 && Math.abs(a[0].weight - 3) < 1e-9, a);

// ---- what is refused earns nothing ----
inventory([[DAGGER, 1], [COMMON, 1]]);
a = run(enchantReport(null));
ok('no soul spent: refused, no credit', a.length === 0 && sent.some((p) => p.customPacketType === 'craftedExtrasRefused'), [a, sent]);
inventory([[DAGGER, 1], [COMMON, 1]]);
a = run(enchantReport(COMMON, GRINDSTONE));
ok('an enchantment claimed at a grindstone: refused, no credit', a.length === 0, a);
inventory([[DAGGER, 1], [COMMON, 1]]);
a = run(enchantReport(COMMON, 0));
ok('an enchantment with no bench behind it: refused, no credit', a.length === 0, a);
mastery({ blacksmith: 0 });
inventory([[DAGGER, 1], [COMMON, 1]]);
a = run(enchantReport(COMMON));
ok('someone who is not an Enchanter: refused, no credit', a.length === 0, a);

// ---- tempering ----
mastery({ enchanter: 0, blacksmith: 1 });
inventory([[DAGGER, 1], [INGOT, 2]]);
a = run(temperReport(1.1));
ok('an accepted temper is Blacksmith work, keyed on the item', a.length === 1 && a[0].skill === 'blacksmith' && a[0].key === DAGGER, a);
ok('...one step up is 1 unit', a.length === 1 && Math.abs(a[0].weight - 1) < 1e-9, a);
inventory([[DAGGER, 1], [INGOT, 2]]);
a = run(temperReport(1.3));
ok('three steps up is 2 units', a.length === 1 && Math.abs(a[0].weight - 2) < 1e-9, a);
inventory([[DAGGER, 1]]);
a = run(temperReport(1.1));
ok('a temper without its ingot: refused, no credit', a.length === 0, a);
mastery({ enchanter: 0 });
inventory([[DAGGER, 1], [INGOT, 2]]);
a = run(temperReport(1.1));
ok('someone who is not a Blacksmith cannot temper, and earns nothing', a.length === 0, a);

// ---- charge and poison changes are not bench work ----
mastery({ enchanter: 0, blacksmith: 0 });
inventory([[DAGGER, 1, { enchantmentEffects: [effect], maxCharge: 1000, chargePercent: 900 }]]);
a = run({ workbench: 0, gained: [{ baseId: DAGGER, count: 1, enchantmentEffects: [effect], maxCharge: 1000, chargePercent: 500 }], lost: [{ baseId: DAGGER, count: 1, enchantmentEffects: [effect], maxCharge: 1000, chargePercent: 900 }] });
ok('a weapon charge spent in a fight is accepted and credits nothing', a.length === 0 && (daggerNow().chargePercent === 500), [a, daggerNow()]);

// ---- the award is optional and cannot break a report ----
delete globalThis.__alduinakMasteryAward;
mastery({ enchanter: 0, blacksmith: 0 });
inventory([[DAGGER, 1], [COMMON, 1]]);
let threw = false; try { sys.onReport(ctx, USER, enchantReport(COMMON)); } catch (e) { threw = true; }
ok('without masterySystem\'s award the enchantment still lands', !threw && Array.isArray(daggerNow().enchantmentEffects));
globalThis.__alduinakMasteryAward = () => { throw new Error('boom'); };
inventory([[DAGGER, 1], [COMMON, 1]]);
threw = false; try { sys.onReport(ctx, USER, enchantReport(COMMON)); } catch (e) { threw = true; }
ok('an award that throws is logged, and the enchantment still lands', !threw && Array.isArray(daggerNow().enchantmentEffects) && logs.some((l) => /skill credit failed/.test(l)), logs.slice(-2));

console.log(fails ? `${fails} failure(s)` : 'all checks passed');
process.exit(fails ? 1 : 0);
