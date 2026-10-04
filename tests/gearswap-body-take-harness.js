// DORMANT: no take from a body reaches the server today (the engine refuses a take from a ref the taker does not occupy,
// and the client blocks activation of actors; R-swapdodge, 4 Oct); this tests the safety net for a fork that opens bodies.
// Scripted test for gearswap.js's body take (Nate, 4 Oct 2026: NPC bodies outside a dungeon lease opened with their full
// kit, and a creature's corpse in a lease keeps its arrows and ingots). The player's game shows its own copy of an actor's
// inventory, so the server swaps at the take: a take from a body that is not a player's, of gear, an ingot, an ore or an
// arrow above the cap, is refused, the body's server copy loses what was taken and the pack gets the swap's replacement.
// Against a stub server, with the real gear-swap.json and loottiers.js. Run from this folder's parent:
//   node tests/gearswap-body-take-harness.js
'use strict';
const fs = require('fs');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const PLUG = { 0: 'Skyrim.esm', 7: 'BSAssets.esm', 8: 'BSHeartland.esm' };
const descOf = (id) => `${((id >>> 0) & 0xffffff).toString(16)}:${PLUG[(id >>> 0) >>> 24] || 'X.esp'}`;
const idOf = (desc) => { const m = /^([0-9a-f]+):(.+)$/i.exec(String(desc)); if (!m) return 0; const top = Object.keys(PLUG).find((k) => PLUG[k].toLowerCase() === m[2].toLowerCase()); return top === undefined ? 0 : ((Number(top) << 24) | parseInt(m[1], 16)) >>> 0; };
const ID = {
  ElvenArrow: 0x139bd, IronArrow: 0x1397d, SteelArrow: 0x1397f, IngotIMoonstone: 0x5ad9f, IngotDwarven: 0xdb8a2, OreMoonstone: 0x5ace0, IngotSteel: 0x5ace5, BSKIngotAdamantium: 0x07602099,
  GlassSword: 0x139a9, SteelSword: 0x13989, IronSword: 0x12eb7, DA08EbonyBlade: 0x4a38f, Gold: 0xf, DragonBone: 0x3ada4, BSKIngotMeteoricIron: 0x07601c91, BSKOreMeteoricIron: 0x07601c92, OreIron: 0x71cf3,
};
const EDID = Object.fromEntries(Object.entries(ID).map(([k, v]) => [v >>> 0, k]));

const BODY = 0xff000500, PLAYER = 0xff000303, STAFF = 0xff000304, EXEMPT = 0xff000305, PBODY = 0xff000306, CHEST = 0x0800f001;
const store = {};
const reset = () => {
  store[BODY] = { type: 'MpActor', profileId: -1, inventory: { entries: [{ baseId: ID.ElvenArrow, count: 5 }, { baseId: ID.IngotDwarven, count: 2 }, { baseId: ID.IngotIMoonstone, count: 2 }, { baseId: ID.OreMoonstone, count: 3 }, { baseId: ID.GlassSword, count: 1 }, { baseId: ID.IronSword, count: 1 }, { baseId: ID.BSKIngotAdamantium, count: 1 }, { baseId: ID.DA08EbonyBlade, count: 1 }, { baseId: ID.DragonBone, count: 2 }, { baseId: ID.BSKIngotMeteoricIron, count: 1 }, { baseId: ID.BSKOreMeteoricIron, count: 2 }] } };
  store[PLAYER] = { type: 'MpActor', profileId: 30, inventory: { entries: [{ baseId: ID.IronArrow, count: 10 }, { baseId: ID.Gold, count: 40 }] } };
  store[STAFF] = { type: 'MpActor', profileId: 4, inventory: { entries: [] } };
  store[EXEMPT] = { type: 'MpActor', profileId: 7, inventory: { entries: [] } };
  store[PBODY] = { type: 'MpActor', profileId: 31, inventory: { entries: [{ baseId: ID.GlassSword, count: 1 }] } };
  store[CHEST] = { type: 'MpObjectReference', profileId: -1, inventory: { entries: [{ baseId: ID.GlassSword, count: 1 }] } };
};
reset();
const said = [], audits = [], logs = [];
const mp = {
  get: (a, k) => { const s = store[a >>> 0]; if (!s) throw new Error('no form'); if (!(k in s) && !/^private\./.test(k)) throw new Error(`no property ${k}`); return s[k]; },
  set: (a, k, v) => { store[a >>> 0][k] = v; },
  getDescFromId: descOf, getIdFromDesc: idOf, callPapyrusFunction: () => {},
};
const staff = new Set([STAFF >>> 0]);
const load = (gearSwap) => require(path.join(SERVER, 'gearswap.js'))({ mp, log: (...a) => logs.push(a.join(' ')), audit: (t) => audits.push(t), who: (a) => `P${(a >>> 0).toString(16)}`, personal: (a, t) => said.push([a >>> 0, t]),
  onlineActors: () => [PLAYER], every: () => {}, cfg: { gearSwap }, registerChatCommand: () => {}, isStaff: (a) => staff.has(a >>> 0),
  recordOf: (id) => (EDID[id >>> 0] ? { record: { type: /Arrow/.test(EDID[id >>> 0]) ? 'AMMO' : /Ingot/.test(EDID[id >>> 0]) ? 'MISC' : 'WEAP', editorId: EDID[id >>> 0], fields: [] }, toGlobalRecordId: (x) => x } : null) });
const tick = () => new Promise((r) => setTimeout(r, 5));
const count = (who, base) => (store[who].inventory.entries || []).filter((e) => (e.baseId >>> 0) === base).reduce((n, e) => n + e.count, 0);

(async () => {
  load({ exemptProfiles: [7] });
  const take = (src, actor, base, n) => globalThis.__dboGearSwapTake(src, actor, base, n);

  // ---- arrows, ingots and gear above the cap ----
  check('a take of Elven arrows from an NPC body is refused (handled here)', take(BODY, PLAYER, ID.ElvenArrow, 3) === true);
  await tick();
  check('...the body loses those 3, the pack gets 3 iron arrows on its own iron stack', count(BODY, ID.ElvenArrow) === 2 && count(PLAYER, ID.IronArrow) === 13 && count(PLAYER, ID.ElvenArrow) === 0
    && store[PLAYER].inventory.entries.filter((e) => e.baseId === ID.IronArrow).length === 1, store[PLAYER].inventory.entries);
  check('...with an audit line and a word to the player', audits.some((t) => t === 'GEARSWAP take Pff000303 from body ff000500: 3 x ElvenArrow -> IronArrow') && said.some(([a, t]) => a === PLAYER && /^To match the loot rules, .*Arrow x3 from the body became .*Iron Arrow x3\.$/.test(t)), { audits, said });
  check('Dwarven metal ingots, smelted from scrap, are an ordinary take: kept like a mined ore (Nate, 4 Oct: "Keep them (crafted, like mined ores)")', take(BODY, PLAYER, ID.IngotDwarven, 2) === false);
  check('refined moonstone and moonstone ore, which players mine, are ordinary takes (Nate, 4 Oct: "Keep mined ores, swap only gear")', take(BODY, PLAYER, ID.IngotIMoonstone, 2) === false && take(BODY, PLAYER, ID.OreMoonstone, 3) === false);
  check('Adamantium (Beyond Skyrim) is swapped the same way', take(BODY, PLAYER, ID.BSKIngotAdamantium, 1) === true);
  await tick();
  check('...for a steel ingot', count(PLAYER, ID.IngotSteel) === 1 && count(BODY, ID.BSKIngotAdamantium) === 0);
  // Meteoric Iron is mined (the Bleak-Frost Mine; Nate, 4 Oct): kept out of loot (loottiers.js LOOT_ONLY_METALS), never swapped
  check('Meteoric Iron, ingot or ore, is never swapped at a take: an ordinary take', take(BODY, PLAYER, ID.BSKIngotMeteoricIron, 1) === false && take(BODY, PLAYER, ID.BSKOreMeteoricIron, 2) === false);
  {
    const G = require(path.join(SERVER, 'gearswap.js'));
    const SWAP = JSON.parse(fs.readFileSync(path.join(SERVER, 'gear-swap.json'), 'utf8'));
    const TIERS = require(path.join(SERVER, 'loottiers.js'))({ materials: JSON.parse(fs.readFileSync(path.join(SERVER, 'loot-materials.json'), 'utf8')), swap: SWAP });
    const p = G.plan({ entries: [{ baseId: ID.BSKIngotMeteoricIron, count: 5 }, { baseId: ID.BSKOreMeteoricIron, count: 8 }, { baseId: ID.IngotIMoonstone, count: 4 }, { baseId: ID.OreMoonstone, count: 6 }, { baseId: ID.IngotDwarven, count: 1 }, { baseId: ID.BSKIngotAdamantium, count: 1 }], descOf, classOf: TIERS.classOf, swap: SWAP, idOf, isArtifact: () => false, edidOf: (id) => EDID[id >>> 0] || '' });
    check('a carried or stored Meteoric, moonstone or Dwarven ingot or ore is not swapped (the plan the login and container sweeps use); an Adamantium ingot beside them is',
      p.swaps.length === 1 && p.swaps[0].edid === 'BSKIngotAdamantium' && p.entries.some((e) => e.baseId === ID.IngotDwarven && e.count === 1) && p.entries.some((e) => e.baseId === ID.IngotIMoonstone && e.count === 4) && p.entries.some((e) => e.baseId === ID.OreMoonstone && e.count === 6) && p.entries.some((e) => e.baseId === ID.BSKIngotMeteoricIron && e.count === 5) && p.entries.some((e) => e.baseId === ID.BSKOreMeteoricIron && e.count === 8), p.swaps);
    check('...and neither Meteoric Iron nor the Dwarven ingot is on gear-swap.json\'s metals, yet loottiers keeps both out of loot', !SWAP.metals['601c91:bsassets.esm'] && !SWAP.metals['601c92:bsassets.esm'] && !SWAP.metals['db8a2:skyrim.esm'] && TIERS.aboveCap('601c91:BSAssets.esm', 'metal').lootOnly === true && TIERS.aboveCap('db8a2:Skyrim.esm', 'metal').lootOnly === true);
  }
  check('a slain dragon\'s bone is never swapped at a take: its body is the one source (Nate, 2026-09-30)', take(BODY, PLAYER, ID.DragonBone, 2) === false);
  {
    const G = require(path.join(SERVER, 'gearswap.js'));
    const SWAP = JSON.parse(fs.readFileSync(path.join(SERVER, 'gear-swap.json'), 'utf8'));
    const DM = JSON.parse(fs.readFileSync(path.join(SERVER, 'dragon-materials.json'), 'utf8'));
    const TIERS = require(path.join(SERVER, 'loottiers.js'))({ materials: JSON.parse(fs.readFileSync(path.join(SERVER, 'loot-materials.json'), 'utf8')), swap: SWAP });
    const norm = require(path.join(SERVER, 'loottiers.js')).normDesc;
    const onList = (DM.materials || []).filter((d) => SWAP.metals[norm(d)] || SWAP.ammo[norm(d)] || SWAP.items[norm(d)]);
    check('no dragon material (dragon-materials.json) is on any of the swap\'s lists, so no version bump or first container open sweeps a dragon\'s bones to steel', (DM.materials || []).length >= 2 && !onList.length, onList);
    const p = G.plan({ entries: [{ baseId: ID.DragonBone, count: 3 }, { baseId: 0x3ada3, count: 2 }], descOf, classOf: TIERS.classOf, swap: SWAP, idOf, isArtifact: () => false, edidOf: (id) => EDID[id >>> 0] || '' });
    check('...the sweeps\' plan keeps dragon bone and scales as they are', p.swaps.length === 0 && p.entries.length === 2, p.swaps);
    const lc = globalThis.__dboGearSwapLoot([{ baseId: ID.DragonBone, count: 3 }, { baseId: ID.IngotDwarven, count: 1 }, { baseId: ID.IngotIMoonstone, count: 1 }]);
    check('...and a slain dragon\'s body hands them over through the loot cap, while the cap keeps Dwarven and moonstone ingots back', lc && lc.entries.length === 1 && lc.entries[0].baseId === ID.DragonBone && lc.entries[0].count === 3 && lc.dropped.length === 2, lc);
  }
  check('a glass sword from a body becomes a steel sword', take(BODY, PLAYER, ID.GlassSword, 1) === true);
  await tick();
  check('...in the pack, gone from the body', count(PLAYER, ID.SteelSword) === 1 && count(BODY, ID.GlassSword) === 0 && count(PLAYER, ID.GlassSword) === 0);

  // ---- what goes ahead untouched ----
  check('an iron sword is an ordinary take (not handled here)', take(BODY, PLAYER, ID.IronSword, 1) === false);
  check('an artifact is never swapped: an ordinary take', take(BODY, PLAYER, ID.DA08EbonyBlade, 1) === false);
  check('a staff character takes what it takes', take(BODY, STAFF, ID.ElvenArrow, 1) === false);
  check('an exempt profile too', take(BODY, EXEMPT, ID.ElvenArrow, 1) === false);
  check('a player\'s body is its owner\'s things (gamemode.js __dboLootBody), never swapped here', take(PBODY, PLAYER, ID.GlassSword, 1) === false);
  check('a container is the container sweep\'s, not this', take(CHEST, PLAYER, ID.GlassSword, 1) === false);
  check('a count below 1 or a missing form is not handled', take(BODY, PLAYER, ID.ElvenArrow, 0) === false && take(0xff0009ff, PLAYER, ID.ElvenArrow, 1) === false);

  // ---- races and modes ----
  reset(); audits.length = 0;
  check('a take of more than the body holds is still refused at once...', take(BODY, PLAYER, ID.ElvenArrow, 9) === true);
  await tick();
  check('...and gives nothing when the body no longer holds it (another player took it first)', count(PLAYER, ID.IronArrow) === 10 && count(BODY, ID.ElvenArrow) === 5 && !audits.length);
  reset(); load({ mode: 'log' });
  check('mode log lets the take go ahead and changes nothing', take(BODY, PLAYER, ID.ElvenArrow, 1) === false && count(BODY, ID.ElvenArrow) === 5 && logs.some((l) => /would swap a take/.test(l)));
  load({ mode: 'off' });
  check('mode off: nothing', take(BODY, PLAYER, ID.ElvenArrow, 1) === false);
  load({ bodies: false });
  check('gearSwap.bodies false: nothing', take(BODY, PLAYER, ID.ElvenArrow, 1) === false);

  // ---- the take chain ----
  const gm = fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8');
  const hook = gm.slice(gm.indexOf('const takeHook = (sourceId, actorId, baseId, count, ...rest) => {'), gm.indexOf('takeHook.__dbo = true;'));
  const iGuard = hook.indexOf('__dboTakeGuard'), iDragon = hook.indexOf('dragonTakeRefused('), iSwap = hook.indexOf('__dboGearSwapTake('), iPrev = hook.indexOf('const prev = globalThis.__dboPrevTake');
  check('gamemode.js asks the body take after the item guards (the body holds what is taken) and the dragon check, before the rest of the chain, and refuses on true',
    iGuard > 0 && iDragon > iGuard && iSwap > iDragon && iPrev > iSwap && /__dboGearSwapTake\([^\n]*=== true\) return false;/.test(hook), { iGuard, iDragon, iSwap, iPrev });

  delete globalThis.__dboGearSwapTake; delete globalThis.__dboGearSwapContainer; delete globalThis.__dboGearSwapLogin;
  console.log(failures ? `${failures} FAILED` : 'all checks passed');
  process.exit(failures ? 1 : 0);
})();
