// Scripted test for the Place tab's catalog search (placement.js searchCatalog, parseQuery; Nate's list N9, 3 Oct).
//   node tests/place-search-harness.js   (from server/)
'use strict';
const path = require('path');
const { searchCatalog, parseQuery } = require(path.resolve(__dirname, '..', 'placement.js'));
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const row = (desc, name, plugin, cat, kind = 'object') => ({ desc, name, plugin, cat, kind, hay: `${name} ${desc}`.toLowerCase() });
const rows = [
  row('1:Skyrim.esm', 'Iron Sword', 'Skyrim.esm', 'Weapons'),
  row('2:Skyrim.esm', 'Steel Sword', 'Skyrim.esm', 'Weapons'),
  row('3:Skyrim.esm', 'Sword Rack', 'Skyrim.esm', 'Furniture'),
  row('4:Skyrim.esm', 'Swordsman Statue', 'Skyrim.esm', 'Statics'),
  row('5:Dawnguard.esm', 'Dawnguard War Axe', 'Dawnguard.esm', 'Weapons'),
  row('6:Skyrim.esm', 'Iron Sword of Burning', 'Skyrim.esm', 'Weapons'),
  row('12e46:Skyrim.esm', 'Hunting Bow', 'Skyrim.esm', 'Weapons'),
  row('7:BSHeartland.esm', 'Imperial Sword', 'BSHeartland.esm', 'Weapons'),
  row('8:Skyrim.esm', 'Bandit Chief', 'Skyrim.esm', 'NPCs', 'npc'),
  row('9:Skyrim.esm', 'Bandit', 'Skyrim.esm', 'NPCs', 'npc'),
  row('a:Skyrim.esm', 'Banditry Notice', 'Skyrim.esm', 'Statics'),
];
const names = (r) => r.hits.map((x) => x.name);

check('terms: words, "phrases", -exclusions and mod:', JSON.stringify(parseQuery('Iron "war axe" -burning mod:dawn')) === JSON.stringify({ include: ['iron', 'war axe'], exclude: ['burning'], mods: ['dawn'] }), parseQuery('Iron "war axe" -burning mod:dawn'));
check('a lone dash is a term, not an exclusion of everything', parseQuery('-').include[0] === '-' && !parseQuery('-').exclude.length);
let r = searchCatalog(rows, 'bandit', '', '');
check('the exact name first, then names starting with it, then the rest', JSON.stringify(names(r)) === JSON.stringify(['Bandit', 'Bandit Chief', 'Banditry Notice']), names(r));
r = searchCatalog(rows, 'sword', '', '');
check('names starting with the query, then words starting with it (shorter first), then the rest', names(r).slice(0, 2).join() === 'Sword Rack,Swordsman Statue' && names(r).indexOf('Iron Sword') < names(r).indexOf('Iron Sword of Burning'), names(r));
r = searchCatalog(rows, 'iron sword', '', '');
check('every word must match, in any order', names(r).join() === 'Iron Sword,Iron Sword of Burning', names(r));
r = searchCatalog(rows, 'sword -burning', '', '');
check('-word leaves those out', !names(r).includes('Iron Sword of Burning') && names(r).includes('Iron Sword'), names(r));
r = searchCatalog(rows, '"war axe"', '', '');
check('a quoted phrase must appear as it is', names(r).join() === 'Dawnguard War Axe', names(r));
r = searchCatalog(rows, 'sword mod:heart', '', '');
check('mod: narrows to mods whose file name holds the text', names(r).join() === 'Imperial Sword', names(r));
r = searchCatalog(rows, 'sword', '', 'Skyrim.esm');
check('the mod picker still filters exactly', r.hits.every((x) => x.plugin === 'Skyrim.esm') && r.hits.length === 5, names(r));
r = searchCatalog(rows, 'sword', 'Weapons', '');
check('a query within a category finds only that category', r.hits.every((x) => x.cat === 'Weapons') && r.hits.length === 4, names(r));
check('...and counts every category for the query', JSON.stringify(r.counts) === JSON.stringify({ Weapons: 4, Furniture: 1, Statics: 1 }), r.counts);
r = searchCatalog(rows, '12e46', '', '');
check('an id is found too', names(r).join() === 'Hunting Bow', names(r));
r = searchCatalog(rows, '', 'NPCs', '');
check('no query: the category in catalog order, no counts', names(r).join() === 'Bandit Chief,Bandit' && r.counts === null, names(r));
const big = Array.from({ length: 44000 }, (_, i) => row(`${i.toString(16)}:Skyrim.esm`, `Thing ${i % 997} Banner ${i}`, 'Skyrim.esm', `C${i % 9}`));
let t0 = process.hrtime.bigint();
r = searchCatalog(big, 'banner', '', '');
const first = Number(process.hrtime.bigint() - t0) / 1e6;
t0 = process.hrtime.bigint();
r = searchCatalog(big, 'thing', '', '');
const again = Number(process.hrtime.bigint() - t0) / 1e6;
check('a broad query over 44,000 rows ranks them in well under a second', r.hits.length === 44000 && first < 1000 && again < 1000, [first, again]);
console.log(`(44,000 rows, every one a match: ${first.toFixed(0)} ms the first time, ${again.toFixed(0)} ms after)`);
console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
