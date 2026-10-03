// salvage.json as tooling/make_salvage.py builds it (#bugs 3 Oct "not all weapons are breakdownable"): a recipe with any
// metal goes to the smelter at that metal's tier (steel and elven at Novice, Nate 3 Oct), equal counts going to the harder metal; an item with no recipe and no
// template takes the cheapest recipe of an item of its type, shape and material keyword (Beyond Skyrim's Elven copies,
// Sentinel's Northern Iron). Reads the committed salvage.json, so a regenerated file is checked as it ships.
//   node tests/salvage-coverage-harness.js   (from server/)
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
ok(glass.length && glass.every(([, v]) => v[1] >= 2), 'glass stays gated (Journeyman)', glass.slice(0, 2));
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
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
