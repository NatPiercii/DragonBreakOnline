// Scripted test for the activation guard in gamemode.js (2026-09-30): an Activate is a native packet, outside the
// custom-packet bucket, and each runs the whole activate chain, so each caster gets 10 a second with a burst of 30. It
// cuts the guard out of the gamemode and runs it around a counting stand-in chain, on a fake clock. Run it from this
// folder's parent with
//
//   node tests/activate-guard-harness.js
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const a = src.indexOf('// An Activate is a native packet');
const b = src.indexOf('// ---- bank treasuries', a);
if (a < 0 || b < 0) { console.log('FAIL the activation guard markers are gone from gamemode.js'); process.exit(1); }
const guardSrc = src.slice(a, b);

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

let now = 1_700_000_000_000;
const realNow = Date.now;
Date.now = () => now;
const P1 = 0xff000014, P2 = 0xff000015;
const logged = [];
const timers = new Map();
let chainCalls = 0;
const load = (cfg, keep) => {
  if (!keep) delete globalThis.__dboActivateBuckets;
  const mp = { onActivate: (t, c) => { chainCalls++; return true; } };
  new Function('mp', 'cfg', 'logCapped', 'display', 'every', 'globalThis', guardSrc)(
    mp, cfg, (key, n, ...parts) => logged.push([key, parts.join(' ')]), (x) => `Actor${(x >>> 0).toString(16)}`, (name, ms, fn) => timers.set(name, fn), globalThis);
  return mp;
};

let mp = load({});
let ok = 0;
for (let i = 0; i < 100; i++) if (mp.onActivate(0x1234, P1)) ok++;
check('a burst of 100 activations at one instant: the first 30 run the chain', ok === 30 && chainCalls === 30, { ok, chainCalls });
check('...the refusals are logged through the per-caster cap', logged.length === 70 && logged.every(([k]) => k === `activate:${P1}`), logged.length);
check('...naming the caster', /activate guard: Actorff000014 is activating faster than 10 a second/.test(logged[0][1]), logged[0][1]);
now += 1000;
ok = 0;
for (let i = 0; i < 100; i++) if (mp.onActivate(0x1234, P1)) ok++;
check('a second later 10 more run', ok === 10, ok);
ok = 0;
for (let i = 0; i < 100; i++) if (mp.onActivate(0x1234, P2)) ok++;
check('the bucket is per caster: another player has a full burst', ok === 30, ok);
now += 60_000;
ok = 0;
for (let i = 0; i < 240; i++) { now += 250; if (mp.onActivate(0x1234, P1)) ok++; }
check('pressing E four times a second for a minute is never refused', ok === 240, ok);
ok = 0;
for (let i = 0; i < 60; i++) { now += 100; if (mp.onActivate(0x1234, P1)) ok++; }
check('a steady 10 a second is never refused', ok === 60, ok);

// A refused activation stops before the chain; the chain's own answer passes through otherwise
mp = load({});
mp.onActivate = ((inner) => inner)(mp.onActivate);
const denyMp = { onActivate: () => false };
new Function('mp', 'cfg', 'logCapped', 'display', 'every', 'globalThis', guardSrc)(denyMp, {}, () => {}, String, () => {}, globalThis);
check('the chain\'s own refusal is passed through', denyMp.onActivate(0x1, 0xff000099) === false);

// Config, reload, pruning
mp = load({ activateGuard: { perSecond: 2, burst: 5 } });
ok = 0;
for (let i = 0; i < 20; i++) if (mp.onActivate(0x1, P1)) ok++;
check('gamemode-config "activateGuard" overrides the defaults', ok === 5, ok);
mp = load({}, true);
check('a hot reload keeps the buckets (no fresh burst)', mp.onActivate(0x1, P1) === false);
now += 180_000;
timers.get('activatePrune')();
check('a caster idle for two minutes is pruned', globalThis.__dboActivateBuckets.size === 0, globalThis.__dboActivateBuckets.size);

// It wraps the whole chain: installed after the gamemode's last own wrapper (the door trace)
const trace = src.indexOf('TEMPORARY door trace');
const guard = src.indexOf('// An Activate is a native packet');
const between = src.slice(trace, guard);
check('the guard wraps the gamemode\'s outermost activate wrapper', trace > 0 && guard > trace && (between.match(/mp\.onActivate = /g) || []).length === 1, (between.match(/mp\.onActivate = /g) || []).length);

Date.now = realNow;
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
