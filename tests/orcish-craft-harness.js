// Only an Orc makes Orcish armour (Nate, 2026-10-06). regions.js craftHook refuses an Orcish ARMO (by editor id or the
// ArmorMaterialOrcish keyword) to every other race, before the faction rule; staff pass with adminBypass; tempering
// stays open to all; Orcish weapons only when config orcishCraft.weapons is on. Loads the real regions.js against fake
// plugin records and drives mp.onCraft.
//   node tests/orcish-craft-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-orcish-'));
process.on('exit', () => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
process.chdir(scratch);
for (const f of ['regions.json', 'regions-overrides.json', 'dragon-materials.json', 'artifacts.json', 'skills.json', 'spell-tomes.json']) {
  try { fs.copyFileSync(path.join(SERVER, f), f); } catch (e) { /* optional */ }
}

// Fake records: Skyrim.esm ids as plain numbers, a second plugin at index 0x0b
const sky = (h) => parseInt(h, 16) >>> 0;
const recs = new Map();
const u32 = (...ids) => { const b = new Uint8Array(ids.length * 4); const dv = new DataView(b.buffer); ids.forEach((v, i) => dv.setUint32(i * 4, v >>> 0, true)); return b; };
const rec = (id, type, editorId, fields = []) => recs.set(id >>> 0, { record: { type, editorId, fields } });
const KW_ORC_ARMOR = sky('6bbe5'), KW_ORC_WEAP = sky('1e7a6'), KW_ARMOR_TABLE = sky('adb78'), KW_FORGE = sky('88105'), KW_STEEL = sky('6bbd7');
rec(KW_ORC_ARMOR, 'KYWD', 'ArmorMaterialOrcish'); rec(KW_ORC_WEAP, 'KYWD', 'WeapMaterialOrcish');
rec(KW_ARMOR_TABLE, 'KYWD', 'CraftingSmithingArmorTable'); rec(KW_FORGE, 'KYWD', 'CraftingSmithingForge'); rec(KW_STEEL, 'KYWD', 'ArmorMaterialSteel');
const ORC_CUIRASS = sky('13957'), ORC_BOOTS_BS = 0x0b0e1000, ORC_SWORD = sky('13991'), STEEL_CUIRASS = sky('13952');
rec(ORC_CUIRASS, 'ARMO', 'ArmorOrcishCuirass', [{ type: 'KWDA', data: u32(KW_ORC_ARMOR) }]);
rec(ORC_BOOTS_BS, 'ARMO', 'CYRBootsHeavyCustom', [{ type: 'KWDA', data: u32(KW_ORC_ARMOR) }]);   // told by its keyword only
rec(ORC_SWORD, 'WEAP', 'OrcishSword', [{ type: 'KWDA', data: u32(KW_ORC_WEAP) }]);
rec(STEEL_CUIRASS, 'ARMO', 'ArmorSteelCuirassA', [{ type: 'KWDA', data: u32(KW_STEEL) }]);
const R_FORGE = sky('a1001'), R_TEMPER = sky('a1002');
rec(R_FORGE, 'COBJ', 'RecipeArmorOrcishCuirass', [{ type: 'BNAM', data: u32(KW_FORGE) }]);
rec(R_TEMPER, 'COBJ', 'TemperArmorOrcishCuirass', [{ type: 'BNAM', data: u32(KW_ARMOR_TABLE) }]);
const ORC_RACE = sky('13747'), ORC_VAMP = sky('a82b9'), NORD_RACE = sky('13746');

const props = new Map(), said = [], audits = [], chain = [];
const desc = (id) => `${(id & 0xffffff).toString(16)}:${(id >>> 24) === 0x0b ? 'BSHeartland.esm' : 'Skyrim.esm'}`;
const mp = {
  getIdFromDesc: (d) => { const [h, p] = String(d).split(':'); return ((/bsheartland/i.test(p) ? 0x0b000000 : 0) | parseInt(h, 16)) >>> 0; },
  getDescFromId: desc, get: (id, p) => props.get(id + '|' + p), set: (id, p, v) => props.set(id + '|' + p, v),
  lookupEspmRecordById: (id) => recs.get(id >>> 0) || null, callPapyrusFunction: () => null,
};
mp.onCraft = (a, item, n, recipe) => { chain.push(recipe); return undefined; };
delete globalThis.__dboPrevCraft;
delete globalThis.__dboFactionCraft;
const ORC = 0xff000101, NORD = 0xff000102, VAMP_ORC = 0xff000103, STAFF = 0xff000104, NOBODY = 0xff000105;
const raceOf = { [ORC]: ORC_RACE, [NORD]: NORD_RACE, [VAMP_ORC]: ORC_VAMP, [STAFF]: NORD_RACE };
for (const a of [ORC, NORD, VAMP_ORC, STAFF, NOBODY]) {
  if (raceOf[a]) props.set(a + '|appearance', { raceId: raceOf[a] });
  props.set(a + '|worldOrCellDesc', 'a764b:BSHeartland.esm'); props.set(a + '|pos', [0, 0, 0]);
}
const load = (orcishCraft) => {
  delete globalThis.__dboPrevCraft;
  mp.onCraft = (a, item, n, recipe) => { chain.push(recipe); return undefined; };
  const cfg = { regions: { craft: false, failOpen: true, defaultPlace: 'cyrodiil', adminBypass: true } };
  if (orcishCraft) cfg.orcishCraft = orcishCraft;
  require(path.join(SERVER, 'regions.js'))({
    mp, log: () => {}, personal: (a, t) => said.push([a, t]), audit: (t) => audits.push(t), who: (a) => `P${a.toString(16)}`, cfg,
    registerChatCommand: () => {}, isAdmin: (a) => a === STAFF, sendPacket: () => true, openWidget: () => true, closeWidget: () => true,
    onUi: () => {}, onlineActors: () => [], every: () => {}, distanceMeters: () => 0, takeGold: () => false, giveItem: () => true,
    depositToTreasury: (z, n) => n,
  });
};
try { load(null); } catch (e) { ok(false, 'regions.js loads', e.stack); process.exit(1); }
const craft = (a, item, recipe = R_FORGE) => mp.onCraft(a, item, 1, recipe);

ok(craft(NORD, ORC_CUIRASS) === false, 'a Nord cannot make an Orcish cuirass');
ok(!chain.includes(R_FORGE), '...and the refused craft never reaches the chain (no materials used, no credit)');
ok(said.some(([a, t]) => a === NORD && /Only an Orc smith/.test(t) && /materials come back/.test(t)), '...and is told why, and that the materials come back', said);
ok(audits.some((t) => /ORCISH craft refused PFF000102|ORCISH craft refused Pff000102/.test(t) && /nord/.test(t)), '...and it is audited with the race', audits);
chain.length = 0;
ok(craft(ORC, ORC_CUIRASS) !== false && chain.includes(R_FORGE), 'an Orc makes it');
chain.length = 0;
ok(craft(VAMP_ORC, ORC_CUIRASS) !== false && chain.includes(R_FORGE), 'so does a vampire Orc');
ok(craft(NORD, ORC_BOOTS_BS) === false, 'a piece told only by its ArmorMaterialOrcish keyword is refused to a Nord too');
ok(craft(NOBODY, ORC_CUIRASS) === false, 'a character whose race cannot be read is refused (fails closed)');
chain.length = 0;
ok(craft(STAFF, ORC_CUIRASS) !== false && chain.includes(R_FORGE), 'staff pass, as with the province rule');
chain.length = 0;
ok(craft(NORD, ORC_CUIRASS, R_TEMPER) !== false && chain.includes(R_TEMPER), 'a Nord may still temper Orcish armour at the armour table');
chain.length = 0;
ok(craft(NORD, STEEL_CUIRASS) !== false && chain.includes(R_FORGE), 'other armour is untouched');
chain.length = 0;
ok(craft(NORD, ORC_SWORD) !== false && chain.includes(R_FORGE), 'Orcish weapons stay open by default (Nate said armour)');

load({ weapons: true });
ok(craft(NORD, ORC_SWORD) === false && craft(ORC, ORC_SWORD) !== false, 'with orcishCraft.weapons on, Orcish weapons are an Orc\'s work too');
load({ enabled: false });
chain.length = 0;
ok(craft(NORD, ORC_CUIRASS) !== false && chain.includes(R_FORGE), 'orcishCraft.enabled false turns the rule off');

const src = fs.readFileSync(path.join(SERVER, 'regions.js'), 'utf8');
ok(src.indexOf('const orcish = orcishRefusal(') > 0 && src.indexOf('const orcish = orcishRefusal(') < src.indexOf("globalThis.__dboFactionCraft(actorId, itemId) === false"),
  'the race rule runs before the faction rule, so a non-Orc hears the race reason');

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
