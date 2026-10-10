// The first-time craft bonus (skillrates.js firstCraft; Discord 10 Oct, Nate: build it and turn it on with this update):
// an item a character has never made in that skill is worth `rate` times as much, in full for the first `fullFor`
// different items, then less and less; never on tempering; kept on the character. Stub records and a stub mp.
// Run from server/: node tests/first-craft-harness.js
'use strict';
const fs = require('fs');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
const MODULE = path.join(SERVER, 'skillrates.js');
const CONFIG = JSON.parse(fs.readFileSync(path.join(SERVER, 'gamemode-config.json'), 'utf8'));
let fails = 0;
const ok = (label, cond, got) => { if (!cond) { fails++; console.log(`  FAIL ${label}${got !== undefined ? `: got ${JSON.stringify(got)}` : ''}`); } else console.log(`  ok   ${label}`); };
const near = (x, y) => Math.abs(x - y) < 1e-9;

// stub records: products 0x5000+n, recipes 0x100+n at a forge or a cook pot; two temper benches
const world = new Map();
const u8 = (fill) => { const b = new Uint8Array(4); fill(new DataView(b.buffer)); return b; };
const FORGE = 0x900, POT = 0x901, TABLE = 0x902;
world.set(FORGE, { record: { type: 'KYWD', editorId: 'CraftingSmithingForge', fields: [] } });
world.set(POT, { record: { type: 'KYWD', editorId: 'CraftingCookpot', fields: [] } });
world.set(TABLE, { record: { type: 'KYWD', editorId: 'CraftingSmithingArmorTable', fields: [] } });
const recipe = (id, product, bench) => {
  world.set(product, { record: { type: 'MISC', editorId: `P${product.toString(16)}`, fields: [] } });
  world.set(id, { record: { type: 'COBJ', editorId: `R${id.toString(16)}`, fields: [{ type: 'CNAM', data: u8((v) => v.setUint32(0, product, true)) }, { type: 'BNAM', data: u8((v) => v.setUint32(0, bench, true)) }] }, toGlobalRecordId: (l) => l });
};
for (let i = 0; i < 120; i++) recipe(0x100 + i, 0x5000 + i, i < 60 ? POT : FORGE);
recipe(0x300, 0x5000, TABLE); // tempering the first dish's product (a stand-in)
const recordOf = (id) => world.get(id >>> 0) || null;
const fieldsOf = (r, type) => ((r && r.record.fields) || []).filter((f) => f.type === type);
const props = new Map(), told = [];
const mp = { get: (a, k) => props.get(`${a}|${k}`), set: (a, k, v) => props.set(`${a}|${k}`, v), getDescFromId: (id) => `${(id >>> 0).toString(16)}:Skyrim.esm` };
const load = (cfg) => { delete require.cache[MODULE]; require(MODULE)({ log: () => {}, cfg: { skillRates: cfg }, recordOf, fieldsOf, inBeastForm: () => false, mp, personal: (a, t) => told.push([a, t]) }); return globalThis.__dboSkillRate; };
const A = 0xff000101;
const craft = (rate, skill, recipeId) => rate(A, skill, 'craft', { recipeId });

// ---- what ships ----
const F = (CONFIG.skillRates || {}).firstCraft || {};
ok('config: firstCraft on (Nate, 10 Oct), x3 for the first 25, cooking, smithing, alchemy, tailoring', F.enabled === true && F.rate === 3 && F.fullFor === 25 && JSON.stringify(F.skills) === '["cook","blacksmith","alchemist","tailor"]', F);
ok('gamemode hands skillrates.js mp and personal', /require\(SKILLRATES_JS\)\(\{[^}]*mp, personal \}\)/.test(fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8')));

// ---- off ----
let rate = load({ enabled: true, rates: {} });
ok('off by default: a new dish is worth 1', craft(rate, 'cook', 0x100) === 1 && !props.get(`${A}|private.dboCraftedKinds`));

// ---- on ----
rate = load({ enabled: true, rates: { blacksmith: 2 }, firstCraft: { enabled: true, rate: 3, fullFor: 25, skills: ['cook', 'blacksmith', 'alchemist', 'tailor'] } });
told.length = 0;
ok('a dish never made before: x3, and the player is told', craft(rate, 'cook', 0x100) === 3 && told.length === 1 && /Something new/.test(told[0][1]));
ok('the same dish again: x1', craft(rate, 'cook', 0x100) === 1);
ok('kept on the character by desc', JSON.stringify(props.get(`${A}|private.dboCraftedKinds`)) === '{"cook":["5000:skyrim.esm"]}', props.get(`${A}|private.dboCraftedKinds`));
for (let i = 1; i < 25; i++) craft(rate, 'cook', 0x100 + i);
ok('the 25th different dish is still x3', props.get(`${A}|private.dboCraftedKinds`).cook.length === 25);
ok('the 26th: 1 + 2 x 25/26', near(craft(rate, 'cook', 0x100 + 25), 1 + 2 * 25 / 26));
for (let i = 26; i < 49; i++) craft(rate, 'cook', 0x100 + i);
ok('the 50th: 1 + 2 x 25/50 = 2', near(craft(rate, 'cook', 0x100 + 49), 2));
ok('tempering is never new', craft(rate, 'blacksmith', 0x300) === 2);
ok('a skill not listed (Blunt) gets nothing', rate(A, 'blunt', 'craft', { recipeId: 0x160 }) === 1);
ok('a new forge item for the smith: its rate x2, then the bonus x3 = 6', craft(rate, 'blacksmith', 0x160) === 6 && craft(rate, 'blacksmith', 0x160) === 2);
ok('each skill counts its own items (the smith\'s first is not the cook\'s 51st)', props.get(`${A}|private.dboCraftedKinds`).blacksmith.length === 1);
ok('not a craft (a hit): its rate only, never the bonus', rate(A, 'blacksmith', 'hit', { recipeId: 0x161 }) === 2 && props.get(`${A}|private.dboCraftedKinds`).blacksmith.length === 1);
// a reload or a relog: the list is on the character
rate = load({ enabled: true, rates: {}, firstCraft: { enabled: true, rate: 3, fullFor: 25, skills: ['cook'] } });
ok('after a reload the dishes made are remembered', craft(rate, 'cook', 0x100) === 1 && near(craft(rate, 'cook', 0x100 + 50), 1 + 2 * 25 / 51));
ok('a recipe the server cannot read gets nothing', craft(rate, 'cook', 0x7777) === 1);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
