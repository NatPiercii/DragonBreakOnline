// The rare-loot rule in dungeons.js (Nat, 2026-09-28: Daedra hearts extremely extremely rare). The pick helper is cut out
// of dungeons.js (from the RARE_LOOT comment to the end of pickFrom) and sampled. Run from this folder's parent:
//   node tests/rare-loot-harness.js
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'dungeons.js'), 'utf8');
const a = src.indexOf('  // Nat, 2026-09-28: a Daedra heart must be extremely extremely rare.');
const b = src.indexOf('    return null;\n  };', a);
if (a < 0 || b < 0) { console.log('FAIL the rare-loot markers are gone from dungeons.js'); process.exit(1); }
const section = src.slice(a, b + '    return null;\n  };'.length);
const make = (C) => new Function('C', section + '\nreturn pickFrom;')(C);
let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };

// 235 ingredients, one of them the heart, as in loot.json
const pool = Array.from({ length: 234 }, (_, i) => ({ id: `${i}:x`, name: `Ingredient${i}` })).concat([{ id: '3ad5b:Skyrim.esm', name: 'DaedraHeart' }]);
const pick = make({});
const N = 2000000;
let hearts = 0, nulls = 0;
for (let i = 0; i < N; i++) { const it = pick(pool); if (!it) nulls++; else if (it.name === 'DaedraHeart') hearts++; }
const per = N / Math.max(1, hearts);
check('a Daedra heart is about one ingredient roll in 23,500', per > 15000 && per < 40000, `${hearts} in ${N} (one in ${Math.round(per)})`);
check('a roll still gives an ingredient', nulls === 0, `${nulls} empty`);
check('other ingredients are as common as before', (() => { let c = 0; for (let i = 0; i < 235000; i++) if (pick(pool).name === 'Ingredient7') c++; return c > 800 && c < 1200; })());
check('strings and an empty pool still work', make({})(['a', 'b']) !== null && make({})([]) === null);
check('config overrides the rate', (() => { const p2 = make({ rareLoot: { DaedraHeart: 1 } }); let c = 0; for (let i = 0; i < 23500; i++) if (p2(pool).name === 'DaedraHeart') c++; return c > 50; })());
console.log(failures ? `${failures} failure(s)` : 'all checks passed');
process.exit(failures ? 1 : 0);
