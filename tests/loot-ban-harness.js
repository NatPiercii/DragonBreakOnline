// No Ebony, Daedric or Dragon gear in dungeon or camp loot (Nate, 1 Oct 2026). dungeons.js BANNED_LOOT matched only
// /Ebony|Daedric/, so the Dragonscale and Dragonplate Water Walking pieces could drop in Bruma from Novice, and the camp
// chests (wildlife.js campLoot) had no ban at all: an Ebony dagger could come out of the Dusk Thorn chest. Loads the
// real dungeons.js (which publishes its pattern) and the real wildlife.js against the real loot.json, then rolls the
// camp chest thousands of times; the dungeon pools are checked where they filter, in the source.
//   node tests/loot-ban-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-lootban-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
global.setTimeout = () => 0;
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };

for (const f of ['loot.json', 'artifacts.json', 'dragon-materials.json', 'ayleid-loot.json']) { try { fs.copyFileSync(path.join(ROOT, f), path.join(dir, f)); } catch (e) { /* optional */ } }
fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [] }));
fs.writeFileSync('wildlife.json', JSON.stringify({ placements: [], giantCamps: [{ id: 'DuskThornCamp', name: 'Dusk Thorn Camp', owners: 'goblins', chests: [{ ref: '1234:Test.esp' }] }] }));
const LOOT = JSON.parse(fs.readFileSync('loot.json', 'utf8')).pools;
const ids = new Map(); let next = 0x01000000;
const idOf = (d) => { const k = String(d).toLowerCase(); if (!ids.has(k)) ids.set(k, next++); return ids.get(k); };
const nameOfId = new Map();
for (const items of Object.values(LOOT)) for (const it of items) if (it && it.id) nameOfId.set(idOf(it.id), String(it.name || ''));
const props = new Map();
const mp = { get: (id, p) => (p === 'profileId' ? 1 : props.get(`${id}|${p}`)), set: (id, p, v) => props.set(`${id}|${p}`, v), getIdFromDesc: idOf };
const given = [];
const api = {
  mp, log: () => {}, personal: () => {}, system: () => {}, audit: () => {}, registerChatCommand: () => {}, onUi: () => {}, openWidget: () => true,
  closeWidget: () => true, sendPacket: () => true, findByName: () => 0, display: String, who: String, profileOf: () => 1, nameOf: String,
  onlineActors: () => [], isAdmin: () => false, giveItem: (a, id, n) => { given.push(id); return true; }, cfg: {}, every: () => {},
};
delete globalThis.__dboBannedLoot;
globalThis.__dboDungeonsBooted = true;
require(path.join(ROOT, 'dungeons.js'))(api);
const BANNED = globalThis.__dboBannedLoot;
ok(BANNED instanceof RegExp, 'dungeons.js publishes its ban for the camp chests');

// ---- the pattern ----
const MUST = ['BSKEnchArmorDragonscaleBootsWaterWalking', 'BSKEnchArmorDragonplateWaterWalking', 'EbonyDagger', 'CYREbonyDagger', 'DaedricDagger',
  'ArmorDragonplateCuirass', 'ArmorDragonscaleHelmet', 'DLC1DragonboneSwordKeeper03', 'DLC1KeeperArmorCuirass', 'IADragonHideCuirass',
  'IWDragonsteelSword', 'DLC1DragonboneArrow', 'IngotEbony', 'EnchEbonyDaggerFire04',
  // and what Worker D's census found the first pattern still let through: Orcish (Nate) and Stalhrim (Ebony's tier)
  'OrcishDagger', 'ArmorOrcishCuirass', 'EnchArmorOrcishBootsSneak02', 'DLC2StalhrimSword', 'DLC2ArmorStalhrimHeavyCuirass', 'DLC2EnchArmorStalhrimLightBoots01', 'DragonPriestDagger',
  'IngotOrichalcum'];
const missed = MUST.filter((n) => !BANNED.test(n));
ok(!missed.length, 'the ban takes the Dragon Water Walking pieces, Ebony/Daedric, plain Dragon gear, Keeper, Dragonhide, Dragonsteel, Orcish, Stalhrim, the Dragon Priest dagger, the orichalcum ingot', missed);
const KEEP = ['IronSword', 'SteelDagger', 'ArmorGlassCuirass', 'CYRGlassSword', 'ArmorElvenCuirass', 'DwarvenBow', 'DragonsTongue', 'BSKGoblinWarAxe',
  'ArmorSteelPlateCuirass', 'ArmorScaledCuirass', 'ArmorNordicCuirass', 'ArmorElvenGildedCuirass', 'ArmorHideCuirass', 'ImperialSword', 'ArmorDwarvenCuirass'];
const wrong = KEEP.filter((n) => BANNED.test(n));
ok(!wrong.length, 'ordinary gear and dragon\'s tongue (an ingredient) stay loot', wrong);
const inPools = Object.values(LOOT).flat().filter((it) => BANNED.test(String(it.name || ''))).length;
console.log(`      loot.json items the ban keeps out: ${inPools}`);

// ---- the dungeon pools: every path filters on BANNED_LOOT ----
const src = fs.readFileSync(path.join(ROOT, 'dungeons.js'), 'utf8');
ok(/const pool = \(name, maxValue, ok\) => \(LOOT\[name\] \|\| \[\]\)\.filter\(\(it\) => [^\n]*!BANNED_LOOT\.test/.test(src), 'every dungeon pool draw drops banned items (pool)');
ok(/if \(BANNED_LOOT\.test\(it\.name\) \|\| ARTIFACT\.test\(it\.name\)/.test(src), '...and so does lootOk');
ok(/const AYLEID_LOOT = [^\n]*!BANNED_LOOT\.test/.test(src), '...and the Ayleid table');
ok((src.match(/BANNED_LOOT\.test\((?:String\()?(?:rec\.editorId|edid)/g) || []).length >= 2, '...and what a corpse keeps and its equipment trim');

// ---- the camp chests: real rolls ----
require(path.join(ROOT, 'wildlife.js'))(api);
const CHEST = idOf('1234:Test.esp');
const roll = (n) => { given.length = 0; for (let i = 0; i < n; i++) { props.clear(); globalThis.__dboCampChest(CHEST, 0xff000014); } return given.map((id) => nameOfId.get(id) || ''); };
const names = roll(4000);
const bad = names.filter((n) => BANNED.test(n));
const weapons = names.filter((n) => LOOT.weapons.some((w) => w.name === n));
ok(weapons.length > 300 && !bad.length, `4000 camp chests: ${weapons.length} weapons, none Ebony, Daedric, Dragon, Stalhrim or Orcish, and no ebony or orichalcum ingot`, [...new Set(bad)].slice(0, 8));
// Without dungeons.js's pattern the chest gives no weapon and no material rather than an unfiltered one
delete globalThis.__dboBannedLoot;
const bare = roll(1000);
ok(!bare.some((n) => LOOT.weapons.some((w) => w.name === n) || LOOT.materials.some((m) => m.name === n)), 'without the ban the camp chest gives no weapon and no material (fails closed)');
ok(bare.length > 0, '...but still its gold and the rest');

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
