// Mithril drops at tier 4, where it is forged, and Adamantium is never loot (Nate, 10 Oct: smithing tiers 4 and 5; the
// adamantium ingot is never loot either).
//   node tests/loot-tiers-metals-harness.js
'use strict';
const path = require('path');
const LT = require(path.resolve(__dirname, '..', 'loottiers.js'));
let failures = 0;
const check = (l, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const m = LT({ materials: { items: { 'a1:x.esp': 'mithril', 'a2:x.esp': 'adamantium', 'a3:x.esp': 'brass', 'a4:x.esp': 'glass' } }, factionGear: {}, overrides: {}, cfg: { cap: 'none' }, swap: {} });
const c = (d) => m.classOf(d);
check('mithril gear is tier 4, as glass', c('a1:x.esp').tier === 4 && c('a1:x.esp').tier === c('a4:x.esp').tier, c('a1:x.esp'));
check('adamantium gear is never loot', c('a2:x.esp').kind === 'never', c('a2:x.esp'));
check('brass stays tier 2', c('a3:x.esp').tier === 2, c('a3:x.esp'));
console.log(''); console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
