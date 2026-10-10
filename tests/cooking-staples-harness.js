// Butter, flour and milk come out of Cyrodiil loot too (Worker F's cooking census, 30 Sep: loot.json gave them only to
// Skyrim and Solstheim, so 17 Cook recipes could not be made inside the Bruma lock; they are made and sold all over
// Tamriel). Checks loot.json, regions-overrides.json, and dungeons.js's own province test (lifted from the file).
//   node tests/cooking-staples-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const SERVER = path.resolve(__dirname, '..');
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };
const STAPLES = ['BYOHFoodButter', 'BYOHFoodFlour', 'BYOHFoodMilk'];

const loot = JSON.parse(fs.readFileSync(path.join(SERVER, 'loot.json'), 'utf8'));
const entries = [];
for (const [pool, list] of Object.entries(loot.pools || {})) for (const it of Array.isArray(list) ? list : []) if (it && STAPLES.includes(it.name)) entries.push({ pool, it });
ok(STAPLES.every((n) => entries.some((e) => e.it.name === n)), 'all three staples are in the loot pools', entries.map((e) => e.it.name));

// dungeons.js: "An item with no p is Tamriel-wide"
const src = fs.readFileSync(path.join(SERVER, 'dungeons.js'), 'utf8');
const line = src.split('\n').find((l) => /const hasProv = /.test(l));
ok(!!line, "dungeons.js still has its province test (hasProv)");
const hasProv = new Function(`${line}\nreturn hasProv;`)();
for (const n of STAPLES) {
  const e = entries.filter((x) => x.it.name === n);
  ok(e.length && e.every((x) => hasProv(x.it, 'cyrodiil')), `${n} can drop in a Cyrodiil dungeon`, e.map((x) => x.it.p));
  ok(e.length && e.every((x) => hasProv(x.it, 'skyrim') && hasProv(x.it, 'solstheim')), `${n} still drops in Skyrim and Solstheim`);
  ok(e.every((x) => !('p' in x.it)), `${n} carries no province list (Tamriel-wide, as loot.py writes it)`, e.map((x) => x.it.p));
}

// regions-overrides.json: the source of truth, applied at runtime by regions.js and by the next loot.py run
const ovr = JSON.parse(fs.readFileSync(path.join(SERVER, 'regions-overrides.json'), 'utf8'));
for (const n of STAPLES) ok(ovr.items && ovr.items[n] === 'common', `regions-overrides.json makes ${n} common`, ovr.items && ovr.items[n]);

// nothing else in loot.json moved (against the release line this branch starts from, when git has it)
try {
  const base = JSON.parse(execFileSync('git', ['-C', SERVER, 'show', 'origin/release-1003-gameplay:loot.json'], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }));
  // Plain Jade joined the gems pool on purpose (smithing obtainability, 9 Oct: nothing else produces it)
  const LATER = new Set(['BSKGemJade']);
  const strip = (l) => JSON.stringify(Object.fromEntries(Object.entries(l.pools || {}).map(([k, v]) => [k, (v || []).filter((it) => !(it && LATER.has(it.name))).map((it) => (it && STAPLES.includes(it.name) ? { ...it, p: undefined } : it))])));
  ok(strip(base) === strip(loot), 'no other loot.json entry changed (plain Jade, added to the gems on purpose, aside)');
} catch (e) { console.log('skip  no origin/release-1003-gameplay to compare with'); }

console.log(fails ? `${fails} FAILED` : 'all checks passed');
process.exit(fails ? 1 : 0);
