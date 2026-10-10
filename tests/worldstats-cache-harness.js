// worldstats.js reuses an offline character's numbers for 10 minutes: reading every character ever seen each minute cost
// 30-70 ms on the main thread (ticks report, 9 Oct). Online characters and their owners stay fresh.
//   node tests/worldstats-cache-harness.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const WORLDSTATS = path.resolve(__dirname, '..', 'worldstats.js');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'worldstats-cache-')));
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
let online = [0x21, 0x22], now = Date.UTC(2026, 9, 10, 0, 0), tick = null;
const realNow = Date.now; Date.now = () => now;
const reads = new Map();
const props = new Map([[0x21, 30], [0x22, 70]].flatMap(([a, g]) => [[`${a}|appearance`, { name: `P${a}`, raceId: 0x13746 }], [`${a}|inventory`, { entries: [{ baseId: 0xf, count: g }] }]]));
delete globalThis.__dboWorldStats; delete globalThis.__dboWorldStatsWrites;
require(WORLDSTATS)({
  mp: { get: (id, p) => { if (p === 'inventory') reads.set(id, (reads.get(id) || 0) + 1); return props.get(id + '|' + p); }, getAllForms: () => [], getActorsByProfileId: (pid) => [pid] },
  log: () => {}, every: (n, ms, f) => { if (n === 'worldStats') tick = f; }, onlineActors: () => online,
  profileOf: (a) => a, nameOf: (a) => `P${a}`, personal: () => {}, registerChatCommand: () => {},
});
const run = () => { reads.clear(); now += 60000; return tick(); };
let s = run();
check('both online: both read', reads.get(0x21) > 0 && reads.get(0x22) > 0, JSON.stringify([...reads]));
online = [0x21];
s = run();
check('the first minute offline reads it once more (it was online)', reads.get(0x22) > 0, JSON.stringify([...reads]));
s = run();
check('then an offline character is not read again', !reads.get(0x22) && reads.get(0x21) > 0, JSON.stringify([...reads]));
check('...and still counts: two characters, its gold included', s.characters === 2 && s.gold.carried === 100, JSON.stringify(s.gold));
now += 10 * 60000;
s = run();
check('after 10 minutes it is read again', reads.get(0x22) > 0, JSON.stringify([...reads]));
online = [0x21, 0x22];
run(); s = run();
check('back online: read every minute', reads.get(0x22) > 0);
Date.now = realNow;
console.log(''); console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
