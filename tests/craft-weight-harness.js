// A dish weighed by how much goes into it (GroundedPasta and swag, 2026-09-30: "the cooking exp goes up so slow",
// "you should get more exp from making more complex food"). masterySystem reads each recipe's ingredient entries and
// its Cook tier gate (HasSpell DBO_Skill_cook_T<n>, tools/recipes) and weighs the craft by skills.json cook.craftWeight;
// every other skill keeps the product-value weight. Loads the real skills.json.
//
//   node tests/craft-weight-harness.js <bundled masterySystem.js>
//   (bundle: cd fork/skymp5-server && ./node_modules/.bin/esbuild ts/systems/masterySystem.ts --bundle --platform=node
//    --format=cjs --outfile=<out>)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests/craft-weight-harness.js <bundled masterySystem.js>'); process.exit(2); }
// A server from before the fork half (mastery-craft-weight 447ab5fa, in the server-next-v2 batch) ignores the key, so
// there is nothing to test yet: said and not failed, as the front harnesses do for a widget the client lacks
if (!/craftWeight/.test(fs.readFileSync(bundle, 'utf8'))) { require('./expect')('craft-weight', 'this masterySystem has no craft weight'); console.log('ok   skipped: this server predates the craft weight (fork mastery-craft-weight)'); process.exit(0); }
const { MasterySystem } = require(path.resolve(bundle));
let fails = 0, checks = 0;
const eq = (label, got, want, tol = 1e-9) => {
  checks++;
  const ok = typeof want === 'number' ? Math.abs(got - want) <= tol : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`  FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); } else console.log(`  ok   ${label}`);
};

// ---- the real skills.json, read the way the server reads it -------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-craftw-'));
fs.copyFileSync(path.join(__dirname, '..', 'skills.json'), path.join(dir, 'skills.json'));
const cwd = process.cwd();
process.chdir(dir);
const sys = new MasterySystem(() => { });
try { sys.loadSkillsFile(); } finally { process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true }); }
const cook = sys.skills.find((k) => k.id === 'cook');
const smith = sys.skills.find((k) => k.id === 'blacksmith');
eq('skills.json gives Cook a craftWeight', !!(cook && cook.craftWeight), true);
eq('...by tier 1..5', cook.craftWeight.byTier, [1, 1.5, 2, 2.5, 3]);
eq('the Blacksmith keeps the product-value weight (no craftWeight)', smith.craftWeight, null);

// ---- a world of recipes -------------------------------------------------------------------------------------------
const world = new Map();
const u8 = (n, fill) => { const b = new Uint8Array(n); fill(new DataView(b.buffer)); return b; };
const cnto = () => ({ type: 'CNTO', data: u8(8, (v) => { v.setUint32(0, 1, true); v.setInt32(4, 1, true); }) });
// CTDA: function index uint16 at 8, first parameter (record-local form id) at 12
const ctda = (fn, local) => ({ type: 'CTDA', data: u8(32, (v) => { v.setUint8(0, 0); v.setFloat32(4, 1, true); v.setUint16(8, fn, true); v.setUint32(12, local, true); }) });
const MARKERS = { 1: 'DBO_Skill_cook_T1', 3: 'DBO_Skill_cook_T3', 5: 'DBO_Skill_cook_T5', 9: 'DBO_Skill_blacksmith_T4', 7: 'SomeOtherSpell' };
const MAP = {};
for (const [local, edid] of Object.entries(MARKERS)) {
  const id = 0x3c000000 + Number(local);
  world.set(id, { record: { type: 'SPEL', editorId: edid, fields: [] } });
  MAP[local] = id;
}
const recipe = (id, parts, conds) => world.set(id, {
  record: { type: 'COBJ', editorId: '', fields: Array.from({ length: parts }, cnto).concat(conds) },
  toGlobalRecordId: (local) => { if (!(local in MAP)) throw new Error('unmapped'); return MAP[local]; },
});
recipe(0x100, 2, []);                         // salt and one thing, no gate yet (before the PC run)
recipe(0x101, 4, []);                         // a four-ingredient stew, no gate yet
recipe(0x102, 9, []);                         // more ingredients than the table: its last entry
recipe(0x103, 2, [ctda(264, 3)]);             // gated at Cook tier 3 (HasSpell DBO_Skill_cook_T3)
recipe(0x104, 5, [ctda(264, 5), ctda(448, 7)]); // tier 5 gate beside some other condition
recipe(0x105, 2, [ctda(264, 9)]);             // a Blacksmith tier gate: not Cook's
recipe(0x106, 2, [ctda(264, 7)]);             // HasSpell on something that is not a tier marker
recipe(0x107, 2, [ctda(47, 3)]);              // function 47 (GetItemCount) on a marker's id: not a gate
recipe(0x108, 3, [ctda(264, 0x77)]);          // a gate whose parameter is an unmapped master: ignored, no throw
const ctx = { svr: { lookupEspmRecordById: (id) => world.get(id >>> 0) || null } };

const shape = (id) => sys.recipeShape(ctx, id);
eq('ingredient entries are counted', shape(0x101).parts, 4);
eq('the Cook tier gate is read', [shape(0x103).tier, shape(0x103).tierSkill], [3, 'cook']);
eq('...beside other conditions', [shape(0x104).tier, shape(0x104).tierSkill], [5, 'cook']);
eq('a Blacksmith gate names the Blacksmith', [shape(0x105).tier, shape(0x105).tierSkill], [4, 'blacksmith']);
eq('HasSpell on an ordinary spell is no gate', shape(0x106).tier, 0);
eq('another function on a marker is no gate', shape(0x107).tier, 0);
eq('an unmapped parameter is skipped, not thrown', shape(0x108).parts, 3);

// the event the onCraft chain builds, then the weight each skill gets from it
const event = (recipeId, value) => {
  const s = shape(recipeId);
  const detail = { recipeId, held: 1, value, parts: s.parts };
  if (s.tierSkill) detail[`tier:${s.tierSkill}`] = s.tier;
  return { kind: 'craft', actorId: 0x14, detail };
};
const w = (skill, recipeId, value = 5) => sys.weightFor(skill, event(recipeId, value));
eq('before the PC run: salt and one thing is 1', w('cook', 0x100), 1);
eq('...a four-ingredient stew 2', w('cook', 0x101), 2);
eq('...nine ingredients take the last entry, 3', w('cook', 0x102), 3);
eq('after it: a tier 3 dish is 2, whatever its ingredients', w('cook', 0x103), 2);
eq('...a tier 5 dish 3', w('cook', 0x104), 3);
eq('a Blacksmith gate on a recipe does not set a Cook tier: ingredients decide', w('cook', 0x105), 1);
eq('a valuable product is never worth less than before (1200 gold: 3)', w('cook', 0x100, 1200), 3);
eq('the Blacksmith still weighs by value: 5 gold is 0.5 + 5/400', w('blacksmith', 0x105, 5), 0.51);
eq('...and 1000 gold is 3', w('blacksmith', 0x105, 1000), 3);
eq('other kinds are untouched (mine, ore band 2)', sys.weightFor('cook', { kind: 'mine', actorId: 0x14, detail: { value: 2 } }), 1.5);
eq('the shape is cached', sys.recipeShape(ctx, 0x103) === sys.recipeShape(ctx, 0x103), true);

// ---- what it means in hours ---------------------------------------------------------------------------------------
// A cook at 40 dishes an hour, five different recipes eight times each (the same dish again within the hour counts
// 1/(1+k/8)), the hourly bucket at pointSystem.bucketPerHour. Units to reach a level: skillPoints (250, 750, 1750, 2950).
const ps = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'skills.json'), 'utf8')).pointSystem;
const perHour = Number(ps.bucketPerHour) || 30;
const decay = Array.from({ length: 8 }, (_, k) => 1 / (1 + k / 8)).reduce((a, b) => a + b, 0);
const rate = (weight) => Math.min(perHour, weight * 5 * decay);
const before = rate(0.5);
const legs = [[250, rate(1)], [500, rate(1.5)], [1000, rate(2)], [1200, rate(2.5)]]; // T1 dishes to L25, T2 to L50...
const cum = (list) => list.reduce((acc, [u, r]) => acc.concat((acc.length ? acc[acc.length - 1] : 0) + u / r), []);
const after = cum(legs);
const was = [250, 750, 1750, 2950].map((u) => u / before);
console.log(`\n  hours to Apprentice / Journeyman / Expert / Master at 40 dishes an hour, five recipes:`);
console.log(`    before: ${was.map((h) => h.toFixed(1)).join(' / ')}  (every dish 0.5: ${before.toFixed(1)} units an hour)`);
console.log(`    after:  ${after.map((h) => h.toFixed(1)).join(' / ')}  (tier-1 dishes ${rate(1).toFixed(1)} an hour, then the ${perHour}-unit bucket)`);
eq('a new cook reaches Apprentice about twice as fast', was[0] / after[0] > 1.9, true);
eq('from Apprentice on, cooking fills the hour as any trade can', rate(1.5), perHour);

console.log(fails ? `\n${fails} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
process.exit(fails ? 1 : 0);
