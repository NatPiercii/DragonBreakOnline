// Scripted test for gearswap.js keeping enchantments (Nate, 4 Oct 2026: "keep enchantments on swapped gear") and the
// restore of the pieces it made plain on 3-4 Oct (gearswap-restore.json, tools/loot/gearswap_restore_plan.js).
// Real records from the live log: Ghazra's CYREnchAyleidBowShock02 -> HuntingBow, an EnchArmorElvenCuirassHealth03.
// Run from this folder's parent:  node tests/gearswap-enchant-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(SERVER, f), 'utf8'));
const G = require(path.join(SERVER, 'gearswap.js'));
const TIERS = require(path.join(SERVER, 'loottiers.js'))({ materials: readJson('loot-materials.json'), factionGear: readJson('faction-gear.json'), overrides: readJson('loot-overrides.json'), cfg: undefined });
const SWAP = readJson('gear-swap.json');

// Skyrim.esm is plugin 0, BSHeartland.esm plugin 8 on the server
const PLUG = { 0: 'Skyrim.esm', 8: 'BSHeartland.esm' };
const descOf = (id) => `${((id >>> 0) & 0xffffff).toString(16)}:${PLUG[(id >>> 0) >>> 24] || 'X.esp'}`;
const idOf = (desc) => { const m = /^([0-9a-f]+):(.+)$/i.exec(desc); if (!m) return 0; const top = Object.keys(PLUG).find((k) => PLUG[k] === m[2]); return top === undefined ? 0 : ((Number(top) << 24) | parseInt(m[1], 16)) >>> 0; };
const ID = {
  CYREnchAyleidBowShock02: 0x080d30dd, HuntingBow: 0x13985, EnchArmorElvenCuirassHealth03: 0xbdfc5, ArmorLeatherCuirass: 0x3619e,
  CYREnchAyleidDaggerShock02: 0x080d30e0, CYRSteelDagger: 0x08300056, GlassSword: 0x139a9, SteelSword: 0x13989, ElvenBow: 0x139b5,
  // the enchantments their EITM names (record-local in BSHeartland: master 0 is Skyrim.esm)
  EnchWeaponShockDamage02: 0x45d97, EnchArmorFortifyHealth03: 0xad462,
};
const EDID = Object.fromEntries(Object.entries(ID).map(([k, v]) => [v >>> 0, k]));
check('the map sends the Ayleid bow of arcing to a hunting bow and the Elven armour of major health to leather armour',
  SWAP.items['d30dd:bsheartland.esm'].toEdid === 'HuntingBow' && SWAP.items['bdfc5:skyrim.esm'].toEdid === 'ArmorLeatherCuirass');
check('loottiers puts both above the cap', ['d30dd:bsheartland.esm', 'bdfc5:skyrim.esm'].every((d) => { const c = TIERS.classOf(d); return c.kind === 'capped' || c.kind === 'never'; }));

// Records as mp.lookupEspmRecordById hands them back: fields with raw bytes, toGlobalRecordId for record-local ids
const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
const u16 = (v) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return b; };
const REC = {
  [ID.CYREnchAyleidBowShock02]: { type: 'WEAP', fields: [{ type: 'EITM', data: u32(0x00045d97) }, { type: 'EAMT', data: u16(1000) }], map: (l) => l },
  [ID.CYREnchAyleidDaggerShock02]: { type: 'WEAP', fields: [{ type: 'EITM', data: u32(0x00045d97) }, { type: 'EAMT', data: u16(1000) }], map: (l) => l },
  [ID.EnchArmorElvenCuirassHealth03]: { type: 'ARMO', fields: [{ type: 'EITM', data: u32(0x000ad462) }] },
  [ID.HuntingBow]: { type: 'WEAP', fields: [] }, [ID.ArmorLeatherCuirass]: { type: 'ARMO', fields: [] }, [ID.CYRSteelDagger]: { type: 'WEAP', fields: [] },
  [ID.GlassSword]: { type: 'WEAP', fields: [] }, [ID.SteelSword]: { type: 'WEAP', fields: [] }, [ID.ElvenBow]: { type: 'WEAP', fields: [] },
  [ID.EnchWeaponShockDamage02]: { type: 'ENCH', fields: [] }, [ID.EnchArmorFortifyHealth03]: { type: 'ENCH', fields: [] },
};
const recordOf = (id) => { const r = REC[id >>> 0]; return r ? { record: { type: r.type, editorId: EDID[id >>> 0] || '', fields: r.fields }, toGlobalRecordId: r.map || ((l) => l) } : null; };
const NAMES = { 'd30dd:bsheartland.esm': 'Ayleid Bow of Arcing', '13985:skyrim.esm': 'Hunting Bow', 'bdfc5:skyrim.esm': 'Elven Armor of Major Health', '3619e:skyrim.esm': 'Leather Armor',
  'd30e0:bsheartland.esm': 'Ayleid Dagger of Arcing', '300056:bsheartland.esm': 'Steel Dagger', '139a9:skyrim.esm': 'Glass Sword', '13989:skyrim.esm': 'Steel Sword' };
const nameOf = (d) => NAMES[String(d).toLowerCase()] || '';
// The runtime's enchantOf over the same records (gearswap.js builds its own from recordOf; this mirrors it for the pure tests)
const typeOf = (id) => (REC[id >>> 0] || {}).type || '';
const enchantOf = (id) => { const r = REC[id >>> 0]; const f = r && r.fields.find((x) => x.type === 'EITM'); if (!f) return null; const e = (r.map || ((l) => l))(new DataView(f.data.buffer).getUint32(0, true)); const a = r.fields.find((x) => x.type === 'EAMT'); return { enchantmentId: e, maxCharge: r.type === 'WEAP' && a ? new DataView(a.data.buffer).getUint16(0, true) : 0 }; };
const planOf = (entries, extra) => G.plan(Object.assign({ entries, descOf, classOf: TIERS.classOf, swap: SWAP, idOf, isArtifact: () => false, edidOf: (id) => EDID[id >>> 0] || '', enchantOf, typeOf, nameOf }, extra || {}));

// ---- 1. names ----
check('a record\'s name moves to the replacement: "Ayleid Bow of Arcing" on a hunting bow is "Hunting Bow of Arcing"', G.renamed('Ayleid Bow of Arcing', 'Hunting Bow') === 'Hunting Bow of Arcing');
check('...a player\'s own name without "of" is kept, a temper suffix is dropped', G.renamed('Grimbo\'s Pride', 'Steel Sword') === 'Grimbo\'s Pride' && G.renamed('Glass Sword of Fire (Fine)', 'Steel Sword') === 'Steel Sword of Fire');
check('...and no name at all leaves the replacement\'s own', G.renamed('', 'Steel Sword') === '');

// ---- 2. the swap keeps enchantments ----
let p = planOf([{ baseId: ID.CYREnchAyleidBowShock02, count: 1, chargePercent: 567.98 }, { baseId: ID.HuntingBow, count: 1 }], { worn: new Map([[ID.CYREnchAyleidBowShock02, 'right']]) });
let e = p.entries.find((x) => x.baseId === ID.HuntingBow && x.enchantmentId);
check('Ghazra\'s bow: the hunting bow carries the bow\'s own enchantment (EITM, mapped through toGlobalRecordId)', !!e && e.enchantmentId === ID.EnchWeaponShockDamage02, p.entries);
check('...with the record\'s charge (EAMT 1000) and the charge it had left', e && e.maxCharge === 1000 && Math.abs(e.chargePercent - 567.98) < 1e-6, e);
check('...named "Hunting Bow of Arcing"', e && e.name === 'Hunting Bow of Arcing', e);
check('...as its own entry: the plain hunting bow stays a plain stack of one', p.entries.some((x) => x.baseId === ID.HuntingBow && x.count === 1 && !x.enchantmentId && !x.name) && p.entries.filter((x) => x.baseId === ID.HuntingBow).length === 2, p.entries);
check('...the swap is marked as carried, still worn, and the Ayleid bow is gone', p.swaps[0].carried && p.swaps[0].worn && !p.entries.some((x) => x.baseId === ID.CYREnchAyleidBowShock02));
p = planOf([{ baseId: ID.CYREnchAyleidDaggerShock02, count: 1 }]);
e = p.entries[0];
check('an unused enchanted weapon gets no charge extra (a missing ExtraCharge is a full one)', e.baseId === ID.CYRSteelDagger && e.enchantmentId === ID.EnchWeaponShockDamage02 && e.maxCharge === 1000 && e.chargePercent === undefined && e.name === 'Steel Dagger of Arcing', e);
p = planOf([{ baseId: ID.CYREnchAyleidDaggerShock02, count: 1, chargePercent: 5000 }]);
check('a stored charge above the record\'s maximum is held to the maximum', p.entries[0].chargePercent === 1000, p.entries[0]);
p = planOf([{ baseId: ID.EnchArmorElvenCuirassHealth03, count: 1 }]);
e = p.entries[0];
check('the Elven armour of major health becomes leather armour of major health, no charge (armour enchantments have none)', e.baseId === ID.ArmorLeatherCuirass && e.enchantmentId === ID.EnchArmorFortifyHealth03 && e.maxCharge === undefined && e.name === 'Leather Armor of Major Health', e);
const effects = [{ effectId: 0x4605a, magnitude: 12.5, area: 0, duration: 1, cost: 40 }];
p = planOf([{ baseId: ID.GlassSword, count: 1, enchantmentEffects: effects, maxCharge: 1500, chargePercent: 800, name: 'Glass Sword of Fire' }]);
e = p.entries[0];
check('a player-made enchantment goes across as it was (effects, charge), renamed "Steel Sword of Fire"', e.baseId === ID.SteelSword && JSON.stringify(e.enchantmentEffects) === JSON.stringify(effects) && e.maxCharge === 1500 && e.chargePercent === 800 && e.name === 'Steel Sword of Fire', e);
check('...its effects are a copy, not the original\'s objects', e.enchantmentEffects[0] !== effects[0]);
p = planOf([{ baseId: ID.GlassSword, count: 1, health: 1.2 }]);
check('a tempered piece is not "enchanted": swapped as before, nothing carried', p.swaps[0].enchanted === false && !p.swaps[0].carried && p.entries[0].baseId === ID.SteelSword && !p.entries[0].health, p.swaps);
p = planOf([{ baseId: ID.CYREnchAyleidBowShock02, count: 1 }], { typeOf: (id) => (id === ID.HuntingBow ? 'ARMO' : typeOf(id)) });
check('an enchantment that cannot go on the replacement (another item type) keeps the piece as it is, never plain', p.swaps.length === 0 && p.skipped.enchanted === 1 && p.entries[0].baseId === ID.CYREnchAyleidBowShock02, p);
p = planOf([{ baseId: ID.CYREnchAyleidBowShock02, count: 1 }], { enchantOf: (id) => (id === ID.CYREnchAyleidBowShock02 ? { enchantmentId: ID.EnchWeaponShockDamage02, maxCharge: 0 } : null) });
check('...and so is a weapon whose enchantment has no charge (it would never fire)', p.swaps.length === 0 && p.skipped.enchanted === 1);
p = planOf([{ baseId: ID.CYREnchAyleidBowShock02, count: 1 }, { baseId: ID.CYREnchAyleidBowShock02, count: 1 }]);
check('two identical enchanted copies stack on one enchanted entry', p.entries.length === 1 && p.entries[0].count === 2 && p.entries[0].enchantmentId === ID.EnchWeaponShockDamage02, p.entries);
check('the swap message says enchantments are kept, never "plain"', /Enchanted pieces keep their enchantment\.$/.test(G.message(planOf([{ baseId: ID.EnchArmorElvenCuirassHealth03, count: 1 }]).swaps)));

// ---- 3. the restore, pure ----
const item = (o) => Object.assign({ id: 'x', count: 1, from: 'd30dd:BSHeartland.esm', to: '13985:Skyrim.esm', extras: { chargePercent: 567.98 } }, o);
let r = G.restore({ entries: [{ baseId: ID.HuntingBow, count: 1, worn: true }, { baseId: 0xf, count: 50 }], items: [item({ id: 'a' })], descOf, idOf, enchantOf, typeOf, nameOf });
e = r.entries.find((x) => x.baseId === ID.HuntingBow);
check('restore: the plain hunting bow the swap gave becomes the enchanted one (no second bow)', r.entries.filter((x) => x.baseId === ID.HuntingBow).length === 1 && e.enchantmentId === ID.EnchWeaponShockDamage02 && e.maxCharge === 1000 && Math.abs(e.chargePercent - 567.98) < 1e-6 && e.name === 'Hunting Bow of Arcing', r.entries);
check('...it was worn, so it is put on again', r.rewear.length === 1 && r.rewear[0].to === ID.HuntingBow && r.rewear[0].worn, r.rewear);
check('...reported as converted, nothing given', r.done.length === 1 && r.done[0].converted === 1 && r.done[0].granted === 0 && r.entries.some((x) => x.baseId === 0xf && x.count === 50));
r = G.restore({ entries: [{ baseId: ID.HuntingBow, count: 3, health: 1.3 }], items: [item({ id: 'a' })], descOf, idOf, enchantOf, typeOf, nameOf });
check('restore: one copy of a stack of three takes the enchantment and keeps the tempering it had since', r.entries.some((x) => x.baseId === ID.HuntingBow && x.count === 2 && !x.enchantmentId) && r.entries.some((x) => x.baseId === ID.HuntingBow && x.count === 1 && x.enchantmentId && x.health === 1.3), r.entries);
r = G.restore({ entries: [{ baseId: 0xf, count: 5 }], items: [item({ id: 'a' })], descOf, idOf, enchantOf, typeOf, nameOf });
check('restore: the hunting bow was sold, so the enchanted hunting bow is given', r.entries.some((x) => x.baseId === ID.HuntingBow && x.count === 1 && x.enchantmentId === ID.EnchWeaponShockDamage02) && r.done[0].granted === 1, r.entries);
r = G.restore({ entries: [{ baseId: ID.HuntingBow, count: 1, enchantmentId: 0x45f6f, maxCharge: 1500 }], items: [item({ id: 'a' })], descOf, idOf, enchantOf, typeOf, nameOf });
check('restore: an already enchanted hunting bow is never overwritten (a new one is given)', r.entries.some((x) => x.enchantmentId === 0x45f6f) && r.entries.some((x) => x.enchantmentId === ID.EnchWeaponShockDamage02), r.entries);
r = G.restore({ entries: [{ baseId: ID.SteelSword, count: 1 }], items: [item({ id: 'c', from: '139a9:Skyrim.esm', to: '13989:Skyrim.esm', extras: { enchantmentEffects: effects, maxCharge: 1500, chargePercent: 800, name: 'Glass Sword of Fire' } })], descOf, idOf, enchantOf, typeOf, nameOf });
check('restore: a player-made enchantment from the backup goes back on the steel sword', r.entries.length === 1 && JSON.stringify(r.entries[0].enchantmentEffects) === JSON.stringify(effects) && r.entries[0].name === 'Steel Sword of Fire', r.entries);
r = G.restore({ entries: [{ baseId: ID.SteelSword, count: 1 }], items: [item({ id: 'd', from: '139a9:Skyrim.esm', to: '13989:Skyrim.esm', extras: { health: 1.1 } })], descOf, idOf, enchantOf, typeOf, nameOf });
check('restore: a piece that was only tempered has nothing to restore (failed, inventory unchanged)', r.done.length === 0 && r.failed[0].why === 'not enchanted' && r.entries[0].baseId === ID.SteelSword && !r.entries[0].health, r);
r = G.restore({ entries: [], items: [item({ id: 'e', extras: { enchantmentEffects: [{ effectId: 'x' }] } })], descOf, idOf, enchantOf, typeOf, nameOf });
check('restore: malformed effects in the plan are refused', r.done.length === 0 && /bad effects/.test(r.failed[0].why));
r = G.restore({ entries: [], items: [item({ id: 'f', from: '1:Missing.esp' })], descOf, idOf, enchantOf, typeOf, nameOf });
check('restore: a plugin that is not loaded is refused', r.done.length === 0 && r.failed[0].why === 'plugin not loaded');

// ---- 4. the runtime, against a stub server ----
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-gearench-harness-'));
const PLAN = path.join(DIR, 'gearswap-restore.json');
const A = 0xff001372, B = 0xff002d35, N = 0xff000999;
const store = {
  [A]: { inventory: { entries: [{ baseId: ID.HuntingBow, count: 1 }, { baseId: 0xf, count: 10 }] }, equipment: { inv: { entries: [{ baseId: ID.HuntingBow, worn: true }] } }, profileId: 31, 'private.charTag': '4AML', 'private.dboGearSwap': { version: G.VERSION } },
  [B]: { inventory: { entries: [] }, equipment: { inv: { entries: [] } }, profileId: 69, 'private.charTag': 'FXWY', 'private.dboGearSwap': { version: G.VERSION } },
  [N]: { inventory: { entries: [{ baseId: ID.EnchArmorElvenCuirassHealth03, count: 1 }, { baseId: ID.CYREnchAyleidBowShock02, count: 1, chargePercent: 100 }] }, equipment: { inv: { entries: [{ baseId: ID.EnchArmorElvenCuirassHealth03, worn: true }] } }, profileId: 77, 'private.charTag': 'NEW1' },
};
const calls = [], said = [], audits = [], logs = [];
const mp = {
  get: (a, k) => (store[a] || {})[k], set: (a, k, v) => { store[a][k] = v; },
  getDescFromId: (id) => (id >>> 24 === 0xff ? (id & 0xffffff).toString(16) : descOf(id)), getIdFromDesc: idOf,
  callPapyrusFunction: (...args) => calls.push(args),
};
const plan = {
  version: 'gearrestore-test',
  characters: [
    { profileId: 31, tag: '4AML', name: 'Ghazra the Wanderer', formDesc: '1372', items: [item({ id: 'line-1' })] },
    { profileId: 69, tag: 'FXWY', name: 'Reyla Feign', formDesc: '9999', items: [item({ id: 'line-2', from: 'd30e0:BSHeartland.esm', to: '300056:BSHeartland.esm' })] },
  ],
};
fs.writeFileSync(PLAN, JSON.stringify(plan));
const load = (gearSwap) => require(path.join(SERVER, 'gearswap.js'))({ mp, log: (...a) => logs.push(a.join(' ')), audit: (t) => audits.push(t), who: (a) => `P${(a >>> 0).toString(16)}`, personal: (a, t) => said.push([a, t]),
  onlineActors: () => [], every: () => {}, cfg: { gearSwap: Object.assign({ restoreFile: path.relative(SERVER, PLAN) }, gearSwap || {}) }, registerChatCommand: () => {}, isStaff: () => false, recordOf });
const M = load({});
check('the runtime reads the bow\'s own enchantment from its record', JSON.stringify(M.enchantOf(ID.CYREnchAyleidBowShock02)) === JSON.stringify({ enchantmentId: ID.EnchWeaponShockDamage02, maxCharge: 1000 }));
check('...and a plain record has none', M.enchantOf(ID.HuntingBow) === null);
check('the restore plan is read at load', logs.some((l) => /restore plan gearrestore-test, 2 character\(s\), 2 item\(s\)/.test(l)), logs);
globalThis.__dboCombatAt = new Map([[A >>> 0, Date.now()]]);
globalThis.__dboGearSwapLogin(A);
check('a character in a fight waits: nothing restored, no mark', !store[A].inventory.entries.some((x) => x.enchantmentId) && !store[A][G.RESTORE_MARK]);
globalThis.__dboCombatAt = new Map();
globalThis.__dboGearSwapLogin(A);
e = store[A].inventory.entries.find((x) => x.baseId === ID.HuntingBow);
check('at the next quiet login Ghazra\'s hunting bow has the arcing enchantment back, with the charge it had', e && e.enchantmentId === ID.EnchWeaponShockDamage02 && Math.abs(e.chargePercent - 567.98) < 1e-6 && e.name === 'Hunting Bow of Arcing' && store[A].inventory.entries.filter((x) => x.baseId === ID.HuntingBow).length === 1, store[A].inventory.entries);
check('...it is worn, so it is put on again', calls.some((c) => c[2] === 'EquipItem' && c[4][0].desc === descOf(ID.HuntingBow)), calls);
check('...one audit line and one message', audits.filter((t) => /^GEARRESTORE P/.test(t)).length === 1 && /EnchWeaponShockDamage02 of its CYREnchAyleidBowShock02 back \(1 on the copy carried, 0 given\) as "Hunting Bow of Arcing" \[line-1\]/.test(audits.find((t) => /^GEARRESTORE/.test(t)) || '') && said.length === 1 && /enchantment back: 1 piece \(Hunting Bow of Arcing\)/.test(said[0][1]), { audits, said });
check('...and the character is marked with the item done', JSON.stringify(store[A][G.RESTORE_MARK].done) === '["line-1"]' && store[A][G.RESTORE_MARK].version === 'gearrestore-test');
const before = JSON.stringify(store[A].inventory);
globalThis.__dboGearSwapLogin(A);
check('once only: the next login changes nothing and says nothing', JSON.stringify(store[A].inventory) === before && said.length === 1);
globalThis.__dboGearSwapLogin(B);
check('a plan whose character form does not match is never applied (another character with the same tag)', !store[B].inventory.entries.length && !store[B][G.RESTORE_MARK]);
// A later plan (regenerated after more logins) adds an item for Ghazra; the done one stays done
plan.characters[0].items.push(item({ id: 'line-3', from: 'bdfc5:Skyrim.esm', to: '3619e:Skyrim.esm', extras: {} }));
fs.writeFileSync(PLAN, JSON.stringify(plan)); const t = new Date(Date.now() + 5000); fs.utimesSync(PLAN, t, t);
globalThis.__dboGearSwapLogin(A);
check('a regenerated plan is picked up: the new item is given (no leather armour left), the done one is not repeated',
  store[A].inventory.entries.filter((x) => x.enchantmentId === ID.EnchWeaponShockDamage02).length === 1 && store[A].inventory.entries.some((x) => x.baseId === ID.ArmorLeatherCuirass && x.enchantmentId === ID.EnchArmorFortifyHealth03 && x.name === 'Leather Armor of Major Health')
  && JSON.stringify(store[A][G.RESTORE_MARK].done) === '["line-1","line-3"]', store[A]);
// A character swapped for the first time now keeps both enchantments, and nothing in the plan touches them
said.length = 0; audits.length = 0; calls.length = 0;
globalThis.__dboGearSwapLogin(N);
const ni = store[N].inventory.entries;
check('a fresh swap keeps the enchantments: leather armour of major health and an arcing hunting bow with its charge',
  ni.some((x) => x.baseId === ID.ArmorLeatherCuirass && x.enchantmentId === ID.EnchArmorFortifyHealth03) && ni.some((x) => x.baseId === ID.HuntingBow && x.enchantmentId === ID.EnchWeaponShockDamage02 && x.chargePercent === 100) && ni.length === 2, ni);
check('...its audit lines say "(enchantment kept)", so a regenerated restore plan never reads them', audits.length === 2 && audits.every((t) => / \(enchantment kept\)$/.test(t)) && !audits.some((t) => / \(enchanted\)$/.test(t)), audits);
check('...the worn armour goes on again, and the message says the enchantments are kept', calls.some((c) => c[2] === 'EquipItem' && c[4][0].desc === descOf(ID.ArmorLeatherCuirass)) && /Enchanted pieces keep their enchantment\.$/.test(said[0][1]), said);
const L = 0xff000555;
store[L] = { inventory: { entries: [{ baseId: ID.HuntingBow, count: 1 }] }, equipment: { inv: { entries: [] } }, profileId: 31, 'private.charTag': '4AML' };
plan.characters[0].formDesc = '';
fs.writeFileSync(PLAN, JSON.stringify(plan)); const t2 = new Date(Date.now() + 10000); fs.utimesSync(PLAN, t2, t2);
load({ mode: 'log' });
globalThis.__dboGearSwapLogin(L);
check('mode log restores nothing and marks nothing', !store[L].inventory.entries[0].enchantmentId && !store[L][G.RESTORE_MARK]);
load({ restore: false });
globalThis.__dboGearSwapLogin(L);
check('restore: false turns the restore off', !store[L].inventory.entries[0].enchantmentId && !store[L][G.RESTORE_MARK]);
fs.unlinkSync(PLAN);
load({});
globalThis.__dboGearSwapLogin(L);
check('no plan file: nothing happens', !store[L].inventory.entries[0].enchantmentId && !store[L][G.RESTORE_MARK]);

// ---- 5. the plan tool reads the audit lines it should ----
const tool = fs.readFileSync(path.join(SERVER, 'tools/loot/gearswap_restore_plan.js'), 'utf8');
const LINE = new RegExp(/const LINE = (\/.*\/);/.exec(tool)[1].slice(1, -1));
const live = '[2026-10-04 00:08:26.139] [console] [info] [gamemode] audit: GEARSWAP Ghazra the Wanderer #4AML (profile 31, <@679660956787277832>): 1 x CYREnchAyleidBowShock02 -> HuntingBow (worn) (enchanted)';
const m = LINE.exec(live);
check('the plan tool reads a live "(enchanted)" line: who, how many, from, to, worn', m && m[3] === 'Ghazra the Wanderer' && m[4] === '4AML' && m[5] === '31' && m[6] === '1' && m[7] === 'CYREnchAyleidBowShock02' && m[8] === 'HuntingBow' && !!m[9], m);
check('...but never a line that kept its enchantment, a plain swap or a container', !LINE.test(live.replace('(enchanted)', '(enchantment kept)')) && !LINE.test(live.replace(' (enchanted)', '')) && !LINE.test('[2026-10-04 00:08:26.139] audit: GEARSWAP container 800f001: 1 x A -> B (enchanted)'));
check('the plan file is gitignored (it names characters; the remote is public)', /^gearswap-restore\.json$/m.test(fs.readFileSync(path.join(SERVER, '.gitignore'), 'utf8')));

fs.rmSync(DIR, { recursive: true, force: true });
delete globalThis.__dboGearSwapContainer; delete globalThis.__dboGearSwapLogin; delete globalThis.__dboCombatAt;
console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
