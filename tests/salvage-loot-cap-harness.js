// Breaking gear down never hands out a metal above the loot cap (salvage.js capped(): the gear swap's own "metals" list in
// gear-swap.json, so the two cannot drift). Every entry of the real salvage.json is broken down at Master, at its station,
// and nothing that comes back may be on that list; an Elven piece gives steel. Skips on a line without gear-swap.json.
//   node tests/salvage-loot-cap-harness.js   (from server/; GEAR_SWAP=<file> to use another copy)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
const SWAP = process.env.GEAR_SWAP || path.join(SERVER, 'gear-swap.json');
if (!fs.existsSync(SWAP)) { require('./expect')('salvage-loot-cap', 'this line has no gear-swap.json'); console.log('skipped: no gear-swap.json'); process.exit(0); }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-salvagecap-'));
for (const f of ['salvage.json', 'dragon-materials.json']) if (fs.existsSync(path.join(SERVER, f))) fs.copyFileSync(path.join(SERVER, f), path.join(scratch, f));
fs.copyFileSync(SWAP, path.join(scratch, 'gear-swap.json'));
const home = process.cwd();
process.chdir(scratch);
const norm = (d) => { const [h, p] = String(d).split(':'); return `${parseInt(h, 16).toString(16)}:${String(p).toLowerCase()}`; };
const S = JSON.parse(fs.readFileSync('salvage.json', 'utf8'));
const metals = JSON.parse(fs.readFileSync('gear-swap.json', 'utf8')).metals || {};
// ...and the metals players mine, never swapped but no more given by salvage than by loot (loottiers.js LOOT_ONLY_METALS)
const LOOT_ONLY = (() => { try { return require(path.join(SERVER, 'loottiers.js')).LOOT_ONLY_METALS || {}; } catch (e) { return {}; } })();
const above = new Set(Object.keys(metals).concat(Object.keys(LOOT_ONLY)).map(norm));
// A stand-in id for every desc the table names
const ids = new Map(), descs = new Map();
const idOf = (d) => { const k = norm(d); if (!ids.has(k)) { const id = 0x10000 + ids.size; ids.set(k, id); descs.set(id, d); } return ids.get(k); };
for (const [d, v] of Object.entries(S.items)) { idOf(d); for (const [m] of v[2]) idOf(m); }
for (const [d, v] of Object.entries(Object.assign({}, LOOT_ONLY, metals))) { idOf(d); idOf(v.to); }
const logs = [];
const mod = require(path.join(SERVER, 'salvage.js'))({
  mp: { get: () => null, set: () => {}, getDescFromId: (id) => descs.get(id) || '', getIdFromDesc: (d) => idOf(d) },
  log: (...x) => logs.push(x.join(' ')), personal: () => {}, who: String, cfg: {}, openWidget: () => {}, closeWidget: () => {}, onUi: () => {},
  masteryOf: () => null, recordOf: () => null, fieldsOf: () => [], giveItem: () => true, itemName: () => '', distanceMeters: () => 1,
});
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 400) : ''}`); if (!c) fails++; };
const station = (id) => ({ id });
let checked = 0;
const leaks = [];
for (const [d, v] of Object.entries(S.items)) {
  const out = mod.yieldOf(idOf(d), station(v[0]), 4);
  if (!out) continue;
  checked++;
  for (const [m] of out) if (above.has(norm(m))) leaks.push([d, m]);
}
ok(checked > 8000, 'every entry of salvage.json was broken down', checked);
ok(!leaks.length, 'nothing that comes back is above the loot cap', leaks.slice(0, 5));
const elven = mod.yieldOf(idOf('1399c:Skyrim.esm'), station('smelter'), 0);
ok(elven && elven.length && elven.every(([m]) => !above.has(norm(m))) && elven.some(([m]) => norm(m) === '5ace5:skyrim.esm'), 'an Elven Battleaxe at Novice gives steel, no moonstone', elven);
const counts = (out) => out.reduce((n, [, c]) => n + c, 0);
ok(new Set(elven.map(([m]) => norm(m))).size === elven.length, '...one line per metal, merged', elven);
const raw = S.items['1399c:Skyrim.esm'][2];
ok(counts(elven) <= Math.max(1, raw.reduce((n, [, c]) => n + Math.floor(c * 0.25), 0)) + 1, '...and no more than its materials gave before the cap', [elven, raw]);
ok(!logs.some((l) => /gear-swap\.json unreadable/.test(l)), 'gear-swap.json was read');
ok(Object.keys(LOOT_ONLY).length >= 12 && !Object.keys(LOOT_ONLY).some((k) => metals[k]), `the ${Object.keys(LOOT_ONLY).length} mined metals are off the swap's list and still capped here`);
process.chdir(home);
fs.rmSync(scratch, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
