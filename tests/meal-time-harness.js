// Scripted test for meals that take time (gamemode.js onEat, creditMeal and the meals block; Nate, 2026-09-27). The code
// is cut out of the gamemode (from "const onEat = " to the eat event chain, and from "// ---- meals:" to the mealCancel
// handler) and run against stubs: food starts a meal and counts only when it finishes; a cancel, death or logout counts
// nothing; more food makes the meal longer; needs.mealTime false counts at once; a hot reload keeps a meal. Run it from
// this folder's parent with
//
//   node tests/meal-time-harness.js
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'gamemode.js'), 'utf8');
const cut = (from, to, keepTo) => {
  const a = src.indexOf(from); const b = src.indexOf(to, a);
  if (a < 0 || b < 0) { console.log(`FAIL the section markers are gone from gamemode.js: ${from}`); process.exit(1); }
  return src.slice(a, keepTo ? src.indexOf('\n', b) + 1 : b);
};
const eatSection = cut('const onEat = ', '// Chain onto the server\'s eat event');
const mealSection = cut('// ---- meals: eating takes time', 'onUi(\'mealCancel\'', true);

let now = 1790000000000;
Date.now = () => now;

const MEAT = 0x100, BREAD = 0x101, MEAD = 0x102, POTION = 0x103;
const kinds = { [MEAT]: 'meal', [BREAD]: 'snack', [MEAD]: 'drink', [POTION]: '' };
const P = 0x14;
let online = true, dead = false;
const hunger = new Map();
const sent = [], said = [], logs = [];
let tick = null; const ui = new Map();
const stubs = (NEEDS) => ({
  NEEDS,
  foodKindOf: (id) => kinds[id] || '',
  needsOf: (a) => ({ hunger: hunger.get(a) ?? 80 }),
  applyNeedsStage: () => {},
  saveNeeds: (a, n) => hunger.set(a, n.hunger),
  recordOf: () => null,
  display: (a) => `P${a.toString(16)}`,
  log: (...m) => logs.push(m.join(' ')),
  sendPacket: (to, packet) => { sent.push({ to, ...packet }); return true; },
  personal: (to, text) => said.push({ to, text }),
  userOf: () => (online ? 1 : -1),
  mp: { get: (a, p) => (p === 'isDead' ? dead : undefined) },
  every: (name, ms, fn) => { tick = fn; },
  onUi: (event, fn) => ui.set(event, fn),
});
const RESTORE = { meal: 35, snack: 15, drink: 8, ingredient: 4 };
let onEat;
const load = (extra) => {
  const s = stubs(Object.assign({ enabled: true, restore: RESTORE }, extra || {}));
  // the two sections share scope in the gamemode; onEat is handed back out
  onEat = new Function(...Object.keys(s), `${eatSection}\n${mealSection}\nreturn onEat;`)(...Object.values(s));
};
const reset = () => {
  hunger.clear(); sent.length = 0; said.length = 0; logs.length = 0; online = true; dead = false;
  if (globalThis.__dboMeals) globalThis.__dboMeals.clear();
  now += 60000;
};
const packets = (type) => sent.filter((p) => p.customPacketType === type);
const run = (ms) => { for (let t = 0; t < ms; t += 250) { now += 250; tick(); } };

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };

load();

// A meal counts when it finishes
reset(); hunger.set(P, 80);
onEat(P, MEAT);
check('eating starts a meal and counts nothing yet', hunger.get(P) === 80 && packets('dboMeal')[0]?.state === 'start' && packets('dboMeal')[0].seconds === 5.5, JSON.stringify(sent));
check('the banner tells how long', /Eating: 6 s/.test(packets('dboBanner')[0]?.text || ''), packets('dboBanner')[0]?.text);
run(5000);
check('before 5.5 s the hunger is unchanged', hunger.get(P) === 80);
run(750);
check('at 5.5 s the meal counts (80 - 35)', hunger.get(P) === 45, hunger.get(P));
check('the client is told it is done', packets('dboMeal').at(-1)?.state === 'done');
check('the log names the food', logs.some((l) => /ate 100 \(meal\): hunger 80 -> 45/.test(l)), logs.join(' | '));

// A cancel counts nothing
reset(); hunger.set(P, 80);
onEat(P, BREAD);
run(2000);
ui.get('mealCancel')(P, ['sprint']);
run(8000);
check('a cancelled meal counts nothing', hunger.get(P) === 80, hunger.get(P));
check('the client is told it was cancelled', packets('dboMeal').at(-1)?.state === 'cancelled');
check('the player is told the rest is wasted', said.some((s) => /stop eating, and the rest goes to waste/.test(s.text)), JSON.stringify(said));
check('the cancel reason is logged', logs.some((l) => /stopped a meal \(sprint\)/.test(l)), logs.join(' | '));
const before = sent.length;
ui.get('mealCancel')(P, ['attack']);
check('a cancel with no meal does nothing', sent.length === before && said.length === 1);

// More food makes the meal longer, and all of it counts at the end
reset(); hunger.set(P, 90);
onEat(P, BREAD);
run(1000);
onEat(P, MEAD);
check('a second item extends the meal (4.5 s left + 7 s)', Math.abs(packets('dboMeal').at(-1).seconds - 11.5) < 0.01, packets('dboMeal').at(-1).seconds);
run(11000);
check('nothing counts before the longer meal ends', hunger.get(P) === 90);
run(750);
check('both items count at the end (90 - 15 - 8)', hunger.get(P) === 67, hunger.get(P));

// Drink only: its own words
reset();
onEat(P, MEAD);
check('a drink says Drinking', /Drinking: 7 s/.test(packets('dboBanner')[0]?.text || '') && packets('dboMeal')[0].drink === true);
ui.get('mealCancel')(P, ['weapon']);
check('a cancelled drink says drinking', said.some((s) => /stop drinking/.test(s.text)));

// Death and logout count nothing
reset(); hunger.set(P, 80);
onEat(P, MEAT); run(1000); dead = true; run(250);
check('dying ends the meal with nothing counted', hunger.get(P) === 80 && packets('dboMeal').at(-1)?.state === 'cancelled' && logs.some((l) => /\(died\)/.test(l)));
reset(); hunger.set(P, 80);
onEat(P, MEAT); run(1000); online = false; run(6000); online = true; run(1000);
check('logging out ends the meal with nothing counted', hunger.get(P) === 80 && !globalThis.__dboMeals.has(P));

// Potions and other non-food start nothing
reset();
onEat(P, POTION);
check('a potion starts no meal', sent.length === 0 && !globalThis.__dboMeals.has(P));

// A cancel reason from the client is cleaned
reset(); onEat(P, MEAT); logs.length = 0;
ui.get('mealCancel')(P, ['<b>x</b>; drop table']);
check('the cancel reason is letters only', logs.some((l) => /stopped a meal \(bxbdroptable\)/.test(l)), logs.join(' | '));

// A hot reload keeps a meal in progress
reset(); hunger.set(P, 80);
onEat(P, MEAT); run(2000);
load();
run(3750);
check('a meal survives a reload and counts at the end', hunger.get(P) === 45, hunger.get(P));

// needs.mealTime false: food counts at once
reset(); load({ mealTime: false }); hunger.set(P, 80);
onEat(P, MEAT);
check('mealTime false counts at once', hunger.get(P) === 45 && packets('dboMeal').length === 0);
load();

console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
