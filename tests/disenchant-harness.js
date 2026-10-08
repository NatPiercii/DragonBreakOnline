// Disenchanting at an arcane enchanter (alchemy.js, the onCraftUnmatched hook), against a stub mp holding the records.
// /bug 2026-10-01 "disassembleenchantedweapon": the client destroys a disenchanted item and tells the server nothing, so the
// server kept it and the next inventory sync handed it back. The craft report the client sends from the enchanter (the items
// that left the pack while seated, closed by the next one to arrive) must take the disenchanted item; enchanting a plain item
// with a soul gem must take nothing here (craftedExtras records it); a lab mix still goes to brewing. 4 Oct (Nate: "when
// someone disenchants something it should destroy the item as well"): a worn copy, a copy enchanted by extra data in a
// report holding a soul gem spent on another item, and a second copy with another enchantment are taken too; a report
// of an enchantment already taught this session (the server's own removal seen by the client) takes nothing. Review
// R-1004b: the report names the base only, so a base whose copies carry more enchantments than copies left is taken from
// not at all (DISENCHANT-AMBIGUOUS for staff), nor is a plain-able base while a reusable soul gem is held and unreported.
// Review 8 Oct: unless every candidate teaches the same effects and no plain copy is held; then the plainest copy goes
// (disenchant-ambiguous-learn-harness).
// Run it from this folder's parent with
//
//   node tests/disenchant-harness.js
'use strict';
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
process.chdir(SERVER); // alchemy-potions.json resolves by cwd, as on the server

const PLUGINS = { 'Skyrim.esm': 0x00, 'BSHeartland.esm': 0x08 };
const NAMES_OF = Object.fromEntries(Object.entries(PLUGINS).map(([k, v]) => [v, k]));
const idOf = (d) => { const [hex, plugin] = String(d).split(':'); if (!(plugin in PLUGINS)) throw new Error(`no plugin ${plugin}`); return ((PLUGINS[plugin] << 24) | parseInt(hex, 16)) >>> 0; };
const descOf = (id) => `${(id & 0xffffff).toString(16)}:${NAMES_OF[id >>> 24] || 'Skyrim.esm'}`;

// The two daggers of the report, a plain sword, a soul gem, and the furniture
const BLAZE = idOf('be190:Skyrim.esm'), SPARKS = idOf('d30df:BSHeartland.esm'), SWORD = idOf('12eb7:Skyrim.esm'), GEM = idOf('2e4e3:Skyrim.esm');
const AMULET = idOf('8b5ab:Skyrim.esm'), UNIQUE = idOf('f0001:Skyrim.esm');
// A steel dagger the gear swap gave the Ayleid dagger's enchantment (EnchWeaponShockDamage02) as extra data
const STEEL = idOf('300056:BSHeartland.esm'), SHOCK = 0x45d97, FROST = 0x45c37, SHOCK_FX = 0x5cd5b, FROST_FX = 0x5cd5c;
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const STAR = idOf('63b27:Skyrim.esm');
const ENCHANTER_BASE = idOf('bad0d:Skyrim.esm'), FORGE_BASE = idOf('bad0e:Skyrim.esm'), LAB_BASE = idOf('bad0c:Skyrim.esm');
const ENCHANTER = 0x080651cb, FORGE = 0x5001, LAB = 0x5002;
const wbdt = (type) => ({ type: 'WBDT', data: new Uint8Array([type, 0]) });
const RECORDS = {
  [BLAZE]: { type: 'WEAP', editorId: 'EnchElvenDaggerFire05', fields: [{ type: 'EITM', data: new Uint8Array(4) }] },
  [SPARKS]: { type: 'WEAP', editorId: 'CYREnchAyleidDaggerShock01', fields: [{ type: 'EITM', data: new Uint8Array(4) }] },
  [AMULET]: { type: 'ARMO', editorId: 'EnchNecklaceStamina05', fields: [{ type: 'EITM', data: new Uint8Array(4) }] },
  [SWORD]: { type: 'WEAP', editorId: 'IronSword', fields: [] },
  [STEEL]: { type: 'WEAP', editorId: 'CYRSteelDagger', fields: [] },
  // An enchanted item the game never lets you disenchant (keyword MagicDisallowEnchanting, c27bd:Skyrim.esm)
  [UNIQUE]: { type: 'WEAP', editorId: 'StandInUniqueWeapon', fields: [{ type: 'EITM', data: new Uint8Array(4) }, { type: 'KWDA', data: new Uint8Array([0x24, 0x00, 0x00, 0x00, 0xbd, 0x27, 0x0c, 0x00]) }] },
  [GEM]: { type: 'SLGM', editorId: 'SoulGemGrandFilled', fields: [] },
  // Azura's Star: keywords VendorItemSoulGem 917e8, ... and ReusableSoulGem ed2f1 (Skyrim.esm, read from the plugin)
  [STAR]: { type: 'SLGM', editorId: 'DA01SoulGemAzurasStar', fields: [{ type: 'KWDA', data: new Uint8Array([...u32(0x917e8), ...u32(0xed2f1)]) }] },
  [SHOCK]: { type: 'ENCH', editorId: 'EnchWeaponShockDamage02', fields: [{ type: 'EFID', data: u32(SHOCK_FX) }] },
  [FROST]: { type: 'ENCH', editorId: 'EnchWeaponFrostDamage02', fields: [{ type: 'EFID', data: u32(FROST_FX) }] },
  [ENCHANTER_BASE]: { type: 'FURN', editorId: 'CraftingEnchantingWorkbench', fields: [wbdt(3)] },
  [FORGE_BASE]: { type: 'FURN', editorId: 'CraftingBlacksmithForge', fields: [wbdt(1)] },
  [LAB_BASE]: { type: 'FURN', editorId: 'CraftingAlchemyWorkbench', fields: [wbdt(5)] },
};
const NAMES = { [BLAZE]: 'Elven Dagger of the Blaze', [SPARKS]: 'Ayleid Dagger of Sparks', [AMULET]: 'Necklace of Peerless Stamina' };

const PLAYER = 0xff0004cb;
const props = new Map();
const put = (id, p, v) => props.set(id + '|' + p, v);
const inv = (a) => (props.get(a + '|inventory') || { entries: [] }).entries;
const count = (a, baseId) => inv(a).filter((e) => e.baseId === baseId).reduce((n, e) => n + e.count, 0);
let clock = 1_790_000_000_000;
Date.now = () => clock;
const logs = [], said = [], audits = [];
const reset = (entries) => {
  clock += 11 * 60 * 1000;
  props.clear(); logs.length = 0; said.length = 0; audits.length = 0;
  put(PLAYER, 'inventory', { entries: entries.map((e) => Object.assign({}, e)) });
  put(PLAYER, 'worldOrCellDesc', '651c0:BSHeartland.esm'); put(PLAYER, 'pos', [100, 100, 0]);
  // Each case is a fresh login: what the client learned at the table is forgotten
  if (globalThis.__dboEnchLearnedLogin) globalThis.__dboEnchLearnedLogin(PLAYER);
  for (const [ref, base] of [[ENCHANTER, ENCHANTER_BASE], [FORGE, FORGE_BASE], [LAB, LAB_BASE]]) {
    put(ref, 'baseDesc', descOf(base)); put(ref, 'worldOrCellDesc', '651c0:BSHeartland.esm'); put(ref, 'pos', [150, 120, 0]);
  }
};
const mp = {
  get: (id, p) => props.get((id >>> 0) + '|' + p),
  set: (id, p, v) => put(id >>> 0, p, v),
  getIdFromDesc: idOf,
  getDescFromId: descOf,
  lookupEspmRecordById: (id) => (RECORDS[id >>> 0] ? { record: RECORDS[id >>> 0], toGlobalRecordId: (x) => x } : null),
};
const api = {
  mp, log: (...x) => logs.push(x.join(' ')), personal: (a, t) => said.push([a, t]), audit: (t) => audits.push(t),
  display: () => 'the player', who: () => 'the player', openWidget: () => {}, closeWidget: () => {}, every: () => {},
  itemName: (d) => NAMES[idOf(d)] || '',
};
require(path.join(SERVER, 'alchemy.js'))(api);
const report = (workbench, result, ids) => mp.onCraftUnmatched(PLAYER, workbench, result, { entries: ids.map((baseId) => ({ baseId, count: 1 })) });

let fails = 0;
const ok = (c, what, detail) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}`); if (!c) { fails++; if (detail) console.log('      ', JSON.stringify(detail)); } };

// The report of 2026-10-01 22:38:39: both daggers disenchanted, the report closed by the Blaze dagger handed back
reset([{ baseId: BLAZE, count: 1 }, { baseId: SPARKS, count: 1 }, { baseId: SWORD, count: 1 }]);
report(ENCHANTER, BLAZE, [BLAZE, SPARKS]);
ok(count(PLAYER, BLAZE) === 0 && count(PLAYER, SPARKS) === 0, 'both disenchanted daggers are used up, as vanilla uses them up', inv(PLAYER));
ok(count(PLAYER, SWORD) === 1, 'nothing else in the pack is touched');
ok(said.some(([, t]) => /Elven Dagger of the Blaze, Ayleid Dagger of Sparks are gone/.test(t)), 'the player is told what was used up', said);
ok(audits.some((t) => /^DISENCHANT /.test(t)) && logs.some((l) => /disenchant: .* taken/.test(l)), 'the disenchant is logged and audited', logs);

// The same dagger disenchanted again later: no copy left, nothing else is taken
report(ENCHANTER, BLAZE, [BLAZE]);
ok(count(PLAYER, SWORD) === 1 && inv(PLAYER).length === 1, 'a report for a dagger no longer held takes nothing else');

// Enchanting a plain sword with a soul gem: the enchanter's other report, craftedExtras' to record
reset([{ baseId: SWORD, count: 1 }, { baseId: GEM, count: 1 }, { baseId: BLAZE, count: 1 }]);
report(ENCHANTER, SWORD, [SWORD, GEM]);
ok(count(PLAYER, SWORD) === 1 && count(PLAYER, GEM) === 1 && count(PLAYER, BLAZE) === 1 && !said.length, 'enchanting a plain item takes nothing here', inv(PLAYER));

// Two copies held, one disenchanted; armour enchanted by its record too
reset([{ baseId: BLAZE, count: 2 }, { baseId: AMULET, count: 1 }]);
report(ENCHANTER, BLAZE, [BLAZE, AMULET]);
ok(count(PLAYER, BLAZE) === 1 && count(PLAYER, AMULET) === 0, 'one copy per reported one: the second dagger stays, the necklace goes', inv(PLAYER));

// An unworn copy is preferred over a worn one; a worn one is taken when it is the only one (vanilla disenchants worn
// items too: Julius Draconis's worn Necklace of Peerless Stamina left his pack with the worn list, 1 Oct 23:59:16, and his
// client's craft report can reach the server before its equipment report)
reset([{ baseId: BLAZE, count: 1, worn: true }, { baseId: BLAZE, count: 1 }]);
report(ENCHANTER, BLAZE, [BLAZE]);
ok(inv(PLAYER).length === 1 && inv(PLAYER)[0].worn === true, 'the unworn copy is taken, the worn one stays', inv(PLAYER));
reset([{ baseId: BLAZE, count: 1, worn: true }]);
report(ENCHANTER, BLAZE, [BLAZE]);
ok(count(PLAYER, BLAZE) === 0, 'only a worn copy: it is used up (keeping it was the item plus the enchantment)', inv(PLAYER));
ok(audits.some((t) => /^DISENCHANT .*Elven Dagger of the Blaze \[.*; worn\]/.test(t)), '...and the audit says it was worn', audits);

// Release-1031 review: a report counts one copy per base item (one per enchantment it teaches); the same enchantment
// reported again in the session takes nothing (the server's own removal of the item, seen by the client's report)
reset([{ baseId: BLAZE, count: 3 }]);
mp.onCraftUnmatched(PLAYER, ENCHANTER, BLAZE, { entries: [{ baseId: BLAZE, count: 2 }, { baseId: BLAZE, count: 1 }] });
ok(count(PLAYER, BLAZE) === 2, 'a report naming one dagger three times takes one', inv(PLAYER));
report(ENCHANTER, BLAZE, [BLAZE]);
ok(count(PLAYER, BLAZE) === 2 && logs.some((l) => /already taught this session/.test(l)), 'the same dagger reported again at once takes nothing (vanilla never offers a known enchantment)', logs);
clock += 10 * 60 * 1000;
report(ENCHANTER, BLAZE, [BLAZE]);
ok(count(PLAYER, BLAZE) === 2, '...nor ten minutes later in the same session (a stale report from the same table)', inv(PLAYER));
globalThis.__dboEnchLearnedLogin(PLAYER);
report(ENCHANTER, BLAZE, [BLAZE]);
ok(count(PLAYER, BLAZE) === 1, '...but after a relog (the client forgot it, so the table offers it again) it is used up again', inv(PLAYER));

// An item the game never disenchants (MagicDisallowEnchanting) is never taken
reset([{ baseId: UNIQUE, count: 1 }]);
report(ENCHANTER, UNIQUE, [UNIQUE]);
ok(count(PLAYER, UNIQUE) === 1 && !said.length, 'an item with MagicDisallowEnchanting is left alone', inv(PLAYER));

// The plain copy goes first: a tempered or poisoned one, then a named or player-enchanted one, are kept
reset([{ baseId: BLAZE, count: 1, name: 'Mine' }, { baseId: BLAZE, count: 1, health: 1.2 }, { baseId: BLAZE, count: 1, poisonId: 0x73f34, poisonCount: 2 }, { baseId: BLAZE, count: 1 }]);
report(ENCHANTER, BLAZE, [BLAZE]);
ok(inv(PLAYER).length === 3 && inv(PLAYER).every((e) => e.name || e.health || e.poisonId), 'the plain copy is taken before tempered, poisoned or named ones', inv(PLAYER));
reset([{ baseId: BLAZE, count: 1, name: 'Mine' }, { baseId: BLAZE, count: 1, health: 1.2 }]);
report(ENCHANTER, BLAZE, [BLAZE]);
ok(inv(PLAYER).length === 1 && inv(PLAYER)[0].name === 'Mine', '...and a tempered one before a named one', inv(PLAYER));
// A player-made enchantment is stored as its effects (enchantmentEffects): such a copy is kept like a named one
reset([{ baseId: BLAZE, count: 1, enchantmentEffects: [{ effectId: 0x3eb15, magnitude: 20, area: 0, duration: 0, cost: 30 }] }, { baseId: BLAZE, count: 1, health: 1.2 }]);
report(ENCHANTER, BLAZE, [BLAZE]);
ok(inv(PLAYER).length === 1 && inv(PLAYER)[0].enchantmentEffects, 'a copy carrying enchantment effects is taken after a tempered one', inv(PLAYER));

// Not at the enchanter, or not an enchanter: nothing taken
reset([{ baseId: BLAZE, count: 1 }]);
put(PLAYER, 'pos', [5000, 5000, 0]);
report(ENCHANTER, BLAZE, [BLAZE]);
ok(count(PLAYER, BLAZE) === 1 && logs.some((l) => /while not at it; ignored/.test(l)), 'a report from away from the enchanter is ignored', logs);
reset([{ baseId: BLAZE, count: 1 }]);
report(FORGE, BLAZE, [BLAZE]);
ok(count(PLAYER, BLAZE) === 1, 'the same report from a forge takes nothing');
reset([{ baseId: BLAZE, count: 1 }]);
report(LAB, BLAZE, [BLAZE]);
ok(count(PLAYER, BLAZE) === 1 && logs.some((l) => /alchemy: .*not a lab mix/.test(l)), 'a lab report still goes to brewing, which ignores a dagger', logs);

// A copy enchanted by extra data (gearswap.js keeps an enchantment on the steel replacement, 4 Oct): disenchanting it uses
// it up too, the enchanted copy before a plain one; enchanting (a soul gem in the report) or a player-made one never
reset([{ baseId: STEEL, count: 1 }, { baseId: STEEL, count: 1, enchantmentId: SHOCK, maxCharge: 1000, name: 'Steel Dagger of Arcing' }]);
report(ENCHANTER, STEEL, [STEEL]);
ok(count(PLAYER, STEEL) === 1 && !inv(PLAYER).some((e) => e.enchantmentId), 'a steel dagger enchanted by extra data is used up, the plain one stays', inv(PLAYER));
ok(audits.some((t) => /^DISENCHANT .* used up/.test(t)), '...and audited', audits);
reset([{ baseId: STEEL, count: 1 }, { baseId: STEEL, count: 1, enchantmentId: SHOCK, maxCharge: 1000 }, { baseId: GEM, count: 1 }]);
report(ENCHANTER, STEEL, [STEEL, GEM]);
ok(count(PLAYER, STEEL) === 2 && count(PLAYER, GEM) === 1 && !said.length, 'enchanting a plain steel dagger with a soul gem takes nothing, though an enchanted one is held', inv(PLAYER));
reset([{ baseId: STEEL, count: 2 }]);
report(ENCHANTER, STEEL, [STEEL]);
ok(count(PLAYER, STEEL) === 2 && !said.length, 'a plain steel dagger alone is never taken (nothing to disenchant)', inv(PLAYER));
reset([{ baseId: STEEL, count: 1, enchantmentId: 0xff000123, maxCharge: 900 }]);
report(ENCHANTER, STEEL, [STEEL]);
ok(count(PLAYER, STEEL) === 1, 'a player-made (dynamic) enchantment is never taken', inv(PLAYER));
reset([{ baseId: STEEL, count: 1, enchantmentId: SHOCK, maxCharge: 1000, worn: true }]);
report(ENCHANTER, STEEL, [STEEL]);
ok(count(PLAYER, STEEL) === 0, 'a worn copy enchanted by extra data is used up too', inv(PLAYER));
reset([{ baseId: BLAZE, count: 1 }, { baseId: BLAZE, count: 1, enchantmentId: SHOCK, maxCharge: 1000 }]);
report(ENCHANTER, BLAZE, [BLAZE]);
ok(count(PLAYER, BLAZE) === 2 && audits.some((t) => /^DISENCHANT-AMBIGUOUS .*2 enchantments to choose from; nothing taken, nothing learned \[eitm:be190 \| EnchWeaponShockDamage02\]$/.test(t)) && !(mp.get(PLAYER, 'private.dboEnchLearned') || []).length,
  'review R-1004b: a base enchanted by its record that also has a copy enchanted by extra data, one reported: which went is unknown, so neither is taken, nothing is learned, and staff get DISENCHANT-AMBIGUOUS', { inv: inv(PLAYER), audits });

// ---- 4 Oct: every way a disenchanted item stayed, and the dupe each one was ---------------------------------------
const learned = () => mp.get(PLAYER, 'private.dboEnchLearned') || [];
// The live report shape (Julius Draconis 1 Oct 23:15:44, Kagrethas Mzulft 3 Oct 00:51:14): an item disenchanted, then a
// plain one enchanted with a soul gem, all in one report. The disenchanted one goes; the gem and the new piece are craftedExtras'
reset([{ baseId: BLAZE, count: 1 }, { baseId: GEM, count: 1 }, { baseId: SWORD, count: 1 }]);
report(ENCHANTER, BLAZE, [BLAZE, GEM, SWORD]);
ok(count(PLAYER, BLAZE) === 0 && count(PLAYER, GEM) === 1 && count(PLAYER, SWORD) === 1, 'disenchant then enchant in one report: the disenchanted dagger goes, the gem and the sword are left to craftedExtras', inv(PLAYER));
// Dupe: a steel dagger enchanted by extra data disenchanted, and a plain sword enchanted, in one report. The old rule ("a
// report holding a soul gem is enchanting") kept the dagger: the enchantment learned and the dagger kept to sell
reset([{ baseId: STEEL, count: 1, enchantmentId: SHOCK, maxCharge: 1000 }, { baseId: STEEL, count: 1 }, { baseId: GEM, count: 1 }, { baseId: SWORD, count: 1 }]);
report(ENCHANTER, SWORD, [STEEL, GEM, SWORD]);
ok(!inv(PLAYER).some((e) => e.enchantmentId) && count(PLAYER, STEEL) === 1 && count(PLAYER, SWORD) === 1, 'a gem spent on the sword does not hide the steel dagger disenchanted beside it', inv(PLAYER));
ok(JSON.stringify(learned()) === JSON.stringify([SHOCK_FX]), "...and the dagger's own enchantment (its extra data's, not the plain record's nothing) is what was learned", learned());
// Two steel daggers left, one gem: one was enchanted (the plain one), the other disenchanted (the enchanted one)
reset([{ baseId: STEEL, count: 1, enchantmentId: SHOCK, maxCharge: 1000 }, { baseId: STEEL, count: 1 }, { baseId: GEM, count: 1 }]);
mp.onCraftUnmatched(PLAYER, ENCHANTER, STEEL, { entries: [{ baseId: STEEL, count: 1 }, { baseId: GEM, count: 1 }, { baseId: STEEL, count: 1 }] });
ok(!inv(PLAYER).some((e) => e.enchantmentId) && count(PLAYER, STEEL) === 1, 'two steel daggers and one gem: the enchanted one is used up, the plain one (being enchanted) stays', inv(PLAYER));
// craftedExtras recorded the new enchantment first: the plain dagger now carries its effects, the gem is still that enchant's
reset([{ baseId: STEEL, count: 1, enchantmentId: SHOCK, maxCharge: 1000 }, { baseId: STEEL, count: 1, enchantmentEffects: [{ effectId: 0x3eb15, magnitude: 20, area: 0, duration: 0, cost: 30 }] }, { baseId: GEM, count: 1 }]);
report(ENCHANTER, STEEL, [STEEL, GEM]);
ok(count(PLAYER, STEEL) === 2 && !said.length, 'enchanting a steel dagger the server already recorded as enchanted takes nothing', inv(PLAYER));
// Review R-1004b's repro: Steel Dagger of Frost and Steel Dagger of Arcing held (both named by gearswap), Arcing
// disenchanted, report [STEEL]. fdb279c7 took Frost, kept Arcing and recorded Frost learned. Neither can be told apart
reset([{ baseId: STEEL, count: 1, enchantmentId: FROST, maxCharge: 1000, name: 'Steel Dagger of Frost' }, { baseId: STEEL, count: 1, enchantmentId: SHOCK, maxCharge: 1000, name: 'Steel Dagger of Arcing' }]);
report(ENCHANTER, STEEL, [STEEL]);
ok(count(PLAYER, STEEL) === 2 && !learned().length, 'Frost and Arcing steel daggers held, one reported: neither is taken and nothing is recorded learned', { inv: inv(PLAYER), learned: learned() });
ok(audits.some((t) => /^DISENCHANT-AMBIGUOUS the player Steel Dagger \(8300056\): 1 left the pack, 2 enchantments to choose from; nothing taken, nothing learned \[EnchWeaponFrostDamage02; named "Steel Dagger of Frost" \| EnchWeaponShockDamage02; named "Steel Dagger of Arcing"\]$/.test(t)) && !said.length,
  '...and the audit names both copies for staff; the player is told nothing was used up', audits);
report(ENCHANTER, STEEL, [STEEL]);
ok(count(PLAYER, STEEL) === 2, '...a second report of one is just as unknown (the second disenchant of the pair)', inv(PLAYER));
// An enchantment already taught this session narrows the choice: Frost was taught from a sword, so the steel dagger
// reported next can only have been the Arcing one
reset([{ baseId: SWORD, count: 1, enchantmentId: FROST, maxCharge: 1000 }, { baseId: STEEL, count: 1, enchantmentId: FROST, maxCharge: 1000 }, { baseId: STEEL, count: 1, enchantmentId: SHOCK, maxCharge: 1000 }]);
report(ENCHANTER, SWORD, [SWORD]);
report(ENCHANTER, STEEL, [STEEL]);
ok(count(PLAYER, SWORD) === 0 && inv(PLAYER).length === 1 && inv(PLAYER)[0].enchantmentId === FROST && JSON.stringify(learned()) === JSON.stringify([FROST_FX, SHOCK_FX]),
  'Frost taught from a sword first: the steel dagger reported next is the Arcing one, taken and learned', { inv: inv(PLAYER), learned: learned() });
reset([{ baseId: STEEL, count: 1, enchantmentId: SHOCK, maxCharge: 1000 }, { baseId: STEEL, count: 1, enchantmentId: FROST, maxCharge: 1000 }]);
mp.onCraftUnmatched(PLAYER, ENCHANTER, STEEL, { entries: [{ baseId: STEEL, count: 1 }, { baseId: STEEL, count: 1 }] });
ok(count(PLAYER, STEEL) === 0, '...and both in one report', inv(PLAYER));
// Two copies with the same enchantment: the table teaches it once, so a report naming two takes one
reset([{ baseId: STEEL, count: 1, enchantmentId: SHOCK, maxCharge: 1000 }, { baseId: STEEL, count: 1, enchantmentId: SHOCK, maxCharge: 400 }]);
mp.onCraftUnmatched(PLAYER, ENCHANTER, STEEL, { entries: [{ baseId: STEEL, count: 1 }, { baseId: STEEL, count: 1 }] });
ok(count(PLAYER, STEEL) === 1, 'two copies of one enchantment named in one report: one used up (vanilla offers a known enchantment no more)', inv(PLAYER));
// A reusable soul gem (Azura's Star) enchants without being used up, so it may be missing from the report: holding one,
// a plain steel dagger may have been enchanted, and the enchanted steel dagger beside it is not taken
reset([{ baseId: STEEL, count: 1 }, { baseId: STEEL, count: 1, enchantmentId: SHOCK, maxCharge: 1000 }, { baseId: STAR, count: 1, soul: 5 }]);
report(ENCHANTER, STEEL, [STEEL]);
ok(count(PLAYER, STEEL) === 2 && audits.some((t) => /^DISENCHANT-AMBIGUOUS .*a reusable soul gem held could have enchanted a plain copy/.test(t)), "Azura's Star held, not reported, plain and enchanted steel daggers: nothing taken, audited", { inv: inv(PLAYER), audits });
reset([{ baseId: STEEL, count: 1 }, { baseId: STEEL, count: 1, enchantmentId: SHOCK, maxCharge: 1000 }, { baseId: STAR, count: 1 }]);
report(ENCHANTER, STEEL, [STEEL, STAR]);
ok(count(PLAYER, STEEL) === 2 && !audits.length, "...the star in the report counts as that enchant's gem: nothing taken, nothing to settle", { inv: inv(PLAYER), audits });
reset([{ baseId: STEEL, count: 1, enchantmentId: SHOCK, maxCharge: 1000 }, { baseId: STAR, count: 1, soul: 5 }]);
report(ENCHANTER, STEEL, [STEEL]);
ok(count(PLAYER, STEEL) === 0, '...with no plain copy to enchant, the star changes nothing: the enchanted dagger is used up', inv(PLAYER));
reset([{ baseId: BLAZE, count: 1 }, { baseId: STAR, count: 1, soul: 5 }]);
report(ENCHANTER, BLAZE, [BLAZE]);
ok(count(PLAYER, BLAZE) === 0, '...nor for a base enchanted by its record (it can never be enchanted)', inv(PLAYER));
// The server's own removal, seen by the client's craft report while the player still sits: never a second take
reset([{ baseId: BLAZE, count: 2 }]);
report(ENCHANTER, BLAZE, [BLAZE]);
report(ENCHANTER, SWORD, [BLAZE, SWORD, GEM]);
ok(count(PLAYER, BLAZE) === 1, "the item the server just took, reported again by the client's next report, is not taken twice", inv(PLAYER));
// A copy is taken for each enchantment taught: the learned list and the audit name it
reset([{ baseId: STEEL, count: 1, enchantmentId: FROST, maxCharge: 1000, health: 1.3 }]);
report(ENCHANTER, STEEL, [STEEL]);
ok(audits.some((t) => /^DISENCHANT the player used up .*\[EnchWeaponFrostDamage02; tempered\]$/.test(t)), 'the audit names the enchantment taught and the copy (tempered)', audits);
ok(JSON.stringify(learned()) === JSON.stringify([FROST_FX]), '...and it is recorded as learned', learned());
// A disenchant that keeps the item is an endless learn: across every case above, a taken disenchant leaves one fewer
// item, and nothing is ever learned without an item going (one more pass: reports that take nothing learn nothing)
reset([{ baseId: STEEL, count: 1 }, { baseId: SWORD, count: 1 }, { baseId: GEM, count: 1 }]);
report(ENCHANTER, STEEL, [STEEL, GEM]);
report(ENCHANTER, UNIQUE, [UNIQUE]);
ok(!learned().length && count(PLAYER, STEEL) === 1 && count(PLAYER, SWORD) === 1, 'a report that takes nothing records nothing learned', { learned: learned(), inv: inv(PLAYER) });

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
