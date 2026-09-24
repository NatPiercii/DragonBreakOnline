// Scripted test for lab alchemy (alchemy.js) and the Draught of Revival brewed at a lab (downed.js), against a mock
// api holding the real ingredient effects: the exact recipe with the book read and Alchemist tier 4 gives the Draught
// and takes one of each ingredient; without the book or the tier it gives the ordinary potion (the latter with a hint);
// a pair or a stray report never makes it; the recipe banner, the lab reminder, the downed text, /brew gone, E revive.
// Run it from this folder's parent with
//
//   node tests\alchemy-harness.js
'use strict';
const fs = require('fs');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
process.chdir(SERVER); // alchemy-potions.json resolves by cwd, as on the server

// Exact plugin-name matching; the two DragonBreak-side indices are harness-only, only their consistency matters
const PLUGINS = { 'Skyrim.esm': 0x00, 'BSAssets.esm': 0x0a, 'BSHeartland.esm': 0x0b, 'DragonBreak Online Edits.esp': 0x60, 'Journey to Baan Malur.esp': 0x61 };
const idOf = (d) => { const [hex, plugin] = String(d).split(':'); if (!(plugin in PLUGINS)) throw new Error(`no plugin ${plugin}`); return ((PLUGINS[plugin] << 24) | parseInt(hex, 16)) >>> 0; };

const TROLL_FAT = idOf('3ad72:Skyrim.esm'), FLY_AMANITA = idOf('4da00:Skyrim.esm'), YELLOW_POLYPORE = idOf('6018c7:BSAssets.esm');
const RED_POLYPORE = idOf('6018c6:BSAssets.esm'), BLUE_FLOWER = idOf('77e1c:Skyrim.esm'), GOLD = idOf('f:Skyrim.esm');
const DRAUGHT = idOf('12ae16:DragonBreak Online Edits.esp'), RECIPE_BOOK = idOf('12ae17:DragonBreak Online Edits.esp');
const LAB_BASE = 'bad0c:Skyrim.esm'; // CraftingAlchemyWorkbench

// Effects and base costs as the load order holds them (EFID read through ck-mcp, USSEP winning where it overrides)
const MGEF = {
  '3eb15:Skyrim.esm': ['AlchRestoreHealth', 0.5], '3eb1a:Skyrim.esm': ['AlchFortifyTwoHanded', 0.5], '73f29:Skyrim.esm': ['AlchInfluenceAggUp', 15],
  '90041:Skyrim.esm': ['AlchResistPoison', 0.5], '3eb42:Skyrim.esm': ['AlchDamageHealth', 3], '3eb06:Skyrim.esm': ['AlchFortifyHealRate', 0.1],
  '601946:BSAssets.esm': ['BSKAlchReflectSpell', 0], '3eb01:Skyrim.esm': ['AlchFortifyCarryWeight', 0.15], '73f2b:Skyrim.esm': ['AlchDamageMagickaRate', 0.5],
  '3eb25:Skyrim.esm': ['AlchFortifyConjuration', 0.25], '3eaf3:Skyrim.esm': ['AlchFortifyHealth', 0.35],
  '3eaea:Skyrim.esm': ['AlchResistFire', 0.5], '3eb08:Skyrim.esm': ['AlchFortifyStaminaRate', 0.1],
};
const INGR = {
  [TROLL_FAT]: ['TrollFat', ['90041:Skyrim.esm', '3eb1a:Skyrim.esm', '73f29:Skyrim.esm', '3eb42:Skyrim.esm']],
  [FLY_AMANITA]: ['Mushroom01', ['3eaea:Skyrim.esm', '3eb1a:Skyrim.esm', '73f29:Skyrim.esm', '3eb08:Skyrim.esm']],
  [YELLOW_POLYPORE]: ['BSKCinnabarPolyporeYellow', ['3eb15:Skyrim.esm', '3eb06:Skyrim.esm', '73f29:Skyrim.esm', '601946:BSAssets.esm']],
  [BLUE_FLOWER]: ['MountainFlower01Blue', ['3eb15:Skyrim.esm', '3eb25:Skyrim.esm', '3eaf3:Skyrim.esm', '73f2b:Skyrim.esm']],
};
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const RECORDS = {};
for (const [d, [edid, cost]] of Object.entries(MGEF)) {
  const data = new Uint8Array(152); new DataView(data.buffer).setFloat32(4, cost, true);
  RECORDS[idOf(d)] = { type: 'MGEF', editorId: edid, fields: [{ type: 'DATA', data }] };
}
for (const [id, [edid, effects]] of Object.entries(INGR)) RECORDS[id] = { type: 'INGR', editorId: edid, fields: effects.map((d) => ({ type: 'EFID', data: u32(idOf(d)) })) };
RECORDS[idOf(LAB_BASE)] = { type: 'FURN', editorId: 'CraftingAlchemyWorkbench', fields: [] };
RECORDS[GOLD] = { type: 'MISC', editorId: 'Gold001', fields: [] };

const TABLE = JSON.parse(fs.readFileSync('alchemy-potions.json', 'utf8')).effects;
const potionsOf = (mg) => TABLE[mg].potions.map((p) => idOf(p.id));
const ORDINARY = new Set([...potionsOf('03eb15'), ...potionsOf('03eb1a')]); // Restore Health, Fortify Two-handed
const TWO_HANDED = new Set(potionsOf('03eb1a'));

const BREWER = 0x14, NOVICE = 0x15, STRANGER = 0x16, FALLEN = 0x17, LAB = 0x5000;
const props = new Map();
const put = (id, p, v) => props.set(id + '|' + p, v);
const mastery = (a, rank) => put(a, 'private.mastery', { v: 2, skills: { alchemist: { level: rank * 25, xp: 0, rank } }, order: ['alchemist'] });
const stock = (a) => put(a, 'inventory', { entries: [{ baseId: TROLL_FAT, count: 2 }, { baseId: FLY_AMANITA, count: 2 }, { baseId: YELLOW_POLYPORE, count: 2 }, { baseId: BLUE_FLOWER, count: 1 }, { baseId: GOLD, count: 50 }] });
const count = (a, baseId) => ((props.get(a + '|inventory') || { entries: [] }).entries.filter((e) => e.baseId === baseId).reduce((n, e) => n + e.count, 0));
const total = (a, set) => [...set].reduce((n, id) => n + count(a, id), 0);
for (const a of [BREWER, NOVICE, STRANGER, FALLEN]) { put(a, 'profileId', a); put(a, 'worldOrCellDesc', 'a764b:BSHeartland.esm'); put(a, 'pos', [0, 0, 0]); put(a, 'angle', [0, 0, 0]); }
put(LAB, 'baseDesc', LAB_BASE); put(LAB, 'worldOrCellDesc', 'a764b:BSHeartland.esm'); put(LAB, 'pos', [100, 50, 0]);

const out = { said: [], packets: [], audits: [], logs: [] };
const commands = new Map();
const mp = {
  getIdFromDesc: idOf,
  get: (id, p) => props.get(id + '|' + p),
  set: (id, p, v) => props.set(id + '|' + p, JSON.parse(JSON.stringify(v))),
  lookupEspmRecordById: (id) => (RECORDS[id] ? { record: RECORDS[id], toGlobalRecordId: (local) => local } : null),
};
// The gamemode's own hooks, re-installed before its modules on every reload
let innerActivate = 0;
const baseHooks = () => {
  mp.onActivate = () => { innerActivate++; return true; };
  mp.onDeath = () => undefined;
  mp.onEatItem = () => true;
  mp.onHitDamageAttempt = () => true;
  mp.onHitDamage = () => undefined;
  mp.onSpellHit = () => undefined;
  mp.onSpellCast = () => undefined;
};
const api = (cfg) => ({
  mp, cfg,
  log: (...a) => out.logs.push(a.join(' ')),
  personal: (a, t) => out.said.push([a, t]),
  sendPacket: (a, p) => out.packets.push([a, p]),
  audit: (t) => out.audits.push(t),
  who: (a) => `P${a.toString(16)}`,
  display: (a) => `P${a.toString(16)}`,
  profileOf: (a) => a,
  nameOf: (a) => `P${a.toString(16)}`,
  onlineActors: () => [BREWER, NOVICE, STRANGER, FALLEN],
  every: () => {},
  registerChatCommand: (name, fn, opts) => commands.set(name, { fn, opts }),
});
const CONFIG = JSON.parse(fs.readFileSync('gamemode-config.json', 'utf8'));
const load = (cfg) => {
  commands.clear(); baseHooks();
  for (const f of ['downed.js', 'alchemy.js']) { const p = path.resolve(f); delete require.cache[p]; require(p)(api(cfg)); }
};

let failures = 0, checks = 0;
const check = (name, ok, detail) => { checks++; if (!ok) { failures++; console.log(`FAIL ${name}${detail !== undefined ? ': ' + JSON.stringify(detail) : ''}`); } else console.log(`ok   ${name}`); };
let wallClock = 1780000000000;
Date.now = () => wallClock;
const craft = (a, ids) => { wallClock += 5000; out.said.length = 0; out.packets.length = 0; mp.onCraftUnmatched(a, LAB, 0xff000123, { entries: ids.map((baseId) => ({ baseId, count: 1 })) }); };
const saidTo = (a) => out.said.filter(([x]) => x === a).map(([, t]) => t);
const bannerTo = (a) => out.packets.filter(([x, p]) => x === a && p.customPacketType === 'dboBanner').map(([, p]) => p.text);

load(CONFIG);
check('downed.js and alchemy.js load with the live config', typeof globalThis.__dboLabDraught === 'function' && typeof mp.onCraftUnmatched === 'function', out.logs.filter((l) => /failed|not in/.test(l)));
check('...the config recipe is read (1 recipe)', out.logs.some((l) => /Draught of Revival on \(Alchemist tier 4, 3 lab bases, 1 recipes\)/.test(l)), out.logs);
check('/brew is gone', !commands.has('brew'), [...commands.keys()]);
check('/respawn stays', commands.has('respawn'));

// ---- reading the recipe book ----
mastery(BREWER, 3); mastery(NOVICE, 1); mastery(STRANGER, 4);
out.packets.length = 0;
mp.onReadBook(BREWER, RECIPE_BOOK);
check('the book teaches the recipe', (props.get(BREWER + '|private.dboRecipes') || {}).revive === true);
check('...its banner names the three ingredients', bannerTo(BREWER)[0] === 'You learned the Draught of Revival: mix troll fat, fly amanita and yellow cinnabar polypore at an alchemy lab.', bannerTo(BREWER));
out.packets.length = 0;
mp.onReadBook(NOVICE, RECIPE_BOOK);
check('...below tier 4 it adds the tier it takes', bannerTo(NOVICE)[0] === 'You learned the Draught of Revival: mix troll fat, fly amanita and yellow cinnabar polypore at an alchemy lab. Brewing it takes an Alchemist of tier 4.', bannerTo(NOVICE));

// ---- the lab reminder ----
out.said.length = 0; innerActivate = 0;
mp.onActivate(LAB, BREWER);
check('sitting at a lab reminds a tier 4 brewer of the mix', saidTo(BREWER)[0] === 'You know the Draught of Revival: mix troll fat, fly amanita and yellow cinnabar polypore here.' && innerActivate === 1, saidTo(BREWER));
out.said.length = 0;
mp.onActivate(LAB, NOVICE); mp.onActivate(LAB, STRANGER);
check('...below the tier it adds the tier it takes', saidTo(NOVICE)[0] === 'You know the Draught of Revival: mix troll fat, fly amanita and yellow cinnabar polypore here. Brewing it takes an Alchemist of tier 4.', saidTo(NOVICE));
check('...and says nothing without the book', saidTo(STRANGER).length === 0);
out.packets.length = 0;
mp.onReadBook(NOVICE, RECIPE_BOOK);
check('re-reading the book shows the recipe again', bannerTo(NOVICE)[0] === 'You know the Draught of Revival: mix troll fat, fly amanita and yellow cinnabar polypore at an alchemy lab. Brewing it takes an Alchemist of tier 4.', bannerTo(NOVICE));
check('...and audits the learning only once', out.audits.filter((t) => /^RECIPE P15 /.test(t)).length === 1, out.audits);

// ---- brewing ----
stock(BREWER);
craft(BREWER, [YELLOW_POLYPORE, TROLL_FAT, FLY_AMANITA]);
check('the exact set, the book and tier 4 give the Draught', count(BREWER, DRAUGHT) === 1, props.get(BREWER + '|inventory'));
check('...and take one of each ingredient', count(BREWER, TROLL_FAT) === 1 && count(BREWER, FLY_AMANITA) === 1 && count(BREWER, YELLOW_POLYPORE) === 1);
check('...and no ordinary potion', total(BREWER, ORDINARY) === 0);
check('...the banner says it reaches the pack', /^You brewed a Draught of Revival\. It reaches your pack as you leave the lab\./.test(bannerTo(BREWER)[0] || ''), bannerTo(BREWER));
check('...and it is audited', out.audits.some((t) => /^BREW P14 brewed a Draught of Revival at a lab$/.test(t)));

stock(STRANGER);
craft(STRANGER, [TROLL_FAT, FLY_AMANITA, YELLOW_POLYPORE]);
check('without the book the same set gives the ordinary potion', count(STRANGER, DRAUGHT) === 0 && total(STRANGER, ORDINARY) === 1, props.get(STRANGER + '|inventory'));
check('...one of each ingredient used', count(STRANGER, TROLL_FAT) === 1 && count(STRANGER, FLY_AMANITA) === 1 && count(STRANGER, YELLOW_POLYPORE) === 1);
check('...and nothing hints at a secret recipe', saidTo(STRANGER).length === 1 && /^You brew [^.]+\.$/.test(saidTo(STRANGER)[0]), saidTo(STRANGER));

stock(NOVICE);
craft(NOVICE, [FLY_AMANITA, YELLOW_POLYPORE, TROLL_FAT]);
check('with the book below tier 4 the set gives the ordinary potion', count(NOVICE, DRAUGHT) === 0 && total(NOVICE, ORDINARY) === 1, props.get(NOVICE + '|inventory'));
check('...with the hint in the same message', saidTo(NOVICE).length === 1 && / You know the Draught of Revival, but brewing it takes an Alchemist of tier 4\. This mix made an ordinary potion\.$/.test(saidTo(NOVICE)[0]), saidTo(NOVICE));

stock(BREWER);
craft(BREWER, [TROLL_FAT, FLY_AMANITA]);
check('a pair of the recipe gives Fortify Two-handed, not the Draught', count(BREWER, DRAUGHT) === 0 && total(BREWER, TWO_HANDED) === 1, props.get(BREWER + '|inventory'));
stock(BREWER);
craft(BREWER, [TROLL_FAT, FLY_AMANITA, BLUE_FLOWER]);
check('a different third ingredient gives no Draught', count(BREWER, DRAUGHT) === 0 && total(BREWER, ORDINARY) === 1, props.get(BREWER + '|inventory'));

stock(BREWER);
const before = JSON.stringify(props.get(BREWER + '|inventory'));
craft(BREWER, [TROLL_FAT, FLY_AMANITA, YELLOW_POLYPORE, GOLD]);
check('a report holding a non-ingredient makes nothing', JSON.stringify(props.get(BREWER + '|inventory')) === before && saidTo(BREWER).length === 0);
check('...and is logged', out.logs.some((l) => /not a lab mix; ignored/.test(l)));
craft(BREWER, [TROLL_FAT, FLY_AMANITA, YELLOW_POLYPORE, BLUE_FLOWER]);
check('four ingredients make nothing', JSON.stringify(props.get(BREWER + '|inventory')) === before);
check('...and the player is told why', /^The lab did not recognise that mix/.test(saidTo(BREWER)[0] || ''), saidTo(BREWER));
put(BREWER, 'pos', [5000, 0, 0]);
craft(BREWER, [TROLL_FAT, FLY_AMANITA, YELLOW_POLYPORE]);
check('a mix reported away from the lab makes nothing', JSON.stringify(props.get(BREWER + '|inventory')) === before && count(BREWER, DRAUGHT) === 0 && saidTo(BREWER).length === 0);
check('...and is logged', out.logs.some((l) => /while not at it; ignored/.test(l)));
put(BREWER, 'pos', [0, 0, 0]); put(BREWER, 'worldOrCellDesc', '1:Skyrim.esm');
craft(BREWER, [TROLL_FAT, FLY_AMANITA, YELLOW_POLYPORE]);
check('...as does one from another cell', JSON.stringify(props.get(BREWER + '|inventory')) === before && count(BREWER, DRAUGHT) === 0);
put(BREWER, 'worldOrCellDesc', 'a764b:BSHeartland.esm');

put(BREWER, 'inventory', { entries: [{ baseId: TROLL_FAT, count: 1 }, { baseId: FLY_AMANITA, count: 1 }] });
craft(BREWER, [TROLL_FAT, FLY_AMANITA, YELLOW_POLYPORE]);
check('a missing ingredient makes nothing', count(BREWER, DRAUGHT) === 0 && count(BREWER, TROLL_FAT) === 1 && /do not have/.test(saidTo(BREWER)[0] || ''), saidTo(BREWER));

// ---- the down state and the Draught used by hand ----
put(FALLEN, 'isDead', true);
out.packets.length = 0;
mp.onDeath(FALLEN, 0);
check('the downed text names both ways back', bannerTo(FALLEN)[0] === "You are down. A Priest's healing or a Draught of Revival can bring you back. You wake at the temple in 60 seconds, or say /respawn to go now.", bannerTo(FALLEN));
put(BREWER, 'inventory', { entries: [{ baseId: DRAUGHT, count: 1 }] });
put(FALLEN, 'percentages', { health: 0, magicka: 1, stamina: 1 });
const r = mp.onActivate(FALLEN, BREWER);
check('E on the fallen with the Draught raises them and uses it', r === false && props.get(FALLEN + '|isDead') === false && count(BREWER, DRAUGHT) === 0);

// ---- reloads and config ----
load(CONFIG); load(CONFIG);
out.packets.length = 0; props.delete(STRANGER + '|private.dboRecipes'); innerActivate = 0;
mp.onReadBook(STRANGER, RECIPE_BOOK);
check('after two reloads a read still teaches once', bannerTo(STRANGER).length === 1 && /^You learned/.test(bannerTo(STRANGER)[0]), bannerTo(STRANGER));
stock(STRANGER);
craft(STRANGER, [TROLL_FAT, YELLOW_POLYPORE, FLY_AMANITA]);
check('...and the Draught still brews', count(STRANGER, DRAUGHT) === 1 && total(STRANGER, ORDINARY) === 0);

load({});
check('with no config the default recipe is the same', /1 recipes\)/.test(out.logs.filter((l) => /^downed on/.test(l)).pop()));
stock(STRANGER);
const had = count(STRANGER, DRAUGHT);
craft(STRANGER, [TROLL_FAT, FLY_AMANITA, YELLOW_POLYPORE]);
check('...and brews the Draught', count(STRANGER, DRAUGHT) === had + 1);

load({ downed: { potion: { recipes: [
  [{ id: '3ad72:Skyrim.esm', name: 'troll fat' }, { id: '4da00:Skyrim.esm', name: 'fly amanita' }, { id: '6018c6:BSAssets.esm', name: 'red cinnabar polypore' }],
  [{ id: '3ad72:Skyrim.esm', name: 'troll fat' }, { id: ['1', 'NotInTheLoadOrder.esp'].join(':'), name: 'nothing' }],
  [{ id: '3ad72:Skyrim.esm', name: 'troll fat' }, { id: '3ad72:Skyrim.esm', name: 'troll fat' }],
] } } });
check('recipes with an unresolved or repeated id are dropped', /1 recipes\)/.test(out.logs.filter((l) => /^downed on/.test(l)).pop()));
check('...the red polypore alternative matches when configured', globalThis.__dboLabDraught(STRANGER, [RED_POLYPORE, TROLL_FAT, FLY_AMANITA]) && globalThis.__dboLabDraught(STRANGER, [RED_POLYPORE, TROLL_FAT, FLY_AMANITA]).potion === DRAUGHT);
check('...and the yellow one then does not', globalThis.__dboLabDraught(STRANGER, [YELLOW_POLYPORE, TROLL_FAT, FLY_AMANITA]) === null);

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures ? 1 : 0);
