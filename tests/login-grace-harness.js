// A player just logged in cannot be harmed by creatures for loginGrace.seconds after the JOIN (Nate, 5 Oct: wolves
// downed Ancano 12 s after his JOIN, #bugs 1556475185857691649). The player's own attack or cast ends it; players can
// still hit them. Part 1 lifts gamemode.js's grace helpers and runs them on a stub clock; part 2 checks the wiring.
//   node tests/login-grace-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fail++; };
let now = 1790000000000;
Date.now = () => now;

const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const i = src.indexOf('const LOGIN_GRACE = '), j = src.indexOf('\n};\n', src.indexOf('const inLoginGrace = '));
if (i < 0 || j < 0) { console.log('FAIL gamemode.js has no login grace'); process.exit(1); }
const logs = [];
const lift = (cfg) => new Function('globalThis', 'cfg', 'display', 'log',
  `${src.slice(i, j + 3)}\nreturn { start: startLoginGrace, end: endLoginGrace, holds: inLoginGrace, map: loginGrace };`)(
  {}, cfg, String, (...x) => logs.push(x.join(' ')));

const P = 0xff000010;
let g = lift({});
ok(!g.holds(P), 'no grace before a login');
g.start(P);
ok(g.holds(P), 'a fresh login is in grace');
now += 19000;
ok(g.holds(P), '...19 s later still (20 s by default)');
now += 1500;
ok(!g.holds(P) && !g.map.has(P), '...and it ends by itself after 20 s, leaving nothing behind');
g.start(P); g.end(P);
ok(!g.holds(P) && logs.some((l) => /login grace: .* ended it early/.test(l)), 'the player\'s own attack or cast ends it at once, logged');
g = lift({ loginGrace: { seconds: 0 } });
g.start(P);
ok(!g.holds(P), 'seconds 0 turns the grace off');
g = lift({ loginGrace: { seconds: 5 } });
g.start(P); now += 6000;
ok(!g.holds(P), 'a configured length applies (5 s)');

// ---- the wiring ----
const join = src.indexOf('audit(`JOIN ${who(a)}');
ok(join > 0 && /^\s*startLoginGrace\(a\);/.test(src.slice(src.indexOf('\n', join) + 1)), 'the grace starts at the JOIN');
const hook = src.slice(src.indexOf('const hitDamageAttemptHook ='), src.indexOf('hitDamageAttemptHook.__dbo'));
const at = hook.indexOf('inLoginGrace(tgt)');
ok(at > 0 && at < hook.indexOf('// 1. Refuse attack') && at < hook.indexOf('combatAt.set('), 'the hit hook refuses a creature\'s hit before every other rule and the combat stamps');
ok(/if \(profileOf\(agg\) >= 0\) \{ if \(loginGrace\.has\(agg\)\) endLoginGrace\(agg\); \}\s*else if \(profileOf\(tgt\) >= 0 && inLoginGrace\(tgt\)\) return false;/.test(hook), 'only a creature is refused; a player\'s attack ends their own grace');
ok(/if \(verdict !== false && loginGrace\.has\(Number\(casterId\) >>> 0\)\) endLoginGrace\(Number\(casterId\) >>> 0\);/.test(src), 'a cast ends the grace');
ok(/globalThis\.__dboLoginGrace instanceof Map/.test(src), 'the grace survives a hot reload (globalThis)');

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exit(fail ? 1 : 0);
