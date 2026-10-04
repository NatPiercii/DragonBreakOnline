// Scripted test for gearswap.js (Nate, 1 Oct 2026: gear above the steel loot cap swapped for steel, once per character)
// and the gear-swap.json map from tools/loot/steel_swap_map.py. Run from this folder's parent:
//   node tests/gearswap-harness.js
'use strict';
const fs = require('fs');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(SERVER, f), 'utf8'));
const G = require(path.join(SERVER, 'gearswap.js'));
const TIERS = require(path.join(SERVER, 'loottiers.js'))({ materials: readJson('loot-materials.json'), factionGear: readJson('faction-gear.json'), overrides: readJson('loot-overrides.json'), cfg: undefined });
const SWAP = readJson('gear-swap.json');

// Real records: Skyrim.esm is plugin 0, BSHeartland.esm plugin 8 on the server
const PLUG = { 0: 'Skyrim.esm', 8: 'BSHeartland.esm' };
const descOf = (id) => `${((id >>> 0) & 0xffffff).toString(16)}:${PLUG[(id >>> 0) >>> 24] || 'X.esp'}`;
const idOf = (desc) => { const m = /^([0-9a-f]+):(.+)$/i.exec(desc); const top = Object.keys(PLUG).find((k) => PLUG[k].toLowerCase() === m[2].toLowerCase()); return top === undefined ? 0 : ((Number(top) << 24) | parseInt(m[1], 16)) >>> 0; };
const ID = {
  GlassSword: 0x139a9, SteelSword: 0x13989, ArmorEbonyCuirass: 0x13961, ArmorSteelCuirassA: 0x13952, IronSword: 0x12eb7,
  IngotEbony: 0x5ad9d, IngotIMoonstone: 0x5ad9f, IngotSteel: 0x5ace5, DA08EbonyBlade: 0x4a38f, SteelGreatsword: 0x13987,
  CYRElvenSword: 0x08300070, CYRSteelSword: 0x08300059, CYRArmorElvenCuirass: 0x08300009, CYRArmorLeatherCuirassA: 0x0805ef24,
  ArmorElvenCuirass: 0x896a3, ArmorLeatherCuirass: 0x3619e, Gold: 0xf, ElvenArrow: 0x139bd, IronArrow: 0x1397d, SteelArrow: 0x1397f,
};
const EDID = Object.fromEntries(Object.entries(ID).map(([k, v]) => [v >>> 0, k]));
const ARTIFACT = new RegExp((readJson('artifacts.json').patterns || []).map((p) => `(?:${p})`).join('|'), 'i');
const planOf = (entries, worn) => G.plan({ entries, descOf, classOf: TIERS.classOf, swap: SWAP, idOf, isArtifact: (e) => ARTIFACT.test(e), edidOf: (id) => EDID[id >>> 0] || '', worn });

// ---- 1. the map ----
const target = (name) => { const it = SWAP.items[`${(ID[name] & 0xffffff).toString(16)}:${PLUG[ID[name] >>> 24].toLowerCase()}`]; return it && it.toEdid; };
check('a Skyrim glass sword becomes a steel sword', target('GlassSword') === 'SteelSword', target('GlassSword'));
check('an Ebony cuirass (heavy) becomes a steel cuirass', target('ArmorEbonyCuirass') === 'ArmorSteelCuirassA', target('ArmorEbonyCuirass'));
check('an Elven cuirass (light) becomes a leather cuirass', target('ArmorElvenCuirass') === 'ArmorLeatherCuirass', target('ArmorElvenCuirass'));
check('Cyrodiil pieces stay Cyrodiil: an Elven sword to CYR steel, an Elven cuirass to CYR leather', target('CYRElvenSword') === 'CYRSteelSword' && target('CYRArmorElvenCuirass') === 'CYRArmorLeatherCuirassA');
const targets = Object.values(SWAP.replacements).map((r) => r.to);
check('every replacement is loot under the cap itself (loottiers says gear)', targets.every((d) => TIERS.classOf(d).kind === 'gear'), targets.filter((d) => TIERS.classOf(d).kind !== 'gear'));
check('every mapped item is above the cap by loottiers', Object.keys(SWAP.items).every((d) => { const c = TIERS.classOf(d); return c.kind === 'capped' || c.kind === 'never'; }));
check('refined moonstone and ebony ingots become steel ingots', SWAP.metals['5ad9f:skyrim.esm'].toEdid === 'IngotSteel' && SWAP.metals['5ad9d:skyrim.esm'].toEdid === 'IngotSteel');
check('corundum, silver and gold ingots are not on the metals list', !Object.values(SWAP.metals).some((m) => /^(Ingot|Ore)(Corundum|Silver|Gold)$|^ingotSilver$/i.test(m.edid)));

// ---- 2. the plan ----
let p = planOf([{ baseId: ID.GlassSword, count: 1 }, { baseId: ID.IronSword, count: 2 }, { baseId: ID.Gold, count: 50 }], new Map([[ID.GlassSword, 'right']]));
check('a glass sword is swapped, iron and gold stay', p.swaps.length === 1 && p.swaps[0].to === ID.SteelSword && p.keep.length === 2, p.swaps);
check('...worn in the right hand, so its replacement goes on there', p.swaps[0].worn === true && p.swaps[0].wornLeft === false);
check('...and the new inventory has the steel sword instead', p.entries.some((e) => e.baseId === ID.SteelSword && e.count === 1) && !p.entries.some((e) => e.baseId === ID.GlassSword));
p = planOf([{ baseId: ID.IngotEbony, count: 3 }, { baseId: ID.IngotIMoonstone, count: 2 }, { baseId: ID.IngotSteel, count: 4 }]);
check('metals go count for count into the plain steel ingot stack', p.entries.length === 1 && p.entries[0].baseId === ID.IngotSteel && p.entries[0].count === 9, p.entries);
p = planOf([{ baseId: ID.IngotEbony, count: 1 }, { baseId: ID.IngotSteel, count: 1, health: 1.2 }]);
check('...but never into a tempered stack', p.entries.length === 2 && p.entries.some((e) => e.baseId === ID.IngotSteel && e.count === 1 && !e.health));
p = planOf([{ baseId: ID.DA08EbonyBlade, count: 1 }]);
check('an artifact is never touched, even above the cap', p.swaps.length === 0 && p.skipped.artifact === 1 && p.entries[0].baseId === ID.DA08EbonyBlade);
p = planOf([{ baseId: ID.ArmorEbonyCuirass, count: 1, enchantmentId: 1234 }]);
check('a player-enchanted piece is swapped and keeps its enchantment (Nate, 4 Oct; tests/gearswap-enchant-harness.js)', p.swaps[0].enchanted === true && p.entries[0].baseId === ID.ArmorSteelCuirassA && p.entries[0].enchantmentId === 1234);
p = G.plan({ entries: [{ baseId: ID.GlassSword, count: 1 }], descOf, classOf: TIERS.classOf, swap: SWAP, idOf: () => 0, isArtifact: () => false });
check('a replacement whose plugin is not loaded keeps the original', p.swaps.length === 0 && p.skipped.unmapped === 1 && p.entries[0].baseId === ID.GlassSword);
p = G.plan({ entries: [{ baseId: ID.GlassSword, count: 1 }], descOf, classOf: () => ({ kind: 'never', family: 'EBONY', why: 'hand override' }), swap: SWAP, idOf, isArtifact: () => false });
check('a hand override (loot-overrides.json) is not swapped', p.swaps.length === 0);
p = G.plan({ entries: [{ baseId: ID.GlassSword, count: 1 }], descOf, classOf: () => ({ kind: 'uniform', family: 'guard' }), swap: SWAP, idOf, isArtifact: () => false });
check('uniforms and trinkets are not swapped', p.swaps.length === 0);
p = planOf([{ baseId: ID.ElvenArrow, count: 40 }, { baseId: ID.IronArrow, count: 10 }, { baseId: ID.SteelArrow, count: 5 }]);
check('arrows above the cap become iron arrows count for count; iron and steel arrows stay', p.entries.some((e) => e.baseId === ID.IronArrow && e.count === 50) && p.entries.some((e) => e.baseId === ID.SteelArrow && e.count === 5) && p.swaps[0].family === 'ammo', p.entries);
check('the ammo list names the vanilla iron arrow and Dawnguard\'s steel bolt only', Object.values(SWAP.ammo).every((m) => m.to === '1397d:Skyrim.esm' || m.to === 'bb3:Dawnguard.esm') && !Object.values(SWAP.ammo).some((m) => /^(IronArrow|SteelArrow|ForswornArrow|FalmerArrow|DraugrArrow|MQ101SteelArrow|boundArrow|DLC1ElvenArrow(Blessed|Blood))$/.test(m.edid)));
check('the message counts the items and says enchanted ones keep their enchantment', /swapped for steel and iron equivalents: 3 items\. Enchanted pieces keep their enchantment\.$/.test(G.message([{ count: 2 }, { count: 1, enchanted: true, carried: { enchantmentId: 1 } }])) && !/plain/.test(G.message([{ count: 1, enchanted: true, carried: { enchantmentId: 1 } }])));
check('wornIn reads the equipment', G.wornIn({ inv: { entries: [{ baseId: 5, worn: true }, { baseId: 6, wornLeft: true }, { baseId: 7 }] } }).get(6) === 'left');

// ---- 3. the runtime, against a stub server ----
const A = 0xff000303, B = 0xff000304;
const store = {
  [A]: { inventory: { entries: [{ baseId: ID.GlassSword, count: 1 }, { baseId: ID.CYRArmorElvenCuirass, count: 1 }, { baseId: ID.IngotEbony, count: 2 }] },
    equipment: { inv: { entries: [{ baseId: ID.GlassSword, worn: true }, { baseId: ID.CYRArmorElvenCuirass, worn: true }] } },
    'private.lastWorn': [ID.GlassSword, ID.CYRArmorElvenCuirass], profileId: 35 },
  [B]: { inventory: { entries: [{ baseId: ID.ArmorEbonyCuirass, count: 1 }] }, equipment: { inv: { entries: [] } }, profileId: 3 },
};
const calls = [], said = [], audits = [], timers = {};
let online = [A];
// The server's own properties (fork PropertyBindingFactory.cpp) and private.* ones; any other name throws there, as
// 'baseId' did on live (3-4 Oct: no container was ever swapped), so it throws here too
const BOUND = new Set(['actorNeighbors', 'angle', 'appearance', 'baseDesc', 'equipment', 'inventory', 'isDead', 'isDisabled', 'isOnline', 'isOpen',
  'locationalData', 'neighbors', 'onlinePlayers', 'percentages', 'pos', 'profileId', 'spawnPoint', 'type', 'worldOrCellDesc', 'idx',
  'consoleCommandsAllowed', 'spawnDelay', 'templateChain', 'lastAnimEvent', 'respawnPercentages']);
const getProp = (a, k) => { if (!BOUND.has(k) && !/^private\./.test(k)) throw new Error(`Property '${k}' doesn't exist`); return (store[a] || {})[k]; };
const mp = {
  get: getProp, set: (a, k, v) => { store[a][k] = v; },
  getDescFromId: (id) => (id >>> 24 === 0xff ? (id & 0xffffff).toString(16) : descOf(id)), getIdFromDesc: idOf,
  callPapyrusFunction: (...args) => calls.push(args),
};
const load = (gearSwap) => require(path.join(SERVER, 'gearswap.js'))({ mp, log: () => {}, audit: (t) => audits.push(t), who: (a) => `P${(a >>> 0).toString(16)}`, personal: (a, t) => said.push([a, t]),
  onlineActors: () => online, every: (n, ms, fn) => { timers[n] = fn; }, cfg: { gearSwap }, registerChatCommand: () => {}, isStaff: (a) => staff.has(a >>> 0),
  recordOf: (id) => (id >>> 0 === CHEST_BASE ? { record: { type: 'CONT', editorId: 'TreasCaveChest' } } : id >>> 0 === BARREL_BASE ? { record: { type: 'ACTI', editorId: 'Barrel' } } : EDID[id >>> 0] ? { record: { editorId: EDID[id >>> 0] } } : null) });
const staff = new Set();
// Each online character logs in (gamemode.js onCharacterReady calls __dboGearSwapLogin)
const loginAll = () => { for (const a of online) globalThis.__dboGearSwapLogin(a); };
const CHEST_BASE = 0x20671, BARREL_BASE = 0x20672;
globalThis.__dboCombatAt = new Map([[A >>> 0, Date.now()]]);
load({ exemptProfiles: [3] });
loginAll();
check('a player in a fight is left for later: nothing taken, no mark', store[A].inventory.entries.some((e) => e.baseId === ID.GlassSword) && !store[A]['private.dboGearSwap']);
globalThis.__dboCombatAt = new Map();
globalThis.__dboIsDowned = (a) => a === A;
loginAll();
check('...and so is a downed one', !store[A]['private.dboGearSwap']);
globalThis.__dboIsDowned = () => false;
globalThis.__dboBeastOriginalRace = (a) => (a === A ? 0x13746 : 0);
loginAll();
check('...and one in a beast form', !store[A]['private.dboGearSwap']);
globalThis.__dboBeastOriginalRace = () => 0;
loginAll();
const inv = store[A].inventory.entries;
check('then the swap: steel sword, CYR leather cuirass, steel ingots, the high-end pieces gone',
  inv.some((e) => e.baseId === ID.SteelSword) && inv.some((e) => e.baseId === ID.CYRArmorLeatherCuirassA) && inv.some((e) => e.baseId === ID.IngotSteel && e.count === 2) && !inv.some((e) => [ID.GlassSword, ID.CYRArmorElvenCuirass, ID.IngotEbony].includes(e.baseId)), inv);
const equips = calls.filter((c) => c[2] === 'EquipItem').map((c) => c[4][0].desc);
check('both worn pieces are put on again as their replacements', equips.length === 2 && equips.includes(descOf(ID.SteelSword)) && equips.includes(descOf(ID.CYRArmorLeatherCuirassA)), equips);
check('the login re-dress remembers the replacements', JSON.stringify(store[A]['private.lastWorn']) === JSON.stringify([ID.SteelSword, ID.CYRArmorLeatherCuirassA]));
check('one message to the player and one audit line per swap', said.length === 1 && said[0][0] === A && /4 items/.test(said[0][1]) && audits.length === 3 && audits.every((t) => /^GEARSWAP P/.test(t)), { said, audits });
check('the character is marked with the version', store[A]['private.dboGearSwap'] && store[A]['private.dboGearSwap'].version === G.VERSION && store[A]['private.dboGearSwap'].swapped === 4);
store[A].inventory.entries.push({ baseId: ID.GlassSword, count: 1 });
loginAll();
check('once only: glass found later is not swapped again (that is the loot cap\'s job)', store[A].inventory.entries.some((e) => e.baseId === ID.GlassSword) && said.length === 1);
online = [A, B];
loginAll();
check('an exempt profile is left alone', store[B].inventory.entries[0].baseId === ID.ArmorEbonyCuirass && !store[B]['private.dboGearSwap']);
load({});
online = [B];
check('offline: nothing happens to a character until it logs in', store[B].inventory.entries[0].baseId === ID.ArmorEbonyCuirass);
loginAll();
check('...and at the first sweep after its login it is swapped', store[B].inventory.entries[0].baseId === ID.ArmorSteelCuirassA && store[B]['private.dboGearSwap']);
const C = 0xff000305;
store[C] = { inventory: { entries: [{ baseId: ID.GlassSword, count: 1 }] }, equipment: { inv: { entries: [] } }, profileId: 40 };
load({ mode: 'log' });
online = [C];
loginAll();
check('mode log changes nothing and marks nothing', store[C].inventory.entries[0].baseId === ID.GlassSword && !store[C]['private.dboGearSwap']);
// staff, through the roles source
const S1 = 0xff000306;
store[S1] = { inventory: { entries: [{ baseId: ID.GlassSword, count: 1 }] }, equipment: { inv: { entries: [] } }, profileId: 50 };
staff.add(S1); load({}); online = [S1]; said.length = 0;
loginAll();
check('a staff character (admin tier from the roles source) is left alone', store[S1].inventory.entries[0].baseId === ID.GlassSword && !store[S1]['private.dboGearSwap'] && !said.length);
// containers, swapped once as they are opened
const CH = 0x0800f001, BAR = 0x0800f002;
store[CH] = { baseDesc: descOf(CHEST_BASE), inventory: { entries: [{ baseId: ID.ArmorEbonyCuirass, count: 1 }, { baseId: ID.ElvenArrow, count: 12 }, { baseId: ID.DA08EbonyBlade, count: 1 }] } };
store[BAR] = { baseDesc: descOf(BARREL_BASE), inventory: { entries: [{ baseId: ID.GlassSword, count: 1 }] } };
audits.length = 0; said.length = 0;
globalThis.__dboGearSwapContainer(CH);
const cinv = store[CH].inventory.entries;
check('an opened container\'s over-cap gear and arrows become steel and iron, its artifact stays',
  cinv.some((e) => e.baseId === ID.ArmorSteelCuirassA) && cinv.some((e) => e.baseId === ID.IronArrow && e.count === 12) && cinv.some((e) => e.baseId === ID.DA08EbonyBlade) && !cinv.some((e) => e.baseId === ID.ArmorEbonyCuirass), cinv);
check('...with an audit line per swap and no message to anyone', audits.length === 2 && audits.every((t) => /^GEARSWAP container 800f001: /.test(t)) && said.length === 0, audits);
cinv.push({ baseId: ID.GlassSword, count: 1 });
globalThis.__dboGearSwapContainer(CH);
check('...once only: a container is marked', cinv.some((e) => e.baseId === ID.GlassSword) && (store[CH]['private.dboGearSwap'] || {}).version === G.VERSION);
globalThis.__dboGearSwapContainer(BAR);
check('something that is not a container (CONT) is never touched', store[BAR].inventory.entries[0].baseId === ID.GlassSword && !store[BAR]['private.dboGearSwap']);
const gm = fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8');
const chain = gm.slice(gm.indexOf('mp.onActivate = (targetId, casterId) => {'), gm.indexOf('if (globalThis.__dboDungeonActivate) {'));
check('the activate chain swaps a container before it opens and never refuses for it', /\n  if \(globalThis\.__dboGearSwapContainer\) globalThis\.__dboGearSwapContainer\(targetId >>> 0\);\n/.test(chain));
check('gamemode hands the module its staff check (isAdmin, the roles source)', /require\(GEARSWAP_JS\)\(\{[^}]*isStaff: isAdmin \}\)/.test(gm));
check('no timer sweeps inventories: the server cannot see an open inventory or container menu (D, 3 Oct)', !Object.keys(timers).length && !/(^|[^.\w])every\(/m.test(fs.readFileSync(path.join(SERVER, 'gearswap.js'), 'utf8')), Object.keys(timers));
check('the login path sweeps each character, beside the rest login', /__dboRestLogin\(a\);[^\n]*\n\s*\/\/[^\n]*\n\s*try \{ if \(globalThis\.__dboGearSwapLogin\) globalThis\.__dboGearSwapLogin\(a\); \}/.test(gm));
// a left-hand weapon goes back in the left hand
const LH = 0xff000307;
store[LH] = { inventory: { entries: [{ baseId: ID.GlassSword, count: 1 }] }, equipment: { inv: { entries: [{ baseId: ID.GlassSword, wornLeft: true }] } }, profileId: 51 };
load({}); calls.length = 0;
globalThis.__dboGearSwapLogin(LH);
const lh = calls.filter((c) => /^EquipItem/.test(c[2]));
check('a left-hand piece is put on again in the left hand (EquipItemEx slot 2)', lh.length === 1 && lh[0][2] === 'EquipItemEx' && lh[0][4][1] === 2 && lh[0][4][0].desc === descOf(ID.SteelSword), lh);
delete globalThis.__dboGearSwapContainer; delete globalThis.__dboGearSwapLogin;
delete globalThis.__dboCombatAt; delete globalThis.__dboIsDowned; delete globalThis.__dboBeastOriginalRace;
console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
