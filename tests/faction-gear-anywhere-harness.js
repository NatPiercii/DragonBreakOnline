// A faction's own gear is made by its own smith or leader anywhere (Nate, 7 Oct: the Dawnguard lead in Bruma could make
// none of the Dawnguard's armour, every recipe of which is Skyrim's), and the Dawnguard's smiths make the Silver Hand's
// silver weapons too, not its mantle. Loads the real factiongear.js and regions.js with the real faction-gear.json and
// regions.json and the province rule on, a smith standing in Bruma, and drives mp.onCraft.
//   node tests/faction-gear-anywhere-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-fganywhere-'));
for (const f of ['faction-gear.json', 'regions.json', 'regions-overrides.json']) { try { fs.copyFileSync(path.join(SERVER, f), path.join(dir, f)); } catch (e) { /* optional */ } }
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };

const ids = new Map(), descs = new Map(); let next = 0x100;
const idOf = (d) => { const k = String(d).toLowerCase(); if (!ids.has(k)) { ids.set(k, next); descs.set(next, d); next++; } return ids.get(k); };
const DG_ARMOR = idOf('f3fb:Dawnguard.esm'), DG_ARMOR_RECIPE = idOf('863:MoreCraftableEquipment.esp');
const SILVER_LONG = idOf('747dc:Immersive Weapons.esp'), SILVER_LONG_RECIPE = idOf('c74734:Immersive Weapons.esp');
const MANTLE = idOf('23068:Hothtrooper44_ArmorCompilation.esp');
const NORDIC = idOf('62d62:Immersive Weapons.esp'), NORDIC_RECIPE = idOf('1828:Immersive Weapons.esp');

const A = { DG_SMITH: 1, DG_LEAD: 2, DG_MEMBER: 3, OUT: 4, ADMIN: 5, SH_SMITH: 6 };
const ranks = { [A.DG_SMITH]: [{ id: 'dawnguard', role: 'blacksmith' }], [A.DG_LEAD]: [{ id: 'dawnguard', role: 'leader' }],
  [A.DG_MEMBER]: [{ id: 'dawnguard', role: 'member' }], [A.SH_SMITH]: [{ id: 'silver-hand', role: 'blacksmith' }] };
globalThis.__dboGuildsOf = (a) => ranks[a] || [];
globalThis.__dboGuildInfo = (fid) => ({ id: fid, name: fid === 'dawnguard' ? 'Dawnguard' : fid });
const props = new Map();
for (const a of Object.values(A)) { props.set(`${a}|worldOrCellDesc`, 'a764b:BSHeartland.esm'); props.set(`${a}|pos`, [0, 0, 0]); }
const said = [];
const mp = { getDescFromId: (id) => descs.get(id) || '', getIdFromDesc: idOf, get: (a, k) => props.get(`${a}|${k}`), set: () => {},
  lookupEspmRecordById: () => null, callPapyrusFunction: () => null };
const chain = [];
mp.onCraft = (a, item, n, recipe) => { chain.push([a, recipe]); return undefined; };
const api = { mp, log: () => {}, personal: (a, t) => said.push([a, t]), audit: () => {}, who: String, registerChatCommand: () => {},
  isAdmin: (a) => a === A.ADMIN, sendPacket: () => true, openWidget: () => true, closeWidget: () => true, onUi: () => {}, onlineActors: () => [],
  every: () => {}, distanceMeters: () => 0, takeGold: () => false, giveItem: () => true, depositToTreasury: (z, n) => n,
  cfg: { factionGear: { enabled: true }, regions: { craft: true, failOpen: true, defaultPlace: 'cyrodiil', adminBypass: true }, smelting: { firewoodPerIngot: 0 } } };
globalThis.__dboFactionGearState = undefined; globalThis.__dboPrevCraft = undefined; globalThis.__dboRegionsState = undefined;
require(path.join(SERVER, 'factiongear.js'))(api);
require(path.join(SERVER, 'regions.js'))(api);
const craft = (a, item, recipe) => { chain.length = 0; said.length = 0; const v = mp.onCraft(a, item, 1, recipe); return { v, made: chain.length === 1 }; };

const smith = craft(A.DG_SMITH, DG_ARMOR, DG_ARMOR_RECIPE);
ok(smith.v !== false && smith.made, 'a Dawnguard smith in Bruma makes Dawnguard Armor (a Skyrim recipe)', said);
ok(craft(A.DG_LEAD, DG_ARMOR, DG_ARMOR_RECIPE).made, '...and so does the Dawnguard leader');
const member = craft(A.DG_MEMBER, DG_ARMOR, DG_ARMOR_RECIPE);
ok(member.v === false && /Blacksmith rank or their leader/.test((said[0] || [])[1] || ''), 'a Dawnguard member without the smith rank is still refused, by the faction rule', said);
ok(craft(A.OUT, DG_ARMOR, DG_ARMOR_RECIPE).v === false, 'an outsider is refused');
const nordic = craft(A.DG_SMITH, NORDIC, NORDIC_RECIPE);
ok(nordic.v === false && !nordic.made, 'the same smith making other Skyrim gear in Bruma is still held to the province', said);
ok(craft(A.DG_SMITH, SILVER_LONG, SILVER_LONG_RECIPE).made, 'a Dawnguard smith makes the Silver Hand\'s Silver Longsword');
ok(craft(A.SH_SMITH, SILVER_LONG, SILVER_LONG_RECIPE).made, '...and the Silver Hand\'s smith still does');
ok(globalThis.__dboFactionCraft(A.DG_SMITH, MANTLE) === false, 'the Mantle of the Silver Hand stays the Silver Hand\'s');
ok(globalThis.__dboFactionGearMember(A.ADMIN, DG_ARMOR) === false && globalThis.__dboFactionGearMember(A.DG_SMITH, DG_ARMOR) === true && globalThis.__dboFactionGearMember(A.DG_SMITH, NORDIC) === false,
  'only a member making their own faction\'s gear counts, not staff and not open items');
const silver = JSON.parse(fs.readFileSync('faction-gear.json', 'utf8')).items;
const sh = Object.values(silver).filter((v) => v.set === 'Silver Hand');
ok(sh.filter((v) => !/Mantle/.test(v.name)).every((v) => v.factions.includes('dawnguard')) && sh.filter((v) => /Mantle/.test(v.name)).every((v) => !v.factions.includes('dawnguard')),
  'every Silver Hand weapon lists the Dawnguard, no mantle does');
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
