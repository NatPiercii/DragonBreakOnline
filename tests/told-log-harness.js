// personal() samples refusal-shaped lines into the log (refusal survey, 2026-09-29): per player and text, the 1st,
// 5th and every 10th, counted again after 10 quiet minutes; other lines are not logged. Lifted from gamemode.js.
//   node tests/told-log-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const gm = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const i = gm.indexOf('const REFUSAL_TEXT = '), j = gm.indexOf('const personal = (actorId, text) =>');
if (i < 0 || j < i) { console.log('FAIL the sampled refusal log is gone from gamemode.js'); process.exit(1); }
let pass = 0, fail = 0;
const ok = (c, what, got) => { if (c) pass++; else { fail++; console.log('FAIL', what, got === undefined ? '' : JSON.stringify(got)); } };
const logged = [];
let clock = 1e12;
const realNow = Date.now; Date.now = () => clock;
delete globalThis.__dboToldCounts;
const noteTold = new Function('log', 'display', `${gm.slice(i, j)}\nreturn noteTold;`)((...a) => logged.push(a.join(' ')), (a) => `P${a.toString(16)}`);

noteTold(0x14, 'Get closer to them first.');
ok(logged.length === 1 && /told P14 \(x1\): Get closer/.test(logged[0]), 'the first refusal is logged', logged);
for (let k = 2; k <= 10; k++) noteTold(0x14, 'Get closer to them first.');
ok(logged.length === 3 && /\(x5\)/.test(logged[1]) && /\(x10\)/.test(logged[2]), '...then the 5th and the 10th', logged);
noteTold(0x14, 'This seam is worked out for now. Come back in 12 minutes.');
noteTold(0x14, 'This seam is worked out for now. Come back in 11 minutes.');
ok(logged.length === 4, 'the same text with other numbers counts as one', logged.length);
noteTold(0x15, 'Get closer to them first.');
ok(logged.length === 5, 'each player has their own count');
noteTold(0x14, 'You pocket 12 gold from the purse.');
ok(logged.length === 5, 'a line that is not a refusal is not logged');
clock += 11 * 60000;
noteTold(0x14, 'Get closer to them first.');
ok(logged.length === 6 && /\(x1\)/.test(logged[5]), 'after 10 quiet minutes it counts from 1 again', logged[5]);
ok(/const personal = \(actorId, text\) => \{ try \{ noteTold\(actorId, text\); \}/.test(gm), 'personal() calls it before delivering');

Date.now = realNow;
console.log(`${pass}/${pass + fail}`);
process.exitCode = fail ? 1 : 0;
