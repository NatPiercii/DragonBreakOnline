// Scripted test for the smelter's firewood in server\regions.js's craft hook (Nate, 2026-10-06: "Firewood is fine. Do 2
// per ingot right now", a stopgap until the charcoal tiers): a craft at a smelter (recipe BNAM CraftingSmelter) burns
// smelting.firewoodPerIngot firewood for each item made; short of it the craft is refused before masterySystem's chain,
// so the materials stay and no credit is earned; firewoodPerIngot 0 turns it off. Woodcutting gives the same Firewood.
// No server and no game: run it from this folder's parent with
//
//   node tests\smelting-firewood-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const REGIONS = path.join(SERVER, 'regions.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smelting-firewood-harness-'));
process.chdir(dir);
for (const f of ['regions.json', 'regions-overrides.json']) fs.copyFileSync(path.join(SERVER, f), f);

let wallClock = 1780000000000;
Date.now = () => wallClock;

const PLUGINS = { 'Skyrim.esm': 0x00, 'BSHeartland.esm': 0x0b };
const BY_INDEX = Object.fromEntries(Object.entries(PLUGINS).map(([k, v]) => [v, k]));
const idOf = (d) => { const [hex, plugin] = String(d).split(':'); if (!(plugin in PLUGINS)) throw new Error(`no plugin ${plugin}`); return ((PLUGINS[plugin] << 24) | parseInt(hex, 16)) >>> 0; };
const descOf = (id) => { const p = BY_INDEX[id >>> 24]; if (!p) throw new Error('no plugin'); return `${(id & 0xffffff).toString(16)}:${p}`; };

// Real recipes: RecipeIngotIron (iron ore -> iron ingot, at the smelter) and RecipeWeaponIronDagger (at the forge). The
// bench keywords are matched by editor id, so the keyword records here carry only that
const IRON_INGOT = ['a30c3:Skyrim.esm', '5ace4:Skyrim.esm', [['71cf3:Skyrim.esm', 1]]];
const IRON_DAGGER = ['ea5f3:Skyrim.esm', '1397e:Skyrim.esm', [['5ace4:Skyrim.esm', 1]]];
const SMELTER_KW = 'a5cce:Skyrim.esm', FORGE_KW = '88105:Skyrim.esm';
const FIREWOOD = '6f993:Skyrim.esm';
const CHARCOAL = '33760:Skyrim.esm';
const bnam = (kw) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, idOf(kw), true); return { type: 'BNAM', data: b }; };
const RECORDS = {
  [idOf(IRON_INGOT[0])]: { type: 'COBJ', editorId: 'RecipeIngotIron', fields: [bnam(SMELTER_KW)] },
  [idOf(IRON_DAGGER[0])]: { type: 'COBJ', editorId: 'RecipeWeaponIronDagger', fields: [bnam(FORGE_KW)] },
  [idOf(SMELTER_KW)]: { type: 'KYWD', editorId: 'CraftingSmelter', fields: [] },
  [idOf(IRON_INGOT[1])]: { type: 'MISC', editorId: 'IngotIron', fields: [] },
  [idOf(FORGE_KW)]: { type: 'KYWD', editorId: 'CraftingSmithingForge', fields: [] },
};

const SMITH = 0x14;
const props = new Map();
const put = (id, p, v) => props.set(id + '|' + p, v);
const inv = (a) => (props.get(a + '|inventory') || { entries: [] }).entries;
const count = (a, desc) => inv(a).filter((e) => e.baseId === idOf(desc)).reduce((n, e) => n + e.count, 0);
const give = (a, desc, n) => { const e = inv(a).map((x) => Object.assign({}, x)); const h = e.find((x) => x.baseId === idOf(desc)); if (h) h.count += n; else e.push({ baseId: idOf(desc), count: n }); put(a, 'inventory', { entries: e }); };
const take = (a, desc, n) => { const e = inv(a).map((x) => Object.assign({}, x)); const h = e.find((x) => x.baseId === idOf(desc)); if (h) h.count -= n; put(a, 'inventory', { entries: e.filter((x) => x.count > 0) }); };
put(SMITH, 'worldOrCellDesc', 'a764b:BSHeartland.esm'); put(SMITH, 'pos', [0, 0, 0]);

const mp = {
  getIdFromDesc: idOf,
  getDescFromId: descOf,
  get: (id, p) => props.get(id + '|' + p),
  set: (id, p, v) => props.set(id + '|' + p, JSON.parse(JSON.stringify(v))),
  lookupEspmRecordById: (id) => (RECORDS[id] ? { record: RECORDS[id], toGlobalRecordId: (local) => local } : null),
};
const credits = [];
let chainVerdict;
const masteryChain = (actorId, itemId, n, recipeId) => { credits.push(recipeId); return chainVerdict; };
mp.onCraft = masteryChain;
// The engine's side: the gamemode decides, then OnFireSuccess swaps the inputs for `n` of the product
const craft = (a, recipe, n) => {
  const r = mp.onCraft(a, idOf(recipe[1]), n, idOf(recipe[0]));
  if (r !== false) { for (const [d, k] of recipe[2]) take(a, d, k * n); give(a, recipe[1], n); }
  return r;
};

const out = { said: [], notices: [], audits: [], logs: [] };
const load = (smelting) => {
  delete require.cache[REGIONS];
  require(REGIONS)({
    mp, log: (...a) => out.logs.push(a.join(' ')), personal: (a, t) => out.said.push([a, t]), audit: (t) => out.audits.push(t),
    who: (a) => `P${a.toString(16)}`, isAdmin: () => false, registerChatCommand: () => {},
    sendPacket: (a, p) => { if (p.customPacketType === 'dboNotice') out.notices.push([a, p.text]); return true; },
    cfg: { regions: { craft: true, tomes: false, adminBypass: true, failOpen: true, defaultPlace: 'skyrim' }, smelting },
  });
};

let failures = 0, checks = 0;
const check = (name, ok, detail) => { checks++; if (!ok) { failures++; console.log(`FAIL ${name}${detail !== undefined ? ': ' + JSON.stringify(detail) : ''}`); } else console.log(`ok   ${name}`); };
const said = () => (out.said.length ? out.said[out.said.length - 1][1] : '');

load(undefined);
give(SMITH, IRON_INGOT[2][0][0], 10);
give(SMITH, FIREWOOD, 5);
give(SMITH, CHARCOAL, 3);
check('a smelt with firewood enough goes on', craft(SMITH, IRON_INGOT, 2) !== false && count(SMITH, IRON_INGOT[1]) === 2, count(SMITH, IRON_INGOT[1]));
check('...and burns 2 firewood per ingot (4 for 2)', count(SMITH, FIREWOOD) === 1, count(SMITH, FIREWOOD));
check('...and earns its mastery credit', credits.length === 1);
check('...and burns 1 charcoal per iron ingot (2 for 2)', count(SMITH, CHARCOAL) === 1, count(SMITH, CHARCOAL));
wallClock += 2000;
const before = count(SMITH, IRON_INGOT[2][0][0]);
check('short of firewood the smelt is refused', craft(SMITH, IRON_INGOT, 1) === false);
check('...with the reason and how many are held', /^Smelting this needs 2 firewood and 1 charcoal for each ingot \(you have 1 firewood, 1 charcoal\)\. Woodcutters make charcoal at the chopping block\. Your materials come back when you close the menu\.$/.test(said()) && out.notices.length === 1, said());
check('...keeping the ore, the firewood and no credit', count(SMITH, IRON_INGOT[2][0][0]) === before && count(SMITH, FIREWOOD) === 1 && credits.length === 1);
check('...and is audited', /^SMELT refused P14 recipe RecipeIngotIron: 1\/2 firewood, 1\/1 charcoal$/.test(out.audits[out.audits.length - 1]), out.audits[out.audits.length - 1]);
check('forge work burns no firewood', craft(SMITH, IRON_DAGGER, 1) !== false && count(SMITH, FIREWOOD) === 1 && credits.length === 2);
give(SMITH, FIREWOOD, 5);
chainVerdict = false;
check('a smelt the mastery chain refuses burns nothing', craft(SMITH, IRON_INGOT, 1) === false && count(SMITH, FIREWOOD) === 6, count(SMITH, FIREWOOD));
chainVerdict = undefined;
put(SMITH, 'inventory', { entries: inv(SMITH).filter((e) => e.baseId !== idOf(FIREWOOD)) });
load({ firewoodPerIngot: 0 });
check('firewoodPerIngot 0 turns it off', craft(SMITH, IRON_INGOT, 1) !== false && count(SMITH, IRON_INGOT[1]) === 2, count(SMITH, IRON_INGOT[1]));
load({ firewoodPerIngot: 3 });
give(SMITH, FIREWOOD, 2);
wallClock += 2000;
check('the rate follows the config', craft(SMITH, IRON_INGOT, 1) === false && /needs 3 firewood and 1 charcoal for each ingot \(you have 2 firewood/.test(said()), said());
// Charcoal alone: with firewood enough but no charcoal the smelt is refused, and woodcutting gives the charcoal
load(undefined);
put(SMITH, 'inventory', { entries: inv(SMITH).filter((e) => e.baseId !== idOf(CHARCOAL)) });
give(SMITH, FIREWOOD, 10);
wallClock += 2000;
check('short of charcoal the smelt is refused', craft(SMITH, IRON_INGOT, 1) === false && /1 charcoal for each ingot \(you have \d+ firewood, 0 charcoal\)/.test(said()), said());
// Woodcutting gives the very item the smelter asks for
const labour = fs.readFileSync(path.join(SERVER, 'labour.js'), 'utf8');
check('woodcutting (labour.js) gives Firewood 6f993:Skyrim.esm', /firewood:\s*'6f993:Skyrim\.esm'/.test(labour) && /giveItem\(a, idOf\(ITEMS\.firewood\), count\)/.test(labour));
check('...and Charcoal 33760:Skyrim.esm', /charcoal:\s*'33760:Skyrim\.esm'/.test(labour) && /giveItem\(a, idOf\(ITEMS\.charcoal\), coal\)/.test(labour));

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures ? 1 : 0);
