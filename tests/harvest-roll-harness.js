// masterySystem.rollHarvest (combat and economy review, 2026-09-29, H2): a plant already picked pays no extra, and a
// failed roll rests that plant for that player, so pressing E again does not re-roll.
//
//   node tests/harvest-roll-harness.js <bundled masterySystem.js>
//   (bundle with: cd fork/skymp5-server && ./node_modules/.bin/esbuild ts/systems/masterySystem.ts \
//      --bundle --platform=node --format=cjs --outfile=<out>)
'use strict';
const path = require('path');
const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests/harvest-roll-harness.js <bundled masterySystem.js>'); process.exit(2); }
const { MasterySystem } = require(path.resolve(bundle));

let fails = 0, checks = 0;
const ok = (label, cond, got) => { checks++; if (!cond) { fails++; console.log(`  FAIL ${label}${got !== undefined ? `: got ${JSON.stringify(got)}` : ''}`); } };

const SKILLED = 0xff000014, UNSKILLED = 0xff000015, PLANT = 0x10b0a7, OTHER_PLANT = 0x10b0a8, INGR = 0x77e1c;
const props = new Map();
let harvestedThrows = false;
const mp = {
  get: (id, key) => {
    if (key === 'isHarvested') { if (harvestedThrows) throw new Error("unknown property 'isHarvested'"); return props.get(`${id}:isHarvested`) === true; }
    return props.get(`${id}:${key}`);
  },
  set: (id, key, value) => props.set(`${id}:${key}`, value),
};
const ctx = { svr: mp };
const sys = new MasterySystem(() => { });
sys.notice = () => { };
sys.lookup = () => ({});
sys.fieldFormIds = () => [INGR];
const base = { id: 0x4b0ba, type: 'FLOR', editorId: 'MountainFlower01Red' };
const master = { skills: { harvesting: { rank: 4 } }, order: ['harvesting'] };
const none = { skills: {}, order: [] };
const held = (a) => ((mp.get(a, 'inventory') || { entries: [] }).entries.find((e) => e.baseId === INGR) || { count: 0 }).count;
const roll = (a, rec, plant, r) => { const real = Math.random; Math.random = () => r; try { return sys.rollHarvest(ctx, a, 1, rec, base, plant); } finally { Math.random = real; } };

// A Master's pick: the engine's one plus one extra
ok('a Master picks a fresh plant', roll(SKILLED, master, PLANT, 0) === true);
ok('...and gets the extra one', held(SKILLED) === 1, held(SKILLED));
props.set(`${PLANT}:isHarvested`, true);   // the engine has picked it
ok('pressing E on the picked plant is let through to the engine (which gives nothing)', roll(SKILLED, master, PLANT, 0) === true);
ok('...and pays no extra', held(SKILLED) === 1, held(SKILLED));
for (let i = 0; i < 5; i++) roll(SKILLED, master, PLANT, 0);
ok('...however often it is pressed', held(SKILLED) === 1, held(SKILLED));

// An unskilled player's failed roll rests the plant for them
ok('an unskilled roll can fail', roll(UNSKILLED, none, OTHER_PLANT, 0.99) === false);
ok('...and pressing E again does not re-roll it', roll(UNSKILLED, none, OTHER_PLANT, 0) === false);
ok('another player may still try that plant', roll(SKILLED, master, OTHER_PLANT, 0) === true);
const realNow = Date.now; Date.now = () => realNow() + 61 * 60000;
ok('an hour on, the unskilled player may try again', roll(UNSKILLED, none, 0x10b0a9, 0) === true && roll(UNSKILLED, none, OTHER_PLANT, 0) === true);
Date.now = realNow;

// An older server without the isHarvested binding reads every plant as unpicked, as before
harvestedThrows = true;
ok('without isHarvested the roll goes on as before', roll(SKILLED, master, 0x10b0aa, 0) === true);
harvestedThrows = false;

console.log(fails ? `${fails}/${checks} FAILED` : `all ${checks} checks passed`);
process.exit(fails ? 1 : 0);
