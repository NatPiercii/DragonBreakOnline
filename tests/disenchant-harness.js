// Disenchanting at an arcane enchanter (alchemy.js, the onCraftUnmatched hook), against a stub mp holding the records.
// /bug 2026-10-01 "disassembleenchantedweapon": the client destroys a disenchanted item and tells the server nothing, so the
// server kept it and the next inventory sync handed it back. The craft report the client sends from the enchanter (the items
// that left the pack while seated, closed by the next one to arrive) must take the disenchanted item; enchanting a plain item
// with a soul gem must take nothing here (craftedExtras records it); a lab mix still goes to brewing.
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
const ENCHANTER_BASE = idOf('bad0d:Skyrim.esm'), FORGE_BASE = idOf('bad0e:Skyrim.esm'), LAB_BASE = idOf('bad0c:Skyrim.esm');
const ENCHANTER = 0x080651cb, FORGE = 0x5001, LAB = 0x5002;
const wbdt = (type) => ({ type: 'WBDT', data: new Uint8Array([type, 0]) });
const RECORDS = {
  [BLAZE]: { type: 'WEAP', editorId: 'EnchElvenDaggerFire05', fields: [{ type: 'EITM', data: new Uint8Array(4) }] },
  [SPARKS]: { type: 'WEAP', editorId: 'CYREnchAyleidDaggerShock01', fields: [{ type: 'EITM', data: new Uint8Array(4) }] },
  [AMULET]: { type: 'ARMO', editorId: 'EnchNecklaceStamina05', fields: [{ type: 'EITM', data: new Uint8Array(4) }] },
  [SWORD]: { type: 'WEAP', editorId: 'IronSword', fields: [] },
  // An enchanted item the game never lets you disenchant (keyword MagicDisallowEnchanting, c27bd:Skyrim.esm)
  [UNIQUE]: { type: 'WEAP', editorId: 'StandInUniqueWeapon', fields: [{ type: 'EITM', data: new Uint8Array(4) }, { type: 'KWDA', data: new Uint8Array([0x24, 0x00, 0x00, 0x00, 0xbd, 0x27, 0x0c, 0x00]) }] },
  [GEM]: { type: 'SLGM', editorId: 'SoulGemGrandFilled', fields: [] },
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

// A worn copy is never taken; an unworn one is preferred over it
reset([{ baseId: BLAZE, count: 1, worn: true }, { baseId: BLAZE, count: 1 }]);
report(ENCHANTER, BLAZE, [BLAZE]);
ok(inv(PLAYER).length === 1 && inv(PLAYER)[0].worn === true, 'the unworn copy is taken, the worn one stays', inv(PLAYER));
reset([{ baseId: BLAZE, count: 1, worn: true }]);
report(ENCHANTER, BLAZE, [BLAZE]);
ok(count(PLAYER, BLAZE) === 1 && logs.some((l) => /not taken/.test(l)), 'only a worn copy: it stays, and that is logged', logs);
ok(audits.some((t) => /^DISENCHANT .* holds only a worn copy; not taken$/.test(t)), '...and audited', audits);

// Release-1031 review: a report counts one copy per base item, and a repeat within ten minutes takes nothing
reset([{ baseId: BLAZE, count: 3 }]);
mp.onCraftUnmatched(PLAYER, ENCHANTER, BLAZE, { entries: [{ baseId: BLAZE, count: 2 }, { baseId: BLAZE, count: 1 }] });
ok(count(PLAYER, BLAZE) === 2, 'a report naming one dagger three times takes one', inv(PLAYER));
report(ENCHANTER, BLAZE, [BLAZE]);
ok(count(PLAYER, BLAZE) === 2 && logs.some((l) => /again within 10 min; ignored/.test(l)), 'the same dagger reported again at once takes nothing (vanilla never offers a known enchantment)', logs);
clock += 10 * 60 * 1000;
report(ENCHANTER, BLAZE, [BLAZE]);
ok(count(PLAYER, BLAZE) === 1, '...and ten minutes later it counts again', inv(PLAYER));

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

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
