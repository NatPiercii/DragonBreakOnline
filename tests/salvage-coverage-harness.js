// salvage.json as tooling/make_salvage.py builds it (#bugs 3 Oct "not all weapons are breakdownable"): a recipe with any
// metal goes to the smelter at that metal's tier (steel and elven at Novice, Nate 3 Oct), equal counts going to the harder metal; an item with no recipe and no
// template takes the cheapest recipe of an item of its type, shape and material keyword (Beyond Skyrim's Elven copies,
// Sentinel's Northern Iron). Reads the committed salvage.json, so a regenerated file is checked as it ships.
//   node tests/salvage-coverage-harness.js [--plugins /opt/skyrim-data]   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const S = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'salvage.json'), 'utf8'));
const items = S.items, names = S.materialEditorIds;
const gen = fs.readFileSync(path.resolve(__dirname, '..', 'tooling', 'make_salvage.py'), 'utf8');
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };
const at = (d) => items[d] || null;
const mats = (d) => (at(d) ? at(d)[2].map(([m, n]) => [names[m] || m, n]) : []);

ok(at('13986:Skyrim.esm') && at('13986:Skyrim.esm')[0] === 'smelter' && at('13986:Skyrim.esm')[1] === 0, 'Steel Dagger: smelter, Novice (Nate, 3 Oct: steel and elven at Novice)', at('13986:Skyrim.esm'));
ok(at('13954:Skyrim.esm') && at('13954:Skyrim.esm')[0] === 'smelter' && mats('13954:Skyrim.esm')[0][0] === 'IngotSteel', 'Steel Helmet: the smelter, steel first (it went to the tanning rack for its strips)', at('13954:Skyrim.esm'));
ok(at('1399f:Skyrim.esm') && at('1399f:Skyrim.esm')[0] === 'smelter' && at('1399f:Skyrim.esm')[1] === 0, 'Elven Greatsword: the smelter, Novice', at('1399f:Skyrim.esm'));
ok(at('1399c:Skyrim.esm') && at('30006b:BSHeartland.esm') && at('1399c:Skyrim.esm')[1] === 0 && at('30006b:BSHeartland.esm')[1] === 0, 'both Elven Battleaxes (Skyrim and Beyond Skyrim) break down alike at Novice', [at('1399c:Skyrim.esm'), at('30006b:BSHeartland.esm')]);
const glass = Object.entries(items).filter(([, v]) => v[0] === 'smelter' && (names[v[2][0][0]] || '') === 'IngotMalachite');
ok(glass.length && glass.every(([, v]) => v[1] >= 2), 'glass stays gated (Adept)', glass.slice(0, 2));
ok(at('300071:BSHeartland.esm') && at('300071:BSHeartland.esm')[0] === 'smelter' && at('300071:BSHeartland.esm')[1] === 0 && mats('300071:BSHeartland.esm')[0][0] === 'IngotIMoonstone', 'Beyond Skyrim Elven War Axe: covered, moonstone first', at('300071:BSHeartland.esm'));
ok(at('30006b:BSHeartland.esm') && at('300078:BSHeartland.esm'), 'Beyond Skyrim Elven Battleaxe and Glass Sword: covered');
const sentinel = Object.keys(items).filter((d) => /:Sentinel\.esp$/.test(d));
ok(sentinel.length >= 200, 'Sentinel (Northern Iron and the rest) is covered', sentinel.length);
const metalAtRack = Object.entries(items).filter(([, v]) => v[0] !== 'smelter' && v[2].some(([m]) => /Ingot|^Ore|DwarvenScrap|ChitinPlate|Stalhrim/i.test(names[m] || '')));
ok(!metalAtRack.length, 'no recipe with a metal goes anywhere but the smelter', metalAtRack.slice(0, 3));
const leatherOnly = Object.entries(items).filter(([, v]) => v[0] === 'smelter' && v[2].every(([m]) => /Leather|Strips|Hide|Pelt/i.test(names[m] || '')));
ok(!leatherOnly.length, 'leather-only gear still goes to the tanning rack', leatherOnly.slice(0, 3));
ok(Object.keys(items).length > 8000, 'coverage did not shrink', Object.keys(items).length);
ok(/def main_of\(mats, item=None\)/.test(gen) && /standin\.get\(\(e\['t'\], material\(e\)\.lower\(\), e\['shape'\]\)\)/.test(gen), 'the generator carries both rules');

// The recipes deployed after 3 Oct (88 faction armour recipes 5 Oct, 195 loom and 2 forge recipes 7 Oct) are in salvage.json
const thread = (d) => at(d) && at(d)[0] === 'loom' && mats(d).length === 1 && mats(d)[0][0] === 'MCE_Thread';
ok(thread('d3dea:Skyrim.esm'), 'College robes (a 7 Oct loom recipe): the loom, thread', at('d3dea:Skyrim.esm'));
ok(thread('80f95:BSHeartland.esm'), 'fur clothes now made of thread at the loom (Colovian Fur Clothes) go back to the loom, not to the rack for leather', at('80f95:BSHeartland.esm'));
// Clothing (BOD2 armour type 2) is its own stand-in pool: hide armour with no recipe never takes a fur clothes' thread one
const hideArmour = ['801', '802', '803', '808', '80d', '80e', '812', '904', '905', '906'].map((x) => `${x}:Sentinel.esp`).concat('e63d2:Journey to Baan Malur.esp');
const rack = hideArmour.filter((d) => at(d) && at(d)[0] === 'tanning' && mats(d).every(([m]) => /Leather/.test(m)));
ok(rack.length === hideArmour.length, "hide armour with no recipe (Sentinel's fur cuirasses, the Slaver's Cuirass): the tanning rack, leather and strips", hideArmour.filter((d) => !rack.includes(d)).map((d) => [d, at(d)]));
ok(/len\(shape\) >= 8 and struct\.unpack_from\('<I', shape, 4\)\[0\] == 2/.test(gen), 'the generator keeps clothing apart in the stand-in pool');
// The 7 Oct forge recipes: Seadog Earrings (gold) and the Windhelm restored circlet (glass, Adept)
const forge = [['2859:Hothtrooper44_ArmorCompilation.esp', 'IngotGold', 1], ['1715f0:WindhelmSSE.esp', 'IngotMalachite', 2]];
ok(forge.every(([d, m, t]) => at(d) && at(d)[0] === 'smelter' && at(d)[1] === t && mats(d)[0][0] === m), 'the 7 Oct forge recipes (Seadog Earrings, the restored Windhelm circlet) break down at the smelter', forge.map(([d]) => at(d)));
const hide = at('23181:Hothtrooper44_ArmorCompilation.esp');
ok(hide && mats('23181:Hothtrooper44_ArmorCompilation.esp').every(([m, n]) => n <= 1), 'gear with a new cheaper recipe gives back no more than that recipe takes', hide);

// With --plugins <data dir>: the generator run on those plugins must give exactly this salvage.json (stale after a plugin deploy)
const pi = process.argv.indexOf('--plugins');
if (pi > 0 && process.argv[pi + 1]) {
  const dir = process.argv[pi + 1];
  const tmp = path.join(require('os').tmpdir(), `salvage-check-${process.pid}.json`);
  require('child_process').execFileSync('python3', [path.resolve(__dirname, '..', 'tooling', 'make_salvage.py'), tmp, dir, path.join(dir, 'loadorder.txt')], { stdio: 'ignore' });
  const fresh = JSON.parse(fs.readFileSync(tmp, 'utf8')).items;
  fs.unlinkSync(tmp);
  const differ = Object.keys(Object.assign({}, items, fresh)).filter((d) => JSON.stringify(items[d]) !== JSON.stringify(fresh[d]));
  ok(!differ.length, `salvage.json matches the plugins in ${dir} (${differ.length} entries differ)`, differ.slice(0, 5));
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
