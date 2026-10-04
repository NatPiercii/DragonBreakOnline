// Artifacts are never loot (Nate, 2026-09-29): artifacts.json names them, and every loot path in dungeons.js
// (all pools, the Ayleid table, what a corpse keeps) and wildlife.js (giant camp chests) leaves them out.
//   node tests/artifact-loot-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, what, got) => { if (c) pass++; else { fail++; console.log('FAIL', what, got === undefined ? '' : JSON.stringify(got)); } };

const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'artifacts.json'), 'utf8')).patterns;
ok(Array.isArray(list) && list.length > 0, 'artifacts.json lists patterns');
let re = null;
try { re = new RegExp(list.map((p) => `(?:${p})`).join('|'), 'i'); } catch (e) { ok(false, 'every pattern compiles', e.message); }
if (re) {
  // The ones the loot review found in loot.json, and the best known
  for (const n of ['ClavicusVileMask', 'CYRGoldbrand', 'CYRThorneblade', 'DBBladeOfWoeAstrid', 'DBBladeOfWoeReward', 'DBAlainAegisbane',
    'DLC1AurielsBow', 'DLC1ArmorAurielsShield', 'ArmorDragonPriestMaskUltraHelmet', 'ArmorDragonPriestMaskEbonyHelmet', 'MGRKeening',
    'NightingaleBlade03', 'DA08EbonyBlade', 'DA08RealEbonyBlade', 'ArmorNightingaleCuirassPlayer02', 'ArmorShieldofYsgramor', 'DLC2MiraakMaskNew', 'DLC2dunKolbjornHelm', 'DLC1HarkonsSword']) {
    ok(re.test(n), `${n} is an artifact`);
  }
  // Ordinary gear, generic enchanted variants and the Ayleid table's own treasure stay loot
  for (const n of ['IronSword', 'EnchIronSwordFire01', 'ArmorDragonplateCuirass', 'CYREnchRingAlchemyAyleid04', 'BSKArmorAyleidLichHelmet',
    'DLC1DragonboneSwordKeeper03', 'ArmorGlassCuirass', 'CYRGlassSword', 'StaffFireball', 'DBArmor', 'ReligiousTalosMankind']) {
    ok(!re.test(n), `${n} is ordinary loot`);
  }
  const pools = JSON.parse(fs.readFileSync(path.join(ROOT, 'loot.json'), 'utf8')).pools;
  const hits = [];
  for (const [name, items] of Object.entries(pools)) for (const it of items) if (re.test(String(it.name || ''))) hits.push(`${name}:${it.name}`);
  console.log(`artifacts in loot.json kept out: ${hits.length}`);
  ok(hits.length >= 60, 'the list catches the artifacts in loot.json', hits.length);
}

const dj = fs.readFileSync(path.join(ROOT, 'dungeons.js'), 'utf8');
ok(/const pool = \(name, maxValue, ok\) => \(LOOT\[name\] \|\| \[\]\)\.filter\(\(it\) => !ARTIFACT\.test/.test(dj), 'dungeons.js: every pool leaves artifacts out');
ok(/BANNED_LOOT\.test\(it\.name\) \|\| ARTIFACT\.test\(it\.name\)/.test(dj), 'dungeons.js: lootOk refuses them');
ok(/const AYLEID_LOOT = .*!ARTIFACT\.test/.test(dj), 'dungeons.js: the Ayleid table leaves them out');
ok(/ARTIFACT\.test\(String\(rec\.editorId \|\| ''\)\)\)\) continue;/.test(dj), "dungeons.js: a corpse does not keep one it was armed with");
// dungeons.js pool() itself, as written there, against a stub pool: the ALL_OK draws (no lootOk) must refuse both
{
  const line = (head) => { const i = dj.indexOf(head); if (i < 0) throw new Error(`dungeons.js has no ${head}`); return dj.slice(i, dj.indexOf('\n', i)); };
  const LOOT = { weapons: [{ name: 'IronSword', value: 25 }, { name: 'EbonySword', value: 720 }, { name: 'DaedricDagger', value: 500 }, { name: 'CYRGoldbrand', value: 3000 }, { name: 'DragonBone', value: 500 }] };
  const BANNED_LOOT = /Ebony|Daedric/i;
  const ARTIFACT = re || /$^/;
  const DRAGON_LOOT = /^(?:DragonBone|DragonScales)$/i;   // dragon-materials.json (Nate, 2026-09-30)
  // The material tiers (loottiers.js) are tested in loot-tiers-harness.js; here they pass everything, so only the name filters act
  // (and the ceiling's ingots and arrows, likewise passed: nothing here is one)
  const pool = new Function('LOOT', 'BANNED_LOOT', 'ARTIFACT', 'DRAGON_LOOT', 'GEAR_POOLS', 'TIERS', 'CAP_KIND', `${line('const pool = (name, maxValue, ok) =>')}\nreturn pool;`)(LOOT, BANNED_LOOT, ARTIFACT, DRAGON_LOOT, new Set(), { lootable: () => true, aboveCap: () => null }, {});
  const names = pool('weapons', 0, undefined).map((it) => it.name);
  ok(names.join() === 'IronSword', 'a draw with no lootOk (ALL_OK) hands out no Ebony, Daedric, artifact or dragon bone', names);
}
const pn = JSON.parse(fs.readFileSync(path.join(ROOT, 'patch-notes.json'), 'utf8'));
ok(pn.some((n) => JSON.stringify(n).includes('Artifacts are no longer found as loot')), 'the patch notes say so');
const wj = fs.readFileSync(path.join(ROOT, 'wildlife.js'), 'utf8');
ok(/const pool = \(name(?:, [^)]*)?\) => [\s\S]{0,900}?\(LOOT\[name\] \|\| \[\]\)\.filter\(\(it\) => !ARTIFACT\.test/.test(wj), 'wildlife.js: giant camp chests leave them out');
ok(/readJson\('artifacts\.json'/.test(dj) && /readJson\('artifacts\.json'/.test(wj), 'both read artifacts.json');

console.log(`${pass}/${pass + fail}`);
process.exitCode = fail ? 1 : 0;
