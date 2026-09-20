// Does the shipped reader get the same number out of a real record that the measurement did?
//
//   node tests\mastery-values-harness.js <bundled masterySystem.js>
//   (bundle with: cd fork\skymp5-server && ./node_modules/.bin/esbuild ts/systems/masterySystem.ts \
//      --bundle --platform=node --format=cjs --outfile=<out>)
//
// `skillPoints.weightOf` scales a craft by the product's gold value and a cast by the spell's
// magicka cost. Where those live was measured over the whole load order by `py ck-mcp\itemvalues.py`
// and written into masterySystem's PRODUCT_VALUE_AT - but a measurement in Python only proves where
// the number is, not that the TypeScript reads it. So `py ck-mcp\valuefixtures.py` dumps the raw
// bytes of REAL records out of the REAL plugins into tests\value-fixtures.json, along with the value
// it read itself, and this file runs the real productValue()/spellCost() against those bytes.
//
// That makes this a regression net for the exact class of bug being fixed: an offset that drifts, or
// a record type whose layout is not what it was assumed to be. AMMO is in the fixture on purpose -
// its value is at 12, and a first pass read flags at 4 and would have passed any looser test.
'use strict';
const fs = require('fs');
const path = require('path');

const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests\mastery-values-harness.js <bundled masterySystem.js>'); process.exit(2); }
const { MasterySystem } = require(path.resolve(bundle));
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'value-fixtures.json'), 'utf8'));

let fails = 0, checks = 0;
const eq = (label, got, want) => {
  checks++;
  if (got !== want) { fails++; console.log(`  FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};

// ---- a world made only of the records the fixture carries --------------------------------------
// Ids are invented here; only the bytes and the CNAM mapping are real.
const RECIPE_BASE = 0x0a000000, PRODUCT_BASE = 0x0b000000, SPELL_BASE = 0x0c000000;
const world = new Map();
const rec = (type, fields, map) => ({
  record: { type, editorId: '', fields: fields.map((f) => ({ type: f.type, data: Uint8Array.from(f.data) })) },
  toGlobalRecordId: (local) => { if (!(local in (map || {}))) throw new Error('unmapped master'); return map[local] >>> 0; },
});

FIX.recipes.forEach((r, i) => {
  const recipeId = RECIPE_BASE + i, productId = PRODUCT_BASE + i;
  // the recipe: a COBJ whose CNAM holds the product's PLUGIN-LOCAL id, mapped like the real espm does
  world.set(recipeId, rec('COBJ', [{ type: 'CNAM', data: r.cnamBytes }], { [r.cnamLocal]: productId }));
  world.set(productId, rec(r.product.type, [{ type: r.product.field, data: r.product.bytes }], {}));
});
FIX.spells.forEach((s, i) => world.set(SPELL_BASE + i, rec('SPEL', [{ type: 'SPIT', data: s.bytes }], {})));

const mp = { lookupEspmRecordById: (id) => world.get(id >>> 0) || null };
const ctx = { svr: mp };
const sys = new MasterySystem(() => { });

// ---- the reads ---------------------------------------------------------------------------------
console.log(`fixture: ${FIX.recipes.length} recipes, ${FIX.spells.length} spells`);
FIX.recipes.forEach((r, i) => {
  eq(`${r.product.type} ${r.product.edid} value`, sys.productValue(ctx, RECIPE_BASE + i), r.product.value);
});
FIX.spells.forEach((s, i) => {
  eq(`${s.edid} magicka cost`, sys.spellCost(ctx, SPELL_BASE + i), s.cost);
});

// every product type in the fixture is actually exercised
const types = [...new Set(FIX.recipes.map((r) => r.product.type))];
eq('AMMO is covered (its value is at 12, not 4)', types.includes('AMMO'), true);
eq('ALCH is covered (value is in ENIT, not DATA)', types.includes('ALCH'), true);

// ---- the guards --------------------------------------------------------------------------------
eq('an unknown recipe is worth 0, not NaN', sys.productValue(ctx, 0xdeadbeef), 0);
eq('recipe id 0 is worth 0', sys.productValue(ctx, 0), 0);
eq('an unknown spell costs 0', sys.spellCost(ctx, 0xdeadbeef), 0);
// a COBJ whose CNAM points at a master this plugin does not have must not throw
world.set(0x0f000001, rec('COBJ', [{ type: 'CNAM', data: [1, 0, 0, 0] }], {}));
eq('an unmapped master is worth 0', sys.productValue(ctx, 0x0f000001), 0);
// a product type with no known layout falls back to the flat base rather than reading a wrong field
world.set(0x0f000003, rec('LIGH', [{ type: 'DATA', data: [99, 0, 0, 0] }], {}));
world.set(0x0f000002, rec('COBJ', [{ type: 'CNAM', data: [2, 0, 0, 0] }], { 2: 0x0f000003 }));
eq('an unlisted product type is worth 0', sys.productValue(ctx, 0x0f000002), 0);
// a truncated field must not read past the end
world.set(0x0f000005, rec('AMMO', [{ type: 'DATA', data: [1, 0, 0, 0, 2, 0, 0, 0] }], {}));
world.set(0x0f000004, rec('COBJ', [{ type: 'CNAM', data: [3, 0, 0, 0] }], { 3: 0x0f000005 }));
eq('a DATA too short for the offset is worth 0', sys.productValue(ctx, 0x0f000004), 0);
// the caches must return the same answer twice
FIX.recipes.forEach((r, i) => eq(`${r.product.edid} cached read agrees`, sys.productValue(ctx, RECIPE_BASE + i), r.product.value));
FIX.spells.forEach((s, i) => eq(`${s.edid} cached read agrees`, sys.spellCost(ctx, SPELL_BASE + i), s.cost));

console.log(fails ? `\n${fails} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
process.exit(fails ? 1 : 0);
