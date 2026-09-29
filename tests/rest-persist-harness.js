// Coin purses and wisp stalks rest on the reference as well as in memory (loot review, 2026-09-29): the in-memory rest
// was lost at every restart, so every push to fork main refilled them all. Lifts restUntil/setRest from gamemode.js.
//   node tests/rest-persist-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const gm = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const line = (start) => { const i = gm.indexOf(start); if (i < 0) throw new Error(`not found: ${start}`); return gm.slice(i, gm.indexOf('\n', i)); };
let pass = 0, fail = 0;
const ok = (c, what, got) => { if (c) pass++; else { fail++; console.log('FAIL', what, got === undefined ? '' : JSON.stringify(got)); } };

const props = new Map();
const mp = { get: (id, k) => props.get(`${id}|${k}`), set: (id, k, v) => props.set(`${id}|${k}`, v) };
const { restUntil, setRest } = new Function('mp', 'log', `${line("const REST_PROP = ")}\n${line('const restUntil = ')}\n${line('const setRest = ')}\nreturn { restUntil, setRest };`)(mp, () => {});
const PURSE = 0x10a0f, until = Date.now() + 45 * 60000;
let mem = new Map();
setRest(mem, PURSE, until);
ok(restUntil(mem, PURSE) === until, 'a rest is read back');
ok(props.get(`${PURSE}|private.dboRestUntil`) === until, '...and kept on the reference');
mem = new Map(); // a restart
ok(restUntil(mem, PURSE) === until, 'after a restart the purse still rests');
const throwing = { get: () => { throw new Error('not loaded'); }, set: () => { throw new Error('not loaded'); } };
const lifted = new Function('mp', 'log', `${line("const REST_PROP = ")}\n${line('const restUntil = ')}\n${line('const setRest = ')}\nreturn { restUntil, setRest };`)(throwing, () => {});
const m2 = new Map(); lifted.setRest(m2, PURSE, until);
ok(lifted.restUntil(m2, PURSE) === until, 'a reference that cannot be read or written still rests in memory');

ok(/const until = restUntil\(purseRest, targetId\);/.test(gm) && /setRest\(purseRest, targetId, /.test(gm), 'coin purses use it');
ok(/const until = restUntil\(wispRest, targetId\);/.test(gm) && /setRest\(wispRest, targetId, /.test(gm), 'wisp stalks use it');

console.log(`${pass}/${pass + fail}`);
process.exitCode = fail ? 1 : 0;
