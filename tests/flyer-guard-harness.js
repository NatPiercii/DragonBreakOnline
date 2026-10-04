// Scripted test for fork skymp5-client/src/view/flyerGuard.ts: the switches a staff test sets on a dragon (ff_flyerGuard)
// and the flyer lines' budget (4 Oct 2026: dragons near players crashed their games, 0xC0000409, no crash log).
// Bundle it first, then run from this folder's parent:
//
//   ../fork/skymp5-server/node_modules/.bin/esbuild ../fork/skymp5-client/src/view/flyerGuard.ts --bundle --platform=node --format=cjs --outfile=<out>
//   node tests/flyer-guard-harness.js <out>
'use strict';
const fs = require('fs');
const path = require('path');
const G = require(path.resolve(process.argv[2]));
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

// ---- the switches ----
check('no property, no switch', G.flyerGuardOf({}) === 0 && G.flyerGuardOf(null) === 0 && G.flyerGuardOf({ ff_flyerGuard: 'x' }) === 0 && G.flyerGuardOf({ ff_flyerGuard: -3 }) === 0);
check('the four bits are kept and nothing else', G.flyerGuardOf({ ff_flyerGuard: 3 }) === 3 && G.flyerGuardOf({ ff_flyerGuard: 31 }) === 15);
check('the bits are 1, 2, 4 and 8', G.FLYER_NO_ANIMS === 1 && G.FLYER_NO_AI === 2 && G.FLYER_NO_OFFSET === 4 && G.FLYER_NO_RESURRECT === 8);
const all = G.flyerPlan(0, false);
check('without switches a watched dragon gets everything, as before this build', all.anims && all.ai && all.offset);
const off = G.flyerPlan(7, false);
check('with switches 1, 2 and 4 a watched copy gets no animations, no AI and no offset', !off.anims && !off.ai && !off.offset);
const hosted = G.flyerPlan(15, true);
check('a copy we host is never held back (our AI drives it)', hosted.anims && hosted.ai && hosted.offset);
check('one switch alone', (() => { const p = G.flyerPlan(G.FLYER_NO_ANIMS, false); return !p.anims && p.ai && p.offset; })());

// ---- the races: the same six as the gameplay's crashycreatures.js ----
const ROOT = path.resolve(__dirname, '..');
let server = null;
try { server = require(path.join(ROOT, 'crashycreatures.js')).DRAGON_RACES; } catch (e) { server = null; }
const client = G.DRAGON_RACES.map(([file, id]) => `${id.toString(16)}:${file}`);
check('the client knows the six DragonProject.hkx races', G.DRAGON_RACES.length === 6 && client.includes('12e82:Skyrim.esm'));
if (server) check('the gameplay refuses the same six', JSON.stringify(client) === JSON.stringify(server), { client, server });

// ---- the trail's budget ----
const T = 1_790_000_000_000;
const t = new G.FlyerTrail(20000, 250, 5, 12);
check('a lifecycle line is always written', t.take('place', 1, T, T) && t.take('spawn', 1, T + 1, T));
check('movement at most once a quarter second per copy', t.take('move', 1, T + 10, T) && !t.take('move', 1, T + 100, T) && t.take('move', 1, T + 300, T) && t.take('move', 2, T + 301, T));
check('the second\'s budget holds', !t.take('anim', 1, T + 400, T) && t.dropped === 1);
check('no movement after the copy\'s first 20 s', !t.take('move', 1, T + 21000, T));
for (let i = 0; i < 20; i++) t.take('anim', 1, T + 30000 + i * 1000, T);
check('the session\'s budget holds', !t.take('kill', 1, T + 60000, T));
const line = G.flyerLine(T, 'pre-resurrect', 0xff000de1, 0xff000862, 'x');
check('a line names the time, the step, the local and remote ids', /^flyer \d\d:\d\d:\d\d\.\d\d\d pre-resurrect ff000de1 remote=ff000862 x$/.test(line), line);

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exitCode = failures ? 1 : 0;
