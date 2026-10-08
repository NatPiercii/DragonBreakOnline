// ghostItems.ts: after a player apply, the game's count of a stackable item beyond the server's is removed (#bugs
// 1557440268897095842: ghost ingredient stacks that could be neither dropped nor stored). Run it from skymp5-client:
//
//   ./node_modules/typescript/bin/tsc src/sync/ghostItems.ts --outDir /tmp/dbo-ghost --module commonjs --target es2019
//   node tests/ghost-items-harness.js /tmp/dbo-ghost/ghostItems.js
'use strict';
const path = require('path');
const { ghostCandidates, serverTotals, ghostExcess, GHOST_CHECK_FRAMES } = require(path.resolve(process.argv[2] || '/tmp/dbo-ghost/ghostItems.js'));

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const SALT = 0x34cdf, GRAPES = 0x0006ac4a, SWORD = 0x00012eb7, POTION = 0x0003eadd;
const stackable = (id) => id !== SWORD;

// Skald: the server holds 167 salt, the game showed 250 (78 + a ghost stack)
const diff = [{ baseId: SALT, count: -83 }, { baseId: SWORD, count: -1 }, { baseId: GRAPES, count: 2 }, { baseId: SALT, count: -1 }];
const ids = ghostCandidates(diff, stackable);
check('only stackable items the apply meant to remove are checked, each once', JSON.stringify(ids) === JSON.stringify([SALT]), ids);
const totals = serverTotals([{ baseId: SALT, count: 100 }, { baseId: SALT, count: 67 }, { baseId: GRAPES, count: 5 }], ids);
check('the server count sums every entry of the item', totals.get(SALT) === 167 && !totals.has(GRAPES), [...totals]);
check('a game count above the server count is the excess', ghostExcess(167, 250) === 83);
check('nothing is removed when the game holds what the server says', ghostExcess(167, 167) === 0);
check('...or less', ghostExcess(167, 150) === 0);
check('an item the server no longer holds at all goes entirely', ghostExcess(serverTotals([], [POTION]).get(POTION), 3) === 3);
check('a garbage count removes nothing', ghostExcess(NaN, undefined) === 0 && ghostExcess(10, '12.7') === 2);
check('an apply that only adds checks nothing', ghostCandidates([{ baseId: SALT, count: 5 }], stackable).length === 0);
const both = ghostCandidates([{ baseId: SALT, count: -2 }], stackable, [{ baseId: GRAPES, count: 5 }, { baseId: SWORD, count: 1 }, { baseId: SALT, count: 3 }]);
check('the server\'s stackable items are checked too (a ghost the reader misses), gear never', JSON.stringify(both) === JSON.stringify([SALT, GRAPES]), both);
check('the check waits for addItemEx to land (a few frames)', GHOST_CHECK_FRAMES >= 10 && GHOST_CHECK_FRAMES <= 120, GHOST_CHECK_FRAMES);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
