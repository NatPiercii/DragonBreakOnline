// Race styles (Nate, 2026-09-30: "race plus their home province"): a people's own style is made by that race
// anywhere, and by anyone in its home province. Loads the real regions.js with the real regions.json and the tracked
// gamemode-config.json (craft forced on), and crafts one recipe per race where the province rule alone refuses it.
//   node tests/race-styles-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
const data = JSON.parse(fs.readFileSync(path.join(SERVER, 'regions.json'), 'utf8'));
const cfg = JSON.parse(fs.readFileSync(path.join(SERVER, 'gamemode-config.json'), 'utf8'));
cfg.regions = Object.assign({}, cfg.regions, { craft: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'race-styles-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
for (const f of ['regions.json', 'regions-overrides.json']) fs.copyFileSync(path.join(SERVER, f), f);

// Recipe descs get small ids of their own; race records keep their real Skyrim.esm ids
const descs = Object.keys(data.recipes); const idByDesc = new Map(), descById = new Map();
descs.forEach((d, i) => { idByDesc.set(d, 0x70000000 + i); descById.set(0x70000000 + i, d); });
const props = new Map();
const mp = {
  get: (id, k) => props.get(`${id}|${k}`), set: () => {},
  getDescFromId: (id) => descById.get(id >>> 0) || '',
  getIdFromDesc: (d) => { if (idByDesc.has(d)) return idByDesc.get(d); const [h, p] = String(d).split(':'); return p === 'Skyrim.esm' ? parseInt(h, 16) : 0; },
  lookupEspmRecordById: () => null,
};
require(path.join(SERVER, 'regions.js'))({ mp, log: () => {}, personal: () => {}, audit: () => {}, who: String, cfg, registerChatCommand: () => {}, isAdmin: () => false, sendPacket: () => {} });
const R = globalThis.__dboRegions;

const RACE = { argonian: 0x13740, breton: 0x13741, dunmer: 0x13742, altmer: 0x13743, imperial: 0x13744, khajiit: 0x13745, nord: 0x13746, orc: 0x13747, redguard: 0x13748, bosmer: 0x13749, nordVampire: 0x88794 };
const BRUMA = 'a764b:BSHeartland.esm', SKYRIM = '3c:Skyrim.esm', SOLSTHEIM = '800:Dragonborn.esm';
const A = 7;
const can = (race, place, recipe) => {
  props.set(`${A}|appearance`, { raceId: RACE[race] || 0 });
  props.set(`${A}|worldOrCellDesc`, place);
  if (!data.recipes[recipe]) throw new Error(`no recipe ${recipe}`);
  return R.recipeOk(A, 0, idByDesc.get(recipe)).ok;
};
let fail = 0;
const ok = (c, what) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}`); if (!c) fail++; };

const ORCISH = '108cfc:Skyrim.esm', STALHRIM = '2b06a:Dragonborn.esm', NORDIC_SPEAR = '1828:Immersive Weapons.esp';
const CHITIN = '2b04f:Dragonborn.esm', TRIBUNAL = '23190:Hothtrooper44_ArmorCompilation.esp', CLIFFRACER = '14c15:Journey to Baan Malur.esp';
const ALIKR = '940d78:Immersive Weapons.esp', KHAJIIT_BOW = 'b473:Immersive Weapons.esp', BOSMER = '238fd:Hothtrooper44_ArmorCompilation.esp';
const ELVEN = '108cfa:Skyrim.esm', COLOVIAN = '58d0:Immersive Weapons.esp', AYLEID = '1dff:Immersive Weapons.esp', IMPERIAL = '21476:Hothtrooper44_ArmorCompilation.esp';
const BONE_HAWK = Object.keys(data.recipes).find((d) => data.recipes[d].name === 'Bone Hawk Amulet');

ok(!can('breton', BRUMA, ORCISH) && can('orc', BRUMA, ORCISH), 'Orc: Orcish at a Bruma forge, where a Breton is refused');
ok(can('breton', SKYRIM, ORCISH), '...and anyone makes it in Skyrim, its home province');
ok(can('nord', BRUMA, STALHRIM) && can('nord', SKYRIM, STALHRIM) && !can('dunmer', SKYRIM, STALHRIM), 'Nord: stalhrim in Bruma and Skyrim (the Skaal are Nords); a Dunmer in Skyrim is refused');
ok(can('nord', BRUMA, NORDIC_SPEAR) && !can('imperial', BRUMA, NORDIC_SPEAR), 'Nord: a Nordic spear in Bruma, an Imperial is refused');
ok(!can('nord', BRUMA, BONE_HAWK), 'Nord: not the whole skyrim catch-all (the Forsworn Bone Hawk amulet is refused)');
ok(can('nordVampire', BRUMA, STALHRIM), 'a Nord vampire counts as a Nord');
ok(can('dunmer', BRUMA, CHITIN) && !can('nord', BRUMA, CHITIN), 'Dunmer: chitin in Bruma; a Nord is refused');
ok(can('dunmer', BRUMA, TRIBUNAL), 'Dunmer: Tribunal armour in Bruma');
// Cooking is known everywhere since 2026-09-30 (regions.freeBenches): the stew no longer waits on race or province
ok(can('dunmer', BRUMA, CLIFFRACER) && can('nord', BRUMA, CLIFFRACER), 'food is known everywhere, whatever the race (Cliffracer stew for a Dunmer and a Nord in Bruma)');
ok(can('redguard', SKYRIM, ALIKR) && !can('nord', SKYRIM, ALIKR), "Redguard: an Alik'r scimitar in Skyrim; a Nord is refused");
ok(can('khajiit', SKYRIM, KHAJIIT_BOW) && !can('nord', SKYRIM, KHAJIIT_BOW), 'Khajiit: an ornate Khajiit bow in Skyrim; a Nord is refused');
ok(can('bosmer', SOLSTHEIM, BOSMER) && !can('nord', SOLSTHEIM, BOSMER), 'Bosmer: Bosmer boots on Solstheim; a Nord is refused');
ok(can('altmer', SOLSTHEIM, ELVEN) && !can('nord', SOLSTHEIM, ELVEN), 'Altmer: an elven bow on Solstheim; a Nord is refused');
ok(can('imperial', SOLSTHEIM, IMPERIAL) && can('imperial', SKYRIM, COLOVIAN), 'Imperial: Imperial gear on Solstheim, Colovian in Skyrim');
ok(!can('imperial', SKYRIM, AYLEID), 'Imperial: not Ayleid (Ayleid gear stays on the province rule)');
ok(!can('argonian', BRUMA, ORCISH) && !can('breton', SKYRIM, ALIKR), 'Argonians and Bretons have no style of their own yet');

console.log(fail ? `${fail} failed` : 'all checks passed');
process.exit(fail ? 1 : 0);
