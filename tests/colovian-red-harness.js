// The red Colovian Fine Clothes from BSAssets.esm (CYR_ColovianNobleClothes01, 602974:BSAssets.esm) leave a woman
// mostly invisible: their armor addon CYR_ColovianNoble01AA (602976:BSAssets.esm) names a FIRST-PERSON mesh,
// bscyrodiil\Clothes\noble\1stPerson_nobleF_0.nif, as the female world model, so in third person only her arms are
// drawn (#bugs 1557441315153645628, 7 Oct 2026: Reyla Feign #FXWY wore them 16:49-16:53Z). The BSHeartland twin
// CYRColovianNobleClothes01 (877b8:BSHeartland.esm) has the same name and red cloth and uses noble_F_1.nif. Until a
// plugin override points the addon at noble_F_0.nif (Nate's PC), the broken copy is kept from spreading:
//   1. loot-overrides.json: never loot (loottiers.js), while the twin stays loot;
//   2. regions-overrides.json: the loom recipe DBOLOOM_CYR_ColovianNobleClothes01 (85f:DragonBreak Nexus Patches.esp)
//      is made nowhere, while the twin's DBOLOOM_CYRColovianNobleClothes01 (885) still is; an admin may still make it;
// The other ways an item reaches a player are checked to stay shut: no other recipe makes it, nothing swaps to it, and
// no spawn, camp, dungeon, faction, Ayleid table or starter kit names it. A copy a player already owns stays theirs (the
// login and container sweeps leave a hand never-loot item alone); staff swap those for the twin.
// No server and no game:   node tests/colovian-red-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
let fails = 0, checks = 0;
const ok = (c, what, got) => { checks++; console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got).slice(0, 400)}`); if (!c) fails++; };

const RED = '602974:BSAssets.esm', TWIN = '877b8:BSHeartland.esm';
const RED_RECIPE = '85f:DragonBreak Nexus Patches.esp', TWIN_RECIPE = '885:DragonBreak Nexus Patches.esp';
const LINEN = 'db5d2:Skyrim.esm';

// ---- 1. loot --------------------------------------------------------------------------------------------------------
const MATERIALS = read('loot-materials.json'), FACTION = read('faction-gear.json'), OVERRIDES = read('loot-overrides.json'), LOOT = read('loot.json').pools;
const inArmor = (d) => (LOOT.armor || []).some((it) => String(it.id).toLowerCase() === d.toLowerCase());
ok(inArmor(RED) && inArmor(TWIN), 'both Colovian Fine Clothes sit in loot.json\'s armor pool, so the material check decides them');
for (const cap of [undefined, 'none']) {
  const T = require(path.join(ROOT, 'loottiers.js'))({ materials: MATERIALS, factionGear: FACTION, overrides: OVERRIDES, cfg: cap ? { cap } : {} });
  const c = T.classOf(RED);
  ok(c.kind === 'never' && !T.lootable(RED) && /first-person/i.test(c.why || ''), `the red BSAssets copy is never loot (cap ${cap || 'default'})`, c);
  ok(T.lootable(TWIN), `the BSHeartland twin is still loot (cap ${cap || 'default'})`, T.classOf(TWIN));
}

// ---- 1b. the other sources stay shut, and an owned copy is left alone ------------------------------------------------
const mentions = (f) => { const t = fs.readFileSync(path.join(ROOT, f), 'utf8').toLowerCase(); return t.includes('602974:bsassets.esm') || t.includes('cyr_coloviannobleclothes01'); };
const GIVERS = ['gear-swap.json', 'faction-gear.json', 'faction-weapons.json', 'ayleid-loot.json', 'NPC-Spawns.json', 'owned-spawns.json',
  'dungeons.json', 'expeditions.json', 'wildlife.json', 'gamemode-config.json'];
const named = GIVERS.filter((f) => fs.existsSync(path.join(ROOT, f)) && mentions(f));
ok(named.length === 0, 'no swap, spawn, camp, dungeon, faction, Ayleid table or starter kit names the red copy', named);
const REGIONS = read('regions.json');
const makers = Object.entries(REGIONS.recipes || {}).filter(([, r]) => String((r && r.item) || '').toLowerCase() === RED.toLowerCase()).map(([k]) => k);
ok(makers.length === 1 && makers[0].toLowerCase() === RED_RECIPE.toLowerCase(), 'recipe 85f is the one recipe that makes the red copy', makers);
{
  const T = require(path.join(ROOT, 'loottiers.js'))({ materials: MATERIALS, factionGear: FACTION, overrides: OVERRIDES, cfg: {} });
  const G = require(path.join(ROOT, 'gearswap.js'));
  const p = G.plan({ entries: [{ baseId: 0x0a602974, count: 1, worn: true }], descOf: () => RED, classOf: T.classOf, swap: read('gear-swap.json'),
    idOf: () => 0x00012e49, isArtifact: () => false });
  ok(p.swaps.length === 0 && p.entries.length === 1 && p.entries[0].baseId === 0x0a602974, 'a copy a player owns is left as it is by the gear swap (staff swap it for the twin)', p);
}
const CATALOG = read('admin-items.json');
const row = (d) => { for (const c of CATALOG.categories || []) for (const it of c.items || []) if (String(it[0]).toLowerCase() === d.toLowerCase()) return it; return null; };
ok(String((row(TWIN) || [])[1]) === 'Colovian Fine Clothes', 'the BSHeartland twin is in the F7 catalog under its own name', row(TWIN));

// ---- 2. the loom (the real regions.js over the real regions.json and regions-overrides.json) ------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colovian-red-harness-'));
process.chdir(dir);
for (const f of ['regions.json', 'regions-overrides.json']) fs.copyFileSync(path.join(ROOT, f), f);
const PLUGINS = { 'Skyrim.esm': 0x00, 'BSAssets.esm': 0x0a, 'BSHeartland.esm': 0x0b, 'DragonBreak Nexus Patches.esp': 0x68 };
const BY_INDEX = Object.fromEntries(Object.entries(PLUGINS).map(([k, v]) => [v, k]));
const idOf = (d) => { const [hex, plugin] = String(d).split(':'); if (!(plugin in PLUGINS)) throw new Error(`no plugin ${plugin}`); return ((PLUGINS[plugin] << 24) | parseInt(hex, 16)) >>> 0; };
const descOf = (id) => { const p = BY_INDEX[id >>> 24]; if (!p) throw new Error('no plugin'); return `${(id & 0xffffff).toString(16)}:${p}`; };
const TAILOR = 0x14, ADMIN = 0x15;
const props = new Map();
const put = (id, p, v) => props.set(id + '|' + p, v);
const inv = (a) => (props.get(a + '|inventory') || { entries: [] }).entries;
const count = (a, desc) => inv(a).filter((e) => e.baseId === idOf(desc)).reduce((n, e) => n + e.count, 0);
const give = (a, desc, n) => { const e = inv(a).map((x) => Object.assign({}, x)); const h = e.find((x) => x.baseId === idOf(desc)); if (h) h.count += n; else e.push({ baseId: idOf(desc), count: n }); put(a, 'inventory', { entries: e }); };
const take = (a, desc, n) => { const e = inv(a).map((x) => Object.assign({}, x)); const h = e.find((x) => x.baseId === idOf(desc)); if (h) h.count -= n; put(a, 'inventory', { entries: e.filter((x) => x.count > 0) }); };
const mp = {
  getIdFromDesc: idOf, getDescFromId: descOf,
  get: (id, p) => props.get(id + '|' + p),
  set: (id, p, v) => props.set(id + '|' + p, JSON.parse(JSON.stringify(v))),
  lookupEspmRecordById: () => null,
  callPapyrusFunction: () => null,
};
const credits = [];
mp.onCraft = (actorId, itemId, n, recipeId) => { credits.push([actorId, recipeId]); return undefined; };
const said = [];
const api = {
  mp, cfg: { regions: { craft: true, tomes: true, adminBypass: true, failOpen: true, defaultPlace: 'skyrim' } },
  log: () => {}, personal: (a, t) => said.push([a, t]), system: (a, t) => said.push([a, t]), audit: () => {},
  display: (a) => `P${a.toString(16)}`, who: (a) => `P${a.toString(16)}`, isAdmin: (a) => a === ADMIN,
  sendPacket: () => true, registerChatCommand: () => {}, onUi: () => {}, every: () => {}, onlineActors: () => [TAILOR, ADMIN],
};
let wallClock = 1790000000000;
Date.now = () => wallClock;
delete require.cache[path.join(ROOT, 'regions.js')];
require(path.join(ROOT, 'regions.js'))(api);
// The engine's side: the gamemode decides, then the inputs become the product (1 linen wrap stands for the inputs)
const craft = (a, recipe, product) => {
  const r = mp.onCraft(a, idOf(product), 1, idOf(recipe));
  if (r !== false) { take(a, LINEN, 1); give(a, product, 1); }
  return r;
};
for (const a of [TAILOR, ADMIN]) { put(a, 'worldOrCellDesc', 'a764b:BSHeartland.esm'); put(a, 'pos', [0, 0, 0]); give(a, LINEN, 3); }

const c0 = credits.length;
ok(craft(TAILOR, RED_RECIPE, RED) === false && count(TAILOR, RED) === 0 && count(TAILOR, LINEN) === 3 && credits.length === c0,
  'a tailor in Bruma cannot weave the red BSAssets Colovian Fine Clothes; the materials stay and no credit is given', { have: count(TAILOR, RED), linen: count(TAILOR, LINEN), said: said.slice(-1) });
ok(/cannot be made anywhere/.test((said.filter((s) => s[0] === TAILOR).pop() || [])[1] || ''), 'and is told the design is made nowhere', said.slice(-1));
// regions.json lists recipe 85f since the PC's 9 Oct rebuild, so the refusal names the clothes and the loom
ok(/^Colovian Fine Clothes cannot be made anywhere\. Your materials return when you leave the loom\.$/.test((said.filter((s) => s[0] === TAILOR).pop() || [])[1] || ''),
  'the refusal names the clothes and the loom', said.slice(-1));
wallClock += 2000;
const c1 = credits.length;
ok(craft(TAILOR, TWIN_RECIPE, TWIN) !== false && count(TAILOR, TWIN) === 1 && credits.length === c1 + 1, 'the same-looking BSHeartland twin is still woven, with credit');
ok(globalThis.__dboRegions.recipeOk(ADMIN, idOf(RED), idOf(RED_RECIPE)).ok, 'an admin may still make the red copy (admin bypass)');

console.log(`\n${checks - fails}/${checks} passed${fails ? `, ${fails} FAILED` : ''}`);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* the temp folder stays */ }
process.exit(fails ? 1 : 0);
