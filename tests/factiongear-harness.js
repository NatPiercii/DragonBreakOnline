// Faction gear (factiongear.js, faction-gear.json; Nate, 2026-09-28): a faction's armor and weapons are made only by
// its own Blacksmith (forge) or Tailor (loom, tanning rack) rank, or its leader; admins pass unless testing. Also runs
// the refusal through regions.js's craft hook, where it is asked. Loads the real modules and the real list, with mocks.
//   node tests/factiongear-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-factiongear-'));
for (const f of ['faction-gear.json', 'regions.json']) fs.copyFileSync(path.join(SERVER, f), path.join(dir, f));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });

let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

const gear = JSON.parse(fs.readFileSync('faction-gear.json', 'utf8')).items;
const itemNamed = (name, set) => { const e = Object.entries(gear).find(([, v]) => v.name === name && (!set || v.set === set)); return e ? e[0] : null; };
// Every faction the list names is a faction guild-defs.json defines
const defs = JSON.parse(fs.readFileSync(path.join(SERVER, 'guild-defs.json'), 'utf8')).factions;
const known = new Set(defs.map((f) => f.id));
const unknown = [...new Set(Object.values(gear).flatMap((v) => v.factions))].filter((f) => !known.has(f));
check('every faction in faction-gear.json exists in guild-defs.json', !unknown.length, unknown);
check('each item names at least one faction and a role', Object.values(gear).every((v) => v.factions.length && ['blacksmith', 'tailor'].includes(v.role)));

// Descs <-> fake ids
const ids = new Map(); const descs = new Map(); let next = 0x100;
// Case-insensitive, as the server's desc lookup is (the module lower-cases plugin names)
const idOf = (desc) => { const k = String(desc).toLowerCase(); if (!ids.has(k)) { ids.set(k, next); descs.set(next, desc); next++; } return ids.get(k); };
const IMP_HELM = idOf(itemNamed('Imperial Helmet')), THALMOR = idOf(itemNamed('Thalmor Robes')), ORC = idOf(itemNamed('Orcish Armor'));
const WR_ARMOR = idOf(itemNamed("Whiterun Guard's Armor")), VAMP = idOf(itemNamed('Vampire Armor', 'Vampire clans'));
const IRON = idOf('12e46:Skyrim.esm');

// Characters and their factions
const A = { OUT: 1, LEG: 2, LEG_SMITH: 3, LEG_BOSS: 4, LEG_TAILOR: 5, TH_TAILOR: 6, TH_SMITH: 7, ORC_SMITH: 8, WR_SMITH: 9, RF_SMITH: 10, VAMP_SMITH: 11, ADMIN: 12 };
const ranks = {
  [A.LEG]: [{ id: 'imperial-legion', role: 'member' }], [A.LEG_SMITH]: [{ id: 'imperial-legion', role: 'blacksmith' }],
  [A.LEG_BOSS]: [{ id: 'imperial-legion', role: 'leader' }], [A.LEG_TAILOR]: [{ id: 'imperial-legion', role: 'tailor' }],
  [A.TH_TAILOR]: [{ id: 'thalmor', role: 'tailor' }], [A.TH_SMITH]: [{ id: 'thalmor', role: 'blacksmith' }],
  [A.ORC_SMITH]: [{ id: 'clan-largashbur', role: 'blacksmith' }], [A.WR_SMITH]: [{ id: 'hold-whiterun', role: 'blacksmith' }],
  [A.RF_SMITH]: [{ id: 'hold-riften', role: 'blacksmith' }], [A.VAMP_SMITH]: [{ id: 'crimson-scars', role: 'blacksmith' }],
};
globalThis.__dboGuildsOf = (a) => ranks[a] || [];
globalThis.__dboGuildInfo = (fid) => { const f = defs.find((x) => x.id === fid); return f ? { id: f.id, name: f.name } : null; };
const said = [], audits = [], commands = new Map();
const cfg = { factionGear: { enabled: true } };   // switched on for the rules; the off state is checked at the end
// Armor records: body pieces carry BOD2 slot 32 (bit 2), a shield slot 39 (bit 9)
const bod2 = (mask) => ({ record: { type: 'ARMO', fields: [{ type: 'BOD2', data: new Uint8Array(new Uint32Array([mask]).buffer) }] } });
const bodyIds = new Set(), shieldIds = new Set();
const equipment = new Map();   // actor -> worn base ids
const mp = { getDescFromId: (id) => descs.get(id) || '', getIdFromDesc: (d) => idOf(d),
  lookupEspmRecordById: (id) => (bodyIds.has(id) ? bod2(1 << 2) : shieldIds.has(id) ? bod2(1 << 9) : { record: null }),
  get: (a, p) => (p === 'equipment' ? { inv: { entries: (equipment.get(a) || []).map((baseId) => ({ baseId, count: 1, worn: true })) } } : undefined) };
const api = { mp, log: () => {}, personal: (a, t) => said.push([a, t]), audit: (t) => audits.push(t), who: String, cfg, registerChatCommand: (n, fn) => commands.set(n, fn), isAdmin: (a) => a === A.ADMIN, sendPacket: () => true };
globalThis.__dboFactionGearState = undefined;
require(path.join(SERVER, 'factiongear.js'))(api);
const craft = globalThis.__dboFactionCraft;
// The module tells one crafter at most every 1.5 s; each check here is a fresh attempt
const fresh = () => globalThis.__dboFactionGearState.toldAt.clear();
const lastTo = (a) => { for (let i = said.length - 1; i >= 0; i--) if (said[i][0] === a) return said[i][1]; return ''; };

check('an item no faction owns is open to all', craft(A.OUT, IRON) === true);
check('Imperial Helmet: refused to an outsider', craft(A.OUT, IMP_HELM) === false && /Imperial Helmet is made only by the Imperial Legion's smiths\. Your materials return when you leave the forge\./.test(lastTo(A.OUT)), lastTo(A.OUT));
check('...and to a Legionnaire, who is told it takes the Blacksmith rank', craft(A.LEG, IMP_HELM) === false && /You are one of them, but it takes their Blacksmith rank or their leader/.test(lastTo(A.LEG)), lastTo(A.LEG));
check('...and to the Legion\'s Quartermaster (tailor) at the forge', craft(A.LEG_TAILOR, IMP_HELM) === false);
check("the Legion Smith makes it", craft(A.LEG_SMITH, IMP_HELM) === true);
check('so does the General (leader)', craft(A.LEG_BOSS, IMP_HELM) === true);
check('Thalmor Robes are loom work: the Thalmor tailor makes them', gear[descs.get(THALMOR)].role === 'tailor' && craft(A.TH_TAILOR, THALMOR) === true);
check('...the Thalmor smith does not, and is sent to the loom', craft(A.TH_SMITH, THALMOR) === false && /leave the loom/.test(lastTo(A.TH_SMITH)), lastTo(A.TH_SMITH));
// The Thalmor loom sets (Nate, 5 Oct: "Thalmor gear should only be crafted by the Thalmor player faction"; the PC pass
// strips the recipes' quest and High Elf conditions, so this gate is the whole rule)
const thalmor = Object.entries(gear).filter(([, v]) => v.set === 'Thalmor' && /MoreCraftableEquipment\.esp$/.test(v.recipes[0])); // the PC's Sentinel Thalmor armour (5 Oct) is forge work beside them
check('the five Thalmor pieces belong to the Thalmor faction alone, loom work, one MoreCraftableEquipment recipe each',
  thalmor.length === 5 && thalmor.every(([, v]) => JSON.stringify(v.factions) === '["thalmor"]' && v.role === 'tailor') &&
  JSON.stringify(thalmor.map(([, v]) => v.recipes[0]).sort()) === JSON.stringify(['9ca', '9cb', '9cc', '9cd', '9ce'].map((r) => `${r}:MoreCraftableEquipment.esp`)), thalmor.map(([k, v]) => [k, v.name, v.recipes]));
check('the faction is guild-defs.json\'s "thalmor", with a tailor rank (Robe-Maker) and a leader', (() => { const f = defs.find((x) => x.id === 'thalmor'); return !!f && f.name === 'Thalmor' && f.ranks.some((r) => r.role === 'tailor' && r.title === 'Robe-Maker') && f.ranks.some((r) => r.role === 'leader'); })());
ranks[20] = [{ id: 'thalmor', role: 'member' }]; ranks[21] = [{ id: 'thalmor', role: 'leader' }];
fresh();
for (const [desc, v] of thalmor) {
  const id = idOf(desc);
  fresh();
  const out = craft(A.OUT, id) === false && lastTo(A.OUT) === `${v.name} is made only by the Thalmor's tailors. Your materials return when you leave the loom.`;
  fresh();
  check(`${v.name}: an outsider is refused and told only the Thalmor's tailors make it; the Robe-Maker and the First Emissary make it; a Thalmor Soldier is told the rank`,
    out && craft(A.TH_TAILOR, id) === true && craft(21, id) === true && craft(20, id) === false && /You are one of them, but it takes their Tailor rank or their leader/.test(lastTo(20)), [lastTo(A.OUT), lastTo(20)]);
}
check("Orcish Armor: any stronghold's smith", craft(A.ORC_SMITH, ORC) === true);
fresh();
check("...no one else, and the line names the strongholds", craft(A.OUT, ORC) === false && /made only by the strongholds' smiths/.test(lastTo(A.OUT)), lastTo(A.OUT));
check("Whiterun Guard's Armor: Whiterun's Hold Smith", craft(A.WR_SMITH, WR_ARMOR) === true);
check("...not Riften's", craft(A.RF_SMITH, WR_ARMOR) === false && /Whiterun Hold's smiths/.test(lastTo(A.RF_SMITH)), lastTo(A.RF_SMITH));
check('Vampire Armor: a Crimson Scars smith, one of the vampire clans', craft(A.VAMP_SMITH, VAMP) === true);
fresh();
check('...an outsider is told the vampire clans', craft(A.OUT, VAMP) === false && /the vampire clans' smiths/.test(lastTo(A.OUT)), lastTo(A.OUT));
check('an admin passes', craft(A.ADMIN, IMP_HELM) === true);
commands.get('factiongear')(A.ADMIN, 'test');
check('...unless /factiongear test holds them to the rules', craft(A.ADMIN, IMP_HELM) === false);
commands.get('factiongear')(A.ADMIN, 'test');
check('each refusal is audited with the set and why', audits.some((t) => /FACTIONGEAR refused .*Imperial Helmet \(Imperial Legion, rank\)/.test(t)), audits.slice(0, 2));
// The modded silver is the Silver Hand's; the base game's silver is not
check("Immersive Weapons' Silver Longsword is the Silver Hand's", Object.values(gear).some((v) => v.name === 'Silver Longsword' && v.factions[0] === 'silver-hand' && v.recipes.every((r) => /Immersive Weapons/.test(r))));
check("the base game's Silver Sword and Silver Greatsword are open", !Object.values(gear).some((v) => /^Silver (Sword|Greatsword)$/.test(v.name) && v.recipes.some((r) => /MoreCraftableEquipment/.test(r))));
check('arrows and bolts are open', !Object.values(gear).some((v) => /Arrow|Bolt/.test(v.name)));

// ---- war uniforms (realm.js asks __dboInUniform at every standard) -----------------------------------------------
const LEG_ARMOR = idOf(itemNamed('Imperial Light Armor')), BRUMA_CUIRASS = idOf('723cd:BSHeartland.esm'), WH_SHIELD = idOf(itemNamed("Windhelm Guard's Shield"));
bodyIds.add(LEG_ARMOR); bodyIds.add(BRUMA_CUIRASS); bodyIds.add(WR_ARMOR); shieldIds.add(WH_SHIELD); shieldIds.add(IMP_HELM);
globalThis.__dboFactionGearState.checkedAt = 0; globalThis.__dboFactionGearState.mtime = -1;   // re-read with the body pieces known
equipment.set(A.LEG, [LEG_ARMOR]);
check('a Legionnaire in Imperial Light Armor is in uniform', globalThis.__dboInUniform(A.LEG, 'imperial-legion') === true);
equipment.set(A.LEG, [IMP_HELM]);
check('...a helmet alone is not the uniform: it takes a body piece', globalThis.__dboInUniform(A.LEG, 'imperial-legion') === false);
equipment.set(A.LEG, [WR_ARMOR]);
check("...nor is another faction's armor", globalThis.__dboInUniform(A.LEG, 'imperial-legion') === false);
equipment.set(A.OUT, [BRUMA_CUIRASS]);
check("the County of Bruma's uniform is its guard cuirass, which no recipe makes", globalThis.__dboInUniform(A.OUT, 'county-bruma') === true);
check('the Fighters Guild has no uniform, so the rule cannot hold it', globalThis.__dboInUniform(A.OUT, 'fighters-guild') === null && globalThis.__dboHasUniform('fighters-guild') === false);
// Windhelm's uniform is Sentinel - City Guards' Windhelm kit (Nate): the cuirass counts, its helmet alone does not
const WH_CUIRASS = idOf('815:Sentinel - City Guards.esp'), WH_HELMET = idOf('819:Sentinel - City Guards.esp');
bodyIds.add(WH_CUIRASS); globalThis.__dboFactionGearState.checkedAt = 0; globalThis.__dboFactionGearState.mtime = -1;
equipment.set(A.OUT, [WH_HELMET]);
check("a Windhelm guard's helmet alone is not Windhelm's uniform", globalThis.__dboInUniform(A.OUT, 'hold-windhelm') === false);
equipment.set(A.OUT, [WH_CUIRASS, WH_HELMET]);
check("Sentinel's Windhelm cuirass is Windhelm's uniform", globalThis.__dboInUniform(A.OUT, 'hold-windhelm') === true);
check('the Fighters Guild stays exempt (Nate)', globalThis.__dboHasUniform('fighters-guild') === false);

// Through regions.js's craft hook, as the server calls it
let prevCalls = 0;
mp.onCraft = function () { prevCalls++; return undefined; };
globalThis.__dboPrevCraft = undefined; globalThis.__dboRegionsState = undefined;
require(path.join(SERVER, 'regions.js'))(Object.assign({}, api, { cfg: { regions: { craft: false } } }));
check('the craft hook refuses an outsider\'s Imperial Helmet before anything else runs', mp.onCraft(A.OUT, IMP_HELM, 1, 0x999) === false && prevCalls === 0);
check('...and passes the Legion Smith\'s on to the chain it wraps', mp.onCraft(A.LEG_SMITH, IMP_HELM, 1, 0x999) === undefined && prevCalls === 1);
cfg.factionGear = { enabled: false };
globalThis.__dboFactionGearState = undefined;
require(path.join(SERVER, 'factiongear.js'))(Object.assign({}, api, { cfg }));
check('with factionGear.enabled false everyone may', globalThis.__dboFactionCraft(A.OUT, IMP_HELM) === true);
check('...an admin too', globalThis.__dboFactionCraft(A.ADMIN, IMP_HELM) === true);
commands.get('factiongear')(A.ADMIN, 'test');
globalThis.__dboFactionGearState.toldAt.clear();
check('...but an admin in test mode is held to the rules while it is off (the live test)', globalThis.__dboFactionCraft(A.ADMIN, IMP_HELM) === false && /made only by the Imperial Legion's smiths/.test(lastTo(A.ADMIN)), lastTo(A.ADMIN));
check('...while players still pass', globalThis.__dboFactionCraft(A.OUT, IMP_HELM) === true);
commands.get('factiongear')(A.ADMIN, '');
check('/factiongear says it is off for players and test mode still applies', /off for players; test mode still applies to you: \d+ items.*Test mode is on for you/.test(lastTo(A.ADMIN)), lastTo(A.ADMIN));
// The shipped defaults: off in the code and in gamemode-config.json
const shipped = JSON.parse(fs.readFileSync(path.join(SERVER, 'gamemode-config.json'), 'utf8')).factionGear;
check('gamemode-config.json switches it on (Nate, 2026-09-28)', shipped && shipped.enabled === true, shipped && shipped.enabled);
globalThis.__dboFactionGearState = undefined;
require(path.join(SERVER, 'factiongear.js'))(Object.assign({}, api, { cfg: {} }));
check('with no config at all it is off', globalThis.__dboFactionCraft(A.OUT, IMP_HELM) === true);

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
