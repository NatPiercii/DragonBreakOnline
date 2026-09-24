// Scripted test for server\regions.js and the province filter in server\spells.js: loads both real modules with a
// mock gamemode api over the real regions.json, regions-overrides.json and spell-tomes.json, and walks where a place
// belongs, the craft gate (a refused craft keeps the materials and earns no mastery credit), the Synod tome shop's
// Cyrodiil stock, admin bypass and /region test, and hand overrides applied without a reload.
// No server and no game: run it from this folder's parent with
//
//   node tests\regions-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const REGIONS = path.join(SERVER, 'regions.js');
const SPELLS = path.join(SERVER, 'spells.js');

// Real places: the Synod Conclave, Bruma's worldspace, Tamriel, Breezehome, Solstheim, the Hub, Vvardenfell,
// a Baan Malur hut no door reaches, and a Survival Mode marker cell no table knows
const SYNOD_CELL = '20ff:BSHeartland.esm', BRUMA_WORLD = 'a764b:BSHeartland.esm', TAMRIEL_WORLD = '3c:Skyrim.esm';
const BREEZEHOME_CELL = '165a8:Skyrim.esm', SOLSTHEIM_WORLD = '800:Dragonborn.esm', HUB_WORLD = '17482:DragonBreak Hub.esp';
const VVARDENFELL_WORLD = 'd28ad3:Journey to Baan Malur.esp', BAAN_HUT_CELL = '2e734:Journey to Baan Malur.esp';
const SURVIVAL_CELL = '861:ccQDRSSE001-SurvivalMode.esl';
// Real recipes: [recipe desc, product desc, [[input desc, count]...]]
const IRON = ['a30c3:Skyrim.esm', '5ace4:Skyrim.esm', [['71cf3:Skyrim.esm', 1]]]; // RecipeIngotIron, common
const GLASS = ['dca0f:Skyrim.esm', '13939:Skyrim.esm', [['800e4:Skyrim.esm', 3], ['db5d2:Skyrim.esm', 1], ['5ada1:Skyrim.esm', 4], ['5ad9f:Skyrim.esm', 2]]]; // RecipeArmorGlassCuirass, skyrim+solstheim
const FORSWORN = ['3f1ef:Immersive Weapons.esp', 'cee9e:Skyrim.esm', [['6bc0a:Skyrim.esm', 1], ['6f993:Skyrim.esm', 1]]]; // IWRecipeAmmoForswornArrow, skyrim
const AYLEID = ['1dff:Immersive Weapons.esp', '1dfe:Immersive Weapons.esp', [['5ad9e:Skyrim.esm', 1], ['5ad9f:Skyrim.esm', 2], ['5ada0:Skyrim.esm', 1], ['5ada1:Skyrim.esm', 2], ['800e4:Skyrim.esm', 2]]]; // IWRecipeWeaponAyleidGreatsword, cyrodiil
const DAEDRIC = ['dd993:Skyrim.esm', '1396b:Skyrim.esm', [['800e4:Skyrim.esm', 3], ['5ad9d:Skyrim.esm', 5], ['3ad5b:Skyrim.esm', 1]]]; // RecipeArmorDaedricCuirass, cyrodiil+skyrim
const STAFF = ['17737:Dragonborn.esm', '4dee3:Skyrim.esm', [['17749:Dragonborn.esm', 2], ['be11f:Skyrim.esm', 1]]]; // DLC2RecipeStaffLightningBolt, solstheim by its bench
const TEMPER = ['1094d4:Skyrim.esm', 'f71cf:Skyrim.esm', [['5ada0:Skyrim.esm', 1]]]; // TemperMQ203AkaviriKatana4, never listed
// Real tomes (book desc)
const SPARKS_BOOK = '9cd53:Skyrim.esm', FROSTFLAMES_BOOK = '7232e:BSHeartland.esm', FIREBOLT_BOOK = 'a26fd:Skyrim.esm';
const INCINERATE_BOOK = '10f7f4:Skyrim.esm', ASHSHELL_BOOK = '177ac:Dragonborn.esm', SKELETON_BOOK = '2923:DragonBreak.esp';
const GLASS_ARMOR = GLASS[1], FORSWORN_ARROW = FORSWORN[1];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regions-harness-'));
process.chdir(dir);
for (const f of ['regions.json', 'regions-overrides.json', 'skills.json', 'spell-tomes.json']) fs.copyFileSync(path.join(SERVER, f), f);
const OVR_BASE = JSON.parse(fs.readFileSync('regions-overrides.json', 'utf8'));
let mtime = Math.floor(Date.now() / 1000);
const writeOverrides = (extra, raw) => {
  fs.writeFileSync('regions-overrides.json', raw !== undefined ? raw : JSON.stringify(Object.assign({}, OVR_BASE, extra)));
  mtime += 10; fs.utimesSync('regions-overrides.json', mtime, mtime);
  wallClock += 2100;
};
const DATA = JSON.parse(fs.readFileSync('regions.json', 'utf8'));
const TOMES_JSON = JSON.parse(fs.readFileSync('spell-tomes.json', 'utf8')).tomes;

let wallClock = 1780000000000;
Date.now = () => wallClock;

// Exact plugin-name matching, like the server's FormDesc::ToFormId; an ESL sits in the 0xfe space
const PLUGINS = { 'Skyrim.esm': 0x00, 'Update.esm': 0x01, 'Dawnguard.esm': 0x02, 'HearthFires.esm': 0x03, 'Dragonborn.esm': 0x04, 'BSAssets.esm': 0x0a, 'BSHeartland.esm': 0x0b, 'Journey to Baan Malur.esp': 0x0c, 'DragonBreak Hub.esp': 0x38, 'Immersive Weapons.esp': 0x3b, 'DragonBreak.esp': 0x60 };
const ESL = { 'ccQDRSSE001-SurvivalMode.esl': 0x001 };
const BY_INDEX = Object.fromEntries(Object.entries(PLUGINS).map(([k, v]) => [v, k]));
const BY_ESL = Object.fromEntries(Object.entries(ESL).map(([k, v]) => [v, k]));
const idOf = (d) => {
  const [hex, plugin] = String(d).split(':');
  if (plugin in ESL) return ((0xfe << 24) | (ESL[plugin] << 12) | parseInt(hex, 16)) >>> 0;
  if (!(plugin in PLUGINS)) throw new Error(`no plugin ${plugin}`);
  return ((PLUGINS[plugin] << 24) | parseInt(hex, 16)) >>> 0;
};
const descOf = (id) => {
  if ((id >>> 24) === 0xfe) return `${(id & 0xfff).toString(16)}:${BY_ESL[(id >>> 12) & 0xfff]}`;
  const p = BY_INDEX[id >>> 24]; if (!p) throw new Error('no plugin'); return `${(id & 0xffffff).toString(16)}:${p}`;
};
const RECORDS = { [idOf(GLASS_ARMOR)]: { type: 'ARMO', editorId: 'ArmorGlassCuirass', fields: [] }, [idOf(SURVIVAL_CELL)]: { type: 'CELL', editorId: 'AAASurvivalMarkerCell', fields: [] } };

const SMITH = 0x14, ADMIN = 0x15, MAGE = 0x16;
const props = new Map();
const put = (id, p, v) => props.set(id + '|' + p, v);
const at = (id, place) => { put(id, 'worldOrCellDesc', place); put(id, 'pos', [0, 0, 0]); };
const inv = (a) => (props.get(a + '|inventory') || { entries: [] }).entries;
const count = (a, desc) => inv(a).filter((e) => e.baseId === idOf(desc)).reduce((n, e) => n + e.count, 0);
const give = (a, desc, n) => { const e = inv(a).map((x) => Object.assign({}, x)); const h = e.find((x) => x.baseId === idOf(desc)); if (h) h.count += n; else e.push({ baseId: idOf(desc), count: n }); put(a, 'inventory', { entries: e }); };
const take = (a, desc, n) => { const e = inv(a).map((x) => Object.assign({}, x)); const h = e.find((x) => x.baseId === idOf(desc)); if (h) h.count -= n; put(a, 'inventory', { entries: e.filter((x) => x.count > 0) }); };
const stock = (a, recipe) => { for (const [d, n] of recipe[2]) give(a, d, n); };
const mastery = (a, skills) => put(a, 'private.mastery', { v: 2, skills: Object.fromEntries(Object.entries(skills).map(([k, rank]) => [k, { level: rank * 25, xp: 0, rank }])), order: Object.keys(skills) });

const mp = {
  getIdFromDesc: idOf,
  getDescFromId: descOf,
  get: (id, p) => props.get(id + '|' + p),
  set: (id, p, v) => props.set(id + '|' + p, JSON.parse(JSON.stringify(v))),
  lookupEspmRecordById: (id) => (RECORDS[id] ? { record: RECORDS[id], toGlobalRecordId: (local) => local } : null),
  callPapyrusFunction: (kind, cls, fn) => (fn === 'GetSpellCount' ? 0 : null),
};
// masterySystem's chain stands in for the handler the gamemode wraps: every call is one mastery credit
const credits = [];
const masteryChain = (actorId, itemId, n, recipeId) => { credits.push([actorId, recipeId]); return undefined; };
mp.onCraft = masteryChain;
// The engine's side of a craft: the gamemode decides, then OnFireSuccess swaps inputs for the product
const craft = (a, recipe) => {
  const r = mp.onCraft(a, idOf(recipe[1]), 1, idOf(recipe[0]));
  if (r !== false) { for (const [d, n] of recipe[2]) take(a, d, n); give(a, recipe[1], 1); }
  return r;
};

const admins = new Set([ADMIN]);
const out = { said: [], notices: [], audits: [], logs: [], widgets: [] };
const handlers = new Map(), commands = new Map();
const mkApi = (cfg) => ({
  mp, cfg,
  log: (...a) => out.logs.push(a.join(' ')),
  personal: (a, t) => out.said.push([a, t]),
  system: (a, t) => out.said.push([a, t]),
  audit: (t) => out.audits.push(t),
  display: (a) => `P${a.toString(16)}`,
  who: (a) => `P${a.toString(16)}`,
  isAdmin: (a) => admins.has(a),
  sendPacket: (a, p) => { if (p.customPacketType === 'dboNotice') out.notices.push([a, p.text]); return true; },
  openWidget: (a, w) => { out.widgets.push({ a, w }); return true; },
  closeWidget: () => true,
  onUi: (ev, fn) => { const l = handlers.get(ev) || []; l.push(fn); handlers.set(ev, l); },
  registerChatCommand: (name, fn, opts) => commands.set(name, { fn, opts }),
  onlineActors: () => [SMITH, ADMIN, MAGE],
  every: () => {},
  distanceMeters: () => 0,
  takeGold: (a, n) => { if (count(a, 'f:Skyrim.esm') < n) return false; take(a, 'f:Skyrim.esm', n); return true; },
  giveItem: (a, baseId, n) => { give(a, descOf(baseId), n); return true; },
  depositToTreasury: (zone, n) => n,
});
let regionsCfg = { craft: true, tomes: true, adminBypass: true, failOpen: true, defaultPlace: 'skyrim' };
let spellsCfg = {};
const load = () => {
  handlers.clear(); commands.clear();
  const cfg = { regions: regionsCfg, spells: spellsCfg };
  delete require.cache[REGIONS]; require(REGIONS)(mkApi(cfg));
  delete require.cache[SPELLS]; require(SPELLS)(mkApi(cfg));
};
load();
const R = () => globalThis.__dboRegions;

let failures = 0, checks = 0;
const check = (name, ok, detail) => { checks++; if (!ok) { failures++; console.log(`FAIL ${name}${detail !== undefined ? ': ' + JSON.stringify(detail) : ''}`); } else console.log(`ok   ${name}`); };
const said = (a) => { const l = out.said.filter((p) => p[0] === a); return l.length ? l[l.length - 1][1] : ''; };
const cmd = (name, a, args) => commands.get(name).fn(a, args || '');
const ui = (ev, a, args, widgetId) => (handlers.get(ev) || []).forEach((fn) => fn(a, args || [], widgetId || 44));
const shop = (a) => { const l = out.widgets.filter((w) => w.a === a && w.w.type === 'tomeShop'); return l.length ? l[l.length - 1].w : null; };
const row = (a, book) => (shop(a) ? shop(a).tomes.find((t) => t.id === book) : null);
const place = (desc) => R().placeOf(desc);

// ---- boot ----
check('boot line counts tomes and recipes per province', out.logs.some((l) => /regions: craft gate on, tome filter on; \d+ cells, \d+ worlds; cyrodiil \d+ tomes \d+ recipes, skyrim/.test(l)), out.logs);
check('the craft hook wraps the handler that was there (masterySystem)', mp.onCraft.__dboRegions === true && globalThis.__dboPrevCraft === masteryChain);
load();
check('a reload replaces its wrapper instead of stacking it', mp.onCraft.__dboRegions === true && globalThis.__dboPrevCraft === masteryChain);

// ---- places ----
check('the Synod Conclave is Cyrodiil through its load doors', place(SYNOD_CELL).province === 'cyrodiil' && place(SYNOD_CELL).source === 'cell', place(SYNOD_CELL));
check('Bruma\'s worldspace is Cyrodiil', place(BRUMA_WORLD).province === 'cyrodiil' && place(BRUMA_WORLD).source === 'world');
check('Tamriel and Breezehome are Skyrim', place(TAMRIEL_WORLD).province === 'skyrim' && place(BREEZEHOME_CELL).province === 'skyrim' && place(BREEZEHOME_CELL).source === 'cell');
check('Solstheim is Solstheim, and Vvardenfell folds into it', place(SOLSTHEIM_WORLD).province === 'solstheim' && place(VVARDENFELL_WORLD).province === 'solstheim');
check('the Hub is no province (override by editor id)', place(HUB_WORLD).province === 'none' && place(HUB_WORLD).source === 'override', place(HUB_WORLD));
check('a Baan Malur hut no door reaches is Solstheim by its plugin', place(BAAN_HUT_CELL).province === 'solstheim' && place(BAAN_HUT_CELL).source === 'plugin', place(BAAN_HUT_CELL));
const logsBefore = out.logs.length;
check('a place no table knows falls back to Skyrim', place(SURVIVAL_CELL).province === 'skyrim' && place(SURVIVAL_CELL).source === 'default');
place(SURVIVAL_CELL);
check('...and is logged once', out.logs.slice(logsBefore).filter((l) => /no province for 861:ccqdrsse001-survivalmode.esl AAASurvivalMarkerCell/.test(l)).length === 1, out.logs.slice(logsBefore));

// ---- core everywhere ----
check('core tomes are sold in every province', ['cyrodiil', 'skyrim', 'solstheim'].every((p) => R().tomeOk(idOf(SPARKS_BOOK), p)));
check('common recipes are craftable everywhere, the Hub included', [BRUMA_WORLD, TAMRIEL_WORLD, SOLSTHEIM_WORLD, HUB_WORLD].every((w) => { at(SMITH, w); return R().recipeOk(SMITH, idOf(IRON[1]), idOf(IRON[0])).ok; }));
at(SMITH, SYNOD_CELL); stock(SMITH, IRON);
const c0 = credits.length;
check('smelting iron in Bruma goes through and earns mastery credit', craft(SMITH, IRON) !== false && count(SMITH, IRON[1]) === 1 && count(SMITH, IRON[2][0][0]) === 0 && credits.length === c0 + 1);

// ---- province stock ----
check('tomes of one province are sold only there', R().tomeOk(idOf(FROSTFLAMES_BOOK), 'cyrodiil') && !R().tomeOk(idOf(FROSTFLAMES_BOOK), 'skyrim') && R().tomeOk(idOf(ASHSHELL_BOOK), 'solstheim') && !R().tomeOk(idOf(ASHSHELL_BOOK), 'cyrodiil'));
check('vanilla tomes Beyond Skyrim\'s mages cast are sold in Cyrodiil and Skyrim', R().tomeOk(idOf(FIREBOLT_BOOK), 'cyrodiil') && R().tomeOk(idOf(FIREBOLT_BOOK), 'skyrim') && !R().tomeOk(idOf(FIREBOLT_BOOK), 'solstheim'));
check('the ISS skeleton tome is Skyrim by override', R().tomeWhere(idOf(SKELETON_BOOK)).join() === 'skyrim');
at(MAGE, SYNOD_CELL);
mastery(MAGE, { arcane: 4, priest: 4 });
put(MAGE, 'private.dboGuilds', [{ id: 'synod', role: 'member' }]);
give(MAGE, 'f:Skyrim.esm', 5000);
cmd('tomes', MAGE);
// The shop spells.js builds, filtered to Cyrodiil the way regions.py counts it
const EXC = /^(dun|MGR)|quest|FF\d\d/i;
const canonToDesc = (c) => { const i = c.lastIndexOf(':'); return `${parseInt(c.slice(i + 1), 16).toString(16)}:${c.slice(0, i)}`; };
const inCyrodiil = (t) => { const p = (DATA.tomes[canonToDesc(t.id)] || {}).p; return p === 'common' || (Array.isArray(p) && p.includes('cyrodiil')); };
const pref = (t) => ({ 'BSHeartland.esm': 0, 'BSAssets.esm': 1 }[t.plugin] ?? 99);
const seen = new Set();
const expected = TOMES_JSON.filter((t) => t.rank <= 3 && !EXC.test(t.name) && !['Gray Fox Cowl.esm', 'SurWR.esp'].includes(t.plugin))
  .sort((x, y) => x.school.localeCompare(y.school) || x.rank - y.rank || pref(x) - pref(y) || String(x.spellName).localeCompare(String(y.spellName)))
  .filter((t) => (seen.has(t.spellId) ? false : seen.add(t.spellId))).filter(inCyrodiil);
check('the Synod panel is titled for Cyrodiil', shop(MAGE).title === 'The Synod: Spell Tomes of Cyrodiil', shop(MAGE).title);
check(`...stocks the Cyrodiil list (${expected.length} tomes for a Master of both skills)`, shop(MAGE).tomes.length === expected.length && expected.length === 51, [shop(MAGE).tomes.length, expected.length]);
check('...core, Cyrodiil and shared tomes are there', row(MAGE, SPARKS_BOOK) && row(MAGE, FROSTFLAMES_BOOK) && row(MAGE, FIREBOLT_BOOK));
check('...Skyrim and Solstheim tomes are not', !row(MAGE, INCINERATE_BOOK) && !row(MAGE, ASHSHELL_BOOK));
check('the boot line counts the Cyrodiil stock', out.logs.some((l) => /tomes in the Synod shop, .*, 51 stocked for Cyrodiil/.test(l)), out.logs.filter((l) => /spells on/.test(l)));
ui('tomeBuy', MAGE, [shop(MAGE).nonce, INCINERATE_BOOK]);
check('a forged buy of a Skyrim tome is refused and costs nothing', shop(MAGE).resultKind === 'refused' && shop(MAGE).result === 'The Synod does not stock Incinerate; it is sold in Skyrim.' && count(MAGE, 'f:Skyrim.esm') === 5000 && count(MAGE, INCINERATE_BOOK) === 0, shop(MAGE).result);
spellsCfg = { shopShowForeign: true }; load();
cmd('tomes', MAGE);
check('shopShowForeign lists foreign tomes as blocked rows', row(MAGE, INCINERATE_BOOK) && row(MAGE, INCINERATE_BOOK).blocked === 'Sold in Skyrim' && row(MAGE, ASHSHELL_BOOK).blocked === 'Sold in Solstheim' && row(MAGE, SPARKS_BOOK).blocked === '', [row(MAGE, INCINERATE_BOOK), row(MAGE, ASHSHELL_BOOK)]);
spellsCfg = {}; load();

// ---- the craft gate ----
at(SMITH, BRUMA_WORLD); stock(SMITH, GLASS);
const c1 = credits.length, n1 = out.notices.length;
check('Glass Armor is refused at a Bruma forge', craft(SMITH, GLASS) === false);
check('...the materials stay and no armor is made', count(SMITH, GLASS[1]) === 0 && GLASS[2].every(([d, n]) => count(SMITH, d) === n));
check('...no mastery credit', credits.length === c1);
check('...the smith is told why', said(SMITH) === 'Glass Armor is a Skyrim and Solstheim design; the smiths of Cyrodiil do not know it. Your materials return when you leave the forge.', said(SMITH));
check('...with a notice too', out.notices.length === n1 + 1 && out.notices[out.notices.length - 1][1] === said(SMITH));
check('...and it is audited', out.audits[out.audits.length - 1] === `REGION refused P14 RecipeArmorGlassCuirass at ${BRUMA_WORLD} (cyrodiil)`, out.audits[out.audits.length - 1]);
const s1 = out.said.length;
check('a second try at once is refused without a second message', craft(SMITH, GLASS) === false && out.said.length === s1);
wallClock += 1600;
craft(SMITH, GLASS);
check('...and told again after 1.5 s', out.said.length === s1 + 1);
at(SMITH, TAMRIEL_WORLD);
check('the same Glass Armor is made in Skyrim, with credit', craft(SMITH, GLASS) !== false && count(SMITH, GLASS[1]) === 1 && credits.length === c1 + 1);
at(SMITH, BRUMA_WORLD); stock(SMITH, FORSWORN);
check('the Forsworn arrow (Skyrim only) is refused in Bruma', craft(SMITH, FORSWORN) === false && count(SMITH, FORSWORN[1]) === 0 && count(SMITH, '6bc0a:Skyrim.esm') === 1);
at(SMITH, BREEZEHOME_CELL); wallClock += 1600;
check('...and made in Breezehome', craft(SMITH, FORSWORN) !== false && count(SMITH, FORSWORN[1]) === 1);
stock(SMITH, AYLEID);
check('the Ayleid greatsword (Cyrodiil only) is refused in Skyrim', craft(SMITH, AYLEID) === false);
at(SMITH, SYNOD_CELL);
check('...and made in Bruma', craft(SMITH, AYLEID) !== false && count(SMITH, AYLEID[1]) === 1);
check('Daedric (Cyrodiil and Skyrim) is allowed in Bruma and refused on Solstheim', R().recipeOk(SMITH, idOf(DAEDRIC[1]), idOf(DAEDRIC[0])).ok && (at(SMITH, SOLSTHEIM_WORLD), !R().recipeOk(SMITH, idOf(DAEDRIC[1]), idOf(DAEDRIC[0])).ok));
at(SMITH, SYNOD_CELL);
check('a staff at the staff enchanter is Solstheim by its bench', !R().recipeOk(SMITH, idOf(STAFF[1]), idOf(STAFF[0])).ok && R().recipeWhere(idOf(STAFF[0]), idOf(STAFF[1])).p.join() === 'solstheim');
at(SMITH, HUB_WORLD); stock(SMITH, GLASS); wallClock += 1600;
check('in the Hub only common designs are made', craft(SMITH, GLASS) === false && /only designs known in every province can be made here/.test(said(SMITH)) && R().recipeOk(SMITH, idOf(IRON[1]), idOf(IRON[0])).ok, said(SMITH));
at(SMITH, BRUMA_WORLD);
const l2 = out.logs.length;
check('a recipe regions.json does not list (tempering) passes', R().recipeOk(SMITH, idOf(TEMPER[1]), idOf(TEMPER[0])).ok && R().recipeOk(SMITH, idOf(TEMPER[1]), idOf(TEMPER[0])).ok);
check('...logged once', out.logs.slice(l2).filter((l) => /no entry for recipe 1094d4:Skyrim.esm, allowing it/.test(l)).length === 1, out.logs.slice(l2));
regionsCfg = Object.assign({}, regionsCfg, { craft: false }); load();
check('with craft off every recipe passes', R().recipeOk(SMITH, idOf(GLASS[1]), idOf(GLASS[0])).ok);
regionsCfg = Object.assign({}, regionsCfg, { craft: true }); load();

// ---- admins ----
at(ADMIN, BRUMA_WORLD); stock(ADMIN, GLASS);
check('an admin crafts Glass Armor in Bruma', craft(ADMIN, GLASS) !== false && count(ADMIN, GLASS[1]) === 1);
cmd('region', ADMIN, 'test');
stock(ADMIN, GLASS);
check('/region test drops the bypass', /Region test on/.test(said(ADMIN)) && craft(ADMIN, GLASS) === false && count(ADMIN, GLASS[1]) === 1);
cmd('region', ADMIN, 'test');
check('...and /region test again restores it', /Region test off/.test(said(ADMIN)) && craft(ADMIN, GLASS) !== false && count(ADMIN, GLASS[1]) === 2);
check('the bypass survives a reload', (load(), R().bypass(ADMIN)) && !R().bypass(SMITH));
at(ADMIN, SYNOD_CELL);
cmd('region', ADMIN);
check('/region names the place, its province and where that came from', said(ADMIN).startsWith(`${SYNOD_CELL} (CYRBrumaSynodConclave) is Cyrodiil, from its load doors (BSHeartland). Craft gate on, tome filter on, your bypass on.`), said(ADMIN));
check('/region is an admin command', commands.get('region').opts.admin === true);
mastery(ADMIN, { arcane: 4, priest: 4 });
put(ADMIN, 'private.dboGuilds', [{ id: 'synod', role: 'member' }]);
give(ADMIN, 'f:Skyrim.esm', 5000);
cmd('tomes', ADMIN);
check('an admin sees foreign tomes labelled with where they are sold', row(ADMIN, INCINERATE_BOOK) && row(ADMIN, INCINERATE_BOOK).name === 'Spell Tome: Incinerate (Skyrim)' && row(ADMIN, INCINERATE_BOOK).blocked === '', row(ADMIN, INCINERATE_BOOK));
ui('tomeBuy', ADMIN, [shop(ADMIN).nonce, INCINERATE_BOOK]);
check('...and can buy one', shop(ADMIN).resultKind === 'ok' && count(ADMIN, INCINERATE_BOOK) === 1, shop(ADMIN).result);

// ---- overrides, applied on save without a reload ----
at(SMITH, BRUMA_WORLD); stock(SMITH, GLASS); wallClock += 1600;
writeOverrides({ items: { ArmorGlassCuirass: 'common' } });
check('an item moved to common by editor id is craftable in Bruma at once', craft(SMITH, GLASS) !== false);
writeOverrides({ items: { [GLASS_ARMOR]: 'glass', [FORSWORN_ARROW]: 'cyrodiil' } });
check('an item override by desc takes a family name (glass: Skyrim and Solstheim)', !R().recipeOk(SMITH, idOf(GLASS[1]), idOf(GLASS[0])).ok && (at(SMITH, SOLSTHEIM_WORLD), R().recipeOk(SMITH, idOf(GLASS[1]), idOf(GLASS[0])).ok));
at(SMITH, BRUMA_WORLD);
check('...and moves the Forsworn arrow to Cyrodiil', R().recipeOk(SMITH, idOf(FORSWORN[1]), idOf(FORSWORN[0])).ok && (at(SMITH, TAMRIEL_WORLD), !R().recipeOk(SMITH, idOf(FORSWORN[1]), idOf(FORSWORN[0])).ok));
writeOverrides({ recipes: { IWRecipeAmmoForswornArrow: 'none' }, items: { [FORSWORN_ARROW]: 'common' } });
at(SMITH, TAMRIEL_WORLD); stock(SMITH, FORSWORN); wallClock += 1600;
check('a recipe override beats the item and \'none\' refuses it everywhere', craft(SMITH, FORSWORN) === false && /^Forsworn Arrow cannot be made anywhere/.test(said(SMITH)), said(SMITH));
writeOverrides({ benches: Object.assign({}, OVR_BASE.benches, { DLC2StaffEnchanter: 'common' }) });
at(SMITH, SYNOD_CELL);
check('a bench override widens the staff enchanter', R().recipeOk(SMITH, idOf(STAFF[1]), idOf(STAFF[0])).ok);
writeOverrides({ tomes: Object.assign({}, OVR_BASE.tomes, { SpellTomeIncinerate: ['cyrodiil', 'skyrim'] }) });
cmd('tomes', MAGE);
check('a tome override stocks Incinerate in the Synod', row(MAGE, INCINERATE_BOOK) && row(MAGE, INCINERATE_BOOK).blocked === '' && shop(MAGE).tomes.length === 52, shop(MAGE).tomes.length);
writeOverrides({ places: Object.assign({}, OVR_BASE.places, { BSHeartland: 'skyrim', [SYNOD_CELL]: 'morrowind' }) });
check('a place override by editor id moves Bruma\'s worldspace', place(BRUMA_WORLD).province === 'skyrim' && place(BRUMA_WORLD).source === 'override');
check('...and one by desc takes a culture (morrowind: Solstheim)', place(SYNOD_CELL).province === 'solstheim');
const good = JSON.stringify(Object.assign({}, OVR_BASE, { items: { ArmorGlassCuirass: 'common' } }));
writeOverrides(null, good);
const l3 = out.logs.length;
writeOverrides(null, good.slice(0, 200));
at(SMITH, BRUMA_WORLD);
check('a half-saved overrides file keeps the last good copy', R().recipeOk(SMITH, idOf(GLASS[1]), idOf(GLASS[0])).ok && out.logs.slice(l3).some((l) => /regions-overrides.json unreadable .*keeping the last good copy/.test(l)), out.logs.slice(l3));
writeOverrides({});
check('...until a good file replaces it', !R().recipeOk(SMITH, idOf(GLASS[1]), idOf(GLASS[0])).ok);

console.log(`\n${checks - failures}/${checks} passed`);
process.chdir(os.tmpdir());
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
