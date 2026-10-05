// gamemode.js startLoginWait: every character a connected player loads gets its own login run (onCharacterReady), for
// the whole connection. The watch used to end 15 minutes after connecting, so a character picked later through
// character select got no login run: no learned enchantments sent, no restore, no JOIN (Kagrethas Mzulft, 5 Oct).
// Slices the function out of gamemode.js and drives it on a fake clock; with an old gamemode.js as argument it shows
// the old behaviour.
//   node tests/login-wait-harness.js [gamemode.js]   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const file = process.argv[2] || path.resolve(__dirname, '..', 'gamemode.js');
const src = fs.readFileSync(file, 'utf8');
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };
const cutFrom = (from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a); if (a < 0 || b < 0) { console.log(`FAIL marker gone: ${from}`); process.exit(1); } return src.slice(a, b); };
const fn = cutFrom('const startLoginWait = ', 'globalThis.__dboHandlers.connect = ');
const capLine = (src.match(/const LOGIN_WAIT_MS = [^\n]*\n/) || [''])[0];

// A fake clock: setInterval callbacks run as time is advanced
let now = 0; const timers = new Map(); let nextId = 1;
const fakeSetInterval = (f, ms) => { const id = nextId++; timers.set(id, { f, ms, at: now + ms }); return id; };
const fakeClearInterval = (id) => timers.delete(id);
const advance = (ms) => { const end = now + ms; for (;;) { let due = null; for (const [id, t] of timers) if (t.at <= end && (!due || t.at < due[1].at)) due = [id, t]; if (!due) break; now = due[1].at; due[1].at += due[1].ms; due[1].f(); } now = end; };
const RealDate = Date;
const FakeDate = { now: () => now };

const ready = [];
let actor = 0;
const connected = new Set();
const api = new Function('connected', 'actorOf', 'onCharacterReady', 'timed', 'log', 'setInterval', 'clearInterval', 'Date', 'globalThis',
  capLine + fn + '\nreturn { startLoginWait };')(
  connected, () => actor, (u, a) => ready.push([u, a, now]), (name, f) => f, () => {}, fakeSetInterval, fakeClearInterval, FakeDate,
  { __dboLoginWaits: new Map() });

connected.add(7);
api.startLoginWait(7, 0);
advance(60000);
ok(ready.length === 0, 'no login run while the player sits at character select');
actor = 0xff000cc2; advance(1000);
ok(ready.length === 1 && ready[0][1] === 0xff000cc2, 'the first character gets its login run', ready);
advance(47 * 60000);
ok(ready.length === 1, 'no second run while the same character plays on');
actor = 0; advance(5000); actor = 0xff000304; advance(1000);
ok(ready.length === 2 && ready[1][1] === 0xff000304, 'a character switched to 47 minutes after connecting gets its own login run', ready.map((r) => r[1].toString(16)));
advance(3 * 3600000); actor = 0xff000cc2; advance(1000);
ok(ready.length === 3 && ready[2][1] === 0xff000cc2, '...and so does a switch back hours later');
connected.delete(7); advance(1000);
ok(timers.size === 0, 'the watch ends when the player disconnects', timers.size);
ok(!/LOGIN_WAIT_MS/.test(fn), 'the watch has no time limit');

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
