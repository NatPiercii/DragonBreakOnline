// The artifacts sweep (Nate, 2026-09-30: Dawnbreaker, the Rueful Axe, the Ebony Blade, Chillrend, the Mace of Molag Bal and
// Volendrung were not in artifacts.json). Every Daedric artifact and named quest unique of the load order, found by its
// display name in admin-items.json and resolved to its editor id, is caught; look-alikes that are ordinary gear are not.
// Three were in loot pools (Muiri's Ring, the Ring of the Beast, the Zahkriisos mask) and leave them. Immersive Weapons,
// Immersive Armors, More Craftable Equipment and Dragon Priest Armor recipes that make one are refused at the forge
// (regions.js craftHook), while tempering one a player holds, and ordinary crafts, pass.
//   node tests/artifact-sweep-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };
const patterns = JSON.parse(fs.readFileSync(path.join(SERVER, 'artifacts.json'), 'utf8')).patterns;
const ART = new RegExp(patterns.map((p) => `(?:${p})`).join('|'), 'i');

// ---- the sweep: every artifact and named unique, by editor id ----
const MUST = [
  // Worker C's six, the vanilla records
  'DA09Dawnbreaker', 'DA03RuefulAxe', 'DA08EbonyBlade', 'TG07Chillrend001', 'TG07Chillrend006', 'DA10MaceofMolagBal', 'DA06Volendrung',
  // the rest of the Daedric artifacts
  'DA01SoulGemAzurasStar', 'DA01SoulGemBlackStar', 'DA02Armor', 'DA04OghmaInfinium', 'DA05HircinesRing', 'DA05SaviorsHide', 'DA07MehrunesRazor',
  'DA11RingofNamira', 'DA13Spellbreaker', 'DA14SanguineRose', 'DA15Wabbajack', 'dunBluePalaceWabbajack', 'DA16SkullofCorruption', 'ClavicusVileMask',
  // guild, quest and dungeon uniques
  'TG08SkeletonKey', 'TGCrown01', 'TGAmuletofArticulation01', 'TGAmuletofArticulation07', 'MQ203AkaviriKatana1', 'MQ203AkaviriKatana5', 'MG07StaffofMagnus',
  'MG05RewardAmulet', 'DB05ElvenBow', 'DBSilverRing', 'dunAngisBow', 'dunBloatedMansKatana', 'dunVolunruudEduj', 'dunVolunruudPickaxe', 'dunAnsilvundGhostblade',
  'dunValthumeDragonPriestStaff', 'dunSaarthalStaffJyrikStaff', 'dunTargeOfTheBloodedShield', 'dunLiarsRetreatLonghammer', 'dunPOITrollsbane',
  'dunMossMotherValdrDagger', 'dunKatariahScimitar', 'dunHaltedStreamPoachersAxe', 'dunDeepwoodBoots', 'dunFolgunthurMikrulSword02', 'dunGeirmundSigdisBow06',
  'dunGeirmundSigdisBowIllusion', 'dunGauldurAmuletFragmentSaarthal', 'dunRedEagleSwordBase', 'dunRedEagleSwordUpgraded', 'dunSilentMoonsEnchIronSword01',
  'dunSilentMoonsEnchSteelSword03', 'POIMageBorvirsDagger', 'POIMageRundisDagger', 'MFDDravinsBow', 'FFRiften09Grimsever', 'T03Nettlebane', 'FavorNelacarStaffFear',
  'ArmorBoneCrown', 'MGRKeeningNonPlayable', 'dunGauldurAmulet', 'dunFrostmereCryptPaleBlade01', 'dunFrostmereCryptPaleBlade05',
  // Dawnguard and Dragonborn
  'DLC1LD_AetherialCrown', 'DLC1LD_AetherialShield', 'DLC1LD_AetherialStaff', 'DLC1LD_KatriaBow', 'DLC1LD_KatriaBowNP', 'DLC1nVampireBloodMagicRingBeast',
  'DLC2MKMiraakRobes3', 'DLC2MKClothesMiraakRobes', 'DLC2MKMiraakMask1H', 'DLC2MKMiraakStaff2', 'DLC2MKMiraakSword3', 'DLC2ArmorAcolyteMaskFire',
  'DLC2ArmorAcolyteMaskFrost', 'DLC2ArmorAcolyteMaskShock',
  // the replicas a smith could make, and the modded uniques
  'IWCDawnbreaker', 'IWCChillrend', 'IWCEbonyBlade', 'IWCMaceofMolagBal', 'IWCRuefulAxe', 'IWCVolendrung', 'IWCMehrunesRazor', 'IWCBladeOfWoe',
  'IWCNightingaleBlade', 'IWCNightingaleBow', 'IWGoldbrandKatana', 'IWIceBladeoftheMonarchGreatsword', 'IWForkofHorripilationDagger', 'IWChrysamereGreatsword',
  'IAShieldYsgramor', 'MCEArmorTsunCuirassPlayer', 'manny_GF_Armor_GrayCowl', 'manny_GF_Armor_BootsofSpringheelJak', 'manny_GF_Weapon_Umbra',
  'manny_GF_Amulet_RightEyeOfColdharbour', 'manny_GF_Amulet_LeftEyeOfColdharbour',
];
const missed = MUST.filter((e) => !ART.test(e));
ok(missed.length === 0, `all ${MUST.length} swept artifacts and uniques are in artifacts.json`, missed);
// Look-alikes that are ordinary gear stay lootable and craftable
const NOT = ['Book2CommonWabbajack', 'IronSword', 'SilverRing', 'ArmorIronHelmet', 'IWCAmoranSaber', 'IWChakramDagger', 'IWCaptainsCutlass', 'ExecutionerAxe',
  'IATrollbaneHeavyCuirass', 'DPA_DragonPriestArmorKonahrikHeavy', 'DPA_DragonPriestRobesZahkriisos', 'manny_GF_Weapon_BladesSword', 'manny_GF_Armor_Yokuda',
  'DLC2ArmorAcolyteRobesFire', 'TG07MercerDisplayCaseKey', 'DBSilverRingX', 'DA02ArmorX', 'DragonboneSword', 'DLC1ArmorVampireBoots'];
const wrong = NOT.filter((e) => ART.test(e));
ok(wrong.length === 0, 'ordinary gear is not caught (the Wabbajack book, a silver ring, Immersive Armors\' Trollsbane set, Dragon Priest Armor\'s own sets, Gray Fox Cowl\'s other gear)', wrong);

// ---- loot: the pools, through dungeons.js's own filter and pool line ----
const dj = fs.readFileSync(path.join(SERVER, 'dungeons.js'), 'utf8');
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(path.join(SERVER, f), 'utf8')); } catch (e) { return fb; } };
const liftConst = (name) => { const i = dj.indexOf(`const ${name} = (() => {`), j = dj.indexOf('})();', i); return i < 0 || j < 0 ? null : new Function('readJson', 'log', `${dj.slice(i, j + 5)}\nreturn ${name};`)(readJson, () => {}); };
const ARTIFACT = liftConst('ARTIFACT');
let DRAGON_LOOT = /$^/; try { DRAGON_LOOT = liftConst('DRAGON_LOOT') || /$^/; } catch (e) { /* older dungeons.js */ }
const li = dj.indexOf('const pool = (name, maxValue, ok) =>');
const LOOT = readJson('loot.json', { pools: {} }).pools || {};
const pool = new Function('LOOT', 'BANNED_LOOT', 'ARTIFACT', 'DRAGON_LOOT', `${dj.slice(li, dj.indexOf('\n', li))}\nreturn pool;`)(LOOT, /Ebony|Daedric/i, ARTIFACT, DRAGON_LOOT);
const inPools = ['DBSilverRing', 'DLC1nVampireBloodMagicRingBeast', 'DLC2ArmorAcolyteMaskShock'];
const had = inPools.filter((n) => Object.values(LOOT).some((l) => (l || []).some((it) => it.name === n)));
const still = inPools.filter((n) => Object.keys(LOOT).some((k) => pool(k, 0, undefined).some((it) => it.name === n)));
ok(had.length === 3 && still.length === 0, `Muiri's Ring, the Ring of the Beast and the Zahkriisos mask were in loot.json (${had.length}) and no draw hands them out`, { had, still });
const ay = (readJson('ayleid-loot.json', { items: [] }).items || []).filter((it) => ART.test(String(it.name || '')));
ok(ay.length === 0 || /!ARTIFACT\.test\(String\(it\.name \|\| ''\)\)/.test(dj), 'the Ayleid table is filtered by the same list');

// ---- crafting: regions.js refuses a recipe that makes one ----
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-artsweep-'));
process.on('exit', () => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
process.chdir(scratch);
for (const f of ['artifacts.json', 'dragon-materials.json', 'regions.json', 'regions-overrides.json', 'skills.json', 'spell-tomes.json']) { try { fs.copyFileSync(path.join(SERVER, f), f); } catch (e) { /* optional */ } }
// Real recipes and products (desc -> editor id), at stub ids
const REC = {
  '478d8:Immersive Weapons.esp': 'IWRecipeWeaponDawnbreaker', '478cc:Immersive Weapons.esp': 'IWCDawnbreaker',
  '478d5:Immersive Weapons.esp': 'IWRecipeWeaponChillrend', '478d1:Immersive Weapons.esp': 'IWCChillrend',
  '478ed:Immersive Weapons.esp': 'IWRecipeWeaponVolendrung', '478c9:Immersive Weapons.esp': 'IWCVolendrung',
  '2146e:Hothtrooper44_ArmorCompilation.esp': 'IARShieldYsgramor', '2146f:Hothtrooper44_ArmorCompilation.esp': 'IAShieldYsgramor',
  '81a:MoreCraftableEquipment.esp': 'MCERecipeArmorTsunCuirass', '819:MoreCraftableEquipment.esp': 'MCEArmorTsunCuirassPlayer',
  '575b:Dawnguard.esm': 'DLC1LD_RecipeAetherialCrown', '575a:Dawnguard.esm': 'DLC1LD_AetherialCrown',
  '2a000:DragonPriestArmor.esp': 'DPA_DowngradeDragonPriestArmorMiraakHeavy', '39d22:Dragonborn.esm': 'DLC2MKMiraakRobes3',
  '2a001:DragonPriestArmor.esp': 'DPA_UpgradeDragonPriestArmorKonahrikHeavy', 'fb75:DragonPriestArmor.esp': 'DPA_DragonPriestArmorKonahrikHeavy',
  '2a002:Skyrim.esm': 'TemperWeaponDawnbreaker', '4e4ee:Skyrim.esm': 'DA09Dawnbreaker',
  'a30c3:Skyrim.esm': 'RecipeIngotIron', '5ace4:Skyrim.esm': 'IngotIron',
  '21470:Hothtrooper44_ArmorCompilation.esp': 'IATShieldYsgramor',   // tempers the shield at the armor table, no "Temper" in its name
  '88105:Skyrim.esm': 'CraftingSmithingForge', '88108:Skyrim.esm': 'CraftingSmithingSharpeningWheel', 'adb78:Skyrim.esm': 'CraftingSmithingArmorTable',
};
// Each recipe's workbench keyword (BNAM): tempering is told by the bench, never by the name
const BENCH = { '2a002:Skyrim.esm': '88108:Skyrim.esm', '21470:Hothtrooper44_ArmorCompilation.esp': 'adb78:Skyrim.esm' };
const ids = new Map(), descs = new Map(); let nextId = 0x0a000001;
for (const d of Object.keys(REC)) { ids.set(d.toLowerCase(), nextId); descs.set(nextId, d); nextId++; }
const cid = (d) => { const k = String(d).toLowerCase(); if (!ids.has(k)) { ids.set(k, nextId); descs.set(nextId, d); nextId++; } return ids.get(k); };
const said = [], audits = [], credits = [];
const cmp = {
  getIdFromDesc: cid, getDescFromId: (id) => descs.get(id >>> 0) || '', get: () => null, set: () => {},
  lookupEspmRecordById: (id) => {
    const d = descs.get(id >>> 0); if (!d || !REC[d]) return null;
    const bench = BENCH[d] || (/Recipe|IAR|DPA_/.test(REC[d]) ? '88105:Skyrim.esm' : null);
    const fields = []; if (bench) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, cid(bench), true); fields.push({ type: 'BNAM', data: b }); }
    return { record: { editorId: REC[d], type: 'WEAP', fields }, toGlobalRecordId: (l) => l };
  },
  callPapyrusFunction: () => null,
};
cmp.onCraft = (a, item, n, recipe) => { credits.push(recipe); return undefined; };
delete globalThis.__dboPrevCraft;
const SMITH = 0xff000014;
try {
  require(path.join(SERVER, 'regions.js'))({
    mp: cmp, log: () => {}, personal: (a, t) => said.push(t), audit: (t) => audits.push(t), who: (a) => `P${a.toString(16)}`,
    cfg: { regions: { craft: false } }, registerChatCommand: () => {}, isAdmin: () => false, sendPacket: () => true, openWidget: () => true,
    closeWidget: () => true, onUi: () => {}, onlineActors: () => [SMITH], every: () => {}, distanceMeters: () => 0, takeGold: () => false, giveItem: () => true,
    depositToTreasury: (z, n) => n,
  });
} catch (e) { ok(false, 'regions.js loads', e.message); }
const craft = (recipe, product) => cmp.onCraft(SMITH, cid(product), 1, cid(recipe));
for (const [r, p, what] of [
  ['478d8:Immersive Weapons.esp', '478cc:Immersive Weapons.esp', "Immersive Weapons' Dawnbreaker"],
  ['478d5:Immersive Weapons.esp', '478d1:Immersive Weapons.esp', 'its Chillrend'],
  ['478ed:Immersive Weapons.esp', '478c9:Immersive Weapons.esp', 'its Volendrung'],
  ['2146e:Hothtrooper44_ArmorCompilation.esp', '2146f:Hothtrooper44_ArmorCompilation.esp', "Immersive Armors' Shield of Ysgramor"],
  ['81a:MoreCraftableEquipment.esp', '819:MoreCraftableEquipment.esp', "More Craftable Equipment's Tsun's armour"],
  ['575b:Dawnguard.esm', '575a:Dawnguard.esm', 'the Aetherial Crown'],
  ['2a000:DragonPriestArmor.esp', '39d22:Dragonborn.esm', "Dragon Priest Armor's downgrade that makes Miraak's Robes"],
]) ok(craft(r, p) === false, `${what} is refused at the forge`);
ok(!credits.length, 'a refused craft earns no mastery credit', credits);
ok(said.some((t) => /not made by any craftsman/.test(t) && /materials come back/.test(t)) && audits.some((t) => /ARTIFACT craft refused Pff000014 recipe IWRecipeWeaponDawnbreaker -> IWCDawnbreaker/.test(t)),
  'the smith is told why and that the materials come back, and it is audited', { said: said.slice(0, 2), audits: audits.slice(0, 2) });
credits.length = 0;
ok(craft('2a002:Skyrim.esm', '4e4ee:Skyrim.esm') !== false, 'tempering Dawnbreaker (a staff grant a player holds) at the sharpening wheel still works');
ok(craft('21470:Hothtrooper44_ArmorCompilation.esp', '2146f:Hothtrooper44_ArmorCompilation.esp') !== false, 'tempering a granted Shield of Ysgramor at the armor table still works, though its recipe is not named Temper (Worker A)');
ok(craft('2a001:DragonPriestArmor.esp', 'fb75:DragonPriestArmor.esp') !== false, "Dragon Priest Armor's own Konahrik set is ordinary gear and still made");
ok(craft('a30c3:Skyrim.esm', '5ace4:Skyrim.esm') !== false && credits.length === 4, 'an iron ingot is made and credited as always');

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
